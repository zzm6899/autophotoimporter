import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useAppState } from '../context/ImportContext';

interface ShortcutsOverlayProps {
  onClose: () => void;
}

const fixedShortcuts = [
  ['Enter', 'Open focused photo in detail view'],
  ['Ctrl+A', 'Select all visible results'],
  ['Shift+◀▶', 'Previous / next burst'],
  ['Ctrl+Shift+◀▶', 'Previous / next batch page (panel open)'],
  ['Shift+A', 'Select all photos in focused burst/group'],
  ['Shift+B', 'Best of focused burst'],
  ['A', 'Normalize selection to focused anchor'],
  ['[ / ] / \\', 'Manual exposure down, up, reset'],
  ['Ctrl+C / V', 'Copy/paste exposure recipe'],
  ['Space', 'Hold original in detail preview'],
  ['Ctrl+Wheel', 'Zoom compare view together'],
  ['Esc', 'Back / deselect'],
];

const tools = [
  ['Best of Burst', 'Ranks the focused burst first: protected/rating, faces, subject sharpness, blur risk, whole-image sharpness, then smart score.'],
  ['Blur Check', 'Filters to photos with medium/high blur risk from local thumbnail analysis.'],
  ['Pause Review', 'Stops background smart scoring so culling and navigation stay responsive.'],
  ['Stop Loading', 'Stops background preview preloading and drops low-priority warmups. The current photo still loads normally.'],
  ['Reject Blur', 'Rejects high blur-risk files that are not already picked.'],
  ['Safe Cull', 'Conservatively rejects only clearly worse burst/similar alternatives; protected, starred, and picked files are never rejected.'],
  ['Pick Best', 'For each burst/similar group, picks the best-ranked image and rejects the rest.'],
  ['Queue Keepers', 'Queues the top keeper from each burst/group plus strong standalone shots.'],
];

const workflows = [
  {
    title: 'Fast Cull',
    steps: ['Scan the card and start once the first thumbnails appear.', 'Press Enter for detail view, then use arrows with P, X, U, and 0-5.', 'Use Q for definite keepers, then import from the queue.'],
  },
  {
    title: 'Burst Selection',
    steps: ['Focus any frame in the burst.', 'Press Shift+B to rank candidates.', 'Pick one of the suggested frames, or use Queue Keepers after AI review finishes.'],
  },
  {
    title: 'FTP Import',
    steps: ['Choose FTP source and probe the camera path.', 'Mirror files locally before scan so previews and EXIF stay fast.', 'Import to disk, backup, or an FTP destination from the output panel.'],
  },
  {
    title: 'Exposure Match',
    steps: ['Focus a well-exposed anchor frame.', 'Select matching frames and press A to normalize.', 'Use [ and ] for small manual EV nudges before export.'],
  },
];

export function ShortcutsOverlay({ onClose }: ShortcutsOverlayProps) {
  const { keybinds } = useAppState();
  const [query, setQuery] = useState('');
  const panelRef = useRef<HTMLDivElement | null>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const matches = (values: string[]) => normalizedQuery === '' || values.join(' ').toLowerCase().includes(normalizedQuery);
  const formatKey = (key: string): string => {
    if (key === 'ArrowRight') return '→';
    if (key === 'ArrowLeft') return '←';
    if (key === 'ArrowUp') return '↑';
    if (key === 'ArrowDown') return '↓';
    if (key === ' ') return 'Space';
    return key.length === 1 ? key.toUpperCase() : key;
  };
  const shortcuts = [
    [`${formatKey(keybinds.prevPhoto)} / ${formatKey(keybinds.nextPhoto)}`, 'Navigate photos'],
    [`${formatKey(keybinds.pick)} / ${formatKey(keybinds.reject)} / ${formatKey(keybinds.unflag)}`, 'Pick, reject, clear'],
    [`${formatKey(keybinds.clearRating)}-${formatKey(keybinds.rateFive)}`, 'Set or clear star rating'],
    [formatKey(keybinds.queuePhoto), 'Queue focused or selected photos'],
    [formatKey(keybinds.burstSelect), 'Select focused burst'],
    [formatKey(keybinds.burstCollapse), 'Collapse focused burst'],
    [formatKey(keybinds.compareMode), 'Toggle cull/compare workflow'],
    [formatKey(keybinds.jumpUnreviewed), 'Jump to next unreviewed file'],
    [formatKey(keybinds.batchRejectBurst), 'Reject burst batch in detail view'],
  ];
  const visibleShortcuts = shortcuts.filter(([key, label]) => matches([key, label]));
  const visibleFixedShortcuts = fixedShortcuts.filter(([key, label]) => matches([key, label]));
  const visibleTools = tools.filter(([name, label]) => matches([name, label]));
  const visibleWorkflows = workflows.filter((workflow) => matches([workflow.title, ...workflow.steps]));

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => previouslyFocused?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])',
    )).filter((element) => !element.hasAttribute('disabled') && !element.getAttribute('aria-hidden'));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/65 flex items-center justify-center"
      onClick={(e) => { if (e.currentTarget === e.target) onClose(); }}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-center-title"
        className="w-[760px] max-w-[94vw] max-h-[86vh] bg-surface-alt border border-border rounded-lg shadow-2xl overflow-hidden flex flex-col"
      >
        <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3">
          <div>
            <h2 id="help-center-title" className="text-sm font-semibold text-text">Help Center</h2>
            <p className="mt-0.5 text-[11px] text-text-muted">Search shortcuts, smart tools, and fast workflows.</p>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text text-sm">Close</button>
        </div>
        <div className="border-b border-border bg-surface px-4 py-3">
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search help, for example: burst, queue, FTP, exposure"
            className="w-full rounded border border-border bg-surface-alt px-3 py-2 text-xs text-text placeholder-text-muted outline-none focus:border-blue-500/60"
          />
        </div>
        <div className="min-h-0 overflow-y-auto p-4 grid gap-4 lg:grid-cols-[1fr_1fr]">
          <div>
            <h3 className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mb-2">Current Keybinds</h3>
            <div className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-2">
              {visibleShortcuts.map(([key, label]) => (
                <div key={key} className="contents">
                  <span className="text-[11px] font-mono text-text bg-surface-raised rounded px-1.5 py-0.5 text-center">{key}</span>
                  <span className="text-xs text-text-secondary py-0.5">{label}</span>
                </div>
              ))}
              {visibleShortcuts.length === 0 && <p className="col-span-2 text-xs text-text-muted">No matching shortcuts.</p>}
            </div>
            <h3 className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mt-5 mb-2">Fixed Shortcuts</h3>
            <div className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-2">
              {visibleFixedShortcuts.map(([key, label]) => (
                <div key={key} className="contents">
                  <span className="text-[11px] font-mono text-text bg-surface-raised rounded px-1.5 py-0.5 text-center">{key}</span>
                  <span className="text-xs text-text-secondary py-0.5">{label}</span>
                </div>
              ))}
              {visibleFixedShortcuts.length === 0 && <p className="col-span-2 text-xs text-text-muted">No matching fixed shortcuts.</p>}
            </div>
          </div>
          <div>
            <h3 className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mb-2">Fast Workflow</h3>
            <div className="space-y-2">
              {visibleWorkflows.map((workflow) => (
                <div key={workflow.title} className="border border-border rounded bg-surface px-2 py-1.5">
                  <div className="text-[11px] text-text font-medium">{workflow.title}</div>
                  <ol className="mt-1 space-y-0.5 text-[10px] text-text-secondary">
                    {workflow.steps.map((step, index) => <li key={step}>{index + 1}. {step}</li>)}
                  </ol>
                </div>
              ))}
              {visibleWorkflows.length === 0 && <p className="text-xs text-text-muted">No matching workflows.</p>}
            </div>
            <h3 className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mt-4 mb-2">Smart Tools</h3>
            <div className="space-y-2">
              {visibleTools.map(([name, label]) => (
                <div key={name} className="border border-border rounded bg-surface px-2 py-1.5">
                  <div className="text-[11px] text-text font-medium">{name}</div>
                  <div className="text-[10px] text-text-secondary mt-0.5">{label}</div>
                </div>
              ))}
              {visibleTools.length === 0 && <p className="text-xs text-text-muted">No matching tools.</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
