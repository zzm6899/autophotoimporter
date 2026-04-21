import { useState, useEffect, useRef, useCallback } from 'react';
import type { MediaFile } from '../../shared/types';
import { buildExposure } from '../utils/formatters';
import { useAppState, useAppDispatch } from '../context/ImportContext';
import { formatEVDelta } from '../../shared/exposure';

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
  const { files, exposureAnchorPath, normalizeExposure, saveFormat } = useAppState();
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
  const isDragging = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  // Reset zoom/pan when file changes
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [file.path]);

  useEffect(() => {
    let cancelled = false;
    setPreview(undefined);
    setLoading(true);

    window.electronAPI.getPreview(file.path).then((result) => {
      if (!cancelled) {
        setPreview(result);
        setLoading(false);
      }
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });

    return () => { cancelled = true; };
  }, [file.path]);

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

  const imageSrc = preview || file.thumbnail;
  const isZoomed = zoom > 1;
  const exposure = buildExposure(file);
  const cameraName = file.cameraModel || null;

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
      </div>

      {loading && file.thumbnail && (
        <div className="absolute top-3 right-3 flex items-center gap-1.5">
          <div className="w-3 h-3 border-[1.5px] border-text-muted border-t-text rounded-full animate-spin" />
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
            {isAnchor && (
              <span className="text-[9px] font-mono text-blue-300 bg-blue-500/30 px-1.5 py-0.5 rounded">
                Exposure anchor
              </span>
            )}
            {typeof file.exposureValue === 'number' && (
              <button
                type="button"
                onClick={() =>
                  dispatch({
                    type: 'SET_EXPOSURE_ANCHOR',
                    path: isAnchor ? null : file.path,
                  })
                }
                className="text-[9px] font-mono text-text-muted hover:text-text bg-black/30 hover:bg-black/50 dark:bg-black/50 px-1.5 py-0.5 rounded"
                title={isAnchor
                  ? 'Clear the exposure anchor'
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
