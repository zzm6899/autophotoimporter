import { useEffect, useMemo, useState } from 'react';
import type { ImportHealthSummary } from '../../shared/types';
import { formatDuration, formatSize } from '../utils/formatters';

type HealthTone = 'neutral' | 'good' | 'warn' | 'bad';

function pathName(filePath: string): string {
  return filePath.split(/[/\\]/).filter(Boolean).pop() || filePath;
}

function formatDateTime(value?: string): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function toneClass(tone: HealthTone): string {
  if (tone === 'good') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
  if (tone === 'warn') return 'border-yellow-500/30 bg-yellow-500/10 text-yellow-300';
  if (tone === 'bad') return 'border-red-500/30 bg-red-500/10 text-red-300';
  return 'border-border bg-surface-alt text-text-secondary';
}

function statusTone(status: string): HealthTone {
  if (['healthy', 'verified', 'ok', 'success', 'ready'].includes(status)) return 'good';
  if (['attention', 'partial', 'missing', 'unavailable', 'needs-destination', 'running'].includes(status)) return 'warn';
  if (['failed', 'error'].includes(status)) return 'bad';
  return 'neutral';
}

export function getImportHealthIssueCount(summary: ImportHealthSummary): number {
  return summary.lastImport.failed
    + summary.lastImport.pending
    + summary.backup.failed
    + summary.watchFolders.missing
    + summary.watchFolders.needsDestination
    + (summary.ftp.status === 'error' ? 1 : 0)
    + (summary.checksum.status === 'partial' || summary.checksum.status === 'missing' ? 1 : 0);
}

export function getImportHealthHeadline(summary: ImportHealthSummary): string {
  if (summary.lastImport.state === 'none') return 'No import ledger yet';
  if (summary.lastImport.state === 'failed') return 'Last import failed';
  if (summary.lastImport.state === 'attention') return 'Last import needs follow-up';
  const issues = getImportHealthIssueCount(summary);
  return issues > 0 ? `${issues} health ${issues === 1 ? 'note' : 'notes'}` : 'Last import is healthy';
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className={`rounded border px-2 py-0.5 text-[10px] font-medium ${toneClass(statusTone(status))}`}>
      {status.replace(/-/g, ' ')}
    </span>
  );
}

function Metric({ label, value, tone = 'neutral' }: { label: string; value: string | number; tone?: HealthTone }) {
  return (
    <div className={`rounded border px-2 py-1.5 ${toneClass(tone)}`}>
      <p className="text-[9px] uppercase tracking-wider opacity-80">{label}</p>
      <p className="mt-0.5 truncate text-sm font-medium text-current" title={String(value)}>{value}</p>
    </div>
  );
}

export function ImportHealthDashboard() {
  const [summary, setSummary] = useState<ImportHealthSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await window.electronAPI.getImportHealthSummary();
      setSummary(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load import health.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    window.electronAPI.getImportHealthSummary()
      .then((next) => {
        if (!cancelled) setSummary(next);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load import health.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const retryablePreview = useMemo(() => summary?.retryableItems.slice(0, 8) ?? [], [summary]);
  const headline = summary ? getImportHealthHeadline(summary) : 'Loading import health';
  const issueCount = summary ? getImportHealthIssueCount(summary) : 0;

  const copyRetryList = () => {
    if (!summary) return;
    const lines = summary.retryableItems.map((item) => `${item.sourcePath}: ${item.error ?? item.status}`);
    void navigator.clipboard.writeText(lines.join('\n')).catch(() => undefined);
  };

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <h3 className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Import Health Dashboard</h3>
          <p className="text-[10px] text-text-muted">{summary ? `Updated ${formatDateTime(summary.generatedAt)}` : 'Reading local import state'}</p>
        </div>
        <button
          type="button"
          onClick={() => { void refresh(); }}
          disabled={loading}
          className="rounded border border-surface-border bg-surface-raised px-2 py-1 text-[10px] text-text-secondary transition-colors hover:border-text-secondary hover:text-text disabled:opacity-50"
        >
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="mb-2 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">
          {error}
        </div>
      )}

      {!summary ? (
        <div className="rounded border border-border bg-surface-alt px-3 py-2 text-[11px] text-text-muted">
          {loading ? 'Loading health summary...' : 'No health summary available.'}
        </div>
      ) : (
        <div className="space-y-3">
          <div className={`rounded border px-3 py-2 ${toneClass(statusTone(summary.lastImport.state))}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-current">{headline}</p>
                <p className="mt-0.5 text-[10px] text-current/80">
                  {summary.lastImport.createdAt ? formatDateTime(summary.lastImport.createdAt) : 'No completed import has been recorded.'}
                </p>
              </div>
              <StatusPill status={summary.lastImport.state} />
            </div>
            {summary.lastImport.destRoot && (
              <button
                type="button"
                onClick={() => { void window.electronAPI.openPath(summary.lastImport.destRoot ?? ''); }}
                className="mt-2 max-w-full truncate rounded bg-surface-raised px-2 py-1 text-left text-[10px] text-text-secondary transition-colors hover:bg-border hover:text-text"
                title={summary.lastImport.destRoot}
              >
                {summary.lastImport.destRoot}
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Metric label="Imported" value={summary.lastImport.imported} tone={summary.lastImport.imported > 0 ? 'good' : 'neutral'} />
            <Metric label="Retryable" value={summary.retryableItems.length} tone={summary.retryableItems.length > 0 ? 'warn' : 'good'} />
            <Metric label="Skipped" value={summary.lastImport.skipped} />
            <Metric label="Size" value={formatSize(summary.lastImport.totalBytes)} />
            <Metric label="Duration" value={formatDuration(summary.lastImport.durationMs)} />
            <Metric label="Health notes" value={issueCount} tone={issueCount > 0 ? 'warn' : 'good'} />
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="rounded border border-border bg-surface-alt px-3 py-2">
              <div className="mb-1 flex items-center justify-between gap-2">
                <h4 className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">Checksum</h4>
                <StatusPill status={summary.checksum.status} />
              </div>
              <p className="text-[11px] text-text-secondary">
                {summary.checksum.enabled
                  ? `${summary.checksum.verified}/${summary.checksum.expected} verified`
                  : 'Verification disabled'}
              </p>
            </div>

            <div className="rounded border border-border bg-surface-alt px-3 py-2">
              <div className="mb-1 flex items-center justify-between gap-2">
                <h4 className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">Backup</h4>
                <StatusPill status={summary.backup.status} />
              </div>
              <p className="text-[11px] text-text-secondary">
                {summary.backup.enabled
                  ? `${summary.backup.copied}/${summary.backup.totalTargets} backup targets`
                  : 'Backup disabled'}
              </p>
              {summary.backup.targetRoot && (
                <p className="mt-0.5 truncate text-[10px] text-text-muted" title={summary.backup.targetRoot}>{summary.backup.targetRoot}</p>
              )}
            </div>

            <div className="rounded border border-border bg-surface-alt px-3 py-2">
              <div className="mb-1 flex items-center justify-between gap-2">
                <h4 className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">FTP</h4>
                <StatusPill status={summary.ftp.status} />
              </div>
              <p className="text-[11px] text-text-secondary">{summary.ftp.message}</p>
              {(summary.ftp.imported != null || summary.ftp.errors != null) && (
                <p className="mt-0.5 text-[10px] text-text-muted">
                  {summary.ftp.imported ?? 0} imported, {summary.ftp.skipped ?? 0} skipped, {summary.ftp.errors ?? 0} errors
                </p>
              )}
            </div>
          </div>

          <div className="rounded border border-border bg-surface-alt px-3 py-2">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h4 className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">Retryable Files</h4>
              {summary.retryableItems.length > 0 && (
                <button
                  type="button"
                  onClick={copyRetryList}
                  className="rounded border border-surface-border bg-surface-raised px-2 py-0.5 text-[10px] text-text-secondary transition-colors hover:border-text-secondary hover:text-text"
                >
                  Copy list
                </button>
              )}
            </div>
            {summary.retryableItems.length === 0 ? (
              <p className="text-[11px] text-text-muted">No failed or pending files in the latest ledger.</p>
            ) : (
              <div className="space-y-1">
                {retryablePreview.map((item) => (
                  <div key={`${item.sourcePath}-${item.status}`} className="grid grid-cols-[1fr_auto] gap-2 text-[11px]">
                    <span className="truncate text-text-secondary" title={item.sourcePath}>{pathName(item.sourcePath)}</span>
                    <span className={item.status === 'failed' ? 'text-red-300' : 'text-yellow-300'}>{item.status}</span>
                    {item.error && <span className="col-span-2 truncate text-[10px] text-text-muted" title={item.error}>{item.error}</span>}
                  </div>
                ))}
                {summary.retryableItems.length > retryablePreview.length && (
                  <p className="text-[10px] text-text-muted">{summary.retryableItems.length - retryablePreview.length} more in the ledger.</p>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="rounded border border-border bg-surface-alt px-3 py-2">
              <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-text-secondary">Catalog</h4>
              {summary.catalog ? (
                <div className="space-y-0.5 text-[11px] text-text-secondary">
                  <div className="flex justify-between"><span>Total files</span><span className="font-mono">{summary.catalog.totalFiles}</span></div>
                  <div className="flex justify-between"><span>Imported memory</span><span className="font-mono">{summary.catalog.importedFiles}</span></div>
                  <div className="flex justify-between"><span>Duplicates</span><span className="font-mono">{summary.catalog.duplicateIdentities}</span></div>
                  <div className="flex justify-between"><span>Size</span><span className="font-mono">{formatSize(summary.catalog.totalBytes)}</span></div>
                  <p className="truncate pt-1 text-[10px] text-text-muted" title={summary.catalog.catalogPath}>{summary.catalog.storageKind}: {summary.catalog.catalogPath}</p>
                </div>
              ) : (
                <p className="text-[11px] text-text-muted">Catalog stats are not available yet.</p>
              )}
            </div>

            <div className="rounded border border-border bg-surface-alt px-3 py-2">
              <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-text-secondary">Watch Folders</h4>
              <div className="grid grid-cols-2 gap-1 text-[11px] text-text-secondary">
                <div className="flex justify-between"><span>Enabled</span><span className="font-mono">{summary.watchFolders.enabled}/{summary.watchFolders.total}</span></div>
                <div className="flex justify-between"><span>Active</span><span className="font-mono">{summary.watchFolders.active}</span></div>
                <div className="flex justify-between"><span>Auto-scan</span><span className="font-mono">{summary.watchFolders.autoScan}</span></div>
                <div className="flex justify-between"><span>Auto-import</span><span className="font-mono">{summary.watchFolders.autoImport}</span></div>
                <div className="flex justify-between"><span>Missing</span><span className="font-mono">{summary.watchFolders.missing}</span></div>
                <div className="flex justify-between"><span>No target</span><span className="font-mono">{summary.watchFolders.needsDestination}</span></div>
              </div>
              {summary.watchFolders.folders.length > 0 && (
                <div className="mt-2 max-h-28 space-y-1 overflow-y-auto">
                  {summary.watchFolders.folders.map((folder) => (
                    <div key={folder.id} className="grid grid-cols-[1fr_auto] gap-2 text-[10px]">
                      <span className="truncate text-text-secondary" title={folder.path}>{folder.label || pathName(folder.path)}</span>
                      <span className={statusTone(folder.status) === 'good' ? 'text-emerald-300' : statusTone(folder.status) === 'bad' ? 'text-red-300' : 'text-yellow-300'}>
                        {folder.status.replace(/-/g, ' ')}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {summary.watchFolders.lastTriggeredAt && (
                <p className="mt-1 text-[10px] text-text-muted">Last change {formatDateTime(summary.watchFolders.lastTriggeredAt)}</p>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
