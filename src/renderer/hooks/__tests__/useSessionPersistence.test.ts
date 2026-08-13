import { describe, expect, it, vi } from 'vitest';
import type { MediaFile } from '../../../shared/types';
import { getSessionDeltaDescriptor } from '../../../shared/session-delta';
import { buildPersistedSession, persistUntilRevisionStable, sessionSaveDelay, sessionSaveMaxWait, sessionSaveRetryDelay, SESSION_SAVE_RETRY_DELAYS_MS, type DurableSessionBaseline } from '../useSessionPersistence';
import { acknowledgeSessionChanges, currentSessionChangeRevision, markSessionPathsChanged, resetSessionChangeJournal, stageRestoredSessionBaseline, consumeRestoredSessionBaseline, subscribeSessionChanges } from '../../utils/sessionChangeJournal';
import { applyVisualGroupAssignments, buildVisualGroupAssignments, mergeReviewPatch, type ReviewPatch } from '../../context/ImportContext';

function makeFiles(count: number): MediaFile[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `/shoot/${index}.jpg`,
    name: `${index}.jpg`,
    size: 1,
    type: 'photo' as const,
    extension: '.jpg',
    thumbnail: `keptra-preview://${index}`,
  }));
}

describe('large session persistence', () => {
  it('uses a bounded exponential retry schedule for failed durable saves', () => {
    expect(Array.from(SESSION_SAVE_RETRY_DELAYS_MS)).toEqual([1_000, 2_000, 4_000, 8_000, 15_000]);
    expect(sessionSaveRetryDelay(1)).toBe(1_000);
    expect(sessionSaveRetryDelay(5)).toBe(15_000);
    expect(sessionSaveRetryDelay(6)).toBeNull();
    expect(sessionSaveRetryDelay(0)).toBeNull();
  });

  it('caps trailing debounce starvation with a bounded max-wait checkpoint', () => {
    expect(sessionSaveDelay(250_000)).toBe(15_000);
    expect(sessionSaveMaxWait(1_000)).toBe(12_000);
    expect(sessionSaveMaxWait(50_000)).toBe(20_000);
    expect(sessionSaveMaxWait(1_000_000)).toBe(30_000);
  });

  it('re-arms max-wait after an overlay-only mutation following a completed save', async () => {
    vi.useFakeTimers();
    let unsubscribe: () => void = () => undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const files = makeFiles(10_000);
      resetSessionChangeJournal(true);
      const snapshot = {
        selectedSource: '/shoot', destination: '/dest', files,
        selectedPaths: [] as string[], queuedPaths: [] as string[], filter: 'all',
        focusedIndex: -1, focusedPath: null, importLedgerId: undefined,
      };
      const checkpoint = buildPersistedSession(snapshot, 'overlay-rearm', null);
      acknowledgeSessionChanges(checkpoint.revision);
      let baseline: DurableSessionBaseline = {
        source: '/shoot', fileCount: files.length, destination: '/dest', filter: 'all', focusedPath: null,
        selectedPaths: [], queuedPaths: [], savedRevision: checkpoint.revision,
        stats: checkpoint.session.stats, statsBits: checkpoint.statsBits!,
      };
      const changedPath = files[7_777].path;
      const overlay = new Map<string, ReviewPatch>();
      const savedScores: number[] = [];
      const schedule = () => {
        if (timer !== null) return;
        timer = setTimeout(() => {
          timer = null;
          const built = buildPersistedSession(snapshot, 'overlay-rearm', baseline, overlay);
          savedScores.push(built.session.files[0]?.reviewScore ?? -1);
          acknowledgeSessionChanges(built.revision);
          const statsBits = baseline.statsBits.slice();
          for (const update of built.statUpdates) statsBits[update.index] = update.bits;
          baseline = { ...baseline, savedRevision: built.revision, stats: built.session.stats, statsBits };
        }, sessionSaveMaxWait(250_000));
      };
      unsubscribe = subscribeSessionChanges(schedule);

      // Neither mutation materializes into snapshot.files, matching the 60s UI
      // overlay cadence. Each one must independently arm a new 30s deadline.
      markSessionPathsChanged([changedPath]);
      overlay.set(changedPath, { reviewScore: 73 });
      await vi.advanceTimersByTimeAsync(30_000);
      markSessionPathsChanged([changedPath]);
      overlay.set(changedPath, { reviewScore: 94 });
      await vi.advanceTimersByTimeAsync(30_000);

      expect(savedScores).toEqual([73, 94]);
    } finally {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
      vi.useRealTimers();
    }
  });

  it('turns a one-row change into a one-row IPC payload after the checkpoint', () => {
    const files = makeFiles(50_000);
    resetSessionChangeJournal(true);
    const snapshot = {
      selectedSource: '/shoot', destination: '/dest', files,
      selectedPaths: [] as string[], queuedPaths: [] as string[], filter: 'all',
      focusedIndex: -1, focusedPath: null, importLedgerId: undefined,
    };
    const checkpoint = buildPersistedSession(snapshot, 'large-session', null);
    acknowledgeSessionChanges(checkpoint.revision);
    const baseline: DurableSessionBaseline = {
      source: '/shoot',
      fileCount: files.length,
      destination: '/dest',
      filter: 'all',
      focusedPath: null,
      selectedPaths: [],
      queuedPaths: [],
      savedRevision: checkpoint.revision,
      stats: checkpoint.session.stats,
      statsBits: checkpoint.statsBits!,
    };

    const changed = files.slice();
    changed[42_000] = { ...changed[42_000], pick: 'selected', thumbnail: 'large-preview' };
    markSessionPathsChanged([changed[42_000].path]);
    const delta = buildPersistedSession({ ...snapshot, files: changed }, 'large-session', baseline);
    const descriptor = getSessionDeltaDescriptor(delta.session);

    expect(delta.delta).toBe(true);
    expect(delta.session.files).toHaveLength(1);
    expect(delta.session.files[0].path).toBe('/shoot/42000.jpg');
    expect(delta.session.files[0].thumbnail).toBeUndefined();
    expect(descriptor?.fileIndexes).toEqual([42_000]);
    expect(delta.session.stats).toEqual(expect.objectContaining({ totalFiles: 50_000, picked: 1, reviewed: 1 }));
  });

  it('persists a 22.5k-photo regroup as changed rows instead of a full checkpoint', () => {
    const files = makeFiles(22_529);
    files[8_000] = { ...files[8_000], visualHash: '0000000000000000' };
    files[8_001] = { ...files[8_001], visualHash: '0000000000000001' };
    resetSessionChangeJournal(true);
    const snapshot = {
      selectedSource: '/shoot', destination: '/dest', files,
      selectedPaths: [] as string[], queuedPaths: [] as string[], filter: 'all',
      focusedIndex: -1, focusedPath: null, importLedgerId: undefined,
    };
    const checkpoint = buildPersistedSession(snapshot, 'large-regroup', null);
    acknowledgeSessionChanges(checkpoint.revision);
    const baseline: DurableSessionBaseline = {
      source: '/shoot',
      fileCount: files.length,
      destination: '/dest',
      filter: 'all',
      focusedPath: null,
      selectedPaths: [],
      queuedPaths: [],
      savedRevision: checkpoint.revision,
      stats: checkpoint.session.stats,
      statsBits: checkpoint.statsBits!,
    };

    const grouped = applyVisualGroupAssignments(files, buildVisualGroupAssignments(files, 2));
    expect(grouped.changedPaths).toEqual(['/shoot/8000.jpg', '/shoot/8001.jpg']);
    markSessionPathsChanged(grouped.changedPaths);
    const persisted = buildPersistedSession({ ...snapshot, files: grouped.files }, 'large-regroup', baseline);
    const descriptor = getSessionDeltaDescriptor(persisted.session);

    expect(persisted.delta).toBe(true);
    expect(persisted.session.files).toHaveLength(2);
    expect(descriptor?.fileIndexes).toEqual([8_000, 8_001]);
    expect(persisted.session.stats).toEqual(expect.objectContaining({ totalFiles: 22_529, reviewed: 2 }));
  });

  it('max-wait persists a live overlay patch that arrived after the last 250k-tier render', async () => {
    vi.useFakeTimers();
    try {
      // 10k is the real delta threshold; the timer uses the >=250k cadence
      // whose 60s UI materialization delay exposed the stale-snapshot bug.
      const files = makeFiles(10_000);
      resetSessionChangeJournal(true);
      const snapshot = {
        selectedSource: '/shoot', destination: '/dest', files,
        selectedPaths: [] as string[], queuedPaths: [] as string[], filter: 'all',
        focusedIndex: -1, focusedPath: null, importLedgerId: undefined,
      };
      const changedPath = files[9_500].path;
      const overlay = new Map<string, ReviewPatch>();
      let maxWaitSave: ReturnType<typeof buildPersistedSession> | undefined;
      setTimeout(() => {
        // `snapshot.files` deliberately remains the pre-overlay rendered array.
        maxWaitSave = buildPersistedSession(snapshot, 'live-overlay', null, overlay);
      }, sessionSaveMaxWait(250_000));

      markSessionPathsChanged([changedPath]);
      overlay.set(changedPath, { reviewScore: 91, reviewAnalysisStage: 'screened', faceCount: 1 });
      await vi.advanceTimersByTimeAsync(30_000);

      expect(maxWaitSave?.delta).toBe(false);
      expect(maxWaitSave?.session.files).toHaveLength(files.length);
      expect(maxWaitSave?.session.files[9_500]).toEqual(expect.objectContaining({
        path: changedPath,
        reviewScore: 91,
        reviewAnalysisStage: 'screened',
        faceCount: 1,
      }));
      expect(maxWaitSave?.session.stats.reviewed).toBe(1);

      const saved = maxWaitSave!;
      acknowledgeSessionChanges(saved.revision);
      const savedBaseline: DurableSessionBaseline = {
        source: '/shoot', fileCount: files.length, destination: '/dest', filter: 'all', focusedPath: null,
        selectedPaths: [], queuedPaths: [],
        savedRevision: saved.revision,
        stats: saved.session.stats,
        statsBits: saved.statsBits!,
      };
      const materializedFiles = files.slice();
      materializedFiles[9_500] = mergeReviewPatch(files[9_500], overlay.get(changedPath)!);
      const afterUiMaterialization = buildPersistedSession(
        { ...snapshot, files: materializedFiles },
        'live-overlay',
        savedBaseline,
        overlay,
      );
      expect(afterUiMaterialization.noop).toBe(true);
      expect(afterUiMaterialization.session.files).toEqual([]);
      expect(afterUiMaterialization.session.stats.reviewed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('quit stability observes journal changes and re-saves the latest live overlay row', async () => {
    const files = makeFiles(10_000);
    resetSessionChangeJournal(true);
    const snapshot = {
      selectedSource: '/shoot', destination: '/dest', files,
      selectedPaths: [] as string[], queuedPaths: [] as string[], filter: 'all',
      focusedIndex: -1, focusedPath: null, importLedgerId: undefined,
    };
    const checkpoint = buildPersistedSession(snapshot, 'quit-live-overlay', null);
    acknowledgeSessionChanges(checkpoint.revision);
    let baseline: DurableSessionBaseline = {
      source: '/shoot', fileCount: files.length, destination: '/dest', filter: 'all', focusedPath: null,
      selectedPaths: [], queuedPaths: [], savedRevision: checkpoint.revision,
      stats: checkpoint.session.stats, statsBits: checkpoint.statsBits!,
    };
    const changedPath = files[8_888].path;
    const overlay = new Map<string, ReviewPatch>();
    markSessionPathsChanged([changedPath]);
    overlay.set(changedPath, { reviewScore: 40 });
    const savedScores: number[] = [];
    let calls = 0;

    const stable = await persistUntilRevisionStable(
      () => `render-0:${currentSessionChangeRevision()}`,
      async () => {
        calls++;
        const built = buildPersistedSession(snapshot, 'quit-live-overlay', baseline, overlay);
        savedScores.push(built.session.files[0]?.reviewScore ?? -1);
        if (calls === 1) {
          // A review result lands while the first quit save is in flight.
          markSessionPathsChanged([changedPath]);
          overlay.set(changedPath, { reviewScore: 96 });
        }
        acknowledgeSessionChanges(built.revision);
        const statsBits = baseline.statsBits.slice();
        for (const update of built.statUpdates) statsBits[update.index] = update.bits;
        baseline = {
          ...baseline,
          savedRevision: built.revision,
          stats: built.session.stats,
          statsBits,
        };
        return true;
      },
    );

    expect(stable).toBe(true);
    expect(calls).toBe(2);
    expect(savedScores).toEqual([40, 96]);
  });

  it('immediate quit after COMMIT persists pending patches before React renders reducer state', () => {
    const files = makeFiles(10_000);
    resetSessionChangeJournal(true);
    const snapshot = {
      selectedSource: '/shoot', destination: '/dest', files,
      selectedPaths: [] as string[], queuedPaths: [] as string[], filter: 'all',
      focusedIndex: -1, focusedPath: null, importLedgerId: undefined,
    };
    const checkpoint = buildPersistedSession(snapshot, 'commit-race', null);
    acknowledgeSessionChanges(checkpoint.revision);
    const baseline: DurableSessionBaseline = {
      source: '/shoot', fileCount: files.length, destination: '/dest', filter: 'all', focusedPath: null,
      selectedPaths: [], queuedPaths: [], savedRevision: checkpoint.revision,
      stats: checkpoint.session.stats, statsBits: checkpoint.statsBits!,
    };
    const changedPath = files[4_321].path;
    markSessionPathsChanged([changedPath]);

    // COMMIT has cleared the working overlay, but React has not rendered the
    // reducer's new files yet. The provider retains these pending patches.
    const liveOverlay = new Map<string, ReviewPatch>();
    const pendingCommitted = new Map<string, ReviewPatch>([[changedPath, {
      reviewScore: 84,
      reviewAnalysisStage: 'subjects',
      personCount: 1,
    }]]);
    const immediateQuit = buildPersistedSession(
      snapshot,
      'commit-race',
      baseline,
      liveOverlay,
      pendingCommitted,
    );

    expect(immediateQuit.delta).toBe(true);
    expect(immediateQuit.session.files).toEqual([expect.objectContaining({
      path: changedPath,
      reviewScore: 84,
      reviewAnalysisStage: 'subjects',
      personCount: 1,
    })]);
    expect(immediateQuit.session.stats.reviewed).toBe(1);
  });

  it('seeds a restored large checkpoint as a no-op durable baseline', () => {
    const files = makeFiles(10_000);
    const restored = {
      id: 'restored-session',
      updatedAt: '2026-08-13T01:00:00.000Z',
      sourcePath: '/shoot',
      destRoot: '/dest',
      files,
      selectedPaths: ['/shoot/1.jpg'],
      queuedPaths: ['/shoot/2.jpg'],
      filter: 'queue',
      focusedPath: '/shoot/1.jpg',
      importLedgerId: 'ledger-a',
      stats: { totalFiles: files.length, picked: 0, rejected: 0, queued: 1, reviewed: 0 },
    };
    stageRestoredSessionBaseline(restored);
    const seed = consumeRestoredSessionBaseline('/shoot', files.length);
    expect(seed?.session.id).toBe('restored-session');
    const baseline: DurableSessionBaseline = {
      source: '/shoot',
      fileCount: files.length,
      destination: '/dest',
      filter: 'queue',
      focusedPath: '/shoot/1.jpg',
      importLedgerId: 'ledger-a',
      selectedPaths: restored.selectedPaths,
      queuedPaths: restored.queuedPaths,
      savedRevision: seed!.revision,
      stats: restored.stats,
      statsBits: new Uint8Array(files.length),
    };
    const built = buildPersistedSession({
      selectedSource: '/shoot', destination: '/dest', files,
      selectedPaths: restored.selectedPaths, queuedPaths: restored.queuedPaths,
      filter: 'queue', focusedIndex: 1, focusedPath: '/shoot/1.jpg', importLedgerId: 'ledger-a',
    }, restored.id, baseline);

    expect(built.noop).toBe(true);
    expect(built.delta).toBe(true);
    expect(built.session.id).toBe(restored.id);
    expect(built.session.files).toEqual([]);
  });

  it('repeats a shutdown save when the snapshot mutates in flight', async () => {
    let revision = 4;
    let saves = 0;
    const stable = await persistUntilRevisionStable(
      () => revision,
      async () => {
        saves++;
        if (saves === 1) revision++;
        return true;
      },
    );
    expect(stable).toBe(true);
    expect(saves).toBe(2);
  });

  it('refuses a quit ACK when mutations never become stable', async () => {
    let revision = 0;
    const stable = await persistUntilRevisionStable(
      () => revision,
      async () => {
        revision++;
        return true;
      },
      3,
    );
    expect(stable).toBe(false);
  });
});
