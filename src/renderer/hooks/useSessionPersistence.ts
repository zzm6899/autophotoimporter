import { useEffect, useRef } from 'react';
import type { AppSession, MediaFile } from '../../shared/types';
import { createSessionDeltaEnvelope } from '../../shared/session-delta';
import { useAppState, useMergedFiles } from '../context/ImportContext';
import { acknowledgeSessionChanges, consumeRestoredSessionBaseline, snapshotSessionChanges } from '../utils/sessionChangeJournal';
import { getCataloguePathIndex } from '../utils/catalogueDelta';

function sourceSessionId(source: string): string {
  let sum = 0;
  for (let i = 0; i < source.length; i++) sum += source.charCodeAt(i);
  return `${Date.now()}-${Math.abs(sum)}`;
}

export function stripSessionFile(file: MediaFile): MediaFile {
  if (file.thumbnail === undefined) return file;
  const { thumbnail: _thumbnail, ...metadata } = file;
  return metadata as MediaFile;
}

export function buildSessionStats(files: MediaFile[], queuedCount: number): AppSession['stats'] {
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

const LARGE_SESSION_DELTA_THRESHOLD = 10_000;
export const SESSION_SAVE_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
export const SESSION_PERSISTENCE_STATUS_EVENT = 'keptra:session-persistence-status';

export type SessionPersistenceState = 'idle' | 'saving' | 'saved' | 'retrying' | 'failed';

export function sessionSaveRetryDelay(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 1) return null;
  return SESSION_SAVE_RETRY_DELAYS_MS[attempt - 1] ?? null;
}

export function sessionSaveMaxWait(fileCount: number): number {
  if (fileCount >= 250_000) return 30_000;
  if (fileCount >= 50_000) return 20_000;
  return 12_000;
}

function publishSessionPersistenceStatus(
  state: SessionPersistenceState,
  attempt = 0,
  message?: string,
): void {
  window.dispatchEvent(new CustomEvent(SESSION_PERSISTENCE_STATUS_EVENT, {
    detail: { state, attempt, message },
  }));
}

export interface DurableSessionBaseline {
  source: string;
  fileCount: number;
  destination: string | null;
  filter: string;
  focusedPath: string | null;
  importLedgerId?: string;
  selectedPaths: string[];
  queuedPaths: string[];
  savedRevision: number;
  stats: AppSession['stats'];
  statsBits: Uint8Array;
}

function sameOrderedPaths(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function fileStatsBits(file: MediaFile): number {
  return (file.pick === 'selected' ? 1 : 0)
    | (file.pick === 'rejected' ? 2 : 0)
    | (file.pick || typeof file.reviewScore === 'number' ? 4 : 0);
}

function buildSessionStatsBits(files: readonly MediaFile[]): Uint8Array {
  const bits = new Uint8Array(files.length);
  for (let index = 0; index < files.length; index++) bits[index] = fileStatsBits(files[index]);
  return bits;
}

function buildSessionStatsDelta(
  files: readonly MediaFile[],
  changedPaths: readonly string[],
  baseline: DurableSessionBaseline,
  queuedCount: number,
): { stats: AppSession['stats']; updates: Array<{ index: number; bits: number }> } {
  const indexByPath = getCataloguePathIndex(files);
  let picked = baseline.stats.picked;
  let rejected = baseline.stats.rejected;
  let reviewed = baseline.stats.reviewed;
  const updates: Array<{ index: number; bits: number }> = [];
  for (const filePath of changedPaths) {
    const index = indexByPath.get(filePath);
    if (index === undefined) continue;
    const previous = baseline.statsBits[index] ?? 0;
    const next = fileStatsBits(files[index]);
    picked += Number((next & 1) !== 0) - Number((previous & 1) !== 0);
    rejected += Number((next & 2) !== 0) - Number((previous & 2) !== 0);
    reviewed += Number((next & 4) !== 0) - Number((previous & 4) !== 0);
    updates.push({ index, bits: next });
  }
  return { stats: { totalFiles: files.length, picked, rejected, reviewed, queued: queuedCount }, updates };
}

export interface SessionBuildResult {
  session: AppSession;
  delta: boolean;
  noop: boolean;
  revision: number;
  statsBits?: Uint8Array;
  statUpdates: Array<{ index: number; bits: number }>;
}

export function buildPersistedSession(
  snapshot: {
    selectedSource: string;
    destination: string | null;
    files: MediaFile[];
    selectedPaths: string[];
    queuedPaths: string[];
    filter: string;
    focusedIndex: number;
    focusedPath: string | null;
    importLedgerId?: string;
  },
  sessionId: string,
  baseline: DurableSessionBaseline | null,
): SessionBuildResult {
  const changes = snapshotSessionChanges(baseline?.savedRevision ?? -1);
  const baselineMatchesCatalogue = !!baseline
    && baseline.source === snapshot.selectedSource
    && baseline.fileCount === snapshot.files.length;
  const useDelta = snapshot.files.length >= LARGE_SESSION_DELTA_THRESHOLD
    && baselineMatchesCatalogue
    && !changes.fullCheckpoint;
  const focusedPath = snapshot.focusedPath ?? (
    snapshot.focusedIndex >= 0 ? snapshot.files[snapshot.focusedIndex]?.path : undefined
  );
  const selectedPathsChanged = !!baseline && !sameOrderedPaths(snapshot.selectedPaths, baseline.selectedPaths);
  const queuedPathsChanged = !!baseline && !sameOrderedPaths(snapshot.queuedPaths, baseline.queuedPaths);
  const metadataChanged = !!baseline && (
    baseline.destination !== snapshot.destination
    || baseline.filter !== snapshot.filter
    || baseline.focusedPath !== (focusedPath ?? null)
    || baseline.importLedgerId !== snapshot.importLedgerId
  );
  if (useDelta && baseline && changes.paths.length === 0
    && !selectedPathsChanged && !queuedPathsChanged && !metadataChanged) {
    const noopCommon = {
      id: sessionId,
      updatedAt: new Date().toISOString(),
      sourcePath: snapshot.selectedSource,
      destRoot: snapshot.destination,
      files: [] as MediaFile[],
      selectedPaths: [] as string[],
      queuedPaths: [] as string[],
      filter: snapshot.filter,
      focusedPath,
      importLedgerId: snapshot.importLedgerId,
      stats: baseline.stats,
    };
    return {
      revision: changes.revision,
      delta: true,
      noop: true,
      statUpdates: [],
      session: createSessionDeltaEnvelope(noopCommon, {
        totalFileCount: snapshot.files.length,
        fileIndexes: [],
        removedPaths: [],
        selectedPathsChanged: false,
        queuedPathsChanged: false,
      }),
    };
  }
  const fileIndexByPath = useDelta && changes.paths.length > 0
    ? getCataloguePathIndex(snapshot.files)
    : null;
  const deltaStats = useDelta && baseline
    ? changes.paths.length > 0
      ? buildSessionStatsDelta(snapshot.files, changes.paths, baseline, snapshot.queuedPaths.length)
      : { stats: { ...baseline.stats, queued: snapshot.queuedPaths.length }, updates: [] }
    : null;
  const stats = deltaStats?.stats ?? buildSessionStats(snapshot.files, snapshot.queuedPaths.length);
  const common = {
    id: sessionId,
    updatedAt: new Date().toISOString(),
    sourcePath: snapshot.selectedSource,
    destRoot: snapshot.destination,
    selectedPaths: snapshot.selectedPaths,
    queuedPaths: snapshot.queuedPaths,
    filter: snapshot.filter,
    focusedPath,
    importLedgerId: snapshot.importLedgerId,
    stats,
  };

  if (!useDelta) {
    return {
      revision: changes.revision,
      delta: false,
      noop: false,
      statsBits: buildSessionStatsBits(snapshot.files),
      statUpdates: [],
      session: { ...common, files: snapshot.files.map(stripSessionFile) },
    };
  }

  const files: MediaFile[] = [];
  const fileIndexes: number[] = [];
  for (const filePath of changes.paths) {
    const index = fileIndexByPath?.get(filePath);
    if (index === undefined) continue;
    files.push(stripSessionFile(snapshot.files[index]));
    fileIndexes.push(index);
  }
  return {
    revision: changes.revision,
    delta: true,
    noop: false,
    statUpdates: deltaStats?.updates ?? [],
    session: createSessionDeltaEnvelope(
      {
        ...common,
        files,
        selectedPaths: selectedPathsChanged ? snapshot.selectedPaths : [],
        queuedPaths: queuedPathsChanged ? snapshot.queuedPaths : [],
      },
      {
        totalFileCount: snapshot.files.length,
        fileIndexes,
        removedPaths: [],
        selectedPathsChanged,
        queuedPathsChanged,
      },
    ),
  };
}

/**
 * Persist until the snapshot revision observed before a save is still current
 * after that save. This prevents a quit ACK from covering a mutation that
 * arrived while Electron was cloning or committing the previous snapshot.
 */
export async function persistUntilRevisionStable(
  readRevision: () => number,
  persist: () => Promise<boolean>,
  maxPasses = 8,
): Promise<boolean> {
  for (let pass = 0; pass < maxPasses; pass++) {
    const revision = readRevision();
    if (!await persist()) return false;
    if (readRevision() === revision) return true;
  }
  return false;
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
  const sessionSaveMaxWaitTimerRef = useRef<number | null>(null);
  const sessionSaveInFlightRef = useRef(false);
  const sessionSavePromiseRef = useRef<Promise<boolean> | null>(null);
  const sessionSavePendingRef = useRef(false);
  const sessionSaveRetryAttemptRef = useRef(0);
  const persistCurrentSnapshotRef = useRef<() => Promise<boolean>>(async () => true);
  const durableBaselineRef = useRef<DurableSessionBaseline | null>(null);
  const restoredImportLedgerIdRef = useRef<string | undefined>(undefined);
  const sessionIdentityEpochRef = useRef(0);
  const initialSnapshot = {
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
  const sessionSnapshotRef = useRef(initialSnapshot);
  const sessionSnapshotIdentityRef = useRef(initialSnapshot);
  const sessionSnapshotRevisionRef = useRef(0);

  const nextSnapshot = {
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
  const previousSnapshot = sessionSnapshotIdentityRef.current;
  if (previousSnapshot.selectedSource !== nextSnapshot.selectedSource
    || previousSnapshot.destination !== nextSnapshot.destination
    || previousSnapshot.files !== nextSnapshot.files
    || previousSnapshot.selectedPaths !== nextSnapshot.selectedPaths
    || previousSnapshot.queuedPaths !== nextSnapshot.queuedPaths
    || previousSnapshot.filter !== nextSnapshot.filter
    || previousSnapshot.focusedIndex !== nextSnapshot.focusedIndex
    || previousSnapshot.focusedPath !== nextSnapshot.focusedPath
    || previousSnapshot.phase !== nextSnapshot.phase
    || previousSnapshot.importLedgerId !== nextSnapshot.importLedgerId) {
    sessionSnapshotRevisionRef.current++;
    sessionSnapshotIdentityRef.current = nextSnapshot;
  }
  sessionSnapshotRef.current = nextSnapshot;

  useEffect(() => {
    const flushNow = async (): Promise<boolean> => {
      const clearScheduledSaves = () => {
        if (sessionSaveTimerRef.current !== null) {
          window.clearTimeout(sessionSaveTimerRef.current);
          sessionSaveTimerRef.current = null;
        }
        if (sessionSaveMaxWaitTimerRef.current !== null) {
          window.clearTimeout(sessionSaveMaxWaitTimerRef.current);
          sessionSaveMaxWaitTimerRef.current = null;
        }
      };
      clearScheduledSaves();
      return persistUntilRevisionStable(
        () => sessionSnapshotRevisionRef.current,
        async () => {
          const active = sessionSavePromiseRef.current;
          if (active && !await active.catch(() => false)) return false;
          // An in-flight save may schedule a coalesced trailing timer from its
          // finally handler. The flush loop owns that trailing save now.
          clearScheduledSaves();
          return persistCurrentSnapshotRef.current().catch(() => false);
        },
      );
    };
    const onPageHide = () => {
      void flushNow();
    };
    const unsubscribe = window.electronAPI.onSessionFlushRequest((token) => {
      void flushNow().then(
        (success) => window.electronAPI.acknowledgeSessionFlush(token, success),
        (error: unknown) => window.electronAPI.acknowledgeSessionFlush(
          token,
          false,
          error instanceof Error ? error.message : 'Final session save failed.',
        ),
      ).catch(() => undefined);
    });
    window.addEventListener('pagehide', onPageHide);
    return () => {
      unsubscribe();
      window.removeEventListener('pagehide', onPageHide);
      if (sessionSaveMaxWaitTimerRef.current !== null) {
        window.clearTimeout(sessionSaveMaxWaitTimerRef.current);
        sessionSaveMaxWaitTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (sessionSaveTimerRef.current !== null) {
      window.clearTimeout(sessionSaveTimerRef.current);
      sessionSaveTimerRef.current = null;
    }
    if (!selectedSource || files.length === 0 || phase === 'scanning') return;
    // A restore can replace an already-open review of the same source, so the
    // staged checkpoint (not just a source-path change) must re-seed identity.
    const restored = consumeRestoredSessionBaseline(selectedSource, files.length);
    if (restored || sessionSourceRef.current !== selectedSource || !sessionIdRef.current) {
      if (sessionSaveMaxWaitTimerRef.current !== null) {
        window.clearTimeout(sessionSaveMaxWaitTimerRef.current);
        sessionSaveMaxWaitTimerRef.current = null;
      }
      sessionSourceRef.current = selectedSource;
      sessionIdentityEpochRef.current++;
      sessionSaveRetryAttemptRef.current = 0;
      if (restored) {
        sessionIdRef.current = restored.session.id;
        restoredImportLedgerIdRef.current = restored.session.importLedgerId;
        durableBaselineRef.current = {
          source: selectedSource,
          fileCount: files.length,
          destination: restored.session.destRoot,
          filter: restored.session.filter,
          focusedPath: restored.session.focusedPath ?? null,
          importLedgerId: restored.session.importLedgerId,
          selectedPaths: restored.session.selectedPaths,
          queuedPaths: restored.session.queuedPaths,
          savedRevision: restored.revision,
          stats: restored.session.stats,
          statsBits: buildSessionStatsBits(files),
        };
      } else {
        sessionIdRef.current = sourceSessionId(selectedSource);
        restoredImportLedgerIdRef.current = undefined;
        durableBaselineRef.current = null;
      }
    }
    const delay = files.length >= 250_000 ? 15_000 : files.length >= 50_000 ? 6_000 : files.length >= 2500 ? 2600 : files.length >= 800 ? 1800 : 1200;
    const persistCurrentSnapshot = (): Promise<boolean> => {
      sessionSaveTimerRef.current = null;
      const snapshot = sessionSnapshotRef.current;
      if (!snapshot.selectedSource || snapshot.files.length === 0 || snapshot.phase === 'scanning') return Promise.resolve(true);
      if (sessionSaveInFlightRef.current) {
        sessionSavePendingRef.current = true;
        return sessionSavePromiseRef.current ?? Promise.resolve(true);
      }
      const durableSnapshot = {
        ...snapshot,
        selectedSource: snapshot.selectedSource,
        importLedgerId: snapshot.importLedgerId ?? restoredImportLedgerIdRef.current,
      } as typeof snapshot & { selectedSource: string };
      const built = buildPersistedSession(
        durableSnapshot,
        sessionIdRef.current || sourceSessionId(snapshot.selectedSource),
        durableBaselineRef.current,
      );
      if (built.noop) {
        acknowledgeSessionChanges(built.revision);
        publishSessionPersistenceStatus('saved');
        if (sessionSaveMaxWaitTimerRef.current !== null) {
          window.clearTimeout(sessionSaveMaxWaitTimerRef.current);
          sessionSaveMaxWaitTimerRef.current = null;
        }
        return Promise.resolve(true);
      }
      sessionSaveInFlightRef.current = true;
      const saveIdentityEpoch = sessionIdentityEpochRef.current;
      publishSessionPersistenceStatus('saving', sessionSaveRetryAttemptRef.current);
      let saveSucceeded = false;
      const operation = window.electronAPI.saveSession(built.session).then(() => {
        saveSucceeded = true;
        sessionSaveRetryAttemptRef.current = 0;
        acknowledgeSessionChanges(built.revision);
        // A same-source restore can replace session identity while this save
        // is in flight. Never let that older completion overwrite the newly
        // staged durable baseline or cancel its max-wait timer.
        if (sessionIdentityEpochRef.current === saveIdentityEpoch
          && sessionIdRef.current === built.session.id) {
          const previous = durableBaselineRef.current;
          const nextStatsBits = built.statsBits ?? previous?.statsBits ?? new Uint8Array(snapshot.files.length);
          for (const update of built.statUpdates) nextStatsBits[update.index] = update.bits;
          durableBaselineRef.current = {
            source: durableSnapshot.selectedSource,
            fileCount: snapshot.files.length,
            destination: snapshot.destination,
            filter: snapshot.filter,
            focusedPath: snapshot.focusedPath ?? (
              snapshot.focusedIndex >= 0 ? snapshot.files[snapshot.focusedIndex]?.path ?? null : null
            ),
            importLedgerId: durableSnapshot.importLedgerId,
            selectedPaths: snapshot.selectedPaths,
            queuedPaths: snapshot.queuedPaths,
            savedRevision: built.revision,
            stats: built.session.stats,
            statsBits: nextStatsBits,
          };
          publishSessionPersistenceStatus('saved');
          if (sessionSaveMaxWaitTimerRef.current !== null) {
            window.clearTimeout(sessionSaveMaxWaitTimerRef.current);
            sessionSaveMaxWaitTimerRef.current = null;
          }
        }
        return true;
      }).catch((error: unknown) => {
        const attempt = ++sessionSaveRetryAttemptRef.current;
        const retryDelay = sessionSaveRetryDelay(attempt);
        const message = error instanceof Error ? error.message : 'Session save failed.';
        if (retryDelay !== null) {
          publishSessionPersistenceStatus('retrying', attempt, message);
          sessionSaveTimerRef.current = window.setTimeout(() => {
            void persistCurrentSnapshotRef.current();
          }, retryDelay);
        } else {
          publishSessionPersistenceStatus('failed', attempt, message);
        }
        return false;
      }).finally(() => {
        sessionSaveInFlightRef.current = false;
        sessionSavePromiseRef.current = null;
        if (sessionSavePendingRef.current) {
          sessionSavePendingRef.current = false;
          // Coalesce all state changes that arrived during the structured
          // clone/transaction into exactly one trailing save.
          if (sessionSaveTimerRef.current !== null) window.clearTimeout(sessionSaveTimerRef.current);
          sessionSaveTimerRef.current = window.setTimeout(() => {
            void persistCurrentSnapshotRef.current();
          }, saveSucceeded ? 0 : 250);
        }
      });
      sessionSavePromiseRef.current = operation;
      return operation;
    };
    persistCurrentSnapshotRef.current = persistCurrentSnapshot;
    if (sessionSaveMaxWaitTimerRef.current === null) {
      sessionSaveMaxWaitTimerRef.current = window.setTimeout(() => {
        sessionSaveMaxWaitTimerRef.current = null;
        if (sessionSaveTimerRef.current !== null) {
          window.clearTimeout(sessionSaveTimerRef.current);
          sessionSaveTimerRef.current = null;
        }
        void persistCurrentSnapshotRef.current();
      }, sessionSaveMaxWait(files.length));
    }
    sessionSaveTimerRef.current = window.setTimeout(() => {
      void persistCurrentSnapshot();
    }, delay);
    return () => {
      if (sessionSaveTimerRef.current !== null) {
        window.clearTimeout(sessionSaveTimerRef.current);
        sessionSaveTimerRef.current = null;
      }
    };
  }, [selectedSource, destination, files, selectedPaths, queuedPaths, filter, focusedIndex, focusedPath, phase, importResult?.ledgerId]);
}
