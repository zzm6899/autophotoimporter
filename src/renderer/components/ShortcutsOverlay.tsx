interface ShortcutsOverlayProps {
  onClose: () => void;
}

const shortcuts = [
  ['Arrows', 'Navigate'],
  ['P / X / U', 'Pick, reject, clear'],
  ['0-5', 'Set star rating'],
  ['Ctrl+A', 'Select visible'],
  ['B / G', 'Select or collapse burst'],
  ['Shift+B', 'Best of selected batch'],
  ['A', 'Normalize selection to focused anchor'],
  ['[ / ] / \\', 'Manual exposure down, up, reset'],
  ['Space', 'Hold original in detail preview'],
  ['C', 'Cull mode'],
  ['Esc', 'Back / deselect'],
];

export function ShortcutsOverlay({ onClose }: ShortcutsOverlayProps) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/65 flex items-center justify-center"
      onClick={(e) => { if (e.currentTarget === e.target) onClose(); }}
    >
      <div className="w-[360px] max-w-[92vw] bg-surface-alt border border-border rounded-lg shadow-2xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text">Shortcuts</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text text-sm">Close</button>
        </div>
        <div className="p-4 grid grid-cols-[88px_1fr] gap-x-3 gap-y-2">
          {shortcuts.map(([key, label]) => (
            <div key={key} className="contents">
              <span className="text-[11px] font-mono text-text bg-surface-raised rounded px-1.5 py-0.5 text-center">{key}</span>
              <span className="text-xs text-text-secondary py-0.5">{label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
