import { useEffect } from 'react';
import { useAppState, useAppDispatch } from '../context/ImportContext';
import { formatDuration, formatSize, formatSpeed } from '../utils/formatters';
import { useImport } from '../hooks/useImport';

export function ImportSummary() {
  const { phase, importResult, destination } = useAppState();
  const dispatch = useAppDispatch();
  const { startImport } = useImport();

  useEffect(() => {
    if (phase !== 'complete' || !importResult) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dispatch({ type: 'DISMISS_SUMMARY' });
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [phase, importResult, dispatch]);

  if (phase !== 'complete' || !importResult) return null;

  const handleOpenDestination = () => {
    if (destination) window.electronAPI.openPath(destination);
  };

  const handleDismiss = () => {
    dispatch({ type: 'DISMISS_SUMMARY' });
  };

  const handleRetry = () => {
    void startImport();
  };

  return (
    <div className="fixed inset-0 z-50 bg-surface-overlay flex items-center justify-center">
      <div className="bg-surface-alt rounded-lg border border-border p-8 max-w-md w-full mx-4 shadow-2xl">
        <h2 className="text-lg font-medium text-text mb-6">Import Complete</h2>

        <div className="space-y-3 mb-6">
          <div className="flex justify-between text-sm">
            <span className="text-text-secondary">Imported</span>
            <span className="text-green-400 font-mono font-medium">{importResult.imported}</span>
          </div>
          {importResult.skipped > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-text-secondary">Skipped (duplicates)</span>
              <span className="text-yellow-400 font-mono">{importResult.skipped}</span>
            </div>
          )}
          {typeof importResult.verified === 'number' && (
            <div className="flex justify-between text-sm">
              <span className="text-text-secondary">Verified</span>
              <span className="text-emerald-400 font-mono">{importResult.verified}</span>
            </div>
          )}
          {typeof importResult.checksumVerified === 'number' && importResult.checksumVerified > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-text-secondary">Checksum verified</span>
              <span className="text-emerald-400 font-mono">{importResult.checksumVerified}</span>
            </div>
          )}
          {importResult.errors.length > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-text-secondary">Errors</span>
              <span className="text-red-400 font-mono">{importResult.errors.length}</span>
            </div>
          )}
          <div className="flex justify-between text-sm">
            <span className="text-text-secondary">Total size</span>
            <span className="text-text font-mono">{formatSize(importResult.totalBytes)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-text-secondary">Duration</span>
            <span className="text-text font-mono">{formatDuration(importResult.durationMs)}</span>
          </div>
          {importResult.totalBytes > 0 && importResult.durationMs > 500 && (
            <div className="flex justify-between text-sm">
              <span className="text-text-secondary">Avg speed</span>
              <span className="text-text font-mono">
                {formatSpeed(Math.round(importResult.totalBytes / (importResult.durationMs / 1000)))}
              </span>
            </div>
          )}
        </div>

        {/* Error list */}
        {importResult.errors.length > 0 && (
          <div className="mb-6 max-h-32 overflow-y-auto">
            <h3 className="text-xs font-semibold text-red-400 uppercase tracking-wider mb-2">Errors</h3>
            {importResult.errors.map((err, i) => (
              <div key={i} className="text-xs text-text-secondary py-0.5 truncate" title={`${err.file}: ${err.error}`}>
                <span className="text-text-secondary">{err.file}</span>: {err.error}
              </div>
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3 flex-wrap">
          <button
            onClick={handleOpenDestination}
            className="flex-1 min-w-[9rem] py-2 rounded text-sm bg-accent hover:bg-accent-hover text-white font-medium transition-colors"
          >
            Open Destination
          </button>
          {importResult.errors.length > 0 && (
            <button
              onClick={handleRetry}
              className="flex-1 min-w-[9rem] py-2 rounded text-sm bg-surface-raised hover:bg-red-500/10 text-red-300 transition-colors"
            >
              Retry Import
            </button>
          )}
          <button
            onClick={handleDismiss}
            className="flex-1 min-w-[9rem] py-2 rounded text-sm bg-surface-raised hover:bg-accent/10 text-text transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
