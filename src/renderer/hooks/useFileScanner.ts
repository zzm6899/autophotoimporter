import { useCallback } from 'react';
import { useAppState, useAppDispatch } from '../context/ImportContext';
import { FOLDER_PRESETS } from '../../shared/types';

function createScanId(sourcePath: string): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${sourcePath.length}`;
}

export function useFileScanner() {
  const { selectedSource, folderPreset, customPattern, activeScanId } = useAppState();
  const dispatch = useAppDispatch();

  const startScan = useCallback(async (sourcePath?: string) => {
    const target = sourcePath || selectedSource;
    if (!target) return;

    const pattern = folderPreset === 'custom'
      ? customPattern
      : FOLDER_PRESETS[folderPreset]?.pattern;

    const scanId = createScanId(target);
    await window.electronAPI.cancelScan();
    dispatch({ type: 'SCAN_START', scanId, sourcePath: target });
    try {
      await window.electronAPI.scanFiles(target, pattern, scanId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Scan failed';
      dispatch({ type: 'SCAN_ERROR', message });
    }
  }, [selectedSource, folderPreset, customPattern, dispatch]);

  const cancelScan = useCallback(async () => {
    await window.electronAPI.cancelScan();
    // SCAN_CANCEL invalidates the main-process generation, so no completion
    // event is emitted for the cancelled scan. Complete it locally and keep
    // any files already discovered available for review.
    dispatch({ type: 'SCAN_COMPLETE', scanId: activeScanId ?? undefined });
  }, [activeScanId, dispatch]);

  const pauseScan = useCallback(async () => {
    await window.electronAPI.pauseScan();
    dispatch({ type: 'SCAN_PAUSE' });
  }, [dispatch]);

  const resumeScan = useCallback(async () => {
    await window.electronAPI.resumeScan();
    dispatch({ type: 'SCAN_RESUME' });
  }, [dispatch]);

  return { startScan, cancelScan, pauseScan, resumeScan };
}
