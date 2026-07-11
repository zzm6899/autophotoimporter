import { useEffect, useRef } from 'react';
import { useAppDispatch, useAppState, type AppPhase } from '../context/ImportContext';
import { useFileScanner } from './useFileScanner';
import { useImport } from './useImport';

export function useVolumeQueueOrchestration() {
  const dispatch = useAppDispatch();
  const { phase, importRunning, volumeImportQueue } = useAppState();
  const { startScan } = useFileScanner();
  const { startImport } = useImport();
  const volumeImportQueueRef = useRef(volumeImportQueue);
  const startImportRef = useRef(startImport);
  const startScanRef = useRef(startScan);
  const prevPhaseRef = useRef<AppPhase>('idle');
  const prevImportRunningRef = useRef(false);

  volumeImportQueueRef.current = volumeImportQueue;
  startImportRef.current = startImport;
  startScanRef.current = startScan;

  useEffect(() => {
    const prev = prevPhaseRef.current;
    const wasImportRunning = prevImportRunningRef.current;
    prevPhaseRef.current = phase;
    prevImportRunningRef.current = importRunning;
    const queue = volumeImportQueueRef.current;
    if (queue.length === 0) return;

    if (phase === 'ready' && prev !== 'ready' && !importRunning) {
      void startImportRef.current();
    } else if (!importRunning && wasImportRunning && phase === 'complete') {
      if (queue.length > 1) {
        dispatch({ type: 'ADVANCE_VOLUME_IMPORT_QUEUE' });
        void startScanRef.current(queue[1]);
      } else {
        dispatch({ type: 'SET_VOLUME_IMPORT_QUEUE', paths: [] });
      }
    }
  }, [phase, importRunning, dispatch]);
}
