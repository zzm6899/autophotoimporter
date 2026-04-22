interface ShortcutsOverlayProps {
  onClose: () => void;
}

const shortcuts = [
  ['Arrows', 'Navigate'],
  ['P / X / U', 'Pick, reject, clear'],
  ['0-5', 'Set star rating'],
  ['Ctrl+A', 'Select visible'],
  ['B / G', 'Select or collapse burst'],
  ['Shift+B', 'Best of focused burst'],
  ['A', 'Normalize selection to focused anchor'],
  ['[ / ] / \\', 'Manual exposure down, up, reset'],
  ['Copy/Paste EV', 'Toolbar syncs manual exposure offsets'],
  ['Space', 'Hold original in detail preview'],
  ['Ctrl+Wheel', 'Zoom compare view together'],
  ['C', 'Cull mode'],
  ['Esc', 'Back / deselect'],
];

const tools = [
  ['Best of Burst', 'Ranks the focused burst first: protected/rating, faces, subject sharpness, blur risk, whole-image sharpness, then smart score.'],
  ['Blur Check', 'Filters to photos with medium/high blur risk from local thumbnail analysis.'],
  ['Pause Review', 'Stops background smart scoring so culling and navigation stay responsive.'],
  ['Stop Loading', 'Stops background preview preloading. The current photo still loads normally.'],
  ['Reject Blur', 'Rejects high blur-risk files that are not already picked.'],
  ['Safe Cull', 'Conservatively rejects only clearly worse burst/similar alternatives; protected, starred, and picked files are never rejected.'],
  ['Pick Best', 'For each burst/similar group, picks the best-ranked image and rejects the rest.'],
  ['Queue Best', 'Adds high-scoring keeper candidates to the import queue without changing pick/reject flags.'],
];

export function ShortcutsOverlay({ onClose }: ShortcutsOverlayProps) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/65 flex items-center justify-center"
      onClick={(e) => { if (e.currentTarget === e.target) onClose(); }}
    >
      <div className="w-[560px] max-w-[92vw] bg-surface-alt border border-border rounded-lg shadow-2xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text">Shortcuts</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text text-sm">Close</button>
        </div>
        <div className="p-4 grid gap-4 md:grid-cols-2">
          <div>
            <h3 className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mb-2">Keyboard</h3>
            <div className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-2">
              {shortcuts.map(([key, label]) => (
                <div key={key} className="contents">
                  <span className="text-[11px] font-mono text-text bg-surface-raised rounded px-1.5 py-0.5 text-center">{key}</span>
                  <span className="text-xs text-text-secondary py-0.5">{label}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <h3 className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mb-2">Smart Tools</h3>
            <div className="space-y-2">
              {tools.map(([name, label]) => (
                <div key={name} className="border border-border rounded bg-surface px-2 py-1.5">
                  <div className="text-[11px] text-text font-medium">{name}</div>
                  <div className="text-[10px] text-text-secondary mt-0.5">{label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
