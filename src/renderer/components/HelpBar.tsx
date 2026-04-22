import { useAppState, useAppDispatch } from '../context/ImportContext';
import { useFileScanner } from '../hooks/useFileScanner';

const isMac = typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin';
const MOD = isMac ? 'Cmd' : 'Ctrl';

export function HelpBar() {
  const {
    files, phase, scanPaused, filter, viewMode, selectedPaths, queuedPaths,
    focusedIndex, importProgress,
  } = useAppState();
  const dispatch = useAppDispatch();
  const { pauseScan, resumeScan } = useFileScanner();

  const picked = files.filter((f) => f.pick === 'selected').length;
  const rejected = files.filter((f) => f.pick === 'rejected').length;
  const smart = files.filter((f) => typeof f.reviewScore === 'number').length;
  const focusedLabel = focusedIndex >= 0 && focusedIndex < files.length
    ? `${focusedIndex + 1}/${files.length}`
    : `${files.length} files`;

  const status = phase === 'importing' && importProgress
    ? `Importing ${importProgress.currentIndex}/${importProgress.totalFiles}`
    : phase === 'scanning'
      ? scanPaused ? 'Scan paused' : 'Scanning'
      : viewMode === 'single' || viewMode === 'split'
        ? focusedLabel
        : `${files.length} files`;

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface-alt/95 backdrop-blur-sm px-2 py-1">
      <div className="flex items-center gap-2 text-[10px] text-text-muted overflow-x-auto">
        <span className="shrink-0 font-medium text-text-secondary">{status}</span>
        {filter !== 'all' && <span className="shrink-0">Filter: <span className="text-text-secondary">{filter}</span></span>}
        {selectedPaths.length > 0 && <span className="shrink-0 text-blue-300">{selectedPaths.length} selected</span>}
        {queuedPaths.length > 0 && <span className="shrink-0 text-emerald-300">{queuedPaths.length} queued</span>}
        {picked > 0 && <span className="shrink-0 text-yellow-300">{picked} picked</span>}
        {rejected > 0 && <span className="shrink-0 text-red-300">{rejected} rejected</span>}
        {smart > 0 && <span className="shrink-0 text-sky-300">{smart} scored</span>}
        <div className="w-px h-3 bg-border shrink-0" />
        <span className="shrink-0">P pick</span>
        <span className="shrink-0">X reject</span>
        <span className="shrink-0">0-5 stars</span>
        <span className="shrink-0">{MOD}+Z undo</span>
        <span className="shrink-0">? shortcuts</span>
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {phase === 'scanning' && (
            <button
              onClick={() => scanPaused ? resumeScan() : pauseScan()}
              className="px-2 py-0.5 rounded bg-surface-raised hover:bg-border text-text-secondary"
            >
              {scanPaused ? 'Resume' : 'Pause'}
            </button>
          )}
          {files.length > 0 && (
            <>
              <button
                onClick={() => dispatch({ type: 'SET_FILTER', filter: 'review-needed' })}
                className="px-2 py-0.5 rounded bg-surface-raised hover:bg-border text-text-secondary"
              >
                Review
              </button>
              <button
                onClick={() => dispatch({ type: 'SET_FILTER', filter: 'best' })}
                className="px-2 py-0.5 rounded bg-surface-raised hover:bg-border text-text-secondary"
              >
                Best
              </button>
              <button
                onClick={() => dispatch({ type: 'QUEUE_BEST' })}
                className="px-2 py-0.5 rounded bg-surface-raised hover:bg-border text-text-secondary"
              >
                Queue Best
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
