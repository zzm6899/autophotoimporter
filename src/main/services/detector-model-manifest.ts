/**
 * Pinned alternative detectors, including the explicitly promoted fast pass.
 *
 * A catalogue entry is not an accuracy approval. Only ids named by the
 * productionFastPass policy may enter automatic culling, and then only after
 * the exact byte size and digest below have been verified. Every other entry
 * remains evaluation-only.
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
  /** Describes recorded artifact licensing, not training-data legal approval. */
  readonly redistribution: 'artifact-license-recorded';
  readonly bundledByDefault: boolean;
}

export interface DetectorCandidateManifest {
  readonly schemaVersion: 2;
  readonly status: 'mixed';
  /** Fast detectors may run inside the conservative cascade, but legacy
   * fallbacks and candidate-only manual holds cannot be removed without a
   * versioned labelled-corpus report. */
  readonly legacyFallbackRemovalRequiresGoldenCorpus: true;
  readonly productionFastPass: {
    readonly policyVersion: 1;
    readonly activation: 'verified-weight-or-legacy-fallback';
    readonly faceCandidateId: DetectorCandidateId;
    readonly personCandidateId: DetectorCandidateId;
    readonly faceFallback: 'version-RFB-640.onnx';
    readonly personFallback: 'ssd_mobilenet_v1_12.onnx';
    readonly selectionPolicy: 'selective-fallback-v1';
  };
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
  if (!manifest || manifest.schemaVersion !== 2 || manifest.status !== 'mixed' ||
      manifest.legacyFallbackRemovalRequiresGoldenCorpus !== true || !manifest.productionFastPass ||
      !Array.isArray(manifest.models)) {
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
    if (candidate.bytes <= 0 || typeof candidate.bundledByDefault !== 'boolean' ||
        candidate.redistribution !== 'artifact-license-recorded') {
      throw new Error(`Invalid detector candidate release policy: ${candidate.id}`);
    }
    ids.add(candidate.id);
    files.add(candidate.fileName);
  }
  const production = manifest.productionFastPass;
  const face = (manifest.models as DetectorCandidateModel[])
    .find((candidate) => candidate.id === production.faceCandidateId);
  const person = (manifest.models as DetectorCandidateModel[])
    .find((candidate) => candidate.id === production.personCandidateId);
  if (production.policyVersion !== 1 ||
      production.activation !== 'verified-weight-or-legacy-fallback' ||
      production.selectionPolicy !== 'selective-fallback-v1' ||
      production.faceFallback !== 'version-RFB-640.onnx' ||
      production.personFallback !== 'ssd_mobilenet_v1_12.onnx' ||
      face?.role !== 'face' || face.decoder !== 'yunet-v1' ||
      face.bundledByDefault !== true ||
      !face.capabilities.includes('face-landmarks-5') ||
      person?.role !== 'object' || person.decoder !== 'nanodet-plus-gfl-v1' ||
      person.bundledByDefault !== true ||
      !person.capabilities.includes('person-boxes')) {
    throw new Error('Invalid production fast detector policy');
  }
}

assertManifest(manifestJson);
export const DETECTOR_CANDIDATE_MANIFEST: DetectorCandidateManifest = deepFreeze(manifestJson);
export const DETECTOR_CANDIDATE_MODELS = DETECTOR_CANDIDATE_MANIFEST.models;

export type ProductionFastDetectorRole = 'face' | 'person';

/** The only two alternative weights approved for the production cascade. */
export const PRODUCTION_FAST_DETECTOR_MODELS: Readonly<Record<
  ProductionFastDetectorRole,
  DetectorCandidateModel
>> = deepFreeze({
  face: getDetectorCandidateFromManifest(
    DETECTOR_CANDIDATE_MANIFEST.productionFastPass.faceCandidateId,
  ),
  person: getDetectorCandidateFromManifest(
    DETECTOR_CANDIDATE_MANIFEST.productionFastPass.personCandidateId,
  ),
});

export const PRODUCTION_FAST_DETECTOR_FINGERPRINT = [
  `fast-detectors-v${DETECTOR_CANDIDATE_MANIFEST.productionFastPass.policyVersion}`,
  DETECTOR_CANDIDATE_MANIFEST.productionFastPass.selectionPolicy,
  ...(['face', 'person'] as const).map((role) => {
    const model = PRODUCTION_FAST_DETECTOR_MODELS[role];
    return `${role}:${model.id}:${model.sha256}`;
  }),
].join('|');

function getDetectorCandidateFromManifest(id: DetectorCandidateId): DetectorCandidateModel {
  const candidate = DETECTOR_CANDIDATE_MODELS.find((entry) => entry.id === id);
  if (!candidate) throw new Error(`Unknown detector candidate: ${id}`);
  return candidate;
}

export function getDetectorCandidate(id: DetectorCandidateId): DetectorCandidateModel {
  return getDetectorCandidateFromManifest(id);
}

export function getProductionFastDetector(role: ProductionFastDetectorRole): DetectorCandidateModel {
  return PRODUCTION_FAST_DETECTOR_MODELS[role];
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
