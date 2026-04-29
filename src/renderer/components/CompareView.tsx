import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import type { MediaFile } from '../../shared/types';
import { buildExposure } from '../utils/formatters';
import { decodeImage, getCachedPreview } from '../utils/previewCache';
import { buildPreviewExposureFilter, buildPreviewWhiteBalanceFilter } from '../../shared/exposure';
import { bestShotScore } from '../../shared/review';
import { buildAiBadges, buildAiReasons } from '../utils/aiReasons';

interface CompareViewProps {
  files: MediaFile[];
  previewStopsByPath?: Record<string, number>;
  previewWhiteBalanceByPath?: Record<string, { temperature?: number; tint?: number } | undefined>;
  selectionCount?: number;
  onPickWinner?: (file: MediaFile) => void;
  onRejectFile?: (file: MediaFile) => void;
  onQueueFile?: (file: MediaFile) => void;
  onFocusFile?: (file: MediaFile) => void;
}

export function CompareView({
  files,
  previewStopsByPath,
  previewWhiteBalanceByPath,
  selectionCount = files.length,
  onPickWinner,
  onRejectFile,
  onQueueFile,
  onFocusFile,
}: CompareViewProps) {
  const visible = useMemo(() => files.slice(0, 4), [files]);
  const [previews, setPreviews] = useState<Record<string, string | undefined>>({});
  const [zoom, setZoom] = useState(1);
  const [drawerPath, setDrawerPath] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const loadedRef = useRef(new Set<string>());
  const bestPath = useMemo(() => {
    const ranked = visible
      .filter((file) => file.type === 'photo' && file.pick !== 'rejected')
      .slice()
      .sort((a, b) =>
        Number(!!b.isProtected) - Number(!!a.isProtected) ||
        (b.rating ?? 0) - (a.rating ?? 0) ||
        (b.reviewScore ?? -1) - (a.reviewScore ?? -1) ||
        bestShotScore(b) - bestShotScore(a),
      );
    return ranked[0]?.path ?? null;
  }, [visible]);

  const handleWheel = useCallback((e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom((z) => Math.max(1, Math.min(4, z * Math.exp(-e.deltaY * 0.004))));
  }, []);

  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  useEffect(() => {
    for (const file of visible) {
      if (loadedRef.current.has(file.path)) continue;
      loadedRef.current.add(file.path);
      void getCachedPreview(file.path, 'preview', 'high').then(async (preview) => {
        if (preview) await decodeImage(preview).catch(() => undefined);
        setPreviews((p) => ({ ...p, [file.path]: preview }));
      }).catch(() => undefined);
    }
  }, [visible]); // previews removed from deps — loadedRef prevents duplicate fetches

  if (visible.length === 0) {
    return <div className="h-full flex items-center justify-center text-sm text-text-muted">Select images to compare</div>;
  }

  return (
    <div
      ref={gridRef}
      className={`relative h-full grid gap-px bg-border ${visible.length <= 2 ? 'grid-cols-2' : 'grid-cols-2 grid-rows-2'}`}
      onDoubleClick={() => setZoom((z) => z > 1 ? 1 : 2)}
      title="Compare view. Ctrl/Cmd + wheel zooms all images together; double-click toggles 200%."
    >
      {selectionCount > visible.length && (
        <div className="pointer-events-none absolute left-3 top-3 z-20 rounded bg-black/60 px-2.5 py-1 text-[10px] font-mono text-white/85">
          Showing {visible.length} of {selectionCount}
        </div>
      )}
      {visible.map((file, index) => {
        const src = previews[file.path] || file.thumbnail;
        const exposure = buildExposure(file);
        const aiBadges = buildAiBadges(file);
        const aiReasons = buildAiReasons(file);
        const drawerOpen = drawerPath === file.path;
        const isAiWinner = file.path === bestPath && visible.length > 1;
        const previewFilter = [
          buildPreviewExposureFilter(previewStopsByPath?.[file.path] ?? 0),
          buildPreviewWhiteBalanceFilter(file.whiteBalanceAdjustment ?? previewWhiteBalanceByPath?.[file.path]),
        ].filter(Boolean).join(' ') || undefined;
        return (
          <div
            key={file.path}
            className={`group relative bg-black flex items-center justify-center overflow-hidden ${
              isAiWinner ? 'ring-2 ring-inset ring-yellow-400/70' : ''
            }`}
          >
            {src ? (
              <img
                src={src}
                alt={file.name}
                className="max-w-full max-h-full object-contain transition-transform duration-100"
                draggable={false}
                style={{ transform: `scale(${zoom})`, filter: previewFilter }}
              />
            ) : (
              <div className="text-xs text-text-muted">No preview</div>
            )}
            {zoom > 1 && (
              <div className="absolute top-2 right-2 text-[10px] font-mono text-white/75 bg-black/55 px-1.5 py-0.5 rounded">
                {Math.round(zoom * 100)}%
              </div>
            )}
            <div className="absolute left-2 top-2 z-20 flex max-w-[calc(100%-7rem)] flex-wrap gap-1">
              <span className="rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-mono text-white/80">
                {index + 1}
              </span>
              {isAiWinner && (
                <span className="rounded bg-yellow-400/90 px-1.5 py-0.5 text-[10px] font-semibold text-black">
                  AI pick
                </span>
              )}
              {aiBadges.map((badge) => (
                <span
                  key={badge}
                  className={`rounded px-1.5 py-0.5 text-[10px] font-mono ${
                    badge === 'Best'
                      ? 'bg-yellow-500/80 text-black'
                      : badge === 'Blur'
                        ? 'bg-red-600/80 text-white'
                        : 'bg-black/60 text-white/80'
                  }`}
                >
                  {badge}
                </span>
              ))}
            </div>
            <div className="absolute left-2 right-2 bottom-2 flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-[10px] font-mono text-white/85 bg-black/55 px-1.5 py-0.5 rounded">
                {file.name}
              </span>
              <span className="shrink-0 text-[10px] font-mono text-white/75 bg-black/55 px-1.5 py-0.5 rounded">
                {exposure || `${Math.round(file.size / 1024)} KB`}
              </span>
            </div>
            {(file.normalizeToAnchor || file.exposureAdjustmentStops || file.whiteBalanceAdjustment || previewWhiteBalanceByPath?.[file.path]) && (
              <div className="absolute top-2 left-2 text-[10px] font-mono text-orange-200 bg-orange-600/75 px-1.5 py-0.5 rounded">
                {file.normalizeToAnchor ? 'ANCHOR ' : ''}{file.exposureAdjustmentStops ? `${file.exposureAdjustmentStops > 0 ? '+' : ''}${file.exposureAdjustmentStops.toFixed(2)} EV` : ''}
                {(file.whiteBalanceAdjustment || previewWhiteBalanceByPath?.[file.path]) ? ' WB' : ''}
              </div>
            )}
            <div className="absolute right-2 top-2 z-30 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 hover:opacity-100">
              {onFocusFile && (
                <button
                  type="button"
                  onClick={() => onFocusFile(file)}
                  className="rounded bg-black/65 px-1.5 py-0.5 text-[10px] text-white/80 hover:bg-black/85 hover:text-white"
                  title="Open this photo in detail view"
                >
                  Focus
                </button>
              )}
              <button
                type="button"
                onClick={() => setDrawerPath((path) => path === file.path ? null : file.path)}
                className="rounded bg-black/65 px-1.5 py-0.5 text-[10px] text-white/80 hover:bg-black/85 hover:text-white"
                title="Show AI reasons for this candidate"
              >
                Why
              </button>
            </div>
            <div className="absolute bottom-9 right-2 z-30 flex gap-1">
              {onPickWinner && (
                <button
                  type="button"
                  onClick={() => onPickWinner(file)}
                  className="rounded bg-yellow-400/90 px-2 py-1 text-[10px] font-semibold text-black hover:bg-yellow-300"
                  title="Mark this candidate as the winner and reject the other compared photos"
                >
                  Winner
                </button>
              )}
              {onQueueFile && (
                <button
                  type="button"
                  onClick={() => onQueueFile(file)}
                  className="rounded bg-emerald-500/85 px-2 py-1 text-[10px] font-semibold text-white hover:bg-emerald-500"
                  title="Add this photo to the import queue"
                >
                  Queue
                </button>
              )}
              {onRejectFile && (
                <button
                  type="button"
                  onClick={() => onRejectFile(file)}
                  className="rounded bg-red-600/85 px-2 py-1 text-[10px] font-semibold text-white hover:bg-red-600"
                  title="Reject this compared photo"
                >
                  Reject
                </button>
              )}
            </div>
            {drawerOpen && (
              <div className="absolute right-2 top-10 z-40 w-[min(20rem,calc(100%-1rem))] rounded border border-white/10 bg-black/75 p-2 text-white/90 shadow-lg backdrop-blur">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-[9px] font-semibold uppercase text-white/65">AI reasons</span>
                  <span className="text-[9px] font-mono text-white/55">best {bestShotScore(file)}</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {(aiReasons.length > 0 ? aiReasons : ['no AI notes yet']).map((reason) => (
                    <span key={reason} className="max-w-full truncate rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white/80">
                      {reason}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
