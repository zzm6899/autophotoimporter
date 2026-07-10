import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppSession, MediaFile } from '../../../shared/types';
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
      await rm(path.join(sessionDir, 'latest.json'), { force: true });
      const second = await openSessionStore(sessionDir);
      await expect(second.readLatest()).resolves.toEqual(expect.objectContaining({ id: 'legacy-session' }));
      await second.close();
    }
  });
});
