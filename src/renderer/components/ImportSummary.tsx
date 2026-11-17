import { useEffect, useRef, useState } from 'react';
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
  const plannedCount = (result.ledgerItems ?? []).filter((item) => item.status === 'planned').length;
  const newCopies = Math.max(0, result.imported - plannedCount);
  const previewOnly = plannedCount > 0 && newCopies === 0;
  const transferLabel = previewOnly ? 'Preview only' : issueCount > 0 ? 'Review required'
    : result.imported === 0 ? 'No new copies'
    : checksumCount === result.imported ? 'All new copies checksum-matched'
    : checksumCount > 0 ? 'Partial checksum coverage'
    : verifiedCount > 0 ? 'Copy checks recorded'
    : 'Copies not verified';
  const backupPlannedCount = result.ledgerItems?.filter((item) => item.backupFullPath).length;
  const outcomeTone = issueCount > 0 ? 'needs-attention' : 'complete';
  const outcomeTitle = previewOnly ? 'Import preview' : issueCount > 0 ? 'Import Finished With Follow-Up' : 'Import Complete';
  const outcomeMessage = previewOnly ? 'This was a dry run. No files were copied.' : issueCount > 0
    ? `${completedCount} ${completedCount === 1 ? 'item is' : 'items are'} accounted for. ${issueCount} ${issueCount === 1 ? 'item needs' : 'items need'} another pass.`
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
    transferLabel,
    plannedCount,
    newCopies,
    previewOnly,
    backupPlannedCount,
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
  const [openError, setOpenError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (phase !== 'complete' || !importResult || !dialog) return;
    setOpenError(null);
    setCopied(false);
    dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, [phase, importResult]);

  if (phase !== 'complete' || !importResult) return null;

  const openPath = async (target?: string | null) => {
    if (!target) return;
    setOpenError(null);
    try {
      await window.electronAPI.openPath(target);
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : 'Could not open that path.');
    }
  };

  const handleOpenDestination = () => {
    void openPath(destination);
  };

  const handleOpenImportLog = () => {
    void openPath(importResult.importLogCsvPath);
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
    setOpenError(null);
    void navigator.clipboard.writeText(report).then(() => setCopied(true)).catch(() => {
      setCopied(false);
      setOpenError('Could not copy the report to the clipboard.');
    });
  };

  const handleExportManifest = () => {
    setOpenError(null);
    void window.electronAPI.exportManifest('csv').catch(() => setOpenError('Could not export the manifest.'));
  };

  const handleLightroomHandoff = async () => {
    if (handoffBusy) return;
    const existingDir = importResult?.lightroomHandoff?.outputDir;
    if (existingDir) {
      void openPath(existingDir);
      return;
    }
    setOpenError(null);
    setHandoffBusy(true);
    try {
      const handoff = await window.electronAPI.exportLightroomHandoff(files);
      if (handoff?.outputDir) void openPath(handoff.outputDir);
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : 'Could not export the Lightroom handoff.');
    } finally {
      setHandoffBusy(false);
    }
  };

  const summary = summarizeImportResult(importResult);
  const flowSummary = summarizeReviewImportVisibility(importResult, files, selectedPaths.length, queuedPaths.length);
  const displayedIssues = summary.displayedIssues;
  const importedOutputs = (importResult.ledgerItems ?? [])
    .filter((item) => (item.status === 'imported' || item.status === 'verified') && (item.destFullPath || item.backupFullPath))
    .slice(0, 6);
  const reportDetails = [
    summary.previewOnly ? `${summary.plannedCount} planned, no files copied` : `${summary.newCopies} imported`,
    summary.skippedSummary.reportLabel,
    summary.verificationLabel,
    formatSize(importResult.totalBytes),
    formatDuration(importResult.durationMs),
  ];

  const secondary = 'rounded-md border border-border bg-surface px-3 py-2 text-sm text-text hover:bg-surface-raised focus-visible:outline-accent disabled:opacity-50';
  const retryable = importFailedPaths.length > 0
    || (importResult.ledgerItems ?? []).some((item) => item.status === 'failed' || item.status === 'pending');
  const backupLabel = summary.backupPlannedCount === undefined ? 'No backup record'
    : summary.backupPlannedCount === 0 ? 'No backup paths recorded'
    : countLabel(summary.backupPlannedCount, 'planned backup path');
  const primary = summary.previewOnly ? { label: 'Back to workspace', action: handleDismiss }
    : retryable
    ? { label: 'Retry failed or pending files', action: handleRetry }
    : destination
      ? { label: 'Open destination', action: handleOpenDestination }
      : { label: 'Back to workspace', action: handleDismiss };
  return (
    <dialog ref={dialogRef} onCancel={(event) => { event.preventDefault(); handleDismiss(); }}
      aria-labelledby="import-summary-title" aria-describedby="import-summary-report"
      className="m-auto max-w-2xl max-h-[90vh] overflow-hidden rounded-xl border border-border bg-surface-alt p-0 text-text shadow-2xl backdrop:bg-black/60"
      style={{ width: 'min(42rem, calc(100vw - 2rem))' }}>
      <div className="flex max-h-[90vh] flex-col">
        <div className="min-h-0 overflow-y-auto p-5 sm:p-7">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-widest text-text-muted">Keptra / Transfer report</span>
            <span className={`rounded-full border border-border px-2.5 py-1 text-xs font-medium ${summary.issueCount ? 'text-orange-800 dark:text-orange-300' : 'text-text-secondary'}`}>{summary.transferLabel}</span>
          </div>
          <h2 id="import-summary-title" tabIndex={-1} autoFocus className="text-2xl font-semibold tracking-tight">{summary.outcomeTitle}</h2>
          <p id="import-summary-report" className="mt-1 text-sm text-text-secondary">{summary.outcomeMessage}</p>

          <dl className="my-5 grid grid-cols-3 divide-x divide-border rounded-lg border border-border bg-surface">
            {[
              [summary.previewOnly ? 'Planned' : 'New copies', summary.previewOnly ? summary.plannedCount : summary.newCopies], ['Skipped', importResult.skipped], ['Issues', summary.issueCount],
            ].map(([label, value]) => (
              <div key={label} className="px-3 py-3 sm:px-4">
                <dt className="text-xs text-text-secondary">{label}</dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          <section aria-labelledby="verification-title" className="rounded-lg border border-border bg-surface p-4">
            <h3 id="verification-title" className="mb-2 text-sm font-semibold">Verification and backup</h3>
            <dl className="space-y-1.5 text-sm">
              <div className="flex justify-between gap-3"><dt className="text-text-secondary">Post-copy checks</dt><dd>{summary.verifiedCount} / {summary.newCopies} new copies</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-text-secondary">Checksum matches</dt><dd>{summary.checksumCount} / {summary.newCopies} new copies</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-text-secondary">Backup plan</dt><dd className="text-right">{backupLabel}</dd></div>
            </dl>
            <p className="mt-3 border-t border-border pt-2 text-xs text-text-muted">Post-copy checks are not checksum matches. A planned backup path is not proof of a verified second copy.</p>
          </section>
          {displayedIssues.length > 0 && (
            <section className="mt-4 rounded-lg border border-border bg-surface p-4" aria-labelledby="issues-title">
              <h3 id="issues-title" className="text-sm font-semibold text-orange-800 dark:text-orange-300">Needs attention</h3>
              <p className="my-1 text-xs text-text-secondary">{summary.recoveryMessage}</p>
              <ul className="max-h-32 space-y-1 overflow-auto text-xs">
                {displayedIssues.map((issue, index) => <li key={index} className="break-words">{issue.file}: {issue.error}</li>)}
              </ul>
              {importFailedPaths.length > 0 && <button type="button" className={`mt-2 ${secondary}`} onClick={handleViewFailures}>View affected files ({importFailedPaths.length})</button>}
            </section>
          )}
          <details className="mt-4 rounded-lg border border-border bg-surface p-4 text-sm">
            <summary className="cursor-pointer font-medium">Transfer details and exports</summary>
            <p className="mt-3 text-text-secondary">{flowSummary.sourceLabel}: {flowSummary.sourceMessage}</p>
            <p className="mt-1 text-text-secondary">{formatSize(importResult.totalBytes)} · {formatDuration(importResult.durationMs)}
              {importResult.totalBytes > 0 && importResult.durationMs > 500 && ` · ${formatSpeed(Math.round(importResult.totalBytes / (importResult.durationMs / 1000)))}`}</p>
            {summary.skippedSummary.detail && <p className="mt-1 text-text-secondary">Skipped: {summary.skippedSummary.detail}</p>}
            {destination && <p className="mt-2 break-all text-xs text-text-muted">Destination: {destination}</p>}
            {importResult.importLogCsvPath && <p className="break-all text-xs text-text-muted">Log: {importResult.importLogCsvPath}</p>}
            {importedOutputs.length > 0 && <div className="mt-3">
              <h3 className="text-xs font-semibold">Sample outputs</h3>
              {importedOutputs.map((item) => <button key={item.sourcePath} className="block max-w-full truncate py-1 text-left text-sm text-text-secondary underline" onClick={() => { void openPath(item.destFullPath ?? item.backupFullPath); }}>{item.name}</button>)}
            </div>}
            <div className="mt-3 flex flex-wrap gap-2">
              {retryable && destination && <button className={secondary} onClick={handleOpenDestination}>Open destination</button>}
              {!summary.previewOnly && <button className={secondary} disabled={handoffBusy} onClick={() => { void handleLightroomHandoff(); }}>{handoffBusy ? 'Exporting…' : 'Lightroom handoff'}</button>}
              <button className={secondary} onClick={handleCopyReport}>{copied ? 'Report copied' : 'Copy report'}</button>
              <button className={secondary} onClick={handleExportManifest}>Export manifest</button>
              {importResult.importLogCsvPath && <button className={secondary} onClick={handleOpenImportLog}>Open import log</button>}
            </div>
          </details>
          {openError && <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-400">{openError}</p>}
        </div>
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-surface px-5 py-3">
          {primary.action !== handleDismiss && <button className={secondary} onClick={handleDismiss}>Done</button>}
          <button className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover" onClick={primary.action}>{primary.label}</button>
        </footer>
      </div>
    </dialog>
  );
}
