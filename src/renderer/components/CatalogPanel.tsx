import { useEffect, useMemo, useState } from 'react';
import type {
  CatalogBackupResult,
  CatalogBrowserQuery,
  CatalogBrowserRecord,
  CatalogBrowserResult,
  CatalogImportedFilter,
  CatalogMaintenanceResult,
  CatalogPruneResult,
  CatalogStats,
} from '../../shared/types';
import { formatSize } from '../utils/formatters';

const PAGE_SIZE = 30;

function formatDate(value?: string): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function resultSummary(result: CatalogMaintenanceResult | CatalogPruneResult | null): string {
  if (!result) return 'No maintenance scan has run yet.';
  const removed = 'removedMediaFiles' in result
    ? ` Removed ${result.removedMediaFiles} media records and ${result.removedImportOutcomes} import outcomes.`
    : '';
  return `Checked ${result.checked} records. Missing: ${result.missingSources} sources, ${result.missingDestinations} destinations, ${result.missingBackups} backups.${removed}`;
}

function cameraLabel(record: CatalogBrowserRecord): string {
  const camera = [record.cameraMake, record.cameraModel].filter(Boolean).join(' ');
  return camera || 'Unknown camera';
}

function destinationLabel(record: CatalogBrowserRecord): string {
  return record.destFullPath ?? record.destRelPath ?? record.backupFullPath ?? 'No destination recorded';
}

export function CatalogPanel() {
  const [stats, setStats] = useState<CatalogStats | null>(null);
  const [result, setResult] = useState<CatalogBrowserResult>({ records: [], total: 0, limit: PAGE_SIZE, offset: 0 });
  const [search, setSearch] = useState('');
  const [camera, setCamera] = useState('');
  const [lens, setLens] = useState('');
  const [destination, setDestination] = useState('');
  const [visualHash, setVisualHash] = useState('');
  const [imported, setImported] = useState<CatalogImportedFilter>('any');
  const [sortBy, setSortBy] = useState<NonNullable<CatalogBrowserQuery['sortBy']>>('lastSeenAt');
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const [maintenanceResult, setMaintenanceResult] = useState<CatalogMaintenanceResult | CatalogPruneResult | null>(null);
  const [backupResult, setBackupResult] = useState<CatalogBackupResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const query = useMemo<CatalogBrowserQuery>(() => ({
    search,
    camera,
    lens,
    destinationPath: destination,
    visualHash,
    imported,
    sortBy,
    sortDirection: sortBy === 'name' ? 'asc' : 'desc',
    limit: PAGE_SIZE,
    offset,
  }), [camera, destination, imported, lens, offset, search, sortBy, visualHash]);

  const refresh = async (nextQuery = query) => {
    setLoading(true);
    setMessage(null);
    try {
      const [nextStats, nextResult] = await Promise.all([
        window.electronAPI.getCatalogStats(),
        window.electronAPI.browseCatalog(nextQuery),
      ]);
      setStats(nextStats);
      setResult(nextResult);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not load catalog.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh();
    }, 180);
    return () => window.clearTimeout(timer);
  }, [query]);

  const resetFilters = () => {
    setSearch('');
    setCamera('');
    setLens('');
    setDestination('');
    setVisualHash('');
    setImported('any');
    setOffset(0);
  };

  const verifyMissing = async () => {
    setMaintenanceBusy(true);
    setMessage(null);
    try {
      const next = await window.electronAPI.verifyCatalogMissingPaths();
      setMaintenanceResult(next);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Catalog verification failed.');
    } finally {
      setMaintenanceBusy(false);
    }
  };

  const pruneMissing = async () => {
    const confirmed = window.confirm('Remove catalog entries whose recorded local files are missing? This does not delete photos from disk.');
    if (!confirmed) return;
    setMaintenanceBusy(true);
    setMessage(null);
    try {
      const next = await window.electronAPI.pruneCatalogMissingEntries();
      setMaintenanceResult(next);
      await refresh({ ...query, offset: 0 });
      setOffset(0);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Catalog prune failed.');
    } finally {
      setMaintenanceBusy(false);
    }
  };

  const exportBackup = async () => {
    setMaintenanceBusy(true);
    setMessage(null);
    try {
      const next = await window.electronAPI.exportCatalogBackup();
      if (next) {
        setBackupResult(next);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Catalog backup failed.');
    } finally {
      setMaintenanceBusy(false);
    }
  };

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));

  return (
    <>
      <section>
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-secondary">Catalog Stats</h3>
        <div className="grid grid-cols-2 gap-1 text-[10px] text-text-muted md:grid-cols-4">
          <div className="rounded border border-border bg-surface-alt px-2 py-1">Files: <span className="text-text-secondary">{stats?.totalFiles ?? 0}</span></div>
          <div className="rounded border border-border bg-surface-alt px-2 py-1">Imported: <span className="text-text-secondary">{stats?.importedFiles ?? 0}</span></div>
          <div className="rounded border border-border bg-surface-alt px-2 py-1">Size: <span className="text-text-secondary">{formatSize(stats?.totalBytes ?? 0)}</span></div>
          <div className="rounded border border-border bg-surface-alt px-2 py-1">Store: <span className="text-text-secondary">{stats?.storageKind ?? 'loading'}</span></div>
        </div>
        {stats?.catalogPath && (
          <p className="mt-1 truncate text-[10px] text-text-muted" title={stats.catalogPath}>{stats.catalogPath}</p>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-secondary">Browse</h3>
        <div className="grid gap-2 md:grid-cols-5">
          <input value={search} onChange={(event) => { setSearch(event.target.value); setOffset(0); }} placeholder="Name, path, camera, hash" className="rounded border border-border bg-surface px-2 py-1 text-xs text-text placeholder-text-muted focus:border-text focus:outline-none md:col-span-2" />
          <input value={destination} onChange={(event) => { setDestination(event.target.value); setOffset(0); }} placeholder="Destination path" className="rounded border border-border bg-surface px-2 py-1 text-xs text-text placeholder-text-muted focus:border-text focus:outline-none" />
          <input value={camera} onChange={(event) => { setCamera(event.target.value); setOffset(0); }} placeholder="Camera" className="rounded border border-border bg-surface px-2 py-1 text-xs text-text placeholder-text-muted focus:border-text focus:outline-none" />
          <input value={lens} onChange={(event) => { setLens(event.target.value); setOffset(0); }} placeholder="Lens" className="rounded border border-border bg-surface px-2 py-1 text-xs text-text placeholder-text-muted focus:border-text focus:outline-none" />
          <input value={visualHash} onChange={(event) => { setVisualHash(event.target.value); setOffset(0); }} placeholder="Visual hash" className="rounded border border-border bg-surface px-2 py-1 text-xs text-text placeholder-text-muted focus:border-text focus:outline-none" />
          <select value={imported} onChange={(event) => { setImported(event.target.value as CatalogImportedFilter); setOffset(0); }} className="rounded border border-border bg-surface px-2 py-1 text-xs text-text focus:border-text focus:outline-none">
            <option value="any">All states</option>
            <option value="imported">Imported</option>
            <option value="not-imported">Not imported</option>
          </select>
          <select value={sortBy} onChange={(event) => setSortBy(event.target.value as NonNullable<CatalogBrowserQuery['sortBy']>)} className="rounded border border-border bg-surface px-2 py-1 text-xs text-text focus:border-text focus:outline-none">
            <option value="lastSeenAt">Last seen</option>
            <option value="lastImportedAt">Last imported</option>
            <option value="name">Name</option>
            <option value="size">Size</option>
          </select>
          <button onClick={resetFilters} className="rounded bg-surface-raised px-3 py-1 text-xs text-text-secondary hover:bg-border">Reset</button>
        </div>

        <div className="mt-3 overflow-hidden rounded border border-border">
          <div className="grid grid-cols-[minmax(160px,1.3fr)_minmax(160px,1.6fr)_110px] border-b border-border bg-surface-alt px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
            <span>Name</span>
            <span>Path</span>
            <span>Status</span>
          </div>
          {result.records.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-text-muted">{loading ? 'Loading catalog...' : 'No catalog records match these filters.'}</div>
          ) : result.records.map((record) => (
            <div key={record.id} className="grid grid-cols-[minmax(160px,1.3fr)_minmax(160px,1.6fr)_110px] gap-2 border-b border-border/60 px-2 py-2 text-[10px] last:border-b-0">
              <div className="min-w-0">
                <div className="truncate text-xs text-text" title={record.name}>{record.name}</div>
                <div className="truncate text-text-muted">{formatSize(record.size)} · {cameraLabel(record)}</div>
                <div className="truncate text-text-muted">{record.lensModel ?? 'No lens'}{record.visualHash ? ` · ${record.visualHash}` : ''}</div>
              </div>
              <div className="min-w-0 space-y-1">
                <button onClick={() => { void window.electronAPI.openPath(record.sourcePath); }} className="block max-w-full truncate text-left text-text-secondary hover:text-text" title={record.sourcePath}>{record.sourcePath}</button>
                <button onClick={() => { const target = record.destFullPath ?? record.backupFullPath; if (target) void window.electronAPI.openPath(target); }} className="block max-w-full truncate text-left text-text-muted hover:text-text-secondary" title={destinationLabel(record)}>{destinationLabel(record)}</button>
              </div>
              <div className="text-right">
                <div className={record.imported ? 'text-emerald-300' : 'text-text-muted'}>{record.imported ? 'Imported' : 'Seen'}</div>
                <div className="text-text-muted">{formatDate(record.lastImportedAt ?? record.lastSeenAt)}</div>
                {record.importStatus && <div className="text-text-muted">{record.importStatus}</div>}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-2 flex items-center gap-2 text-[10px] text-text-muted">
          <span>{result.total} matches · page {page}/{totalPages}</span>
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} className="ml-auto rounded bg-surface-raised px-2 py-1 text-text-secondary hover:bg-border disabled:opacity-40">Previous</button>
          <button disabled={offset + PAGE_SIZE >= result.total} onClick={() => setOffset(offset + PAGE_SIZE)} className="rounded bg-surface-raised px-2 py-1 text-text-secondary hover:bg-border disabled:opacity-40">Next</button>
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-secondary">Maintenance</h3>
        <div className="flex flex-wrap gap-2">
          <button onClick={verifyMissing} disabled={maintenanceBusy} className="rounded bg-surface-raised px-3 py-1 text-xs text-text-secondary hover:bg-border disabled:opacity-50">Verify paths</button>
          <button onClick={pruneMissing} disabled={maintenanceBusy} className="rounded bg-surface-raised px-3 py-1 text-xs text-text-secondary hover:bg-border disabled:opacity-50">Prune missing</button>
          <button onClick={exportBackup} disabled={maintenanceBusy} className="rounded bg-accent px-3 py-1 text-xs text-white hover:bg-accent-hover disabled:opacity-50">Export JSON backup</button>
        </div>
        <p className="mt-2 text-[10px] text-text-muted">{resultSummary(maintenanceResult)}</p>
        {maintenanceResult && maintenanceResult.missingPaths.length > 0 && (
          <div className="mt-2 max-h-36 overflow-y-auto rounded border border-border bg-surface-alt p-2 text-[10px] text-text-muted">
            {maintenanceResult.missingPaths.slice(0, 80).map((item) => (
              <div key={`${item.kind}:${item.path}`} className="truncate" title={item.path}>
                {item.kind}: <span className="font-mono text-text-secondary">{item.path}</span>
              </div>
            ))}
          </div>
        )}
        {backupResult && (
          <p className="mt-2 truncate text-[10px] text-emerald-300" title={backupResult.path}>Backup exported: {backupResult.path}</p>
        )}
        {message && <p className="mt-2 text-[10px] text-yellow-300">{message}</p>}
      </section>
    </>
  );
}
