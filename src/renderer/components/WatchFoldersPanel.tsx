import { useEffect, useMemo, useState } from 'react';
import { useAppDispatch, useAppState } from '../context/ImportContext';
import { useFileScanner } from '../hooks/useFileScanner';
import type { SourceProfile, WatchFolder } from '../../shared/types';

const SOURCE_PROFILE_OPTIONS: Array<{ value: SourceProfile; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'ssd', label: 'SSD' },
  { value: 'usb', label: 'USB' },
  { value: 'nas', label: 'NAS' },
];

function folderLabel(folder: WatchFolder): string {
  return folder.label?.trim() || folder.path.split(/[/\\]/).filter(Boolean).pop() || folder.path;
}

function withDestination(folder: WatchFolder, destination: string): WatchFolder {
  return { ...folder, destination, destRoot: destination, updatedAt: new Date().toISOString() };
}

export function WatchFoldersPanel() {
  const { destination, autoImportDestRoot, sourceProfile } = useAppState();
  const dispatch = useAppDispatch();
  const { startScan } = useFileScanner();
  const [folders, setFolders] = useState<WatchFolder[]>([]);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    window.electronAPI.getWatchFolders()
      .then((saved) => {
        if (!cancelled) setFolders(saved);
      })
      .catch(() => {
        if (!cancelled) setFeedback('Could not read watch folders.');
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => { cancelled = true; };
  }, []);

  const enabledCount = useMemo(() => folders.filter((folder) => folder.enabled).length, [folders]);
  const autoImportCount = useMemo(() => folders.filter((folder) => folder.enabled && folder.autoImport).length, [folders]);

  const saveFolders = async (next: WatchFolder[]) => {
    setFolders(next);
    setFeedback(null);
    try {
      const saved = await window.electronAPI.setWatchFolders(next);
      setFolders(saved);
    } catch {
      setFeedback('Could not save watch folders.');
    }
  };

  const addFolder = async () => {
    const path = await window.electronAPI.selectFolder('Choose Watch Folder');
    if (!path) return;
    const now = new Date().toISOString();
    const fallbackDest = destination || autoImportDestRoot || '';
    const next: WatchFolder = {
      id: `watch-${Date.now().toString(36)}`,
      label: path.split(/[/\\]/).filter(Boolean).pop() || path,
      path,
      enabled: true,
      destination: fallbackDest,
      destRoot: fallbackDest,
      sourceProfile: sourceProfile ?? 'auto',
      autoScan: true,
      autoImport: false,
      createdAt: now,
      updatedAt: now,
    };
    await saveFolders([...folders.filter((folder) => folder.path.toLocaleLowerCase() !== path.toLocaleLowerCase()), next]);
  };

  const patchFolder = (id: string, patch: Partial<WatchFolder>) => {
    const next = folders.map((folder) =>
      folder.id === id
        ? { ...folder, ...patch, updatedAt: new Date().toISOString() }
        : folder,
    );
    void saveFolders(next);
  };

  const chooseDestination = async (folder: WatchFolder) => {
    const selected = await window.electronAPI.selectFolder('Choose Watch Folder Destination');
    if (!selected) return;
    void saveFolders(folders.map((item) => item.id === folder.id ? withDestination(item, selected) : item));
  };

  const removeFolder = (id: string) => {
    void saveFolders(folders.filter((folder) => folder.id !== id));
  };

  const scanNow = (folder: WatchFolder) => {
    const dest = folder.destination ?? folder.destRoot ?? '';
    dispatch({ type: 'SET_SOURCE_KIND', kind: 'volume' });
    dispatch({ type: 'SELECT_SOURCE', path: folder.path });
    if (dest) dispatch({ type: 'SET_DESTINATION', path: dest });
    void startScan(folder.path);
  };

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <h3 className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Watch Folders</h3>
          <p className="text-[10px] text-text-muted">
            {enabledCount} enabled · {autoImportCount} auto-import
          </p>
        </div>
        <button
          type="button"
          onClick={addFolder}
          disabled={busy}
          className="rounded border border-surface-border bg-surface-raised px-2 py-1 text-[10px] text-text-secondary transition-colors hover:border-text-secondary hover:text-text disabled:opacity-50"
        >
          Add
        </button>
      </div>

      {folders.length === 0 ? (
        <div className="rounded border border-border bg-surface-alt px-3 py-2 text-[11px] text-text-muted">
          No watch folders saved.
        </div>
      ) : (
        <div className="space-y-2">
          {folders.map((folder) => {
            const dest = folder.destination ?? folder.destRoot ?? '';
            return (
              <div key={folder.id} className="rounded border border-border bg-surface-alt px-3 py-2">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <label className="min-w-0 flex flex-1 items-start gap-2">
                    <input
                      type="checkbox"
                      checked={folder.enabled}
                      onChange={(e) => patchFolder(folder.id, { enabled: e.target.checked })}
                      className="mt-0.5"
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium text-text" title={folder.path}>{folderLabel(folder)}</span>
                      <span className="block truncate text-[10px] text-text-muted" title={folder.path}>{folder.path}</span>
                    </span>
                  </label>
                  <button
                    type="button"
                    onClick={() => removeFolder(folder.id)}
                    className="shrink-0 text-[10px] text-text-muted transition-colors hover:text-text"
                  >
                    remove
                  </button>
                </div>

                <div className="grid grid-cols-[1fr_6rem] gap-1.5">
                  <button
                    type="button"
                    onClick={() => chooseDestination(folder)}
                    className="min-w-0 rounded bg-surface-raised px-2 py-1 text-left text-[10px] text-text-secondary transition-colors hover:bg-border"
                    title={dest || 'Choose destination'}
                  >
                    <span className="block truncate">{dest || 'Choose destination...'}</span>
                  </button>
                  <select
                    value={folder.sourceProfile ?? 'auto'}
                    onChange={(e) => patchFolder(folder.id, { sourceProfile: e.target.value as SourceProfile })}
                    className="rounded border border-border bg-surface-raised px-2 py-1 text-[10px] text-text focus:border-text focus:outline-none"
                  >
                    {SOURCE_PROFILE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-1.5 text-[10px] text-text-secondary">
                    <input
                      type="checkbox"
                      checked={folder.autoScan}
                      onChange={(e) => patchFolder(folder.id, { autoScan: e.target.checked })}
                    />
                    Auto-scan
                  </label>
                  <label className="flex items-center gap-1.5 text-[10px] text-text-secondary">
                    <input
                      type="checkbox"
                      checked={folder.autoImport}
                      onChange={(e) => patchFolder(folder.id, { autoImport: e.target.checked })}
                    />
                    Auto-import
                  </label>
                  <button
                    type="button"
                    onClick={() => scanNow(folder)}
                    disabled={!folder.enabled}
                    className="ml-auto rounded border border-surface-border bg-surface-raised px-2 py-0.5 text-[10px] text-text-secondary transition-colors hover:border-text-secondary hover:text-text disabled:opacity-40"
                  >
                    Scan now
                  </button>
                </div>
                {folder.autoImport && !dest && (
                  <p className="mt-1 text-[10px] text-yellow-400">Choose a destination before auto-import can run.</p>
                )}
                {folder.lastTriggeredAt && (
                  <p className="mt-1 text-[10px] text-text-muted">Last change {new Date(folder.lastTriggeredAt).toLocaleString()}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {feedback && <p className="mt-1 text-[10px] text-yellow-400">{feedback}</p>}
    </section>
  );
}
