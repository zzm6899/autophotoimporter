import { useEffect, useRef } from 'react';
import { ImportProvider, useAppDispatch, useAppState, type AppPhase } from './context/ImportContext';
import type { AppSession, MediaFile } from '../shared/types';
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
import { SettingsOptimizationPrompt } from './components/SettingsOptimizationPrompt';
import { HelpBar } from './components/HelpBar';
import { TutorialOverlay } from './components/TutorialOverlay';
import { LicenseOverlay } from './components/LicenseOverlay';
import { LicenseBanner } from './components/LicenseBanner';
import { CommandPalette } from './components/CommandPalette';
import { playCompletionSound } from './utils/completionSound';
import { setPreviewConcurrency } from './utils/previewCache';

function sourceSessionId(source: string): string {
  let sum = 0;
  for (let i = 0; i < source.length; i++) sum += source.charCodeAt(i);
  return `${Date.now()}-${Math.abs(sum)}`;
}

function stripSessionFile(file: MediaFile): MediaFile {
  const { thumbnail: _thumbnail, ...metadata } = file;
  return metadata as MediaFile;
}

function buildSessionStats(files: MediaFile[], queuedCount: number): AppSession['stats'] {
  let picked = 0;
  let rejected = 0;
  let reviewed = 0;
  for (const file of files) {
    if (file.pick === 'selected') picked++;
    else if (file.pick === 'rejected') rejected++;
    if (file.pick || typeof file.reviewScore === 'number') reviewed++;
  }
  return {
    totalFiles: files.length,
    picked,
    rejected,
    queued: queuedCount,
    reviewed,
  };
}

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
    selectedSource,
    destination,
    files,
    selectedPaths,
    queuedPaths,
    filter,
    focusedIndex,
    focusedPath,
    previewConcurrency,
    importResult,
  } = useAppState();
  const { startScan } = useFileScanner();
  const { startImport } = useImport();
  const lastAutoImportDestRef = useRef<string>('');
  const sessionIdRef = useRef<string>('');
  const sessionSourceRef = useRef<string | null>(null);
  const sessionSaveTimerRef = useRef<number | null>(null);
  const sessionSnapshotRef = useRef({
    selectedSource,
    destination,
    files,
    selectedPaths,
    queuedPaths,
    filter,
    focusedIndex,
    focusedPath,
    phase,
    importLedgerId: importResult?.ledgerId,
  });

  // Stable refs so queue-orchestration effect doesn't go stale
  const volumeImportQueueRef = useRef(volumeImportQueue);
  volumeImportQueueRef.current = volumeImportQueue;
  const startImportRef = useRef(startImport);
  startImportRef.current = startImport;
  const startScanRef = useRef(startScan);
  startScanRef.current = startScan;
  const prevPhaseRef = useRef<AppPhase>('idle');

  sessionSnapshotRef.current = {
    selectedSource,
    destination,
    files,
    selectedPaths,
    queuedPaths,
    filter,
    focusedIndex,
    focusedPath,
    phase,
    importLedgerId: importResult?.ledgerId,
  };

  useEffect(() => {
    const unsub = window.electronAPI.onImportProgress((progress) => {
      dispatch({ type: 'IMPORT_PROGRESS', progress });
    });
    return () => { unsub(); };
  }, [dispatch]);

  useEffect(() => {
    setPreviewConcurrency(previewConcurrency);
  }, [previewConcurrency]);

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

  useEffect(() => {
    if (sessionSaveTimerRef.current !== null) {
      window.clearTimeout(sessionSaveTimerRef.current);
      sessionSaveTimerRef.current = null;
    }
    if (!selectedSource || files.length === 0 || phase === 'scanning' || phase === 'importing') return;
    if (sessionSourceRef.current !== selectedSource || !sessionIdRef.current) {
      sessionSourceRef.current = selectedSource;
      sessionIdRef.current = sourceSessionId(selectedSource);
    }
    const delay = files.length >= 2500 ? 2600 : files.length >= 800 ? 1800 : 1200;
    sessionSaveTimerRef.current = window.setTimeout(() => {
      sessionSaveTimerRef.current = null;
      const snapshot = sessionSnapshotRef.current;
      if (!snapshot.selectedSource || snapshot.files.length === 0 || snapshot.phase === 'scanning' || snapshot.phase === 'importing') return;
      const sessionFocusedPath = snapshot.focusedPath ?? (
        snapshot.focusedIndex >= 0 ? snapshot.files[snapshot.focusedIndex]?.path : undefined
      );
      const session: AppSession = {
        id: sessionIdRef.current || sourceSessionId(snapshot.selectedSource),
        updatedAt: new Date().toISOString(),
        sourcePath: snapshot.selectedSource,
        destRoot: snapshot.destination,
        files: snapshot.files.map(stripSessionFile),
        selectedPaths: snapshot.selectedPaths,
        queuedPaths: snapshot.queuedPaths,
        filter: snapshot.filter,
        focusedPath: sessionFocusedPath,
        importLedgerId: snapshot.importLedgerId,
        stats: buildSessionStats(snapshot.files, snapshot.queuedPaths.length),
      };
      void window.electronAPI.saveSession(session).catch(() => undefined);
    }, delay);
    return () => {
      if (sessionSaveTimerRef.current !== null) {
        window.clearTimeout(sessionSaveTimerRef.current);
        sessionSaveTimerRef.current = null;
      }
    };
  }, [selectedSource, destination, files, selectedPaths, queuedPaths, filter, focusedIndex, focusedPath, phase, importResult?.ledgerId]);

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
