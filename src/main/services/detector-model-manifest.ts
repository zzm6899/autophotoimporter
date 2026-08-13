/**
 * Pinned, opt-in detector candidates that are safe to evaluate separately
 * from the production face/person pipeline.
 *
 * A manifest entry is not an accuracy approval. New detectors must pass the
 * labelled golden corpus before `face-engine.ts` may select one by default.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import manifestJson from './detector-model-manifest.json';

export type DetectorCandidateId =
  | 'yunet-2023mar-fp32'
  | 'nanodet-2022nov-fp32'
  | 'yolox-s-2022nov-fp32';

export type DetectorCandidateRole = 'face' | 'object';
export type DetectorCandidateDecoder = 'yunet-v1' | 'nanodet-plus-gfl-v1' | 'yolox-v1';

export interface DetectorCandidateModel {
  readonly id: DetectorCandidateId;
  readonly displayName: string;
  readonly fileName: string;
  readonly role: DetectorCandidateRole;
  readonly capabilities: readonly string[];
  readonly format: 'onnx';
  readonly precision: 'fp32';
  readonly input: {
    readonly type: 'float32';
    readonly layout: 'nchw';
    readonly dimensions: readonly [number, number, number, number];
    readonly colourOrder: 'rgb' | 'bgr';
    readonly resize: 'letterbox' | 'letterbox-top-left';
  };
  readonly decoder: DetectorCandidateDecoder;
  readonly personClassId?: number;
  readonly sha256: string;
  readonly bytes: number;
  readonly sourceRevision: string;
  readonly sourceUrl: string;
  readonly projectUrl: string;
  readonly license: 'MIT' | 'Apache-2.0';
  readonly licenseUrl: string;
  readonly redistribution: 'candidate-approved';
  readonly bundledByDefault: false;
}

export interface DetectorCandidateManifest {
  readonly schemaVersion: 1;
  readonly status: 'evaluation-only';
  readonly goldenCorpusRequired: true;
  readonly models: readonly DetectorCandidateModel[];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function assertManifest(value: unknown): asserts value is DetectorCandidateManifest {
  const manifest = value as Partial<DetectorCandidateManifest> | null;
  if (!manifest || manifest.schemaVersion !== 1 || manifest.status !== 'evaluation-only' ||
      manifest.goldenCorpusRequired !== true || !Array.isArray(manifest.models)) {
    throw new Error('Invalid detector candidate manifest header');
  }
  const ids = new Set<string>();
  const files = new Set<string>();
  for (const candidate of manifest.models as DetectorCandidateModel[]) {
    if (!candidate.id || ids.has(candidate.id)) throw new Error(`Duplicate detector candidate id: ${candidate.id}`);
    if (!candidate.fileName || files.has(candidate.fileName)) {
      throw new Error(`Duplicate detector candidate file: ${candidate.fileName}`);
    }
    if (!/^[a-f0-9]{64}$/.test(candidate.sha256)) {
      throw new Error(`Invalid detector candidate digest: ${candidate.id}`);
    }
    if (!/^[a-f0-9]{40}$/.test(candidate.sourceRevision) ||
        !candidate.sourceUrl.includes(candidate.sourceRevision)) {
      throw new Error(`Detector candidate source is not revision-pinned: ${candidate.id}`);
    }
    if (!candidate.sourceUrl.startsWith('https://') || !candidate.licenseUrl.startsWith('https://')) {
      throw new Error(`Detector candidate provenance must use HTTPS: ${candidate.id}`);
    }
    if (candidate.bytes <= 0 || candidate.bundledByDefault !== false ||
        candidate.redistribution !== 'candidate-approved') {
      throw new Error(`Invalid detector candidate release policy: ${candidate.id}`);
    }
    ids.add(candidate.id);
    files.add(candidate.fileName);
  }
}

assertManifest(manifestJson);
export const DETECTOR_CANDIDATE_MANIFEST: DetectorCandidateManifest = deepFreeze(manifestJson);
export const DETECTOR_CANDIDATE_MODELS = DETECTOR_CANDIDATE_MANIFEST.models;

export function getDetectorCandidate(id: DetectorCandidateId): DetectorCandidateModel {
  const candidate = DETECTOR_CANDIDATE_MODELS.find((entry) => entry.id === id);
  if (!candidate) throw new Error(`Unknown detector candidate: ${id}`);
  return candidate;
}

export async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export async function verifyDetectorCandidateFile(
  candidate: DetectorCandidateModel,
  filePath: string,
): Promise<boolean> {
  if (!existsSync(filePath)) return false;
  try {
    if (statSync(filePath).size !== candidate.bytes) return false;
    return await sha256File(filePath) === candidate.sha256;
  } catch {
    return false;
  }
}
