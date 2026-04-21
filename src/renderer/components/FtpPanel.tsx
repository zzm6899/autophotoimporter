import { useEffect } from 'react';
import { useAppState, useAppDispatch } from '../context/ImportContext';
import { useFileScanner } from '../hooks/useFileScanner';
import { formatSize } from '../utils/formatters';

export function FtpPanel() {
  const { ftpConfig, ftpStatus, ftpMessage, ftpProgress } = useAppState();
  const dispatch = useAppDispatch();
  const { startScan } = useFileScanner();

  useEffect(() => {
    const unsub = window.electronAPI.onFtpMirrorProgress((p) => {
      dispatch({ type: 'SET_FTP_PROGRESS', progress: p });
    });
    return () => { unsub(); };
  }, [dispatch]);

  const setField = (field: keyof typeof ftpConfig, value: string | number | boolean) => {
    dispatch({ type: 'SET_FTP_CONFIG', config: { [field]: value } as Partial<typeof ftpConfig> });
  };

  const testConnection = async () => {
    dispatch({ type: 'SET_FTP_STATUS', status: 'probing', message: 'Contacting server...' });
    const result = await window.electronAPI.probeFtp(ftpConfig);
    if (result.ok) {
      dispatch({
        type: 'SET_FTP_STATUS',
        status: 'idle',
        message: `Found ${result.fileCount ?? 0} files (${formatSize(result.totalBytes ?? 0)})`,
      });
    } else {
      dispatch({ type: 'SET_FTP_STATUS', status: 'error', message: result.error ?? 'Connection failed' });
    }
  };

  const startMirror = async () => {
    dispatch({ type: 'SET_FTP_STATUS', status: 'mirroring', message: 'Mirroring files...' });
    dispatch({ type: 'SET_FTP_PROGRESS', progress: { done: 0, total: 0, name: '' } });
    const result = await window.electronAPI.mirrorFtp(ftpConfig);
    dispatch({ type: 'SET_FTP_PROGRESS', progress: null });
    if (result.ok && result.stagingDir) {
      dispatch({ type: 'SET_FTP_STATUS', status: 'idle', message: `Mirrored to ${result.stagingDir}` });
      dispatch({ type: 'SELECT_SOURCE', path: result.stagingDir });
      startScan(result.stagingDir);
    } else {
      dispatch({ type: 'SET_FTP_STATUS', status: 'error', message: result.error ?? 'Mirror failed' });
    }
  };

  const cancelMirror = async () => {
    await window.electronAPI.cancelFtpMirror();
    dispatch({ type: 'SET_FTP_STATUS', status: 'idle', message: 'Cancelled' });
    dispatch({ type: 'SET_FTP_PROGRESS', progress: null });
  };

  const mirroring = ftpStatus === 'mirroring';
  const probing = ftpStatus === 'probing';

  return (
    <div className="px-2.5 py-2 space-y-1.5">
      <h3 className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">FTP Source</h3>
      <div className="space-y-1 text-[11px]">
        <label className="block">
          <span className="text-[10px] text-text-muted">Host</span>
          <input
            type="text"
            value={ftpConfig.host}
            onChange={(e) => setField('host', e.target.value)}
            placeholder="192.168.0.10"
            className="w-full px-1.5 py-1 bg-surface border border-border rounded text-[11px] text-text focus:outline-none focus:border-blue-500"
          />
        </label>
        <div className="flex gap-1">
          <label className="flex-1">
            <span className="text-[10px] text-text-muted">Port</span>
            <input
              type="number"
              value={ftpConfig.port}
              onChange={(e) => setField('port', Number(e.target.value) || 21)}
              className="w-full px-1.5 py-1 bg-surface border border-border rounded text-[11px] text-text focus:outline-none focus:border-blue-500"
            />
          </label>
          <label className="flex items-center gap-1 text-[10px] text-text-muted mt-3">
            <input
              type="checkbox"
              checked={ftpConfig.secure}
              onChange={(e) => setField('secure', e.target.checked)}
            />
            FTPS
          </label>
        </div>
        <label className="block">
          <span className="text-[10px] text-text-muted">User</span>
          <input
            type="text"
            value={ftpConfig.user}
            onChange={(e) => setField('user', e.target.value)}
            autoComplete="off"
            className="w-full px-1.5 py-1 bg-surface border border-border rounded text-[11px] text-text focus:outline-none focus:border-blue-500"
          />
        </label>
        <label className="block">
          <span className="text-[10px] text-text-muted">Password</span>
          <input
            type="password"
            value={ftpConfig.password}
            onChange={(e) => setField('password', e.target.value)}
            autoComplete="off"
            className="w-full px-1.5 py-1 bg-surface border border-border rounded text-[11px] text-text focus:outline-none focus:border-blue-500"
          />
        </label>
        <label className="block">
          <span className="text-[10px] text-text-muted">Remote path</span>
          <input
            type="text"
            value={ftpConfig.remotePath}
            onChange={(e) => setField('remotePath', e.target.value)}
            placeholder="/DCIM"
            className="w-full px-1.5 py-1 bg-surface border border-border rounded text-[11px] text-text focus:outline-none focus:border-blue-500"
          />
        </label>
      </div>

      <div className="flex gap-1 pt-1">
        <button
          onClick={testConnection}
          disabled={probing || mirroring || !ftpConfig.host}
          className="flex-1 px-2 py-1 text-[11px] bg-surface-raised hover:bg-border rounded text-text disabled:opacity-40"
        >
          {probing ? 'Testing...' : 'Test'}
        </button>
        {mirroring ? (
          <button
            onClick={cancelMirror}
            className="flex-1 px-2 py-1 text-[11px] bg-red-500/20 hover:bg-red-500/30 rounded text-red-400"
          >
            Cancel
          </button>
        ) : (
          <button
            onClick={startMirror}
            disabled={probing || !ftpConfig.host}
            className="flex-1 px-2 py-1 text-[11px] bg-blue-500/20 hover:bg-blue-500/30 rounded text-blue-400 disabled:opacity-40"
          >
            Mirror &amp; Scan
          </button>
        )}
      </div>

      {ftpProgress && ftpProgress.total > 0 && (
        <div className="pt-1">
          <div className="h-1 bg-surface-raised rounded overflow-hidden">
            <div
              className="h-full bg-blue-500 transition-all"
              style={{ width: `${(ftpProgress.done / ftpProgress.total) * 100}%` }}
            />
          </div>
          <div className="text-[10px] text-text-muted mt-0.5 flex justify-between">
            <span className="truncate">{ftpProgress.name}</span>
            <span className="font-mono shrink-0 ml-1">
              {ftpProgress.done}/{ftpProgress.total}
            </span>
          </div>
        </div>
      )}

      {ftpMessage && !ftpProgress && (
        <div
          className={`text-[10px] pt-1 ${
            ftpStatus === 'error' ? 'text-red-400' : 'text-text-muted'
          }`}
        >
          {ftpMessage}
        </div>
      )}
    </div>
  );
}
