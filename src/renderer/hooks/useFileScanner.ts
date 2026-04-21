import { useCallback } from 'react';
import { useAppState, useAppDispatch } from '../context/ImportContext';
import { FOLDER_PRESETS } from '../../shared/types';

export function useFileScanner() {
  const { selectedSource, folderPreset, customPattern } = useAppState();
  const dispatch = useAppDispatch();

  const startScan = useCallback(async (sourcePath?: string) => {
    const target = sourcePath || selectedSource;
    if (!target) return;

    const pattern = folderPreset === 'custom'
      ? customPattern
      : FOLDER_PRESETS[folderPreset]?.pattern;

    await window.electronAPI.cancelScan();
    dispatch({ type: 'SCAN_START' });
    try {
      await window.electronAPI.scanFiles(target, pattern);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Scan failed';
      dispatch({ type: 'SCAN_ERROR', message });
    }
  }, [selectedSource, folderPreset, customPattern, dispatch]);

  const cancelScan = useCallback(async () => {
    await window.electronAPI.cancelScan();
  }, []);

  return { startScan, cancelScan };
}
