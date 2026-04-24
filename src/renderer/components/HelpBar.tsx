import { useAppDispatch, useAppState } from '../context/ImportContext';
import { useFileScanner } from '../hooks/useFileScanner';

const isMac = typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin';
const MOD = isMac ? 'Cmd' : 'Ctrl';

function getContextTip(phase: string, fileCount: number, picked: number, queued: number): string {
  if (phase === 'scanning') return 'Scanning your files. Thumbnails will appear shortly.';
  if (fileCount === 0) return 'Select a source on the left to scan for photos.';
  if (queued > 0) return `${queued} file${queued !== 1 ? 's' : ''} queued. Click Import in the right panel when ready.`;
  if (picked > 0) return `${picked} picked. Add them to the queue or import now.`;
  if (fileCount > 0 && picked === 0) return 'Press Enter for detail view, P to pick, X to reject, and Q to queue keepers.';
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
  const nativeFaceFiles = files.filter((f) => (f.faceCount ?? 0) > 0 && f.faceDetection === 'native').length;
  const estimatedFaceFiles = files.filter((f) => (f.faceCount ?? 0) > 0 && f.faceDetection === 'estimated').length;
  const blurRisk = files.filter((f) => f.blurRisk === 'high' || f.blurRisk === 'medium').length;
  const faceFiles = files.filter((f) => (f.faceCount ?? 0) > 0).length;
  const faceGroups = new Set(files.map((f) => f.faceGroupId).filter(Boolean)).size;
  const focusedLabel = focusedIndex >= 0 && focusedIndex < files.length
    ? `${focusedIndex + 1} / ${files.length}`
    : `${files.length} photo${files.length !== 1 ? 's' : ''}`;

  const isImporting = phase === 'importing' && importProgress;
  const isScanning = phase === 'scanning';
  const tip = getContextTip(phase, files.length, picked, queuedPaths.length);

  const importPct = isImporting
    ? Math.round((importProgress.currentIndex / Math.max(1, importProgress.totalFiles)) * 100)
    : 0;

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface-alt/95 backdrop-blur-sm">
      {isImporting && (
        <div className="h-0.5 bg-border">
          <div
            className="h-full bg-emerald-500 transition-all duration-300"
            style={{ width: `${importPct}%` }}
          />
        </div>
      )}

      <div className="flex items-center gap-3 overflow-x-auto px-3 py-1.5 text-[10px] text-text-muted">
        <div className="flex shrink-0 items-center gap-1.5">
          {isImporting ? (
            <>
              <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-500" />
              <span className="font-medium text-text-secondary">
                Importing {importProgress.currentIndex}/{importProgress.totalFiles}
              </span>
            </>
          ) : isScanning ? (
            <>
              <span className={`h-2 w-2 shrink-0 rounded-full ${scanPaused ? 'bg-yellow-500' : 'animate-pulse bg-blue-500'}`} />
              <span className="font-medium text-text-secondary">{scanPaused ? 'Paused' : 'Scanning...'}</span>
              <button
                onClick={() => (scanPaused ? resumeScan() : pauseScan())}
                className="rounded bg-surface-raised px-1.5 py-0.5 text-text-secondary transition-colors hover:bg-border"
              >
                {scanPaused ? 'Resume' : 'Pause'}
              </button>
            </>
          ) : (
            <>
              <span className={`h-2 w-2 shrink-0 rounded-full ${files.length > 0 ? 'bg-emerald-500' : 'bg-border'}`} />
              <span className="font-medium text-text-secondary">
                {viewMode === 'single' || viewMode === 'split' ? focusedLabel : `${files.length} file${files.length !== 1 ? 's' : ''}`}
              </span>
            </>
          )}
        </div>

        {filter !== 'all' && (
          <span className="flex shrink-0 items-center gap-1">
            <span className="text-text-muted">Filter:</span>
            <span className="text-text-secondary">{filter}</span>
            <button
              onClick={() => dispatch({ type: 'SET_FILTER', filter: 'all' })}
              className="ml-0.5 text-text-faint transition-colors hover:text-text"
              title="Clear filter"
            >
              x
            </button>
          </span>
        )}
        {selectedPaths.length > 0 && <span className="shrink-0 text-blue-300">{selectedPaths.length} selected</span>}
        {queuedPaths.length > 0 && <span className="shrink-0 text-emerald-300">{queuedPaths.length} queued</span>}
        {picked > 0 && <span className="shrink-0 text-yellow-300">{picked} picked</span>}
        {rejected > 0 && <span className="shrink-0 text-red-300">{rejected} rejected</span>}
        {files.length > 0 && (
          <span
            className="shrink-0 text-text-faint"
            title="Smart review progress: files analyzed for blur risk, subject or facial focus, and keeper score."
          >
            AI review {analyzed}/{files.length}
            {estimatedFaceFiles > 0 ? ` (${nativeFaceFiles} native, ${estimatedFaceFiles} est.)` : ''}
            {faceFiles > 0 ? ` | faces ${faceFiles}` : ''}
            {faceGroups > 0 ? ` | groups ${faceGroups}` : ''}
            {blurRisk > 0 ? ` | blur ${blurRisk}` : ''}
          </span>
        )}

        {files.length > 0 && (
          <>
            <div className="h-3 w-px shrink-0 bg-border" />
            <span className="hidden shrink-0 sm:inline">P pick</span>
            <span className="hidden shrink-0 sm:inline">X reject</span>
            <span className="hidden shrink-0 md:inline">Q queue</span>
            <span className="hidden shrink-0 md:inline">Shift+B best</span>
            <span className="hidden shrink-0 md:inline">0-5 stars</span>
            <span className="hidden shrink-0 md:inline">{MOD}+Z undo</span>
          </>
        )}

        {tip && <span className="hidden shrink-0 italic text-text-faint lg:inline">{tip}</span>}

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {files.length > 0 && !isImporting && (
            <>
              <button
                onClick={() => dispatch({ type: 'SET_FILTER', filter: 'faces' })}
                className="rounded bg-surface-raised px-2 py-0.5 text-text-secondary transition-colors hover:bg-border"
                title="Show photos with native or estimated face detections."
              >
                Faces{faceFiles > 0 ? ` ${faceFiles}` : ''}
              </button>
              <button
                onClick={() => dispatch({ type: 'CLEAR_FACE_DATA' })}
                className="rounded bg-surface-raised px-2 py-0.5 text-text-secondary transition-colors hover:bg-border"
                title="Re-run local face, eye, subject, blur, and keeper analysis."
              >
                Re-scan AI
              </button>
              <button
                onClick={() => dispatch({ type: 'SET_FILTER', filter: 'review-needed' })}
                className="rounded bg-surface-raised px-2 py-0.5 text-text-secondary transition-colors hover:bg-border"
                title="Show files that still need a decision: unpicked, blur-risk, similar, or not fully scored."
              >
                Review
              </button>
              <button
                onClick={() => dispatch({ type: 'SET_FILTER', filter: 'best' })}
                className="rounded bg-surface-raised px-2 py-0.5 text-text-secondary transition-colors hover:bg-border"
                title="Show top-scored keeper candidates using rating, protected status, subject focus, blur risk, and review score."
              >
                Best
              </button>
              <button
                onClick={() => dispatch({ type: 'QUEUE_BEST' })}
                className="rounded bg-surface-raised px-2 py-0.5 text-text-secondary transition-colors hover:bg-border"
                title="Create a fresh queue of batch-best keepers: one winner per burst or similar group plus strong ungrouped shots."
              >
                Queue Batch Best
              </button>
            </>
          )}
          <button
            className="rounded bg-surface-raised px-2 py-0.5 text-text-secondary transition-colors hover:bg-border"
            title={viewMode === 'settings' ? 'Back to grid' : 'Open settings'}
            onClick={() => dispatch({ type: 'SET_VIEW_MODE', mode: viewMode === 'settings' ? 'grid' : 'settings' })}
          >
            Settings
          </button>
          <button
            className="rounded bg-surface-raised px-2 py-0.5 text-text-secondary transition-colors hover:bg-border"
            title="Open the quick-start tutorial"
            onClick={() => window.dispatchEvent(new Event('photo-importer:tutorial'))}
          >
            Tutorial
          </button>
          <button
            className="rounded bg-surface-raised px-2 py-0.5 text-text-secondary transition-colors hover:bg-border"
            title="Press ? to see all keyboard shortcuts"
            onClick={() => window.dispatchEvent(new Event('photo-importer:shortcuts'))}
          >
            Help
          </button>
        </div>
      </div>
    </div>
  );
}
