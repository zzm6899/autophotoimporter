import { describe, expect, it } from 'vitest';
import type { MediaFile } from '../../../shared/types';
import { getSessionDeltaDescriptor } from '../../../shared/session-delta';
import { buildPersistedSession, persistUntilRevisionStable, sessionSaveMaxWait, sessionSaveRetryDelay, SESSION_SAVE_RETRY_DELAYS_MS, type DurableSessionBaseline } from '../useSessionPersistence';
import { acknowledgeSessionChanges, markSessionPathsChanged, resetSessionChangeJournal, stageRestoredSessionBaseline, consumeRestoredSessionBaseline } from '../../utils/sessionChangeJournal';

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
    expect(sessionSaveMaxWait(1_000)).toBe(12_000);
    expect(sessionSaveMaxWait(50_000)).toBe(20_000);
    expect(sessionSaveMaxWait(1_000_000)).toBe(30_000);
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
