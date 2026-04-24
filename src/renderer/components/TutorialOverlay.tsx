import { useEffect, useState } from 'react';

const STORAGE_KEY = 'photo-importer:tutorial-dismissed';

const steps = [
  { title: '1. Start with any source', body: 'Choose a card, folder, or FTP source on the left. The scan streams in, so you can begin reviewing as soon as thumbnails appear.' },
  { title: '2. Move into detail view early', body: 'Double-click a thumbnail or press Enter, then use arrows to step through the shoot quickly.' },
  { title: '3. Make decisions with one hand', body: 'Use P to keep, X to reject, U to clear, 0-5 to rate, and Q to add the current photo or selection to the import queue.' },
  { title: '4. Let bursts do the heavy lifting', body: 'Press B to grab a burst, Shift+B to rank the best candidates, and G to collapse a burst once you are done with it.' },
  { title: '5. Match exposure only when needed', body: 'Set a strong frame as the anchor, then use A to normalize the selection to it or [ and ] for manual EV nudges.' },
  { title: '6. Import from the queue', body: 'The queue is your final shortlist. Once it looks right, import to your main destination plus any backup or FTP target you enabled.' },
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
            <p className="text-[11px] text-text-muted mt-0.5">A simple pass: scan, review, queue, import.</p>
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
