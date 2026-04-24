import { useState, useEffect, useRef, useCallback } from 'react';
import type { MediaFile } from '../../shared/types';
import { buildExposure, formatFileSize } from '../utils/formatters';
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
const RAW_EXT_RE = /\.(nef|nrw|cr2|cr3|arw|raf|rw2|orf|dng|pef|srw)$/i;

function isRawPhoto(file: MediaFile) {
  return file.type === 'photo' && RAW_EXT_RE.test(file.name || file.extension);
}

function orientationTransform(orientation?: number) {
  switch (orientation) {
    case 2: return 'scaleX(-1)';
    case 3: return 'rotate(180deg)';
    case 4: return 'scaleY(-1)';
    case 5: return 'rotate(90deg) scaleX(-1)';
    case 6: return 'rotate(90deg)';
    case 7: return 'rotate(270deg) scaleX(-1)';
    case 8: return 'rotate(270deg)';
    default: return undefined;
  }
}

function orientationQuarterTurns(orientation?: number) {
  switch (orientation) {
    case 3:
    case 4:
      return 2;
    case 5:
    case 6:
      return 1;
    case 7:
    case 8:
      return 3;
    default:
      return 0;
  }
}

export function SingleView({ file, index, total }: SingleViewProps) {
  const [preview, setPreview] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
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
  const [manualQuarterTurns, setManualQuarterTurns] = useState(0);
  const [clipping, setClipping] = useState<{ highlights: number; shadows: number } | null>(null);
  const [imageNatural, setImageNatural] = useState<{ width: number; height: number } | null>(null);
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number } | null>(null);
  const isDragging = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const rawPreview = isRawPhoto(file);

  // Reset zoom/pan and preview toggle when file changes
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setPreviewNormalized(!!file.normalizeToAnchor);
    setHoldOriginal(false);
    setManualQuarterTurns(0);
    setImageNatural(null);
  }, [file.path]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setViewportSize({ width: rect.width, height: rect.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === 'Space') {
        e.preventDefault();
        setHoldOriginal(true);
      } else if (e.key.toLowerCase() === 'r') {
        e.preventDefault();
        setManualQuarterTurns((turns) => (turns + (e.shiftKey ? 3 : 1)) % 4);
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
    setLoadError(false);

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
          setLoadError(!result && !file.thumbnail);
        }
      }).catch(() => {
        if (!cancelled) {
          setLoading(false);
          setLoadError(!file.thumbnail);
        }
      });
    }, file.thumbnail ? (rawPreview ? 220 : 80) : 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [file.path, file.thumbnail, rawPreview]);

  useEffect(() => {
    if (!file.thumbnail) return;
    void decodeImage(file.thumbnail).catch(() => undefined);
  }, [file.thumbnail]);

  useEffect(() => {
    if (file.type !== 'photo') return;
    if (file.faceBoxes !== undefined && file.personBoxes !== undefined) return;

    let cancelled = false;
    void window.electronAPI.analyzeFaces(file.path).then((results) => {
      if (cancelled) return;
      const result = results[0];
      if (!result || result.path !== file.path) return;
      dispatch({
        type: 'SET_REVIEW_SCORES',
        scores: {
          [file.path]: {
            faceCount: result.boxes.length,
            faceBoxes: result.boxes.map((box) => ({ x: box.x, y: box.y, width: box.width, height: box.height })),
            faceDetection: result.boxes.length > 0 ? 'native' : undefined,
            faceEmbedding: result.embeddings?.[0] || file.faceEmbedding,
            personCount: result.personBoxes.length,
            personBoxes: result.personBoxes.map((box) => ({ x: box.x, y: box.y, width: box.width, height: box.height, score: box.score })),
            subjectReasons: [
              ...(file.subjectReasons ?? []),
              ...(result.boxes.length > 0 ? ['single-photo face scan'] : []),
              ...(result.personBoxes.length > 0 ? ['single-photo person scan'] : []),
            ],
          },
        },
      });
    }).catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [dispatch, file.faceBoxes, file.faceEmbedding, file.path, file.personBoxes, file.subjectReasons, file.type]);

  /*
    Keep the thumbnail visible while the full preview is being generated and
    decoded. On slower laptops this makes detail navigation feel immediate,
    even when the platform preview converter takes a beat.
  */
  const imageSrc = preview || file.thumbnail;
  const showingThumbnailOnly = !!file.thumbnail && !preview && loading;

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    setZoom((z) => {
      const factor = Math.exp(-e.deltaY * ZOOM_STEP);
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor));
      if (next < 1.02) { setPan({ x: 0, y: 0 }); return 1; }
      return next;
    });
  }, []);

  // Must be non-passive to call preventDefault and block browser scroll.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

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
      ? clampStops(-evDelta, exposureMaxStops)
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
  const orientation = orientationTransform(file.orientation);
  const manualRotation = manualQuarterTurns ? `rotate(${manualQuarterTurns * 90}deg)` : undefined;
  const displayTransform = [orientation, manualRotation].filter(Boolean).join(' ') || undefined;
  const totalQuarterTurns = (orientationQuarterTurns(file.orientation) + manualQuarterTurns) % 4;
  const rotatedSwapsAxes = totalQuarterTurns === 1 || totalQuarterTurns === 3;
  const fittedSize = imageNatural && viewportSize
    ? (() => {
        const availableWidth = Math.max(320, viewportSize.width - 24);
        const availableHeight = Math.max(240, viewportSize.height - 24);
        const fit = rotatedSwapsAxes
          ? Math.min(availableHeight / imageNatural.width, availableWidth / imageNatural.height)
          : Math.min(availableWidth / imageNatural.width, availableHeight / imageNatural.height);
        return {
          width: Math.max(1, Math.round(imageNatural.width * fit)),
          height: Math.max(1, Math.round(imageNatural.height * fit)),
        };
      })()
    : null;
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
            className={fittedSize ? 'object-contain' : 'max-h-[calc(100vh-6rem)] max-w-full object-contain'}
            draggable={false}
            onLoad={(event) => {
              const img = event.currentTarget;
              setImageNatural({ width: img.naturalWidth || img.width, height: img.naturalHeight || img.height });
            }}
            style={{
              imageOrientation: 'none',
              transform: displayTransform,
              transformOrigin: 'center center',
              filter: imageFilter || undefined,
              width: fittedSize ? `${fittedSize.width}px` : showingThumbnailOnly ? 'min(94vw, 1280px)' : undefined,
              height: fittedSize ? `${fittedSize.height}px` : showingThumbnailOnly ? 'calc(100vh - 6rem)' : undefined,
            }}
          />
        ) : (
          <div className="flex min-h-48 min-w-64 flex-col items-center justify-center gap-2 rounded border border-border bg-surface-alt px-6 text-center">
            <svg className="h-10 w-10 text-text-faint" viewBox="0 0 24 24" fill="currentColor">
              <path fillRule="evenodd" d="M1.5 6a2.25 2.25 0 012.25-2.25h16.5A2.25 2.25 0 0122.5 6v12a2.25 2.25 0 01-2.25 2.25H3.75A2.25 2.25 0 011.5 18V6zm3.75-.75A.75.75 0 004.5 6v9.44l3.44-3.44a1.5 1.5 0 012.12 0l1.69 1.69.44-.44a1.5 1.5 0 012.12 0l5.19 5.19V6a.75.75 0 00-.75-.75H5.25z" clipRule="evenodd" />
            </svg>
            <div className="text-sm text-text-secondary">{loadError ? 'Preview could not be loaded' : 'Preparing preview...'}</div>
            <div className="max-w-72 truncate text-[11px] text-text-muted" title={file.path}>{file.name}</div>
          </div>
        )}

        {loading && imageSrc && (
          <div className="absolute left-3 top-3 z-20 rounded bg-black/65 px-2 py-1 text-[11px] text-white shadow">
            Loading full preview...
          </div>
        )}
        {showingThumbnailOnly && (
          <div className="absolute bottom-3 left-3 z-20 rounded bg-black/65 px-2 py-1 text-[11px] text-white/80 shadow">
            Quick preview
          </div>
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
        {!isZoomed && imageSrc && (file.faceBoxes?.length ?? 0) > 0 && (
          <div
            className="absolute inset-0 pointer-events-none z-[15]"
            style={{
              transform: displayTransform,
              transformOrigin: 'center center',
            }}
          >
            {file.faceBoxes!.map((box, i) => (
              <div
                key={i}
                className={`absolute rounded-sm shadow-[0_0_0_1px_rgba(0,0,0,0.4)] ${
                  file.faceDetection === 'estimated'
                    ? 'border border-dashed border-cyan-300/75'
                    : (box.eyeScore ?? 0) >= 2
                    ? 'border-2 border-emerald-400/90'
                    : 'border border-yellow-400/70'
                }`}
                style={{
                  left: `${box.x * 100}%`,
                  top: `${box.y * 100}%`,
                  width: `${box.width * 100}%`,
                  height: `${box.height * 100}%`,
                }}
                title={file.faceDetection === 'estimated'
                  ? 'Estimated face region'
                  : (box.eyeScore ?? 0) >= 2 ? 'Eyes open' : (box.eyeScore ?? 0) === 1 ? 'One eye visible' : 'Face detected'}
              />
            ))}
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

      {!isZoomed && imageSrc && !loading && (
        <div className="absolute top-3 right-3 z-20 flex max-w-[45vw] flex-wrap justify-end gap-1.5">
          <span className="rounded bg-black/65 px-2 py-1 text-[10px] font-mono text-white/90">
            {index + 1}/{total}
          </span>
          <span className="rounded bg-black/65 px-2 py-1 text-[10px] font-mono uppercase text-white/90">
            {file.extension.replace('.', '')}
          </span>
          <span className="rounded bg-black/65 px-2 py-1 text-[10px] font-mono text-white/90">
            {formatFileSize(file.size)}
          </span>
          {file.faceGroupId && (
            <span className="rounded bg-violet-500/35 px-2 py-1 text-[10px] font-mono text-violet-100" title={file.faceGroupId}>
              face group {file.faceGroupSize ?? 0}
            </span>
          )}
          {!!file.faceCount && (
            <span className="rounded bg-emerald-500/35 px-2 py-1 text-[10px] font-mono text-emerald-100">
              {file.faceDetection === 'estimated' ? 'estimated faces' : 'faces'} {file.faceCount}
            </span>
          )}
          {file.orientation && file.orientation > 1 && (
            <span className="rounded bg-black/65 px-2 py-1 text-[10px] font-mono text-white/90">
              rotated
            </span>
          )}
          <button
            type="button"
            onClick={() => setManualQuarterTurns((turns) => (turns + 1) % 4)}
            className="rounded bg-black/65 px-2 py-1 text-[10px] font-mono text-white/90 hover:bg-black/80"
            title="Rotate this view 90 degrees. Shortcut: R, Shift+R."
          >
            rotate
          </button>
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
            <span className="flex items-center gap-0.5 bg-black/55 px-1.5 py-0.5 rounded" title={`${file.rating} star rating`}>
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
              <span className="text-[9px] font-mono text-white bg-black/70 backdrop-blur-sm px-1.5 py-0.5 rounded">
                {exposure}
              </span>
            )}
            {typeof file.exposureValue === 'number' && (
              <span
                className="text-[9px] font-mono text-white bg-black/70 backdrop-blur-sm px-1.5 py-0.5 rounded"
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
                className="text-[9px] font-mono text-white/80 hover:text-white bg-black/70 backdrop-blur-sm hover:bg-black/80 px-1.5 py-0.5 rounded"
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
                    : 'text-white/80 bg-black/70 backdrop-blur-sm hover:bg-black/80 hover:text-orange-300'
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
                    : 'text-white/80 bg-black/70 backdrop-blur-sm hover:bg-black/80 hover:text-sky-300'
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
                      : 'bg-black/55 text-white/90'
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
            {file.faceGroupId && (
              <span className="text-[9px] font-mono text-violet-300 bg-violet-500/30 px-1.5 py-0.5 rounded" title={file.faceGroupId}>
                Face group {file.faceGroupSize ?? 0}
              </span>
            )}
            {file.faceCount ? (
              <span className="text-[9px] font-mono text-emerald-300 bg-emerald-500/30 px-1.5 py-0.5 rounded" title="Local face detection signal">
                Face {file.faceCount}
              </span>
            ) : null}
            {file.personCount ? (
              <span className="text-[9px] font-mono text-sky-300 bg-sky-500/30 px-1.5 py-0.5 rounded" title="ONNX person/body detection signal">
                Person {file.personCount}
              </span>
            ) : null}
            {typeof file.subjectSharpnessScore === 'number' && (
              <span className="text-[9px] font-mono text-yellow-300 bg-yellow-500/30 px-1.5 py-0.5 rounded" title={file.subjectReasons?.join(', ') || 'Subject focus score'}>
                Subject {file.subjectSharpnessScore}
              </span>
            )}
          </div>
          {cameraName && (
            <span className="text-[9px] font-mono text-white bg-black/70 backdrop-blur-sm px-1.5 py-0.5 rounded pointer-events-none">
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
