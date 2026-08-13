/**
 * face-engine.ts
 *
 * Main-process face detection + embedding service using onnxruntime-node.
 *
 * Pipeline per image:
 *   1. UltraFace-slim-640  → bounding boxes for each detected face
 *   2. OpenCV SFace         → L2-normalised embedding per face crop
 *
 * The strongest embeddings can be stored on MediaFile.faceEmbeddings and used
 * to cluster similar faces across a session via cosine similarity. This
 * replaces the old pixel-hash faceSignature with real identity matching that
 * is robust to lighting/angle/JPEG compression changes.
 *
 * Usage:
 *   const result = await analyzeFaces('/path/to/photo.jpg');
 *   // result.boxes   — face bounding boxes normalised 0..1
 *   // result.embeddings — 512-d Float32Array per embedded face
 *
 * Session management:
 *   Sessions are loaded lazily on first call and reused for the process
 *   lifetime. Call disposeFaceEngine() before quitting if you need clean
 *   shutdown, but Electron's process exit handles it automatically.
 */

import path from 'node:path';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile, stat as statFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { app } from 'electron';
import { log } from '../logger';
import { disposePoseEngine, estimatePosesDetailed, isPoseAnalysisEnabled } from './pose-engine';
import {
  disposeImagePreprocessSupervisor,
  clearImagePreprocessQuarantine,
  getImagePreprocessSupervisor,
  getImagePreprocessSupervisorDiagnostics,
  ImagePreprocessError,
  type PreparedImagePayload,
  type PreparedPersonTensor,
} from './image-preprocess-supervisor';
import {
  FACE_MODEL_IDENTITIES,
  FACE_PIPELINE_FINGERPRINT,
  type FaceModelRole,
} from './face-model-manifest';
import type { PoseKeypoints } from '../../shared/types';
import {
  DetectorCandidateRuntime,
  type CandidateDetection,
  type NanoDetDecodeOptions,
  type PreparedDetectorInput,
} from './detector-candidate-runtime';
import {
  PRODUCTION_FAST_DETECTOR_FINGERPRINT,
  getProductionFastDetector,
  type ProductionFastDetectorRole,
} from './detector-model-manifest';

// onnxruntime-node is a native addon — it must be outside the asar.
// The forge config sets unpackDir for it. Require at runtime to avoid
// Vite trying to bundle it (it's CJS with a native .node binary).
type OrtModule = {
  InferenceSession: {
    create: (modelPath: string, options: Record<string, unknown>) => Promise<any>;
  };
  Tensor: new (type: string, data: Float32Array | Uint8Array, dims: number[]) => any;
};

let ort: OrtModule | null = null;

function getOrt(): OrtModule {
  if (!ort) {
    // In a packaged app, onnxruntime-node is unpacked to app.asar.unpacked by
    // @electron-forge/plugin-auto-unpack-natives. We must require it via the
    // absolute filesystem path so Node can dlopen the native .node binary —
    // a bare require('onnxruntime-node') resolves into the asar bundle and fails.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app: electronApp } = require('electron') as typeof import('electron');
    if (electronApp.isPackaged) {
      // onnxruntime-node is copied as an extraResource into resources/onnxruntime-node/
      // This is the only reliable way to ship a native addon with Vite + electron-forge,
      // since Vite externalizes the module so asar unpackDir never fires.
      const ortPath = path.join(process.resourcesPath, 'onnxruntime-node', 'dist', 'index.js');
      if (existsSync(ortPath)) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        ort = require(ortPath) as OrtModule;
      } else {
        throw new Error(
          `onnxruntime-node not found at expected resource path.\n` +
          `Tried: ${ortPath}`,
        );
      }
    } else {
      // Dev mode — normal resolution works fine
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      ort = require('onnxruntime-node') as OrtModule;
    }
  }
  return ort;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FaceBox {
  /** Normalised coordinates, 0..1 relative to image dimensions */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Detection confidence score 0..1 */
  score: number;
  /** Number of expected eye regions (0-2) with usable local detail. */
  eyeScore?: number;
  /** Normalized 0..1 sharpness/contrast signal across both eye regions. */
  eyeSharpness?: number;
}

export interface FaceLandmarkPoint {
  x: number;
  y: number;
}

export type FaceLandmarks = readonly [
  FaceLandmarkPoint,
  FaceLandmarkPoint,
  FaceLandmarkPoint,
  FaceLandmarkPoint,
  FaceLandmarkPoint,
];

export interface FaceAnalysisResult {
  /** Detected face bounding boxes (may be empty if no faces found) */
  boxes: FaceBox[];
  /** Detected person/body bounding boxes (may be empty if no people found) */
  personBoxes: FaceBox[];
  /**
   * L2-normalised embeddings for the strongest usable detected faces.
   * Use embeddingBoxes to map each embedding back to its detected crop.
   */
  embeddings: Float32Array[];
  /** Face boxes corresponding 1:1 with embeddings. */
  embeddingBoxes?: FaceBox[];
  /** One entry per face box; null marks a legacy-detector or merged fallback box. */
  faceLandmarks?: Array<FaceLandmarks | null>;
  /**
   * Optional per-athlete pose keypoints (MoveNet) — present only when pose
   * analysis is enabled and the model is installed. Aligned to personBoxes.
   */
  poses?: PoseKeypoints[];
  /** Feature stages that were actually completed for this result. */
  features?: {
    faceMatching: boolean;
    personDetection: boolean;
    poseAnalysis: boolean;
    embeddingLimit: number;
    /** Internal resume marker: subject-profile eye sampling has completed. */
    eyeDetail?: boolean;
    /** Opt-in sports disagreement fallback was available and evaluated. */
    personFallback?: boolean;
    /** Sports zero-evidence/disagreement safeguards were actually evaluated. */
    sportsSafeguards?: boolean;
    /** True only when the alternate SSD pass itself returned person evidence. */
    personFallbackCorroborated?: boolean;
    /** True when SSD was executed, including a valid zero-detection result. */
    personFallbackExecuted?: boolean;
    /** True only when the paired, digest-verified YuNet fast pass produced the face stage. */
    fastFaceDetection?: boolean;
    /** True only when the paired, digest-verified NanoDet fast pass produced the person stage. */
    fastPersonDetection?: boolean;
    /** True when at least one retained face has a complete YuNet five-point set. */
    faceLandmarks?: boolean;
    /** Exact detector ids used to produce the returned boxes. */
    faceDetectorId?: string;
    personDetectorId?: string;
    /** Policy + model-digest identity for cache/provenance decisions. */
    detectorPipelineFingerprint?: string;
  };
}

/**
 * Per-request analysis depth. This lets the review pipeline cascade from a
 * very cheap screen into richer subject analysis without changing the user's
 * global feature settings or reloading ONNX sessions between requests.
 */
export type FaceAnalysisProfile = 'detect' | 'subjects' | 'full';

export interface FaceAnalysisOptions {
  /** Defaults to `full` for backwards compatibility. */
  profile?: FaceAnalysisProfile;
  /** Optional scan-time EXIF orientation hint (1-8), avoiding a second metadata read. */
  orientation?: ExifOrientation;
  /**
   * A completed shallower result for this exact file/version. Coordinates are
   * in stored-image orientation, just like every public result. Full analysis
   * reuses its detections/eye signals and performs only missing enrichment.
   */
  seed?: FaceAnalysisResult;
  /** Enables sports disagreement safeguards in the subjects pass. */
  sportsMode?: boolean;
  /**
   * Optional SFace shortlist. Use 1-2 for routine athlete/cosplay comparisons
   * and 6-8 for an explicit group-completeness pass. The legacy configured
   * limit remains the default when omitted.
   */
  embeddingLimit?: number;
}

export interface FaceAnalysisResumePlan {
  faceDetection: boolean;
  personDetection: boolean;
  eyeDetail: boolean;
  faceMatching: boolean;
  poseAnalysis: boolean;
}

function effectiveEmbeddingLimit(profile: FaceAnalysisProfile, requested?: number): number {
  const configured = getFaceFeatureOptions(profile).embeddingLimit;
  if (profile !== 'full' || configured <= 0 || requested === undefined) return configured;
  return Math.max(1, Math.min(configured, Math.min(16, Math.round(requested))));
}

/** Pure resume planner used by the pipeline and regression tests. */
export function getFaceAnalysisResumePlan(
  profile: FaceAnalysisProfile,
  seed?: FaceAnalysisResult,
  embeddingLimit?: number,
): FaceAnalysisResumePlan {
  const requested = {
    ...getFaceFeatureOptions(profile),
    embeddingLimit: effectiveEmbeddingLimit(profile, embeddingLimit),
  };
  return {
    faceDetection: !seed,
    personDetection: requested.personDetection && seed?.features?.personDetection !== true,
    eyeDetail: profile !== 'detect' && seed?.features?.eyeDetail !== true,
    faceMatching: requested.faceMatching && !(
      seed?.features?.faceMatching === true &&
      (seed.features.embeddingLimit ?? 0) >= requested.embeddingLimit
    ),
    poseAnalysis: requested.poseAnalysis && seed?.features?.poseAnalysis !== true,
  };
}

export function shouldResumePersonFallback(
  seed: FaceAnalysisResult | undefined,
  sportsMode: boolean,
  fallbackActive: boolean,
): boolean {
  return fallbackActive && sportsMode && !!seed &&
    seed.features?.personFallback !== true &&
    seed.personBoxes.length === 0 && seed.boxes.some(isReliableFaceForEmbedding);
}

/** A general subjects cache is not sufficient evidence for a sports review. */
export function shouldResumeSportsSafeguards(
  seed: FaceAnalysisResult | undefined,
  sportsMode: boolean,
): boolean {
  return sportsMode && !!seed && seed.features?.sportsSafeguards !== true;
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the path to a bundled model file.
 *
 * In dev mode: looks in <projectRoot>/models/
 * In packaged app: looks in userData/models first, then bundled resources.
 */
function modelCandidates(fileName: string): string[] {
  const candidates: string[] = [];

  if (app.isPackaged) {
    candidates.push(path.join(app.getPath('userData'), 'models', fileName));
    candidates.push(path.join(process.resourcesPath, 'models', fileName));
  } else {
    // Dev: relative to the project root (two levels up from src/main/services/)
    candidates.push(path.join(__dirname, '..', '..', '..', 'models', fileName));
    // Fallback for different CWD contexts
    candidates.push(path.join(process.cwd(), 'models', fileName));
  }

  return candidates;
}

function productionFastModelCandidates(fileName: string): string[] {
  const candidates: string[] = [];
  if (app.isPackaged) {
    candidates.push(path.join(app.getPath('userData'), 'models', fileName));
    candidates.push(path.join(process.resourcesPath, 'models', fileName));
    // Compatibility with installs made while these weights were evaluation-only.
    candidates.push(path.join(app.getPath('userData'), 'models', 'experimental', fileName));
    candidates.push(path.join(process.resourcesPath, 'models', 'experimental', fileName));
  } else {
    candidates.push(path.join(__dirname, '..', '..', '..', 'models', fileName));
    candidates.push(path.join(process.cwd(), 'models', fileName));
    candidates.push(path.join(__dirname, '..', '..', '..', 'models', 'experimental', fileName));
    candidates.push(path.join(process.cwd(), 'models', 'experimental', fileName));
  }
  return [...new Set(candidates)];
}

async function resolveVerifiedProductionFastModelPath(
  role: ProductionFastDetectorRole,
): Promise<string | null> {
  const identity = getProductionFastDetector(role);
  for (const candidate of productionFastModelCandidates(identity.fileName)) {
    if (!existsSync(candidate)) continue;
    if (await verifyModelFileDigest(candidate, identity.sha256)) return candidate;
  }
  return null;
}

function modelPath(fileName: string): string {
  const candidates = modelCandidates(fileName);
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;

  throw new Error(
    `Face model "${fileName}" not found. Run "npm run models" to download it.\n` +
    `Searched:\n${candidates.map((p) => `  ${p}`).join('\n')}`,
  );
}

type VerifiedModel = { size: number; mtimeMs: number; sha256: string };
const verifiedModelFiles = new Map<string, VerifiedModel>();

/** Stream a model digest without holding the full ONNX file in memory. */
export async function verifyModelFileDigest(filePath: string, expectedSha256: string): Promise<boolean> {
  let fileStat: ReturnType<typeof statSync>;
  try {
    fileStat = statSync(filePath);
  } catch {
    return false;
  }
  if (!fileStat.isFile() || fileStat.size <= 0) return false;

  const cached = verifiedModelFiles.get(filePath);
  if (
    cached &&
    cached.size === fileStat.size &&
    cached.mtimeMs === fileStat.mtimeMs &&
    cached.sha256 === expectedSha256
  ) {
    return true;
  }

  const actual = await new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  }).catch(() => '');
  const valid = actual === expectedSha256;
  if (valid) {
    verifiedModelFiles.set(filePath, {
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      sha256: expectedSha256,
    });
  } else {
    verifiedModelFiles.delete(filePath);
  }
  return valid;
}

async function resolveVerifiedModelPath(role: FaceModelRole): Promise<string> {
  const identity = FACE_MODEL_IDENTITIES[role];
  const candidates = modelCandidates(identity.fileName);
  const invalid: string[] = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (await verifyModelFileDigest(candidate, identity.sha256)) return candidate;
    invalid.push(candidate);
  }

  if (invalid.length > 0) {
    throw new Error(
      `Face model integrity check failed for "${identity.fileName}". ` +
      `Remove the invalid model and let Keptra download it again.`,
    );
  }
  throw new Error(
    `Face model "${identity.fileName}" not found. Run "npm run models" to download it.\n` +
    `Searched:\n${candidates.map((candidate) => `  ${candidate}`).join('\n')}`,
  );
}

// ---------------------------------------------------------------------------
// Session lifecycle & configuration
// ---------------------------------------------------------------------------

let detectorSession: any | null = null;
let embedderSession: any | null = null;
let personSession: any | null = null;
let detectorInputName = 'input';
let embedderInputName = 'input';
let personInputName = 'image_tensor:0';
let sessionLoadPromise: Promise<void> | null = null;
let sessionLoadGeneration = 0;
let gpuAvailable: boolean | null = null;
let actualExecutionProvider: string | null = null; // legacy summary: mixed, dml, or cpu

export type ProductionFastDetectorState = 'unchecked' | 'active' | 'legacy-fallback';
export interface ProductionFastFailurePlan {
  state: 'legacy-fallback';
  failure: string;
  retryAt: number;
  prepareFastTensors: false;
}

/** Deterministic fail-closed route used after a promoted native circuit opens. */
export function productionFastFailurePlan(reason: string): ProductionFastFailurePlan {
  return {
    state: 'legacy-fallback',
    failure: reason,
    retryAt: Number.POSITIVE_INFINITY,
    prepareFastTensors: false,
  };
}

export function shouldAttemptProductionFastRoute(
  state: ProductionFastDetectorState,
  retryAt: number,
  now = Date.now(),
): boolean {
  return state !== 'legacy-fallback' || now >= retryAt;
}

export function canProductionFastBundleMutateRoute(
  bundleGeneration: number,
  currentGeneration: number,
): boolean {
  return bundleGeneration === currentGeneration;
}

export function productionPersonDetectorId(
  fastCompleted: boolean,
  fallbackCorroborated: boolean,
): string {
  if (!fastCompleted) return FACE_MODEL_IDENTITIES.person.fileName;
  return `${getProductionFastDetector('person').id}${fallbackCorroborated ? '+ssd-fallback' : ''}`;
}

interface ProductionFastDetectorBundle {
  face: DetectorCandidateRuntime;
  person: DetectorCandidateRuntime;
  generation: number;
}

export interface ProductionFastDetectorRuntimeStatus {
  state: ProductionFastDetectorState;
  active: boolean;
  faceModel: string;
  personModel: string;
  faceProvider?: 'cpu' | 'dml';
  personProvider?: 'cpu' | 'dml';
  faceRuns: number;
  personRuns: number;
  ssdFallbacks: number;
  ssdFallbackRate: number | null;
  legacyFaceFallbacks: number;
  legacyPersonFallbacks: number;
  failure?: string;
}

let productionFastDetectorGeneration = 0;
let productionFastDetectorPromise: Promise<ProductionFastDetectorBundle | null> | null = null;
let activeProductionFastBundle: ProductionFastDetectorBundle | null = null;
let productionFastDetectorState: ProductionFastDetectorState = 'unchecked';
let productionFastDetectorFailure: string | undefined;
let productionFastDetectorRetryAt = 0;
let fastFaceRuns = 0;
let fastPersonRuns = 0;
let fastCascadeLegacyFaceFallbacks = 0;
let fastCascadeLegacyPersonFallbacks = 0;
// Counts photos that actually attempted NanoDet and then routed through SSD.
// Unlike legacyPersonFallbacks, legacy-only photos are deliberately excluded.
let fastPersonSsdFallbacks = 0;
let activeProductionFastInferences = 0;
const retiredProductionFastBundles = new Set<ProductionFastDetectorBundle>();
let retiredProductionFastRelease: Promise<void> = Promise.resolve();

function releaseRetiredProductionFastBundles(): void {
  if (activeProductionFastInferences !== 0 || retiredProductionFastBundles.size === 0) return;
  const bundles = [...retiredProductionFastBundles];
  retiredProductionFastBundles.clear();
  retiredProductionFastRelease = retiredProductionFastRelease.then(async () => {
    await Promise.all(bundles.flatMap((bundle) => [
      bestEffortBoundedRelease('retired YuNet fast runtime', () => bundle.face.close()),
      bestEffortBoundedRelease('retired NanoDet fast runtime', () => bundle.person.close()),
    ]));
  });
}

function retireProductionFastBundle(
  bundle: ProductionFastDetectorBundle,
  reason: string,
): void {
  if (retiredProductionFastBundles.has(bundle)) return;
  retiredProductionFastBundles.add(bundle);
  // A native promise from a disposed generation can settle after replacement
  // sessions are already active. It may release its own bundle, but must never
  // poison or clear the current generation's route.
  if (!canProductionFastBundleMutateRoute(
    bundle.generation, productionFastDetectorGeneration,
  )) {
    log.info('[face-engine] retired stale production fast detector generation:',
      bundle.generation, reason);
    releaseRetiredProductionFastBundles();
    return;
  }
  const plan = productionFastFailurePlan(reason);
  if (activeProductionFastBundle === bundle) activeProductionFastBundle = null;
  productionFastDetectorState = plan.state;
  productionFastDetectorFailure = plan.failure;
  productionFastDetectorRetryAt = plan.retryAt;
  productionFastDetectorPromise = null;
  log.warn('[face-engine] retiring production fast detector pair; later photos use UltraFace/SSD:', reason);
  releaseRetiredProductionFastBundles();
}

async function trackProductionFastInference<T>(
  bundle: ProductionFastDetectorBundle,
  work: () => Promise<T>,
): Promise<T> {
  activeProductionFastInferences++;
  try {
    return await work();
  } catch (error) {
    retireProductionFastBundle(
      bundle,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  } finally {
    activeProductionFastInferences = Math.max(0, activeProductionFastInferences - 1);
    releaseRetiredProductionFastBundles();
  }
}

async function createProductionFastBundle(
  provider: 'cpu' | 'dml',
  facePath: string,
  personPath: string,
  generation: number,
): Promise<ProductionFastDetectorBundle> {
  const settled = await Promise.allSettled([
    DetectorCandidateRuntime.create(
      getProductionFastDetector('face'), facePath, provider, { dmlDeviceId },
    ),
    DetectorCandidateRuntime.create(
      getProductionFastDetector('person'), personPath, provider, { dmlDeviceId },
    ),
  ]);
  const failed = settled.find((entry): entry is PromiseRejectedResult => entry.status === 'rejected');
  if (failed) {
    await Promise.all(settled.map((entry, index) => entry.status === 'fulfilled'
      ? bestEffortBoundedRelease(
        `${index === 0 ? 'YuNet' : 'NanoDet'} partial ${provider} runtime`,
        () => entry.value.close(),
      )
      : Promise.resolve()));
    throw failed.reason;
  }
  const face = settled[0];
  const person = settled[1];
  if (face.status !== 'fulfilled' || person.status !== 'fulfilled') {
    throw new Error('Production fast detector pair did not settle completely');
  }
  return { face: face.value, person: person.value, generation };
}

/**
 * Load the promoted pair atomically. A single absent, corrupt, or unloadable
 * weight closes the fast path for this session; YuNet and NanoDet are never
 * silently mixed with an unverified file or partially promoted.
 */
async function getProductionFastDetectorBundle(): Promise<ProductionFastDetectorBundle | null> {
  if (productionFastDetectorState === 'legacy-fallback') {
    if (!shouldAttemptProductionFastRoute(
      productionFastDetectorState, productionFastDetectorRetryAt,
    )) return null;
    productionFastDetectorState = 'unchecked';
    productionFastDetectorPromise = null;
    activeProductionFastBundle = null;
  }
  if (!productionFastDetectorPromise) {
    const loadGeneration = productionFastDetectorGeneration;
    const loading = (async () => {
      let face: DetectorCandidateRuntime | null = null;
      let person: DetectorCandidateRuntime | null = null;
      try {
        const [facePath, personPath] = await Promise.all([
          resolveVerifiedProductionFastModelPath('face'),
          resolveVerifiedProductionFastModelPath('person'),
        ]);
        if (!facePath || !personPath) {
          activeProductionFastBundle = null;
          productionFastDetectorState = 'legacy-fallback';
          productionFastDetectorFailure = !facePath && !personPath
            ? 'verified YuNet and NanoDet weights are unavailable'
            : `verified ${!facePath ? 'YuNet' : 'NanoDet'} weight is unavailable`;
          // Startup model download can finish after the first analysis. Retry
          // availability at a bounded cadence without digesting on every photo.
          productionFastDetectorRetryAt = Date.now() + 10_000;
          return null;
        }
        const providers: Array<'cpu' | 'dml'> =
          process.platform === 'win32' && gpuFaceAccelerationEnabled ? ['dml', 'cpu'] : ['cpu'];
        let bundle: ProductionFastDetectorBundle | null = null;
        let providerError: unknown;
        let selectedProvider: 'cpu' | 'dml' = providers[0];
        for (const provider of providers) {
          try {
            bundle = await createProductionFastBundle(
              provider, facePath, personPath, loadGeneration,
            );
            selectedProvider = provider;
            break;
          } catch (error) {
            providerError = error;
            log.warn(`[face-engine] production fast ${provider} pair failed:`,
              error instanceof Error ? error.message : String(error));
          }
        }
        if (!bundle) throw providerError ?? new Error('No fast detector provider loaded');
        if (loadGeneration !== productionFastDetectorGeneration) {
          retiredProductionFastBundles.add(bundle);
          releaseRetiredProductionFastBundles();
          return null;
        }
        const loadedFace = bundle.face;
        const loadedPerson = bundle.person;
        face = loadedFace;
        person = loadedPerson;
        activeProductionFastBundle = bundle;
        productionFastDetectorState = 'active';
        productionFastDetectorFailure = undefined;
        productionFastDetectorRetryAt = Number.POSITIVE_INFINITY;
        log.info('[face-engine] verified production fast detector pair active:',
          getProductionFastDetector('face').id, '+', getProductionFastDetector('person').id,
          `(${selectedProvider})`);
        return bundle;
      } catch (error) {
        if (loadGeneration !== productionFastDetectorGeneration) return null;
        activeProductionFastBundle = null;
        productionFastDetectorState = 'legacy-fallback';
        productionFastDetectorFailure = error instanceof Error ? error.message : String(error);
        // A verified weight that cannot create a runtime should remain closed
        // until explicit engine reconfiguration/disposal, not thrash each job.
        productionFastDetectorRetryAt = Number.POSITIVE_INFINITY;
        const partialFace = face;
        const partialPerson = person;
        await Promise.all([
          bestEffortBoundedRelease('partial YuNet fast runtime', partialFace ? () => partialFace.close() : undefined),
          bestEffortBoundedRelease('partial NanoDet fast runtime', partialPerson ? () => partialPerson.close() : undefined),
        ]);
        log.warn('[face-engine] production fast detector pair unavailable; using verified legacy models:',
          productionFastDetectorFailure);
        return null;
      }
    })();
    productionFastDetectorPromise = loading;
    void loading.then((bundle) => {
      if (!bundle && productionFastDetectorPromise === loading) {
        productionFastDetectorPromise = null;
      }
    }, () => undefined);
  }
  return productionFastDetectorPromise;
}

export type FaceInferenceStage = 'detector' | 'embedder' | 'person';
export type FaceInferenceErrorCode =
  | 'FACE_INFERENCE_TIMEOUT'
  | 'FACE_INFERENCE_FAILED'
  | 'FACE_INFERENCE_CIRCUIT_OPEN'
  | 'FACE_INFERENCE_RESET';

/** Machine-readable native inference failure. No failure is converted to zero detections. */
export class FaceInferenceCircuitError extends Error {
  constructor(
    readonly code: FaceInferenceErrorCode,
    readonly stage: FaceInferenceStage,
    readonly detail: string,
  ) {
    super(`face-engine ${stage} inference ${code === 'FACE_INFERENCE_CIRCUIT_OPEN' ? 'unavailable' : 'failed'}: ${detail}`);
    this.name = 'FaceInferenceCircuitError';
  }
}

interface InferenceQueueEntry<T> {
  work: () => Promise<T>;
  timeoutMs: number;
  resolve: (value: T) => void;
  reject: (error: FaceInferenceCircuitError) => void;
}

interface ActiveInferenceRejector {
  generation: number;
  reject: (error: FaceInferenceCircuitError) => void;
}

/**
 * Bounded circuit around a native ORT session.
 *
 * ORT JavaScript promises cannot cancel a native call. On timeout/failure we
 * therefore reject every active/queued caller, open the circuit, and refuse
 * later work until the owning session is explicitly disposed/reconfigured.
 * This prevents a hung serialized person call from retaining its queue forever
 * without pretending that inference returned an empty result.
 */
export class FaceInferenceCircuit {
  private failure: FaceInferenceCircuitError | null = null;
  private readonly queue: Array<InferenceQueueEntry<unknown>> = [];
  private readonly activeRejectors = new Set<ActiveInferenceRejector>();
  private active = 0;
  private generation = 0;

  constructor(
    readonly stage: FaceInferenceStage,
    // One native Run per session is the safe default. DirectML explicitly
    // forbids overlapping Run calls on the same session, and callers must opt
    // into a real session pool (not just a larger number) to raise this.
    private readonly maxConcurrent = 1,
  ) {}

  run<T>(work: () => Promise<T>, timeoutMs: number): Promise<T> {
    if (this.failure) return Promise.reject(this.openError());
    const boundedTimeout = Math.max(1, Math.floor(timeoutMs));
    return new Promise<T>((resolve, reject) => {
      const entry: InferenceQueueEntry<T> = {
        work,
        timeoutMs: boundedTimeout,
        resolve,
        reject,
      };
      if (this.active < this.maxConcurrent) this.start(entry);
      else this.queue.push(entry as InferenceQueueEntry<unknown>);
    });
  }

  reset(detail = 'native session lifecycle reset'): void {
    const resetError = new FaceInferenceCircuitError('FACE_INFERENCE_RESET', this.stage, detail);
    const queued = this.queue.splice(0);
    const active = [...this.activeRejectors];
    this.generation++;
    this.active = 0;
    this.failure = null;
    for (const entry of queued) entry.reject(resetError);
    for (const entry of active) entry.reject(resetError);
    this.activeRejectors.clear();
  }

  diagnostics() {
    return {
      stage: this.stage,
      state: this.failure ? 'open' as const : 'closed' as const,
      active: this.active,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      failureCode: this.failure?.code,
      failure: this.failure?.detail,
    };
  }

  private start<T>(entry: InferenceQueueEntry<T>): void {
    if (this.failure) {
      entry.reject(this.openError());
      return;
    }
    const operationGeneration = this.generation;
    this.active++;
    let settled = false;
    let timer: NodeJS.Timeout;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.activeRejectors.delete(activeRejector);
      if (operationGeneration === this.generation) {
        this.active = Math.max(0, this.active - 1);
      }
      callback();
      this.drain();
    };
    const rejectFromCircuit = (error: FaceInferenceCircuitError) => finish(() => entry.reject(error));
    const activeRejector: ActiveInferenceRejector = {
      generation: operationGeneration,
      reject: rejectFromCircuit,
    };
    this.activeRejectors.add(activeRejector);
    timer = setTimeout(() => this.trip(new FaceInferenceCircuitError(
      'FACE_INFERENCE_TIMEOUT',
      this.stage,
      `native call exceeded ${entry.timeoutMs}ms; circuit opened until session reset`,
    )), entry.timeoutMs);

    Promise.resolve()
      .then(entry.work)
      .then(
        (value) => finish(() => entry.resolve(value)),
        (error) => {
          if (settled) return;
          const detail = error instanceof Error ? error.message : String(error);
          this.trip(new FaceInferenceCircuitError(
            'FACE_INFERENCE_FAILED', this.stage,
            `${detail}; circuit opened until session reset`,
          ));
        },
      );
  }

  private drain(): void {
    if (this.failure) return;
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      this.start(this.queue.shift()!);
    }
  }

  private trip(error: FaceInferenceCircuitError): void {
    if (this.failure) return;
    this.failure = error;
    const queued = this.queue.splice(0);
    const active = [...this.activeRejectors]
      .filter((entry) => entry.generation === this.generation);
    this.generation++;
    this.active = 0;
    for (const entry of queued) entry.reject(error);
    for (const entry of active) entry.reject(error);
  }

  private openError(): FaceInferenceCircuitError {
    const cause = this.failure;
    return new FaceInferenceCircuitError(
      'FACE_INFERENCE_CIRCUIT_OPEN',
      this.stage,
      cause
        ? `previous ${cause.code.toLowerCase()}: ${cause.detail}`
        : 'native session circuit is open',
    );
  }
}

const detectorInferenceCircuit = new FaceInferenceCircuit('detector', 1);
// DirectML sessions reject concurrent Run calls. CPU also uses internal ORT
// threads, so one JS call per session avoids oversubscription on either route.
const embedderInferenceCircuit = new FaceInferenceCircuit('embedder', 1);
const personInferenceCircuit = new FaceInferenceCircuit('person', 1);
const fastFaceInferenceCircuit = new FaceInferenceCircuit('detector', 1);
const fastPersonInferenceCircuit = new FaceInferenceCircuit('person', 1);
const DETECTOR_INFERENCE_TIMEOUT_MS = 12_000;
const PERSON_INFERENCE_TIMEOUT_MS = 12_000;
const EMBEDDER_INFERENCE_TIMEOUT_MS = 8_000;
const INFERENCE_RELEASE_TIMEOUT_MS = 2_000;

function resetFaceInferenceCircuits(detail: string): void {
  detectorInferenceCircuit.reset(detail);
  embedderInferenceCircuit.reset(detail);
  personInferenceCircuit.reset(detail);
  fastFaceInferenceCircuit.reset(detail);
  fastPersonInferenceCircuit.reset(detail);
}

async function bestEffortBoundedRelease(
  label: string,
  release: (() => Promise<unknown> | unknown) | undefined,
): Promise<void> {
  if (!release) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(release),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          log.warn(`[face-engine] ${label} release exceeded ${INFERENCE_RELEASE_TIMEOUT_MS}ms; abandoning best-effort cleanup`);
          resolve();
        }, INFERENCE_RELEASE_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    log.warn(`[face-engine] ${label} release failed:`,
      error instanceof Error ? error.message : String(error));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type FaceModelKey = 'detector' | 'embedder' | 'person';

export interface FaceProviderDiagnostic {
  model: FaceModelKey;
  provider: string;
  inputName?: string;
  loadMs?: number;
  avgInferenceMs?: number;
  cpuAvgInferenceMs?: number;
  dmlAvgInferenceMs?: number;
  deviceId?: number;
  fallbackReason?: string;
}

const providerDiagnostics: Record<FaceModelKey, FaceProviderDiagnostic> = {
  detector: { model: 'detector', provider: 'cpu' },
  embedder: { model: 'embedder', provider: 'cpu' },
  person: { model: 'person', provider: 'cpu' },
};

// Settings-driven configuration
let gpuFaceAccelerationEnabled = true;  // Can be disabled by user
let cpuOptimizationMode = false;        // Lighter models for older CPUs
let faceMatchingEnabled = true;
let personDetectionEnabled = true;
let faceEmbeddingLimit = 8;
let dmlDeviceId: number | undefined;

export function configureGpuAcceleration(enabled: boolean): void {
  const changed = gpuFaceAccelerationEnabled !== enabled;
  gpuFaceAccelerationEnabled = enabled;
  if (changed && sessionLoadPromise) void disposeFaceEngine().catch(() => undefined);
}

export function configureGpuDevice(deviceId?: number): void {
  const normalized = typeof deviceId === 'number' && Number.isFinite(deviceId) && deviceId >= 0
    ? Math.round(deviceId)
    : undefined;
  const changed = dmlDeviceId !== normalized;
  dmlDeviceId = normalized;
  if (changed && sessionLoadPromise) void disposeFaceEngine().catch(() => undefined);
}

export function configureCpuOptimization(enabled: boolean): void {
  const changed = cpuOptimizationMode !== enabled;
  cpuOptimizationMode = enabled;
  if (changed && sessionLoadPromise) void disposeFaceEngine().catch(() => undefined);
}

export function configureFaceFeatureOptions(options: { faceMatching?: boolean; personDetection?: boolean }): void {
  const nextFaceMatching = options.faceMatching ?? faceMatchingEnabled;
  const nextPersonDetection = options.personDetection ?? personDetectionEnabled;
  const changed = faceMatchingEnabled !== nextFaceMatching || personDetectionEnabled !== nextPersonDetection;
  faceMatchingEnabled = nextFaceMatching;
  personDetectionEnabled = nextPersonDetection;
  if (changed && sessionLoadPromise) void disposeFaceEngine().catch(() => undefined);
}

export function getFaceFeatureOptions(
  profile: FaceAnalysisProfile = 'full',
): { faceMatching: boolean; personDetection: boolean; poseAnalysis: boolean; embeddingLimit: number } {
  const includeSubjects = profile !== 'detect';
  const includeFullAnalysis = profile === 'full';
  return {
    faceMatching: includeFullAnalysis && faceMatchingEnabled,
    personDetection: includeSubjects && personDetectionEnabled,
    poseAnalysis: includeFullAnalysis && isPoseAnalysisEnabled(),
    embeddingLimit: includeFullAnalysis && faceMatchingEnabled ? faceEmbeddingLimit : 0,
  };
}

export function configureFaceThroughput(concurrency: number): void {
  const slots = Math.max(1, Math.min(32, Math.round(concurrency)));
  // Embedding every face in a crowded sports/event frame is the hidden cost:
  // crop+resize+GPU dispatch dominates far more than the warm 3 ms model time.
  // Keep all boxes for UI, but cap embeddings to the strongest faces for
  // grouping. This keeps similar-face grouping useful without turning a
  // 15-face crowd shot into 15 extra DML runs.
  faceEmbeddingLimit = slots >= 16 ? 6 : slots >= 8 ? 8 : 10;
}

/**
 * Return execution providers shipped by this build. Windows may benchmark
 * DirectML; other platforms currently use CPU-only onnxruntime-node.
 */
function getExecutionProviders(): string[] {
  if (process.platform === 'win32' && gpuFaceAccelerationEnabled) return ['dml', 'cpu'];
  return ['cpu'];
}

function sessionOptions(provider: 'cpu' | 'dml', cpuCount: number): Record<string, unknown> {
  return {
    executionProviders: provider === 'dml'
      ? [{ name: 'dml', ...(dmlDeviceId !== undefined ? { deviceId: dmlDeviceId } : {}) }]
      : [provider],
    graphOptimizationLevel: cpuOptimizationMode ? 'basic' : 'all',
    intraOpNumThreads: provider === 'cpu'
      ? (cpuOptimizationMode ? 2 : Math.min(cpuCount, 6))
      : 1,
    interOpNumThreads: 1,
    logSeverityLevel: 3,
  };
}

function warmupTensorSpec(model: FaceModelKey): { type: string; dims: number[] } {
  switch (model) {
    case 'embedder':
      return { type: 'float32', dims: [1, 3, EMBED_H, EMBED_W] };
    case 'person':
      return { type: 'uint8', dims: [1, 320, 320, 3] };
    case 'detector':
    default:
      return { type: 'float32', dims: [1, 3, DETECTOR_H, DETECTOR_W] };
  }
}

function makeWarmupTensor(runtime: OrtModule, model: FaceModelKey): any {
  const spec = warmupTensorSpec(model);
  const size = spec.dims.reduce((product, value) => product * value, 1);
  const data = spec.type === 'uint8' ? new Uint8Array(size) : new Float32Array(size);
  return new runtime.Tensor(spec.type, data, spec.dims);
}

async function warmBenchmarkSession(
  runtime: OrtModule,
  model: FaceModelKey,
  session: any,
  iterations = 6,
): Promise<number> {
  const inputName = session.inputNames?.[0];
  if (!inputName) throw new Error(`${model} session has no input name`);
  const tensor = makeWarmupTensor(runtime, model);
  const times: number[] = [];
  const benchmarkCircuit = new FaceInferenceCircuit(model);
  const timeoutMs = model === 'embedder'
    ? EMBEDDER_INFERENCE_TIMEOUT_MS
    : model === 'person' ? PERSON_INFERENCE_TIMEOUT_MS : DETECTOR_INFERENCE_TIMEOUT_MS;
  for (let i = 0; i < iterations; i++) {
    const t = performance.now();
    await benchmarkCircuit.run(
      () => session.run({ [inputName]: tensor }),
      timeoutMs,
    );
    times.push(performance.now() - t);
  }
  const warm = times.slice(Math.min(2, Math.max(0, times.length - 1)));
  return warm.reduce((sum, value) => sum + value, 0) / Math.max(1, warm.length);
}

export function choosePreferredProvider(input: {
  model: FaceModelKey;
  gpuEnabled: boolean;
  platform: NodeJS.Platform | string;
  cpuAvgMs?: number;
  dmlAvgMs?: number;
  dmlError?: string;
}): { provider: 'cpu' | 'dml'; fallbackReason?: string } {
  if (input.model === 'person') {
    return { provider: 'cpu', fallbackReason: 'person detector is faster and more stable on CPU' };
  }
  if (!input.gpuEnabled) return { provider: 'cpu', fallbackReason: 'GPU acceleration disabled' };
  if (input.platform !== 'win32') return { provider: 'cpu', fallbackReason: 'DirectML is only enabled on Windows' };
  if (input.dmlError) return { provider: 'cpu', fallbackReason: input.dmlError };
  if (typeof input.dmlAvgMs !== 'number') return { provider: 'cpu', fallbackReason: 'DirectML benchmark unavailable' };
  if (typeof input.cpuAvgMs !== 'number') return { provider: 'dml' };
  return input.dmlAvgMs < input.cpuAvgMs * 0.95
    ? { provider: 'dml' }
    : { provider: 'cpu', fallbackReason: `DirectML benchmark ${input.dmlAvgMs.toFixed(1)}ms was not faster than CPU ${input.cpuAvgMs.toFixed(1)}ms` };
}

async function createBenchmarkedSession(
  runtime: OrtModule,
  model: FaceModelKey,
  modelFilePath: string,
  cpuCount: number,
): Promise<{ session: any; inputName: string; diagnostic: FaceProviderDiagnostic }> {
  const cpuStart = Date.now();
  let cpuSession: any | null = null;
  let cpuLoadMs: number;
  let cpuAvgInferenceMs: number;
  try {
    cpuSession = await runtime.InferenceSession.create(modelFilePath, sessionOptions('cpu', cpuCount));
    cpuLoadMs = Date.now() - cpuStart;
    cpuAvgInferenceMs = await warmBenchmarkSession(runtime, model, cpuSession);
  } catch (error) {
    await bestEffortBoundedRelease(
      `${model} CPU benchmark session`, cpuSession?.release ? () => cpuSession.release() : undefined,
    );
    throw error;
  }
  const diagnostic: FaceProviderDiagnostic = {
    model,
    provider: 'cpu',
    inputName: cpuSession.inputNames?.[0],
    loadMs: cpuLoadMs,
    avgInferenceMs: cpuAvgInferenceMs,
    cpuAvgInferenceMs,
  };

  const providers = getExecutionProviders();
  if (!providers.includes('dml') || model === 'person') {
    const choice = choosePreferredProvider({
      model,
      gpuEnabled: gpuFaceAccelerationEnabled,
      platform: process.platform,
      cpuAvgMs: cpuAvgInferenceMs,
    });
    diagnostic.fallbackReason = choice.fallbackReason;
    return { session: cpuSession, inputName: cpuSession.inputNames?.[0] ?? 'input', diagnostic };
  }

  let dmlSession: any | null = null;
  let dmlLoadMs: number | undefined;
  let dmlAvgInferenceMs: number | undefined;
  let dmlError: string | undefined;
  try {
    const dmlStart = Date.now();
    dmlSession = await runtime.InferenceSession.create(modelFilePath, sessionOptions('dml', cpuCount));
    dmlLoadMs = Date.now() - dmlStart;
    dmlAvgInferenceMs = await warmBenchmarkSession(runtime, model, dmlSession);
  } catch (err) {
    dmlError = err instanceof Error ? err.message : 'DirectML benchmark failed';
    await bestEffortBoundedRelease(
      `${model} DirectML benchmark session`, dmlSession?.release ? () => dmlSession.release() : undefined,
    );
    dmlSession = null;
  }

  const choice = choosePreferredProvider({
    model,
    gpuEnabled: gpuFaceAccelerationEnabled,
    platform: process.platform,
    cpuAvgMs: cpuAvgInferenceMs,
    dmlAvgMs: dmlAvgInferenceMs,
    dmlError,
  });

  diagnostic.cpuAvgInferenceMs = cpuAvgInferenceMs;
  diagnostic.dmlAvgInferenceMs = dmlAvgInferenceMs;

  if (choice.provider === 'dml' && dmlSession) {
    await cpuSession.release?.().catch(() => undefined);
    return {
      session: dmlSession,
      inputName: dmlSession.inputNames?.[0] ?? 'input',
      diagnostic: {
        ...diagnostic,
        provider: 'dml',
        inputName: dmlSession.inputNames?.[0],
        loadMs: dmlLoadMs,
        avgInferenceMs: dmlAvgInferenceMs,
        deviceId: dmlDeviceId,
      },
    };
  }

  await dmlSession?.release?.().catch(() => undefined);
  return {
    session: cpuSession,
    inputName: cpuSession.inputNames?.[0] ?? 'input',
    diagnostic: {
      ...diagnostic,
      fallbackReason: choice.fallbackReason ?? dmlError,
    },
  };
}

async function loadSessions(): Promise<void> {
  if (sessionLoadPromise) return sessionLoadPromise;
  const loadGeneration = sessionLoadGeneration;
  const matchingRequested = faceMatchingEnabled;
  const personRequested = personDetectionEnabled;
  const loading = (async () => {
    try {
      const runtime = getOrt();
      const cpuCount = Math.max(2, require('os').cpus().length);

      // Resolve by pinned digest rather than by filename alone. In packaged
      // builds userData is searched before bundled resources; a corrupt stale
      // userData file must not shadow a valid bundled model.
      const [detPath, embPath, personPath] = await Promise.all([
        resolveVerifiedModelPath('detector'),
        matchingRequested ? resolveVerifiedModelPath('embedder') : Promise.resolve(null),
        personRequested ? resolveVerifiedModelPath('person') : Promise.resolve(null),
      ]);

      log.info('[face-engine] Loading sessions (providers:', getExecutionProviders().join(','), 'threads:', Math.min(cpuCount, 6), ')');
      if (dmlDeviceId !== undefined && getExecutionProviders().includes('dml')) {
        log.info(`[face-engine] DirectML adapter override: deviceId=${dmlDeviceId}`);
      }

      const settled = await Promise.allSettled([
        createBenchmarkedSession(runtime, 'detector', detPath, cpuCount),
        matchingRequested && embPath ? createBenchmarkedSession(runtime, 'embedder', embPath, cpuCount) : Promise.resolve(null),
        personRequested && personPath ? createBenchmarkedSession(runtime, 'person', personPath, cpuCount) : Promise.resolve(null),
      ]);
      const firstFailure = settled.find((entry): entry is PromiseRejectedResult => entry.status === 'rejected');
      if (firstFailure) {
        await Promise.all(settled.map((entry, index) => {
          const loaded = entry.status === 'fulfilled' ? entry.value : null;
          return loaded
            ? bestEffortBoundedRelease(
              `${(['detector', 'embedder', 'person'] as const)[index]} partial session`,
              loaded.session?.release ? () => loaded.session.release() : undefined,
            )
            : Promise.resolve();
        }));
        throw firstFailure.reason;
      }
      const detectorSettled = settled[0];
      const embedderSettled = settled[1];
      const personSettled = settled[2];
      if (
        detectorSettled.status !== 'fulfilled' ||
        embedderSettled.status !== 'fulfilled' ||
        personSettled.status !== 'fulfilled' ||
        !detectorSettled.value
      ) {
        throw new Error('Face model sessions did not settle to a complete load set');
      }
      const detector = detectorSettled.value;
      const embedder = embedderSettled.value;
      const person = personSettled.value;

      if (loadGeneration !== sessionLoadGeneration) {
        await Promise.all([
          bestEffortBoundedRelease('superseded detector session', () => detector.session.release?.()),
          bestEffortBoundedRelease('superseded embedder session', embedder?.session?.release ? () => embedder.session.release() : undefined),
          bestEffortBoundedRelease('superseded person session', person?.session?.release ? () => person.session.release() : undefined),
        ]);
        throw new FaceInferenceCircuitError(
          'FACE_INFERENCE_RESET', 'detector', 'model session load was superseded by reconfiguration',
        );
      }

      detectorSession = detector.session;
      detectorInputName = detector.inputName;
      providerDiagnostics.detector = detector.diagnostic;
      embedderSession = embedder?.session ?? null;
      embedderInputName = embedder?.inputName ?? 'input';
      providerDiagnostics.embedder = embedder?.diagnostic ?? { model: 'embedder', provider: 'disabled', fallbackReason: 'Face matching disabled in settings.' };
      personSession = person?.session ?? null;
      personInputName = person?.inputName ?? 'image_tensor:0';
      providerDiagnostics.person = person?.diagnostic ?? { model: 'person', provider: 'disabled', fallbackReason: 'Person detection disabled in settings.' };

      const providers = [detector.diagnostic.provider, embedder?.diagnostic.provider, person?.diagnostic.provider].filter(Boolean) as string[];
      gpuAvailable = providers.includes('dml');
      actualExecutionProvider = new Set(providers).size === 1 ? providers[0] : providers.join('+');
      log.info('[face-engine] Sessions loaded - EP:', actualExecutionProvider, JSON.stringify(providerDiagnostics));
    } catch (e) {
      if (loadGeneration === sessionLoadGeneration) sessionLoadPromise = null;
      throw e;
    }
  })();
  sessionLoadPromise = loading;
  return loading;
}

export async function disposeFaceEngine(): Promise<void> {
  sessionLoadGeneration++;
  disposeImagePreprocessSupervisor();
  const [d, e, p] = [detectorSession, embedderSession, personSession];
  const fastPromise = productionFastDetectorPromise;
  productionFastDetectorGeneration++;
  const pendingRetiredFastRelease = retiredProductionFastRelease;
  // Capture and clear the current pose session before any bounded await. A
  // reconfigured analysis is allowed to start a new generation immediately;
  // delayed cleanup of the old generation must never dispose that new session.
  const poseDisposePromise = disposePoseEngine();
  detectorSession = null;
  embedderSession = null;
  personSession = null;
  detectorInputName = 'input';
  embedderInputName = 'input';
  personInputName = 'image_tensor:0';
  sessionLoadPromise = null;
  gpuAvailable = null;
  actualExecutionProvider = null;
  productionFastDetectorPromise = null;
  activeProductionFastBundle = null;
  productionFastDetectorState = 'unchecked';
  productionFastDetectorFailure = undefined;
  productionFastDetectorRetryAt = 0;
  // Reject active/queued native callers before awaiting session.release(); a
  // release can itself wait on a stuck native invocation.
  resetFaceInferenceCircuits('face engine disposed or reconfigured');
  // Retire the captured pair instead of releasing it directly. Native ORT work
  // cannot be cancelled after a circuit timeout/reset; the active-native count
  // closes the pair only after the actual Run promise settles.
  const fastCleanupPromise = fastPromise
    ?.then((bundle) => {
      if (bundle) {
        retiredProductionFastBundles.add(bundle);
        releaseRetiredProductionFastBundles();
      }
    })
    .catch(() => undefined) ?? Promise.resolve();
  // A previously retired bundle may already be queued for release.
  releaseRetiredProductionFastBundles();
  await Promise.all([
    bestEffortBoundedRelease('detector session', d?.release ? () => d.release() : undefined),
    bestEffortBoundedRelease('embedder session', e?.release ? () => e.release() : undefined),
    bestEffortBoundedRelease('person session', p?.release ? () => p.release() : undefined),
    bestEffortBoundedRelease('pose engine', () => poseDisposePromise),
    Promise.race([
      Promise.all([fastCleanupPromise, pendingRetiredFastRelease]),
      new Promise<void>((resolve) => setTimeout(resolve, INFERENCE_RELEASE_TIMEOUT_MS)),
    ]),
  ]);
}

/**
 * Check if GPU acceleration is available (after first face analysis).
 * Returns null if not yet determined, true if GPU is active, false if CPU-only.
 */
export function isGpuAvailable(): boolean | null {
  return gpuAvailable;
}

/**
 * Pre-warm the ONNX face engine by loading sessions without running inference.
 * Call this at app startup so the first real analyzeFaces() call is fast.
 */
export async function prewarmFaceEngine(): Promise<void> {
  await Promise.all([loadSessions(), getProductionFastDetectorBundle()]);
}

/** Backwards-compatible capability probe used by diagnostics/IPC. */
export async function isNanoDetSportsFallbackActive(): Promise<boolean> {
  return (await getProductionFastDetectorBundle()) !== null;
}

/**
 * Returns the actual execution provider in use ('cpu', 'dml', 'coreml', etc.)
 * or null if sessions haven't been loaded yet.
 */
export function getActualExecutionProvider(): string | null {
  return actualExecutionProvider;
}

export function getFaceProviderDiagnostics(): FaceProviderDiagnostic[] {
  return [
    { ...providerDiagnostics.detector },
    { ...providerDiagnostics.embedder },
    { ...providerDiagnostics.person },
  ];
}

// ---------------------------------------------------------------------------
// Image preprocessing helpers
// ---------------------------------------------------------------------------

// Pure-Node pixel decoder — we avoid spawning a child process for each image
// by using Electron's nativeImage for fast thumbnail decoding.
// nativeImage is only available in the main process.
import { nativeImage } from 'electron';
import exifr from 'exifr';
import {
  extractLargestEmbeddedJpeg,
  getDetectionPixels,
  getThumbnailPayload,
  jpegDimensions,
  peekPreviewFile,
  peekThumbnailPayload,
  readExifOrientation,
  type PreviewPayload,
} from './exif-parser';

/**
 * Load a nativeImage from a path, with RAW fallback via exifr.thumbnail().
 * Returns a decoded nativeImage ready for resizing/cropping.
 * Result is NOT cached — callers that need to reuse it should keep the reference.
 */
// Short-lived decode cache: avoid re-loading the same RAW file within one
// analyzeFaces() call chain. Max 8 entries; evict oldest when full.
const imageDecodeCache = new Map<string, Electron.NativeImage>();
const MAX_DECODE_CACHE = 8;
type CachedAnalysisSurface = { image: Electron.NativeImage; bytes: number };
const analysisSurfaceCache = new Map<string, CachedAnalysisSurface>();
const MAX_ANALYSIS_SURFACES = 64;
const MAX_ANALYSIS_SURFACE_BYTES = 256 * 1024 * 1024;
let analysisSurfaceCacheBytes = 0;
let analysisSurfaceCacheHits = 0;
let analysisSurfaceCacheMisses = 0;

function removeAnalysisSurface(key: string): void {
  const entry = analysisSurfaceCache.get(key);
  if (!entry) return;
  analysisSurfaceCache.delete(key);
  analysisSurfaceCacheBytes = Math.max(0, analysisSurfaceCacheBytes - entry.bytes);
}

export function getAnalysisSurfaceCacheDiagnostics() {
  return {
    entries: analysisSurfaceCache.size,
    bytes: analysisSurfaceCacheBytes,
    maxBytes: MAX_ANALYSIS_SURFACE_BYTES,
    maxEntries: MAX_ANALYSIS_SURFACES,
    hits: analysisSurfaceCacheHits,
    misses: analysisSurfaceCacheMisses,
  };
}

function imageDecodeCacheKey(imagePath: string, profile: FaceAnalysisProfile): string {
  return `${profile}:${imagePath}`;
}

/** Clear the in-process image decode cache. Call when the scan source changes. */
export function clearImageDecodeCache(): void {
  imageDecodeCache.clear();
  analysisSurfaceCache.clear();
  analysisSurfaceCacheBytes = 0;
  analysisQuarantine.clear();
  clearImagePreprocessQuarantine();
}

/**
 * Terminate every active native decode/resize worker when the scan generation
 * changes. Utility-process work is genuinely cancellable, unlike an in-process
 * Promise timeout, so an old source cannot retain all preprocessing slots while
 * a newly selected source waits behind it.
 */
export function cancelActiveFacePreprocessing(): void {
  disposeImagePreprocessSupervisor();
  clearImageDecodeCache();
}

async function loadNativeImageCached(
  imagePath: string,
  profile: FaceAnalysisProfile,
): Promise<Electron.NativeImage> {
  const cacheKey = imageDecodeCacheKey(imagePath, profile);
  const cached = imageDecodeCache.get(cacheKey);
  if (cached) return cached;
  const img = await loadNativeImage(imagePath, profile);
  if (imageDecodeCache.size >= MAX_DECODE_CACHE) {
    // Evict oldest entry
    const firstKey = imageDecodeCache.keys().next().value;
    if (firstKey !== undefined) imageDecodeCache.delete(firstKey);
  }
  imageDecodeCache.set(cacheKey, img);
  return img;
}

export function isUsableDetectionPreviewSize(width: number, height: number): boolean {
  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  return Number.isFinite(width) && Number.isFinite(height) && shortSide >= 120 && longSide >= 240;
}

function usableDetectionPreview(image: Electron.NativeImage): boolean {
  if (image.isEmpty()) return false;
  const size = image.getSize();
  return isUsableDetectionPreviewSize(size.width, size.height);
}

async function loadDetectionThumbnail(imagePath: string): Promise<Electron.NativeImage | null> {
  const payload = await getThumbnailPayload(imagePath).catch(() => undefined);
  if (!payload) return null;
  try {
    const image = payload.kind === 'file'
      ? nativeImage.createFromPath(payload.diskPath)
      : nativeImage.createFromBuffer(payload.buffer);
    return usableDetectionPreview(image) ? image : null;
  } catch {
    return null;
  }
}

async function loadNativeImage(
  imagePath: string,
  profile: FaceAnalysisProfile = 'full',
): Promise<Electron.NativeImage> {
  // Detector-only screening does not need eye/identity detail. Reuse the
  // scan/grid's existing ~320px thumbnail (or its embedded RAW thumbnail)
  // rather than decoding a megapixel source. Reject undersized/corrupt
  // thumbnails and fall through to the normal 1920px/original path.
  if (profile === 'detect') {
    const detectionThumbnail = await loadDetectionThumbnail(imagePath);
    if (detectionThumbnail) return detectionThumbnail;
  }

  // The scanner normally creates a 1920px preview before AI review starts.
  // Reuse that already-decoded artifact when present instead of decoding the
  // original JPEG/RAW for a second time. peekPreviewFile never generates a
  // preview, so this cannot recurse back into the preview pipeline.
  const previewPath = await peekPreviewFile(imagePath, 'preview').catch(() => undefined);
  if (previewPath) {
    try {
      const preview = nativeImage.createFromPath(previewPath);
      if (!preview.isEmpty()) return preview;
    } catch {
      // A stale/corrupt preview is only a cache miss; fall through to the
      // verified original/embedded-preview decode paths below.
    }
  }

  try {
    const thumbnail = await nativeImage.createThumbnailFromPath(imagePath, { width: 1600, height: 1600 });
    if (!thumbnail.isEmpty()) return thumbnail;
  } catch {
    // Fall back to the full decoder below. RAW files and some camera formats
    // cannot be thumbnail-decoded by Electron directly.
  }

  let img = nativeImage.createFromPath(imagePath);
  if (!img.isEmpty()) return img;

  // RAW file — retain the fast IFD1 thumbnail as a fallback, but do not return a
  // tiny camera thumbnail before checking for the large embedded JPEG. Face and
  // eye analysis on a 160×120 preview is fast but produces unreliable results.
  const thumbData = await exifr.thumbnail(imagePath).catch(() => null);
  let thumbnailFallback: Electron.NativeImage | null = null;
  if (thumbData && thumbData.length > 0) {
    img = nativeImage.createFromBuffer(Buffer.from(thumbData));
    if (!img.isEmpty()) {
      const size = img.getSize();
      if (Math.max(size.width, size.height) >= 640) return img;
      thumbnailFallback = img;
    }
  }

  // Deep fallback: scan first 8MB of the RAW file for the largest JPEG block
  const jpegBuf = await extractLargestEmbeddedJpeg(imagePath).catch(() => null);
  if (jpegBuf && jpegBuf.length > 0) {
    img = nativeImage.createFromBuffer(jpegBuf);
    if (!img.isEmpty()) return img;
  }

  if (thumbnailFallback) return thumbnailFallback;

  throw new Error(`Cannot decode image for face analysis: ${imagePath}`);
}

export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/**
 * Bind a decoded analysis surface to the exact source file generation. Path
 * alone is unsafe because cameras/tethering tools routinely overwrite a file
 * in place while a review session remains open.
 */
export async function analysisSurfaceCacheKey(
  imagePath: string,
  orientation: ExifOrientation,
): Promise<string | null> {
  try {
    const identity = await statFile(imagePath, { bigint: true });
    return [
      orientation,
      imagePath,
      identity.size,
      identity.mtimeNs,
      identity.ctimeNs,
      identity.ino,
    ].join(':');
  } catch {
    // Without a trusted identity, decode normally and deliberately skip reuse.
    return null;
  }
}

function safeExifOrientation(value: number): ExifOrientation {
  return Number.isInteger(value) && value >= 1 && value <= 8
    ? value as ExifOrientation
    : 1;
}

/**
 * Transform stored-pixel bitmap data into the upright view described by EXIF.
 * Pixel words are copied intact, so BGRA/RGBA platform ordering is preserved.
 */
export function orientBitmapForExif(
  pixels: Uint8Array,
  width: number,
  height: number,
  orientationValue: number,
): { data: Buffer; width: number; height: number } {
  const orientation = safeExifOrientation(orientationValue);
  if (width <= 0 || height <= 0 || pixels.byteLength < width * height * 4) {
    throw new Error('Invalid bitmap dimensions for EXIF orientation');
  }
  const swapsAxes = orientation >= 5;
  const outputWidth = swapsAxes ? height : width;
  const outputHeight = swapsAxes ? width : height;
  const output = Buffer.allocUnsafe(outputWidth * outputHeight * 4);
  const wordAligned = pixels.byteOffset % 4 === 0 && output.byteOffset % 4 === 0;
  const inputWords = wordAligned
    ? new Uint32Array(pixels.buffer, pixels.byteOffset, width * height)
    : null;
  const outputWords = wordAligned
    ? new Uint32Array(output.buffer, output.byteOffset, outputWidth * outputHeight)
    : null;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let outputX = x;
      let outputY = y;
      switch (orientation) {
        case 2: outputX = width - 1 - x; break;
        case 3: outputX = width - 1 - x; outputY = height - 1 - y; break;
        case 4: outputY = height - 1 - y; break;
        case 5: outputX = y; outputY = x; break;
        case 6: outputX = height - 1 - y; outputY = x; break;
        case 7: outputX = height - 1 - y; outputY = width - 1 - x; break;
        case 8: outputX = y; outputY = width - 1 - x; break;
        default: break;
      }
      const sourceIndex = y * width + x;
      const outputIndex = outputY * outputWidth + outputX;
      if (inputWords && outputWords) {
        outputWords[outputIndex] = inputWords[sourceIndex];
      } else {
        output.set(pixels.subarray(sourceIndex * 4, sourceIndex * 4 + 4), outputIndex * 4);
      }
    }
  }
  return { data: output, width: outputWidth, height: outputHeight };
}

async function orientImageForAnalysis(
  storedImage: Electron.NativeImage,
  orientationValue: number,
): Promise<{ image: Electron.NativeImage; orientation: ExifOrientation }> {
  const orientation = safeExifOrientation(orientationValue);
  if (orientation === 1) return { image: storedImage, orientation };
  const { width, height } = storedImage.getSize();
  const bitmap = (storedImage.toBitmap?.() ?? storedImage.getBitmap()) as unknown as Buffer;
  const transformed = orientBitmapForExif(bitmap, width, height, orientation);
  const image = nativeImage.createFromBitmap(transformed.data, {
    width: transformed.width,
    height: transformed.height,
    scaleFactor: 1,
  });
  if (image.isEmpty()) throw new Error('Failed to create orientation-normalized analysis image');
  return { image, orientation };
}

function uprightPointToStored(
  x: number,
  y: number,
  orientationValue: number,
): { x: number; y: number } {
  const orientation = safeExifOrientation(orientationValue);
  switch (orientation) {
    case 2: return { x: 1 - x, y };
    case 3: return { x: 1 - x, y: 1 - y };
    case 4: return { x, y: 1 - y };
    case 5: return { x: y, y: x };
    case 6: return { x: y, y: 1 - x };
    case 7: return { x: 1 - y, y: 1 - x };
    case 8: return { x: 1 - y, y: x };
    default: return { x, y };
  }
}

function storedPointToUpright(
  x: number,
  y: number,
  orientationValue: number,
): { x: number; y: number } {
  const orientation = safeExifOrientation(orientationValue);
  switch (orientation) {
    case 2: return { x: 1 - x, y };
    case 3: return { x: 1 - x, y: 1 - y };
    case 4: return { x, y: 1 - y };
    case 5: return { x: y, y: x };
    case 6: return { x: 1 - y, y: x };
    case 7: return { x: 1 - y, y: 1 - x };
    case 8: return { x: y, y: 1 - x };
    default: return { x, y };
  }
}

function mapBoxToUprightOrientation(box: FaceBox, orientationValue: number): FaceBox {
  const orientation = safeExifOrientation(orientationValue);
  if (orientation === 1) return box;
  const corners = [
    storedPointToUpright(box.x, box.y, orientation),
    storedPointToUpright(box.x + box.width, box.y, orientation),
    storedPointToUpright(box.x, box.y + box.height, orientation),
    storedPointToUpright(box.x + box.width, box.y + box.height, orientation),
  ];
  const x1 = clamp01(Math.min(...corners.map((point) => point.x)));
  const y1 = clamp01(Math.min(...corners.map((point) => point.y)));
  const x2 = clamp01(Math.max(...corners.map((point) => point.x)));
  const y2 = clamp01(Math.max(...corners.map((point) => point.y)));
  return { ...box, x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function mapPoseToUprightOrientation(pose: PoseKeypoints, orientationValue: number): PoseKeypoints {
  const orientation = safeExifOrientation(orientationValue);
  if (orientation === 1) return pose;
  return {
    ...pose,
    keypoints: pose.keypoints.map((keypoint) => ({
      ...keypoint,
      ...storedPointToUpright(keypoint.x, keypoint.y, orientation),
    })),
  };
}

function mapLandmarksToUprightOrientation(
  landmarks: FaceLandmarks | null,
  orientationValue: number,
): FaceLandmarks | null {
  if (!landmarks) return null;
  const orientation = safeExifOrientation(orientationValue);
  return landmarks.map((point) => storedPointToUpright(point.x, point.y, orientation)) as unknown as FaceLandmarks;
}

function resultInUprightOrientation(
  result: FaceAnalysisResult,
  orientation: ExifOrientation,
): FaceAnalysisResult {
  if (orientation === 1) return result;
  return {
    ...result,
    boxes: result.boxes.map((box) => mapBoxToUprightOrientation(box, orientation)),
    personBoxes: result.personBoxes.map((box) => mapBoxToUprightOrientation(box, orientation)),
    embeddingBoxes: result.embeddingBoxes?.map((box) => mapBoxToUprightOrientation(box, orientation)),
    faceLandmarks: result.faceLandmarks?.map((points) =>
      mapLandmarksToUprightOrientation(points, orientation)),
    poses: result.poses?.map((pose) => mapPoseToUprightOrientation(pose, orientation)),
  };
}

export function mapLandmarksToStoredForExif(
  landmarks: FaceLandmarks,
  orientationValue: number,
): FaceLandmarks {
  return mapLandmarksToStoredOrientation(landmarks, orientationValue) ?? landmarks;
}

/** Map an upright inference box back to stored-pixel coordinates for IPC/UI. */
export function mapBoxToStoredOrientation(box: FaceBox, orientationValue: number): FaceBox {
  const orientation = safeExifOrientation(orientationValue);
  if (orientation === 1) return box;
  const corners = [
    uprightPointToStored(box.x, box.y, orientation),
    uprightPointToStored(box.x + box.width, box.y, orientation),
    uprightPointToStored(box.x, box.y + box.height, orientation),
    uprightPointToStored(box.x + box.width, box.y + box.height, orientation),
  ];
  const x1 = clamp01(Math.min(...corners.map((point) => point.x)));
  const y1 = clamp01(Math.min(...corners.map((point) => point.y)));
  const x2 = clamp01(Math.max(...corners.map((point) => point.x)));
  const y2 = clamp01(Math.max(...corners.map((point) => point.y)));
  return { ...box, x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function mapPoseToStoredOrientation(pose: PoseKeypoints, orientationValue: number): PoseKeypoints {
  const orientation = safeExifOrientation(orientationValue);
  if (orientation === 1) return pose;
  return {
    ...pose,
    keypoints: pose.keypoints.map((keypoint) => ({
      ...keypoint,
      ...uprightPointToStored(keypoint.x, keypoint.y, orientation),
    })),
  };
}

function mapLandmarksToStoredOrientation(
  landmarks: FaceLandmarks | null,
  orientationValue: number,
): FaceLandmarks | null {
  if (!landmarks) return null;
  const orientation = safeExifOrientation(orientationValue);
  return landmarks.map((point) => uprightPointToStored(point.x, point.y, orientation)) as unknown as FaceLandmarks;
}

/**
 * Decode image → raw RGBA pixels at a target size.
 * Accepts an already-loaded nativeImage to avoid re-decoding RAW thumbnails.
 */
function resizeToPixels(
  img: Electron.NativeImage,
  targetW: number,
  targetH: number,
): { data: Buffer; width: number; height: number } {
  const resized = img.resize({ width: targetW, height: targetH });
  const bitmap = (resized.toBitmap?.() ?? resized.getBitmap()) as unknown as Buffer;
  const size = resized.getSize();
  return { data: bitmap, width: size.width, height: size.height };
}

/**
 * Decode image → raw RGBA pixels at a target size.
 * For RAW formats falls back to exifr.thumbnail().
 */
async function decodeImage(
  imagePath: string,
  targetW: number,
  targetH: number,
): Promise<{ data: Buffer; width: number; height: number }> {
  const img = await loadNativeImage(imagePath);
  return resizeToPixels(img, targetW, targetH);
}

/**
 * Convert raw BGRA/RGBA Uint8Array → normalised float CHW tensor
 * (channels × height × width), mean-std normalised for face detection.
 */
function pixelsToCHW(
  pixels: Buffer,
  width: number,
  height: number,
  mean: number[],
  std: number[],
): Float32Array {
  const channelSize = width * height;
  const tensor = new Float32Array(3 * channelSize);
  const rOff = IS_BGRA_PLATFORM ? 2 : 0;
  const bOff = IS_BGRA_PLATFORM ? 0 : 2;
  const invStd0 = 1.0 / std[0], invStd1 = 1.0 / std[1], invStd2 = 1.0 / std[2];
  const sc = 1.0 / 255.0;
  // Pre-compute scaled means
  const m0 = mean[0], m1 = mean[1], m2 = mean[2];
  const ch1 = channelSize, ch2 = channelSize * 2;
  for (let i = 0; i < channelSize; i++) {
    const base = i * 4;
    tensor[i]       = (pixels[base + rOff] * sc - m0) * invStd0;
    tensor[ch1 + i] = (pixels[base + 1]   * sc - m1) * invStd1;
    tensor[ch2 + i] = (pixels[base + bOff] * sc - m2) * invStd2;
  }
  return tensor;
}

function pixelsToHWCUint8(
  pixels: Buffer,
  width: number,
  height: number,
): Uint8Array {
  const n = width * height;
  const tensor = new Uint8Array(n * 3);
  const rOff = IS_BGRA_PLATFORM ? 2 : 0;
  const bOff = IS_BGRA_PLATFORM ? 0 : 2;
  for (let i = 0; i < n; i++) {
    const src = i * 4;
    const dst = i * 3;
    tensor[dst]     = pixels[src + rOff];
    tensor[dst + 1] = pixels[src + 1];
    tensor[dst + 2] = pixels[src + bOff];
  }
  return tensor;
}

/**
 * Build the fixed detector tensor directly from stored-orientation pixels.
 * The source has already been resized to the detector's stored-axis shape, so
 * this is an exact rotate/mirror + colour conversion with no intermediate
 * upright bitmap allocation. It produces the same upright coordinate system
 * used by the normal path and resultInStoredOrientation maps boxes back later.
 */
function pixelsToOrientedDetectorCHW(
  pixels: Buffer,
  sourceWidth: number,
  sourceHeight: number,
  orientation: ExifOrientation,
  pixelLayout: 'native' | 'rgb' = 'native',
): Float32Array {
  const channelSize = DETECTOR_W * DETECTOR_H;
  const tensor = new Float32Array(channelSize * 3);
  const pixelStride = pixelLayout === 'rgb' ? 3 : 4;
  const rOff = pixelLayout === 'rgb' ? 0 : IS_BGRA_PLATFORM ? 2 : 0;
  const bOff = pixelLayout === 'rgb' ? 2 : IS_BGRA_PLATFORM ? 0 : 2;
  const ch1 = channelSize;
  const ch2 = channelSize * 2;

  // Orientation 1 is overwhelmingly common for camera JPEGs. Keep this hot
  // path branch-free; the prior per-pixel switch cost almost as much as the
  // DirectML detector kernel on a 640x480 input.
  if (orientation === 1) {
    for (let target = 0, source = 0; target < channelSize; target++, source += pixelStride) {
      tensor[target] = (pixels[source + rOff] - 127) / 128;
      tensor[ch1 + target] = (pixels[source + 1] - 127) / 128;
      tensor[ch2 + target] = (pixels[source + bOff] - 127) / 128;
    }
    return tensor;
  }

  for (let y = 0; y < DETECTOR_H; y++) {
    for (let x = 0; x < DETECTOR_W; x++) {
      let sourceX = x;
      let sourceY = y;
      switch (orientation) {
        case 2: sourceX = sourceWidth - 1 - x; break;
        case 3: sourceX = sourceWidth - 1 - x; sourceY = sourceHeight - 1 - y; break;
        case 4: sourceY = sourceHeight - 1 - y; break;
        case 5: sourceX = y; sourceY = x; break;
        case 6: sourceX = y; sourceY = sourceHeight - 1 - x; break;
        case 7: sourceX = sourceWidth - 1 - y; sourceY = sourceHeight - 1 - x; break;
        case 8: sourceX = sourceWidth - 1 - y; sourceY = x; break;
        default: break;
      }
      const source = (sourceY * sourceWidth + sourceX) * pixelStride;
      const target = y * DETECTOR_W + x;
      // UltraFace constants simplify exactly to (byte - 127) / 128.
      tensor[target] = (pixels[source + rOff] - 127) / 128;
      tensor[ch1 + target] = (pixels[source + 1] - 127) / 128;
      tensor[ch2 + target] = (pixels[source + bOff] - 127) / 128;
    }
  }
  return tensor;
}

// ---------------------------------------------------------------------------
// UltraFace detection
// ---------------------------------------------------------------------------

const DETECTOR_W = 640;
const DETECTOR_H = 480;
// UltraFace normalisation constants (from original repo)
const DET_MEAN = [127 / 255, 127 / 255, 127 / 255];
const DET_STD  = [128 / 255, 128 / 255, 128 / 255];
const CONF_THRESHOLD = 0.7;
const IOU_THRESHOLD  = 0.3;
const PERSON_THRESHOLD = 0.45;
const PERSON_EVIDENCE_THRESHOLD = 0.18;
const PERSON_CLASS_ID = 1;
/**
 * Production NanoDet decode budget. Top-K is applied independently to each of
 * the 8/16/32 stride heads before DFL decoding/NMS, bounding the worst-case
 * postprocess cost while retaining far more proposals than a usable photo can
 * surface in the UI. The 0.40-0.45 band is disagreement evidence only.
 */
export const PRODUCTION_NANODET_DECODE_PROFILE: Readonly<Required<NanoDetDecodeOptions>> = Object.freeze({
  scoreThreshold: 0.40,
  nmsThreshold: 0.60,
  preNmsTopK: 512,
  maxDetections: 256,
  requireTopClass: true,
});
const FAST_FACE_RELIABILITY_FLOOR = 0.76;
const LEGACY_FACE_REPLACEMENT_MARGIN = 0.08;
// Electron nativeImage.toBitmap() returns BGRA on Windows/macOS, RGBA elsewhere
const IS_BGRA_PLATFORM = process.platform === 'win32' || process.platform === 'darwin';

interface RawBox {
  x1: number; y1: number; x2: number; y2: number; score: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizeRawBox(box: RawBox, minSize = 0.001): RawBox | null {
  const x1 = clamp01(Math.min(box.x1, box.x2));
  const y1 = clamp01(Math.min(box.y1, box.y2));
  const x2 = clamp01(Math.max(box.x1, box.x2));
  const y2 = clamp01(Math.max(box.y1, box.y2));
  if (x2 - x1 < minSize || y2 - y1 < minSize) return null;
  return { x1, y1, x2, y2, score: clamp01(box.score) };
}

function iou(a: RawBox, b: RawBox): number {
  const ix1 = Math.max(a.x1, b.x1);
  const iy1 = Math.max(a.y1, b.y1);
  const ix2 = Math.min(a.x2, b.x2);
  const iy2 = Math.min(a.y2, b.y2);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const aArea = (a.x2 - a.x1) * (a.y2 - a.y1);
  const bArea = (b.x2 - b.x1) * (b.y2 - b.y1);
  return inter / (aArea + bArea - inter + 1e-6);
}

function nms(boxes: RawBox[]): RawBox[] {
  boxes.sort((a, b) => b.score - a.score);
  const kept: RawBox[] = [];
  const suppressed = new Set<number>();
  for (let i = 0; i < boxes.length; i++) {
    if (suppressed.has(i)) continue;
    kept.push(boxes[i]);
    for (let j = i + 1; j < boxes.length; j++) {
      if (!suppressed.has(j) && iou(boxes[i], boxes[j]) > IOU_THRESHOLD) {
        suppressed.add(j);
      }
    }
  }
  return kept;
}

function rankFacesForEmbedding(boxes: FaceBox[]): FaceBox[] {
  return [...boxes].sort((a, b) => {
    const aArea = a.width * a.height;
    const bArea = b.width * b.height;
    const aCenter = Math.hypot(a.x + a.width / 2 - 0.5, a.y + a.height / 2 - 0.45);
    const bCenter = Math.hypot(b.x + b.width / 2 - 0.5, b.y + b.height / 2 - 0.45);
    const aAspectPenalty = Math.abs(Math.log(Math.max(0.25, Math.min(4, a.width / Math.max(0.001, a.height)))));
    const bAspectPenalty = Math.abs(Math.log(Math.max(0.25, Math.min(4, b.width / Math.max(0.001, b.height)))));
    return (b.score * 2.4 + bArea * 12 - bCenter * 0.35 - bAspectPenalty * 0.1) -
      (a.score * 2.4 + aArea * 12 - aCenter * 0.35 - aAspectPenalty * 0.1);
  });
}

function isReliableFaceForEmbedding(box: FaceBox): boolean {
  const area = box.width * box.height;
  if (area >= 0.004 && box.score >= 0.62) return true;
  if (area >= 0.0015 && box.score >= 0.74) return true;
  return area >= 0.0009 && box.score >= 0.86;
}

export interface EyeDetailResult {
  /** Number of expected eye regions with enough texture to judge (0-2). */
  eyeScore: number;
  /** Aggregate 0..1 eye-region detail signal. */
  eyeSharpness: number;
}

type PixelRegion = { left: number; top: number; right: number; bottom: number };

function pixelRegionDetail(
  pixels: Uint8Array,
  width: number,
  height: number,
  region: PixelRegion,
  bgra: boolean,
): number {
  const left = Math.max(1, Math.min(width - 2, Math.floor(region.left)));
  const top = Math.max(1, Math.min(height - 2, Math.floor(region.top)));
  const right = Math.max(left + 1, Math.min(width - 1, Math.ceil(region.right)));
  const bottom = Math.max(top + 1, Math.min(height - 1, Math.ceil(region.bottom)));
  const rOff = bgra ? 2 : 0;
  const bOff = bgra ? 0 : 2;
  const luma = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return pixels[i + rOff] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + bOff] * 0.114;
  };

  let sum = 0;
  let sumSq = 0;
  let gradient = 0;
  let count = 0;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const value = luma(x, y);
      sum += value;
      sumSq += value * value;
      gradient += Math.abs(luma(x + 1, y) - luma(x - 1, y));
      gradient += Math.abs(luma(x, y + 1) - luma(x, y - 1));
      count++;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  const deviation = Math.sqrt(Math.max(0, sumSq / count - mean * mean));
  const averageGradient = gradient / (count * 2);
  // Eye detail is a combination of local contrast and edges. The deliberately
  // conservative knees keep smooth skin, JPEG blocks, and heavily blurred eye
  // bands below the usable threshold while avoiding any claim about blinking.
  return clamp01(
    clamp01((averageGradient - 2.5) / 16) * 0.68 +
    clamp01((deviation - 6) / 30) * 0.32,
  );
}

/**
 * Estimate whether the two expected eye regions contain usable detail.
 * This is a focus/review signal, not a definitive open-vs-closed classifier.
 * Kept pure and exported so its thresholds can be regression-tested.
 */
export function estimateEyeDetailFromPixels(
  pixels: Uint8Array,
  width: number,
  height: number,
  bgra = IS_BGRA_PLATFORM,
): EyeDetailResult {
  if (width < 24 || height < 24 || pixels.length < width * height * 4) {
    return { eyeScore: 0, eyeSharpness: 0 };
  }
  const y1 = height * 0.24;
  const y2 = height * 0.52;
  const leftSignal = pixelRegionDetail(pixels, width, height, {
    left: width * 0.1, top: y1, right: width * 0.48, bottom: y2,
  }, bgra);
  const rightSignal = pixelRegionDetail(pixels, width, height, {
    left: width * 0.52, top: y1, right: width * 0.9, bottom: y2,
  }, bgra);
  const usableThreshold = 0.34;
  return {
    eyeScore: Number(leftSignal >= usableThreshold) + Number(rightSignal >= usableThreshold),
    eyeSharpness: Math.round(((leftSignal + rightSignal) / 2) * 1000) / 1000,
  };
}

export interface EyeDetailAnnotationBatch {
  boxes: FaceBox[];
  /** True only when every eligible face crop was sampled successfully. */
  complete: boolean;
  eligibleCount: number;
  completedCount: number;
}

export async function annotateEyeDetail(
  img: Electron.NativeImage,
  boxes: FaceBox[],
): Promise<EyeDetailAnnotationBatch> {
  if (boxes.length === 0) {
    return { boxes, complete: true, eligibleCount: 0, completedCount: 0 };
  }
  const { width: imgW, height: imgH } = img.getSize();
  if (imgW <= 0 || imgH <= 0) {
    return { boxes, complete: false, eligibleCount: boxes.length, completedCount: 0 };
  }

  // Eye-region sampling is inexpensive but still requires a crop/resize. Limit
  // it to the strongest review faces; all detector boxes remain visible.
  const candidates = new Set(rankFacesForEmbedding(boxes).slice(0, 12));
  const annotated: FaceBox[] = [];
  let eligibleCount = 0;
  let completedCount = 0;
  for (let index = 0; index < boxes.length; index++) {
    const box = boxes[index];
    const faceW = box.width * imgW;
    const faceH = box.height * imgH;
    if (!candidates.has(box) || faceW < 28 || faceH < 28 || box.score < 0.68) {
      annotated.push(box);
      continue;
    }
    eligibleCount++;
    try {
      const cropX = Math.max(0, Math.floor(box.x * imgW));
      const cropY = Math.max(0, Math.floor(box.y * imgH));
      const cropW = Math.min(imgW - cropX, Math.max(2, Math.ceil(box.width * imgW)));
      const cropH = Math.min(imgH - cropY, Math.max(2, Math.ceil(box.height * imgH)));
      const crop = img.crop({ x: cropX, y: cropY, width: cropW, height: cropH }).resize({ width: 96, height: 96 });
      const bitmap = (crop.toBitmap?.() ?? crop.getBitmap()) as unknown as Buffer;
      const detail = estimateEyeDetailFromPixels(bitmap, 96, 96);
      annotated.push({ ...box, ...detail });
      completedCount++;
    } catch {
      annotated.push(box);
    }
    if (index % 4 === 3) await yieldToEventLoop();
  }
  return {
    boxes: annotated,
    complete: completedCount === eligibleCount,
    eligibleCount,
    completedCount,
  };
}

function faceBoxesFromDetectorResult(result: Record<string, any>): FaceBox[] {
  // Output names vary by export — try common variants.
  const scoresKey = Object.keys(result).find((k) => k.includes('score') || k.includes('conf')) ?? Object.keys(result)[0];
  const boxesKey = Object.keys(result).find((k) => k.includes('box') || k.includes('loc')) ?? Object.keys(result)[1];
  const scores = result[scoresKey].data as Float32Array;
  const boxes = result[boxesKey].data as Float32Array;
  const raw: RawBox[] = [];
  const numBoxes = boxes.length / 4;
  for (let i = 0; i < numBoxes; i++) {
    const faceProb = scores[i * 2 + 1];
    if (faceProb < CONF_THRESHOLD) continue;
    const normalized = normalizeRawBox({
      x1: boxes[i * 4],
      y1: boxes[i * 4 + 1],
      x2: boxes[i * 4 + 2],
      y2: boxes[i * 4 + 3],
      score: faceProb,
    }, 0.0015);
    if (normalized) raw.push(normalized);
  }
  return nms(raw).map((box) => ({
    x: box.x1,
    y: box.y1,
    width: box.x2 - box.x1,
    height: box.y2 - box.y1,
    score: box.score,
  }));
}

async function runFaceDetectorTensor(floats: Float32Array): Promise<FaceBox[]> {
  const session = detectorSession;
  if (!session) throw new Error('Face detector session is not loaded');
  const tensor = new (getOrt().Tensor)('float32', floats, [1, 3, DETECTOR_H, DETECTOR_W]);
  const result = await detectorInferenceCircuit.run(
    () => session.run({ [detectorInputName]: tensor }) as Promise<Record<string, any>>,
    DETECTOR_INFERENCE_TIMEOUT_MS,
  );
  return faceBoxesFromDetectorResult(result);
}

async function detectFaces(imagePath: string, cachedImg?: Electron.NativeImage): Promise<FaceBox[]> {
  if (!detectorSession) throw new Error('Face engine not loaded');

  const img = cachedImg ?? await loadNativeImage(imagePath);
  const { data, width, height } = resizeToPixels(img, DETECTOR_W, DETECTOR_H);
  const floats = pixelsToCHW(data, width, height, DET_MEAN, DET_STD);
  return runFaceDetectorTensor(floats);
}

async function prepareFaceDetectorTensor(
  imagePath: string,
  orientation: ExifOrientation,
): Promise<Float32Array> {
  const swapsAxes = orientation >= 5;
  const storedWidth = swapsAxes ? DETECTOR_H : DETECTOR_W;
  const storedHeight = swapsAxes ? DETECTOR_W : DETECTOR_H;

  // The scanner has normally decoded and persisted this thumbnail already.
  // Let sharp/libvips resize it on a worker thread, then hand its compact RGB
  // buffer directly to tensor packing. This removes nativeImage's synchronous
  // decode/resize/toBitmap sequence from the main-process hot path.
  const accelerated = await getDetectionPixels(imagePath, storedWidth, storedHeight)
    .catch(() => undefined);
  if (accelerated
    && isUsableDetectionPreviewSize(accelerated.sourceWidth, accelerated.sourceHeight)) {
    return pixelsToOrientedDetectorCHW(
      accelerated.data,
      accelerated.width,
      accelerated.height,
      orientation,
      'rgb',
    );
  }

  const img = await loadNativeImageCached(imagePath, 'detect');
  const resized = img.resize({
    width: storedWidth,
    height: storedHeight,
  });
  const size = resized.getSize();
  if (size.width !== storedWidth || size.height !== storedHeight) {
    // Extremely defensive fallback for a platform decoder that refuses the
    // requested dimensions; the established upright path remains reliable.
    const oriented = await orientImageForAnalysis(img, orientation);
    const { data, width, height } = resizeToPixels(oriented.image, DETECTOR_W, DETECTOR_H);
    return pixelsToCHW(data, width, height, DET_MEAN, DET_STD);
  }
  const bitmap = (resized.toBitmap?.() ?? resized.getBitmap()) as unknown as Buffer;
  return pixelsToOrientedDetectorCHW(
    bitmap,
    size.width,
    size.height,
    orientation,
  );
}

const WORKER_DIRECT_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.jpe', '.png', '.webp', '.gif', '.avif',
  '.tif', '.tiff', '.heic', '.heif', '.hif',
]);

/**
 * Resolve a libvips-readable input without generating a new preview on the
 * Electron thread. Camera RAW normally has a scanner preview by review time;
 * if it does not, the worker gets the original and returns a structured decode
 * error instead of risking a synchronous nativeImage fallback.
 */
export interface ResolvedPreprocessSource {
  sourcePath: string;
  orientation: ExifOrientation;
  /** Encoded JPEG/preview bytes for transient/cache-off RAW sources. */
  inputBuffer?: Uint8Array;
  extractEmbeddedJpeg?: boolean;
  useSourceOrientation?: boolean;
  sourceKind?: 'original' | 'preview-file' | 'preview-buffer' | 'thumbnail-file' | 'thumbnail-buffer';
}

function resolvedPreviewSource(
  imagePath: string,
  payload: PreviewPayload,
  originalOrientation: ExifOrientation,
  kind: 'preview' | 'thumbnail',
): ResolvedPreprocessSource {
  // The worker reads the encoded JPEG's own metadata and only falls back to
  // the RAW container orientation when that preview has no tag. Keeping this
  // decision inside the killable process also avoids preflight native decode.
  const orientation = originalOrientation;
  if (payload.kind === 'file') {
    return {
      sourcePath: payload.diskPath,
      orientation,
      useSourceOrientation: true,
      sourceKind: `${kind}-file`,
    };
  }
  return {
    // Keep the user's path as the worker request/quarantine identity. The
    // utility process opens inputBuffer and never asks Sharp to decode RAW.
    sourcePath: imagePath,
    inputBuffer: payload.buffer,
    orientation,
    useSourceOrientation: true,
    sourceKind: `${kind}-buffer`,
  };
}

async function isUsableScannerThumbnail(payload: PreviewPayload): Promise<boolean> {
  try {
    const encoded = payload.kind === 'buffer' ? payload.buffer : await readFile(payload.diskPath);
    const dimensions = jpegDimensions(encoded);
    return !!dimensions && isUsableDetectionPreviewSize(dimensions.width, dimensions.height);
  } catch {
    return false;
  }
}

export async function resolvePreprocessSource(
  imagePath: string,
  originalOrientation: ExifOrientation,
  preferScannerThumbnail = false,
): Promise<ResolvedPreprocessSource> {
  // The scanner has usually already decoded and bounded a thumbnail by the
  // time detector-only review starts. Prefer that handoff for every supported
  // source type, including ordinary JPEGs. Previously the direct-extension
  // return below won first, so a cheap YuNet screen reopened every full-size
  // JPEG and left the four preprocessing workers saturated while the GPU
  // waited. This is a read-only lookup; a missing/evicted thumbnail falls back
  // to the original without generating work on the Electron thread.
  const thumbnail = preferScannerThumbnail
    ? await peekThumbnailPayload(imagePath).catch(() => undefined)
    : undefined;
  if (thumbnail && await isUsableScannerThumbnail(thumbnail)) {
    return resolvedPreviewSource(imagePath, thumbnail, originalOrientation, 'thumbnail');
  }

  if (WORKER_DIRECT_EXTENSIONS.has(path.extname(imagePath).toLowerCase())) {
    return { sourcePath: imagePath, orientation: originalOrientation, sourceKind: 'original' };
  }
  const previewPath = await peekPreviewFile(imagePath, 'preview').catch(() => undefined);
  if (previewPath) {
    return resolvedPreviewSource(
      imagePath,
      { kind: 'file', diskPath: previewPath },
      originalOrientation,
      'preview',
    );
  }

  // Unseen/cache-off RAW extraction belongs to the supervised process too.
  // It scans at most 12 MiB for the largest embedded JPEG; a corrupt or stuck
  // file is terminated by the same per-file deadline as Sharp decode.
  return {
    sourcePath: imagePath,
    orientation: originalOrientation,
    extractEmbeddedJpeg: true,
    useSourceOrientation: true,
    sourceKind: 'original',
  };
}

export function canReuseAnalysisSurfaceForRequest(input: {
  includeAnalysisSurface: boolean;
  includeDetectorTensor: boolean;
  includePersonTensors: boolean;
  includeYuNetTensor: boolean;
}): boolean {
  return input.includeAnalysisSurface &&
    !input.includeDetectorTensor &&
    !input.includePersonTensors &&
    // YuNet preprocessing is intentionally owned by the supervised Sharp
    // worker; the cached nativeImage is not a substitute for its BGR tensor.
    !input.includeYuNetTensor;
}

async function prepareImageOffMain(
  imagePath: string,
  orientation: ExifOrientation,
  includeAnalysisSurface: boolean,
  includeDetectorTensor: boolean,
  includePersonTensors: boolean,
  includeNanoDetTensor = false,
  includeYuNetTensor = false,
): Promise<{ prepared: PreparedImagePayload; image?: Electron.NativeImage }> {
  const surfaceKey = includeAnalysisSurface
    ? await analysisSurfaceCacheKey(imagePath, orientation)
    : null;
  const cachedSurface = surfaceKey && canReuseAnalysisSurfaceForRequest({
    includeAnalysisSurface,
    includeDetectorTensor,
    includePersonTensors,
    includeYuNetTensor,
  })
    ? analysisSurfaceCache.get(surfaceKey)
    : undefined;
  if (cachedSurface && surfaceKey) {
    // Refresh insertion order. This is the common subjects -> seeded full path:
    // enrichment reuses the exact decoded frame and performs no second decode.
    analysisSurfaceCache.delete(surfaceKey);
    analysisSurfaceCache.set(surfaceKey, cachedSurface);
    analysisSurfaceCacheHits++;
    const size = cachedSurface.image.getSize();
    return {
      prepared: {
        detectorCHW: new Float32Array(0),
        sourceWidth: size.width,
        sourceHeight: size.height,
        nanoDet: includeNanoDetTensor ? nanoDetTensorFromSurface(cachedSurface.image) : undefined,
      },
      image: cachedSurface.image,
    };
  }
  if (includeAnalysisSurface && !includePersonTensors) analysisSurfaceCacheMisses++;
  const {
    sourcePath,
    orientation: sourceOrientation,
    inputBuffer,
    extractEmbeddedJpeg,
    useSourceOrientation,
  } = await resolvePreprocessSource(imagePath, orientation, !includeAnalysisSurface);
  let prepared: PreparedImagePayload;
  try {
    prepared = await getImagePreprocessSupervisor().prepare({
      imagePath,
      sourcePath: sourcePath !== imagePath ? sourcePath : undefined,
      inputBuffer,
      extractEmbeddedJpeg,
      useSourceOrientation,
      orientation: sourceOrientation,
      includeDetectorTensor,
      includeAnalysisSurface,
      includePersonTensors,
      includeNanoDetTensor,
      includeYuNetTensor,
      analysisMaxDimension: 1024,
    });
  } catch (error) {
    throw error;
  }
  if (!includeAnalysisSurface) return { prepared };
  if (!prepared.surfaceBitmap || !prepared.surfaceWidth || !prepared.surfaceHeight) {
    throw new ImagePreprocessError(
      'PREPROCESS_FAILED', imagePath, 'complete', 'worker omitted the requested analysis surface',
    );
  }
  const bitmap = Buffer.from(
    prepared.surfaceBitmap.buffer,
    prepared.surfaceBitmap.byteOffset,
    prepared.surfaceBitmap.byteLength,
  );
  const image = nativeImage.createFromBitmap(bitmap, {
    width: prepared.surfaceWidth,
    height: prepared.surfaceHeight,
    scaleFactor: 1,
  });
  if (image.isEmpty()) {
    throw new ImagePreprocessError(
      'PREPROCESS_FAILED', imagePath, 'complete', 'failed to materialise the bounded analysis surface',
    );
  }
  const surfaceBytes = prepared.surfaceWidth! * prepared.surfaceHeight! * 4;
  if (surfaceKey) removeAnalysisSurface(surfaceKey);
  while (analysisSurfaceCache.size >= MAX_ANALYSIS_SURFACES ||
    analysisSurfaceCacheBytes + surfaceBytes > MAX_ANALYSIS_SURFACE_BYTES) {
    const oldest = analysisSurfaceCache.keys().next().value;
    if (!oldest) break;
    removeAnalysisSurface(oldest);
  }
  if (surfaceKey && surfaceBytes <= MAX_ANALYSIS_SURFACE_BYTES) {
    analysisSurfaceCache.set(surfaceKey, { image, bytes: surfaceBytes });
    analysisSurfaceCacheBytes += surfaceBytes;
  }
  return { prepared, image };
}

interface PersonDetectionPass {
  boxes: FaceBox[];
  /** Plausible person outputs below/above the display threshold. */
  candidateCount: number;
}

export function productionNanoDetPersonPass(
  detections: readonly CandidateDetection[],
): PersonDetectionPass {
  return {
    boxes: detections
      .filter((detection) => detection.score >= 0.45)
      .map((detection) => ({
        x: detection.x, y: detection.y, width: detection.width,
        height: detection.height, score: detection.score,
      })),
    candidateCount: detections.length,
  };
}

function hasMeaningfulPersonCandidateGap(candidateCount: number, fastBoxCount: number): boolean {
  if (candidateCount <= fastBoxCount) return false;
  // With no accepted body, even one sub-threshold proposal is useful evidence
  // that the cheap pass was uncertain. Once a body is already accepted, a
  // single weak extra proposal is extremely common in busy event backgrounds
  // and caused most HYROX frames to pay for an unnecessary second pass. Require
  // two additional proposals; face/body disagreement and tiny-body safeguards
  // below still independently trigger refinement.
  return fastBoxCount === 0 || candidateCount >= fastBoxCount + 2;
}

/** Deterministic selective-fallback gate shared by YuNet and NanoDet. */
export function shouldUseLegacyDetectorFallback(
  boxes: readonly FaceBox[],
  confidenceFloor: number,
): boolean {
  if (boxes.length === 0) return true;
  if (!boxes.some((box) => box.score >= confidenceFloor)) return true;
  // A cropped edge subject is a useful disagreement only in a sparse frame.
  // In crowds/conventions, one tiny background edge box is routine and must
  // not force a legacy pass (or discard landmarks) for every good face/body.
  return boxes.length <= 2 && boxes.some((box) =>
    box.x < 0.01 || box.y < 0.01 ||
    box.x + box.width > 0.99 || box.y + box.height > 0.99);
}

export function shouldRefinePersonDetection(input: {
  width: number;
  height: number;
  faceBoxes: FaceBox[];
  fastBoxes: FaceBox[];
  candidateCount: number;
  sportsMode: boolean;
}): boolean {
  const { width, height, faceBoxes, fastBoxes, candidateCount, sportsMode } = input;
  const shortSide = Math.max(1, Math.min(width, height));
  const longSide = Math.max(width, height);
  const aspect = longSide / shortSide;
  const reliableFaces = faceBoxes.filter(isReliableFaceForEmbedding);
  const hasEvidence = reliableFaces.length > 0 || fastBoxes.length > 0 || candidateCount > 0;
  // In a sports batch, "every detector returned zero" is itself an important
  // disagreement: the frame may contain a distant/back-facing athlete. Pay
  // for one bounded 640 pass so zero evidence is never silently interpreted
  // as a confirmed people-free frame. General/landscape batches stay cheap.
  if (!hasEvidence) return sportsMode;

  const missedBodies = reliableFaces.length > fastBoxes.length;
  const weakCandidate = hasMeaningfulPersonCandidateGap(candidateCount, fastBoxes.length);
  const smallBody = fastBoxes.some((box) => box.width * box.height < 0.032);
  const groupEvidence = faceBoxes.length >= 2 || fastBoxes.length >= 3 || candidateCount >= 3;

  // Sports refinement is evidence-driven. A wide room is not itself a reason
  // to double inference; reliable face/body disagreement is, including the
  // important face-positive + zero-person case.
  if (sportsMode) return missedBodies || weakCandidate || smallBody;
  return missedBodies ||
    (groupEvidence && (weakCandidate || smallBody || aspect >= 1.35)) ||
    (aspect >= 1.75 && (reliableFaces.length > 0 || fastBoxes.length >= 2));
}

function personRefinementReason(input: {
  faceBoxes: FaceBox[];
  fastBoxes: FaceBox[];
  candidateCount: number;
}): string {
  const reliableFaceCount = input.faceBoxes.filter(isReliableFaceForEmbedding).length;
  if (reliableFaceCount > input.fastBoxes.length) return 'face-body-disagreement';
  if (hasMeaningfulPersonCandidateGap(input.candidateCount, input.fastBoxes.length)) {
    return 'ambiguous-candidate';
  }
  if (input.fastBoxes.some((box) => box.width * box.height < 0.032)) return 'tiny-subject';
  if (input.faceBoxes.length === 0 && input.fastBoxes.length === 0 && input.candidateCount === 0) {
    return 'sports-zero-evidence';
  }
  return 'group-or-aspect-evidence';
}

function candidateInput(prepared: NonNullable<PreparedImagePayload['nanoDet']>): PreparedDetectorInput {
  return {
    data: prepared.data,
    dimensions: [1, 3, 416, 416],
    transform: {
      sourceWidth: prepared.sourceWidth,
      sourceHeight: prepared.sourceHeight,
      targetWidth: prepared.targetWidth,
      targetHeight: prepared.targetHeight,
      resizedWidth: prepared.resizedWidth,
      resizedHeight: prepared.resizedHeight,
      padLeft: prepared.padLeft,
      padTop: prepared.padTop,
    },
  };
}

async function runNanoDetFastPass(
  bundle: ProductionFastDetectorBundle,
  prepared?: PreparedImagePayload['nanoDet'],
): Promise<PersonDetectionPass> {
  if (!prepared) throw new Error('preprocess worker omitted requested NanoDet tensor');
  fastPersonRuns++;
  const result = await fastPersonInferenceCircuit.run(
    () => trackProductionFastInference(
      bundle,
      // Retain the narrow 0.40-0.45 band only as disagreement evidence. Lower
      // anchors were extremely noisy in crowds (and forced SSD on most frames);
      // evidence detections never enter returned personBoxes directly.
      () => bundle.person.runPrepared(candidateInput(prepared), {
        nanoDet: PRODUCTION_NANODET_DECODE_PROFILE,
      }),
    ),
    PERSON_INFERENCE_TIMEOUT_MS,
  ).catch((error) => {
    retireProductionFastBundle(bundle, error instanceof Error ? error.message : String(error));
    throw error;
  });
  return productionNanoDetPersonPass(result.detections);
}

export interface FastFacePass {
  boxes: FaceBox[];
  landmarks: Array<FaceLandmarks | null>;
}

export function mergeFastFacesWithLegacy(
  fast: FastFacePass,
  legacy: readonly FaceBox[],
): FastFacePass {
  const boxes = [...fast.boxes];
  const landmarks = [...fast.landmarks];
  for (const candidate of legacy) {
    const rawCandidate: RawBox = {
      x1: candidate.x, y1: candidate.y,
      x2: candidate.x + candidate.width, y2: candidate.y + candidate.height,
      score: candidate.score,
    };
    let overlappingIndex = -1;
    let strongestOverlap = IOU_THRESHOLD;
    for (let index = 0; index < boxes.length; index++) {
      const box = boxes[index];
      const overlap = iou(rawCandidate, {
        x1: box.x, y1: box.y,
        x2: box.x + box.width, y2: box.y + box.height,
        score: box.score,
      });
      if (overlap > strongestOverlap) {
        strongestOverlap = overlap;
        overlappingIndex = index;
      }
    }
    if (overlappingIndex < 0) {
      boxes.push(candidate);
      landmarks.push(null);
      continue;
    }

    const fastBox = boxes[overlappingIndex];
    // YuNet landmarks are valuable for SFace, so a small confidence difference
    // is not enough to throw them away. But a weak YuNet proposal must not win
    // merely by arriving first when UltraFace independently reports the same
    // face with materially stronger evidence.
    if (fastBox.score < FAST_FACE_RELIABILITY_FLOOR &&
      candidate.score >= fastBox.score + LEGACY_FACE_REPLACEMENT_MARGIN) {
      boxes[overlappingIndex] = candidate;
      landmarks[overlappingIndex] = null;
    }
  }
  return { boxes, landmarks };
}

async function runYuNetFastPass(
  bundle: ProductionFastDetectorBundle,
  prepared?: PreparedImagePayload['yuNet'],
): Promise<FastFacePass> {
  if (!prepared) throw new Error('preprocess worker omitted requested YuNet tensor');
  fastFaceRuns++;
  const result = await fastFaceInferenceCircuit.run(
    () => trackProductionFastInference(bundle, () => bundle.face.runPrepared({
      data: prepared.data,
      dimensions: [1, 3, 640, 640],
      transform: {
        sourceWidth: prepared.sourceWidth,
        sourceHeight: prepared.sourceHeight,
        targetWidth: prepared.targetWidth,
        targetHeight: prepared.targetHeight,
        resizedWidth: prepared.resizedWidth,
        resizedHeight: prepared.resizedHeight,
        padLeft: prepared.padLeft,
        padTop: prepared.padTop,
      },
    })), DETECTOR_INFERENCE_TIMEOUT_MS,
  ).catch((error) => {
    retireProductionFastBundle(bundle, error instanceof Error ? error.message : String(error));
    throw error;
  });
  const withLandmarks = result.detections.filter(
    (detection): detection is CandidateDetection & { landmarks: FaceLandmarks } =>
      Array.isArray(detection.landmarks) && detection.landmarks.length === 5,
  );
  return {
    boxes: withLandmarks.map((detection) => ({
      x: detection.x, y: detection.y, width: detection.width,
      height: detection.height, score: detection.score,
    })),
    landmarks: withLandmarks.map((detection) => detection.landmarks),
  };
}

function mergePersonBoxes(...groups: FaceBox[][]): FaceBox[] {
  const raw = groups.flat().map((box) => ({
    x1: box.x,
    y1: box.y,
    x2: box.x + box.width,
    y2: box.y + box.height,
    score: box.score,
  }));
  return nms(raw).map((box) => ({
    x: box.x1,
    y: box.y1,
    width: box.x2 - box.x1,
    height: box.y2 - box.y1,
    score: box.score,
  }));
}

async function detectPersons(
  imagePath: string,
  cachedImg?: Electron.NativeImage,
  maxDimension = 320,
): Promise<PersonDetectionPass> {
  if (!personSession) throw new Error('Person detector not loaded');

  let img = cachedImg ?? await loadNativeImage(imagePath);

  const original = img.getSize();
  const scale = Math.min(1, maxDimension / Math.max(original.width, original.height));
  const targetW = Math.max(32, Math.round(original.width * scale));
  const targetH = Math.max(32, Math.round(original.height * scale));
  img = img.resize({ width: targetW, height: targetH });

  const bitmap = (img.toBitmap?.() ?? img.getBitmap()) as unknown as Buffer;
  const input = pixelsToHWCUint8(bitmap, targetW, targetH);
  return detectPersonsFromPrepared({ data: input, width: targetW, height: targetH });
}

async function detectPersonsFromPrepared(
  prepared: PreparedPersonTensor,
): Promise<PersonDetectionPass> {
  const session = personSession;
  if (!session) throw new Error('Person detector not loaded');
  const { data: input, width: targetW, height: targetH } = prepared;
  const tensor = new (getOrt().Tensor)('uint8', input, [1, targetH, targetW, 3]);
  const result = await personInferenceCircuit.run<Record<string, any>>(
    () => session.run({ [personInputName]: tensor }),
    PERSON_INFERENCE_TIMEOUT_MS,
  );

  const countKey = Object.keys(result).find((k) => k.includes('num_detections')) ?? Object.keys(result)[0];
  const boxesKey = Object.keys(result).find((k) => k.includes('detection_boxes')) ?? Object.keys(result)[1];
  const scoresKey = Object.keys(result).find((k) => k.includes('detection_scores')) ?? Object.keys(result)[2];
  const classesKey = Object.keys(result).find((k) => k.includes('detection_classes')) ?? Object.keys(result)[3];

  const countData = result[countKey].data as Float32Array | BigInt64Array | BigUint64Array;
  const boxes = result[boxesKey].data as Float32Array;
  const scores = result[scoresKey].data as Float32Array;
  const classes = result[classesKey].data as Float32Array;
  const detectionCount = Math.min(
    Math.round(Number(countData[0] ?? scores.length)),
    scores.length,
    classes.length,
    Math.floor(boxes.length / 4),
  );

  const raw: RawBox[] = [];
  let candidateCount = 0;
  for (let i = 0; i < detectionCount; i++) {
    const klass = Math.round(classes[i]);
    const score = scores[i];
    if (klass !== PERSON_CLASS_ID || score < PERSON_EVIDENCE_THRESHOLD) continue;
    const top = boxes[i * 4];
    const left = boxes[i * 4 + 1];
    const bottom = boxes[i * 4 + 2];
    const right = boxes[i * 4 + 3];
    const normalized = normalizeRawBox({ x1: left, y1: top, x2: right, y2: bottom, score }, 0.006);
    if (!normalized) continue;
    candidateCount++;
    if (score >= PERSON_THRESHOLD) raw.push(normalized);
  }

  return {
    boxes: nms(raw).map((b) => ({
      x: b.x1,
      y: b.y1,
      width: b.x2 - b.x1,
      height: b.y2 - b.y1,
      score: b.score,
    })),
    candidateCount,
  };
}

function personTensorFromSurface(
  image: Electron.NativeImage,
  maxDimension: number,
): PreparedPersonTensor {
  const original = image.getSize();
  const scale = Math.min(1, maxDimension / Math.max(original.width, original.height));
  const width = Math.max(32, Math.round(original.width * scale));
  const height = Math.max(32, Math.round(original.height * scale));
  const resized = image.resize({ width, height });
  const bitmap = (resized.toBitmap?.() ?? resized.getBitmap()) as unknown as Buffer;
  return { data: pixelsToHWCUint8(bitmap, width, height), width, height };
}

function nanoDetTensorFromSurface(
  image: Electron.NativeImage,
): NonNullable<PreparedImagePayload['nanoDet']> {
  const source = image.getSize();
  const targetWidth = 416 as const;
  const targetHeight = 416 as const;
  const scale = Math.min(targetWidth / source.width, targetHeight / source.height);
  const resizedWidth = Math.max(1, Math.round(source.width * scale));
  const resizedHeight = Math.max(1, Math.round(source.height * scale));
  const padLeft = Math.floor((targetWidth - resizedWidth) / 2);
  const padTop = Math.floor((targetHeight - resizedHeight) / 2);
  const resized = image.resize({ width: resizedWidth, height: resizedHeight });
  const bitmap = (resized.toBitmap?.() ?? resized.getBitmap()) as unknown as Buffer;
  const rgb = pixelsToHWCUint8(bitmap, resizedWidth, resizedHeight);
  const plane = targetWidth * targetHeight;
  const data = new Float32Array(plane * 3);
  const means = [103.53, 116.28, 123.675] as const;
  const deviations = [57.375, 57.12, 58.395] as const;
  // Black letterbox values must be normalized too, not left as float zero.
  for (let channel = 0; channel < 3; channel++) {
    data.fill((0 - means[channel]) / deviations[channel], channel * plane, (channel + 1) * plane);
  }
  for (let y = 0; y < resizedHeight; y++) {
    for (let x = 0; x < resizedWidth; x++) {
      const sourceOffset = (y * resizedWidth + x) * 3;
      const targetOffset = (y + padTop) * targetWidth + x + padLeft;
      for (let channel = 0; channel < 3; channel++) {
        data[channel * plane + targetOffset] = (rgb[sourceOffset + channel] - means[channel]) / deviations[channel];
      }
    }
  }
  return {
    data,
    sourceWidth: source.width,
    sourceHeight: source.height,
    targetWidth,
    targetHeight,
    resizedWidth,
    resizedHeight,
    padLeft,
    padTop,
  };
}

// ---------------------------------------------------------------------------
// OpenCV SFace embedding
// ---------------------------------------------------------------------------

const EMBED_W = 112;
const EMBED_H = 112;
// OpenCV's FaceRecognizerSF feeds SFace an RGB CHW blob at the original
// 0..255 scale (blobFromImage scale=1, mean=0, swapRB=true). Keep the exact
// upstream preprocessing here so the raw ONNX session matches that contract.
const SFACE_MEAN = [0, 0, 0];
const SFACE_STD = [1 / 255, 1 / 255, 1 / 255];

export function pixelsToSFaceCHW(
  pixels: Buffer,
  width: number,
  height: number,
): Float32Array {
  return pixelsToCHW(pixels, width, height, SFACE_MEAN, SFACE_STD);
}

const SFACE_REFERENCE_LANDMARKS: FaceLandmarks = [
  { x: 38.2946 / EMBED_W, y: 51.6963 / EMBED_H },
  { x: 73.5318 / EMBED_W, y: 51.5014 / EMBED_H },
  { x: 56.0252 / EMBED_W, y: 71.7366 / EMBED_H },
  { x: 41.5493 / EMBED_W, y: 92.3655 / EMBED_H },
  { x: 70.7299 / EMBED_W, y: 92.2041 / EMBED_H },
];

/**
 * Warp an upright source bitmap to OpenCV SFace's canonical five-point crop.
 * The closed-form least-squares similarity transform avoids a native resize
 * round-trip and preserves the platform's existing RGBA/BGRA channel order.
 */
export function alignFaceBitmapForSFace(
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  landmarks: FaceLandmarks,
): Buffer {
  if (sourceWidth < 2 || sourceHeight < 2 || source.length < sourceWidth * sourceHeight * 4) {
    throw new Error('Invalid source bitmap for SFace alignment');
  }
  const reference = SFACE_REFERENCE_LANDMARKS.map((point) => ({
    x: point.x * EMBED_W,
    y: point.y * EMBED_H,
  }));
  const measured = landmarks.map((point) => ({
    x: point.x * sourceWidth,
    y: point.y * sourceHeight,
  }));
  const referenceCenter = reference.reduce(
    (sum, point) => ({ x: sum.x + point.x / 5, y: sum.y + point.y / 5 }),
    { x: 0, y: 0 },
  );
  const measuredCenter = measured.reduce(
    (sum, point) => ({ x: sum.x + point.x / 5, y: sum.y + point.y / 5 }),
    { x: 0, y: 0 },
  );
  let denominator = 0;
  let real = 0;
  let imaginary = 0;
  for (let index = 0; index < 5; index++) {
    const dx = reference[index].x - referenceCenter.x;
    const dy = reference[index].y - referenceCenter.y;
    const sx = measured[index].x - measuredCenter.x;
    const sy = measured[index].y - measuredCenter.y;
    denominator += dx * dx + dy * dy;
    real += dx * sx + dy * sy;
    imaginary += dx * sy - dy * sx;
  }
  if (!Number.isFinite(denominator) || denominator < 1e-6) {
    throw new Error('Degenerate SFace reference landmarks');
  }
  real /= denominator;
  imaginary /= denominator;
  if (!Number.isFinite(real) || !Number.isFinite(imaginary) ||
      Math.hypot(real, imaginary) < 0.05) {
    throw new Error('Degenerate YuNet landmarks for SFace alignment');
  }

  const output = Buffer.allocUnsafe(EMBED_W * EMBED_H * 4);
  for (let y = 0; y < EMBED_H; y++) {
    for (let x = 0; x < EMBED_W; x++) {
      const dx = x - referenceCenter.x;
      const dy = y - referenceCenter.y;
      const sourceX = measuredCenter.x + real * dx - imaginary * dy;
      const sourceY = measuredCenter.y + imaginary * dx + real * dy;
      const left = Math.max(0, Math.min(sourceWidth - 1, Math.floor(sourceX)));
      const top = Math.max(0, Math.min(sourceHeight - 1, Math.floor(sourceY)));
      const right = Math.min(sourceWidth - 1, left + 1);
      const bottom = Math.min(sourceHeight - 1, top + 1);
      const fx = clamp01(sourceX - left);
      const fy = clamp01(sourceY - top);
      const target = (y * EMBED_W + x) * 4;
      for (let channel = 0; channel < 4; channel++) {
        const topValue = source[(top * sourceWidth + left) * 4 + channel] * (1 - fx) +
          source[(top * sourceWidth + right) * 4 + channel] * fx;
        const bottomValue = source[(bottom * sourceWidth + left) * 4 + channel] * (1 - fx) +
          source[(bottom * sourceWidth + right) * 4 + channel] * fx;
        output[target + channel] = Math.max(0, Math.min(255, Math.round(
          topValue * (1 - fy) + bottomValue * fy,
        )));
      }
    }
  }
  return output;
}

async function embedFace(
  imagePath: string,
  box: FaceBox,
  cachedImg?: Electron.NativeImage,
  landmarks?: FaceLandmarks | null,
): Promise<Float32Array> {
  const session = embedderSession;
  if (!session) throw new Error('Face engine not loaded');

  // Read full image, crop to face box, resize to 112×112
  let img = cachedImg ?? await loadNativeImage(imagePath);
  const { width: imgW, height: imgH } = img.getSize();

  let bitmap: Buffer;
  if (landmarks) {
    const sourceBitmap = (img.toBitmap?.() ?? img.getBitmap()) as unknown as Buffer;
    bitmap = alignFaceBitmapForSFace(sourceBitmap, imgW, imgH, landmarks);
  } else {
    // Verified legacy fallback: preserve the established padded box crop.
    const padX = box.width * 0.12;
    const padY = box.height * 0.16;
    const left = clamp01(box.x - padX);
    const top = clamp01(box.y - padY);
    const right = clamp01(box.x + box.width + padX);
    const bottom = clamp01(box.y + box.height + padY);
    const cropX = Math.max(0, Math.round(left * imgW));
    const cropY = Math.max(0, Math.round(top * imgH));
    const cropW = Math.min(imgW - cropX, Math.max(1, Math.round((right - left) * imgW)));
    const cropH = Math.min(imgH - cropY, Math.max(1, Math.round((bottom - top) * imgH)));
    if (cropW < 2 || cropH < 2) throw new Error('Invalid face crop');
    img = img.crop({ x: cropX, y: cropY, width: cropW, height: cropH });
    img = img.resize({ width: EMBED_W, height: EMBED_H });
    bitmap = (img.toBitmap?.() ?? img.getBitmap()) as unknown as Buffer;
  }
  const floats = pixelsToSFaceCHW(bitmap, EMBED_W, EMBED_H);
  const tensor = new (getOrt().Tensor)('float32', floats, [1, 3, EMBED_H, EMBED_W]);

  const feeds: Record<string, any> = { [embedderInputName]: tensor };
  const result = await embedderInferenceCircuit.run<Record<string, any>>(
    () => session.run(feeds) as Promise<Record<string, any>>,
    EMBEDDER_INFERENCE_TIMEOUT_MS,
  );

  // First (and only) output is the embedding vector
  const embKey = Object.keys(result)[0];
  const raw = result[embKey].data as Float32Array;

  // L2 normalise
  let norm = 0;
  for (let i = 0; i < raw.length; i++) norm += raw[i] * raw[i];
  norm = Math.sqrt(norm) + 1e-10;
  const normalised = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) normalised[i] = raw[i] / norm;

  return normalised;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyse faces in an image file.
 * Lazy-loads ONNX sessions on first call (~200ms warm-up, then reused).
 *
 * @param imagePath  Absolute path to a JPEG/PNG/HEIC/WEBP image.
 * @returns          Detected boxes + per-face embeddings.
 */
let _analyzeCallCount = 0;
let _analyzeTotalMs = 0;
let _decodeTotalMs = 0;
let _detectTotalMs = 0;
let _embedTotalMs = 0;
let _personRefinementCount = 0;
const personRefinementReasons = new Map<string, number>();

// Per-image inference timeout. Preprocessing itself has a stronger hard limit:
// its native worker process is destroyed and replaced. This outer deadline is
// retained as defence in depth, but quarantines only the affected path. A bad
// frame must never open a global circuit that prevents later files running.
const ANALYZE_TIMEOUT_MS = 30_000;

// The SSD MobileNet person model deliberately runs on CPU because DirectML is
// slower for this graph on the supported Windows stack. A single native ORT
// session already fans out across CPU threads, so allowing every whole-photo
// job to call it at once oversubscribes the processor (for example, 8 jobs x 6
// ORT threads on a 16-thread CPU). personInferenceCircuit keeps that stage at
// one active run and, unlike the former semaphore, rejects the whole queue if
// its native owner fails or exceeds its lease.

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`face-engine timeout: ${label}`));
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

const analysisInFlight = new Map<string, Promise<FaceAnalysisResult>>();
const analysisQuarantine = new Map<string, Error>();

function analysisSingleflightKey(
  imagePath: string,
  profile: FaceAnalysisProfile,
  orientation?: ExifOrientation,
  seed?: FaceAnalysisResult,
  sportsMode = false,
  embeddingLimit?: number,
): string {
  const features = {
    ...getFaceFeatureOptions(profile),
    embeddingLimit: effectiveEmbeddingLimit(profile, embeddingLimit),
  };
  const seedFeatures = seed?.features;
  const seedFingerprint = seed ? JSON.stringify({
    boxes: seed.boxes.length,
    persons: seed.personBoxes.length,
    embeddings: seed.embeddings.length,
    embeddingBoxes: seed.embeddingBoxes?.length ?? 0,
    poses: seed.poses?.length ?? 0,
    landmarks: seed.faceLandmarks?.length ?? 0,
    landmarkSets: seed.faceLandmarks?.filter(Boolean).length ?? 0,
    features: seedFeatures ? {
      faceMatching: seedFeatures.faceMatching,
      personDetection: seedFeatures.personDetection,
      poseAnalysis: seedFeatures.poseAnalysis,
      embeddingLimit: seedFeatures.embeddingLimit,
      eyeDetail: seedFeatures.eyeDetail,
      personFallback: seedFeatures.personFallback,
      personFallbackExecuted: seedFeatures.personFallbackExecuted,
      personFallbackCorroborated: seedFeatures.personFallbackCorroborated,
      sportsSafeguards: seedFeatures.sportsSafeguards,
      fastFaceDetection: seedFeatures.fastFaceDetection,
      fastPersonDetection: seedFeatures.fastPersonDetection,
      faceLandmarks: seedFeatures.faceLandmarks,
      faceDetectorId: seedFeatures.faceDetectorId,
      personDetectorId: seedFeatures.personDetectorId,
      detectorPipelineFingerprint: seedFeatures.detectorPipelineFingerprint,
    } : null,
  }) : 'no-seed';
  return JSON.stringify([
    imagePath,
    FACE_PIPELINE_FINGERPRINT,
    profile,
    `orientation:${orientation ?? 'read'}`,
    features.faceMatching ? 'match' : 'no-match',
    features.personDetection ? 'person' : 'no-person',
    features.poseAnalysis ? 'pose' : 'no-pose',
    `embed:${features.embeddingLimit}`,
    seedFingerprint,
    sportsMode ? 'sports' : 'general',
  ]);
}

export function analyzeFaces(
  imagePath: string,
  options: FaceAnalysisOptions = {},
): Promise<FaceAnalysisResult> {
  const quarantined = analysisQuarantine.get(imagePath);
  if (quarantined) return Promise.reject(quarantined);
  const profile = options.profile ?? 'full';
  const orientation = options.orientation;
  const key = analysisSingleflightKey(
    imagePath, profile, orientation, options.seed, options.sportsMode, options.embeddingLimit,
  );
  let operation = analysisInFlight.get(key);
  if (!operation) {
    operation = _analyzeFacesInner(
      imagePath, profile, orientation, options.seed, options.sportsMode, options.embeddingLimit,
    );
    analysisInFlight.set(key, operation);
    const cleanup = () => {
      if (analysisInFlight.get(key) === operation) analysisInFlight.delete(key);
    };
    // Clean up only when the native operation settles. A caller timeout must
    // not permit another inference for the same file to stack behind a hung
    // ONNX call.
    void operation.then(cleanup, cleanup);
  }
  return withTimeout(operation, ANALYZE_TIMEOUT_MS, imagePath, () => {
    analysisQuarantine.set(imagePath, new Error(
      `face-engine timeout: ${imagePath}; this file was quarantined and later files will continue`,
    ));
  });
}

async function runRequiredStage<T>(stage: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ImagePreprocessError || error instanceof FaceInferenceCircuitError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`face-engine ${stage} failed: ${detail}`);
  }
}

function resultInStoredOrientation(
  result: FaceAnalysisResult,
  orientation: ExifOrientation,
): FaceAnalysisResult {
  if (orientation === 1) return result;
  return {
    ...result,
    boxes: result.boxes.map((box) => mapBoxToStoredOrientation(box, orientation)),
    personBoxes: result.personBoxes.map((box) => mapBoxToStoredOrientation(box, orientation)),
    embeddingBoxes: result.embeddingBoxes?.map((box) => mapBoxToStoredOrientation(box, orientation)),
    faceLandmarks: result.faceLandmarks?.map((points) =>
      mapLandmarksToStoredOrientation(points, orientation)),
    poses: result.poses?.map((pose) => mapPoseToStoredOrientation(pose, orientation)),
  };
}

/** Lightweight, synchronous status for renderer polling; it never loads a model. */
export function getProductionFastDetectorRuntimeStatus(): ProductionFastDetectorRuntimeStatus {
  const activeBundle = productionFastDetectorState === 'active' &&
    activeProductionFastBundle?.generation === productionFastDetectorGeneration
    ? activeProductionFastBundle
    : null;
  return {
    state: productionFastDetectorState,
    active: activeBundle !== null,
    faceModel: getProductionFastDetector('face').id,
    personModel: getProductionFastDetector('person').id,
    faceProvider: activeBundle?.face.provider,
    personProvider: activeBundle?.person.provider,
    faceRuns: fastFaceRuns,
    personRuns: fastPersonRuns,
    ssdFallbacks: fastPersonSsdFallbacks,
    ssdFallbackRate: fastPersonRuns > 0
      ? Math.min(1, fastPersonSsdFallbacks / fastPersonRuns)
      : null,
    legacyFaceFallbacks: fastCascadeLegacyFaceFallbacks,
    legacyPersonFallbacks: fastCascadeLegacyPersonFallbacks,
    failure: productionFastDetectorFailure,
  };
}

export function getFaceEngineRuntimeDiagnostics() {
  return {
    preprocessing: getImagePreprocessSupervisorDiagnostics(),
    analysisSurfaces: getAnalysisSurfaceCacheDiagnostics(),
    inferenceCircuits: {
      detector: detectorInferenceCircuit.diagnostics(),
      embedder: embedderInferenceCircuit.diagnostics(),
      person: personInferenceCircuit.diagnostics(),
      fastFace: fastFaceInferenceCircuit.diagnostics(),
      fastPerson: fastPersonInferenceCircuit.diagnostics(),
    },
    personRefinements: {
      total: _personRefinementCount,
      reasons: Object.fromEntries(personRefinementReasons),
    },
    productionFastDetectors: {
      ...getProductionFastDetectorRuntimeStatus(),
      fingerprint: PRODUCTION_FAST_DETECTOR_FINGERPRINT,
    },
  };
}

async function _analyzeFacesInner(
  imagePath: string,
  profile: FaceAnalysisProfile,
  orientationHint?: ExifOrientation,
  seed?: FaceAnalysisResult,
  sportsMode = false,
  embeddingLimit?: number,
): Promise<FaceAnalysisResult> {
  await loadSessions();
  const t0 = Date.now();
  let decodeMs = 0;
  let detectMs = 0;
  let embedMs = 0;

  const finishStats = () => {
    _analyzeCallCount++;
    _decodeTotalMs += decodeMs;
    _detectTotalMs += detectMs;
    _embedTotalMs += embedMs;
    _analyzeTotalMs += Date.now() - t0;
    if (_analyzeCallCount % 10 === 0) {
      const avg = (_analyzeTotalMs / _analyzeCallCount).toFixed(0);
      const decodeAvg = (_decodeTotalMs / _analyzeCallCount).toFixed(0);
      const detectAvg = (_detectTotalMs / _analyzeCallCount).toFixed(0);
      const embedAvg = (_embedTotalMs / _analyzeCallCount).toFixed(0);
      log.info(`[face-engine] EP:${actualExecutionProvider ?? '?'} avg=${avg}ms/img decode=${decodeAvg}ms detect=${detectAvg}ms embed=${embedAvg}ms refined=${_personRefinementCount} over ${_analyzeCallCount} images`);
    }
  };

  try {
    const requestedFeatures = {
      ...getFaceFeatureOptions(profile),
      embeddingLimit: effectiveEmbeddingLimit(profile, embeddingLimit),
    };
    const resumePlan = getFaceAnalysisResumePlan(profile, seed, embeddingLimit);
    // Resolve the tiny EXIF tag first, then send every native pixel operation
    // to a supervised utility process. The returned 1024px bitmap is a single
    // shared surface for eyes, identity crops, person boxes and pose.
    const decodeStart = Date.now();
    const orientationValue = await runRequiredStage('orientation metadata', () =>
      orientationHint !== undefined ? Promise.resolve(orientationHint) : readExifOrientation(imagePath));
    const orientation = safeExifOrientation(orientationValue);
    const seedUpright = seed ? resultInUprightOrientation(seed, orientation) : undefined;
    const fastDetectorBundle = await getProductionFastDetectorBundle();
    const fastRouteActive = fastDetectorBundle !== null;
    const seedFastRouteMatches = !seedUpright || (
      seedUpright.features?.fastFaceDetection === fastRouteActive &&
      (!fastRouteActive ||
        seedUpright.features?.detectorPipelineFingerprint === PRODUCTION_FAST_DETECTOR_FINGERPRINT)
    );
    const seedFastPersonRouteMatches = !seedUpright || !requestedFeatures.personDetection || (
      seedUpright.features?.fastPersonDetection === fastRouteActive &&
      (!fastRouteActive ||
        seedUpright.features?.detectorPipelineFingerprint === PRODUCTION_FAST_DETECTOR_FINGERPRINT)
    );
    const seedHasPersonStage = seedUpright?.features?.personDetection === true;
    // Defend against a stale seed even if an upstream cache caller forgets to
    // require route provenance. Installing/removing the promoted pair must
    // actively upgrade/downgrade boxes instead of silently reusing the other
    // detector route.
    const shouldRunPerson = resumePlan.personDetection || !seedFastPersonRouteMatches;
    const shouldRunFaceDetector = resumePlan.faceDetection || !seedFastRouteMatches;
    const needsAnalysisSurface = profile !== 'detect';
    const sportsSafeguards = sportsMode || requestedFeatures.poseAnalysis;
    const nanoDetActive = fastDetectorBundle !== null;
    const fallbackResumeNeeded = shouldResumePersonFallback(
      seedUpright, sportsSafeguards, nanoDetActive,
    );
    const sportsSafeguardsResumeNeeded = shouldResumeSportsSafeguards(
      seedUpright, sportsSafeguards,
    );
    const includeNanoDetTensor = nanoDetActive &&
      (shouldRunPerson || fallbackResumeNeeded || sportsSafeguardsResumeNeeded);
    const { prepared, image: img } = await runRequiredStage('supervised preprocessing', () =>
      prepareImageOffMain(
        imagePath,
        orientation,
        needsAnalysisSurface,
        shouldRunFaceDetector && fastDetectorBundle === null,
        shouldRunPerson && fastDetectorBundle === null,
        includeNanoDetTensor,
        fastDetectorBundle !== null && shouldRunFaceDetector,
      ));
    decodeMs = Date.now() - decodeStart;
    await yieldToEventLoop();

    let boxes: FaceBox[] = seedUpright?.boxes ? [...seedUpright.boxes] : [];
    let faceLandmarks: Array<FaceLandmarks | null> = seedUpright?.faceLandmarks
      ? [...seedUpright.faceLandmarks]
      : boxes.map(() => null);
    let fastFaceCompleted = !shouldRunFaceDetector &&
      seedUpright?.features?.fastFaceDetection === true;
    let fastPersonCompleted = !shouldRunPerson &&
      seedUpright?.features?.fastPersonDetection === true;
    let legacyFaceUsed = false;
    let legacyPersonUsed = false;
    let nanoDetAttemptedThisAnalysis = false;
    let ssdFallbackCountedThisAnalysis = false;
    const markNanoDetSsdFallback = () => {
      if (!nanoDetAttemptedThisAnalysis || ssdFallbackCountedThisAnalysis) return;
      ssdFallbackCountedThisAnalysis = true;
      fastPersonSsdFallbacks++;
    };
    let legacyPersonCorroborated = !shouldRunPerson &&
      seedUpright?.features?.personFallbackCorroborated === true;
    let fastPersons: PersonDetectionPass = seedHasPersonStage
      ? { boxes: [...(seedUpright?.personBoxes ?? [])], candidateCount: seedUpright?.personBoxes.length ?? 0 }
      : { boxes: [], candidateCount: 0 };
    const detectStart = Date.now();
    const poseRequested = requestedFeatures.poseAnalysis;
    let deferredLegacyFaceTensor: Promise<Float32Array> | null = null;
    const legacyFaceTensor = (): Promise<Float32Array> => {
      if (prepared.detectorCHW.length > 0) return Promise.resolve(prepared.detectorCHW);
      if (img) {
        const pixels = resizeToPixels(img, DETECTOR_W, DETECTOR_H);
        return Promise.resolve(pixelsToCHW(pixels.data, pixels.width, pixels.height, DET_MEAN, DET_STD));
      }
      if (!deferredLegacyFaceTensor) {
        // Detector-only previews omit the 1024px surface. A selective fallback
        // pays for one supervised legacy tensor rather than packing it for
        // every successful YuNet frame.
        deferredLegacyFaceTensor = prepareImageOffMain(
          imagePath, orientation, false, true, false, false, false,
        ).then((fallback) => fallback.prepared.detectorCHW);
      }
      return deferredLegacyFaceTensor;
    };
    const runLegacyFace = async (): Promise<FaceBox[]> => {
      legacyFaceUsed = true;
      fastCascadeLegacyFaceFallbacks++;
      return runFaceDetectorTensor(await legacyFaceTensor());
    };
    const runLegacyPerson = async (): Promise<PersonDetectionPass> => {
      legacyPersonUsed = true;
      fastCascadeLegacyPersonFallbacks++;
      const tensor = prepared.fastPerson ?? (img ? personTensorFromSurface(img, 320) : undefined);
      if (!tensor) throw new Error('person fallback has no decoded analysis surface');
      const result = await detectPersonsFromPrepared(tensor);
      legacyPersonCorroborated ||= result.boxes.length > 0;
      return result;
    };
    const runFastFace = async (): Promise<FastFacePass> => {
      if (!fastDetectorBundle) {
        const legacy = await runLegacyFace();
        return { boxes: legacy, landmarks: legacy.map(() => null) };
      }
      try {
        const fast = await runYuNetFastPass(fastDetectorBundle, prepared.yuNet);
        // A zero/weak/cropped-edge result is not final culling evidence. Pay for
        // the verified UltraFace pass and merge it; keep landmarks only when
        // the box list remains the direct YuNet result so alignment is exact.
        const needsFallback = shouldUseLegacyDetectorFallback(
          fast.boxes, FAST_FACE_RELIABILITY_FLOOR,
        );
        if (needsFallback) {
          fastFaceCompleted = true;
          return mergeFastFacesWithLegacy(fast, await runLegacyFace());
        }
        fastFaceCompleted = true;
        return fast;
      } catch (error) {
        if (error instanceof FaceInferenceCircuitError) {
          log.warn('[face-engine] YuNet fast pass failed; using UltraFace:', error.message);
        }
        const legacy = await runLegacyFace();
        return { boxes: legacy, landmarks: legacy.map(() => null) };
      }
    };
    const runFastPerson = async (): Promise<PersonDetectionPass> => {
      if (!fastDetectorBundle) return runLegacyPerson();
      try {
        nanoDetAttemptedThisAnalysis = prepared.nanoDet !== undefined;
        const fast = await runNanoDetFastPass(fastDetectorBundle, prepared.nanoDet);
        const needsFallback = shouldUseLegacyDetectorFallback(fast.boxes, 0.48);
        if (needsFallback) {
          fastPersonCompleted = true;
          markNanoDetSsdFallback();
          const legacy = await runLegacyPerson();
          return {
            boxes: mergePersonBoxes(fast.boxes, legacy.boxes),
            candidateCount: Math.max(fast.candidateCount, legacy.candidateCount),
          };
        }
        fastPersonCompleted = true;
        return fast;
      } catch (error) {
        log.warn('[face-engine] NanoDet fast pass failed; using SSD:',
          error instanceof Error ? error.message : String(error));
        markNanoDetSsdFallback();
        return runLegacyPerson();
      }
    };
    if (!shouldRunFaceDetector && !shouldRunPerson) {
      // A subjects/full seed makes detection a zero-cost feature enrichment.
    } else if (profile === 'detect') {
      const face = await runRequiredStage('face detection', runFastFace);
      boxes = face.boxes;
      faceLandmarks = face.landmarks;
    } else if (shouldRunFaceDetector && shouldRunPerson) {
      const [face, person] = await runRequiredStage('detection', () => Promise.all([
        runFastFace(), runFastPerson(),
      ]));
      boxes = face.boxes;
      faceLandmarks = face.landmarks;
      fastPersons = person;
    } else {
      if (shouldRunFaceDetector) {
        const face = await runRequiredStage('face detection', runFastFace);
        boxes = face.boxes;
        faceLandmarks = face.landmarks;
      }
      if (shouldRunPerson) {
        fastPersons = await runRequiredStage('person detection', runFastPerson);
      }
    }

    let personBoxes = fastPersons.boxes;
    let personFallbackEvaluated = seedUpright?.features?.personFallback === true;
    let sportsSafeguardsEvaluated = seedUpright?.features?.sportsSafeguards === true;
    let sportsSafeguardsFailed = false;
    const imageSize = img?.getSize() ?? { width: 0, height: 0 };
    const personRefinementNeeded = (shouldRunPerson || sportsSafeguardsResumeNeeded) &&
      shouldRefinePersonDetection({
      width: imageSize.width,
      height: imageSize.height,
      faceBoxes: boxes,
      fastBoxes: fastPersons.boxes,
      candidateCount: fastPersons.candidateCount,
      sportsMode: sportsSafeguards,
    });
    if (personRefinementNeeded) {
      try {
        const reason = personRefinementReason({
          faceBoxes: boxes,
          fastBoxes: fastPersons.boxes,
          candidateCount: fastPersons.candidateCount,
        });
        // Only the evidence-triggered minority pays for the 640 tensor. It is
        // derived from the retained 1024 surface, never another file decode.
        markNanoDetSsdFallback();
        const refined = await detectPersonsFromPrepared(personTensorFromSurface(img!, 640));
        legacyPersonCorroborated ||= refined.boxes.length > 0;
        personBoxes = mergePersonBoxes(fastPersons.boxes, refined.boxes);
        // The persisted set is now a NanoDet + SSD union, not a pure fast pass.
        legacyPersonUsed = true;
        _personRefinementCount++;
        personRefinementReasons.set(reason, (personRefinementReasons.get(reason) ?? 0) + 1);
        if (_personRefinementCount % 25 === 0) {
          log.info('[face-engine] person refinement reasons:',
            JSON.stringify(Object.fromEntries(personRefinementReasons)));
        }
      } catch (error) {
        if (error instanceof FaceInferenceCircuitError) throw error;
        // The verified 320 pass is still a valid completed person stage. A
        // failed optional refinement must not erase those detections.
        log.warn('[face-engine] adaptive person refinement failed:',
          error instanceof Error ? error.message : String(error));
        // A confirmed fast-pass person still establishes people presence; a
        // failed optional high-resolution refinement must not make the sports
        // safeguard marker retry forever. Zero-person disagreement remains
        // incomplete because that refinement was the false-negative guard.
        if (sportsSafeguards && personBoxes.length === 0) sportsSafeguardsFailed = true;
      }
    }
    if (sportsSafeguards && (shouldRunPerson || sportsSafeguardsResumeNeeded)) {
      // This marker records that the sports-specific decision/refinement path
      // ran. It deliberately remains false after a failed required refinement
      // so a persisted general cache cannot hide the failure forever.
      sportsSafeguardsEvaluated = !sportsSafeguardsFailed;
    }
    if (sportsSafeguards && nanoDetActive && (shouldRunPerson || fallbackResumeNeeded)) {
      // The promoted NanoDet pass is the primary result. This marker means the
      // verified alternate detector route was evaluated; any evidence-driven
      // SSD merge above is provenance-preserving selective fallback.
      personFallbackEvaluated = true;
    }
    const seedHasEyeDetail = seedUpright?.features?.eyeDetail === true;
    let eyeDetailComplete = seedHasEyeDetail || boxes.length === 0;
    if (resumePlan.eyeDetail) {
      const eyeDetail = await annotateEyeDetail(img!, boxes);
      boxes = eyeDetail.boxes;
      eyeDetailComplete = eyeDetail.complete;
    }
    await yieldToEventLoop();
    detectMs = Date.now() - detectStart;

    const seedHasPoseStage = seedUpright?.features?.poseAnalysis === true;
    let poses: PoseKeypoints[] = seedHasPoseStage ? [...(seedUpright?.poses ?? [])] : [];
    let poseAnalysisComplete = seedHasPoseStage || !poseRequested || personBoxes.length === 0;
    if (resumePlan.poseAnalysis && personBoxes.length > 0) {
      const estimated = await estimatePosesDetailed(img!, personBoxes).catch((error) => {
        log.warn('[face-engine] optional pose stage failed:',
          error instanceof Error ? error.message : String(error));
        return { poses: [] as PoseKeypoints[], selectedCount: 0, successfulSelectedCount: 0 };
      });
      // estimatePoses preserves alignment with score-zero placeholders for an
      // individual failed/bounded crop. Successful athlete poses survive.
      poseAnalysisComplete = estimated.selectedCount > 0 &&
        estimated.successfulSelectedCount === estimated.selectedCount;
      poses = estimated.poses;
      if (poses.length > 0) await yieldToEventLoop();
    }

    let embeddings: Float32Array[] = [...(seedUpright?.embeddings ?? [])];
    let embeddingBoxes: FaceBox[] = [...(seedUpright?.embeddingBoxes ?? [])];
    const shouldRunFaceMatching = requestedFeatures.faceMatching;
    const seedHasMatchingStage = seedUpright?.features?.faceMatching === true &&
      (seedUpright.features.embeddingLimit ?? 0) >= requestedFeatures.embeddingLimit;
    let faceMatchingComplete = seedHasMatchingStage || (shouldRunFaceMatching && boxes.length === 0);
    let completedEmbeddingLimit = seedHasMatchingStage
      ? seedUpright?.features?.embeddingLimit ?? requestedFeatures.embeddingLimit
      : shouldRunFaceMatching ? requestedFeatures.embeddingLimit : seedUpright?.features?.embeddingLimit ?? 0;

    if (resumePlan.faceMatching && boxes.length > 0) {
      // Embed only the strongest useful faces in crowds. This cap limits crop
      // and dispatch cost without changing face/person detections.
      const rankedFaces = rankFacesForEmbedding(boxes);
      const reliableFaces = rankedFaces.filter(isReliableFaceForEmbedding);
      const crowdAdaptiveLimit = boxes.length >= 12 ? 4
        : boxes.length >= 8 ? 6
        : faceEmbeddingLimit;
      const effectiveEmbeddingLimit = Math.min(requestedFeatures.embeddingLimit, crowdAdaptiveLimit);
      const facesToEmbed = (reliableFaces.length > 0 ? reliableFaces : rankedFaces.slice(0, 1))
        .slice(0, effectiveEmbeddingLimit);
      const embedStart = Date.now();
      const embedConcurrency = providerDiagnostics.embedder.provider === 'dml'
        ? Math.min(4, Math.max(1, facesToEmbed.length))
        : 1;
      const embeddedByIndex = new Array<{ box: FaceBox; embedding: Float32Array } | null>(facesToEmbed.length).fill(null);
      let nextFaceIndex = 0;
      await Promise.all(Array.from({ length: embedConcurrency }, async () => {
        while (nextFaceIndex < facesToEmbed.length) {
          const index = nextFaceIndex++;
          const box = facesToEmbed[index];
          const boxIndex = boxes.indexOf(box);
          const landmarks = boxIndex >= 0 ? faceLandmarks[boxIndex] : null;
          const embedding = await embedFace(imagePath, box, img!, landmarks).catch((error) => {
            if (error instanceof FaceInferenceCircuitError) throw error;
            return null;
          });
          if (embedding) embeddedByIndex[index] = { box, embedding };
          await yieldToEventLoop();
        }
      }));
      const embeddedFaces = embeddedByIndex.filter(
        (entry): entry is { box: FaceBox; embedding: Float32Array } => entry !== null,
      );
      // Prefer freshly generated, requested-profile embeddings but retain any
      // valid seed values when an optional crop fails during enrichment.
      if (embeddedFaces.length > 0) {
        embeddings = embeddedFaces.map((entry) => entry.embedding);
        embeddingBoxes = embeddedFaces.map((entry) => entry.box);
      }
      faceMatchingComplete = embeddedFaces.length === facesToEmbed.length;
      completedEmbeddingLimit = faceMatchingComplete
        ? requestedFeatures.embeddingLimit
        : Math.max(seedUpright?.features?.embeddingLimit ?? 0, embeddings.length);
      embedMs = Date.now() - embedStart;
    }

    const result = resultInStoredOrientation({
      boxes,
      personBoxes,
      embeddings,
      embeddingBoxes,
      faceLandmarks,
      poses,
      features: {
        faceMatching: seedUpright?.features?.faceMatching === true || faceMatchingComplete,
        personDetection: seedHasPersonStage || shouldRunPerson,
        // A disabled/unrequested pose stage is not evidence that pose analysis
        // completed; keeping this false prevents a later sports/full request
        // from accepting a cache entry that contains no pose inference.
        poseAnalysis: seedHasPoseStage || (poseRequested && poseAnalysisComplete),
        embeddingLimit: completedEmbeddingLimit,
        eyeDetail: seedHasEyeDetail || (profile !== 'detect' && eyeDetailComplete),
        personFallback: seedUpright?.features?.personFallback === true || personFallbackEvaluated,
        personFallbackExecuted: !shouldRunPerson
          ? seedUpright?.features?.personFallbackExecuted === true
          : legacyPersonUsed,
        personFallbackCorroborated: legacyPersonCorroborated,
        sportsSafeguards: seedUpright?.features?.sportsSafeguards === true || sportsSafeguardsEvaluated,
        fastFaceDetection: fastFaceCompleted,
        fastPersonDetection: fastPersonCompleted,
        faceLandmarks: faceLandmarks.some((landmarks) => landmarks !== null),
        faceDetectorId: shouldRunFaceDetector
          ? fastFaceCompleted
            ? `${getProductionFastDetector('face').id}${legacyFaceUsed ? '+ultraface-fallback' : ''}`
            : FACE_MODEL_IDENTITIES.detector.fileName
          : seedUpright?.features?.faceDetectorId ?? FACE_MODEL_IDENTITIES.detector.fileName,
        personDetectorId: shouldRunPerson
          ? productionPersonDetectorId(fastPersonCompleted, legacyPersonCorroborated)
          : seedUpright?.features?.personDetectorId ?? FACE_MODEL_IDENTITIES.person.fileName,
        detectorPipelineFingerprint: PRODUCTION_FAST_DETECTOR_FINGERPRINT,
      },
    }, orientation);
    finishStats();
    return result;
  } finally {
    // Always release decoded image memory, including required-stage failures.
    imageDecodeCache.delete(imageDecodeCacheKey(imagePath, profile));
  }
}

export interface ProductionFastDetectorDiagnostic {
  active: boolean;
  fingerprint: string;
  faceModel: string;
  personModel: string;
  faceProvider?: string;
  personProvider?: string;
  faceDeviceId?: number;
  personDeviceId?: number;
  faceInferenceMs?: number;
  personInferenceMs?: number;
  failure?: string;
}

async function diagnoseProductionFastDetectors(
  bundle: ProductionFastDetectorBundle,
): Promise<ProductionFastDetectorDiagnostic> {
  const [face, person] = await Promise.all([
    fastFaceInferenceCircuit.run(
      () => trackProductionFastInference(bundle, () => bundle.face.runDiagnostic()),
      DETECTOR_INFERENCE_TIMEOUT_MS,
    ),
    fastPersonInferenceCircuit.run(
      () => trackProductionFastInference(bundle, () => bundle.person.runDiagnostic({
        nanoDet: PRODUCTION_NANODET_DECODE_PROFILE,
      })),
      PERSON_INFERENCE_TIMEOUT_MS,
    ),
  ]).catch((error) => {
    retireProductionFastBundle(bundle, error instanceof Error ? error.message : String(error));
    throw error;
  });
  return {
    active: true,
    fingerprint: PRODUCTION_FAST_DETECTOR_FINGERPRINT,
    faceModel: bundle.face.candidate.id,
    personModel: bundle.person.candidate.id,
    faceProvider: bundle.face.provider,
    personProvider: bundle.person.provider,
    faceDeviceId: bundle.face.deviceId,
    personDeviceId: bundle.person.deviceId,
    faceInferenceMs: face.timings.inferenceMs,
    personInferenceMs: person.timings.inferenceMs,
  };
}

/**
 * Run a quick native diagnostic: real zero-tensor inference through all legacy
 * sessions plus YuNet/NanoDet when their verified production pair is present.
 */
export async function diagnoseFaceEngine(): Promise<{
  ep: string | null;
  gpuAvailable: boolean | null;
  avgInferenceMs: number;
  sessionLoadMs: number;
  platform: string;
  providers: string[];
  models: FaceProviderDiagnostic[];
  productionFastDetectors: ProductionFastDetectorDiagnostic;
}> {
  const t0 = Date.now();
  await loadSessions();
  const sessionLoadMs = Date.now() - t0;

  const providers = getExecutionProviders();
  // Run 5 dummy detector inferences and time them
  const runtime = getOrt();
  const dummyInput = new Float32Array(1 * 3 * DETECTOR_H * DETECTOR_W);
  const tensor = new (runtime.Tensor)('float32', dummyInput, [1, 3, DETECTOR_H, DETECTOR_W]);
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t = Date.now();
    const session = detectorSession;
    if (!session) throw new Error('Face detector session is not loaded');
    await detectorInferenceCircuit.run(
      () => session.run({ [detectorInputName]: tensor }),
      DETECTOR_INFERENCE_TIMEOUT_MS,
    );
    times.push(Date.now() - t);
  }
  const avgInferenceMs = times.reduce((a, b) => a + b, 0) / times.length;

  // Session construction is not sufficient proof for a packaged native
  // runtime. Execute and decode one correctly shaped tensor through each
  // verified promoted graph. Any native error retires the pair so subsequent
  // photos immediately re-plan to the established UltraFace/SSD route.
  const fastBundle = await getProductionFastDetectorBundle();
  let productionFastDetectors: ProductionFastDetectorDiagnostic;
  if (fastBundle) {
    productionFastDetectors = await diagnoseProductionFastDetectors(fastBundle);
  } else {
    productionFastDetectors = {
      active: false,
      fingerprint: PRODUCTION_FAST_DETECTOR_FINGERPRINT,
      faceModel: getProductionFastDetector('face').id,
      personModel: getProductionFastDetector('person').id,
      failure: productionFastDetectorFailure ?? 'verified production fast detector pair unavailable',
    };
  }

  log.info('[face-engine] DIAG: EP=%s sessionLoad=%dms avgInference=%dms times=%s',
    actualExecutionProvider, sessionLoadMs, avgInferenceMs.toFixed(1), JSON.stringify(times));

  return {
    ep: actualExecutionProvider,
    gpuAvailable,
    avgInferenceMs,
    sessionLoadMs,
    platform: process.platform,
    providers,
    models: getFaceProviderDiagnostics(),
    productionFastDetectors,
  };
}

export async function runFaceGpuStressTest(durationMs = 8000, streams = 8): Promise<{
  ep: string | null;
  gpuAvailable: boolean | null;
  durationMs: number;
  streams: number;
  detectorRuns: number;
  embedderRuns: number;
  totalRuns: number;
  runsPerSecond: number;
  detectorAvgMs: number;
  embedderAvgMs: number;
  models: FaceProviderDiagnostic[];
}> {
  await loadSessions();
  const runtime = getOrt();
  const detectorTensor = makeWarmupTensor(runtime, 'detector');
  const embedderTensor = makeWarmupTensor(runtime, 'embedder');
  const detector = detectorSession;
  const embedder = embedderSession;
  if (!detector) throw new Error('Face detector session is not loaded');
  const boundedDurationMs = Math.max(2000, Math.min(30000, durationMs));
  const streamCount = Math.max(1, Math.min(32, Math.round(streams)));
  const startedAt = performance.now();
  const targetEnd = startedAt + boundedDurationMs;
  let detectorRuns = 0;
  let embedderRuns = 0;
  let detectorMs = 0;
  let embedderMs = 0;

  // Keep DML-backed sessions busy with independent loops. This is a
  // verification tool, not the production pipeline, so it intentionally avoids
  // decode/person/embedding-crop work and should show up under GPU Compute.
  const loops = Array.from({ length: streamCount }, (_, index) => {
    const runDetector = index % 2 === 0;
    return (async () => {
      while (performance.now() < targetEnd) {
        const t = performance.now();
        if (runDetector) {
          await detectorInferenceCircuit.run(
            () => detector.run({ [detectorInputName]: detectorTensor }),
            DETECTOR_INFERENCE_TIMEOUT_MS,
          );
          detectorMs += performance.now() - t;
          detectorRuns++;
        } else if (embedder) {
          await embedderInferenceCircuit.run(
            () => embedder.run({ [embedderInputName]: embedderTensor }),
            EMBEDDER_INFERENCE_TIMEOUT_MS,
          );
          embedderMs += performance.now() - t;
          embedderRuns++;
        }
      }
    })();
  });
  await Promise.all(loops);

  const elapsed = Math.max(1, performance.now() - startedAt);
  const totalRuns = detectorRuns + embedderRuns;
  return {
    ep: actualExecutionProvider,
    gpuAvailable,
    durationMs: elapsed,
    streams: streamCount,
    detectorRuns,
    embedderRuns,
    totalRuns,
    runsPerSecond: Math.round((totalRuns / elapsed) * 1000),
    detectorAvgMs: detectorRuns ? detectorMs / detectorRuns : 0,
    embedderAvgMs: embedderRuns ? embedderMs / embedderRuns : 0,
    models: getFaceProviderDiagnostics(),
  };
}

/**
 * Cosine similarity between two L2-normalised embedding vectors.
 * Returns a value in [0, 1] where 1 = identical face, ~0.5 = different person.
 * A threshold of ~0.65–0.70 works well for "same person" clustering.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  // Both vectors are already L2-normalised, so ||a||=||b||=1 and cos = dot
  return Math.max(0, Math.min(1, dot));
}

/**
 * Serialise a Float32Array embedding to a compact hex string for storage
 * on MediaFile.faceEmbedding/faceEmbeddings.
 * Use deserializeEmbedding() to recover the Float32Array.
 */
export function serializeEmbedding(embedding: Float32Array): string {
  const buf = Buffer.from(embedding.buffer);
  return buf.toString('hex');
}

export function deserializeEmbedding(hex: string): Float32Array {
  const buf = Buffer.from(hex, 'hex');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}

/**
 * Returns true when the face models are present on disk.
 * Use this to conditionally show the face-analysis feature in the UI.
 */
export function faceModelsAvailable(): boolean {
  try {
    modelPath(FACE_MODEL_IDENTITIES.detector.fileName);
    modelPath(FACE_MODEL_IDENTITIES.embedder.fileName);
    modelPath(FACE_MODEL_IDENTITIES.person.fileName);
    return true;
  } catch {
    return false;
  }
}
