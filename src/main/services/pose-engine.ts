/**
 * pose-engine.ts
 *
 * Optional ONNX pose-estimation service for sports event modes.
 *
 * Model: MoveNet SinglePose Thunder — 17 COCO keypoints, 256×256 int32 input,
 * output [1, 1, 17, 3] as (y, x, score) normalised 0..1.
 *
 * MoveNet is single-pose, so we run it once per detected athlete crop (from the
 * SSD person boxes) and map the keypoints back into full-frame coordinates. The
 * whole stage is OPTIONAL: if movenet_thunder.onnx is not present the engine
 * reports unavailable and the caller simply skips pose analysis — sports scoring
 * then falls back to person-box proxies.
 *
 * This mirrors the lifecycle/preprocessing patterns in face-engine.ts. The
 * keypoint geometry that consumes these results (kick straightness, foot-to-
 * torso contact) lives in src/shared/review.ts and is unit-tested independently.
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { app } from 'electron';
import { log } from '../logger';
import type { PoseKeypoint, PoseKeypoints } from '../../shared/types';
import { POSE_MODEL_IDENTITY } from './face-model-manifest';

type OrtModule = {
  InferenceSession: { create: (modelPath: string, options: Record<string, unknown>) => Promise<any> };
  Tensor: new (type: string, data: Int32Array | Float32Array | Uint8Array, dims: number[]) => any;
};

let ort: OrtModule | null = null;

function getOrt(): OrtModule {
  if (!ort) {
    const { app: electronApp } = require('electron') as typeof import('electron');
    if (electronApp.isPackaged) {
      const ortPath = path.join(process.resourcesPath, 'onnxruntime-node', 'dist', 'index.js');
      if (!existsSync(ortPath)) throw new Error(`onnxruntime-node not found at ${ortPath}`);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      ort = require(ortPath) as OrtModule;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      ort = require('onnxruntime-node') as OrtModule;
    }
  }
  return ort;
}

const POSE_INPUT = 256;
const KEYPOINT_COUNT = 17;
const IS_BGRA_PLATFORM = process.platform === 'win32' || process.platform === 'darwin';

function poseModelCandidates(): string[] {
  return app.isPackaged
    ? [
        path.join(app.getPath('userData'), 'models', 'movenet_thunder.onnx'),
        path.join(process.resourcesPath, 'models', 'movenet_thunder.onnx'),
      ]
    : [
        path.join(__dirname, '..', '..', '..', 'models', 'movenet_thunder.onnx'),
        path.join(process.cwd(), 'models', 'movenet_thunder.onnx'),
      ];
}

function poseModelPath(): string | null {
  return poseModelCandidates().find((candidate) => existsSync(candidate)) ?? null;
}

export function poseModelAvailable(): boolean {
  return poseModelPath() !== null;
}

export async function verifyPoseModelFile(filePath: string): Promise<boolean> {
  if (!existsSync(filePath)) return false;
  const digest = await new Promise<string>((resolve) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', () => resolve(''));
  });
  return digest === POSE_MODEL_IDENTITY.sha256;
}

async function resolveVerifiedPoseModelPath(): Promise<string | null> {
  for (const candidate of poseModelCandidates()) {
    if (!existsSync(candidate)) continue;
    if (await verifyPoseModelFile(candidate)) return candidate;
    log.warn(`[pose-engine] ignoring untrusted MoveNet candidate: ${candidate}`);
  }
  return null;
}

let session: any | null = null;
let inputName = 'input';
let inputType: 'int32' | 'float32' | 'uint8' = 'int32';
let loadPromise: Promise<boolean> | null = null;
let poseLoadGeneration = 0;
let poseEnabled = false;
const POSE_INFERENCE_TIMEOUT_MS = 12_000;
const POSE_RELEASE_TIMEOUT_MS = 2_000;
let poseCircuitFailure: Error | null = null;
let poseCircuitGeneration = 0;
const poseActiveRejectors = new Set<(error: Error) => void>();

export function poseInferenceDiagnostics() {
  return {
    state: poseCircuitFailure ? 'open' as const : 'closed' as const,
    failure: poseCircuitFailure?.message,
    active: poseActiveRejectors.size,
  };
}

async function runPoseInference<T>(work: () => Promise<T>): Promise<T> {
  if (poseCircuitFailure) {
    throw new Error(`pose inference unavailable: ${poseCircuitFailure.message}`);
  }
  const generation = poseCircuitGeneration;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      poseActiveRejectors.delete(rejectFromCircuit);
      callback();
    };
    const rejectFromCircuit = (error: Error) => finish(() => reject(error));
    poseActiveRejectors.add(rejectFromCircuit);
    const trip = (error: Error) => {
      if (generation !== poseCircuitGeneration || poseCircuitFailure) return;
      poseCircuitFailure = error;
      poseCircuitGeneration++;
      const active = [...poseActiveRejectors];
      poseActiveRejectors.clear();
      for (const rejectActive of active) rejectActive(error);
    };
    const timer = setTimeout(() => trip(new Error(
      `pose inference timed out after ${POSE_INFERENCE_TIMEOUT_MS}ms; disabled until model session reset`,
    )), POSE_INFERENCE_TIMEOUT_MS);
    Promise.resolve().then(work).then(
      (value) => finish(() => resolve(value)),
      (error) => trip(new Error(
        `pose inference failed: ${error instanceof Error ? error.message : String(error)}; disabled until model session reset`,
      )),
    );
  });
}

export function configurePoseAnalysis(enabled: boolean): void {
  const changed = poseEnabled !== enabled;
  poseEnabled = enabled;
  if (changed && !enabled && (session || loadPromise)) {
    void disposePoseEngine().catch(() => undefined);
  }
}

export function isPoseAnalysisEnabled(): boolean {
  return poseEnabled && poseModelAvailable();
}

async function loadPoseSession(): Promise<boolean> {
  if (loadPromise) return loadPromise;
  const loadGeneration = poseLoadGeneration;
  const loading = (async () => {
    const modelFile = await resolveVerifiedPoseModelPath();
    if (!modelFile) {
      log.info('[pose-engine] no digest-verified movenet_thunder.onnx found — pose analysis disabled');
      return false;
    }
    let loadedSession: any | null = null;
    try {
      const runtime = getOrt();
      const providers = process.platform === 'win32' ? ['dml', 'cpu'] : ['cpu'];
      loadedSession = await runtime.InferenceSession.create(modelFile, {
        executionProviders: providers,
        graphOptimizationLevel: 'all',
        logSeverityLevel: 3,
      });
      const loadedInputName = loadedSession.inputNames?.[0] ?? 'input';
      // MoveNet Thunder typically wants int32; some exports use uint8/float32.
      const meta = loadedSession.inputMetadata?.[0] ?? loadedSession.inputNames?.[0];
      const typeStr = typeof meta === 'object' && meta?.type ? String(meta.type) : '';
      const loadedInputType = typeStr.includes('float') ? 'float32' as const
        : typeStr.includes('uint8') ? 'uint8' as const : 'int32' as const;
      if (loadGeneration !== poseLoadGeneration) {
        await releasePoseSessionBounded(loadedSession, 'superseded MoveNet load');
        return false;
      }
      session = loadedSession;
      inputName = loadedInputName;
      inputType = loadedInputType;
      log.info(`[pose-engine] MoveNet loaded (input=${inputName}, type=${inputType})`);
      return true;
    } catch (err) {
      log.warn('[pose-engine] failed to load MoveNet:', (err as Error).message);
      if (loadedSession && loadedSession !== session) {
        await releasePoseSessionBounded(loadedSession, 'failed MoveNet load');
      }
      if (loadGeneration === poseLoadGeneration) session = null;
      return false;
    } finally {
      if (loadGeneration === poseLoadGeneration && session === null) loadPromise = null;
    }
  })();
  loadPromise = loading;
  return loading;
}

async function releasePoseSessionBounded(target: any, label: string): Promise<void> {
  if (!target?.release) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.resolve().then(() => target.release()).catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        log.warn(`[pose-engine] ${label} release exceeded ${POSE_RELEASE_TIMEOUT_MS}ms`);
        resolve();
      }, POSE_RELEASE_TIMEOUT_MS);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

export async function disposePoseEngine(): Promise<void> {
  poseLoadGeneration++;
  const s = session;
  session = null;
  loadPromise = null;
  poseCircuitFailure = null;
  poseCircuitGeneration++;
  const resetError = new Error('pose inference reset');
  const active = [...poseActiveRejectors];
  poseActiveRejectors.clear();
  for (const reject of active) reject(resetError);
  await releasePoseSessionBounded(s, 'session');
}

export interface PoseModelSmokeStatus {
  ok: boolean;
  modelPath?: string;
  digestVerified: boolean;
  sessionLoaded: boolean;
  inferenceRan: boolean;
  inputName?: string;
  inputType?: 'int32' | 'float32' | 'uint8';
  outputName?: string;
  outputShape?: number[];
  outputValues?: number;
  inferenceMs?: number;
  error?: string;
}

/**
 * Exercise the exact packaged MoveNet loader and runtime with one bounded-size
 * synthetic input. Package smoke calls this before release so a present but
 * corrupt model, missing native provider, or incompatible graph cannot ship as
 * an apparently healthy pose feature.
 */
export async function runPoseModelSmoke(): Promise<PoseModelSmokeStatus> {
  const modelFile = await resolveVerifiedPoseModelPath();
  if (!modelFile) {
    return {
      ok: false,
      digestVerified: false,
      sessionLoaded: false,
      inferenceRan: false,
      error: 'MoveNet model was not found',
    };
  }

  const digestVerified = await verifyPoseModelFile(modelFile);
  if (!digestVerified) {
    return {
      ok: false,
      modelPath: modelFile,
      digestVerified: false,
      sessionLoaded: false,
      inferenceRan: false,
      error: 'MoveNet model digest did not match the pinned identity',
    };
  }

  try {
    const loaded = await loadPoseSession();
    if (!loaded || !session) {
      return {
        ok: false,
        modelPath: modelFile,
        digestVerified: true,
        sessionLoaded: false,
        inferenceRan: false,
        error: 'MoveNet session could not be loaded',
      };
    }

    const inputValues = POSE_INPUT * POSE_INPUT * 3;
    const input = inputType === 'float32'
      ? new Float32Array(inputValues)
      : inputType === 'uint8'
        ? new Uint8Array(inputValues)
        : new Int32Array(inputValues);
    const tensor = new (getOrt().Tensor)(inputType, input, [1, POSE_INPUT, POSE_INPUT, 3]);
    const startedAt = performance.now();
    const outputs = await runPoseInference<Record<string, any>>(
      () => session.run({ [inputName]: tensor }),
    );
    const inferenceMs = performance.now() - startedAt;
    const outputName = Object.keys(outputs)[0];
    const output = outputName ? outputs[outputName] : undefined;
    const outputShape: number[] = Array.isArray(output?.dims)
      ? output.dims.map((value: unknown) => Number(value))
      : [];
    const outputValues = Number(output?.data?.length ?? 0);
    const expectedShape = [1, 1, KEYPOINT_COUNT, 3];
    const shapeMatches = outputShape.length === expectedShape.length &&
      outputShape.every((value, index) => value === expectedShape[index]);
    const valuesAreFinite = outputValues === KEYPOINT_COUNT * 3 &&
      Array.from(output.data as ArrayLike<number>).every((value) => Number.isFinite(Number(value)));

    return {
      ok: shapeMatches && valuesAreFinite,
      modelPath: modelFile,
      digestVerified: true,
      sessionLoaded: true,
      inferenceRan: true,
      inputName,
      inputType,
      outputName,
      outputShape,
      outputValues,
      inferenceMs: Math.round(inferenceMs * 100) / 100,
      ...(!shapeMatches || !valuesAreFinite
        ? { error: 'MoveNet inference returned an unexpected output contract' }
        : {}),
    };
  } catch (error) {
    return {
      ok: false,
      modelPath: modelFile,
      digestVerified: true,
      sessionLoaded: session !== null,
      inferenceRan: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await disposePoseEngine();
  }
}

interface NormBox { x: number; y: number; width: number; height: number }

/** Crop a person box (normalised), letterbox to 256×256, build the input tensor. */
function buildCropTensor(img: Electron.NativeImage, box: NormBox): any {
  const { width: imgW, height: imgH } = img.getSize();
  // Expand the box slightly so limbs at full extension stay in frame.
  const padX = box.width * 0.15;
  const padY = box.height * 0.1;
  const left = Math.max(0, Math.round((box.x - padX) * imgW));
  const top = Math.max(0, Math.round((box.y - padY) * imgH));
  const right = Math.min(imgW, Math.round((box.x + box.width + padX) * imgW));
  const bottom = Math.min(imgH, Math.round((box.y + box.height + padY) * imgH));
  const cropW = Math.max(1, right - left);
  const cropH = Math.max(1, bottom - top);

  let crop = img.crop({ x: left, y: top, width: cropW, height: cropH });
  // Letterbox into a square so MoveNet's aspect ratio is preserved.
  const scale = POSE_INPUT / Math.max(cropW, cropH);
  const rw = Math.max(1, Math.round(cropW * scale));
  const rh = Math.max(1, Math.round(cropH * scale));
  crop = crop.resize({ width: rw, height: rh });
  const bitmap = (crop.toBitmap?.() ?? crop.getBitmap()) as unknown as Buffer;

  const offX = Math.floor((POSE_INPUT - rw) / 2);
  const offY = Math.floor((POSE_INPUT - rh) / 2);
  const n = POSE_INPUT * POSE_INPUT * 3;
  const data = inputType === 'float32' ? new Float32Array(n) : inputType === 'uint8' ? new Uint8Array(n) : new Int32Array(n);
  const rOff = IS_BGRA_PLATFORM ? 2 : 0;
  const bOff = IS_BGRA_PLATFORM ? 0 : 2;
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const src = (y * rw + x) * 4;
      const dst = ((y + offY) * POSE_INPUT + (x + offX)) * 3;
      const r = bitmap[src + rOff];
      const g = bitmap[src + 1];
      const b = bitmap[src + bOff];
      if (inputType === 'float32') {
        data[dst] = r / 255; data[dst + 1] = g / 255; data[dst + 2] = b / 255;
      } else {
        data[dst] = r; data[dst + 1] = g; data[dst + 2] = b;
      }
    }
  }
  return new (getOrt().Tensor)(inputType, data, [1, POSE_INPUT, POSE_INPUT, 3]);
}

/**
 * Estimate poses for the given athlete boxes in an already-decoded frame.
 * Returns one PoseKeypoints per box (keypoints in full-frame 0..1 coords).
 * Returns [] when pose analysis is disabled or the model is unavailable.
 */
export async function estimatePoses(img: Electron.NativeImage, personBoxes: NormBox[]): Promise<PoseKeypoints[]> {
  return (await estimatePosesDetailed(img, personBoxes)).poses;
}

export interface PoseEstimateBatch {
  poses: PoseKeypoints[];
  selectedCount: number;
  successfulSelectedCount: number;
}

export async function estimatePosesDetailed(
  img: Electron.NativeImage,
  personBoxes: NormBox[],
): Promise<PoseEstimateBatch> {
  if (!isPoseAnalysisEnabled() || personBoxes.length === 0) {
    return { poses: [], selectedCount: 0, successfulSelectedCount: 0 };
  }
  const ok = await loadPoseSession();
  if (!ok || !session) return { poses: [], selectedCount: 0, successfulSelectedCount: 0 };

  const { width: imgW, height: imgH } = img.getSize();
  // SinglePose inference scales linearly with the number of crowd boxes. Keep
  // this optional stage bounded to the two strongest likely primary athletes;
  // unselected and failed boxes receive aligned score-zero placeholders.
  const selected = new Set(personBoxes
    .map((box, index) => {
      const centerX = box.x + box.width / 2;
      const centerY = box.y + box.height / 2;
      const centrality = 1 - Math.min(1, Math.hypot(centerX - 0.5, centerY - 0.48) / 0.72);
      const confidence = typeof (box as NormBox & { score?: number }).score === 'number'
        ? (box as NormBox & { score: number }).score
        : 0.5;
      return {
        index,
        primaryScore: box.width * box.height * 3.2 + centrality * 0.35 + confidence * 0.25,
      };
    })
    .sort((a, b) => b.primaryScore - a.primaryScore)
    .slice(0, 2)
    .map((entry) => entry.index));
  const results: PoseKeypoints[] = [];
  let successfulSelectedCount = 0;

  for (let boxIndex = 0; boxIndex < personBoxes.length; boxIndex++) {
    const box = personBoxes[boxIndex];
    if (!selected.has(boxIndex)) {
      results.push({ keypoints: [], score: 0 });
      continue;
    }
    try {
      const padX = box.width * 0.15;
      const padY = box.height * 0.1;
      const left = Math.max(0, (box.x - padX));
      const top = Math.max(0, (box.y - padY));
      const right = Math.min(1, (box.x + box.width + padX));
      const bottom = Math.min(1, (box.y + box.height + padY));
      const cropWpx = Math.max(1, Math.round((right - left) * imgW));
      const cropHpx = Math.max(1, Math.round((bottom - top) * imgH));
      const squarePx = Math.max(cropWpx, cropHpx);
      const offXpx = Math.floor((squarePx - cropWpx) / 2);
      const offYpx = Math.floor((squarePx - cropHpx) / 2);

      const tensor = buildCropTensor(img, box);
      const out = await runPoseInference<Record<string, any>>(
        () => session.run({ [inputName]: tensor }),
      );
      const data = out[Object.keys(out)[0]].data as Float32Array;

      const keypoints: PoseKeypoint[] = [];
      for (let k = 0; k < KEYPOINT_COUNT; k++) {
        // MoveNet output order is (y, x, score), normalised 0..1 to the 256 square.
        const ky = data[k * 3];
        const kx = data[k * 3 + 1];
        const ks = data[k * 3 + 2];
        // Undo letterbox: square(0..1) → crop pixel → full-frame normalised.
        const sqX = kx * squarePx;
        const sqY = ky * squarePx;
        const cropPxX = sqX - offXpx;
        const cropPxY = sqY - offYpx;
        const fullX = left + (cropPxX / imgW);
        const fullY = top + (cropPxY / imgH);
        keypoints.push({ x: Math.max(0, Math.min(1, fullX)), y: Math.max(0, Math.min(1, fullY)), score: ks });
      }
      const avg = keypoints.reduce((s, p) => s + p.score, 0) / KEYPOINT_COUNT;
      results.push({ keypoints, score: avg });
      successfulSelectedCount++;
    } catch (err) {
      log.warn('[pose-engine] pose estimation failed for a box:', (err as Error).message);
      results.push({ keypoints: [], score: 0 });
      if (poseCircuitFailure) break;
    }
  }
  while (results.length < personBoxes.length) results.push({ keypoints: [], score: 0 });
  return { poses: results, selectedCount: selected.size, successfulSelectedCount };
}
