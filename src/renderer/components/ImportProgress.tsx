import { useEffect } from 'react';
import { useAppState } from '../context/ImportContext';
import { useImport } from '../hooks/useImport';
import { formatSize } from '../utils/formatters';

export function ImportProgress() {
  const { phase, importProgress } = useAppState();
  const { cancelImport } = useImport();

  useEffect(() => {
    if (phase !== 'importing' || !importProgress) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelImport();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [phase, importProgress, cancelImport]);

  if (phase !== 'importing' || !importProgress) return null;

  const percent = importProgress.totalFiles > 0
    ? Math.round((importProgress.currentIndex / importProgress.totalFiles) * 100)
    : 0;

  return (
    <div className="fixed inset-0 z-50 bg-surface-overlay flex items-center justify-center">
      <div className="bg-surface-alt rounded-lg border border-border p-8 max-w-md w-full mx-4 shadow-2xl">
        <h2 className="text-lg font-medium text-text mb-6">Importing Photos</h2>

        {/* Progress bar */}
        <div className="h-2 bg-surface-raised rounded-full mb-4 overflow-hidden">
          <div
            className="h-full bg-accent rounded-full transition-[width] duration-300 ease-out"
            style={{ width: `${percent}%` }}
          />
        </div>

        {/* Stats */}
        <div className="space-y-2 mb-6">
          <div className="flex justify-between text-sm">
            <span className="text-text-secondary">Progress</span>
            <span className="text-text font-mono">
              {importProgress.currentIndex} / {importProgress.totalFiles}
            </span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-text-secondary">Transferred</span>
            <span className="text-text font-mono">
              {formatSize(importProgress.bytesTransferred)} / {formatSize(importProgress.totalBytes)}
            </span>
          </div>
          {importProgress.skipped > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-text-secondary">Skipped</span>
              <span className="text-yellow-400 font-mono">{importProgress.skipped}</span>
            </div>
          )}
          {importProgress.errors > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-text-secondary">Errors</span>
              <span className="text-red-400 font-mono">{importProgress.errors}</span>
            </div>
          )}
        </div>

        {/* Current file */}
        <div className="text-xs text-text-secondary truncate mb-6" title={importProgress.currentFile}>
          {importProgress.currentFile}
        </div>

        {/* Cancel button */}
        <button
          onClick={cancelImport}
          className="w-full py-2 rounded text-sm bg-surface-raised hover:bg-accent/10 text-text transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
