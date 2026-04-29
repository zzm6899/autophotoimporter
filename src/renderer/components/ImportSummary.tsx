import { useEffect } from 'react';
import { useAppState, useAppDispatch } from '../context/ImportContext';
import { formatDuration, formatSize, formatSpeed } from '../utils/formatters';
import { useImport } from '../hooks/useImport';
import type { ImportResult } from '../../shared/types';

export function summarizeImportResult(result: ImportResult) {
  const failedCount = result.ledgerItems?.filter((item) => item.status === 'failed').length ?? result.errors.length;
  const pendingCount = result.ledgerItems?.filter((item) => item.status === 'pending').length ?? 0;
  const verifiedCount = result.verified ?? 0;
  const checksumCount = result.checksumVerified ?? 0;
  const issueCount = failedCount + pendingCount;
  const completedCount = result.imported + result.skipped;
  const recoveredCount = result.recoveryCount ?? 0;
  const verificationLabel = checksumCount > 0
    ? `${checksumCount} checksum ${checksumCount === 1 ? 'match' : 'matches'} confirmed`
    : verifiedCount > 0
      ? `${verifiedCount} ${verifiedCount === 1 ? 'file was' : 'files were'} verified after copy`
      : 'No post-copy verification was recorded for this run';
  const outcomeTone = issueCount > 0 ? 'needs-attention' : 'complete';
  const outcomeTitle = issueCount > 0 ? 'Import Finished With Follow-Up' : 'Import Complete';
  const outcomeMessage = issueCount > 0
    ? `${completedCount} ${completedCount === 1 ? 'item is' : 'items are'} safely accounted for. ${issueCount} ${issueCount === 1 ? 'item needs' : 'items need'} another pass.`
    : recoveredCount > 0
      ? `All selected files are accounted for, including ${recoveredCount} recovered ${recoveredCount === 1 ? 'item' : 'items'}.`
      : 'All selected files are accounted for.';
  const recoveryMessage = issueCount > 0
    ? pendingCount > 0
      ? 'Retry will pick up failed and pending files from the saved import ledger.'
      : 'Retry will copy only the files that failed in this run.'
    : 'No recovery action is needed.';

  return {
    failedCount,
    pendingCount,
    verifiedCount,
    checksumCount,
    issueCount,
    completedCount,
    recoveredCount,
    verificationLabel,
    outcomeTone,
    outcomeTitle,
    outcomeMessage,
    recoveryMessage,
  };
}

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
    void startImport({ retryFailed: true });
  };

  const summary = summarizeImportResult(importResult);
  const issueItems = importResult.ledgerItems?.filter((item) => item.status === 'failed' || item.status === 'pending') ?? [];
  const displayedIssues = issueItems.length > 0
    ? issueItems.map((item) => ({
        file: item.name,
        error: item.error ?? (item.status === 'pending' ? 'Pending retry' : 'Failed during import'),
      }))
    : importResult.errors;
  const reportDetails = [
    `${importResult.imported} imported`,
    `${importResult.skipped} skipped`,
    summary.verificationLabel,
    formatSize(importResult.totalBytes),
    formatDuration(importResult.durationMs),
  ];

  return (
    <div className="fixed inset-0 z-50 bg-surface-overlay flex items-center justify-center">
      <div
        className="bg-surface-alt rounded-lg border border-border p-8 max-w-lg w-full mx-4 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-summary-title"
        aria-describedby="import-summary-report"
      >
        <div className="mb-6">
          <p className={`text-xs font-semibold uppercase tracking-wider ${summary.outcomeTone === 'complete' ? 'text-emerald-400' : 'text-yellow-400'}`}>
            {summary.issueCount > 0 ? 'Review needed' : 'Verified handoff'}
          </p>
          <h2 id="import-summary-title" className="mt-1 text-lg font-medium text-text">{summary.outcomeTitle}</h2>
          <p id="import-summary-report" className="mt-2 text-sm text-text-secondary">{summary.outcomeMessage}</p>
        </div>

        <div className="mb-6 rounded border border-border bg-surface-raised px-3 py-2">
          <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">Import report</h3>
          <p className="mt-1 text-sm text-text">{reportDetails.join(' · ')}</p>
          <p className="mt-1 text-xs text-text-muted">{summary.recoveryMessage}</p>
        </div>

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
          {summary.pendingCount > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-text-secondary">Pending retry</span>
              <span className="text-orange-300 font-mono">{summary.pendingCount}</span>
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
        {displayedIssues.length > 0 && (
          <div className="mb-6 max-h-32 overflow-y-auto">
            <h3 className="text-xs font-semibold text-red-400 uppercase tracking-wider mb-2">Needs recovery</h3>
            {displayedIssues.map((err, i) => (
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
          <button
            onClick={handleOpenDestination}
            className="flex-1 min-w-[9rem] py-2 rounded text-sm bg-surface-raised hover:bg-blue-500/10 text-blue-300 transition-colors"
            title="Open the output folder. XMP sidecars, ratings, labels, keywords, GPS, and scene buckets are ready for Lightroom Classic import."
          >
            Lightroom Handoff
          </button>
          {summary.issueCount > 0 && (
            <button
              onClick={handleRetry}
              className="flex-1 min-w-[9rem] py-2 rounded text-sm bg-surface-raised hover:bg-red-500/10 text-red-300 transition-colors"
            >
              Retry Failed/Pending
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
