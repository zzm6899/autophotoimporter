import { useEffect } from 'react';
import { ImportProvider, useAppState } from './context/ImportContext';
import { useVolumes } from './hooks/useVolumes';
import { useSettings } from './hooks/useSettings';
import { useScanListeners } from './hooks/useScanListeners';
import { useImportProgressListener } from './hooks/useImportProgressListener';
import { useAutoImportEvents } from './hooks/useAutoImportEvents';
import { useVolumeQueueOrchestration } from './hooks/useVolumeQueueOrchestration';
import { useSessionPersistence } from './hooks/useSessionPersistence';
import { Layout } from './components/Layout';
import { SourcePanel } from './components/SourcePanel';
import { ThumbnailGrid } from './components/ThumbnailGrid';
import { DestinationPanel } from './components/DestinationPanel';
import { ImportProgress } from './components/ImportProgress';
import { ImportSummary } from './components/ImportSummary';
import { UpdateBanner } from './components/UpdateBanner';
import { AutoImportPrompt } from './components/AutoImportPrompt';
import { SettingsOptimizationPrompt } from './components/SettingsOptimizationPrompt';
import { HelpBar } from './components/HelpBar';
import { TutorialOverlay } from './components/TutorialOverlay';
import { LicenseOverlay } from './components/LicenseOverlay';
import { LicenseBanner } from './components/LicenseBanner';
import { CommandPalette } from './components/CommandPalette';
import { FirstRunWizard } from './components/onboarding/FirstRunWizard';
import { setPreviewConcurrency } from './utils/previewCache';

function AppInner() {
  useVolumes();
  useSettings();
  useScanListeners();
  useImportProgressListener();
  useAutoImportEvents();
  useVolumeQueueOrchestration();
  useSessionPersistence();
  const { previewConcurrency } = useAppState();

  useEffect(() => {
    setPreviewConcurrency(previewConcurrency);
  }, [previewConcurrency]);

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
      <SettingsOptimizationPrompt />
      <HelpBar />
      <TutorialOverlay />
      <LicenseOverlay />
      <CommandPalette />
      <FirstRunWizard />
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
