import { useEffect } from 'react';
import { useAppState, useAppDispatch } from '../context/ImportContext';
import { formatDuration, formatSize } from '../utils/formatters';

export function ImportSummary() {
  const { phase, importResult, destination } = useAppState();
  const dispatch = useAppDispatch();

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
        <div className="flex gap-3">
          <button
            onClick={handleOpenDestination}
            className="flex-1 py-2 rounded text-sm bg-accent hover:bg-accent-hover text-white font-medium transition-colors"
          >
            Open Destination
          </button>
          <button
            onClick={handleDismiss}
            className="flex-1 py-2 rounded text-sm bg-surface-raised hover:bg-accent/10 text-text transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
