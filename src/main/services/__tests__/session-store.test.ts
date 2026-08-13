import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppSession, MediaFile } from '../../../shared/types';
import { createSessionDeltaEnvelope } from '../../../shared/session-delta';
import { openSessionStore } from '../session-store';

const tempDirs: string[] = [];

async function tempSessionDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'keptra-sessions-'));
  tempDirs.push(dir);
  return dir;
}

function embeddingHex(values: number[]): string {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer.toString('hex');
}

function makeFile(overrides: Partial<MediaFile> = {}): MediaFile {
  return {
    path: '/card/DCIM/IMG_0001.JPG',
    name: 'IMG_0001.JPG',
    size: 4_096,
    type: 'photo',
    extension: '.jpg',
    thumbnail: 'data:image/jpeg;base64,large-preview-data',
    faceEmbedding: embeddingHex([1, 0, 0, 0]),
    faceEmbeddings: [embeddingHex([1, 0, 0, 0]), embeddingHex([0.9, 0.1, 0, 0])],
    faceEmbeddingBoxes: [
      { x: 0.2, y: 0.25, width: 0.1, height: 0.12, score: 0.93 },
      { x: 0.62, y: 0.3, width: 0.08, height: 0.1, score: 0.82 },
    ],
    cameraModel: 'R5',
    reviewScore: 88,
    pick: 'selected',
    ...overrides,
  };
}

function makeSession(overrides: Partial<AppSession> = {}): AppSession {
  const file = makeFile();
  return {
    id: 'session-a',
    updatedAt: '2026-05-06T00:00:00.000Z',
    sourcePath: '/card',
    destRoot: '/imports',
    files: [file],
    selectedPaths: [file.path],
    queuedPaths: [file.path],
    filter: 'queue',
    focusedPath: file.path,
    stats: { totalFiles: 1, picked: 1, rejected: 0, queued: 1, reviewed: 1 },
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('SessionStore JSON fallback', () => {
  it('persists compact sessions without thumbnails while preserving face embeddings', async () => {
    const sessionDir = await tempSessionDir();
    const store = await openSessionStore(sessionDir, { preferJson: true });
    const saved = await store.save(makeSession());
    const restored = await store.readLatest();

    expect(store.storageKind).toBe('json');
    expect(saved.files[0].thumbnail).toBeUndefined();
    expect(saved.files[0].faceEmbeddings).toHaveLength(2);
    expect(restored?.files[0].thumbnail).toBeUndefined();
    expect(restored?.files[0].faceEmbeddings).toEqual(saved.files[0].faceEmbeddings);

    const raw = await readFile(path.join(sessionDir, 'latest.json'), 'utf8');
    expect(raw).not.toContain('large-preview-data');
    expect(raw).toContain(saved.files[0].faceEmbeddings![0]);
    await store.close();
  });

  it('purges face, pose, and derived review evidence from every JSON session copy', async () => {
    const sessionDir = await tempSessionDir();
    const store = await openSessionStore(sessionDir, { preferJson: true });
    const embedding = embeddingHex([1, 0, 0, 0]);
    await store.save(makeSession({
      files: [makeFile({
        rating: 5,
        faceCount: 1,
        faceBoxes: [{ x: 0.2, y: 0.2, width: 0.2, height: 0.2, score: 0.9 }],
        faceSignature: 'face-signature',
        faceEmbedding: embedding,
        faceEmbeddings: [embedding],
        faceGroupId: 'face-1',
        faceGroupSize: 2,
        personCount: 1,
        personBoxes: [{ x: 0.1, y: 0.05, width: 0.4, height: 0.8, score: 0.8 }],
        poses: [{ keypoints: [{ x: 0.2, y: 0.3, score: 0.9 }] }],
        subjectSharpnessScore: 42,
        subjectReasons: ['face focus'],
        reviewScore: 91,
        reviewReasons: ['sharp eyes'],
        reviewAnalysisStage: 'full',
        sceneAnalysis: {
          kind: 'people', confidence: 0.9, focusCoverage: 0.7,
          subjectSharpnessScore: 42, subjectReasons: ['face focus'],
          reasons: ['balanced composition', 'face focus'],
        },
      })],
    }));
    const activeRaw = await readFile(path.join(sessionDir, 'latest.json'), 'utf8');
    const archivedPath = path.join(sessionDir, 'old.json.sqlite-migrated-test');
    await writeFile(archivedPath, activeRaw, 'utf8');

    const result = await store.purgeFaceData();
    const restored = await store.readLatest();
    const file = restored?.files[0];
    expect(result.sessionFilesPurged).toBeGreaterThanOrEqual(2);
    expect(file).toEqual(expect.objectContaining({ cameraModel: 'R5', rating: 5, pick: 'selected' }));
    for (const key of [
      'faceCount', 'faceBoxes', 'faceSignature', 'faceEmbedding', 'faceEmbeddings',
      'faceEmbeddingBoxes', 'faceGroupId', 'faceGroupSize', 'personCount',
      'personBoxes', 'poses', 'subjectSharpnessScore', 'subjectReasons',
      'reviewScore', 'reviewReasons', 'reviewAnalysisStage',
    ]) expect(file).not.toHaveProperty(key);
    expect(file?.sceneAnalysis).toEqual({
      kind: 'people', confidence: 0.9, focusCoverage: 0.7, reasons: ['balanced composition'],
    });
    expect(restored?.selectedPaths).toEqual(['/card/DCIM/IMG_0001.JPG']);
    const persisted = `${await readFile(path.join(sessionDir, 'latest.json'), 'utf8')}\n${await readFile(archivedPath, 'utf8')}`;
    expect(persisted).not.toContain(embedding);
    expect(persisted).not.toContain('"faceBoxes"');
    expect(persisted).not.toContain('"poses"');
    expect(persisted).not.toContain('"reviewScore"');
    await store.close();
  });

  it('merges delta saves into the durable JSON checkpoint', async () => {
    const sessionDir = await tempSessionDir();
    const store = await openSessionStore(sessionDir, { preferJson: true });
    const first = makeFile();
    const second = makeFile({ path: '/card/DCIM/IMG_0002.JPG', name: 'IMG_0002.JPG', pick: undefined });
    const checkpoint = makeSession({ files: [first, second], selectedPaths: [first.path], queuedPaths: [] });
    await store.save(checkpoint);
    await store.save(createSessionDeltaEnvelope(
      {
        ...checkpoint,
        updatedAt: '2026-05-06T00:01:00.000Z',
        files: [{ ...second, rating: 4, pick: 'selected' }],
        selectedPaths: [],
        stats: { totalFiles: 2, picked: 2, rejected: 0, queued: 0, reviewed: 2 },
      },
      {
        totalFileCount: 2,
        fileIndexes: [1],
        removedPaths: [],
        selectedPathsChanged: false,
        queuedPathsChanged: false,
      },
    ));

    const restored = await store.readLatest();
    expect(restored?.files).toHaveLength(2);
    expect(restored?.files[0].path).toBe(first.path);
    expect(restored?.files[1]).toEqual(expect.objectContaining({ path: second.path, rating: 4, pick: 'selected' }));
    await store.close();
  });

  it('reads only a summary at startup and pages the full review on demand', async () => {
    const sessionDir = await tempSessionDir();
    const store = await openSessionStore(sessionDir, { preferJson: true });
    const first = makeFile();
    const second = makeFile({ path: '/card/DCIM/IMG_0002.JPG', name: 'IMG_0002.JPG', pick: undefined });
    await store.save(makeSession({
      files: [first, second],
      selectedPaths: [first.path, second.path],
      queuedPaths: [second.path],
      stats: { totalFiles: 2, picked: 1, rejected: 0, queued: 1, reviewed: 1 },
    }));

    const summary = await store.readLatestSummary();
    expect(summary).toEqual(expect.objectContaining({ id: 'session-a', stats: expect.objectContaining({ totalFiles: 2 }) }));
    expect(summary).not.toHaveProperty('files');
    const firstPage = await store.readRestorePage('session-a', 0, 1);
    const secondPage = await store.readRestorePage('session-a', 1, 1);
    expect(firstPage).toEqual(expect.objectContaining({
      offset: 0, complete: false, files: [expect.objectContaining({ path: first.path })],
      selectedPaths: [first.path], queuedPaths: [second.path],
    }));
    expect(secondPage).toEqual(expect.objectContaining({
      offset: 1, complete: true, files: [expect.objectContaining({ path: second.path })],
      selectedPaths: [second.path], queuedPaths: [],
    }));
    await store.close();
  });

  it('keeps pre-summary JSON checkpoints restorable after an explicit request', async () => {
    const sessionDir = await tempSessionDir();
    const legacy = makeSession({ id: 'legacy-json' });
    await writeFile(path.join(sessionDir, 'latest.json'), JSON.stringify(legacy), 'utf8');
    await writeFile(path.join(sessionDir, 'legacy-json.json'), JSON.stringify(legacy), 'utf8');
    const store = await openSessionStore(sessionDir, { preferJson: true });

    await expect(store.readLatestSummary()).resolves.toEqual(expect.objectContaining({
      id: 'legacy-json', stats: expect.objectContaining({ totalFiles: 0 }),
    }));
    await expect(store.readRestorePage('legacy-json', 0, 100)).resolves.toEqual(expect.objectContaining({
      complete: true,
      summary: expect.objectContaining({ stats: expect.objectContaining({ totalFiles: 1 }) }),
      files: [expect.objectContaining({ path: legacy.files[0].path })],
    }));
    await store.close();
  });
});

describe('SessionStore default storage', () => {
  it('uses SQLite when available and round-trips latest review sessions', async () => {
    const sessionDir = await tempSessionDir();
    const store = await openSessionStore(sessionDir);
    const saved = await store.save(makeSession());
    const restored = await store.readLatest();

    expect(['sqlite', 'json']).toContain(store.storageKind);
    expect(saved.files[0].thumbnail).toBeUndefined();
    expect(restored).toEqual(expect.objectContaining({
      id: 'session-a',
      filter: 'queue',
      selectedPaths: ['/card/DCIM/IMG_0001.JPG'],
      queuedPaths: ['/card/DCIM/IMG_0001.JPG'],
    }));
    expect(restored?.files[0]).toEqual(expect.objectContaining({
      path: '/card/DCIM/IMG_0001.JPG',
      cameraModel: 'R5',
      faceEmbedding: saved.files[0].faceEmbeddings![0],
      faceEmbeddings: saved.files[0].faceEmbeddings,
      faceEmbeddingBoxes: saved.files[0].faceEmbeddingBoxes,
    }));
    expect(restored?.files[0].thumbnail).toBeUndefined();

    if (store.storageKind === 'sqlite') {
      await expect(stat(store.storagePath)).resolves.toEqual(expect.objectContaining({ size: expect.any(Number) }));
      await expect(readFile(path.join(sessionDir, 'latest.json'), 'utf8')).rejects.toThrow();
    }
    await store.close();
  });

  it('purges separate SQLite embeddings and subject metadata without deleting the session', async () => {
    const sessionDir = await tempSessionDir();
    const store = await openSessionStore(sessionDir);
    if (store.storageKind !== 'sqlite') {
      await store.close();
      return;
    }
    const embedding = embeddingHex([1, 0, 0, 0]);
    await store.save(makeSession({
      files: [makeFile({
        rating: 4,
        pick: undefined,
        faceCount: 1,
        faceBoxes: [{ x: 0.2, y: 0.2, width: 0.2, height: 0.2 }],
        faceEmbedding: embedding,
        faceEmbeddings: [embedding],
        faceGroupId: 'face-1',
        poses: [{ keypoints: [{ x: 0.3, y: 0.4, score: 0.8 }] }],
        reviewScore: 95,
        reviewReasons: ['clear face'],
      })],
      selectedPaths: [],
      queuedPaths: [],
      stats: { totalFiles: 1, picked: 0, rejected: 0, queued: 0, reviewed: 1 },
    }));

    await expect(store.purgeFaceData()).resolves.toEqual({ sessionFilesPurged: 1 });
    const restored = await store.readLatest();
    expect(restored).toEqual(expect.objectContaining({
      id: 'session-a', selectedPaths: [], stats: expect.objectContaining({ reviewed: 0 }),
    }));
    expect(restored?.files[0]).toEqual(expect.objectContaining({ cameraModel: 'R5', rating: 4 }));
    expect(restored?.files[0]).not.toHaveProperty('faceEmbedding');
    expect(restored?.files[0]).not.toHaveProperty('faceEmbeddings');
    expect(restored?.files[0]).not.toHaveProperty('faceBoxes');
    expect(restored?.files[0]).not.toHaveProperty('faceGroupId');
    expect(restored?.files[0]).not.toHaveProperty('poses');
    expect(restored?.files[0]).not.toHaveProperty('reviewScore');

    const sqlite = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (filename: string) => {
        prepare: (sql: string) => { get: () => Record<string, unknown> };
        close: () => void;
      };
    };
    const inspection = new sqlite.DatabaseSync(store.storagePath);
    expect(Number(inspection.prepare('SELECT COUNT(*) AS count FROM session_face_embeddings').get().count)).toBe(0);
    inspection.close();
    await store.close();
  });

  it('restores SQLite sessions in ordered bounded pages with face evidence', async () => {
    const sessionDir = await tempSessionDir();
    const store = await openSessionStore(sessionDir);
    if (store.storageKind !== 'sqlite') {
      await store.close();
      return;
    }
    const first = makeFile();
    const second = makeFile({ path: '/card/DCIM/IMG_0002.JPG', name: 'IMG_0002.JPG', pick: undefined });
    const third = makeFile({ path: '/card/DCIM/IMG_0003.JPG', name: 'IMG_0003.JPG', pick: 'rejected' });
    await store.save(makeSession({
      files: [first, second, third],
      selectedPaths: [first.path, third.path],
      queuedPaths: [second.path],
      stats: { totalFiles: 3, picked: 1, rejected: 1, queued: 1, reviewed: 2 },
    }));

    const summary = await store.readLatestSummary();
    expect(summary).toEqual(expect.objectContaining({ id: 'session-a', stats: expect.objectContaining({ totalFiles: 3 }) }));
    expect(summary).not.toHaveProperty('files');
    const page0 = await store.readRestorePage('session-a', 0, 2);
    const page1 = await store.readRestorePage('session-a', 2, 2);
    expect(page0?.files.map((file) => file.path)).toEqual([first.path, second.path]);
    expect(page0?.files[0].faceEmbeddings).toEqual(first.faceEmbeddings);
    expect(page0?.selectedPaths).toEqual([first.path, third.path]);
    expect(page0?.queuedPaths).toEqual([second.path]);
    expect(page0?.complete).toBe(false);
    expect(page1?.files.map((file) => file.path)).toEqual([third.path]);
    expect(page1?.selectedPaths).toEqual([]);
    expect(page1?.complete).toBe(true);
    await store.close();
  });

  it('persists changed and removed files across incremental saves', async () => {
    const sessionDir = await tempSessionDir();
    const store = await openSessionStore(sessionDir);
    const first = makeFile();
    const second = makeFile({ path: '/card/DCIM/IMG_0002.JPG', name: 'IMG_0002.JPG', pick: undefined });
    await store.save(makeSession({ files: [first, second], selectedPaths: [first.path], queuedPaths: [first.path, second.path] }));
    await store.save(makeSession({
      updatedAt: '2026-05-06T00:01:00.000Z',
      files: [{ ...first, rating: 5, pick: 'rejected' }],
      selectedPaths: [],
      queuedPaths: [],
      stats: { totalFiles: 1, picked: 0, rejected: 1, queued: 0, reviewed: 1 },
    }));

    const restored = await store.readLatest();
    expect(restored?.files).toHaveLength(1);
    expect(restored?.files[0]).toEqual(expect.objectContaining({ path: first.path, rating: 5, pick: 'rejected' }));
    expect(restored?.selectedPaths).toEqual([]);
    expect(restored?.queuedPaths).toEqual([]);
    await store.close();
  });

  it('transactionally upserts only rows carried by a session delta', async () => {
    const sessionDir = await tempSessionDir();
    const store = await openSessionStore(sessionDir);
    const first = makeFile();
    const second = makeFile({ path: '/card/DCIM/IMG_0002.JPG', name: 'IMG_0002.JPG', pick: undefined });
    const checkpoint = makeSession({ files: [first, second], selectedPaths: [first.path], queuedPaths: [] });
    await store.save(checkpoint);
    await store.save(createSessionDeltaEnvelope(
      {
        ...checkpoint,
        updatedAt: '2026-05-06T00:02:00.000Z',
        files: [{ ...second, rating: 3, colorLabel: 'green' }],
        selectedPaths: [],
        stats: { totalFiles: 2, picked: 1, rejected: 0, queued: 0, reviewed: 2 },
      },
      {
        totalFileCount: 2,
        fileIndexes: [1],
        removedPaths: [],
        selectedPathsChanged: false,
        queuedPathsChanged: false,
      },
    ));

    const restored = await store.readLatest();
    expect(restored?.files).toHaveLength(2);
    expect(restored?.files[0]).toEqual(expect.objectContaining({ path: first.path, pick: 'selected' }));
    expect(restored?.files[1]).toEqual(expect.objectContaining({ path: second.path, rating: 3, colorLabel: 'green' }));
    expect(restored?.stats.totalFiles).toBe(2);
    await store.close();
  });

  it('rejects a delta whose path does not match the persisted sort index', async () => {
    const sessionDir = await tempSessionDir();
    const store = await openSessionStore(sessionDir);
    if (store.storageKind !== 'sqlite') {
      await store.close();
      return;
    }
    const first = makeFile();
    const second = makeFile({ path: '/card/DCIM/IMG_0002.JPG', name: 'IMG_0002.JPG', pick: undefined });
    const checkpoint = makeSession({ files: [first, second], selectedPaths: [first.path], queuedPaths: [] });
    await store.save(checkpoint);

    const replacement = makeFile({ path: '/card/DCIM/REPLACEMENT.JPG', name: 'REPLACEMENT.JPG' });
    const malformed = createSessionDeltaEnvelope(
      {
        ...checkpoint,
        files: [replacement],
        selectedPaths: [],
        queuedPaths: [],
        stats: { totalFiles: 2, picked: 1, rejected: 0, queued: 0, reviewed: 1 },
      },
      {
        totalFileCount: 2,
        fileIndexes: [1],
        removedPaths: [],
        selectedPathsChanged: false,
        queuedPathsChanged: false,
      },
    );

    await expect(store.save(malformed)).rejects.toThrow(/path.*index/i);
    await expect(store.readLatest()).resolves.toEqual(expect.objectContaining({
      files: [
        expect.objectContaining({ path: first.path }),
        expect.objectContaining({ path: second.path }),
      ],
    }));
    await store.close();
  });

  it('rejects inconsistent aggregate counters in a delta', async () => {
    const sessionDir = await tempSessionDir();
    const store = await openSessionStore(sessionDir);
    const checkpoint = makeSession();
    await store.save(checkpoint);
    const malformed = createSessionDeltaEnvelope(
      {
        ...checkpoint,
        files: [{ ...checkpoint.files[0], rating: 5 }],
        selectedPaths: [],
        queuedPaths: [],
        stats: { totalFiles: 1, picked: 1, rejected: 1, queued: 0, reviewed: 1 },
      },
      {
        totalFileCount: 1,
        fileIndexes: [0],
        removedPaths: [],
        selectedPathsChanged: false,
        queuedPathsChanged: false,
      },
    );
    await expect(store.save(malformed)).rejects.toThrow();
    if (store.storageKind === 'sqlite') {
      await expect(readFile(path.join(sessionDir, 'latest.json'), 'utf8')).rejects.toThrow();
    }
    await store.close();
  });

  it('derives full-checkpoint statistics when a caller supplies a stale aggregate', async () => {
    const sessionDir = await tempSessionDir();
    const store = await openSessionStore(sessionDir);
    const first = makeFile();
    const second = makeFile({
      path: '/card/DCIM/IMG_0002.JPG',
      name: 'IMG_0002.JPG',
      pick: 'rejected',
    });

    // makeSession's default aggregate describes one file. A durable full
    // checkpoint must derive its own aggregate from the actual two-file list.
    await store.save(makeSession({
      files: [first, second],
      selectedPaths: [first.path],
      queuedPaths: [second.path],
      stats: { totalFiles: 2, picked: 99, rejected: 99, queued: 99, reviewed: 99 },
    }));

    await expect(store.readLatest()).resolves.toEqual(expect.objectContaining({
      stats: {
        totalFiles: 2,
        picked: 1,
        rejected: 1,
        queued: 1,
        reviewed: 2,
      },
    }));
    await store.close();
  });

  it('keeps reading and extending JSON recovery after an SQLite save failure', async () => {
    const sessionDir = await tempSessionDir();
    const store = await openSessionStore(sessionDir);
    if (store.storageKind !== 'sqlite') {
      await store.close();
      return;
    }

    const first = makeFile();
    const second = makeFile({ path: '/card/DCIM/IMG_0002.JPG', name: 'IMG_0002.JPG', pick: undefined });
    const checkpoint = makeSession({
      files: [first, second],
      selectedPaths: [first.path],
      queuedPaths: [],
    });
    await store.save(checkpoint);

    const sqlite = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (filename: string) => {
        exec: (sql: string) => void;
        close: () => void;
      };
    };
    const sabotage = new sqlite.DatabaseSync(store.storagePath);
    sabotage.exec(`
      CREATE TRIGGER force_session_save_failure
      BEFORE UPDATE ON sessions
      BEGIN
        SELECT RAISE(FAIL, 'forced session save failure');
      END;
    `);
    sabotage.close();

    const firstDelta = createSessionDeltaEnvelope(
      {
        ...checkpoint,
        updatedAt: '2026-05-06T00:03:00.000Z',
        files: [{ ...second, rating: 4 }],
        selectedPaths: [],
        queuedPaths: [],
        stats: { totalFiles: 2, picked: 1, rejected: 0, queued: 0, reviewed: 2 },
      },
      {
        totalFileCount: 2,
        fileIndexes: [1],
        removedPaths: [],
        selectedPathsChanged: false,
        queuedPathsChanged: false,
      },
    );
    await store.save(firstDelta);
    expect((await store.readLatest())?.files[1]).toEqual(expect.objectContaining({ rating: 4 }));

    // A second delta must merge against the recovery checkpoint, not branch
    // from the older SQLite snapshot that missed the first update.
    await store.save(createSessionDeltaEnvelope(
      {
        ...firstDelta,
        updatedAt: '2026-05-06T00:04:00.000Z',
        files: [{ ...first, colorLabel: 'blue' }],
        stats: { totalFiles: 2, picked: 1, rejected: 0, queued: 0, reviewed: 2 },
      },
      {
        totalFileCount: 2,
        fileIndexes: [0],
        removedPaths: [],
        selectedPathsChanged: false,
        queuedPathsChanged: false,
      },
    ));

    const recovered = await store.readLatest();
    expect(recovered?.files[0]).toEqual(expect.objectContaining({ colorLabel: 'blue' }));
    expect(recovered?.files[1]).toEqual(expect.objectContaining({ rating: 4 }));
    await store.close();
  });

  it('migrates an old latest.json session into SQLite when SQLite is available', async () => {
    const sessionDir = await tempSessionDir();
    const legacy = makeSession({ id: 'legacy-session' });
    await writeFile(path.join(sessionDir, 'latest.json'), JSON.stringify(legacy), 'utf8');

    const first = await openSessionStore(sessionDir);
    const restored = await first.readLatest();
    expect(restored?.id).toBe('legacy-session');
    expect(restored?.files[0].thumbnail).toBeUndefined();
    await first.close();

    if (first.storageKind === 'sqlite') {
      await expect(readFile(path.join(sessionDir, 'latest.json'), 'utf8')).rejects.toThrow();
      await rm(path.join(sessionDir, 'latest.json'), { force: true });
      const second = await openSessionStore(sessionDir);
      await expect(second.readLatest()).resolves.toEqual(expect.objectContaining({ id: 'legacy-session' }));
      await second.close();
    }
  });

  it('does not parse a stale large legacy document when SQLite is current', async () => {
    const sessionDir = await tempSessionDir();
    const first = await openSessionStore(sessionDir);
    if (first.storageKind !== 'sqlite') {
      await first.close();
      return;
    }
    const current = makeSession({ updatedAt: '2026-05-06T01:00:00.000Z' });
    await first.save(current);
    await first.close();

    // The valid header fits in the bounded prefix, but the remainder is
    // intentionally not JSON. Parsing the whole fallback would fail; the
    // SQLite-first path compares only its header and archives it by rename.
    await writeFile(
      path.join(sessionDir, 'latest.json'),
      '{"id":"stale-session","updatedAt":"2020-01-01T00:00:00.000Z","files":[' + 'x'.repeat(256_000),
      'utf8',
    );
    const second = await openSessionStore(sessionDir);
    await expect(second.readLatest()).resolves.toEqual(expect.objectContaining({ id: current.id }));
    await expect(readFile(path.join(sessionDir, 'latest.json'), 'utf8')).rejects.toThrow();
    await second.close();
  });

  it('preserves an ambiguous equal-timestamp legacy recovery without a generation token', async () => {
    const sessionDir = await tempSessionDir();
    const first = await openSessionStore(sessionDir);
    if (first.storageKind !== 'sqlite') {
      await first.close();
      return;
    }
    const current = makeSession({ updatedAt: '2026-05-06T02:00:00.000Z' });
    await first.save(current);
    await first.close();

    const divergent = makeSession({
      updatedAt: current.updatedAt,
      files: [{ ...current.files[0], rating: 1 }],
    });
    await writeFile(path.join(sessionDir, 'latest.json'), JSON.stringify(divergent), 'utf8');
    // No latest.checkpoint.json: this models a pre-generation fallback. Equal
    // timestamps alone are not strong enough evidence to discard it.
    const second = await openSessionStore(sessionDir);
    await expect(second.readLatest()).resolves.toEqual(expect.objectContaining({ id: current.id }));
    await expect(readFile(path.join(sessionDir, 'latest.json'), 'utf8')).resolves.toContain('"rating":1');
    await second.close();
  });
});
