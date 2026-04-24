import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import type { MediaFile } from '../../shared/types';
import { buildExposure } from '../utils/formatters';
import { decodeImage, getCachedPreview } from '../utils/previewCache';

interface CompareViewProps {
  files: MediaFile[];
}

export function CompareView({ files }: CompareViewProps) {
  const visible = useMemo(() => files.slice(0, 4), [files]);
  const [previews, setPreviews] = useState<Record<string, string | undefined>>({});
  const [zoom, setZoom] = useState(1);
  const gridRef = useRef<HTMLDivElement>(null);
  const loadedRef = useRef(new Set<string>());

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
      void getCachedPreview(file.path, 'high').then(async (preview) => {
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
      className={`h-full grid gap-px bg-border ${visible.length <= 2 ? 'grid-cols-2' : 'grid-cols-2 grid-rows-2'}`}
      onDoubleClick={() => setZoom((z) => z > 1 ? 1 : 2)}
      title="Compare view. Ctrl/Cmd + wheel zooms all images together; double-click toggles 200%."
    >
      {visible.map((file) => {
        const src = previews[file.path] || file.thumbnail;
        const exposure = buildExposure(file);
        return (
          <div key={file.path} className="relative bg-black flex items-center justify-center overflow-hidden">
            {src ? (
              <img
                src={src}
                alt={file.name}
                className="max-w-full max-h-full object-contain transition-transform duration-100"
                draggable={false}
                style={{ transform: `scale(${zoom})` }}
              />
            ) : (
              <div className="text-xs text-text-muted">No preview</div>
            )}
            {zoom > 1 && (
              <div className="absolute top-2 right-2 text-[10px] font-mono text-white/75 bg-black/55 px-1.5 py-0.5 rounded">
                {Math.round(zoom * 100)}%
              </div>
            )}
            <div className="absolute left-2 right-2 bottom-2 flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-[10px] font-mono text-white/85 bg-black/55 px-1.5 py-0.5 rounded">
                {file.name}
              </span>
              <span className="shrink-0 text-[10px] font-mono text-white/75 bg-black/55 px-1.5 py-0.5 rounded">
                {exposure || `${Math.round(file.size / 1024)} KB`}
              </span>
            </div>
            {(file.normalizeToAnchor || file.exposureAdjustmentStops) && (
              <div className="absolute top-2 left-2 text-[10px] font-mono text-orange-200 bg-orange-600/75 px-1.5 py-0.5 rounded">
                {file.normalizeToAnchor ? 'ANCHOR ' : ''}{file.exposureAdjustmentStops ? `${file.exposureAdjustmentStops > 0 ? '+' : ''}${file.exposureAdjustmentStops.toFixed(2)} EV` : ''}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
