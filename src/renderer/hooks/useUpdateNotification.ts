import { useEffect, useState } from 'react';
import type { UpdateState } from '../../shared/types';

const INITIAL_STATE: UpdateState = {
  status: 'idle',
  currentVersion: 'unknown',
};

export function useUpdateNotification() {
  const [updateState, setUpdateState] = useState<UpdateState>(INITIAL_STATE);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const unsub = window.electronAPI.onUpdateStatus((state) => {
      setUpdateState((prev) => ({ ...prev, ...state }));
      if (state.status === 'available' || state.status === 'ready') setDismissed(false);
    });

    void window.electronAPI.checkForUpdates().then((state) => {
      setUpdateState(state);
    }).catch(() => undefined);

    return () => { unsub(); };
  }, []);

  const dismiss = () => setDismissed(true);

  const checkNow = async () => {
    setDismissed(false);
    const state = await window.electronAPI.checkForUpdates();
    setUpdateState(state);
    return state;
  };

  const downloadUpdate = async () => {
    setUpdateState((prev) => ({ ...prev, status: 'downloading', message: 'Downloading update...' }));
    const result = await window.electronAPI.downloadUpdate();
    if (!result.ok) {
      setUpdateState((prev) => ({ ...prev, status: 'error', message: result.message || 'Could not download the update.' }));
    }
    return result;
  };

  const installUpdate = async () => {
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
    dismiss,
    checkNow,
    downloadUpdate,
    installUpdate,
    openRelease,
    visibleState: dismissed ? { ...updateState, status: 'idle' as const } : updateState,
  };
}
