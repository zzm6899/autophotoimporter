/**
 * Persistent cache for face-analysis results.
 *
 * The primary store is a single WAL-mode SQLite database. This avoids creating
 * and scanning hundreds of thousands of tiny JSON files, batches concurrent
 * writes into transactions, and retains enough results for million-photo
 * libraries. Existing sharded JSON records are migrated lazily on first use.
 *
 * Cache identity deliberately remains compatible with the previous store:
 * md5(absPath + mtimeMs + size + pipeline fingerprint). A rename, content
 * change, or model/preprocessing revision therefore invalidates the result.
 */

import crypto from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { app } from 'electron';
import type { PoseKeypoints } from '../../shared/types';
import type { FaceAnalysisProfile, FaceAnalysisResult, FaceBox, FaceLandmarks } from './face-engine';
import { FACE_PIPELINE_FINGERPRINT } from './face-model-manifest';

// v4 records exact model/preprocessing provenance and orientation-normalized
// inference, so previous schema versions must not be reused.
const SCHEMA_VERSION = 4;
const DATABASE_SCHEMA_VERSION = 2;
const DATABASE_NAME = 'face-analysis.sqlite';

// This keeps at least one complete million-photo library while placing a hard
// bound on runaway cache growth. Maintenance trims to the lower target so it
// is infrequent rather than running for every new photo at the boundary.
const MAX_DATABASE_ENTRIES = 1_250_000;
const TARGET_DATABASE_ENTRIES = 1_150_000;
const MAX_DATABASE_PAYLOAD_BYTES = 16 * 1024 * 1024 * 1024;
const TARGET_DATABASE_PAYLOAD_BYTES = 14 * 1024 * 1024 * 1024;
const MAINTENANCE_WRITE_INTERVAL = 4_096;
const MAX_PRUNE_BATCH = 50_000;

const MAX_MEMORY_ENTRIES = 4_000;
const SQLITE_WRITE_BATCH = 128;
const LEGACY_MAX_ENTRIES = 50_000;
const LEGACY_PRUNE_BATCH = 5_000;
const MAX_CACHE_ENTRY_BYTES = 16 * 1024 * 1024;
const ACCESS_TOUCH_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const EMBEDDING_BLOB_MAGIC = 0x31454346; // "FCE1" as little-endian bytes

interface CachedEntry {
  v: number;
  pipelineFingerprint: string;
  key: string;
  path: string;
  size: number;
  mtimeMs: number;
  cachedAt: number;
  /** Monotonic inference depth; absent legacy entries are conservatively full. */
  analysisDepth?: FaceAnalysisProfile;
  boxes: FaceBox[];
  /** Five-point YuNet geometry aligned 1:1 with boxes. */
  faceLandmarks?: Array<FaceLandmarks | null>;
  personBoxes: FaceBox[];
  embeddings: string[];
  embeddingBoxes?: FaceBox[];
  poses?: PoseKeypoints[];
  features: {
    faceMatching: boolean;
    personDetection: boolean;
    poseAnalysis: boolean;
    embeddingLimit: number;
    eyeDetail?: boolean;
    /** Selective alternate person detector was available and evaluated. */
    personFallback?: boolean;
    /** Selective SSD fallback ran, even when it returned zero people. */
    personFallbackExecuted?: boolean;
    /** Selective SSD fallback independently returned a person. */
    personFallbackCorroborated?: boolean;
    /** Sports-specific zero-evidence/disagreement safeguards completed. */
    sportsSafeguards?: boolean;
    fastFaceDetection?: boolean;
    fastPersonDetection?: boolean;
    faceLandmarks?: boolean;
    faceDetectorId?: string;
    personDetectorId?: string;
    detectorPipelineFingerprint?: string;
  };
}

type StoredEntryMetadata = Omit<CachedEntry, 'embeddings'>;

export interface FaceCacheIdentityHint {
  /** Source byte size captured by the scanner. */
  size: number;
  /** Source modification time captured by the scanner. */
  mtimeMs: number;
}

type RequiredFeatures = {
  faceMatching?: boolean;
  personDetection?: boolean;
  poseAnalysis?: boolean;
  /** Require the opt-in alternate person detector to have been evaluated. */
  personFallback?: boolean;
  /** Require face crops to have completed eye-detail measurement. */
  eyeDetail?: boolean;
  /** Require sports zero-evidence/disagreement safeguards. */
  sportsSafeguards?: boolean;
  /** Require the promoted YuNet pass to have completed. */
  fastFaceDetection?: boolean;
  /** Require the promoted NanoDet pass to have completed. */
  fastPersonDetection?: boolean;
  detectorPipelineFingerprint?: string;
  embeddingLimit?: number;
  /** Required cascade depth. A shallower result must never satisfy this read. */
  analysisDepth?: FaceAnalysisProfile;
  /** Avoid another filesystem stat when the scanner already captured identity. */
  identity?: FaceCacheIdentityHint;
};

type SqliteRunResult = { changes: number; lastInsertRowid: number | bigint };
type SqliteStatement = {
  run: (...params: unknown[]) => SqliteRunResult;
  get: (...params: unknown[]) => Record<string, unknown> | undefined;
  all: (...params: unknown[]) => Array<Record<string, unknown>>;
};
type SqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
};
type SqliteModule = {
  DatabaseSync: new (filename: string) => SqliteDatabase;
};

interface DatabaseStats {
  entryCount: number;
  payloadBytes: number;
}

export interface FaceCacheDiagnostics extends DatabaseStats {
  storageKind: 'sqlite' | 'json';
  databasePath?: string;
  pendingWrites: number;
  maxEntries: number;
  maxPayloadBytes: number;
}

export interface FaceCacheMaintenanceOptions {
  maxEntries?: number;
  targetEntries?: number;
  maxPayloadBytes?: number;
  targetPayloadBytes?: number;
}

interface PendingWrite {
  entry: CachedEntry;
  waiters: Array<() => void>;
}

interface SqliteWriteResult {
  prunedKeys: string[];
  /** Equal-depth writes rejected because they would discard completed evidence. */
  rejectedKeys: string[];
  /** Exact merged rows committed, used to keep the memory tier identical. */
  writtenEntries: CachedEntry[];
}

const createNodeRequire = createRequire(import.meta.url);

let cacheDirPromise: Promise<string> | null = null;
let sqliteStorePromise: Promise<SqliteFaceCache | null> | null = null;
let inMemoryHits = new Map<string, CachedEntry>();
let pendingWrites = new Map<string, PendingWrite>();
let flushScheduled = false;
let flushInFlight: Promise<void> | null = null;
let clearInFlight: Promise<void> | null = null;
let cacheGeneration = 0;
let legacyWritesSincePrune = 0;

function configuredPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function databaseEntryLimits(): {
  maxEntries: number;
  targetEntries: number;
  maxPayloadBytes: number;
  targetPayloadBytes: number;
} {
  const maxEntries = configuredPositiveInteger('KEPTRA_FACE_CACHE_MAX_ENTRIES', MAX_DATABASE_ENTRIES);
  const maxPayloadBytes = configuredPositiveInteger(
    'KEPTRA_FACE_CACHE_MAX_BYTES',
    MAX_DATABASE_PAYLOAD_BYTES,
  );
  return {
    maxEntries,
    targetEntries: Math.min(
      maxEntries,
      configuredPositiveInteger('KEPTRA_FACE_CACHE_TARGET_ENTRIES', TARGET_DATABASE_ENTRIES),
    ),
    maxPayloadBytes,
    targetPayloadBytes: Math.min(
      maxPayloadBytes,
      configuredPositiveInteger('KEPTRA_FACE_CACHE_TARGET_BYTES', TARGET_DATABASE_PAYLOAD_BYTES),
    ),
  };
}

function loadSqliteModule(): SqliteModule | null {
  try {
    return createNodeRequire('node:sqlite') as SqliteModule;
  } catch {
    return null;
  }
}

async function getCacheDir(): Promise<string> {
  if (!cacheDirPromise) {
    cacheDirPromise = (async () => {
      const directory = path.join(app.getPath('userData'), 'face-cache');
      await mkdir(directory, { recursive: true });
      return directory;
    })();
  }
  return cacheDirPromise;
}

function databasePathFor(cacheDirectory: string): string {
  return path.join(cacheDirectory, DATABASE_NAME);
}

function shardFor(key: string): string {
  return key.slice(0, 2);
}

async function legacyFileFor(key: string, createShard = false): Promise<string> {
  const directory = path.join(await getCacheDir(), shardFor(key));
  if (createShard) await mkdir(directory, { recursive: true });
  return path.join(directory, `${key}.json`);
}

function validIdentityHint(value?: FaceCacheIdentityHint): value is FaceCacheIdentityHint {
  return !!value
    && Number.isSafeInteger(value.size)
    && value.size >= 0
    && Number.isFinite(value.mtimeMs)
    && value.mtimeMs >= 0;
}

async function cacheIdentityFor(filePath: string, hint?: FaceCacheIdentityHint): Promise<{
  key: string;
  size: number;
  mtimeMs: number;
} | null> {
  try {
    const source = validIdentityHint(hint)
      ? hint
      : await stat(filePath);
    return {
      key: crypto
        .createHash('md5')
        .update(`${filePath}|${source.mtimeMs}|${source.size}|${FACE_PIPELINE_FINGERPRINT}`)
        .digest('hex'),
      size: source.size,
      mtimeMs: source.mtimeMs,
    };
  } catch {
    return null;
  }
}

export async function cacheKeyFor(
  filePath: string,
  identityHint?: FaceCacheIdentityHint,
): Promise<string | null> {
  return (await cacheIdentityFor(filePath, identityHint))?.key ?? null;
}

function rememberInMemory(key: string, entry: CachedEntry): CachedEntry {
  const existing = inMemoryHits.get(key);
  const preferred = preferCachedEntry(existing, entry);
  if (existing) inMemoryHits.delete(key);
  inMemoryHits.set(key, preferred);
  if (inMemoryHits.size > MAX_MEMORY_ENTRIES) {
    const oldest = inMemoryHits.keys().next().value as string | undefined;
    if (oldest) inMemoryHits.delete(oldest);
  }
  return preferred;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isFaceBox(value: unknown): value is FaceBox {
  if (!value || typeof value !== 'object') return false;
  const box = value as Record<string, unknown>;
  return isFiniteNumber(box.x)
    && isFiniteNumber(box.y)
    && isFiniteNumber(box.width)
    && isFiniteNumber(box.height)
    && isFiniteNumber(box.score);
}

function isFaceLandmarks(value: unknown): value is FaceLandmarks {
  return Array.isArray(value) && value.length === 5 && value.every((point) =>
    !!point && typeof point === 'object' &&
    isFiniteNumber((point as Record<string, unknown>).x) &&
    isFiniteNumber((point as Record<string, unknown>).y) &&
    Number((point as Record<string, unknown>).x) >= 0 &&
    Number((point as Record<string, unknown>).x) <= 1 &&
    Number((point as Record<string, unknown>).y) >= 0 &&
    Number((point as Record<string, unknown>).y) <= 1);
}

function isHexEmbedding(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length % 8 === 0
    && /^[0-9a-f]+$/i.test(value);
}

function isAnalysisDepth(value: unknown): value is FaceAnalysisProfile {
  return value === 'detect' || value === 'subjects' || value === 'full';
}

function analysisDepthRank(value: FaceAnalysisProfile): number {
  return value === 'full' ? 3 : value === 'subjects' ? 2 : 1;
}

/**
 * Pick the record that cannot regress already-completed work. Profile depth is
 * the primary monotonic dimension. At equal depth, an incoming record may
 * replace the current one only when it preserves every completed feature, the
 * embedding budget, and every embedding already stored.
 *
 * Feature vectors can be incomparable (for example matching-only versus
 * pose-only after a settings change). Keeping the existing record is safer
 * than trading one completed capability for another; a later request for the
 * missing capability remains an explicit cache miss.
 */
function boxIntersectionOverUnion(left: FaceBox, right: FaceBox): number {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (intersection <= 0) return 0;
  const union = left.width * left.height + right.width * right.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function hasUsablePose(pose: PoseKeypoints | undefined): boolean {
  if (!pose || pose.keypoints.length !== 17) return false;
  const usable = pose.keypoints.filter((point) =>
    Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.score));
  return usable.length === 17 && usable.some((point) => point.score > 0.05);
}

function isStoredPose(value: unknown): value is PoseKeypoints {
  if (!value || typeof value !== 'object') return false;
  const pose = value as Partial<PoseKeypoints>;
  if (!Array.isArray(pose.keypoints) || (pose.keypoints.length !== 0 && pose.keypoints.length !== 17)) return false;
  if (pose.score !== undefined && (!Number.isFinite(pose.score) || pose.score < 0 || pose.score > 1)) return false;
  return pose.keypoints.every((point) => !!point &&
    Number.isFinite(point.x) && point.x >= 0 && point.x <= 1 &&
    Number.isFinite(point.y) && point.y >= 0 && point.y <= 1 &&
    Number.isFinite(point.score) && point.score >= 0 && point.score <= 1);
}

function primaryPoseIndexes(personBoxes: FaceBox[]): number[] {
  return personBoxes
    .map((box, index) => {
      const centerX = box.x + box.width / 2;
      const centerY = box.y + box.height / 2;
      const centrality = 1 - Math.min(1, Math.hypot(centerX - 0.5, centerY - 0.48) / 0.72);
      const confidence = typeof box.score === 'number' ? box.score : 0.5;
      return {
        index,
        primaryScore: box.width * box.height * 3.2 + centrality * 0.35 + confidence * 0.25,
      };
    })
    .sort((left, right) => right.primaryScore - left.primaryScore)
    .slice(0, 2)
    .map((entry) => entry.index);
}

function poseEvidenceComplete(personBoxes: FaceBox[], poses: PoseKeypoints[] | undefined): boolean {
  if (personBoxes.length === 0) return true;
  return primaryPoseIndexes(personBoxes).every((index) => hasUsablePose(poses?.[index]));
}

function mergeFaceBoxEvidence(existing: FaceBox[], incoming: FaceBox[]): FaceBox[] {
  // The newest completed detector pass is authoritative. Unioning unmatched
  // boxes across reruns makes false positives immortal and slowly inflates face
  // counts. Retain only annotations from an IoU-matched previous box; identity
  // embeddings remain aligned to their separate embeddingBoxes array.
  return incoming.map((candidate) => {
    let previous: FaceBox | undefined;
    let bestIou = 0.45;
    for (const existingBox of existing) {
      const iou = boxIntersectionOverUnion(existingBox, candidate);
      if (iou > bestIou) {
        bestIou = iou;
        previous = existingBox;
      }
    }
    return {
      ...candidate,
      eyeScore: candidate.eyeScore ?? previous?.eyeScore,
      eyeSharpness: candidate.eyeSharpness ?? previous?.eyeSharpness,
    };
  });
}

function mergeFaceLandmarkEvidence(
  canonicalBoxes: FaceBox[],
  canonical: CachedEntry,
  previous: CachedEntry,
): Array<FaceLandmarks | null> | undefined {
  if (!canonical.faceLandmarks && !previous.faceLandmarks) return undefined;
  return canonicalBoxes.map((box, index) => {
    const direct = canonical.faceLandmarks?.[index];
    if (direct) return direct;
    let best: FaceLandmarks | null = null;
    let bestIou = 0.45;
    for (let previousIndex = 0; previousIndex < previous.boxes.length; previousIndex++) {
      const landmarks = previous.faceLandmarks?.[previousIndex];
      if (!landmarks) continue;
      const iou = boxIntersectionOverUnion(box, previous.boxes[previousIndex]);
      if (iou > bestIou) {
        bestIou = iou;
        best = landmarks;
      }
    }
    return best;
  });
}

function mergePersonAndPoseEvidence(
  existing: CachedEntry,
  incoming: CachedEntry,
): { personBoxes: FaceBox[]; poses?: PoseKeypoints[] } {
  // A detector-only shallower write has no authority over the person stage.
  // Once a fresh person pass completes, its canonical boxes replace the old
  // pass and usable pose evidence is transferred only to IoU-matched athletes.
  const canonical = incoming.features.fastPersonDetection && !existing.features.fastPersonDetection
    ? incoming
    : existing.features.fastPersonDetection && !incoming.features.fastPersonDetection
      ? existing
      : incoming.features.personDetection ? incoming : existing;
  const previous = canonical === incoming ? existing : incoming;
  const boxes = canonical.personBoxes.map((box) => ({ ...box }));
  const poses: Array<PoseKeypoints | undefined> = [];
  for (let canonicalIndex = 0; canonicalIndex < boxes.length; canonicalIndex++) {
    const canonicalPose = canonical.poses?.[canonicalIndex];
    if (hasUsablePose(canonicalPose)) {
      poses[canonicalIndex] = canonicalPose;
      continue;
    }
    let matchedPose: PoseKeypoints | undefined;
    let bestIou = 0.3;
    for (let previousIndex = 0; previousIndex < previous.personBoxes.length; previousIndex++) {
      const iou = boxIntersectionOverUnion(boxes[canonicalIndex], previous.personBoxes[previousIndex]);
      if (iou > bestIou) {
        bestIou = iou;
        const candidatePose = previous.poses?.[previousIndex];
        matchedPose = hasUsablePose(candidatePose) ? candidatePose : undefined;
      }
    }
    poses[canonicalIndex] = matchedPose;
  }

  const hasAnyPosePayload = existing.poses !== undefined || incoming.poses !== undefined;
  return {
    personBoxes: boxes,
    poses: hasAnyPosePayload
      ? poses.map((pose) => pose ?? { keypoints: [], score: 0 })
      : undefined,
  };
}

/**
 * Merge compatible results rather than selecting one whole record. A profile
 * upgrade may enrich identity or pose without rerunning eye/body stages, and
 * a later sports safeguard may be shallower than an already cached full pass.
 * Each evidence family is therefore monotonic independently.
 */
function preferCachedEntry(existing: CachedEntry | undefined, incoming: CachedEntry): CachedEntry {
  if (!existing) return incoming;
  const existingDepth = analysisDepthRank(existing.analysisDepth ?? 'full');
  const incomingDepth = analysisDepthRank(incoming.analysisDepth ?? 'full');
  const deeper = incomingDepth >= existingDepth ? incoming : existing;
  // Detector provenance and its canonical boxes move together. A later
  // feature-only legacy write must not replace a verified fast result while
  // leaving fast flags/landmarks behind (or vice versa).
  const canonicalFaceEvidence = incoming.features.fastFaceDetection && !existing.features.fastFaceDetection
    ? incoming
    : existing.features.fastFaceDetection && !incoming.features.fastFaceDetection
      ? existing
      : deeper;
  const otherFaceEvidence = canonicalFaceEvidence === incoming ? existing : incoming;
  const embeddingSource = incoming.embeddings.length >= existing.embeddings.length ? incoming : existing;
  const personEvidence = mergePersonAndPoseEvidence(existing, incoming);
  const poseWasCompleted = existing.features.poseAnalysis || incoming.features.poseAnalysis;
  const canonicalBoxes = mergeFaceBoxEvidence(otherFaceEvidence.boxes, canonicalFaceEvidence.boxes);
  const canonicalPersonEvidence = incoming.features.fastPersonDetection && !existing.features.fastPersonDetection
    ? incoming
    : existing.features.fastPersonDetection && !incoming.features.fastPersonDetection
      ? existing
      : incoming.features.personDetection ? incoming : existing;
  const mergedLandmarks = mergeFaceLandmarkEvidence(canonicalBoxes, canonicalFaceEvidence, otherFaceEvidence);
  return {
    ...deeper,
    cachedAt: Math.max(existing.cachedAt, incoming.cachedAt),
    analysisDepth: incomingDepth >= existingDepth
      ? incoming.analysisDepth ?? 'full'
      : existing.analysisDepth ?? 'full',
    boxes: canonicalBoxes,
    faceLandmarks: mergedLandmarks,
    personBoxes: personEvidence.personBoxes,
    poses: personEvidence.poses,
    embeddings: embeddingSource.embeddings,
    embeddingBoxes: embeddingSource.embeddingBoxes,
    features: {
      faceMatching: existing.features.faceMatching || incoming.features.faceMatching,
      personDetection: existing.features.personDetection || incoming.features.personDetection,
      // A newer body pass can add or reprioritise an athlete. Preserve the
      // completion marker only when every currently selected primary athlete
      // still has a usable aligned pose; score-zero placeholders are not work.
      poseAnalysis: poseWasCompleted &&
        poseEvidenceComplete(personEvidence.personBoxes, personEvidence.poses),
      embeddingLimit: Math.max(existing.features.embeddingLimit, incoming.features.embeddingLimit),
      eyeDetail: existing.features.eyeDetail === true || incoming.features.eyeDetail === true,
      personFallback: existing.features.personFallback === true || incoming.features.personFallback === true,
      personFallbackExecuted: canonicalPersonEvidence.features.personFallbackExecuted === true,
      personFallbackCorroborated: canonicalPersonEvidence.features.personFallbackCorroborated === true,
      sportsSafeguards: existing.features.sportsSafeguards === true || incoming.features.sportsSafeguards === true,
      fastFaceDetection: canonicalFaceEvidence.features.fastFaceDetection === true,
      fastPersonDetection: canonicalPersonEvidence.features.fastPersonDetection === true,
      faceLandmarks: mergedLandmarks?.some((landmarks) => landmarks !== null) === true,
      faceDetectorId: canonicalFaceEvidence.features.faceDetectorId,
      personDetectorId: canonicalPersonEvidence.features.personDetectorId,
      detectorPipelineFingerprint: canonicalFaceEvidence.features.detectorPipelineFingerprint ??
        canonicalPersonEvidence.features.detectorPipelineFingerprint,
    },
  };
}

function isValidEntry(value: unknown, expectedKey: string): value is CachedEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<CachedEntry>;
  const features = entry.features as CachedEntry['features'] | undefined;
  return entry.v === SCHEMA_VERSION
    && entry.pipelineFingerprint === FACE_PIPELINE_FINGERPRINT
    && entry.key === expectedKey
    && typeof entry.path === 'string'
    && isFiniteNumber(entry.size)
    && isFiniteNumber(entry.mtimeMs)
    && isFiniteNumber(entry.cachedAt)
    && (entry.analysisDepth === undefined || isAnalysisDepth(entry.analysisDepth))
    && Array.isArray(entry.boxes)
    && entry.boxes.every(isFaceBox)
    && (entry.faceLandmarks === undefined || (
      Array.isArray(entry.faceLandmarks) &&
      entry.faceLandmarks.length === entry.boxes.length &&
      entry.faceLandmarks.every((landmarks) => landmarks === null || isFaceLandmarks(landmarks))
    ))
    && Array.isArray(entry.personBoxes)
    && entry.personBoxes.every(isFaceBox)
    && (entry.poses === undefined || (
      Array.isArray(entry.poses) &&
      entry.poses.length <= 256 &&
      entry.poses.every(isStoredPose)
    ))
    && Array.isArray(entry.embeddings)
    && entry.embeddings.every(isHexEmbedding)
    && (entry.embeddingBoxes === undefined
      || (Array.isArray(entry.embeddingBoxes) && entry.embeddingBoxes.every(isFaceBox)))
    && !!features
    && typeof features.faceMatching === 'boolean'
    && typeof features.personDetection === 'boolean'
    && typeof features.poseAnalysis === 'boolean'
    && (features.eyeDetail === undefined || typeof features.eyeDetail === 'boolean')
    && (features.personFallback === undefined || typeof features.personFallback === 'boolean')
    && (features.personFallbackExecuted === undefined || typeof features.personFallbackExecuted === 'boolean')
    && (features.personFallbackCorroborated === undefined || typeof features.personFallbackCorroborated === 'boolean')
    && (features.sportsSafeguards === undefined || typeof features.sportsSafeguards === 'boolean')
    && (features.fastFaceDetection === undefined || typeof features.fastFaceDetection === 'boolean')
    && (features.fastPersonDetection === undefined || typeof features.fastPersonDetection === 'boolean')
    && (features.faceLandmarks === undefined || typeof features.faceLandmarks === 'boolean')
    && (features.faceDetectorId === undefined || typeof features.faceDetectorId === 'string')
    && (features.personDetectorId === undefined || typeof features.personDetectorId === 'string')
    && (features.detectorPipelineFingerprint === undefined || typeof features.detectorPipelineFingerprint === 'string')
    && Number.isInteger(features.embeddingLimit)
    && features.embeddingLimit >= 0;
}

function encodeEmbeddings(embeddings: string[]): Buffer {
  const buffers = embeddings.map((embedding) => {
    if (!isHexEmbedding(embedding)) throw new Error('Invalid cached face embedding');
    return Buffer.from(embedding, 'hex');
  });
  const headerBytes = 8 + buffers.length * 4;
  const dataBytes = buffers.reduce((total, buffer) => total + buffer.byteLength, 0);
  if (headerBytes + dataBytes > MAX_CACHE_ENTRY_BYTES) {
    throw new Error('Face cache entry exceeds the safe size limit');
  }
  const packed = Buffer.allocUnsafe(headerBytes + dataBytes);
  packed.writeUInt32LE(EMBEDDING_BLOB_MAGIC, 0);
  packed.writeUInt32LE(buffers.length, 4);
  let dataOffset = headerBytes;
  for (let index = 0; index < buffers.length; index++) {
    packed.writeUInt32LE(buffers[index].byteLength, 8 + index * 4);
    buffers[index].copy(packed, dataOffset);
    dataOffset += buffers[index].byteLength;
  }
  return packed;
}

function decodeEmbeddings(value: unknown): string[] {
  if (!(Buffer.isBuffer(value) || value instanceof Uint8Array)) {
    throw new Error('Invalid face embedding payload');
  }
  const packed = Buffer.from(value);
  if (packed.byteLength < 8 || packed.readUInt32LE(0) !== EMBEDDING_BLOB_MAGIC) {
    throw new Error('Unsupported face embedding payload');
  }
  const count = packed.readUInt32LE(4);
  if (count > 100_000 || 8 + count * 4 > packed.byteLength) {
    throw new Error('Corrupt face embedding header');
  }
  let dataOffset = 8 + count * 4;
  const embeddings: string[] = [];
  for (let index = 0; index < count; index++) {
    const byteLength = packed.readUInt32LE(8 + index * 4);
    if (byteLength === 0 || byteLength % 4 !== 0 || dataOffset + byteLength > packed.byteLength) {
      throw new Error('Corrupt face embedding data');
    }
    embeddings.push(packed.subarray(dataOffset, dataOffset + byteLength).toString('hex'));
    dataOffset += byteLength;
  }
  if (dataOffset !== packed.byteLength) throw new Error('Unexpected face embedding bytes');
  return embeddings;
}

function serializeForDatabase(entry: CachedEntry): {
  metadataJson: string;
  embeddingBlob: Buffer;
  payloadBytes: number;
} {
  const { embeddings, ...metadata } = entry;
  const metadataJson = JSON.stringify(metadata satisfies StoredEntryMetadata);
  const embeddingBlob = encodeEmbeddings(embeddings);
  const payloadBytes = Buffer.byteLength(metadataJson) + embeddingBlob.byteLength;
  if (payloadBytes > MAX_CACHE_ENTRY_BYTES) {
    throw new Error('Face cache entry exceeds the safe size limit');
  }
  return { metadataJson, embeddingBlob, payloadBytes };
}

function parseDatabaseEntry(row: Record<string, unknown>, expectedKey: string): CachedEntry {
  if (typeof row.payload_json !== 'string') throw new Error('Invalid face cache payload');
  const metadata = JSON.parse(row.payload_json) as StoredEntryMetadata;
  const entry = {
    ...metadata,
    embeddings: decodeEmbeddings(row.embeddings),
  };
  if (!isValidEntry(entry, expectedKey)) throw new Error('Stale or corrupt face cache entry');
  return entry;
}

function sqliteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0;
}

function isDatabaseCorruption(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /corrupt|malformed|not a database|file is encrypted/i.test(message);
}

class SqliteFaceCache {
  private readonly db: SqliteDatabase;
  private readonly getStatement: SqliteStatement;
  private readonly upsertStatement: SqliteStatement;
  private readonly touchStatement: SqliteStatement;
  private readonly deleteStatement: SqliteStatement;
  private writesSinceMaintenance = 0;

  constructor(public readonly databasePath: string, sqlite: SqliteModule) {
    this.db = new sqlite.DatabaseSync(databasePath);
    try {
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA temp_store = MEMORY;
        PRAGMA wal_autocheckpoint = 1000;
        PRAGMA auto_vacuum = INCREMENTAL;
        CREATE TABLE IF NOT EXISTS face_analysis_cache (
          key TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL,
          pipeline_fingerprint TEXT NOT NULL,
          source_path TEXT NOT NULL,
          file_size INTEGER NOT NULL,
          mtime_ms REAL NOT NULL,
        cached_at INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL,
        analysis_depth INTEGER NOT NULL DEFAULT 3,
        payload_bytes INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          embeddings BLOB NOT NULL
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS idx_face_cache_accessed
          ON face_analysis_cache (last_accessed_at);
        PRAGMA user_version = ${DATABASE_SCHEMA_VERSION};
      `);
      const cacheColumns = this.db.prepare('PRAGMA table_info(face_analysis_cache)').all();
      if (!cacheColumns.some((column) => column.name === 'analysis_depth')) {
        // Databases created by the initial development build predate cascade
        // profiles; all of those records came from the original full pass.
        this.db.exec('ALTER TABLE face_analysis_cache ADD COLUMN analysis_depth INTEGER NOT NULL DEFAULT 3;');
      }
      this.getStatement = this.db.prepare(`
        SELECT payload_json, embeddings, last_accessed_at
        FROM face_analysis_cache
        WHERE key = ? AND schema_version = ? AND pipeline_fingerprint = ?
      `);
      this.upsertStatement = this.db.prepare(`
        INSERT INTO face_analysis_cache (
          key, schema_version, pipeline_fingerprint, source_path, file_size,
          mtime_ms, cached_at, last_accessed_at, analysis_depth, payload_bytes,
          payload_json, embeddings
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          schema_version = excluded.schema_version,
          pipeline_fingerprint = excluded.pipeline_fingerprint,
          source_path = excluded.source_path,
          file_size = excluded.file_size,
          mtime_ms = excluded.mtime_ms,
          cached_at = excluded.cached_at,
          last_accessed_at = excluded.last_accessed_at,
          analysis_depth = excluded.analysis_depth,
          payload_bytes = excluded.payload_bytes,
          payload_json = excluded.payload_json,
          embeddings = excluded.embeddings
      `);
      this.touchStatement = this.db.prepare(
        'UPDATE face_analysis_cache SET last_accessed_at = ? WHERE key = ?',
      );
      this.deleteStatement = this.db.prepare('DELETE FROM face_analysis_cache WHERE key = ?');
    } catch (error) {
      try { this.db.close(); } catch { /* best effort */ }
      throw error;
    }
  }

  get(key: string): CachedEntry | null {
    const row = this.getStatement.get(key, SCHEMA_VERSION, FACE_PIPELINE_FINGERPRINT);
    if (!row) return null;
    try {
      const entry = parseDatabaseEntry(row, key);
      const lastAccessedAt = sqliteNumber(row.last_accessed_at);
      if (Date.now() - lastAccessedAt >= ACCESS_TOUCH_INTERVAL_MS) {
        this.touchStatement.run(Date.now(), key);
      }
      return entry;
    } catch {
      // A malformed row must behave as a miss and must not poison later reads.
      this.deleteStatement.run(key);
      return null;
    }
  }

  putMany(entries: CachedEntry[]): SqliteWriteResult {
    if (entries.length === 0) return { prunedKeys: [], rejectedKeys: [], writtenEntries: [] };
    // Merge against the durable row before serialising. This protects evidence
    // even when memory was cold after restart or a shallower sports pass adds a
    // capability to an older full record.
    const mergedEntries = entries.map((entry) => preferCachedEntry(this.get(entry.key) ?? undefined, entry));
    // Serialize before BEGIN so one pathological/oversized result cannot roll
    // back otherwise healthy records that happened to share its batch.
    const prepared = mergedEntries.flatMap((entry) => {
      try {
        return [{ entry, stored: serializeForDatabase(entry) }];
      } catch {
        return [];
      }
    });
    if (prepared.length === 0) return { prunedKeys: [], rejectedKeys: [], writtenEntries: [] };
    const now = Date.now();
    const rejectedKeys: string[] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const { entry, stored } of prepared) {
        const writeResult = this.upsertStatement.run(
          entry.key,
          SCHEMA_VERSION,
          FACE_PIPELINE_FINGERPRINT,
          entry.path,
          entry.size,
          entry.mtimeMs,
          entry.cachedAt,
          now,
          analysisDepthRank(entry.analysisDepth ?? 'full'),
          stored.payloadBytes,
          stored.metadataJson,
          stored.embeddingBlob,
        );
        if (writeResult.changes === 0) rejectedKeys.push(entry.key);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* best effort */ }
      throw error;
    }

    this.writesSinceMaintenance += prepared.length;
    if (this.writesSinceMaintenance < MAINTENANCE_WRITE_INTERVAL) {
      return {
        prunedKeys: [],
        rejectedKeys,
        writtenEntries: prepared.map(({ entry }) => entry),
      };
    }
    this.writesSinceMaintenance = 0;
    return {
      prunedKeys: this.prune({}),
      rejectedKeys,
      writtenEntries: prepared.map(({ entry }) => entry),
    };
  }

  stats(): DatabaseStats {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS entry_count, COALESCE(SUM(payload_bytes), 0) AS payload_bytes
      FROM face_analysis_cache
    `).get();
    return {
      entryCount: sqliteNumber(row?.entry_count),
      payloadBytes: sqliteNumber(row?.payload_bytes),
    };
  }

  prune(options: FaceCacheMaintenanceOptions): string[] {
    const configured = databaseEntryLimits();
    const maxEntries = Math.max(0, options.maxEntries ?? configured.maxEntries);
    const targetEntries = Math.min(
      maxEntries,
      Math.max(0, options.targetEntries ?? configured.targetEntries),
    );
    const maxPayloadBytes = Math.max(0, options.maxPayloadBytes ?? configured.maxPayloadBytes);
    const targetPayloadBytes = Math.min(
      maxPayloadBytes,
      Math.max(0, options.targetPayloadBytes ?? configured.targetPayloadBytes),
    );
    const removed: string[] = [];

    for (let pass = 0; pass < 32; pass++) {
      const current = this.stats();
      if (current.entryCount <= maxEntries && current.payloadBytes <= maxPayloadBytes) break;
      const averageBytes = Math.max(1, current.payloadBytes / Math.max(1, current.entryCount));
      const entriesOverTarget = Math.max(0, current.entryCount - targetEntries);
      const bytesOverTarget = Math.max(0, current.payloadBytes - targetPayloadBytes);
      const removeCount = Math.min(
        MAX_PRUNE_BATCH,
        current.entryCount,
        Math.max(1, entriesOverTarget, Math.ceil(bytesOverTarget / averageBytes)),
      );
      const rows = this.db.prepare(`
        SELECT key FROM face_analysis_cache
        ORDER BY last_accessed_at ASC, cached_at ASC
        LIMIT ?
      `).all(removeCount);
      if (rows.length === 0) break;

      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of rows) {
          if (typeof row.key !== 'string') continue;
          this.deleteStatement.run(row.key);
          removed.push(row.key);
        }
        this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { /* best effort */ }
        throw error;
      }
    }

    if (removed.length > 0) {
      try {
        this.db.exec('PRAGMA wal_checkpoint(PASSIVE); PRAGMA incremental_vacuum(4096);');
      } catch {
        // Logical bounds are already enforced; physical compaction is best-effort.
      }
    }
    return removed;
  }

  remove(key: string): void {
    this.deleteStatement.run(key);
  }

  clear(): void {
    this.db.exec(`
      PRAGMA secure_delete = ON;
      DELETE FROM face_analysis_cache;
      PRAGMA wal_checkpoint(TRUNCATE);
      VACUUM;
      PRAGMA wal_checkpoint(TRUNCATE);
    `);
  }

  close(): void {
    this.db.close();
  }
}

async function quarantineDatabase(databasePath: string): Promise<void> {
  const suffix = `.corrupt-${Date.now()}`;
  for (const extension of ['', '-wal', '-shm']) {
    const source = `${databasePath}${extension}`;
    await rename(source, `${databasePath}${suffix}${extension}`).catch(() => undefined);
  }
}

async function openSqliteStore(): Promise<SqliteFaceCache | null> {
  const sqlite = loadSqliteModule();
  if (!sqlite) return null;
  const databasePath = databasePathFor(await getCacheDir());
  try {
    return new SqliteFaceCache(databasePath, sqlite);
  } catch (error) {
    if (!isDatabaseCorruption(error)) return null;
    await quarantineDatabase(databasePath);
    try {
      return new SqliteFaceCache(databasePath, sqlite);
    } catch {
      return null;
    }
  }
}

async function getSqliteStore(): Promise<SqliteFaceCache | null> {
  if (!sqliteStorePromise) sqliteStorePromise = openSqliteStore();
  return sqliteStorePromise;
}

async function recoverFromRuntimeCorruption(store: SqliteFaceCache, error: unknown): Promise<void> {
  if (!isDatabaseCorruption(error)) return;
  try { store.close(); } catch { /* best effort */ }
  const databasePath = store.databasePath;
  sqliteStorePromise = null;
  await quarantineDatabase(databasePath);
}

function cacheEntryHasRequiredFeatures(
  entry: CachedEntry,
  requiredFeatures?: RequiredFeatures,
): boolean {
  if (!entry.features) return false;
  // Legacy v4 JSON predates profiles and was always produced by the original
  // full pipeline. Treating an absent marker as full preserves those valid
  // caches, while every newly cascaded result records its explicit depth.
  const storedDepth = entry.analysisDepth ?? 'full';
  const requiredDepth = requiredFeatures?.analysisDepth ?? 'full';
  if (analysisDepthRank(storedDepth) < analysisDepthRank(requiredDepth)) return false;
  if (requiredFeatures?.faceMatching && !entry.features.faceMatching) return false;
  if (requiredFeatures?.personDetection && !entry.features.personDetection) return false;
  if (requiredFeatures?.poseAnalysis && !entry.features.poseAnalysis) return false;
  if (requiredFeatures?.personFallback && !entry.features.personFallback) return false;
  if (requiredFeatures?.eyeDetail && !entry.features.eyeDetail) return false;
  if (requiredFeatures?.sportsSafeguards && !entry.features.sportsSafeguards) return false;
  if (requiredFeatures?.fastFaceDetection && !entry.features.fastFaceDetection) return false;
  if (requiredFeatures?.fastPersonDetection && !entry.features.fastPersonDetection) return false;
  if (requiredFeatures?.detectorPipelineFingerprint &&
      entry.features.detectorPipelineFingerprint !== requiredFeatures.detectorPipelineFingerprint) return false;
  if (
    requiredFeatures?.faceMatching
    && requiredFeatures.embeddingLimit
    && entry.features.embeddingLimit < requiredFeatures.embeddingLimit
    && entry.embeddings.length < entry.boxes.length
  ) {
    return false;
  }
  return true;
}

function rehydrate(entry: CachedEntry): { result: FaceAnalysisResult; hexEmbeddings: string[] } {
  const embeddings = entry.embeddings.map((hex) => {
    const buffer = Buffer.from(hex, 'hex');
    return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
  });
  return {
    result: {
      boxes: entry.boxes,
      faceLandmarks: entry.faceLandmarks,
      personBoxes: entry.personBoxes,
      embeddings,
      embeddingBoxes: entry.embeddingBoxes ?? [],
      poses: entry.poses,
      features: entry.features,
    },
    hexEmbeddings: entry.embeddings,
  };
}

async function readLegacyEntry(key: string): Promise<CachedEntry | null> {
  try {
    const raw = await readFile(await legacyFileFor(key), 'utf8');
    if (Buffer.byteLength(raw) > MAX_CACHE_ENTRY_BYTES * 2) return null;
    const entry = JSON.parse(raw) as unknown;
    return isValidEntry(entry, key) ? entry : null;
  } catch {
    return null;
  }
}

async function writeLegacyEntry(entry: CachedEntry): Promise<void> {
  const target = await legacyFileFor(entry.key, true);
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(entry), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
  } catch {
    await unlink(temporary).catch(() => undefined);
  }
  legacyWritesSincePrune++;
  if (legacyWritesSincePrune >= 500) {
    legacyWritesSincePrune = 0;
    void pruneLegacyJsonIfTooLarge().catch(() => undefined);
  }
}

function settlePendingWrites(writes: PendingWrite[]): void {
  for (const write of writes) {
    for (const resolve of write.waiters) resolve();
  }
}

async function flushPendingWriteBatch(): Promise<void> {
  if (flushInFlight) {
    await flushInFlight;
    if (pendingWrites.size > 0) await flushPendingWriteBatch();
    return;
  }
  if (pendingWrites.size === 0) return;
  const batchMap = pendingWrites;
  pendingWrites = new Map();
  const batch = Array.from(batchMap.values());
  const work = (async () => {
    const store = await getSqliteStore();
    if (store) {
      try {
        const { prunedKeys, rejectedKeys, writtenEntries } = store.putMany(batch.map((item) => item.entry));
        for (const entry of writtenEntries) rememberInMemory(entry.key, entry);
        for (const key of prunedKeys) inMemoryHits.delete(key);
        // A disk row can be richer than memory after an app restart. When the
        // SQL guard rejects a regressive equal-depth write, restore the actual
        // persisted record so reads in this process stay monotonic too.
        for (const key of rejectedKeys) {
          const persisted = store.get(key);
          if (persisted) rememberInMemory(key, persisted);
        }
      } catch (error) {
        await recoverFromRuntimeCorruption(store, error);
        // The cache is best-effort. A failed database write is deliberately not
        // replayed into thousands of legacy files on the main process hot path.
      }
    } else {
      await Promise.all(batch.map((item) => writeLegacyEntry(item.entry)));
    }
  })().finally(() => {
    settlePendingWrites(batch);
    flushInFlight = null;
    if (pendingWrites.size > 0) scheduleWriteFlush();
  });
  flushInFlight = work;
  return work;
}

function scheduleWriteFlush(): void {
  if (flushScheduled || flushInFlight) return;
  flushScheduled = true;
  setImmediate(() => {
    flushScheduled = false;
    void flushPendingWriteBatch();
  });
}

function enqueueWrite(entry: CachedEntry): Promise<void> {
  return new Promise((resolve) => {
    const existing = pendingWrites.get(entry.key);
    if (existing) {
      // Coalescing happens before SQLite's monotonic UPSERT guard. Keep the
      // deeper/richer pending result here as well, otherwise a later partial
      // result in the same turn could erase embeddings or completed features.
      existing.entry = preferCachedEntry(existing.entry, entry);
      existing.waiters.push(resolve);
    } else {
      pendingWrites.set(entry.key, { entry, waiters: [resolve] });
    }
    if (pendingWrites.size >= SQLITE_WRITE_BATCH) {
      void flushPendingWriteBatch();
    } else {
      scheduleWriteFlush();
    }
  });
}

async function discardPendingWrites(): Promise<void> {
  if (flushInFlight) await flushInFlight;
  const discarded = Array.from(pendingWrites.values());
  pendingWrites = new Map();
  settlePendingWrites(discarded);
}

export async function getCachedFaceResult(filePath: string): Promise<{
  result: FaceAnalysisResult;
  hexEmbeddings: string[];
} | null>;
export async function getCachedFaceResult(
  filePath: string,
  requiredFeatures: RequiredFeatures,
): Promise<{
  result: FaceAnalysisResult;
  hexEmbeddings: string[];
} | null>;
export async function getCachedFaceResult(
  filePath: string,
  requiredFeatures?: RequiredFeatures,
): Promise<{
  result: FaceAnalysisResult;
  hexEmbeddings: string[];
} | null> {
  if (clearInFlight) await clearInFlight;
  const generation = cacheGeneration;
  const identity = await cacheIdentityFor(filePath, requiredFeatures?.identity);
  if (!identity || generation !== cacheGeneration) return null;

  const memoryHit = inMemoryHits.get(identity.key);
  if (memoryHit) {
    if (!cacheEntryHasRequiredFeatures(memoryHit, requiredFeatures)) return null;
    inMemoryHits.delete(identity.key);
    inMemoryHits.set(identity.key, memoryHit);
    return rehydrate(memoryHit);
  }

  const store = await getSqliteStore();
  if (generation !== cacheGeneration) return null;
  if (store) {
    try {
      const entry = store.get(identity.key);
      if (entry) {
        if (!cacheEntryHasRequiredFeatures(entry, requiredFeatures)) return null;
        rememberInMemory(identity.key, entry);
        return rehydrate(entry);
      }
    } catch (error) {
      await recoverFromRuntimeCorruption(store, error);
    }
  }

  // Legacy migration is intentionally lazy. Revisited photos move into SQLite
  // without a million-file startup scan; untouched legacy records remain valid.
  const legacyEntry = await readLegacyEntry(identity.key);
  if (!legacyEntry || generation !== cacheGeneration) return null;
  if (!cacheEntryHasRequiredFeatures(legacyEntry, requiredFeatures)) return null;
  rememberInMemory(identity.key, legacyEntry);
  if (store) {
    await enqueueWrite(legacyEntry);
    await unlink(await legacyFileFor(identity.key)).catch(() => undefined);
  }
  return rehydrate(legacyEntry);
}

/**
 * Return the richest stored analysis even when it cannot satisfy the requested
 * final profile. The face engine uses this as an enrichment seed, so a
 * subjects→full transition never has to repeat face/person detection.
 */
export async function getBestCachedFaceResult(
  filePath: string,
  identity?: FaceCacheIdentityHint,
  minimumAnalysisDepth: FaceAnalysisProfile = 'detect',
): Promise<{
  result: FaceAnalysisResult;
  hexEmbeddings: string[];
} | null> {
  return getCachedFaceResult(filePath, { analysisDepth: minimumAnalysisDepth, identity });
}

export async function setCachedFaceResult(
  filePath: string,
  result: FaceAnalysisResult,
  hexEmbeddings: string[],
  analysisDepth: FaceAnalysisProfile = 'full',
  identityHint?: FaceCacheIdentityHint,
): Promise<void> {
  if (clearInFlight) await clearInFlight;
  const generation = cacheGeneration;
  const identity = await cacheIdentityFor(filePath, identityHint);
  if (!identity || generation !== cacheGeneration) return;

  const entry: CachedEntry = {
    v: SCHEMA_VERSION,
    pipelineFingerprint: FACE_PIPELINE_FINGERPRINT,
    key: identity.key,
    path: filePath,
    size: identity.size,
    mtimeMs: identity.mtimeMs,
    cachedAt: Date.now(),
    analysisDepth,
    boxes: result.boxes,
    faceLandmarks: result.faceLandmarks,
    personBoxes: result.personBoxes,
    embeddings: hexEmbeddings,
    embeddingBoxes: result.embeddingBoxes,
    poses: result.poses,
    features: result.features ?? {
      faceMatching: hexEmbeddings.length > 0 || result.boxes.length === 0,
      personDetection: true,
      poseAnalysis: false,
      embeddingLimit: hexEmbeddings.length,
    },
  };
  if (!isValidEntry(entry, identity.key)) return;
  const preferred = rememberInMemory(identity.key, entry);
  await enqueueWrite(preferred);
}

async function pruneLegacyJsonIfTooLarge(): Promise<void> {
  const directory = await getCacheDir();
  const cacheFiles: Array<{ full: string; key: string }> = [];
  try {
    const shards = await readdir(directory);
    for (const shard of shards) {
      if (!/^[0-9a-f]{2}$/i.test(shard)) continue;
      const shardDirectory = path.join(directory, shard);
      let entries: string[];
      try { entries = await readdir(shardDirectory); } catch { continue; }
      for (const name of entries) {
        if (!name.endsWith('.json')) continue;
        cacheFiles.push({
          full: path.join(shardDirectory, name),
          key: name.replace(/\.json$/, ''),
        });
      }
    }
  } catch {
    return;
  }
  if (cacheFiles.length <= LEGACY_MAX_ENTRIES) return;

  const files: Array<{ full: string; key: string; cachedAt: number }> = [];
  for (let start = 0; start < cacheFiles.length; start += 128) {
    const details = await Promise.all(cacheFiles.slice(start, start + 128).map(async (file) => {
      try {
        return { ...file, cachedAt: (await stat(file.full)).mtimeMs };
      } catch {
        return null;
      }
    }));
    for (const detail of details) if (detail) files.push(detail);
  }
  files.sort((left, right) => left.cachedAt - right.cachedAt);
  const removeCount = Math.min(
    files.length,
    Math.max(LEGACY_PRUNE_BATCH, cacheFiles.length - LEGACY_MAX_ENTRIES),
  );
  for (const file of files.slice(0, removeCount)) {
    await unlink(file.full).catch(() => undefined);
    inMemoryHits.delete(file.key);
  }
}

export async function maintainFaceCache(
  options: FaceCacheMaintenanceOptions = {},
): Promise<DatabaseStats> {
  if (clearInFlight) await clearInFlight;
  await flushPendingWriteBatch();
  const store = await getSqliteStore();
  if (!store) {
    await pruneLegacyJsonIfTooLarge();
    return { entryCount: 0, payloadBytes: 0 };
  }
  try {
    const removed = store.prune(options);
    for (const key of removed) inMemoryHits.delete(key);
    return store.stats();
  } catch (error) {
    await recoverFromRuntimeCorruption(store, error);
    return { entryCount: 0, payloadBytes: 0 };
  }
}

export async function getFaceCacheDiagnostics(): Promise<FaceCacheDiagnostics> {
  await flushPendingWriteBatch();
  const store = await getSqliteStore();
  if (!store) {
    return {
      storageKind: 'json',
      entryCount: 0,
      payloadBytes: 0,
      pendingWrites: pendingWrites.size,
      maxEntries: LEGACY_MAX_ENTRIES,
      maxPayloadBytes: 0,
    };
  }
  try {
    const limits = databaseEntryLimits();
    return {
      storageKind: 'sqlite',
      databasePath: store.databasePath,
      ...store.stats(),
      pendingWrites: pendingWrites.size,
      maxEntries: limits.maxEntries,
      maxPayloadBytes: limits.maxPayloadBytes,
    };
  } catch (error) {
    await recoverFromRuntimeCorruption(store, error);
    return {
      storageKind: 'json',
      entryCount: 0,
      payloadBytes: 0,
      pendingWrites: pendingWrites.size,
      maxEntries: LEGACY_MAX_ENTRIES,
      maxPayloadBytes: 0,
    };
  }
}

export async function clearFaceCache(): Promise<void> {
  if (clearInFlight) return clearInFlight;
  const work = (async () => {
    cacheGeneration++;
    inMemoryHits = new Map();
    await discardPendingWrites();
    const store = await getSqliteStore();
    if (store) {
      try {
        store.clear();
      } catch (error) {
        await recoverFromRuntimeCorruption(store, error);
      }
    }

    try {
      const directory = await getCacheDir();
      const protectedDatabaseFiles = new Set([DATABASE_NAME, `${DATABASE_NAME}-wal`, `${DATABASE_NAME}-shm`]);
      for (const name of await readdir(directory)) {
        if (protectedDatabaseFiles.has(name)) continue;
        // Everything else in this dedicated directory is reconstructible:
        // legacy JSON shards, abandoned write temps, and quarantined corrupt
        // databases can all retain face/pose/embedding payloads.
        await rm(path.join(directory, name), { recursive: true, force: true });
      }
    } catch {
      // The cache is reconstructible; clear remains best-effort.
    }
  })();
  clearInFlight = work;
  try {
    await work;
  } finally {
    if (clearInFlight === work) clearInFlight = null;
  }
}

/** Close the database during application/test shutdown after pending writes land. */
export async function closeFaceCache(): Promise<void> {
  if (clearInFlight) await clearInFlight;
  await flushPendingWriteBatch();
  const store = sqliteStorePromise ? await sqliteStorePromise : null;
  try { store?.close(); } catch { /* best effort */ }
  sqliteStorePromise = null;
  inMemoryHits = new Map();
}
