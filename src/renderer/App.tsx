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
import { BulkAiPreviewProvider } from './context/BulkAiPreviewContext';
import { BulkAiDecisionPreview } from './components/BulkAiDecisionPreview';

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
    <div className="keptra-app-shell flex h-screen min-h-0 flex-col overflow-hidden bg-surface text-text">
      <LicenseBanner />
      <div className="min-h-0 flex-1">
        <Layout
          left={<SourcePanel />}
          center={<ThumbnailGrid />}
          right={<DestinationPanel />}
        />
      </div>
      <HelpBar />
      <ImportProgress />
      <ImportSummary />
      <UpdateBanner />
      <AutoImportPrompt />
      <SettingsOptimizationPrompt />
      <TutorialOverlay />
      <LicenseOverlay />
      <CommandPalette />
      <FirstRunWizard />
      <BulkAiDecisionPreview />
    </div>
  );
}

export function App() {
  return (
    <ImportProvider>
      <BulkAiPreviewProvider>
        <AppInner />
      </BulkAiPreviewProvider>
    </ImportProvider>
  );
}
