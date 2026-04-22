import { useEffect, useState } from 'react';
import type { MediaFile } from '../../shared/types';
import { buildExposure } from '../utils/formatters';

interface CompareViewProps {
  files: MediaFile[];
}

export function CompareView({ files }: CompareViewProps) {
  const visible = files.slice(0, 4);
  const [previews, setPreviews] = useState<Record<string, string | undefined>>({});

  useEffect(() => {
    let cancelled = false;
    for (const file of visible) {
      if (previews[file.path]) continue;
      void window.electronAPI.getPreview(file.path).then((preview) => {
        if (!cancelled) setPreviews((p) => ({ ...p, [file.path]: preview }));
      }).catch(() => undefined);
    }
    return () => { cancelled = true; };
  }, [visible, previews]);

  if (visible.length === 0) {
    return <div className="h-full flex items-center justify-center text-sm text-text-muted">Select images to compare</div>;
  }

  return (
    <div className={`h-full grid gap-px bg-border ${visible.length <= 2 ? 'grid-cols-2' : 'grid-cols-2 grid-rows-2'}`}>
      {visible.map((file) => {
        const src = previews[file.path] || file.thumbnail;
        const exposure = buildExposure(file);
        return (
          <div key={file.path} className="relative bg-black flex items-center justify-center overflow-hidden">
            {src ? (
              <img src={src} alt={file.name} className="max-w-full max-h-full object-contain" draggable={false} />
            ) : (
              <div className="text-xs text-text-muted">No preview</div>
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
