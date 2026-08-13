import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { cacheRoot } = vi.hoisted(() => ({
  cacheRoot: pathForTestCache(),
}));

function pathForTestCache(): string {
  const temp = process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp';
  return `${temp}\\keptra-face-cache-${process.pid}-${Date.now()}`;
}

vi.mock('electron', () => ({
  app: {
    getPath: () => cacheRoot,
  },
}));

import { FACE_PIPELINE_FINGERPRINT } from '../face-model-manifest';
import type { FaceAnalysisResult } from '../face-engine';
import {
  cacheKeyFor,
  clearFaceCache,
  closeFaceCache,
  getBestCachedFaceResult,
  getCachedFaceResult,
  getFaceCacheDiagnostics,
  maintainFaceCache,
  setCachedFaceResult,
} from '../face-cache';

const imagePath = path.join(cacheRoot, 'photo.jpg');

function analysisResult(options: {
  faceMatching?: boolean;
  personDetection?: boolean;
  poseAnalysis?: boolean;
  personFallback?: boolean;
  eyeDetail?: boolean;
  sportsSafeguards?: boolean;
} = {}): { result: FaceAnalysisResult; hexEmbeddings: string[] } {
  const faceMatching = options.faceMatching ?? false;
  const embeddingHex = Buffer.from(new Float32Array([0.25, -0.5, 0.75, 1]).buffer).toString('hex');
  return {
    result: {
      boxes: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4, score: 0.9 }],
      personBoxes: [],
      embeddings: faceMatching ? [new Float32Array([0.25, -0.5, 0.75, 1])] : [],
      embeddingBoxes: [],
      features: {
        faceMatching,
        personDetection: options.personDetection ?? true,
        poseAnalysis: options.poseAnalysis ?? false,
        embeddingLimit: faceMatching ? 1 : 0,
        personFallback: options.personFallback ?? false,
        eyeDetail: options.eyeDetail ?? false,
        sportsSafeguards: options.sportsSafeguards ?? false,
      },
    },
    hexEmbeddings: faceMatching ? [embeddingHex] : [],
  };
}

function richFullAnalysisResult() {
  const boxes = [
    { x: 0.1, y: 0.2, width: 0.3, height: 0.4, score: 0.9 },
    { x: 0.55, y: 0.22, width: 0.25, height: 0.35, score: 0.86 },
  ];
  const embeddings = [
    new Float32Array([0.25, -0.5, 0.75, 1]),
    new Float32Array([-0.125, 0.375, 0.625, -0.875]),
  ];
  const poses = [{
    keypoints: Array.from({ length: 17 }, (_, index) => ({
      x: 0.12 + index * 0.01,
      y: 0.18 + index * 0.01,
      score: 0.8,
    })),
    score: 0.8,
  }];
  return {
    result: {
      boxes,
      personBoxes: [{ x: 0.05, y: 0.1, width: 0.45, height: 0.8, score: 0.92 }],
      embeddings,
      embeddingBoxes: boxes,
      poses,
      features: {
        faceMatching: true,
        personDetection: true,
        poseAnalysis: true,
        embeddingLimit: 2,
      },
    },
    hexEmbeddings: embeddings.map((embedding) => Buffer.from(embedding.buffer).toString('hex')),
  };
}

async function createPhoto(name: string, contents = name): Promise<string> {
  const filePath = path.join(cacheRoot, name);
  await writeFile(filePath, Buffer.from(contents));
  return filePath;
}

beforeAll(async () => {
  await mkdir(cacheRoot, { recursive: true });
  await writeFile(imagePath, Buffer.from('photo bytes'));
});

beforeEach(async () => {
  await clearFaceCache();
  delete process.env.KEPTRA_FACE_CACHE_MAX_ENTRIES;
  delete process.env.KEPTRA_FACE_CACHE_TARGET_ENTRIES;
  delete process.env.KEPTRA_FACE_CACHE_MAX_BYTES;
  delete process.env.KEPTRA_FACE_CACHE_TARGET_BYTES;
});

afterAll(async () => {
  await closeFaceCache();
  await rm(cacheRoot, { recursive: true, force: true });
});

describe('face-cache SQLite storage', () => {
  it('accepts scanner-captured identity without changing the cache key', async () => {
    const source = await stat(imagePath);
    const hint = { size: source.size, mtimeMs: source.mtimeMs };
    expect(await cacheKeyFor(imagePath, hint)).toBe(await cacheKeyFor(imagePath));

    const { result, hexEmbeddings } = analysisResult();
    await setCachedFaceResult(imagePath, result, hexEmbeddings, 'subjects', hint);
    await expect(getCachedFaceResult(imagePath, {
      analysisDepth: 'subjects',
      identity: hint,
    })).resolves.not.toBeNull();
  });

  it('returns a shallower record as an enrichment seed without satisfying a full read', async () => {
    const source = await stat(imagePath);
    const hint = { size: source.size, mtimeMs: source.mtimeMs };
    const { result, hexEmbeddings } = analysisResult({ personDetection: true });
    await setCachedFaceResult(imagePath, result, hexEmbeddings, 'subjects', hint);

    await expect(getCachedFaceResult(imagePath, {
      analysisDepth: 'full',
      identity: hint,
    })).resolves.toBeNull();
    const seed = await getBestCachedFaceResult(imagePath, hint);
    expect(seed?.result.boxes).toEqual(result.boxes);
    expect(seed?.result.features?.personDetection).toBe(true);
  });

  it('persists exact provenance and compact binary embeddings', async () => {
    const { result, hexEmbeddings } = analysisResult({ faceMatching: true });
    await setCachedFaceResult(imagePath, result, hexEmbeddings);

    const key = await cacheKeyFor(imagePath);
    const diagnostics = await getFaceCacheDiagnostics();
    expect(diagnostics.storageKind).toBe('sqlite');
    expect(diagnostics.entryCount).toBe(1);
    expect(diagnostics.maxEntries).toBeGreaterThanOrEqual(1_000_000);

    const database = new DatabaseSync(diagnostics.databasePath!);
    const persisted = database.prepare(`
      SELECT schema_version, pipeline_fingerprint, payload_json, embeddings
      FROM face_analysis_cache WHERE key = ?
    `).get(key!);
    database.close();

    expect(persisted?.schema_version).toBe(4);
    expect(persisted?.pipeline_fingerprint).toBe(FACE_PIPELINE_FINGERPRINT);
    expect(JSON.parse(String(persisted?.payload_json))).not.toHaveProperty('embeddings');
    expect(persisted?.embeddings).toBeInstanceOf(Uint8Array);

    await closeFaceCache(); // prove this is a disk hit, not the memory fast path
    const cached = await getCachedFaceResult(imagePath, { faceMatching: true });
    expect(cached?.hexEmbeddings).toEqual(hexEmbeddings);
    expect(Array.from(cached?.result.embeddings[0] ?? [])).toEqual([0.25, -0.5, 0.75, 1]);
  });

  it('does not claim a failed optional stage satisfies a required lookup', async () => {
    const { result, hexEmbeddings } = analysisResult();
    await setCachedFaceResult(imagePath, result, hexEmbeddings);

    await expect(getCachedFaceResult(imagePath, { personDetection: true })).resolves.not.toBeNull();
    await expect(getCachedFaceResult(imagePath, { faceMatching: true })).resolves.toBeNull();
    await expect(getCachedFaceResult(imagePath, { poseAnalysis: true })).resolves.toBeNull();
    await expect(getCachedFaceResult(imagePath, { personFallback: true })).resolves.toBeNull();
    await expect(getCachedFaceResult(imagePath, { eyeDetail: true })).resolves.toBeNull();
    await expect(getCachedFaceResult(imagePath, { sportsSafeguards: true })).resolves.toBeNull();
  });

  it('requires and persists eye-detail and sports-safeguard provenance', async () => {
    const { result, hexEmbeddings } = analysisResult({
      eyeDetail: true,
      sportsSafeguards: true,
    });
    await setCachedFaceResult(imagePath, result, hexEmbeddings, 'subjects');

    const cached = await getCachedFaceResult(imagePath, {
      analysisDepth: 'subjects',
      eyeDetail: true,
      sportsSafeguards: true,
    });
    expect(cached?.result.features).toMatchObject({
      eyeDetail: true,
      sportsSafeguards: true,
    });
  });

  it('persists alternate-person fallback provenance and prevents its regression', async () => {
    const { result, hexEmbeddings } = analysisResult({ personFallback: true });
    await setCachedFaceResult(imagePath, result, hexEmbeddings, 'subjects');

    const withoutFallback = {
      ...result,
      features: { ...result.features!, personFallback: false },
    };
    await setCachedFaceResult(imagePath, withoutFallback, hexEmbeddings, 'subjects');
    await closeFaceCache();

    const cached = await getCachedFaceResult(imagePath, {
      analysisDepth: 'subjects',
      personFallback: true,
    });
    expect(cached?.result.features?.personFallback).toBe(true);
  });

  it('never lets a shallower cascade result satisfy or overwrite a deeper one', async () => {
    const { result: fullResult, hexEmbeddings } = analysisResult({ faceMatching: true });
    await setCachedFaceResult(imagePath, fullResult, hexEmbeddings, 'full');

    const detectResult = {
      ...fullResult,
      embeddings: [],
      features: {
        faceMatching: false,
        personDetection: false,
        poseAnalysis: false,
        embeddingLimit: 0,
      },
    };
    await setCachedFaceResult(imagePath, detectResult, [], 'detect');
    await closeFaceCache();

    const full = await getCachedFaceResult(imagePath, {
      analysisDepth: 'full',
      faceMatching: true,
    });
    expect(full?.hexEmbeddings).toEqual(hexEmbeddings);
  });

  it('keeps a deeper result when pending writes for one key are coalesced', async () => {
    const { result: fullResult, hexEmbeddings } = analysisResult({ faceMatching: true });
    const detectResult = {
      ...fullResult,
      embeddings: [],
      features: {
        faceMatching: false,
        personDetection: false,
        poseAnalysis: false,
        embeddingLimit: 0,
      },
    };

    // Deliberately do not await the first write. Both entries must occupy the
    // same pending batch for this to exercise the in-memory coalescer instead
    // of SQLite's independent UPSERT guard.
    const fullWrite = setCachedFaceResult(imagePath, fullResult, hexEmbeddings, 'full');
    const detectWrite = setCachedFaceResult(imagePath, detectResult, [], 'detect');
    await Promise.all([fullWrite, detectWrite]);
    await closeFaceCache();

    const cached = await getCachedFaceResult(imagePath, {
      analysisDepth: 'full',
      faceMatching: true,
    });
    expect(cached?.hexEmbeddings).toEqual(hexEmbeddings);
  });

  it('keeps richer equal-depth features when pending writes are coalesced', async () => {
    const { result: richResult, hexEmbeddings } = richFullAnalysisResult();
    const partialResult = {
      ...richResult,
      embeddings: [],
      embeddingBoxes: [],
      personBoxes: [],
      features: {
        faceMatching: false,
        personDetection: false,
        poseAnalysis: false,
        embeddingLimit: 0,
      },
    };

    const richWrite = setCachedFaceResult(imagePath, richResult, hexEmbeddings, 'full');
    const partialWrite = setCachedFaceResult(imagePath, partialResult, [], 'full');
    await Promise.all([richWrite, partialWrite]);

    const cached = await getCachedFaceResult(imagePath, {
      analysisDepth: 'full',
      faceMatching: true,
      personDetection: true,
      poseAnalysis: true,
    });
    expect(cached?.hexEmbeddings).toEqual(hexEmbeddings);
    expect(cached?.result.features).toMatchObject({
      faceMatching: true,
      personDetection: true,
      poseAnalysis: true,
      embeddingLimit: 2,
    });
  });

  it('rejects an equal-depth feature regression already persisted in SQLite', async () => {
    const { result: richResult, hexEmbeddings } = richFullAnalysisResult();
    await setCachedFaceResult(imagePath, richResult, hexEmbeddings, 'full');
    await closeFaceCache();

    const partialResult = {
      ...richResult,
      personBoxes: [],
      features: {
        ...richResult.features,
        personDetection: false,
        poseAnalysis: false,
      },
    };
    await setCachedFaceResult(imagePath, partialResult, hexEmbeddings, 'full');

    // The rejected disk write must also restore the richer entry in memory;
    // callers should not need an app restart to see monotonic cache evidence.
    const immediate = await getCachedFaceResult(imagePath, {
      analysisDepth: 'full',
      personDetection: true,
      poseAnalysis: true,
    });
    expect(immediate?.result.personBoxes).toEqual(richResult.personBoxes);
    expect(immediate?.result.features?.poseAnalysis).toBe(true);

    await closeFaceCache();
    await expect(getCachedFaceResult(imagePath, {
      analysisDepth: 'full',
      personDetection: true,
      poseAnalysis: true,
    })).resolves.not.toBeNull();
  });

  it('never replaces equal-depth cache evidence with fewer embeddings', async () => {
    const { result: richResult, hexEmbeddings } = richFullAnalysisResult();
    await setCachedFaceResult(imagePath, richResult, hexEmbeddings, 'full');
    await closeFaceCache();

    const fewerEmbeddings = {
      ...richResult,
      embeddings: richResult.embeddings.slice(0, 1),
      embeddingBoxes: richResult.embeddingBoxes.slice(0, 1),
      // Keep the same completed feature vector and requested budget so this
      // specifically exercises actual stored embedding-count monotonicity.
      features: { ...richResult.features },
    };
    await setCachedFaceResult(imagePath, fewerEmbeddings, hexEmbeddings.slice(0, 1), 'full');

    const cached = await getCachedFaceResult(imagePath, {
      analysisDepth: 'full',
      faceMatching: true,
      embeddingLimit: 2,
    });
    expect(cached?.hexEmbeddings).toEqual(hexEmbeddings);

    await closeFaceCache();
    const persisted = await getCachedFaceResult(imagePath, {
      analysisDepth: 'full',
      faceMatching: true,
      embeddingLimit: 2,
    });
    expect(persisted?.hexEmbeddings).toEqual(hexEmbeddings);
  });

  it('merges independently completed eye, body, pose, and embedding evidence', async () => {
    const subjectResult = analysisResult({
      personDetection: true,
      eyeDetail: true,
      sportsSafeguards: true,
    }).result;
    subjectResult.boxes[0] = { ...subjectResult.boxes[0], eyeScore: 2, eyeSharpness: 0.82 };
    subjectResult.personBoxes = [{ x: 0.08, y: 0.1, width: 0.5, height: 0.82, score: 0.94 }];
    subjectResult.poses = [{
      keypoints: Array.from({ length: 17 }, (_, index) => ({
        x: 0.2 + index * 0.01,
        y: 0.25 + index * 0.01,
        score: 0.8,
      })),
      score: 0.8,
    }];
    subjectResult.features!.poseAnalysis = true;
    await setCachedFaceResult(imagePath, subjectResult, [], 'subjects');

    const richerIdentity = analysisResult({ faceMatching: true, personDetection: true }).result;
    richerIdentity.boxes = subjectResult.boxes.map(({ eyeScore: _eyeScore, eyeSharpness: _eyeSharpness, ...box }) => box);
    // A seeded full enrichment preserves the already completed subject stage;
    // the cache must keep the same canonical boxes and transfer richer pose or
    // eye annotations by box alignment.
    richerIdentity.personBoxes = subjectResult.personBoxes.map((box) => ({ ...box }));
    richerIdentity.poses = subjectResult.poses;
    richerIdentity.features = {
      ...richerIdentity.features!,
      eyeDetail: true,
      poseAnalysis: true,
    };
    const embeddingHex = Buffer.from(richerIdentity.embeddings[0].buffer).toString('hex');
    await setCachedFaceResult(imagePath, richerIdentity, [embeddingHex], 'full');
    await closeFaceCache();

    const cached = await getCachedFaceResult(imagePath, {
      analysisDepth: 'full',
      faceMatching: true,
      personDetection: true,
      poseAnalysis: true,
      eyeDetail: true,
      sportsSafeguards: true,
    });
    expect(cached?.result.boxes[0]).toMatchObject({ eyeScore: 2, eyeSharpness: 0.82 });
    expect(cached?.result.personBoxes).toHaveLength(1);
    expect(cached?.result.poses?.[0].keypoints).toHaveLength(17);
    expect(cached?.hexEmbeddings).toEqual([embeddingHex]);
  });

  it('keeps the newest detector set, transfers matched eye evidence, and suppresses jittered bodies', async () => {
    const first = analysisResult({ personDetection: true, eyeDetail: true }).result;
    first.boxes = [
      { x: 0.1, y: 0.1, width: 0.12, height: 0.18, score: 0.91, eyeScore: 2 },
      // A stale false positive must disappear when the next completed detector
      // pass no longer returns it.
      { x: 0.42, y: 0.04, width: 0.08, height: 0.08, score: 0.71 },
    ];
    first.personBoxes = [{ x: 0.1, y: 0.08, width: 0.4, height: 0.82, score: 0.8 }];
    await setCachedFaceResult(imagePath, first, [], 'subjects');

    const second = analysisResult({ personDetection: true, eyeDetail: true }).result;
    second.boxes = [
      { x: 0.11, y: 0.1, width: 0.12, height: 0.18, score: 0.94 },
      { x: 0.72, y: 0.12, width: 0.1, height: 0.16, score: 0.88 },
    ];
    second.personBoxes = [{ x: 0.13, y: 0.1, width: 0.41, height: 0.8, score: 0.93 }];
    await setCachedFaceResult(imagePath, second, [], 'subjects');
    await closeFaceCache();

    const cached = await getCachedFaceResult(imagePath, {
      analysisDepth: 'subjects', personDetection: true, eyeDetail: true,
    });
    expect(cached?.result.boxes).toHaveLength(2);
    expect(cached?.result.boxes[0].eyeScore).toBe(2);
    expect(cached?.result.personBoxes).toHaveLength(1);
    expect(cached?.result.personBoxes[0].score).toBe(0.93);
  });

  it('invalidates pose completion when a newer body pass adds an unposed primary athlete', async () => {
    const posed = analysisResult({ personDetection: true }).result;
    posed.personBoxes = [{ x: 0.1, y: 0.1, width: 0.32, height: 0.72, score: 0.91 }];
    posed.poses = [{
      keypoints: Array.from({ length: 17 }, (_, index) => ({
        x: 0.15 + index * 0.01,
        y: 0.2 + index * 0.01,
        score: 0.8,
      })),
      score: 0.8,
    }];
    posed.features!.poseAnalysis = true;
    await setCachedFaceResult(imagePath, posed, [], 'full');

    const redetected = analysisResult({ personDetection: true }).result;
    redetected.personBoxes = [
      { ...posed.personBoxes[0] },
      { x: 0.38, y: 0.06, width: 0.5, height: 0.9, score: 0.98 },
    ];
    redetected.poses = undefined;
    redetected.features!.poseAnalysis = false;
    await setCachedFaceResult(imagePath, redetected, [], 'full');

    await expect(getCachedFaceResult(imagePath, {
      analysisDepth: 'full',
      personDetection: true,
      poseAnalysis: true,
    })).resolves.toBeNull();
  });

  it('lets a shallower sports pass enrich an existing full record without lowering depth', async () => {
    const full = analysisResult({ faceMatching: true, personDetection: true });
    await setCachedFaceResult(imagePath, full.result, full.hexEmbeddings, 'full');

    const sports = analysisResult({
      personDetection: true,
      personFallback: true,
      eyeDetail: true,
      sportsSafeguards: true,
    });
    sports.result.personBoxes = [{ x: 0.12, y: 0.08, width: 0.55, height: 0.86, score: 0.91 }];
    await setCachedFaceResult(imagePath, sports.result, sports.hexEmbeddings, 'subjects');
    await closeFaceCache();

    const cached = await getCachedFaceResult(imagePath, {
      analysisDepth: 'full',
      faceMatching: true,
      sportsSafeguards: true,
      personFallback: true,
    });
    expect(cached?.result.personBoxes).toHaveLength(1);
    expect(cached?.hexEmbeddings).toEqual(full.hexEmbeddings);
  });

  it('requires a profile upgrade when only a shallow result is cached', async () => {
    const { result } = analysisResult({ personDetection: false });
    await setCachedFaceResult(imagePath, result, [], 'detect');

    await expect(getCachedFaceResult(imagePath, { analysisDepth: 'detect' })).resolves.not.toBeNull();
    await expect(getCachedFaceResult(imagePath, { analysisDepth: 'subjects' })).resolves.toBeNull();
    await expect(getCachedFaceResult(imagePath, { analysisDepth: 'full' })).resolves.toBeNull();
  });

  it('batches concurrent writes atomically', async () => {
    const photos = await Promise.all(Array.from({ length: 64 }, (_, index) => (
      createPhoto(`batch-${index}.jpg`)
    )));
    const { result, hexEmbeddings } = analysisResult({ faceMatching: true });
    await Promise.all(photos.map((photo) => setCachedFaceResult(photo, result, hexEmbeddings)));

    const diagnostics = await getFaceCacheDiagnostics();
    expect(diagnostics.entryCount).toBe(64);
    expect(diagnostics.pendingWrites).toBe(0);
    for (const photo of photos.slice(0, 4)) {
      await expect(getCachedFaceResult(photo, { faceMatching: true })).resolves.not.toBeNull();
    }
  });

  it('treats a corrupt row as a miss and removes it', async () => {
    const corruptPhoto = await createPhoto('corrupt.jpg');
    const { result, hexEmbeddings } = analysisResult({ faceMatching: true });
    await setCachedFaceResult(corruptPhoto, result, hexEmbeddings);
    const key = await cacheKeyFor(corruptPhoto);
    const diagnostics = await getFaceCacheDiagnostics();
    await closeFaceCache();

    const database = new DatabaseSync(diagnostics.databasePath!);
    database.prepare('UPDATE face_analysis_cache SET payload_json = ? WHERE key = ?')
      .run('{not-json', key!);
    database.close();

    await expect(getCachedFaceResult(corruptPhoto)).resolves.toBeNull();
    expect((await getFaceCacheDiagnostics()).entryCount).toBe(0);
  });

  it('lazily migrates a valid legacy JSON record', async () => {
    const legacyPhoto = await createPhoto('legacy.jpg');
    const key = await cacheKeyFor(legacyPhoto);
    const fileStat = await import('node:fs/promises').then(({ stat }) => stat(legacyPhoto));
    const legacyFile = path.join(cacheRoot, 'face-cache', key!.slice(0, 2), `${key}.json`);
    await mkdir(path.dirname(legacyFile), { recursive: true });
    const { result } = analysisResult();
    await writeFile(legacyFile, JSON.stringify({
      v: 4,
      pipelineFingerprint: FACE_PIPELINE_FINGERPRINT,
      key,
      path: legacyPhoto,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      cachedAt: Date.now(),
      boxes: result.boxes,
      personBoxes: result.personBoxes,
      embeddings: [],
      embeddingBoxes: result.embeddingBoxes,
      features: result.features,
    }));

    await expect(getCachedFaceResult(legacyPhoto, { personDetection: true })).resolves.not.toBeNull();
    await expect(readFile(legacyFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await getFaceCacheDiagnostics()).entryCount).toBe(1);
  });

  it('prunes least-recently-used entries to configured maintenance bounds', async () => {
    const photos = await Promise.all(Array.from({ length: 6 }, (_, index) => (
      createPhoto(`prune-${index}.jpg`)
    )));
    const { result, hexEmbeddings } = analysisResult();
    for (const photo of photos) await setCachedFaceResult(photo, result, hexEmbeddings);

    const stats = await maintainFaceCache({
      maxEntries: 3,
      targetEntries: 2,
      maxPayloadBytes: Number.MAX_SAFE_INTEGER,
      targetPayloadBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(stats.entryCount).toBe(2);
  });

  it('supports release/operator limits without changing cache correctness', async () => {
    process.env.KEPTRA_FACE_CACHE_MAX_ENTRIES = '3';
    process.env.KEPTRA_FACE_CACHE_TARGET_ENTRIES = '2';
    const photos = await Promise.all(Array.from({ length: 4 }, (_, index) => (
      createPhoto(`configured-prune-${index}.jpg`)
    )));
    const { result, hexEmbeddings } = analysisResult();
    for (const photo of photos) await setCachedFaceResult(photo, result, hexEmbeddings);

    expect((await maintainFaceCache()).entryCount).toBe(2);
    expect((await getFaceCacheDiagnostics()).maxEntries).toBe(3);
  });

  it('clears both SQLite and legacy records', async () => {
    const { result, hexEmbeddings } = analysisResult();
    await setCachedFaceResult(imagePath, result, hexEmbeddings);
    const legacyFile = path.join(cacheRoot, 'face-cache', 'aa', `${'a'.repeat(32)}.json`);
    await mkdir(path.dirname(legacyFile), { recursive: true });
    await writeFile(legacyFile, '{}');

    await clearFaceCache();
    expect((await getFaceCacheDiagnostics()).entryCount).toBe(0);
    await expect(readFile(legacyFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
