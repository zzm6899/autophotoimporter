import { useEffect } from 'react';
import { ImportProvider, useAppDispatch } from './context/ImportContext';
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

function AppInner() {
  useVolumes();
  useSettings();
  useScanListeners();
  const dispatch = useAppDispatch();

  // Listen for auto-import events from the main process. When the user has
  // opted in and plugs in a card, the main process kicks off the import and
  // emits AUTO_IMPORT_STARTED. We flip the UI into importing mode so the
  // progress overlay shows up without the user lifting a finger.
  useEffect(() => {
    const unsubStart = window.electronAPI.onAutoImportStarted((info) => {
      dispatch({ type: 'SELECT_SOURCE', path: info.volumePath });
      dispatch({ type: 'SET_DESTINATION', path: info.destRoot });
      dispatch({ type: 'IMPORT_START' });
    });
    return () => { unsubStart(); };
  }, [dispatch]);

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
