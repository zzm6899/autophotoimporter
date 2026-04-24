import { useEffect, useState } from 'react';
import { useAppState } from '../context/ImportContext';
import { useImport } from '../hooks/useImport';
import { formatSize, formatSpeed, formatEta } from '../utils/formatters';

export function ImportProgress() {
  const { phase, importProgress, volumeImportQueue } = useAppState();
  const { cancelImport } = useImport();
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    if (phase === 'importing') setCollapsed(true);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'importing' || !importProgress) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelImport();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [phase, importProgress, cancelImport]);

  if (phase !== 'importing') return null;

  const percent = importProgress && importProgress.totalFiles > 0
    ? Math.round((importProgress.currentIndex / importProgress.totalFiles) * 100)
    : 0;

  const queueLabel = volumeImportQueue.length > 1
    ? ` — Card 1 of ${volumeImportQueue.length}`
    : '';

  if (collapsed) {
    return (
      <div className="fixed bottom-9 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-surface-alt border border-border rounded-lg px-4 py-2 shadow-xl min-w-[280px] max-w-[min(92vw,38rem)]">
        <span className="text-xs font-medium text-text shrink-0">Importing</span>
        {/* Mini progress bar */}
        <div className="flex-1 h-1.5 bg-surface-raised rounded-full overflow-hidden">
          <div
            className="h-full bg-accent rounded-full transition-[width] duration-300 ease-out"
            style={{ width: `${percent}%` }}
          />
        </div>
        <span className="text-xs font-mono text-text-secondary shrink-0">{percent}%</span>
        {importProgress?.bytesPerSec != null && (
          <span className="text-[10px] font-mono text-text-muted shrink-0">
            {formatSpeed(importProgress.bytesPerSec)}
          </span>
        )}
        {importProgress?.etaSec != null && importProgress.etaSec > 0 && (
          <span className="text-[10px] text-text-muted shrink-0">
            ~{formatEta(importProgress.etaSec)}
          </span>
        )}
        {queueLabel && (
          <span className="text-[10px] text-text-muted shrink-0">{queueLabel.replace(' — ', '')}</span>
        )}
        <button
          onClick={() => setCollapsed(false)}
          className="shrink-0 p-0.5 rounded text-text-muted hover:text-text transition-colors"
          title="Expand import progress"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M14.77 12.79a.75.75 0 01-1.06-.02L10 8.832 6.29 12.77a.75.75 0 11-1.08-1.04l4.25-4.5a.75.75 0 011.08 0l4.25 4.5a.75.75 0 01-.02 1.06z" clipRule="evenodd" />
          </svg>
        </button>
        <button
          onClick={cancelImport}
          className="shrink-0 p-0.5 rounded text-text-muted hover:text-red-400 transition-colors"
          title="Cancel import (Esc)"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div className="fixed bottom-9 right-4 z-50 flex items-end justify-end pointer-events-none">
      <div className="pointer-events-auto">
      <div className="bg-surface-alt rounded-lg border border-border p-6 max-w-md w-full mx-4 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-text">
            Importing Photos{queueLabel}
          </h2>
          <button
            onClick={() => setCollapsed(true)}
            className="p-1 rounded text-text-muted hover:text-text hover:bg-surface-raised transition-colors"
            title="Minimize — import continues in the background"
          >
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
            </svg>
          </button>
        </div>

        {/* Progress bar */}
        <div className="h-2 bg-surface-raised rounded-full mb-4 overflow-hidden">
          <div
            className="h-full bg-accent rounded-full transition-[width] duration-300 ease-out"
            style={{ width: `${percent}%` }}
          />
        </div>

        {/* Percentage */}
        <div className="text-center text-2xl font-mono font-semibold text-text mb-4">
          {percent}%
        </div>

        {/* Stats */}
        <div className="space-y-2 mb-5">
          <div className="flex justify-between text-sm">
            <span className="text-text-secondary">Files</span>
            <span className="text-text font-mono">
              {importProgress ? `${importProgress.currentIndex} / ${importProgress.totalFiles}` : 'Preparing…'}
            </span>
          </div>
          {importProgress ? (
            <>
              <div className="flex justify-between text-sm">
                <span className="text-text-secondary">Transferred</span>
                <span className="text-text font-mono">
                  {formatSize(importProgress.bytesTransferred)} / {formatSize(importProgress.totalBytes)}
                </span>
              </div>
              {importProgress.bytesPerSec != null && (
                <div className="flex justify-between text-sm">
                  <span className="text-text-secondary">Speed</span>
                  <span className="text-text font-mono">
                    {formatSpeed(importProgress.bytesPerSec)}
                    {importProgress.etaSec != null && importProgress.etaSec > 0 && (
                      <span className="text-text-muted ml-2">~{formatEta(importProgress.etaSec)} left</span>
                    )}
                  </span>
                </div>
              )}
              {importProgress.skipped > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-text-secondary">Skipped (duplicates)</span>
                  <span className="text-yellow-400 font-mono">{importProgress.skipped}</span>
                </div>
              )}
              {importProgress.errors > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-text-secondary">Errors</span>
                  <span className="text-red-400 font-mono">{importProgress.errors}</span>
                </div>
              )}
            </>
          ) : (
            <div className="flex justify-between text-sm">
              <span className="text-text-secondary">Status</spa