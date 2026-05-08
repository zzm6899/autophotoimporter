import { useEffect, useRef } from 'react';
import { useAppDispatch, useAppState } from '../context/ImportContext';
import { playCompletionSound } from '../utils/completionSound';

export function useAutoImportEvents() {
  const dispatch = useAppDispatch();
  const {
    playSoundOnComplete,
    completeSoundPath,
    openFolderOnComplete,
    autoImportDestRoot,
  } = useAppState();
  const lastAutoImportDestRef = useRef('');

  useEffect(() => {
    const unsubStart = window.electronAPI.onAutoImportStarted((info) => {
      lastAutoImportDestRef.current = info.destRoot;
      dispatch({ type: 'SELECT_SOURCE', path: info.volumePath });
      dispatch({ type: 'SET_DESTINATION', path: info.destRoot });
      dispatch({ type: 'IMPORT_START' });
    });
    const unsubComplete = window.electronAPI.onAutoImportComplete((result) => {
      dispatch({ type: 'IMPORT_COMPLETE', result });
      if (result.errors.length === 0 || result.imported > 0) {
        if (playSoundOnComplete) playCompletionSound(completeSoundPath);
        const destRoot = lastAutoImportDestRef.current || autoImportDestRoot;
        if (openFolderOnComplete && destRoot) {
          void window.electronAPI.openPath(destRoot).catch(() => undefined);
        }
      }
    });
    return () => {
      unsubStart();
      unsubComplete();
    };
  }, [dispatch, playSoundOnComplete, completeSoundPath, openFolderOnComplete, autoImportDestRoot]);
}
