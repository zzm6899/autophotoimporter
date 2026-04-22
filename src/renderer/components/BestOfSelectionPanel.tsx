import type { MediaFile } from '../../shared/types';
import { formatFileSize, formatExposure } from '../utils/formatters';

interface BestOfSelectionPanelProps {
  files: MediaFile[];
  onClose: () => void;
  onPickBest: (file: MediaFile) => void;
  onQueueBest: (file: MediaFile) => void;
  onRejectRest: (best: MediaFile) => void;
}

function explain(file: MediaFile): string {
  const parts = [
    file.isProtected ? 'protected' : '',
    file.rating ? `${file.rating} star` : '',
    typeof file.reviewScore === 'number' ? `score ${file.reviewScore}` : '',
    typeof file.sharpnessScore === 'number' ? `sharp ${file.sharpnessScore}` : '',
    file.blurRisk && file.blurRisk !== 'low' ? `${file.blurRisk} blur risk` : '',
    ...(file.reviewReasons ?? []),
  ].filter(Boolean);
  return [...new Set(parts)].join(', ') || 'ranked by file metadata';
}

export function rankBestOfSelection(files: MediaFile[]): MediaFile[] {
  return files.slice().sort((a, b) =>
    Number(!!b.isProtected) - Number(!!a.isProtected) ||
    (b.rating ?? 0) - (a.rating ?? 0) ||
    (b.reviewScore ?? 0) - (a.reviewScore ?? 0) ||
    (b.sharpnessScore ?? 0) - (a.sharpnessScore ?? 0) ||
    Number(a.blurRisk === 'high') - Number(b.blurRisk === 'high') ||
    a.name.localeCompare(b.name),
  );
}

export function BestOfSelectionPanel({
  files,
  onClose,
  onPickBest,
  onQueueBest,
  onRejectRest,
}: BestOfSelectionPanelProps) {
  const ranked = rankBestOfSelection(files).slice(0, 6);
  const best = ranked[0];

  if (!best) return null;

  return (
    <div className="absolute inset-0 z-30 bg-surface/95 backdrop-blur-sm flex flex-col">
      <div className="shrink-0 px-3 py-2 border-b border-border flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-text">Best of Selection</div>
          <div className="text-[10px] text-text-muted">{files.length} files ranked locally</div>
        </div>
        <button
          onClick={() => onPickBest(best)}
          className="px-2.5 py-1 text-[11px] rounded bg-yellow-500/15 text-yellow-300 hover:bg-yellow-500/25"
        >
          Pick Best
        </button>
        <button
          onClick={() => onQueueBest(best)}
          className="px-2.5 py-1 text-[11px] rounded bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
        >
          Queue Best
        </button>
        <button
          onClick={() => onRejectRest(best)}
          className="px-2.5 py-1 text-[11px] rounded bg-red-500/10 text-red-300 hover:bg-red-500/20"
        >
          Reject Rest
        </button>
        <button
          onClick={onClose}
          className="px-2 py-1 text-[11px] rounded bg-surface-raised text-text-secondary hover:bg-border"
        >
          Close
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {ranked.map((file, idx) => (
            <div
              key={file.path}
              className={`border rounded overflow-hidden bg-surface-alt ${
                idx === 0 ? 'border-yellow-400/70' : 'border-border'
              }`}
            >
              <div className="aspect-[4/3] bg-black flex items-center justify-center relative">
                {file.thumbnail ? (
                  <img src={file.thumbnail} alt={file.name} className="w-full h-full object-contain" decoding="async" />
                ) : (
                  <span className="text-xs text-text-muted">No preview</span>
                )}
                <div className="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/70 text-white text-[10px] font-semibold">
                  #{idx + 1}
                </div>
                {idx === 0 && (
                  <div className="absolute top-2 right-2 px-2 py-0.5 rounded bg-yellow-400 text-black text-[10px] font-semibold">
                    BEST
                  </div>
                )}
              </div>
              <div className="p-2">
                <div className="text-xs text-text font-mono truncate" title={file.path}>{file.name}</div>
                <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-text-muted">
                  {formatExposure(file) && <span>{formatExposure(file)}</span>}
                  <span>{formatFileSize(file.size)}</span>
                  {file.blurRisk && <span>{file.blurRisk} blur</span>}
                </div>
                <div className="mt-1 text-[10px] text-text-secondary">{explain(file)}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
