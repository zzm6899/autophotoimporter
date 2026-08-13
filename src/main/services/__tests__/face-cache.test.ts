import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
import { cacheKeyFor, getCachedFaceResult, setCachedFaceResult } from '../face-cache';

const imagePath = path.join(cacheRoot, 'photo.jpg');

beforeAll(async () => {
  await mkdir(cacheRoot, { recursive: true });
  await writeFile(imagePath, Buffer.from('photo bytes'));
});

afterAll(async () => {
  await rm(cacheRoot, { recursive: true, force: true });
});

describe('face-cache provenance and stage semantics', () => {
  it('persists the exact pipeline fingerprint with an inference result', async () => {
    const result = {
      boxes: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4, score: 0.9 }],
      personBoxes: [],
      embeddings: [],
      embeddingBoxes: [],
      features: {
        faceMatching: false,
        personDetection: true,
        poseAnalysis: false,
        embeddingLimit: 0,
      },
    };
    await setCachedFaceResult(imagePath, result, []);

    const key = await cacheKeyFor(imagePath);
    expect(key).not.toBeNull();
    const file = path.join(cacheRoot, 'face-cache', key!.slice(0, 2), `${key}.json`);
    const persisted = JSON.parse(await readFile(file, 'utf8')) as {
      v: number;
      pipelineFingerprint: string;
    };
    expect(persisted.v).toBe(4);
    expect(persisted.pipelineFingerprint).toBe(FACE_PIPELINE_FINGERPRINT);
  });

  it('does not claim a failed optional stage satisfies a required lookup', async () => {
    await expect(getCachedFaceResult(imagePath, { personDetection: true })).resolves.not.toBeNull();
    await expect(getCachedFaceResult(imagePath, { faceMatching: true })).resolves.toBeNull();
    await expect(getCachedFaceResult(imagePath, { poseAnalysis: true })).resolves.toBeNull();
  });
});
