import { useState, useEffect, useRef, useCallback } from 'react';
import type { MediaFile } from '../../shared/types';
import { buildExposure } from '../utils/formatters';
import { useAppState, useAppDispatch } from '../context/ImportContext';
import { formatEVDelta, stopsToSafeMultiplier, clampStops, estimateClippingPercent } from '../../shared/exposure';
import { Histogram } from './Histogram';
import { decodeImage, getCachedPreview } from '../utils/previewCache';

interface SingleViewProps {
  file: MediaFile;
  index: number;
  total: number;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.008;

export function SingleView({ file, index, total }: SingleViewProps) {
  const [preview, setPreview] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const isPicked = file.pick === 'selected';
  const isRejected = file.pick === 'rejected';
  const { files, exposureAnchorPath, normalizeExposure, saveFormat, exposureMaxStops } = useAppState();
  const dispatch = useAppDispatch();
  const anchor = exposureAnchorPath ? files.find((f) => f.path === exposureAnchorPath) : null;
  const isAnchor = anchor?.path === file.path;
  const anchorHasEV = typeof anchor?.exposureValue === 'number';
  const evDelta =
    anchor && typeof anchor.exposureValue === 'number' && typeof file.exposureValue === 'number'
      ? file.exposureValue - anchor.exposureValue
      : undefined;

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [previewNormalized, setPreviewNormalized] = useState(false);
  const [holdOriginal, setHoldOriginal] = useState(false);
  const [clipping, setClipping] = useState<{ highlights: number; shadows: number } | null>(null);
  const isDragging = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  // Reset zoom/pan and preview toggle when file changes
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setPreviewNormalized(false);
    setHoldOriginal(false);
  }, [file.path]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === 'Space') {
        e.preventDefault();
        setHoldOriginal(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setHoldOriginal(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setPreview(undefined);
    setLoading(!file.thumbnail);

    const timer = window.setTimeout(() => {
      setLoading(true);
      void getCachedPreview(file.path, 'high').then(async (result) => {
        if (cancelled) return;
        if (result) {
          try {
            await decodeImage(result);
          } catch {
            // If decode fails, still hand the browser the source so the user
            // gets whatever it can render instead of a permanent spinner.
          }
        }
        if (!cancelled) {
          setPreview(result);
          setLoading(false);
        }
      }).catch(() => {
        if (!cancelled) setLoading(false);
      });
    }, file.thumbnail ? 80 : 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [file.path, file.thumbnail]);

  useEffect(() => {
    if (!file.thumbnail) return;
    void decodeImage(file.thumbnail).catch(() => undefined);
  }, [file.thumbnail]);

  /*
    Keep the thumbnail visible while the full preview is being generated and
    decoded. On slower laptops this makes detail navigation feel immediate,
    even when the platform preview converter takes a beat.
  */
  const imageSrc = preview || file.thumbnail;
  const showingThumbnailOnly = !!file.thumbnail && !preview && loading;

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => {
      // Exponential zoom: constant scroll feels uniform at any zoom level
      const factor = Math.exp(-e.deltaY * ZOOM_STEP);
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor));
      if (next < 1.02) { setPan({ x: 0, y: 0 }); return 1; }
      return next;
    });
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (zoom <= 1) return;
    isDragging.current = true;
    lastMouse.current = { x: e.clientX, y: e.clientY };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [zoom]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging.current) return;
    const dx = e.clientX - lastMouse.current.x;
    const dy = e.clientY - lastMouse.current.y;
    lastMouse.current = { x: e.clientX, y: e.clientY };
    setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
  }, []);

  const handlePointerUp = useCallback(() => {
    isDragging.current = false;
  }, []);

  const handleDoubleClick = useCallback(() => {
    if (zoom > 1) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
    } else {
      setZoom(2);
    }
  }, [zoom]);

  const isZoomed = zoom > 1;
  const exposure = buildExposure(file);
  const cameraName = file.cameraModel || null;

  // Live normalization preview: compute brightness multiplier from EV delta.
  // The toggle is only active when there's a meaningful delta to show.
  const canPreviewNorm =
    evDelta !== undefined && !isAnchor && Math.abs(evDelta) >= 0.05 && imageSrc;
  const normalizedEvDelta =
    canPreviewNorm && typeof evDelta === 'number' && typeof file.exposureValue === 'number' && anchor
      ? clampStops(evDelta, exposureMaxStops)
      : 0;
  const manualStops = file.exposureAdjustmentStops ?? 0;
  const previewStops = previewNormalized && !holdOriginal
    ? clampStops(normalizedEvDelta + manualStops, exposureMaxStops)
    : 0;
  const brightnessMultiplier = previewStops !== 0
    ? stopsToSafeMultiplier(previewStops)
    : 1;
  const imageFilter = [
    showingThumbnailOnly ? 'blur(0.35px)' : '',
    brightnessMultiplier !== 1 ? `brightness(${brightnessMultiplier.toFixed(3)})` : '',
  ].filter(Boolean).join(' ');
  const canPreviewAdjust = imageSrc && (canPreviewNorm || Math.abs(manualStops) >= 0.01);
  const clippingRisk = Math.abs(previewStops) >= exposureMaxStops - 0.01 || brightnessMultiplier >= 2.25 || brightnessMultiplier <= 0.4;

  useEffect(() => {
    if (!imageSrc) {
      setClipping(null);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (cancelled) return;
      const canvas = document.createElement('canvas');
      const width = 96;
      const height = 72;
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, width, height);
      const data = ctx.getImageData(0, 0, width, height).data;
      if (!cancelled) setClipping(estimateClippingPercent(data, brightnessMultiplier));
    };
    img.onerror = () => {
      if (!cancelled) setClipping(null);
    };
    img.src = imageSrc;
    return () => {
      cancelled = true;
    };
  }, [imageSrc, brightnessMultiplier]);

  return (
    <div
      ref={containerRef}
      className="h-full flex items-center justify-center bg-neutral-100 dark:bg-black relative overflow-hidden"
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onDoubleClick={handleDoubleClick}
      style={{ cursor: isZoomed ? (isDragging.current ? 'grabbing' : 'grab') : 'default' }}
    >
      <div
        className={`relative max-h-full max-w-full ${isRejected ? 'opacity-40' : ''}`}
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: 'center center',
          transition: isDragging.current ? 'none' : 'transform 0.15s ease-out',
        }}
      >
        {imageSrc ? (
          <img
            src={imageSrc}
            alt={file.name}
            className="max-h-[calc(100vh-6rem)] max-w-full object-contain"
            draggable={false}
            style={{
              filter: imageFilter || undefined,
              width: showingThumbnailOnly ? 'min(94vw, 1280px)' : undefined,
              height: showingThumbnailOnly ? 'calc(100vh - 6rem)' : undefined,
            }}
          />
        ) : (
          <div className="text-text-muted text-sm">No preview</div>
        )}

        {/* Viewfinder corner ticks */}
        {imageSrc && (
          <div className="absolute inset-0 pointer-events-none z-[5]">
            <div className="absolute top-1.5 left-1.5 w-3 h-3 border-t border-l border-white/25" />
            <div className="absolute top-1.5 right-1.5 w-3 h-3 border-t border-r border-white/25" />
            <div className="absolute bottom-1.5 left-1.5 w-3 h-3 border-b border-l border-white/25" />
            <div className="absolute bottom-1.5 right-1.5 w-3 h-3 border-b border-r border-white/25" />
          </div>
        )}

        {isPicked && imageSrc && (
          <div className="absolute inset-0 pointer-events-none z-10">
            <div className="absolute top-2 left-2 w-5 h-5 border-t-[2px] border-l-[2px] border-yellow-400/80" />
            <div className="absolute top-2 right-2 w-5 h-5 border-t-[2px] border-r-[2px] border-yellow-400/80" />
            <div className="absolute bottom-2 left-2 w-5 h-5 border-b-[2px] border-l-[2px] border-yellow-400/80" />
            <div className="absolute bottom-2 right-2 w-5 h-5 border-b-[2px] border-r-[2px] border-yellow-400/80" />
          </div>
        )}

        {isRejected && imageSrc && (
          <div className="absolute inset-0 pointer-events-none z-10">
            <svg className="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
              <line x1="10" y1="10" x2="90" y2="90" stroke="#dc2626" strokeWidth="1" strokeLinecap="round" strokeOpacity="0.7" />
              <line x1="90" y1="10" x2="10" y2="90" stroke="#dc2626" strokeWidth="1" strokeLinecap="round" strokeOpacity="0.7" />
            </svg>
          </div>
        )}
        {clippingRisk && imageSrc && (
          <div className="absolute inset-0 pointer-events-none z-20">
            <div className={`absolute inset-x-0 top-0 h-8 ${previewStops > 0 ? 'bg-red-500/25' : 'bg-blue-500/25'}`} />
            <div className={`absolute inset-x-0 bottom-0 h-8 ${previewStops > 0 ? 'bg-red-500/25' : 'bg-blue-500/25'}`} />
          </div>
        )}
      </div>

      {loading && file.thumbnail && (
        <div className="absolute top-3 right-3 flex items-center gap-1.5 bg-black/45 text-white/80 px-2 py-1 rounded z-30">
          <div className="w-3 h-3 border-[1.5px] border-text-muted border-t-text rounded-full animate-spin" />
          <span className="text-[10px]">Loading full preview</span>
        </div>
      )}

      {!isZoomed && imageSrc && <Histogram src={file.thumbnail || imageSrc} />}

      {!isZoomed && (file.isProtected || (file.rating && file.rating > 0)) && (
        <div className="absolute top-3 left-3 flex items-center gap-1.5 z-20">
          {file.isProtected && (
            <span className="text-[10px] font-semibold text-emerald-200 bg-emerald-600/80 px-2 py-0.5 rounded">
              Protected
            </span>
          )}
          {file.rating && file.rating > 0 && (
            <span className="flex items-center gap-0.5 bg-black/45 dark:bg-black/65 px-1.5 py-0.5 rounded" title={`${file.rating} star rating`}>
              {Array.from({ length: 5 }).map((_, i) => (
                <svg
                  key={i}
                  className={`w-3 h-3 ${i < file.rating! ? 'text-yellow-400' : 'text-white/25'}`}
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                </svg>
              ))}
            </span>
          )}
        </div>
      )}

      {/* Metadata HUD — hidden when zoomed */}
      {!isZoomed && (exposure || cameraName || typeof file.exposureValue === 'number') && (
        <div className="absolute bottom-3 left-3 right-3 flex items-end justify-between gap-2 z-[5]">
          <div className="flex items-center gap-1.5 flex-wrap">
            {exposure && (
              <span className="text-[9px] font-mono text-text-muted bg-black/30 dark:bg-black/50 px-1.5 py-0.5 rounded">
                {exposure}
              </span>
            )}
            {typeof file.exposureValue === 'number' && (
              <span
                className="text-[9px] font-mono text-text-muted bg-black/30 dark:bg-black/50 px-1.5 py-0.5 rounded"
                title="EV100 — exposure value at ISO 100"
              >
                EV {file.exposureValue.toFixed(2)}
              </span>
            )}
            {evDelta !== undefined && !isAnchor && (
              <span
                className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${
                  Math.abs(evDelta) < 0.17
                    ? 'bg-emerald-500/30 text-emerald-300'
                    : Math.abs(evDelta) < 1
                    ? 'bg-yellow-500/30 text-yellow-300'
                    : 'bg-red-500/30 text-red-300'
                }`}
                title={`Difference vs anchor (${anchor?.name})`}
              >
                Δ {formatEVDelta(evDelta)}
              </span>
            )}
            {Math.abs(manualStops) >= 0.01 && (
              <span className="text-[9px] font-mono text-sky-300 bg-sky-500/30 px-1.5 py-0.5 rounded" title="Manual exposure offset">
                EV {manualStops > 0 ? '+' : ''}{manualStops.toFixed(2)}
              </span>
            )}
            {clippingRisk && (
              <span className="text-[9px] font-mono text-red-300 bg-red-500/30 px-1.5 py-0.5 rounded">
                clipping risk
              </span>
            )}
            {clipping && (clipping.highlights > 0.5 || clipping.shadows > 0.5) && (
              <span
                className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${
                  clipping.highlights > 3 || clipping.shadows > 6
                    ? 'text-red-300 bg-red-500/30'
                    : 'text-yellow-300 bg-yellow-500/30'
                }`}
                title="Estimated clipped pixels in the current preview after EV adjustment"
              >
                clip H{clipping.highlights.toFixed(1)}% S{clipping.shadows.toFixed(1)}%
              </span>
            )}
            {isAnchor && (
              <span className="text-[9px] font-mono text-blue-300 bg-blue-500/30 px-1.5 py-0.5 rounded">
                Exposure anchor
              </span>
            )}
            {typeof file.exposureValue === 'number' && (
              <button
                type="button"
                onClick={() => {
                  if (isAnchor) {
                    dispatch({ type: 'CLEAR_EXPOSURE_ANCHOR' });
                  } else {
                    dispatch({ type: 'SET_EXPOSURE_ANCHOR', path: file.path });
                  }
                }}
                className="text-[9px] font-mono text-text-muted hover:text-text bg-black/30 hover:bg-black/50 dark:bg-black/50 px-1.5 py-0.5 rounded"
                title={isAnchor
                  ? 'Clear the exposure anchor and reset all normalization flags'
                  : normalizeExposure
                    ? 'Use this shot as the exposure anchor — others will be matched to it on import'
                    : 'Set as exposure anchor (enable Normalize Exposure in the Output panel to apply on import)'}
              >
                {isAnchor ? 'Clear anchor' : 'Set as anchor'}
              </button>
            )}
            {typeof file.exposureValue === 'number' && !isAnchor && anchorHasEV && (
              <button
                type="button"
                onClick={() =>
                  dispatch({
                    type: 'SET_NORMALIZE_TO_ANCHOR',
                    filePaths: [file.path],
                    value: !file.normalizeToAnchor,
                  })
                }
                className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${
                  file.normalizeToAnchor
                    ? 'bg-orange-500/30 text-orange-300 hover:bg-orange-500/40'
                    : 'text-text-muted bg-black/30 hover:bg-black/50 dark:bg-black/50 hover:text-orange-300'
                }`}
                title={file.normalizeToAnchor
                  ? 'Remove: exposure will NOT be normalized to anchor on import'
                  : saveFormat === 'original'
                    ? 'Mark to normalize exposure to anchor (requires a transcoding save format)'
                    : `Normalize this file's exposure to match the anchor on import`}
              >
                {file.normalizeToAnchor ? '⊖ Normalize' : '⊕ Normalize'}
              </button>
            )}
            {canPreviewAdjust && (
              <button
                type="button"
                onClick={() => setPreviewNormalized((v) => !v)}
                className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${
                  previewNormalized
                    ? 'bg-sky-500/30 text-sky-300 hover:bg-sky-500/40'
                    : 'text-text-muted bg-black/30 hover:bg-black/50 dark:bg-black/50 hover:text-sky-300'
                }`}
                title={previewNormalized
                  ? `Showing adjusted preview (${formatEVDelta(previewStops)}). Hold Space for original`
                  : `Preview exposure adjustment (${formatEVDelta(clampStops(normalizedEvDelta + manualStops, exposureMaxStops))})`}
              >
                {previewNormalized ? (holdOriginal ? 'Original' : 'Adjusted') : 'Preview EV'}
              </button>
            )}
            {typeof file.reviewScore === 'number' && (
              <span
                className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${
                  file.reviewScore >= 70
                    ? 'bg-yellow-500/30 text-yellow-300'
                    : file.blurRisk === 'high'
                      ? 'bg-red-500/30 text-red-300'
                      : 'bg-black/30 dark:bg-black/50 text-text-muted'
                }`}
                title={file.reviewReasons?.join(', ') || 'Smart review score'}
              >
                Score {file.reviewScore}
              </span>
            )}
          {file.visualGroupId && (
            <span className="text-[9px] font-mono text-blue-300 bg-blue-500/30 px-1.5 py-0.5 rounded" title={file.visualGroupId}>
              Similar {file.visualGroupSize ?? 0}
            </span>
          )}
            {file.faceCount ? (
              <span className="text-[9px] font-mono text-emerald-300 bg-emerald-500/30 px-1.5 py-0.5 rounded" title="Local face detection signal">
                Face {file.faceCount}
              </span>
            ) : null}
            {typeof file.subjectSharpnessScore === 'number' && (
              <span className="text-[9px] font-mono text-yellow-300 bg-yellow-500/30 px-1.5 py-0.5 rounded" title={file.subjectReasons?.join(', ') || 'Subject focus score'}>
                Subject {file.subjectSharpnessScore}
              </span>
            )}
          </div>
          {cameraName && (
            <span className="text-[9px] font-mono text-text-muted bg-black/30 dark:bg-black/50 px-1.5 py-0.5 rounded pointer-events-none">
              {cameraName}
            </span>
          )}
        </div>
      )}

      {/* Zoom indicator */}
      {isZoomed && (
        <div className="absolute bottom-3 right-3 bg-black/60 text-white text-[10px] font-mono px-1.5 py-0.5 rounded z-20">
          {Math.round(zoom * 100)}%
        </div>
      )}
    </div>
  );
}
