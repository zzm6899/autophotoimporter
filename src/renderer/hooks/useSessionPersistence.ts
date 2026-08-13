import { useEffect, useRef } from 'react';
import type { AppSession, MediaFile } from '../../shared/types';
import { useAppState, useMergedFiles } from '../context/ImportContext';

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

export function useSessionPersistence() {
  const {
    selectedSource,
    destination,
    selectedPaths,
    queuedPaths,
    filter,
    focusedIndex,
    focusedPath,
    phase,
    importResult,
  } = useAppState();
  // Persist the batched AI overlay as well as reducer-owned metadata. On very
  // large reviews the provider flushes at a bounded interval, so a crash loses
  // at most that interval of canvas evidence; native inference remains cached.
  const files = useMergedFiles();
  const sessionIdRef = useRef('');
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
    if (sessionSaveTimerRef.current !== null) {
      window.clearTimeout(sessionSaveTimerRef.current);
      sessionSaveTimerRef.current = null;
    }
    if (!selectedSource || files.length === 0 || phase === 'scanning') return;
    if (sessionSourceRef.current !== selectedSource || !sessionIdRef.current) {
      sessionSourceRef.current = selectedSource;
      sessionIdRef.current = sourceSessionId(selectedSource);
    }
    const delay = files.length >= 250_000 ? 15_000 : files.length >= 50_000 ? 6_000 : files.length >= 2500 ? 2600 : files.length >= 800 ? 1800 : 1200;
    sessionSaveTimerRef.current = window.setTimeout(() => {
      sessionSaveTimerRef.current = null;
      const snapshot = sessionSnapshotRef.current;
      if (!snapshot.selectedSource || snapshot.files.length === 0 || snapshot.phase === 'scanning') return;
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
}
