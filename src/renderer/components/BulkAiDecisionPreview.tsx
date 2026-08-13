import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Search, ShieldCheck, X } from 'lucide-react';
import type { MediaFile } from '../../shared/types';
import { bulkAiDecisionPage, bulkAiDecisionPlanStaleReason, selectedBulkAiDecisionItems, useBulkAiPreview, type BulkAiDecisionItem, type BulkAiDecisionOutcome } from '../context/BulkAiPreviewContext';
import { useAppState, useMergedFiles, useReviewScoresVersion } from '../context/ImportContext';
import { getCachedPreview } from '../utils/previewCache';
import { orientationSwapsAxes, orientationTransform } from '../utils/orientation';

const PAGE_SIZE = 80;

const OUTCOME_STYLE: Record<BulkAiDecisionOutcome, { label: string; className: string }> = {
  keep: { label: 'Pick', className: 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200' },
  reject: { label: 'Reject', className: 'border-red-400/40 bg-red-500/10 text-red-200' },
  queue: { label: 'Queue', className: 'border-blue-400/40 bg-blue-500/10 text-blue-200' },
};

function DecisionThumbnail({ file }: { file: MediaFile }) {
  const [preview, setPreview] = useState(file.thumbnail);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    if (preview || loadFailed) return;
    let cancelled = false;
    void getCachedPreview(file.path, 'thumb', 'normal')
      .then((src) => {
        if (cancelled) return;
        if (src) setPreview(src);
        else setLoadFailed(true);
      })
      .catch(() => { if (!cancelled) setLoadFailed(true); });
    return () => { cancelled = true; };
  }, [file.path, loadFailed, preview]);
  const plane = natural ? (() => {
    const displayWidth = orientationSwapsAxes(file.orientation) ? natural.height : natural.width;
    const displayHeight = orientationSwapsAxes(file.orientation) ? natural.width : natural.height;
    const scale = Math.min(80 / Math.max(1, displayWidth), 64 / Math.max(1, displayHeight));
    return { width: natural.width * scale, height: natural.height * scale };
  })() : { width: 80, height: 64 };
  return (
    <div className="relative flex h-16 w-20 shrink-0 items-center justify-center overflow-hidden rounded bg-black">
      {preview ? (
        <div className="relative shrink-0" style={{ width: plane.width, height: plane.height, transform: orientationTransform(file.orientation), transformOrigin: 'center' }}>
          <img
            src={preview}
            alt=""
            className="absolute inset-0 h-full w-full"
            style={{ imageOrientation: 'none' }}
            onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          />
          {(file.personBoxes ?? []).map((box, index) => (
            <span key={`person-${index}`} aria-hidden="true" className="absolute border border-dashed border-sky-300/80" style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.width * 100}%`, height: `${box.height * 100}%` }} />
          ))}
          {(file.faceBoxes ?? []).map((box, index) => (
            <span key={`face-${index}`} aria-hidden="true" className="absolute border border-yellow-300/90" style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.width * 100}%`, height: `${box.height * 100}%` }} />
          ))}
        </div>
      ) : (
        <button
          type="button"
          className="flex h-full w-full items-center justify-center text-[9px] text-text-muted hover:text-text"
          onClick={() => setLoadFailed(false)}
          title={`Load preview for ${file.name}`}
        >
          {loadFailed ? 'Retry preview' : 'Loading…'}
        </button>
      )}
    </div>
  );
}

function decisionSearchText(item: BulkAiDecisionItem, file: MediaFile | undefined): string {
  return [file?.name, item.path, item.outcome, item.groupLabel, ...item.reasons].filter(Boolean).join(' ').toLowerCase();
}

export function BulkAiDecisionPreview() {
  const files = useMergedFiles();
  const { selectedSource, activeScanId } = useAppState();
  const reviewVersion = useReviewScoresVersion();
  const { plan, closeBulkAiPreview } = useBulkAiPreview();
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [outcomeFilter, setOutcomeFilter] = useState<'all' | BulkAiDecisionOutcome>('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const byPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);

  useEffect(() => {
    setExcluded(new Set());
    setOutcomeFilter('all');
    setQuery('');
    setPage(0);
    if (plan) {
      previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    }
    return () => previousFocusRef.current?.focus();
  }, [plan?.id]);

  useEffect(() => {
    if (!plan) return;
    const handleKey = (event: KeyboardEvent) => {
      // While this modal is open, prevent app-level culling shortcuts from
      // changing the gallery behind the proposal. Native input behaviour stays.
      event.stopImmediatePropagation();
      if (event.key === 'Tab') {
        const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [])].filter((element) => !element.hasAttribute('hidden'));
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) {
          event.preventDefault();
          return;
        }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeBulkAiPreview();
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [closeBulkAiPreview, plan]);

  const counts = useMemo(() => {
    const value: Record<BulkAiDecisionOutcome, number> = { keep: 0, reject: 0, queue: 0 };
    for (const item of plan?.items ?? []) value[item.outcome]++;
    return value;
  }, [plan]);

  const filtered = useMemo(() => {
    if (!plan) return [];
    const normalizedQuery = query.trim().toLowerCase();
    return plan.items.filter((item) => {
      if (outcomeFilter !== 'all' && item.outcome !== outcomeFilter) return false;
      if (!normalizedQuery) return true;
      return decisionSearchText(item, byPath.get(item.path)).includes(normalizedQuery);
    });
  }, [byPath, outcomeFilter, plan, query]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = bulkAiDecisionPage(filtered, safePage, PAGE_SIZE);
  const selectedCount = plan?.items.reduce((count, item) => count + (excluded.has(item.path) ? 0 : 1), 0) ?? 0;
  const staleReason = plan
    ? bulkAiDecisionPlanStaleReason(plan, selectedSource, activeScanId, reviewVersion, new Set(byPath.keys()))
    : null;

  useEffect(() => setPage(0), [outcomeFilter, query]);

  if (!plan) return null;

  const apply = () => {
    if (staleReason) return;
    const selected = selectedBulkAiDecisionItems(plan.items, excluded);
    if (selected.length === 0) return;
    plan.onApply(selected);
    closeBulkAiPreview();
  };
  const toggleVisible = (include: boolean) => {
    setExcluded((previous) => {
      const next = new Set(previous);
      for (const item of visible) {
        if (include) next.delete(item.path);
        else next.add(item.path);
      }
      return next;
    });
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80 p-3 backdrop-blur-sm">
      <div ref={dialogRef} className="flex max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="bulk-ai-preview-title" aria-describedby="bulk-ai-preview-summary">
        <header className="flex items-start gap-3 border-b border-border px-4 py-3">
          <div className="mt-0.5 rounded-lg bg-blue-500/15 p-2 text-blue-300"><ShieldCheck className="h-5 w-5" /></div>
          <div className="min-w-0 flex-1">
            <h2 id="bulk-ai-preview-title" className="text-base font-semibold text-text">{plan.title}</h2>
            <p id="bulk-ai-preview-summary" className="mt-0.5 max-w-3xl text-[11px] text-text-muted">{plan.summary}</p>
          </div>
          <button ref={closeButtonRef} type="button" onClick={closeBulkAiPreview} className="rounded p-1.5 text-text-muted hover:bg-surface-raised hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400" aria-label="Close AI decision preview"><X className="h-4 w-4" /></button>
        </header>

        <div className="grid grid-cols-2 gap-2 border-b border-border p-3 sm:grid-cols-4">
          {(['keep', 'reject', 'queue'] as const).map((outcome) => {
            const style = OUTCOME_STYLE[outcome];
            return (
              <button
                key={outcome}
                type="button"
                onClick={() => setOutcomeFilter((current) => current === outcome ? 'all' : outcome)}
                className={`rounded-lg border p-2.5 text-left transition-colors ${style.className} ${outcomeFilter === outcome ? 'ring-2 ring-current' : ''}`}
                aria-pressed={outcomeFilter === outcome}
              >
                <div className="text-[10px] uppercase tracking-wide">{style.label}</div>
                <div className="text-xl font-semibold text-text">{counts[outcome]}</div>
              </button>
            );
          })}
          <button type="button" onClick={() => setOutcomeFilter('all')} className={`rounded-lg border border-border bg-surface-raised/60 p-2.5 text-left ${outcomeFilter === 'all' ? 'ring-2 ring-blue-400' : ''}`} aria-pressed={outcomeFilter === 'all'}>
            <div className="text-[10px] uppercase tracking-wide text-text-muted">Unchanged</div>
            <div className="text-xl font-semibold text-text">{plan.unchangedCount ?? 0}</div>
          </button>
        </div>

        <div className="flex flex-col gap-2 border-b border-border px-3 py-2 sm:flex-row sm:items-center">
          <label className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
            <span className="sr-only">Search proposed AI decisions</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search filename, outcome or reason" className="min-h-9 w-full rounded border border-border bg-surface-alt pl-7 pr-2 text-[11px] text-text focus:border-blue-400 focus:outline-none" />
          </label>
          <div className="flex items-center gap-1 text-[10px] text-text-muted">
            <button type="button" onClick={() => toggleVisible(true)} className="rounded border border-border px-2 py-1.5 hover:text-text">Include page</button>
            <button type="button" onClick={() => toggleVisible(false)} className="rounded border border-border px-2 py-1.5 hover:text-text">Exclude page</button>
            <span className="ml-1">{selectedCount}/{plan.items.length} changes selected</span>
          </div>
        </div>

        {(plan.warnings?.length ?? 0) > 0 && (
          <div className="flex items-start gap-2 border-b border-yellow-400/20 bg-yellow-500/5 px-4 py-2 text-[11px] text-yellow-100">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-yellow-300" />
            <span>{plan.warnings!.join(' ')}</span>
          </div>
        )}

        {staleReason && (
          <div role="alert" className="flex items-start gap-2 border-b border-red-400/30 bg-red-500/10 px-4 py-2 text-[11px] text-red-100">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-300" />
            <span>{staleReason}</span>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {visible.length === 0 ? (
            <div className="flex min-h-48 items-center justify-center text-sm text-text-muted">No decisions match this filter.</div>
          ) : (
            <div className="divide-y divide-border/70">
              {visible.map((item) => {
                const file = byPath.get(item.path);
                const style = OUTCOME_STYLE[item.outcome];
                const included = !excluded.has(item.path);
                return (
                  <div key={item.path} className={`flex items-center gap-3 px-3 py-2 transition-opacity ${included ? '' : 'opacity-45'}`}>
                    <input type="checkbox" checked={included} onChange={() => setExcluded((previous) => {
                      const next = new Set(previous);
                      if (next.has(item.path)) next.delete(item.path);
                      else next.add(item.path);
                      return next;
                    })} className="h-4 w-4 shrink-0 accent-blue-500" aria-label={`${included ? 'Exclude' : 'Include'} ${file?.name ?? item.path}`} />
                    {file ? <DecisionThumbnail file={file} /> : <div className="h-16 w-20 shrink-0 rounded bg-black/60" />}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="max-w-full truncate font-mono text-[11px] text-text" title={item.path}>{file?.name ?? item.path}</span>
                        <span className={`rounded border px-1.5 py-0.5 text-[9px] font-medium ${style.className}`}>{style.label}</span>
                        {item.groupLabel && <span className="text-[9px] text-text-muted">{item.groupLabel}</span>}
                        {typeof item.score === 'number' && <span className="text-[9px] text-text-muted">score {Math.round(item.score)}</span>}
                        {item.confidence && <span className="text-[9px] text-text-muted">{item.confidence} confidence</span>}
                      </div>
                      <div className="mt-1 text-[10px] text-text-muted">{item.reasons.join(' · ') || 'No additional reason supplied'}</div>
                      {file && (typeof file.sceneAnalysis?.subjectSharpnessScore === 'number' || typeof file.subjectSharpnessScore === 'number' || (file.orientation ?? 1) > 1) && (
                        <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-[9px] text-text-faint">
                          <span>subject {Math.round(file.sceneAnalysis?.subjectSharpnessScore ?? file.subjectSharpnessScore ?? 0)}</span>
                          {typeof file.sceneAnalysis?.backgroundSharpnessScore === 'number' && <span>background {Math.round(file.sceneAnalysis.backgroundSharpnessScore)}</span>}
                          {typeof file.sceneAnalysis?.subjectArea === 'number' && <span>area {Math.round(file.sceneAnalysis.subjectArea * 100)}%</span>}
                          {typeof file.sceneAnalysis?.subjectFocusCoverage === 'number' && <span>focus coverage {Math.round(file.sceneAnalysis.subjectFocusCoverage * 100)}%</span>}
                          {typeof file.sceneAnalysis?.subjectFocusConfidence === 'number' && <span>measurement confidence {Math.round(file.sceneAnalysis.subjectFocusConfidence * 100)}%</span>}
                          {(file.orientation ?? 1) > 1 && <span>EXIF orientation {file.orientation}</span>}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <footer className="flex flex-col gap-2 border-t border-border bg-surface-alt px-4 py-3 sm:flex-row sm:items-center">
          <div className="flex items-center gap-1 text-[10px] text-text-muted">
            <button type="button" disabled={safePage === 0} onClick={() => setPage((value) => Math.max(0, value - 1))} className="rounded border border-border p-1 disabled:opacity-30" aria-label="Previous decisions page"><ChevronLeft className="h-3.5 w-3.5" /></button>
            <span>Page {safePage + 1}/{pageCount} · every proposed change is available for review</span>
            <button type="button" disabled={safePage >= pageCount - 1} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))} className="rounded border border-border p-1 disabled:opacity-30" aria-label="Next decisions page"><ChevronRight className="h-3.5 w-3.5" /></button>
          </div>
          <div className="flex items-center gap-2 sm:ml-auto">
            <button type="button" onClick={closeBulkAiPreview} className="min-h-9 rounded border border-border bg-surface px-3 text-[11px] text-text-secondary hover:text-text">Cancel</button>
            <button type="button" disabled={selectedCount === 0 || !!staleReason} onClick={apply} className="inline-flex min-h-9 items-center gap-1.5 rounded bg-blue-500 px-3 text-[11px] font-semibold text-black hover:bg-blue-400 disabled:cursor-not-allowed disabled:opacity-45" title={staleReason ?? undefined}>
              <Check className="h-3.5 w-3.5" />
              {plan.applyLabel ?? 'Apply reviewed decisions'} · {selectedCount}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
