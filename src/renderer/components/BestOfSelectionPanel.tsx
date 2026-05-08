import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { MediaFile } from '../../shared/types';
import { formatFileSize, formatExposure } from '../utils/formatters';
import { getCachedPreview } from '../utils/previewCache';
import { bestShotScore, rankBestShots, scoreGapConfidence } from '../../shared/review';

interface BestOfSelectionPanelProps {
  files: MediaFile[];
  title?: string;
  subtitle?: string;
  isBurst?: boolean;
  onPrevBurst?: () => void;
  onNextBurst?: () => void;
  isBatch?: boolean;
  onPrevBatch?: () => void;
  onNextBatch?: () => void;
  onClose: () => void;
  onPickFile?: (file: MediaFile, pick: 'selected' | 'rejected' | undefined) => void;
  onPickBest: (file: MediaFile) => void;
  onQueueBest: (file: MediaFile) => void;
  onRejectRest: (best: MediaFile) => void;
  queuedPaths?: string[];
}

function explain(file: MediaFile): string {
  const parts = [
    file.isProtected ? 'protected' : '',
    file.rating ? `${file.rating} star` : '',
    file.faceCount ? `${file.faceCount} face${file.faceCount === 1 ? '' : 's'}` : '',
    file.personCount ? `${file.personCount} person${file.personCount === 1 ? '' : 's'}` : '',
    file.faceGroupId ? `face group ${file.faceGroupSize ?? 0}` : '',
    typeof file.subjectSharpnessScore === 'number' ? `subject ${file.subjectSharpnessScore}` : '',
    typeof file.reviewScore === 'number' ? `score ${file.reviewScore}` : '',
    typeof file.sharpnessScore === 'number' ? `sharp ${file.sharpnessScore}` : '',
    file.blurRisk && file.blurRisk !== 'low' ? `${file.blurRisk} blur risk` : '',
    ...(file.reviewReasons ?? []),
    ...(file.subjectReasons ?? []),
  ].filter(Boolean);
  return [...new Set(parts)].join(', ') || 'ranked by file metadata';
}

function rankScore(file: MediaFile): number {
  return bestShotScore(file);
}

export function rankBestOfSelection(files: MediaFile[]): MediaFile[] {
  return rankBestShots(files);
}

function autoAcceptSummary(best: MediaFile, second: MediaFile | undefined, scoreGap: number): {
  label: string;
  tone: 'safe' | 'review' | 'manual';
  detail: string;
} {
  if (best.blurRisk === 'high') {
    return {
      label: 'Manual review',
      tone: 'manual',
      detail: 'Top pick still has high blur risk, so compare before accepting.',
    };
  }
  if (!second) {
    return {
      label: 'Safe to accept',
      tone: 'safe',
      detail: 'Only one candidate is in this set.',
    };
  }
  const confidence = scoreGapConfidence(scoreGap);
  if (confidence === 'high') {
    return {
      label: 'Safe to accept',
      tone: 'safe',
      detail: `Top pick is ${scoreGap} points ahead of #2.`,
    };
  }
  if (confidence === 'medium') {
    return {
      label: 'Review #2',
      tone: 'review',
      detail: `Top pick leads by ${scoreGap} points; compare the runner-up before auto-accepting.`,
    };
  }
  return {
    label: 'Manual compare',
    tone: 'manual',
    detail: `Only ${Math.max(0, scoreGap)} points separate the top two.`,
  };
}

function topPickEvidence(best: MediaFile, second: MediaFile | undefined, scoreGap: number): string[] {
  const evidence: string[] = [];
  if (best.isProtected) evidence.push('Protected file');
  if ((best.rating ?? 0) > 0) evidence.push(`${best.rating}-star rating`);
  if (second) evidence.push(`${scoreGap >= 0 ? '+' : ''}${scoreGap} vs #2`);

  const bestSubject = best.subjectSharpnessScore ?? best.sharpnessScore;
  const secondSubject = second ? second.subjectSharpnessScore ?? second.sharpnessScore : undefined;
  if (typeof bestSubject === 'number' && typeof secondSubject === 'number') {
    const subjectGap = Math.round(bestSubject - secondSubject);
    if (subjectGap >= 12) evidence.push(`Sharper subject +${subjectGap}`);
    else if (subjectGap <= -12) evidence.push(`Softer subject ${subjectGap}`);
  } else if (typeof bestSubject === 'number') {
    evidence.push(`Subject ${bestSubject}`);
  }

  const bestFaces = best.faceCount ?? best.faceBoxes?.length ?? 0;
  const secondFaces = second ? second.faceCount ?? second.faceBoxes?.length ?? 0 : 0;
  if (bestFaces > 0) evidence.push(second && bestFaces !== secondFaces ? `${bestFaces} faces vs ${secondFaces}` : `${bestFaces} face${bestFaces === 1 ? '' : 's'}`);
  if (best.blurRisk && best.blurRisk !== 'low') evidence.push(`${best.blurRisk} blur risk`);
  return evidence.slice(0, 4);
}

type BestOfActionScope = 'batch' | 'burst' | 'selection';

interface BestOfActionSummary {
  scopeLabel: string;
  pickButtonLabel: string;
  pickLabel: string;
  queueButtonLabel: string;
  queueLabel: string;
  rejectRestButtonLabel: string;
  rejectRestLabel: string;
  queueState: 'queued' | 'ready';
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function summarizeBestOfActions(
  files: MediaFile[],
  best: MediaFile | undefined,
  queuedPaths: Iterable<string> = [],
  scope: BestOfActionScope = 'selection',
): BestOfActionSummary | null {
  if (!best) return null;

  const queuedSet = queuedPaths instanceof Set ? queuedPaths : new Set(queuedPaths);
  const topName = best.name || 'top candidate';
  const total = files.length;
  const restCount = files.filter((file) => file.path !== best.path).length;
  const otherCandidates = pluralize(restCount, 'other candidate');
  const scopePrefix =
    scope === 'batch'
      ? `Current batch page: ${pluralize(total, 'candidate')}.`
      : scope === 'burst'
        ? `Current burst: ${pluralize(total, 'candidate')}.`
        : `Current review set: ${pluralize(total, 'candidate')}.`;
  const scopeLabel = scope === 'batch'
    ? `${scopePrefix} Next/Prev page changes which candidates these actions affect.`
    : `${scopePrefix} Actions apply only to this panel.`;

  const pickStart = best.pick === 'selected'
    ? `${topName} is already picked`
    : best.pick === 'rejected'
      ? `Pick Best changes ${topName} from rejected to picked`
      : `Pick Best marks ${topName} as picked`;
  const pickLabel = restCount > 0
    ? `${pickStart}; ${otherCandidates} ${restCount === 1 ? 'stays' : 'stay'} unchanged.`
    : `${pickStart}.`;
  const pickButtonLabel = scope === 'batch' ? 'Pick Page Best' : 'Pick Best';

  const queueState = queuedSet.has(best.path) ? 'queued' : 'ready';
  const queueLabel = queueState === 'queued'
    ? `${topName} is already in the import queue; pick/reject flags stay unchanged.`
    : `Queue Best adds ${topName} to the import queue; pick/reject flags stay unchanged.`;
  const queueButtonLabel = scope === 'batch' ? 'Queue Page Best' : 'Queue Best';

  const rejectRestLabel = restCount > 0
    ? `Reject Rest marks ${topName} picked and rejects ${otherCandidates} in this panel.`
    : `Reject Rest keeps ${topName} picked because it is the only candidate.`;
  const rejectRestButtonLabel = scope === 'batch' ? 'Reject Page Rest' : 'Reject Rest';

  return { scopeLabel, pickButtonLabel, pickLabel, queueButtonLabel, queueLabel, rejectRestButtonLabel, rejectRestLabel, queueState };
}

// Corrects face box positions for object-contain letterboxing.
function LetterboxedFaceBoxes({
  boxes,
  personBoxes = [],
  imgNaturalW,
  imgNaturalH,
}: {
  boxes: NonNullable<MediaFile['faceBoxes']>;
  personBoxes?: NonNullable<MediaFile['personBoxes']>;
  imgNaturalW: number;
  imgNaturalH: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [cSize, setCSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const el = containerRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) =>
      setCSize({ w: entry.contentRect.width, h: entry.contentRect.height })
    );
    ro.observe(el);
    setCSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  if (!cSize) return <div ref={containerRef} className="absolute inset-0 pointer-events-none" />;

  const scale = Math.min(cSize.w / imgNaturalW, cSize.h / imgNaturalH);
  const rW = imgNaturalW * scale;
  const rH = imgNaturalH * scale;
  const offX = (cSize.w - rW) / 2;
  const offY = (cSize.h - rH) / 2;

  return (
    <div ref={containerRef} className="absolute inset-0 pointer-events-none">
      {personBoxes.map((box, i) => (
        <div
          key={`person-${i}`}
          className="absolute rounded-sm border border-dashed border-sky-300/70 shadow-[0_0_0_1px_rgba(0,0,0,0.45)]"
          style={{
            left: `${((box.x * rW + offX) / cSize.w) * 100}%`,
            top: `${((box.y * rH + offY) / cSize.h) * 100}%`,
            width: `${(box.width * rW / cSize.w) * 100}%`,
            height: `${(box.height * rH / cSize.h) * 100}%`,
          }}
          title={`Person detected${typeof box.score === 'number' ? ` (${Math.round(box.score * 100)}%)` : ''}`}
        />
      ))}
      {boxes.map((box, i) => {
        const eyeScore = box.eyeScore ?? 0;
        return (
          <div
            key={i}
            className={`absolute shadow-[0_0_0_1px_rgba(0,0,0,0.5)] rounded-sm ${
              eyeScore >= 2 ? 'border-2 border-emerald-400/90' : 'border border-yellow-400/70'
            }`}
            style={{
              left: `${((box.x * rW + offX) / cSize.w) * 100}%`,
              top: `${((box.y * rH + offY) / cSize.h) * 100}%`,
              width: `${(box.width * rW / cSize.w) * 100}%`,
              height: `${(box.height * rH / cSize.h) * 100}%`,
            }}
            title={eyeScore >= 2 ? 'Eyes open detected' : eyeScore === 1 ? 'One eye visible' : 'Face detected'}
          />
        );
      })}
    </div>
  );
}

// Fullscreen lightbox with left/right navigation and pick/reject actions.
function ImageLightbox({
  ranked,
  initialIndex,
  previews,
  onClose,
  onPickFile,
}: {
  ranked: MediaFile[];
  initialIndex: number;
  previews: Map<string, string>;
  onClose: () => void;
  onPickFile?: (file: MediaFile, pick: 'selected' | 'rejected' | undefined) => void;
}) {
  const [idx, setIdx] = useState(initialIndex);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const isDragging = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  const [imgNatural, setImgNatural] = useState<{ w: number; h: number } | null>(null);

  const file = ranked[idx];
  const src = previews.get(file?.path ?? '') ?? file?.thumbnail;

  // Reset zoom/pan on file change
  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }); setImgNatural(null); }, [idx]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        setIdx((i) => Math.max(0, Math.min(ranked.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1))));
      }
      if ((e.key === 'p' || e.key === 'P') && file) onPickFile?.(file, file.pick === 'selected' ? undefined : 'selected');
      if ((e.key === 'x' || e.key === 'X') && file) onPickFile?.(file, file.pick === 'rejected' ? undefined : 'rejected');
      if ((e.key === 'u' || e.key === 'U') && file) onPickFile?.(file, undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onPickFile, file, ranked.length]);

  const wheelRef = useRef<HTMLDivElement>(null);
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    setZoom((z) => Math.min(8, Math.max(1, z * Math.exp(-e.deltaY * 0.008))));
  }, []);
  useEffect(() => {
    const el = wheelRef.current;
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

  const handlePointerUp = useCallback(() => { isDragging.current = false; }, []);

  const handleDoubleClick = useCallback(() => {
    if (zoom > 1) { setZoom(1); setPan({ x: 0, y: 0 }); }
    else setZoom(3);
  }, [zoom]);

  if (!file) return null;

  const isPicked = file.pick === 'selected';
  const isRejected = file.pick === 'rejected';

  return (
    <div className="fixed inset-0 z-50 bg-black/92 flex flex-col">
      {/* Top bar */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-2 bg-black/60 backdrop-blur-sm border-b border-white/10">
        <span className="text-white/60 text-[11px] font-mono">#{idx + 1} / {ranked.length}</span>
        <span className="text-white text-[11px] font-mono truncate flex-1">{file.name}</span>
        {onPickFile && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => onPickFile(file, isPicked ? undefined : 'selected')}
              className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                isPicked ? 'bg-yellow-400/30 text-yellow-300 border border-yellow-400/50' : 'bg-white/10 text-white/70 hover:bg-yellow-400/20 hover:text-yellow-300'
              }`}
              title="Pick (P)"
            >
              {isPicked ? '★ Picked' : 'Pick'}
            </button>
            <button
              onClick={() => onPickFile(file, isRejected ? undefined : 'rejected')}
              className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                isRejected ? 'bg-red-500/30 text-red-300 border border-red-500/50' : 'bg-white/10 text-white/70 hover:bg-red-500/20 hover:text-red-300'
              }`}
              title="Reject (X)"
            >
              {isRejected ? '✕ Rejected' : 'Reject'}
            </button>
            {(isPicked || isRejected) && (
              <button
                onClick={() => onPickFile(file, undefined)}
                className="px-2 py-1 rounded text-[11px] text-white/50 hover:text-white/80 bg-white/5 hover:bg-white/15 transition-colors"
                title="Clear (U)"
              >
                Clear
              </button>
            )}
          </div>
        )}
        <button onClick={onClose} className="ml-2 px-2.5 py-1 rounded bg-white/10 text-white/60 hover:text-white text-[11px]">
          ✕
        </button>
      </div>

      {/* Image area */}
      <div
        ref={wheelRef}
        className="flex-1 min-h-0 relative flex items-center justify-center overflow-hidden"
        style={{ cursor: zoom > 1 ? 'grab' : 'default' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onDoubleClick={handleDoubleClick}
      >
        {src ? (
          <div
            className="relative"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: 'center center',
              transition: isDragging.current ? 'none' : 'transform 0.15s ease-out',
            }}
          >
            <img
              src={src}
              alt={file.name}
              className="max-w-[92vw] max-h-[calc(100vh-8rem)] object-contain"
              draggable={false}
              onLoad={(e) => {
                const el = e.currentTarget;
                setImgNatural({ w: el.naturalWidth, h: el.naturalHeight });
              }}
            />
            {zoom <= 1 && imgNatural && (file.faceBoxes?.length ?? 0) > 0 && (
              <div className="absolute inset-0 pointer-events-none">
                {file.personBoxes?.map((box, i) => (
                  <div
                    key={`person-${i}`}
                    className="absolute rounded-sm border border-dashed border-sky-300/70 shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
                    style={{
                      left: `${box.x * 100}%`,
                      top: `${box.y * 100}%`,
                      width: `${box.width * 100}%`,
                      height: `${box.height * 100}%`,
                    }}
                    title={`Person detected${typeof box.score === 'number' ? ` (${Math.round(box.score * 100)}%)` : ''}`}
                  />
                ))}
                {file.faceBoxes!.map((box, i) => (
                  <div
                    key={i}
                    className={`absolute shadow-[0_0_0_1px_rgba(0,0,0,0.5)] rounded-sm ${
                      (box.eyeScore ?? 0) >= 2 ? 'border-2 border-emerald-400/90' : 'border border-yellow-400/70'
                    }`}
                    style={{
                      left: `${box.x * 100}%`,
                      top: `${box.y * 100}%`,
                      width: `${box.width * 100}%`,
                      height: `${box.height * 100}%`,
                    }}
                    title={(box.eyeScore ?? 0) >= 2 ? 'Eyes open' : 'Face detected'}
                  />
                ))}
              </div>
            )}
            {zoom <= 1 && imgNatural && (file.faceBoxes?.length ?? 0) === 0 && (file.personBoxes?.length ?? 0) > 0 && (
              <div className="absolute inset-0 pointer-events-none">
                {file.personBoxes!.map((box, i) => (
                  <div
                    key={i}
                    className="absolute rounded-sm border border-dashed border-sky-300/70 shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
                    style={{
                      left: `${box.x * 100}%`,
                      top: `${box.y * 100}%`,
                      width: `${box.width * 100}%`,
                      height: `${box.height * 100}%`,
                    }}
                    title={`Person detected${typeof box.score === 'number' ? ` (${Math.round(box.score * 100)}%)` : ''}`}
                  />
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="text-white/40 text-sm">Loading preview…</div>
        )}

        {/* Prev / next arrows */}
        {idx > 0 && (
          <button
            onClick={() => setIdx((i) => i - 1)}
            className="absolute left-3 top-1/2 -translate-y-1/2 bg-black/50 hover:bg-black/80 text-white rounded-full w-10 h-10 flex items-center justify-center text-xl transition-colors"
            title="Previous (←)"
          >
            ‹
          </button>
        )}
        {idx < ranked.length - 1 && (
          <button
            onClick={() => setIdx((i) => i + 1)}
            className="absolute right-3 top-1/2 -translate-y-1/2 bg-black/50 hover:bg-black/80 text-white rounded-full w-10 h-10 flex items-center justify-center text-xl transition-colors"
            title="Next (→)"
          >
            ›
          </button>
        )}
      </div>

      {/* Bottom status */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-1.5 bg-black/60 backdrop-blur-sm border-t border-white/10 text-[10px] text-white/50">
        <span>{explain(file)}</span>
        {zoom > 1 && <span className="ml-auto font-mono">{Math.round(zoom * 100)}%</span>}
        <span className="ml-auto">← → navigate · Scroll zoom · Dbl-click 3× · P pick · X reject · Esc close</span>
      </div>

      {/* Thumbnail strip */}
      <div className="shrink-0 flex gap-1 px-3 py-2 bg-black/70 overflow-x-auto">
        {ranked.map((f, i) => (
          <button
            key={f.path}
            onClick={() => setIdx(i)}
            className={`relative shrink-0 w-16 h-12 rounded overflow-hidden border-2 transition-colors ${
              i === idx ? 'border-white' : 'border-transparent hover:border-white/40'
            }`}
            title={f.name}
          >
            {(previews.get(f.path) ?? f.thumbnail) ? (
              <img
                src={previews.get(f.path) ?? f.thumbnail}
                alt={f.name}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full bg-white/10" />
            )}
            {f.pick === 'selected' && (
              <div className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-yellow-400" />
            )}
            {f.pick === 'rejected' && (
              <div className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-red-500" />
            )}
            {i === 0 && (
              <div className="absolute bottom-0 inset-x-0 bg-yellow-400/80 text-black text-[8px] text-center font-bold">
                BEST
              </div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

export function BestOfSelectionPanel({
  files,
  title = 'Best of Selection',
  subtitle,
  isBurst = false,
  onPrevBurst,
  onNextBurst,
  isBatch = false,
  onPrevBatch,
  onNextBatch,
  onClose,
  onPickFile,
  onPickBest,
  onQueueBest,
  onRejectRest,
  queuedPaths = [],
}: BestOfSelectionPanelProps) {
  const ranked = useMemo(() => rankBestOfSelection(files).slice(0, 6), [files]);
  const best = ranked[0];
  const second = ranked[1];
  const bestScore = best ? Math.round(rankScore(best)) : 0;
  const scoreGap = best && second ? Math.round(rankScore(best) - rankScore(second)) : bestScore;
  const confidence = scoreGapConfidence(scoreGap);
  const readiness = best ? autoAcceptSummary(best, second, scoreGap) : null;
  const evidence = best ? topPickEvidence(best, second, scoreGap) : [];
  const actionSummary = summarizeBestOfActions(
    files,
    best,
    queuedPaths,
    isBatch ? 'batch' : isBurst ? 'burst' : 'selection',
  );
  const actionTitle = (detail: string | undefined, fallback: string) =>
    actionSummary ? `${actionSummary.scopeLabel} ${detail ?? fallback}` : fallback;
  const panelStats = useMemo(() => {
    let analyzed = 0;
    let faceFiles = 0;
    let blurRisk = 0;
    for (const f of files) {
      if (
        typeof f.subjectSharpnessScore === 'number' ||
        typeof f.sharpnessScore === 'number' ||
        typeof f.reviewScore === 'number'
      ) analyzed++;
      if ((f.faceCount ?? 0) > 0) faceFiles++;
      if (f.blurRisk === 'high' || f.blurRisk === 'medium') blurRisk++;
    }
    return { analyzed, faceFiles, blurRisk };
  }, [files]);
  const { analyzed, faceFiles, blurRisk } = panelStats;

  const [previews, setPreviews] = useState<Map<string, string>>(() => new Map());
  const [imgNaturals, setImgNaturals] = useState<Map<string, { w: number; h: number }>>(() => new Map());
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(ranked.map(async (file) => {
      const src = await getCachedPreview(file.path, 'preview', 'high');
      if (!src) return null;
      const natural = await new Promise<{ w: number; h: number } | null>((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => resolve(null);
        img.src = src;
      });
      return natural ? { path: file.path, src, natural } : null;
    })).then((loaded) => {
      if (cancelled) return;
      const entries = loaded.filter((entry): entry is { path: string; src: string; natural: { w: number; h: number } } => !!entry);
      if (entries.length === 0) return;
      setPreviews((prev) => {
        const next = new Map(prev);
        for (const entry of entries) next.set(entry.path, entry.src);
        return next;
      });
      setImgNaturals((prev) => {
        const next = new Map(prev);
        for (const entry of entries) next.set(entry.path, entry.natural);
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [ranked]);

  if (!best) return null;

  return (
    <>
      {lightboxIndex !== null && (
        <ImageLightbox
          ranked={ranked}
          initialIndex={lightboxIndex}
          previews={previews}
          onClose={() => setLightboxIndex(null)}
          onPickFile={onPickFile}
        />
      )}
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
            title={actionTitle(actionSummary?.pickLabel, 'Mark the top-ranked candidate as picked.')}
            className="px-2.5 py-1 text-[11px] rounded bg-yellow-500/15 text-yellow-300 hover:bg-yellow-500/25"
          >
            {actionSummary?.pickButtonLabel ?? 'Pick Best'}
          </button>
          {isBurst && (
            <>
              <button
                onClick={onPrevBurst}
                className="flex items-center gap-1 px-2 py-1 text-[11px] rounded bg-surface-raised text-text-secondary hover:bg-border"
                title="Previous burst · Shift+←"
              >
                ← Prev burst
              </button>
              <button
                onClick={onNextBurst}
                className="flex items-center gap-1 px-2 py-1 text-[11px] rounded bg-surface-raised text-text-secondary hover:bg-border"
                title="Next burst · Shift+→"
              >
                Next burst →
              </button>
            </>
          )}
          {isBatch && (
            <>
              <button
                onClick={onPrevBatch}
                className="flex items-center gap-1 px-2 py-1 text-[11px] rounded bg-surface-raised text-text-secondary hover:bg-border"
                title="Previous page of batch"
              >
                ← Prev page
              </button>
              <button
                onClick={onNextBatch}
                className="flex items-center gap-1 px-2 py-1 text-[11px] rounded bg-surface-raised text-text-secondary hover:bg-border"
                title="Next page of batch"
              >
                Next page →
              </button>
            </>
          )}
          <button
            onClick={() => onQueueBest(best)}
            title={actionTitle(actionSummary?.queueLabel, 'Add the top-ranked candidate to the import queue.')}
            className="px-2.5 py-1 text-[11px] rounded bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
          >
            {actionSummary?.queueButtonLabel ?? 'Queue Best'}
          </button>
          <button
            onClick={() => onRejectRest(best)}
            title={actionTitle(actionSummary?.rejectRestLabel, 'Pick the top-ranked candidate and reject the rest in this panel.')}
            className="px-2.5 py-1 text-[11px] rounded bg-red-500/10 text-red-300 hover:bg-red-500/20"
          >
            {actionSummary?.rejectRestButtonLabel ?? 'Reject Rest'}
          </button>
          <button onClick={onClose} className="px-2 py-1 text-[11px] rounded bg-surface-raised text-text-secondary hover:bg-border">
            Close
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          <div className="mb-3 grid grid-cols-1 lg:grid-cols-[1.2fr_0.8fr] gap-3">
            <div className="border border-yellow-400/50 bg-yellow-500/10 rounded p-3">
              <div className="text-[10px] uppercase tracking-wider text-yellow-300 font-semibold">Top candidate</div>
              <div className="mt-1 text-sm text-text font-mono truncate" title={best.path}>{best.name}</div>
              <div className="mt-1 text-[11px] text-text-secondary">{explain(best)}</div>
              {readiness && (
                <div
                  className={`mt-2 rounded border px-2.5 py-2 ${
                    readiness.tone === 'safe'
                      ? 'border-emerald-400/40 bg-emerald-500/10'
                      : readiness.tone === 'review'
                        ? 'border-yellow-400/40 bg-yellow-500/10'
                        : 'border-red-400/40 bg-red-500/10'
                  }`}
                >
                  <div
                    className={`text-[11px] font-semibold ${
                      readiness.tone === 'safe'
                        ? 'text-emerald-300'
                        : readiness.tone === 'review'
                          ? 'text-yellow-300'
                          : 'text-red-300'
                    }`}
                  >
                    {readiness.label}
                  </div>
                  <div className="mt-0.5 text-[10px] text-text-secondary">{readiness.detail}</div>
                  {evidence.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {evidence.map((item) => (
                        <span key={item} className="px-1.5 py-0.5 rounded bg-surface/80 text-[9px] text-text-muted">
                          {item}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="mt-2 flex flex-wrap gap-1 text-[9px] text-text-muted">
                <span className="px-1.5 py-0.5 rounded bg-surface" title="Protected files and star ratings are trusted first.">1 protected/rating</span>
                <span className="px-1.5 py-0.5 rounded bg-surface" title="Face detector + eye-open landmarks + subject sharpness.">2 faces/eyes/subject</span>
                <span className="px-1.5 py-0.5 rounded bg-surface" title="Whole-image sharpness, blur risk, and smart review score.">3 sharpness/review</span>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="border border-border bg-surface-alt rounded p-2">
                <div className="text-[9px] text-text-muted uppercase">Confidence</div>
                <div className={`text-sm font-semibold ${confidence === 'high' ? 'text-emerald-300' : confidence === 'medium' ? 'text-yellow-300' : 'text-red-300'}`}>
                  {confidence === 'high' ? 'High' : confidence === 'medium' ? 'Medium' : 'Close'}
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
            {ranked.map((file, idx) => {
              const src = previews.get(file.path) ?? file.thumbnail;
              const nat = imgNaturals.get(file.path);
              return (
                <div
                  key={file.path}
                  className={`border rounded overflow-hidden bg-surface-alt ${idx === 0 ? 'border-yellow-400/70' : 'border-border'}`}
                >
                  <div
                    className="aspect-[4/3] bg-black flex items-center justify-center relative group cursor-zoom-in"
                    onClick={() => setLightboxIndex(idx)}
                    title="Click to expand · ← → navigate · P pick · X reject"
                  >
                    {src ? (
                      <img src={src} alt={file.name} className="w-full h-full object-contain" decoding="async" loading={idx < 2 ? 'eager' : 'lazy'} />
                    ) : (
                      <span className="text-xs text-text-muted">No preview</span>
                    )}
                    {src && nat && ((file.faceBoxes?.length ?? 0) > 0 || (file.personBoxes?.length ?? 0) > 0) && (
                      <LetterboxedFaceBoxes
                        boxes={file.faceBoxes ?? []}
                        personBoxes={file.personBoxes ?? []}
                        imgNaturalW={nat.w}
                        imgNaturalH={nat.h}
                      />
                    )}
                    <div className="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/70 text-white text-[10px] font-semibold">#{idx + 1}</div>
                    {idx === 0 && (
                      <div className="absolute top-2 right-2 px-2 py-0.5 rounded bg-yellow-400 text-black text-[10px] font-semibold">BEST</div>
                    )}
                    {file.pick === 'selected' && (
                      <div className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-yellow-400/90 text-black text-[9px] font-bold">PICKED</div>
                    )}
                    {file.pick === 'rejected' && (
                      <div className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-red-500/90 text-white text-[9px] font-bold">REJECTED</div>
                    )}
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
                      <svg className="w-6 h-6 text-white opacity-0 group-hover:opacity-70 transition-opacity" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M3 4a1 1 0 011-1h4a1 1 0 010 2H6.414l2.293 2.293a1 1 0 11-1.414 1.414L5 6.414V8a1 1 0 01-2 0V4zm9 1a1 1 0 010-2h4a1 1 0 011 1v4a1 1 0 01-2 0V6.414l-2.293 2.293a1 1 0 11-1.414-1.414L13.586 5H12zm-9 7a1 1 0 012 0v1.586l2.293-2.293a1 1 0 111.414 1.414L6.414 15H8a1 1 0 010 2H4a1 1 0 01-1-1v-4zm13-1a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 010-2h1.586l-2.293-2.293a1 1 0 111.414-1.414L15 13.586V12a1 1 0 011-1z" clipRule="evenodd" />
                      </svg>
                    </div>
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
                      <div className="bg-surface rounded px-1.5 py-1" title="Subject/face-region sharpness.">
                        <div className="text-text-muted">Subject</div>
                        <div className="text-yellow-300 font-mono">{file.subjectSharpnessScore ?? '-'}</div>
                      </div>
                      <div className="bg-surface rounded px-1.5 py-1" title="Whole-thumbnail sharpness.">
                        <div className="text-text-muted">Sharp</div>
                        <div className="text-text font-mono">{file.sharpnessScore ?? '-'}</div>
                      </div>
                      <div className="bg-surface rounded px-1.5 py-1" title="Combined keeper score.">
                        <div className="text-text-muted">Score</div>
                        <div className="text-text font-mono">{file.reviewScore ?? '-'}</div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
