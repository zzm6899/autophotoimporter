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
    targetClass: 'left-2 top-[76px] h-[120px] w-[188px]',
    panelClass: 'left-[220px] top-[86px]',
    arrowClass: 'left-[-9px] top-8 border-y-8 border-r-8 border-y-transparent border-r-surface',
  },
  {
    title: 'Review without hunting',
    body: 'Use the main toolbar for Review, Queue Keepers, Import, and Best. Everything else is in More or Ctrl/Cmd+K.',
    targetClass: 'left-[205px] top-[132px] h-8 w-[460px]',
    panelClass: 'left-[300px] top-[178px]',
    arrowClass: 'left-12 top-[-9px] border-x-8 border-b-8 border-x-transparent border-b-surface',
  },
  {
    title: 'Queue shows the whole set',
    body: 'Queue Keepers now switches to grid view and turns Multi on, so you can see and adjust the import set immediately.',
    targetClass: 'left-[270px] top-[132px] h-8 w-[145px]',
    panelClass: 'left-[330px] top-[178px]',
    arrowClass: 'left-12 top-[-9px] border-x-8 border-b-8 border-x-transparent border-b-surface',
  },
  {
    title: 'Choose output last',
    body: 'The right panel holds destination, format, duplicate checks, backup, FTP, and import readiness. Disabled buttons show why.',
    targetClass: 'right-2 top-[76px] h-[250px] w-[180px]',
    panelClass: 'right-[210px] top-[104px]',
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
