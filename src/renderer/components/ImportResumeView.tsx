import { useEffect, useMemo, useState } from 'react';
import { useAppDispatch, useAppState } from '../context/ImportContext';
import { useFileScanner } from '../hooks/useFileScanner';
import { useImport } from '../hooks/useImport';
import { formatDuration, formatSize } from '../utils/formatters';
import type { ImportLedger, ImportLedgerItem, ImportLedgerStatus } from '../../shared/types';

type ResumeTone = 'panel' | 'settings';

interface ImportResumeViewProps {
  tone?: ResumeTone;
}

const STATUS_LABELS: Record<ImportLedgerStatus, string> = {
  planned: 'Planned',
  imported: 'Imported',
  skipped: 'Skipped',
  failed: 'Failed',
  verified: 'Verified',
  pending: 'Pending',
};

const STATUS_CLASS: Record<ImportLedgerStatus, string> = {
  planned: 'text-blue-300',
  imported: 'text-emerald-400',
  skipped: 'text-yellow-400',
  failed: 'text-red-400',
  verified: 'text-cyan-300',
  pending: 'text-orange-300',
};

export function summarizeImportLedger(ledger: ImportLedger | null) {
  if (!ledger) {
    return {
      actionableCount: 0,
      completionPercent: 0,
      orderedItems: [] as ImportLedgerItem[],
    };
  }
  const actionableCount = ledger.items.filter((item) => item.status === 'failed' || item.status === 'pending').length;
  const completed = ledger.imported + ledger.skipped + (ledger.verified ?? 0);
  const completionPercent = ledger.totalFiles > 0
    ? Math.min(100, Math.round((completed / ledger.totalFiles) * 100))
    : 0;
  const rank: Record<ImportLedgerStatus, number> = {
    failed: 0,
    pending: 1,
    imported: 2,
    verified: 3,
    skipped: 4,
    planned: 5,
  };
  return {
    actionableCount,
    completionPercent,
    orderedItems: [...ledger.items].sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name)),
  };
}

function formatLedgerDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function basename(pathValue?: string): string {
  if (!pathValue) return '';
  const parts = pathValue.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || pathValue;
}

export function ImportResumeView({ tone = 'panel' }: ImportResumeViewProps) {
  const dispatch = useAppDispatch();
  const { selectedSource, destination, phase } = useAppState();
  const { startScan } = useFileScanner();
  const { startImport } = useImport();
  const [ledger, setLedger] = useState<ImportLedger | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  const summary = useMemo(() => summarizeImportLedger(ledger), [ledger]);
  const currentSessionMatches = !!ledger && selectedSource === ledger.sourcePath && destination === ledger.destRoot;
  const retryDisabled = !currentSessionMatches || summary.actionableCount === 0 || phase === 'importing' || phase === 'scanning';
  const compact = tone === 'panel';

  const refreshLedger = async () => {
    setLoading(true);
    try {
      setLedger(await window.electronAPI.getLatestImportLedger());
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not read import history.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshLedger();
  }, []);

  const handleRestoreSession = async () => {
    if (!ledger) return;
    dispatch({ type: 'SELECT_SOURCE', path: ledger.sourcePath });
    dispatch({ type: 'SET_DESTINATION', path: ledger.destRoot });
    setMessage('Scanning the previous source before retry.');
    await startScan(ledger.sourcePath);
  };

  const handleRetry = async () => {
    if (retryDisabled) return;
    setMessage('Retrying failed and pending files.');
    await startImport({ retryFailed: true });
    await refreshLedger();
  };

  const handleOpenDestination = () => {
    if (ledger?.destRoot) void window.electronAPI.openPath(ledger.destRoot);
  };

  const handleOpenFirstFailure = () => {
    const first = summary.orderedItems.find((item) => item.status === 'failed' || item.status === 'pending');
    const target = first?.destFullPath || first?.sourcePath || ledger?.destRoot;
    if (target) void window.electronAPI.openPath(target);
  };

  if (loading) {
    return (
      <div className="rounded border border-border bg-surface-alt px-2 py-2 text-[10px] text-text-muted">
        Loading import history...
      </div>
    );
  }

  if (!ledger) {
    return (
      <div className="rounded border border-border bg-surface-alt px-2 py-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">Import history</h3>
          <button onClick={refreshLedger} className="text-[10px] text-text-muted hover:text-text">Refresh</button>
        </div>
        <p className="mt-1 text-[10px] text-text-muted">No import ledger has been written yet.</p>
        {message && <p className="mt-1 text-[10px] text-red-400">{message}</p>}
      </div>
    );
  }

  return (
    <div className="rounded border border-border bg-surface-alt px-2 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">Import resume</h3>
          <div className="mt-0.5 truncate text-[10px] text-text-muted" title={ledger.sourcePath}>
            {formatLedgerDate(ledger.createdAt)} · {basename(ledger.sourcePath)} to {basename(ledger.destRoot)}
          </div>
        </div>
        <button onClick={refreshLedger} className="shrink-0 text-[10px] text-text-muted hover:text-text">Refresh</button>
      </div>

      <div className="mt-2 h-1 overflow-hidden rounded bg-surface-raised">
        <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${summary.completionPercent}%` }} />
      </div>

      <div className={`mt-2 grid gap-1 text-[10px] ${compact ? 'grid-cols-2' : 'grid-cols-4'}`}>
        <div className="rounded bg-surface-raised px-1.5 py-1 text-text-secondary">Imported <span className="text-emerald-400">{ledger.imported}</span></div>
        <div className="rounded bg-surface-raised px-1.5 py-1 text-text-secondary">Failed <span className="text-red-400">{ledger.failed}</span></div>
        <div className="rounded bg-surface-raised px-1.5 py-1 text-text-secondary">Pending <span className="text-orange-300">{ledger.pending}</span></div>
        <div className="rounded bg-surface-raised px-1.5 py-1 text-text-secondary">Size <span className="text-text">{formatSize(ledger.totalBytes)}</span></div>
      </div>

      {!currentSessionMatches && summary.actionableCount > 0 && (
        <p className="mt-2 text-[10px] text-yellow-500">
          Restore this source and destination, then retry failed files.
        </p>
      )}
      {summary.actionableCount === 0 && (
        <p className="mt-2 text-[10px] text-text-muted">
          Last import has no failed or pending files. Duration {formatDuration(ledger.durationMs)}.
        </p>
      )}
      {message && <p className="mt-2 text-[10px] text-text-muted">{message}</p>}

      <div className="mt-2 flex flex-wrap gap-1">
        <button
          onClick={handleRestoreSession}
          disabled={phase === 'importing' || phase === 'scanning'}
          className="rounded bg-surface-raised px-2 py-1 text-[10px] text-text-secondary hover:bg-border disabled:cursor-not-allowed disabled:opacity-50"
        >
          Restore Session
        </button>
        <button
          onClick={handleRetry}
          disabled={retryDisabled}
          className="rounded bg-surface-raised px-2 py-1 text-[10px] text-red-300 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Retry Failed
        </button>
        <button
          onClick={handleOpenDestination}
          className="rounded bg-surface-raised px-2 py-1 text-[10px] text-text-secondary hover:bg-border"
        >
          Open Destination
        </button>
        {summary.actionableCount > 0 && (
          <button
            onClick={handleOpenFirstFailure}
            className="rounded bg-surface-raised px-2 py-1 text-[10px] text-text-secondary hover:bg-border"
          >
            Open Failure
          </button>
        )}
      </div>

      {summary.orderedItems.length > 0 && (
        <div className={`mt-2 space-y-1 overflow-y-auto ${compact ? 'max-h-28' : 'max-h-44'}`}>
          {summary.orderedItems.slice(0, compact ? 8 : 14).map((item) => (
            <div key={`${item.sourcePath}-${item.destRelPath ?? item.name}`} className="grid grid-cols-[4.25rem_1fr] gap-2 text-[10px]">
              <span className={STATUS_CLASS[item.status]}>{STATUS_LABELS[item.status]}</span>
              <span className="truncate text-text-muted" title={`${item.sourcePath}${item.error ? `: ${item.error}` : ''}`}>
                {item.name}{item.error ? ` · ${item.error}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
