import { useEffect, useRef } from 'react';
import { ImportProvider, useAppDispatch, useAppState } from './context/ImportContext';
import { useVolumes } from './hooks/useVolumes';
import { useSettings } from './hooks/useSettings';
import { useScanListeners } from './hooks/useScanListeners';
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
  } = useAppState();
  const lastAutoImportDestRef = useRef<string>('');

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
