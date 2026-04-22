import { useEffect, useState } from 'react';

const STORAGE_KEY = 'photo-importer:tutorial-dismissed';

const steps = [
  { title: '1. Pick a source', body: 'Choose a card, folder, or FTP source on the left. Scanning starts from there.' },
  { title: '2. Cull fast', body: 'Use arrows to move, P to pick, X to reject, and 0-5 for star ratings.' },
  { title: '3. Find the best', body: 'Select a burst or batch and press Shift+B to compare the sharpest/top candidates.' },
  { title: '4. Fix exposure', body: 'Set an anchor, use Match for a selected batch, or nudge exposure with [ and ].' },
  { title: '5. Import once', body: 'Queue keepers, then import to local, backup, and optional FTP output.' },
];

export function TutorialOverlay() {
  const [open, setOpen] = useState(() => localStorage.getItem(STORAGE_KEY) !== '1');

  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener('photo-importer:tutorial', handler);
    return () => window.removeEventListener('photo-importer:tutorial', handler);
  }, []);

  const close = () => {
    localStorage.setItem(STORAGE_KEY, '1');
    setOpen(false);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/45 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-surface border border-border rounded shadow-2xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-text">Quick Start</h2>
            <p className="text-[11px] text-text-muted mt-0.5">A faster flow for importing and culling.</p>
          </div>
          <button
            onClick={close}
            className="px-2 py-1 rounded bg-surface-raised hover:bg-border text-xs text-text-secondary"
          >
            Close
          </button>
        </div>
        <div className="p-4 grid gap-2">
          {steps.map((step) => (
            <div key={step.title} className="border border-border rounded px-3 py-2 bg-surface-alt">
              <div className="text-xs font-medium text-text">{step.title}</div>
              <div className="text-[11px] text-text-secondary mt-0.5">{step.body}</div>
            </div>
          ))}
        </div>
        <div className="px-4 py-3 border-t border-border flex items-center justify-end gap-2">
          <button
            onClick={() => setOpen(false)}
            className="px-3 py-1.5 rounded bg-surface-raised hover:bg-border text-xs text-text-secondary"
          >
            Later
          </button>
          <button
            onClick={close}
            className="px-3 py-1.5 rounded bg-accent hover:bg-accent-hover text-xs font-medium text-white"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
