import { beforeEach, describe, expect, it } from 'vitest';
import { acknowledgeSessionChanges, consumeRestoredSessionBaseline, markSessionPathsChanged, resetSessionChangeJournal, snapshotSessionChanges, stageRestoredSessionBaseline, subscribeSessionChanges } from '../sessionChangeJournal';

describe('sessionChangeJournal', () => {
  beforeEach(() => resetSessionChangeJournal(true));

  it('acknowledges only changes included in the completed save', () => {
    const checkpoint = snapshotSessionChanges(-1);
    acknowledgeSessionChanges(checkpoint.revision);
    markSessionPathsChanged(['/a.jpg']);
    const first = snapshotSessionChanges(checkpoint.revision);
    markSessionPathsChanged(['/a.jpg', '/b.jpg']);
    acknowledgeSessionChanges(first.revision);
    const pending = snapshotSessionChanges(first.revision);

    expect(pending.fullCheckpoint).toBe(false);
    expect(new Set(pending.paths)).toEqual(new Set(['/a.jpg', '/b.jpg']));
  });

  it('does not retain per-path dirtiness already covered by a pending full checkpoint', () => {
    markSessionPathsChanged(Array.from({ length: 100_000 }, (_, index) => `/scan/${index}.jpg`));
    const checkpoint = snapshotSessionChanges(-1);
    expect(checkpoint.fullCheckpoint).toBe(true);
    expect(checkpoint.paths).toEqual([]);

    // Once the checkpoint has been captured, writes arriving while it is in
    // flight must remain visible for the trailing delta.
    markSessionPathsChanged(['/scan/42.jpg']);
    const checkpointRevision = checkpoint.revision;
    acknowledgeSessionChanges(checkpointRevision);
    expect(snapshotSessionChanges(checkpointRevision).paths).toEqual(['/scan/42.jpg']);
  });

  it('hands a restored checkpoint to persistence without requesting a rewrite', () => {
    const session = {
      id: 'restored', updatedAt: '2026-08-13T00:00:00.000Z', sourcePath: '/scan', destRoot: '/dest',
      files: [{ path: '/scan/a.jpg', name: 'a.jpg', size: 1, type: 'photo' as const, extension: '.jpg' }],
      selectedPaths: [], queuedPaths: [], filter: 'all',
      stats: { totalFiles: 1, picked: 0, rejected: 0, queued: 0, reviewed: 0 },
    };
    const revision = stageRestoredSessionBaseline(session);
    expect(snapshotSessionChanges(revision)).toEqual({ revision, fullCheckpoint: false, paths: [] });
    expect(consumeRestoredSessionBaseline('/different', 1)).toBeNull();
    expect(consumeRestoredSessionBaseline('/scan', 1)).toEqual({ session, revision });
    expect(consumeRestoredSessionBaseline('/scan', 1)).toBeNull();
  });

  it('notifies durability scheduling for journal mutations without treating ACKs as new work', () => {
    let calls = 0;
    const unsubscribe = subscribeSessionChanges(() => { calls++; });
    try {
      const changed = markSessionPathsChanged(['/scan/a.jpg']);
      expect(calls).toBe(1);
      acknowledgeSessionChanges(changed);
      expect(calls).toBe(1);
    } finally {
      unsubscribe();
    }
    markSessionPathsChanged(['/scan/b.jpg']);
    expect(calls).toBe(1);
  });
});
