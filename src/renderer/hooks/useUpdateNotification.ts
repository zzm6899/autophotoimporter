import { useEffect, useState } from 'react';
import type { UpdateReleaseSummary, UpdateState } from '../../shared/types';

const INITIAL_STATE: UpdateState = {
  status: 'idle',
  currentVersion: 'unknown',
};

export function useUpdateNotification() {
  const [updateState, setUpdateState] = useState<UpdateState>(INITIAL_STATE);
  const [dismissed, setDismissed] = useState(false);
  const [history, setHistory] = useState<UpdateReleaseSummary[]>([]);

  useEffect(() => {
    const unsub = window.electronAPI.onUpdateStatus((state) => {
      setUpdateState((prev) => ({ ...prev, ...state }));
      if (state.history) setHistory(state.history);
      if (state.status === 'available' || state.status === 'ready') setDismissed(false);
    });

    void window.electronAPI.checkForUpdates().then((state) => {
      setUpdateState(state);
      if (state.history) setHistory(state.history);
    }).catch(() => undefined);

    void window.electronAPI.fetchUpdateHistory().then((releases) => {
      setHistory(releases);
    }).catch(() => undefined);

    return () => { unsub(); };
  }, []);

  const dismiss = () => setDismissed(true);

  const checkNow = async () => {
    setDismissed(false);
    const state = await window.electronAPI.checkForUpdates();
    setUpdateState(state);
    if (state.history) setHistory(state.history);
    return state;
  };

  const downloadUpdate = async () => {
    setUpdateState((prev) => ({ ...prev, status: 'downloading', message: 'Downloading update…' }));
    const result = await window.electronAPI.downloadUpdate();
    if (!result.ok) {
      setUpdateState((prev) => ({ ...prev, status: 'error', message: result.message || 'Could not download the update.' }));
    }
    // On success the main process pushes an UPDATE_STATUS event with status
    // 'ready', which is picked up by onUpdateStatus above — no state update needed here.
    return result;
  };

  const installUpdate = async () => {
    // On packaged Windows builds this triggers quitAndInstall, so the app may
    // close before a response arrives — that is fine. On macOS / dev it opens
    // the installer file and returns synchronously.
    const result = await window.electronAPI.installUpdate();
    if (!result.ok) {
      setUpdateState((prev) => ({ ...prev, status: 'error', message: result.message || 'Could not apply the update.' }));
    }
    return result;
  };

  const openRelease = () => {
    if (updateState.releaseUrl) {
      void window.electronAPI.openReleaseUrl(updateState.releaseUrl);
    }
  };

  return {
    updateState,
    history,
    dismiss,
    checkNow,
    downloadUpdate,
    installUpdate,
    openRelease,
    visibleState: dismissed ? { ...updateState, status: 'idle' as const } : updateState,
  };
}
