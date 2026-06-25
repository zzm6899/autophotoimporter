import { useEffect, useState } from 'react';
import { useAppState, useAppDispatch } from '../context/ImportContext';
import { formatDuration, formatSize, formatSpeed } from '../utils/formatters';
import { useImport } from '../hooks/useImport';
import type { ImportLedgerItem, ImportResult, MediaFile } from '../../shared/types';

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function classifySkippedReason(item: ImportLedgerItem): 'duplicate' | 'conflict' | 'other' {
  const reason = (item.error ?? '').toLowerCase();
  if (reason.includes('duplicate')) return 'duplicate';
  if (
    reason.includes('conflict')
    || reason.includes('eexist')
    || (reason.includes('destination') && reason.includes('exist'))
    || reason.includes('destination already exists')
    || reason.includes('destination file already exists')
  ) {
    return 'conflict';
  }
  return 'other';
}

export function summarizeSkippedImportReasons(result: ImportResult) {
  const skippedItems = result.ledgerItems?.filter((item) => item.status === 'skipped') ?? [];
  let duplicateCount = 0;
  let conflictCount = 0;
  let otherCount = 0;

  if (skippedItems.length > 0) {
    for (const item of skippedItems) {
      const reason = classifySkippedReason(item);
      if (reason === 'duplicate') duplicateCount++;
      else if (reason === 'conflict') conflictCount++;
      else otherCount++;
    }
    otherCount += Math.max(0, result.skipped - skippedItems.length);
  } else {
    duplicateCount = result.skipped;
  }

  const parts = [
    duplicateCount > 0 ? countLabel(duplicateCount, skippedItems.length > 0 ? 'duplicate' : 'presumed duplicate') : null,
    conflictCount > 0 ? countLabel(conflictCount, 'destination conflict') : null,
    otherCount > 0 ? countLabel(otherCount, 'other skipped file') : null,
  ].filter((part): part is string => part !== null);
  const detail = parts.join(', ');
  const reportLabel = detail ? `${result.skipped} skipped (${detail})` : `${result.skipped} skipped`;

  return {
    total: result.skipped,
    duplicateCount,
    conflictCount,
    otherCount,
    detail,
    reportLabel,
  };
}

function normalizeIssueText(value?: string) {
  return (value ?? '').trim().toLowerCase();
}

function importIssueKey(file: string, error?: string) {
  return `${normalizeIssueText(file)}\u0000${normalizeIssueText(error)}`;
}

export function summarizeImportIssues(result: ImportResult) {
  const ledgerIssueItems = result.ledgerItems?.filter((item) => item.status === 'failed' || item.status === 'pending') ?? [];
  const ledgerIssues = ledgerIssueItems.map((item) => ({
    file: item.name,
    error: item.error ?? (item.status === 'pending' ? 'Pending retry' : 'Failed during import'),
  }));
  const ledgerIssueKeys = new Set(ledgerIssues.map((issue) => importIssueKey(issue.file, issue.error)));
  const nonLedgerIssues = result.ledgerItems
    ? result.errors.filter((issue) => !ledgerIssueKeys.has(importIssueKey(issue.file, issue.error)))
    : [];
  const displayedIssues = result.ledgerItems ? [...ledgerIssues, ...nonLedgerIssues] : result.errors;
  const pendingCount = ledgerIssueItems.filter((item) => item.status === 'pending').length;
  const failedCount = result.ledgerItems
    ? ledgerIssueItems.filter((item) => item.status === 'failed').length + nonLedgerIssues.length
    : result.errors.length;

  return {
    failedCount,
    pendingCount,
    nonLedgerErrorCount: nonLedgerIssues.length,
    issueCount: failedCount + pendingCount,
    displayedIssues,
  };
}

export function summarizeImportResult(result: ImportResult) {
  const importIssues = summarizeImportIssues(result);
  const failedCount = importIssues.failedCount;
  const pendingCount = importIssues.pendingCount;
  const skippedSummary = summarizeSkippedImportReasons(result);
  const verifiedCount = result.verified ?? 0;
  const checksumCount = result.checksumVerified ?? 0;
  const issueCount = importIssues.issueCount;
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
      : importIssues.nonLedgerErrorCount > 0 && failedCount === importIssues.nonLedgerErrorCount
        ? 'Review the listed copy or verification errors before handing this set off.'
        : importIssues.nonLedgerErrorCount > 0
          ? 'Retry will copy failed files; review additional copy or verification errors below.'
          : 'Retry will copy only the files that failed in this run.'
    : 'No recovery action is needed.';

  return {
    failedCount,
    pendingCount,
    nonLedgerErrorCount: importIssues.nonLedgerErrorCount,
    verifiedCount,
    checksumCount,
    issueCount,
    completedCount,
    recoveredCount,
    skippedSummary,
    verificationLabel,
    outcomeTone,
    outcomeTitle,
    outcomeMessage,
    recoveryMessage,
    displayedIssues: importIssues.displayedIssues,
  };
}

export function summarizeReviewImportVisibility(
  result: ImportResult,
  files: MediaFile[],
  selectedCount = 0,
  queuedCount = 0,
) {
  const pickedCount = files.filter((file) => file.pick === 'selected').length;
  const rejectedCount = files.filter((file) => file.pick === 'rejected').length;
  const accountedCount = result.imported + result.skipped;
  const issueCount = summarizeImportIssues(result).issueCount;

  const nextStep = issueCount > 0
    ? 'Retry failed or pending files before handing this set off.'
    : result.lightroomHandoff?.outputDir
      ? 'Lightroom handoff is ready. Open the handoff folder or destination to continue.'
      : 'Open the destination to review the delivered files, or export a Lightroom handoff if needed.';

  if (selectedCount > 0) {
    return {
      sourceLabel: 'Manual selection',
      sourceMessage: `${selectedCount} grid ${selectedCount === 1 ? 'selection was' : 'selections were'} sent to import. ${accountedCount} ${accountedCount === 1 ? 'file is' : 'files are'} accounted for.`,
      nextStep,
    };
  }

  if (queuedCount > 0) {
    return {
      sourceLabel: 'Review queue',
      sourceMessage: `${queuedCount} queued ${queuedCount === 1 ? 'keeper was' : 'keepers were'} sent to import. ${accountedCount} ${accountedCount === 1 ? 'file is' : 'files are'} accounted for.`,
      nextStep,
    };
  }

  if (pickedCount > 0) {
    return {
      sourceLabel: 'Picked photos',
      sourceMessage: `${pickedCount} picked ${pickedCount === 1 ? 'photo was' : 'photos were'} sent to import. ${rejectedCount} rejected ${rejectedCount === 1 ? 'photo was' : 'photos were'} left out.`,
      nextStep,
    };
  }

  return {
    sourceLabel: 'Importable media',
    sourceMessage: `${accountedCount} ${accountedCount === 1 ? 'file is' : 'files are'} accounted for from available, non-rejected media.`,
    nextStep,
  };
}

export function ImportSummary() {
  const { phase, importResult, destination, files, selectedPaths, queuedPaths, importFailedPaths } = useAppState();
  const dispatch = useAppDispatch();
  const { startImport } = useImport();
  const [handoffBusy, setHandoffBusy] = useState(false);

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

  const handleOpenImportLog = () => {
    if (importResult.importLogCsvPath) window.electronAPI.openPath(importResult.importLogCsvPath);
  };

  const handleDismiss = () => {
    dispatch({ type: 'DISMISS_SUMMARY' });
  };

  const handleViewFailures = () => {
    dispatch({ type: 'SET_FILTER', filter: 'import-failures' });
    dispatch({ type: 'DISMISS_SUMMARY' });
  };

  const handleRetry = () => {
    void startImport({ retryFailed: true });
  };

  const handleCopyReport = () => {
    const issueLines = displayedIssues.map((issue) => `${issue.file}: ${issue.error}`);
    const report = [
      'Keptra import report',
      `Destination: ${destination || 'not set'}`,
      importResult.importLogCsvPath ? `Import log: ${importResult.importLogCsvPath}` : 'Import log: not written',
      ...reportDetails,
      issueLines.length > 0 ? 'Issues:' : 'Issues: none',
      ...issueLines,
    ].join('\n');
    void navigator.clipboard.writeText(report).catch(() => undefined);
  };

  const handleExportManifest = () => {
    void window.electronAPI.exportManifest('csv');
  };

  const handleLightroomHandoff = async () => {
    if (handoffBusy) return;
    const existingDir = importResult?.lightroomHandoff?.outputDir;
    if (existingDir) {
      void window.electronAPI.openPath(existingDir);
      return;
    }
    setHandoffBusy(true);
    try {
      const handoff = await window.electronAPI.exportLightroomHandoff(files);
      if (handoff?.outputDir) void window.electronAPI.openPath(handoff.outputDir);
    } finally {
      setHandoffBusy(false);
    }
  };

  const summary = summarizeImportResult(importResult);
  const flowSummary = summarizeReviewImportVisibility(importResult, files, selectedPaths.length, queuedPaths.length);
  const displayedIssues = summary.displayedIssues;
  const reportDetails = [
    `${importResult.imported} imported`,
    summary.skippedSummary.reportLabel,
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

        <div className="mb-6 rounded border border-border bg-surface px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">Review to import</h3>
            <span className="shrink-0 rounded bg-surface-raised px-2 py-0.5 text-[10px] font-medium text-text-secondary">
              {flowSummary.sourceLabel}
            </span>
          </div>
          <p className="mt-1 text-xs text-text-secondary">{flowSummary.sourceMessage}</p>
          <p className={`mt-1 text-xs ${summary.issueCount > 0 ? 'text-orange-200' : 'text-text-muted'}`}>
            Next: {flowSummary.nextStep}
          </p>
        </div>

        <div className="space-y-3 mb-6">
          <div className="flex justify-between text-sm">
            <span className="text-text-secondary">Imported</span>
            <span className="text-green-400 font-mono font-medium">{importResult.imported}</span>
          </div>
          {importResult.skipped > 0 && (
            <div>
              <div className="flex justify-between text-sm">
                <span className="text-text-secondary">Skipped</span>
                <span className="text-yellow-400 font-mono">{importResult.skipped}</span>
              </div>
              {summary.skippedSummary.detail && (
                <p className="mt-0.5 text-xs text-text-muted">{summary.skippedSummary.detail}</p>
              )}
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
          {importResult.importLogCsvPath && (
            <div className="flex justify-between gap-3 text-sm">
              <span className="text-text-secondary">Import log</span>
              <span className="truncate text-right font-mono text-text" title={importResult.importLogCsvPath}>
                {importResult.importLogCsvPath.split(/[/\\]/).pop()}
              </span>
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
            onClick={() => { void handleLightroomHandoff(); }}
            className="flex-1 min-w-[9rem] py-2 rounded text-sm bg-surface-raised hover:bg-blue-500/10 text-blue-300 transition-colors"
            disabled={handoffBusy}
            title="Open or export Keptra collection helper manifests for Lightroom Classic."
          >
            {handoffBusy ? 'Exporting...' : 'Lightroom Handoff'}
          </button>
          <button
            onClick={handleCopyReport}
            className="flex-1 min-w-[9rem] py-2 rounded text-sm bg-surface-raised hover:bg-accent/10 text-text transition-colors"
          >
            Copy Report
          </button>
          <button
            onClick={handleExportManifest}
            className="flex-1 min-w-[9rem] py-2 rounded text-sm bg-surface-raised hover:bg-accent/10 text-text transition-colors"
          >
            Export Manifest
          </button>
          {importResult.importLogCsvPath && (
            <button
              onClick={handleOpenImportLog}
              className="flex-1 min-w-[9rem] py-2 rounded text-sm bg-surface-raised hover:bg-accent/10 text-text transition-colors"
            >
              Open Import Log
            </button>
          )}
          {summary.issueCount > 0 && (
            <button
              onClick={handleRetry}
              className="flex-1 min-w-[9rem] py-2 rounded text-sm bg-surface-raised hover:bg-red-500/10 text-red-300 transition-colors"
            >
              Retry Failed/Pending
            </button>
          )}
          {importFailedPaths.length > 0 && (
            <button
              onClick={handleViewFailures}
              className="flex-1 min-w-[9rem] py-2 rounded text-sm bg-surface-raised hover:bg-orange-500/10 text-orange-300 transition-colors"
              title={`Filter the grid to the ${importFailedPaths.length} source ${importFailedPaths.length === 1 ? 'file' : 'files'} that failed or are pending retry.`}
            >
              View Failures ({importFailedPaths.length})
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
