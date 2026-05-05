import { useEffect, useState } from 'react';

const STORAGE_KEY = 'photo-importer:tutorial-dismissed';

type TutorialStep = {
  title: string;
  body: string;
  targetClass: string;
  panelClass: string;
  arrowClass: string;
};

const steps: TutorialStep[] = [
  {
    title: 'Pick a source',
    body: 'Start from the left panel. Choose a card, folder, or FTP source; scan begins as soon as you import or rescan.',
    targetClass: 'left-2 top-[120px] h-[140px] w-[224px]',
    panelClass: 'left-[252px] top-[128px]',
    arrowClass: 'left-[-9px] top-8 border-y-8 border-r-8 border-y-transparent border-r-surface',
  },
  {
    title: 'Follow the workflow',
    body: 'The V2 header keeps source, review, output, import readiness, AI progress, faces, queue, and blur risk in one place.',
    targetClass: 'left-[244px] right-[332px] top-[48px] h-[64px]',
    panelClass: 'left-[320px] top-[126px]',
    arrowClass: 'left-12 top-[-9px] border-x-8 border-b-8 border-x-transparent border-b-surface',
  },
  {
    title: 'Review without hunting',
    body: 'Use the main review toolbar for Review, Queue Keepers, Import, and Best. Everything else is in More or Ctrl/Cmd+K.',
    targetClass: 'left-[244px] top-[116px] h-9 w-[540px]',
    panelClass: 'left-[320px] top-[170px]',
    arrowClass: 'left-12 top-[-9px] border-x-8 border-b-8 border-x-transparent border-b-surface',
  },
  {
    title: 'Output is an inspector',
    body: 'Use Import for the final action, Speed for profiles and benchmarks, and Rules for naming, backup, FTP, and advanced workflow settings.',
    targetClass: 'right-2 top-[120px] h-[280px] w-[312px]',
    panelClass: 'right-[340px] top-[128px]',
    arrowClass: 'right-[-9px] top-8 border-y-8 border-l-8 border-y-transparent border-l-surface',
  },
  {
    title: 'Use the palette',
    body: 'Press Ctrl/Cmd+K to run view switches, filters, AI controls, bulk actions, settings, help, and diagnostics from one place.',
    targetClass: 'right-4 top-1 h-8 w-[150px]',
    panelClass: 'right-[190px] top-12',
    arrowClass: 'right-[-9px] top-8 border-y-8 border-l-8 border-y-transparent border-l-surface',
  },
];

export function TutorialOverlay() {
  const [open, setOpen] = useState(() => localStorage.getItem(STORAGE_KEY) !== '1');
  const [stepIndex, setStepIndex] = useState(0);
  const step = steps[stepIndex];

  useEffect(() => {
    const handler = () => {
      setStepIndex(0);
      setOpen(true);
    };
    window.addEventListener('photo-importer:tutorial', handler);
    return () => window.removeEventListener('photo-importer:tutorial', handler);
  }, []);

  const dismiss = () => {
    localStorage.setItem(STORAGE_KEY, '1');
    setOpen(false);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[80] bg-black/45 backdrop-blur-[1px]">
      <button
        type="button"
        className={`absolute rounded-lg border-2 border-accent bg-accent/10 shadow-[0_0_0_9999px_rgba(0,0,0,0.36)] transition-all ${step.targetClass}`}
        title={step.body}
        aria-label={step.title}
        onClick={() => setStepIndex((value) => Math.min(value + 1, steps.length - 1))}
      />
      <div className={`absolute w-[min(360px,calc(100vw-32px))] rounded-lg border border-border bg-surface shadow-2xl ${step.panelClass}`}>
        <div className={`absolute h-0 w-0 ${step.arrowClass}`} />
        <div className="border-b border-border px-4 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-accent">
            First run guide {stepIndex + 1}/{steps.length}
          </div>
          <h2 className="mt-1 text-sm font-semibold text-text">{step.title}</h2>
          <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">{step.body}</p>
        </div>
        <div className="flex items-center justify-between gap-2 px-4 py-3">
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded border border-border bg-surface-raised px-3 py-1.5 text-xs text-text-secondary hover:bg-border hover:text-text"
          >
            Later
          </button>
          <div className="flex items-center gap-2">
            {stepIndex > 0 && (
              <button
                type="button"
                onClick={() => setStepIndex((value) => Math.max(0, value - 1))}
                className="rounded border border-border bg-surface-raised px-3 py-1.5 text-xs text-text-secondary hover:bg-border hover:text-text"
              >
                Back
              </button>
            )}
            {stepIndex < steps.length - 1 ? (
              <button
                type="button"
                onClick={() => setStepIndex((value) => Math.min(value + 1, steps.length - 1))}
                className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover"
              >
                Next
              </button>
            ) : (
              <button
                type="button"
                onClick={dismiss}
                className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover"
              >
                Got it
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
