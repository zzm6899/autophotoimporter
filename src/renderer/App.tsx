import { useEffect, useRef } from 'react';
import { ImportProvider, useAppDispatch, useAppState, type AppPhase } from './context/ImportContext';
import { useVolumes } from './hooks/useVolumes';
import { useSettings } from './hooks/useSettings';
import { useScanListeners } from './hooks/useScanListeners';
import { useFileScanner } from './hooks/useFileScanner';
import { useImport } from './hooks/useImport';
import { Layout } from './components/Layout';
import { SourcePanel } from './components/SourcePanel';
import { ThumbnailGrid } from './components/ThumbnailGrid';
import { DestinationPanel } from './components/DestinationPanel';
import { ImportProgress } from './components/ImportProgress';
import { ImportSummary } from './components/ImportSummary';
import { UpdateBanner } from './components/UpdateBanner';
import { AutoImportPrompt } from './components/AutoImportPrompt';
import { HelpBar } from './components/HelpBar';
import { TutorialOverlay } from './components/TutorialOverlay';
import { LicenseOverlay } from './components/LicenseOverlay';
import { LicenseBanner } from './components/LicenseBanner';
import { playCompletionSound } from './utils/completionSound';

function AppInner() {
  useVolumes();
  useSettings();
  useScanListeners();
  const dispatch = useAppDispatch();
  const {
    playSoundOnComplete,
    completeSoundPath,
    openFolderOnComplete,
    autoImportDestRoot,
    phase,
    volumeImportQueue,
  } = useAppState();
  const { startScan } = useFileScanner();
  const { startImport } = useImport();
  const lastAutoImportDestRef = useRef<string>('');

  // Stable refs so queue-orchestration effect doesn't go stale
  const volumeImportQueueRef = useRef(volumeImportQueue);
  volumeImportQueueRef.current = volumeImportQueue;
  const startImportRef = useRef(startImport);
  startImportRef.current = startImport;
  const startScanRef = useRef(startScan);
  startScanRef.current = startScan;
  const prevPhaseRef = useRef<AppPhase>('idle');

  useEffect(() => {
    const unsub = window.electronAPI.onImportProgress((progress) => {
      dispatch({ type: 'IMPORT_PROGRESS', progress });
    });
    return () => { unsub(); };
  }, [dispatch]);

  // Multi-SD sequential import orchestration
  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = phase;
    const queue = volumeImportQueueRef.current;
    if (queue.length === 0) return;

    if (phase === 'ready' && prev !== 'ready') {
      // Scan finished — auto-start import for this card
      void startImportRef.current();
    } else if (phase === 'complete' && prev === 'importing') {
      if (queue.length > 1) {
        // More cards to import — advance and start next scan
        dispatch({ type: 'ADVANCE_VOLUME_IMPORT_QUEUE' });
        void startScanRef.current(queue[1]);
      } else {
        // Last card done — clear queue so ImportSummary stays visible
        dispatch({ type: 'SET_VOLUME_IMPORT_QUEUE', paths: [] });
      }
    }
  }, [phase, dispatch]);

  // Listen for auto-import events from the main process. When the user has
  // opted in and plugs in a card, the main process kicks off the import and
  // emits AUTO_IMPORT_STARTED. We flip the UI into importing mode so the
  // progress overlay shows up without the user lifting a finger.
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

  return (
    <>
      <LicenseBanner />
      <Layout
        left={<SourcePanel />}
        center={<ThumbnailGrid />}
        right={<DestinationPanel />}
      />
      <ImportProgress />
      <ImportSummary />
      <UpdateBanner />
      <AutoImportPrompt />
      <HelpBar />
      <TutorialOverlay />
      <LicenseOverlay />
    </>
  );
}

export function App() {
  return (
    <ImportProvider>
      <AppInner />
    </ImportProvider>
  );
}
