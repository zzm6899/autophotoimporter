import type { MediaFile } from '../../shared/types';
import { formatFileSize, formatExposure } from '../utils/formatters';

interface BestOfSelectionPanelProps {
  files: MediaFile[];
  title?: string;
  subtitle?: string;
  isBurst?: boolean;
  onPrevBurst?: () => void;
  onNextBurst?: () => void;
  onClose: () => void;
  onPickBest: (file: MediaFile) => void;
  onQueueBest: (file: MediaFile) => void;
  onRejectRest: (best: MediaFile) => void;
}

function explain(file: MediaFile): string {
  const parts = [
    file.isProtected ? 'protected' : '',
    file.rating ? `${file.rating} star` : '',
    file.faceCount ? `${file.faceCount} face${file.faceCount === 1 ? '' : 's'}` : '',
    typeof file.subjectSharpnessScore === 'number' ? `subject ${file.subjectSharpnessScore}` : '',
    typeof file.reviewScore === 'number' ? `score ${file.reviewScore}` : '',
    typeof file.sharpnessScore === 'number' ? `sharp ${file.sharpnessScore}` : '',
    file.blurRisk && file.blurRisk !== 'low' ? `${file.blurRisk} blur risk` : '',
    ...(file.reviewReasons ?? []),
  ].filter(Boolean);
  return [...new Set(parts)].join(', ') || 'ranked by file metadata';
}

function rankScore(file: MediaFile): number {
  return (
    (file.isProtected ? 80 : 0) +
    (file.rating ?? 0) * 18 +
    (file.faceCount ?? 0) * 35 +
    Math.min(50, (file.subjectSharpnessScore ?? 0) / 4) +
    Math.min(30, (file.sharpnessScore ?? 0) / 8) +
    Math.min(25, (file.reviewScore ?? 0) / 4) +
    (file.blurRisk === 'high' ? 30 : file.blurRisk === 'medium' ? 10 : 0)
  );
}

export function rankBestOfSelection(files: MediaFile[]): MediaFile[] {
  return files.slice().sort((a, b) =>
    Number(!!b.isProtected) - Number(!!a.isProtected) ||
    (b.rating ?? 0) - (a.rating ?? 0) ||
    (b.faceCount ?? 0) - (a.faceCount ?? 0) ||
    (b.subjectSharpnessScore ?? 0) - (a.subjectSharpnessScore ?? 0) ||
    Number(a.blurRisk === 'high') - Number(b.blurRisk === 'high') ||
    (b.sharpnessScore ?? 0) - (a.sharpnessScore ?? 0) ||
    (b.reviewScore ?? 0) - (a.reviewScore ?? 0) ||
    a.name.localeCompare(b.name),
  );
}

export function BestOfSelectionPanel({
  files,
  title = 'Best of Selection',
  subtitle,
  isBurst = false,
  onPrevBurst,
  onNextBurst,
  onClose,
  onPickBest,
  onQueueBest,
  onRejectRest,
}: BestOfSelectionPanelProps) {
  const ranked = rankBestOfSelection(files).slice(0, 6);
  const best = ranked[0];
  const second = ranked[1];
  const bestScore = Math.round(rankScore(best));
  const scoreGap = second ? Math.round(rankScore(best) - rankScore(second)) : bestScore;
  const analyzed = files.filter((f) =>
    typeof f.subjectSharpnessScore === 'number' ||
    typeof f.sharpnessScore === 'number' ||
    typeof f.reviewScore === 'number'
  ).length;
  const faceFiles = files.filter((f) => (f.faceCount ?? 0) > 0).length;
  const blurRisk = files.filter((f) => f.blurRisk === 'high' || f.blurRisk === 'medium').length;

  if (!best) return null;

  return (
    <div className="absolute inset-0 z-30 bg-surface/95 backdrop-blur-sm flex flex-col">
      <div className="shrink-0 px-3 py-2 border-b border-border flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-text">{title}</div>
          <div className="text-[10px] text-text-muted">
            {subtitle ? `${subtitle} · ` : ''}{files.length} files · {analyzed}/{files.length} analyzed · {faceFiles} with faces · {blurRisk} blur risk
          </div>
        </div>
        <button
          onClick={() => onPickBest(best)}
          title="Mark only the top-ranked candidate as picked. Does not reject the other files."
          className="px-2.5 py-1 text-[11px] rounded bg-yellow-500/15 text-yellow-300 hover:bg-yellow-500/25"
        >
          Pick Best
        </button>
        {isBurst && (
          <>
            <button
              onClick={onPrevBurst}
              title="Move to the previous burst and rank its keeper candidates."
              className="px-2 py-1 text-[11px] rounded bg-surface-raised text-text-secondary hover:bg-border"
            >
              Prev Burst
            </button>
            <button
              onClick={onNextBurst}
              title="Move to the next burst and rank its keeper candidates."
              className="px-2 py-1 text-[11px] rounded bg-surface-raised text-text-secondary hover:bg-border"
            >
              Next Burst
            </button>
          </>
        )}
        <button
          onClick={() => onQueueBest(best)}
          title="Add the top-ranked candidate to the import queue without changing pick/reject flags."
          className="px-2.5 py-1 text-[11px] rounded bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
        >
          Queue Best
        </button>
        <button
          onClick={() => onRejectRest(best)}
          title="Pick the top-ranked candidate and reject every other file in this selection."
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
        <div className="mb-3 grid grid-cols-1 lg:grid-cols-[1.2fr_0.8fr] gap-3">
          <div className="border border-yellow-400/50 bg-yellow-500/10 rounded p-3">
            <div className="text-[10px] uppercase tracking-wider text-yellow-300 font-semibold">Top candidate</div>
            <div className="mt-1 text-sm text-text font-mono truncate" title={best.path}>{best.name}</div>
            <div className="mt-1 text-[11px] text-text-secondary">
              {explain(best)}
            </div>
            <div className="mt-2 flex flex-wrap gap-1 text-[9px] text-text-muted">
              <span className="px-1.5 py-0.5 rounded bg-surface" title="Manual/metadata priority: protected files and star ratings are trusted first.">
                1 protected/rating
              </span>
              <span className="px-1.5 py-0.5 rounded bg-surface" title="Then the local face detector and subject-region sharpness are used.">
                2 faces/subject
              </span>
              <span className="px-1.5 py-0.5 rounded bg-surface" title="Then whole-image sharpness, blur risk, and smart review score.">
                3 sharpness/review
              </span>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="border border-border bg-surface-alt rounded p-2">
              <div className="text-[9px] text-text-muted uppercase">Confidence</div>
              <div className={`text-sm font-semibold ${scoreGap >= 12 ? 'text-emerald-300' : scoreGap >= 4 ? 'text-yellow-300' : 'text-red-300'}`}>
                {scoreGap >= 12 ? 'High' : scoreGap >= 4 ? 'Medium' : 'Close'}
              </div>
              <div className="text-[9px] text-text-muted">gap {scoreGap}</div>
            </div>
            <div className="border border-border bg-surface-alt rounded p-2">
              <div className="text-[9px] text-text-muted uppercase">Subject</div>
              <div className="text-sm font-semibold text-yellow-300">{best.subjectSharpnessScore ?? '-'}</div>
              <div className="text-[9px] text-text-muted">{best.faceCount ? `${best.faceCount} face` : 'center'}</div>
            </div>
            <div className="border border-border bg-surface-alt rounded p-2">
              <div className="text-[9px] text-text-muted uppercase">Review</div>
              <div className="text-sm font-semibold text-text">{best.reviewScore ?? '-'}</div>
              <div className="text-[9px] text-text-muted">{best.blurRisk ?? 'pending'}</div>
            </div>
          </div>
        </div>
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
                  <img
                    src={file.thumbnail}
                    alt={file.name}
                    className="w-full h-full object-contain"
                    decoding="async"
                    loading={idx < 2 ? 'eager' : 'lazy'}
                  />
                ) : (
                  <span className="text-xs text-text-muted">No preview</span>
                )}
                {file.faceBoxes?.map((box, faceIdx) => (
                  <div
                    key={faceIdx}
                    className="absolute border-2 border-emerald-300/90 shadow-[0_0_0_1px_rgba(0,0,0,0.5)] pointer-events-none"
                    style={{
                      left: `${box.x * 100}%`,
                      top: `${box.y * 100}%`,
                      width: `${box.width * 100}%`,
                      height: `${box.height * 100}%`,
                    }}
                    title="Detected face"
                  />
                ))}
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
                  {file.faceCount ? <span>{file.faceCount} face{file.faceCount === 1 ? '' : 's'}</span> : null}
                </div>
                <div className="mt-1 text-[10px] text-text-secondary">{explain(file)}</div>
                <div className="mt-2 grid grid-cols-3 gap-1 text-[9px]">
                  <div title="Subject/face-region sharpness. Higher is better." className="bg-surface rounded px-1.5 py-1">
                    <div className="text-text-muted">Subject</div>
                    <div className="text-yellow-300 font-mono">{file.subjectSharpnessScore ?? '-'}</div>
                  </div>
                  <div title="Whole-thumbnail sharpness. Higher is better." className="bg-surface rounded px-1.5 py-1">
                    <div className="text-text-muted">Sharp</div>
                    <div className="text-text font-mono">{file.sharpnessScore ?? '-'}</div>
                  </div>
                  <div title="Combined keeper score from rating, protected flag, subject focus, blur risk, and review signals." className="bg-surface rounded px-1.5 py-1">
                    <div className="text-text-muted">Score</div>
                    <div className="text-text font-mono">{file.reviewScore ?? '-'}</div>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
