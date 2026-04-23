import { useAppState, useAppDispatch } from '../context/ImportContext';
import { useFileScanner } from '../hooks/useFileScanner';

const isMac = typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin';
const MOD = isMac ? 'Cmd' : 'Ctrl';

// Contextual tip shown at the right of the bar — changes based on what the user should do next.
function getContextTip(phase: string, fileCount: number, picked: number, queued: number): string {
  if (phase === 'scanning') return 'Scanning your files — thumbnails will appear shortly.';
  if (fileCount === 0) return 'Select a source on the left to scan for photos.';
  if (queued > 0) return `${queued} file${queued !== 1 ? 's' : ''} queued — click Import in the right panel when ready.`;
  if (picked > 0) return `${picked} picked — add them to the queue or import now.`;
  if (fileCount > 0 && picked === 0) return 'Press P to pick a photo, X to reject. Double-click for full view.';
  return '';
}

export function HelpBar() {
  const {
    files, phase, scanPaused, filter, viewMode, selectedPaths, queuedPaths,
    focusedIndex, importProgress,
  } = useAppState();
  const dispatch = useAppDispatch();
  const { pauseScan, resumeScan } = useFileScanner();

  const picked = files.filter((f) => f.pick === 'selected').length;
  const rejected = files.filter((f) => f.pick === 'rejected').length;
  const analyzed = files.filter((f) => typeof f.reviewScore === 'number' || typeof f.subjectSharpnessScore === 'number').length;
  const blurRisk = files.filter((f) => f.blurRisk === 'high' || f.blurRisk === 'medium').length;
  const faceFiles = files.filter((f) => (f.faceCount ?? 0) > 0).length;
  const faceGroups = new Set(files.map((f) => f.faceGroupId).filter(Boolean)).size;
  const focusedLabel = focusedIndex >= 0 && focusedIndex < files.length
    ? `${focusedIndex + 1} / ${files.length}`
    : `${files.length} photo${files.length !== 1 ? 's' : ''}`;

  const isImporting = phase === 'importing' && importProgress;
  const isScanning = phase === 'scanning';

  const tip = getContextTip(phase, files.length, picked, queuedPaths.length);

  // Progress bar width for import
  const importPct = isImporting
    ? Math.round((importProgress.currentIndex / Math.max(1, importProgress.totalFiles)) * 100)
    : 0;

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface-alt/95 backdrop-blur-sm">
      {/* Import progress strip */}
      {isImporting && (
        <div className="h-0.5 bg-border">
          <div
            className="h-full bg-emerald-500 transition-all duration-300"
            style={{ width: `${importPct}%` }}
          />
        </div>
      )}

      <div className="px-3 py-1.5 flex items-center gap-3 text-[10px] text-text-muted overflow-x-auto">
        {/* Status pill */}
        <div className="flex items-center gap-1.5 shrink-0">
          {isImporting ? (
            <>
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />
              <span className="font-medium text-text-secondary">
                Importing {importProgress.currentIndex}/{importProgress.totalFiles}
              </span>
            </>
          ) : isScanning ? (
            <>
              <span className={`w-2 h-2 rounded-full shrink-0 ${scanPaused ? 'bg-yellow-500' : 'bg-blue-500 animate-pulse'}`} />
              <span className="font-medium text-text-secondary">{scanPaused ? 'Paused' : 'Scanning…'}</span>
              <button
                onClick={() => scanPaused ? resumeScan() : pauseScan()}
                className="px-1.5 py-0.5 rounded bg-surface-raised hover:bg-border text-text-secondary transition-colors"
              >
                {scanPaused ? 'Resume' : 'Pause'}
              </button>
            </>
          ) : (
            <>
              <span className={`w-2 h-2 rounded-full shrink-0 ${files.length > 0 ? 'bg-emerald-500' : 'bg-border'}`} />
              <span className="font-medium text-text-secondary">
                {viewMode === 'single' || viewMode === 'split' ? focusedLabel : `${files.length} file${files.length !== 1 ? 's' : ''}`}
              </span>
            </>
          )}
        </div>

        {/* Counters */}
        {filter !== 'all' && (
          <span className="shrink-0 flex items-center gap-1">
            <span className="text-text-muted">Filter:</span>
            <span className="text-text-secondary">{filter}</span>
            <button
              onClick={() => dispatch({ type: 'SET_FILTER', filter: 'all' })}
              className="text-text-faint hover:text-text transition-colors ml-0.5"
              title="Clear filter"
            >✕</button>
          </span>
        )}
        {selectedPaths.length > 0 && (
          <span className="shrink-0 text-blue-300">{selectedPaths.length} selected</span>
        )}
        {queuedPaths.length > 0 && (
          <span className="shrink-0 text-emerald-300">{queuedPaths.length} queued</span>
        )}
        {picked > 0 && (
          <span className="shrink-0 text-yellow-300">{picked} picked</span>
        )}
        {rejected > 0 && (
          <span className="shrink-0 text-red-300">{rejected} rejected</span>
        )}
        {files.length > 0 && (
          <span
            className="shrink-0 text-text-faint"
            title="Smart review progress: files analyzed for blur risk, subject/facial focus, and keeper score."
          >
            smart {analyzed}/{files.length}
            {faceFiles > 0 ? ` · faces ${faceFiles}` : ''}
            {faceGroups > 0 ? ` · groups ${faceGroups}` : ''}
            {blurRisk > 0 ? ` · blur ${blurRisk}` : ''}
          </span>
        )}

        {/* Separator */}
        {files.length > 0 && (
          <>
            <div className="w-px h-3 bg-border shrink-0" />
            {/* Key hints */}
            <span className="shrink-0 hidden sm:inline">P pick</span>
            <span className="shrink-0 hidden sm:inline">X reject</span>
            <span className="shrink-0 hidden md:inline">Shift+B best</span>
            <span className="shrink-0 hidden md:inline">0-5 stars</span>
            <span className="shrink-0 hidden md:inline">{MOD}+Z undo</span>
          </>
        )}

        {/* Contextual tip — guides beginners */}
        {tip && (
          <span className="shrink-0 hidden lg:inline text-text-faint italic">{tip}</span>
        )}

        {/* Right-side quick actions */}
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {files.length > 0 && !isImporting && (
            <>
              <button
                onClick={() => dispatch({ type: 'SET_FILTER', filter: 'faces' })}
                className="px-2 py-0.5 rounded bg-surface-raised hover:bg-border text-text-secondary transition-colors"
                title="Show photos with detected faces."
              >
                Faces
              </button>
              <button
                onClick={() => dispatch({ type: 'SET_FILTER', filter: 'review-needed' })}
                className="px-2 py-0.5 rounded bg-surface-raised hover:bg-border text-text-secondary transition-colors"
                title="Show files that still need a decision: unpicked, blur-risk, similar, or not fully scored."
              >
                Review
              </button>
              <button
                onClick={() => dispatch({ type: 'SET_FILTER', filter: 'best' })}
                className="px-2 py-0.5 rounded bg-surface-raised hover:bg-border text-text-secondary transition-colors"
                title="Show top-scored keeper candidates using rating, protected status, subject focus, blur risk, and review score."
              >
                Best
              </button>
              <button
                onClick={() => dispatch({ type: 'QUEUE_BEST' })}
                className="px-2 py-0.5 rounded bg-surface-raised hover:bg-border text-text-secondary transition-colors"
                title="Auto-add high-scored keeper candidates to the import queue without changing pick/reject flags."
              >
                Queue Best
              </button>
            </>
          )}
          <button
            className="px-2 py-0.5 rounded bg-surface-raised hover:bg-border text-text-secondary transition-colors"
            title="Open settings"
            onClick={() => dispatch({ type: 'SET_VIEW_MODE', mode: 'settings' })}
          >
            Settings
          </button>
          <button
            className="px-2 py-0.5 rounded bg-surface-raised hover:bg-border text-text-secondary transition-colors"
            title="Open the quick-start tutorial"
            onClick={() => window.dispatchEvent(new Event('photo-importer:tutorial'))}
          >
            Tutorial
          </button>
          <button
            className="px-2 py-0.5 rounded bg-surface-raised hover:bg-border text-text-secondary transition-colors"
            title="Press ? to see all keyboard shortcuts"
            onClick={() => window.dispatchEvent(new Event('photo-importer:shortcuts'))}
          >
            ? Help
          </button>
        </div>
      </div>
    </div>
  );
}
