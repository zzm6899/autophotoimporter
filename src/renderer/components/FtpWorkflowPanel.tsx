import { useMemo, useState } from 'react';
import { useAppDispatch, useAppState } from '../context/ImportContext';

function statusTone(state: 'idle' | 'running' | 'success' | 'error') {
  switch (state) {
    case 'running':
      return 'border-blue-500/30 bg-blue-500/10 text-blue-200';
    case 'success':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200';
    case 'error':
      return 'border-red-500/30 bg-red-500/10 text-red-200';
    default:
      return 'border-border bg-surface-alt text-text-secondary';
  }
}

export function FtpWorkflowPanel() {
  const {
    ftpConfig,
    ftpSyncSettings,
    ftpSyncStatus,
    ftpDestEnabled,
    ftpDestConfig,
  } = useAppState();
  const dispatch = useAppDispatch();
  const [syncBusy, setSyncBusy] = useState(false);

  const runSyncNow = async () => {
    setSyncBusy(true);
    try {
      const result = await window.electronAPI.runFtpSync();
      dispatch({ type: 'SET_FTP_SYNC_STATUS', status: result.status });
    } finally {
      setSyncBusy(false);
    }
  };

  const syncReady = !!ftpConfig.host && !!ftpConfig.remotePath && !!ftpSyncSettings.localDestRoot;
  const sourceReady = !!ftpConfig.host && !!ftpConfig.remotePath;
  const syncTargetLabel = useMemo(() => {
    if (!ftpSyncSettings.localDestRoot) return 'Choose local sync destination...';
    return ftpSyncSettings.localDestRoot;
  }, [ftpSyncSettings.localDestRoot]);

  return (
    <div className="rounded border border-border bg-surface p-2 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">FTP Workflow</h3>
          <p className="mt-0.5 text-[10px] text-text-muted">Run the saved FTP automation job from here. Edit the recurring settings in Settings.</p>
        </div>
        <div className={`rounded border px-2 py-1 text-[10px] ${statusTone(ftpSyncStatus.state)}`}>
          {ftpSyncStatus.state === 'running' ? 'Running' : ftpSyncStatus.state === 'success' ? 'Ready' : ftpSyncStatus.state === 'error' ? 'Check setup' : 'Idle'}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 text-[10px]">
        <div className={`rounded px-2 py-1 ${sourceReady ? 'bg-emerald-500/10 text-emerald-300' : 'bg-surface-raised text-text-muted'}`}>
          Source FTP {sourceReady ? 'connected' : 'not set'}
        </div>
        <div className={`rounded px-2 py-1 ${ftpSyncSettings.localDestRoot ? 'bg-emerald-500/10 text-emerald-300' : 'bg-surface-raised text-text-muted'}`}>
          Local target {ftpSyncSettings.localDestRoot ? 'ready' : 'missing'}
        </div>
      </div>

      <div className="rounded border border-border bg-surface-alt px-2 py-1.5 text-[10px] text-text-muted">
        <div className="flex justify-between gap-2">
          <span>Automation</span>
          <span className={ftpSyncSettings.enabled ? 'text-emerald-300' : 'text-text-muted'}>
            {ftpSyncSettings.enabled ? 'Enabled' : 'Disabled'}
          </span>
        </div>
        <div className="mt-1 flex justify-between gap-2">
          <span>Schedule</span>
          <span>{ftpSyncSettings.runOnLaunch ? `Launch + every ${ftpSyncSettings.intervalMinutes}m` : `Every ${ftpSyncSettings.intervalMinutes}m`}</span>
        </div>
        <div className="mt-1 truncate" title={syncTargetLabel}>
          Local destination: {ftpSyncSettings.localDestRoot || 'Not set'}
        </div>
        <div className="mt-1">
          FTP output: {ftpSyncSettings.reuploadToFtpDest && ftpDestEnabled && ftpDestConfig.host ? 'Chained after import' : 'Local only'}
        </div>
      </div>

      <div className={`rounded border px-2 py-1.5 text-[10px] ${statusTone(ftpSyncStatus.state)}`}>
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-current">
            {ftpSyncStatus.stage === 'importing'
              ? 'Importing mirrored files'
              : ftpSyncStatus.stage === 'mirroring'
                ? 'Mirroring source'
                : ftpSyncStatus.stage === 'scanning'
                  ? 'Indexing mirrored files'
                  : ftpSyncStatus.stage === 'probing'
                    ? 'Checking source'
                    : 'Workflow status'}
          </span>
          {typeof ftpSyncStatus.done === 'number' && typeof ftpSyncStatus.total === 'number' && ftpSyncStatus.total > 0 && (
            <span className="font-mono">{ftpSyncStatus.done}/{ftpSyncStatus.total}</span>
          )}
        </div>
        <p className="mt-1 text-current/90">{ftpSyncStatus.message}</p>
        {ftpSyncStatus.currentFile && (
          <p className="mt-1 truncate font-mono text-current/80" title={ftpSyncStatus.currentFile}>
            {ftpSyncStatus.currentFile}
          </p>
        )}
        {(ftpSyncStatus.imported != null || ftpSyncStatus.skipped != null || ftpSyncStatus.errors != null) && (
          <div className="mt-1 flex flex-wrap gap-2 text-current/80">
            {ftpSyncStatus.imported != null && <span>Imported {ftpSyncStatus.imported}</span>}
            {ftpSyncStatus.skipped != null && <span>Skipped {ftpSyncStatus.skipped}</span>}
            {ftpSyncStatus.errors != null && <span>Errors {ftpSyncStatus.errors}</span>}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-1">
        <button
          onClick={runSyncNow}
          disabled={syncBusy || ftpSyncStatus.state === 'running' || !syncReady}
          className="px-2 py-1 text-[11px] bg-emerald-500/20 hover:bg-emerald-500/30 rounded text-emerald-200 disabled:opacity-40"
        >
          {syncBusy || ftpSyncStatus.state === 'running' ? 'Running...' : 'Run workflow now'}
        </button>
        <button
          onClick={() => dispatch({ type: 'SET_VIEW_MODE', mode: 'settings' })}
          className="px-2 py-1 text-[11px] bg-surface-raised hover:bg-border rounded text-text-secondary"
          title="Open settings to edit the recurring FTP workflow configuration."
        >
          Open settings
        </button>
      </div>
    </div>
  );
}
