import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DETECTOR_CANDIDATE_MANIFEST,
  DETECTOR_CANDIDATE_MODELS,
  PRODUCTION_FAST_DETECTOR_MODELS,
  PRODUCTION_FAST_DETECTOR_FINGERPRINT,
  getDetectorCandidate,
  verifyDetectorCandidateFile,
  type DetectorCandidateModel,
} from '../detector-model-manifest';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('detector candidate manifest', () => {
  it('pins the promoted pair while keeping other alternatives unbundled', () => {
    expect(DETECTOR_CANDIDATE_MANIFEST.status).toBe('mixed');
    expect(DETECTOR_CANDIDATE_MANIFEST.legacyFallbackRemovalRequiresGoldenCorpus).toBe(true);
    expect(Object.isFrozen(DETECTOR_CANDIDATE_MANIFEST)).toBe(true);

    const ids = new Set<string>();
    const files = new Set<string>();
    for (const candidate of DETECTOR_CANDIDATE_MODELS) {
      const promoted = candidate.id === PRODUCTION_FAST_DETECTOR_MODELS.face.id ||
        candidate.id === PRODUCTION_FAST_DETECTOR_MODELS.person.id;
      expect(candidate.bundledByDefault).toBe(promoted);
      expect(candidate.redistribution).toBe('artifact-license-recorded');
      expect(candidate.sourceUrl).toContain(candidate.sourceRevision);
      expect(candidate.sourceUrl).toMatch(/^https:\/\//);
      expect(candidate.licenseUrl).toMatch(/^https:\/\//);
      expect(candidate.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(candidate.bytes).toBeGreaterThan(0);
      expect(ids.has(candidate.id)).toBe(false);
      expect(files.has(candidate.fileName)).toBe(false);
      ids.add(candidate.id);
      files.add(candidate.fileName);
    }
    expect(PRODUCTION_FAST_DETECTOR_MODELS.face.decoder).toBe('yunet-v1');
    expect(PRODUCTION_FAST_DETECTOR_MODELS.person.decoder).toBe('nanodet-plus-gfl-v1');
    expect(PRODUCTION_FAST_DETECTOR_FINGERPRINT).toContain(
      PRODUCTION_FAST_DETECTOR_MODELS.face.sha256,
    );
    expect(PRODUCTION_FAST_DETECTOR_FINGERPRINT).toContain(
      PRODUCTION_FAST_DETECTOR_MODELS.person.sha256,
    );
  });

  it('resolves only a known typed candidate', () => {
    expect(getDetectorCandidate('nanodet-2022nov-fp32').decoder).toBe('nanodet-plus-gfl-v1');
    expect(() => getDetectorCandidate('unknown' as never)).toThrow('Unknown detector candidate');
  });

  it('requires both exact size and SHA-256 before a candidate is usable', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'keptra-detector-manifest-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'candidate.onnx');
    const payload = Buffer.from('detector-candidate-test');
    await writeFile(filePath, payload);
    const base = getDetectorCandidate('yunet-2023mar-fp32');
    const candidate: DetectorCandidateModel = {
      ...base,
      bytes: payload.length,
      sha256: createHash('sha256').update(payload).digest('hex'),
    };

    await expect(verifyDetectorCandidateFile(candidate, filePath)).resolves.toBe(true);
    await writeFile(filePath, Buffer.from('tampered'));
    await expect(verifyDetectorCandidateFile(candidate, filePath)).resolves.toBe(false);
  });
});
