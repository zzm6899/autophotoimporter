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

export async function createPoseInferenceSession(
  inferenceSession: OrtModule['InferenceSession'],
  modelPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<any> {
  const usesDirectMl = platform === 'win32';
  const commonOptions = {
    graphOptimizationLevel: 'all',
    logSeverityLevel: 3,
  };
  if (!usesDirectMl) {
    return inferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
      ...commonOptions,
    });
  }
  try {
    return await inferenceSession.create(modelPath, {
      executionProviders: ['dml', 'cpu'],
      // DirectML requires sequential execution and cannot use ORT memory
      // patterns. Set both explicitly rather than relying on runtime defaults.
      executionMode: 'sequential',
      enableMemPattern: false,
      ...commonOptions,
    });
  } catch (directMlError) {
    log.warn('[pose-engine] DirectML MoveNet load failed; retrying on CPU:',
      (directMlError as Error).message);
    return inferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
      ...commonOptions,
    });
  }
}

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

type PoseInputType = 'int32' | 'float32' | 'uint8';

let sessionRuntime: PoseSessionRuntime | null = null;
let loadPromise: Promise<boolean> | null = null;
let poseLoadGeneration = 0;
let poseEnabled = false;
const POSE_INFERENCE_TIMEOUT_MS = 12_000;
const POSE_RELEASE_TIMEOUT_MS = 2_000;

export type PoseInferenceErrorCode =
  | 'POSE_INFERENCE_TIMEOUT'
  | 'POSE_INFERENCE_FAILED'
  | 'POSE_INFERENCE_CIRCUIT_OPEN'
  | 'POSE_INFERENCE_RESET';

export class PoseInferenceCircuitError extends Error {
  constructor(readonly code: PoseInferenceErrorCode, readonly detail: string) {
    super(`pose inference ${code === 'POSE_INFERENCE_CIRCUIT_OPEN' ? 'unavailable' : 'failed'}: ${detail}`);
    this.name = 'PoseInferenceCircuitError';
  }
}

interface PoseInferenceQueueEntry<T> {
  work: () => Promise<T>;
  timeoutMs: number;
  resolve: (value: T) => void;
  reject: (error: PoseInferenceCircuitError) => void;
}

interface PoseActiveInferenceRejector {
  generation: number;
  reject: (error: PoseInferenceCircuitError) => void;
}

/**
 * Serializes Run calls for one native MoveNet session and fails closed.
 *
 * ORT promises do not cancel their native work. Caller settlement and native
 * settlement are therefore deliberately separate: a timeout/reset rejects the
 * JavaScript caller immediately, while the owning PoseSessionRuntime continues
 * tracking the underlying Run until it really settles.
 */
export class PoseInferenceCircuit {
  private failure: PoseInferenceCircuitError | null = null;
  private readonly queue: Array<PoseInferenceQueueEntry<unknown>> = [];
  private readonly activeRejectors = new Set<PoseActiveInferenceRejector>();
  private active = 0;
  private generation = 0;

  constructor(private readonly maxConcurrent = 1) {}

  run<T>(work: () => Promise<T>, timeoutMs: number): Promise<T> {
    if (this.failure) return Promise.reject(this.openError());
    const boundedTimeout = Math.max(1, Math.floor(timeoutMs));
    return new Promise<T>((resolve, reject) => {
      const entry: PoseInferenceQueueEntry<T> = {
        work,
        timeoutMs: boundedTimeout,
        resolve,
        reject,
      };
      if (this.active < this.maxConcurrent) this.start(entry);
      else this.queue.push(entry as PoseInferenceQueueEntry<unknown>);
    });
  }

  reset(detail = 'native session lifecycle reset'): void {
    const resetError = new PoseInferenceCircuitError('POSE_INFERENCE_RESET', detail);
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
      state: this.failure ? 'open' as const : 'closed' as const,
      active: this.active,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      failureCode: this.failure?.code,
      failure: this.failure?.detail,
    };
  }

  private start<T>(entry: PoseInferenceQueueEntry<T>): void {
    if (this.failure) {
      entry.reject(this.openError());
      return;
    }
    const operationGeneration = this.generation;
    this.active++;
    let callerSettled = false;
    let timer: NodeJS.Timeout;

    const settleCaller = (callback: () => void) => {
      if (callerSettled) return;
      callerSettled = true;
      clearTimeout(timer);
      this.activeRejectors.delete(activeRejector);
      callback();
    };
    const rejectFromCircuit = (error: PoseInferenceCircuitError) => {
      settleCaller(() => entry.reject(error));
    };
    const activeRejector: PoseActiveInferenceRejector = {
      generation: operationGeneration,
      reject: rejectFromCircuit,
    };
    this.activeRejectors.add(activeRejector);
    timer = setTimeout(() => this.trip(new PoseInferenceCircuitError(
      'POSE_INFERENCE_TIMEOUT',
      `native call exceeded ${entry.timeoutMs}ms; circuit opened until session reset`,
    ), operationGeneration), entry.timeoutMs);

    // Do not invoke queued native work after a synchronous lifecycle reset.
    // Once work starts it is not cancellable; PoseSessionRuntime retains it.
    Promise.resolve()
      .then(() => operationGeneration === this.generation ? entry.work() : undefined)
      .then(
        (value) => {
          if (operationGeneration === this.generation && !this.failure) {
            settleCaller(() => entry.resolve(value as T));
          }
          this.finishNative(operationGeneration);
        },
        (error) => {
          if (operationGeneration === this.generation && !callerSettled) {
            const detail = error instanceof Error ? error.message : String(error);
            this.trip(new PoseInferenceCircuitError(
              'POSE_INFERENCE_FAILED',
              `${detail}; circuit opened until session reset`,
            ), operationGeneration);
          }
          this.finishNative(operationGeneration);
        },
      );
  }

  private finishNative(operationGeneration: number): void {
    if (operationGeneration !== this.generation) return;
    this.active = Math.max(0, this.active - 1);
    this.drain();
  }

  private drain(): void {
    if (this.failure) return;
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      this.start(this.queue.shift()!);
    }
  }

  private trip(error: PoseInferenceCircuitError, operationGeneration: number): void {
    if (operationGeneration !== this.generation || this.failure) return;
    this.failure = error;
    const queued = this.queue.splice(0);
    const active = [...this.activeRejectors]
      .filter((entry) => entry.generation === operationGeneration);
    this.generation++;
    this.active = 0;
    for (const entry of queued) entry.reject(error);
    for (const entry of active) entry.reject(error);
  }

  private openError(): PoseInferenceCircuitError {
    const cause = this.failure;
    return new PoseInferenceCircuitError(
      'POSE_INFERENCE_CIRCUIT_OPEN',
      cause
        ? `previous ${cause.code.toLowerCase()}: ${cause.detail}`
        : 'native session circuit is open',
    );
  }
}

const poseInferenceCircuit = new PoseInferenceCircuit(1);

/** A generation-owned native session that never releases across an active Run. */
export class PoseSessionRuntime {
  private activeNativeRuns = 0;
  private retired = false;
  private releaseStarted = false;
  private releaseLabel = 'session';
  private readonly retirementPromise: Promise<void>;
  private resolveRetirement!: () => void;

  constructor(
    private readonly nativeSession: any,
    readonly generation: number,
    readonly inputName: string,
    readonly inputType: PoseInputType,
  ) {
    this.retirementPromise = new Promise<void>((resolve) => {
      this.resolveRetirement = resolve;
    });
  }

  run<T>(
    feeds: Record<string, unknown>,
    circuit: PoseInferenceCircuit = poseInferenceCircuit,
    timeoutMs = POSE_INFERENCE_TIMEOUT_MS,
  ): Promise<T> {
    if (this.retired) {
      return Promise.reject(new PoseInferenceCircuitError(
        'POSE_INFERENCE_RESET', 'MoveNet session was retired',
      ));
    }
    return circuit.run(() => this.runNative<T>(feeds), timeoutMs);
  }

  retire(label: string): Promise<void> {
    if (!this.retired) {
      this.retired = true;
      this.releaseLabel = label;
      this.releaseWhenIdle();
    }
    return this.retirementPromise;
  }

  async retireBounded(label: string, timeoutMs = POSE_RELEASE_TIMEOUT_MS): Promise<boolean> {
    const retirement = this.retire(label);
    let timer: NodeJS.Timeout | undefined;
    let completed = false;
    await Promise.race([
      retirement.then(() => { completed = true; }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(1, Math.floor(timeoutMs)));
      }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    if (!completed) {
      log.warn(`[pose-engine] ${label} still has ${this.activeNativeRuns} native Run call(s); release deferred until they settle`);
    }
    return completed;
  }

  diagnostics() {
    return {
      generation: this.generation,
      activeNativeRuns: this.activeNativeRuns,
      retired: this.retired,
      releaseStarted: this.releaseStarted,
    };
  }

  private async runNative<T>(feeds: Record<string, unknown>): Promise<T> {
    if (this.retired) {
      throw new PoseInferenceCircuitError('POSE_INFERENCE_RESET', 'MoveNet session was retired before Run started');
    }
    this.activeNativeRuns++;
    try {
      return await Promise.resolve().then(() => this.nativeSession.run(feeds) as Promise<T>);
    } finally {
      this.activeNativeRuns = Math.max(0, this.activeNativeRuns - 1);
      this.releaseWhenIdle();
    }
  }

  private releaseWhenIdle(): void {
    if (!this.retired || this.activeNativeRuns !== 0 || this.releaseStarted) return;
    this.releaseStarted = true;
    void releasePoseSessionBounded(this.nativeSession, this.releaseLabel)
      .finally(() => this.resolveRetirement());
  }
}

export function poseInferenceDiagnostics() {
  const circuit = poseInferenceCircuit.diagnostics();
  const runtime = sessionRuntime?.diagnostics();
  return {
    state: circuit.state,
    failure: circuit.failure,
    failureCode: circuit.failureCode,
    active: circuit.active,
    queued: circuit.queued,
    maxConcurrent: circuit.maxConcurrent,
    nativeActive: runtime?.activeNativeRuns ?? 0,
    generation: runtime?.generation,
  };
}

export function configurePoseAnalysis(enabled: boolean): void {
  const changed = poseEnabled !== enabled;
  poseEnabled = enabled;
  if (changed && !enabled && (sessionRuntime || loadPromise)) {
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
      loadedSession = await createPoseInferenceSession(runtime.InferenceSession, modelFile);
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
      sessionRuntime = new PoseSessionRuntime(
        loadedSession, loadGeneration, loadedInputName, loadedInputType,
      );
      // Ownership transferred to PoseSessionRuntime. Its retirement path is the
      // only code allowed to release this native session from this point on.
      loadedSession = null;
      log.info(`[pose-engine] MoveNet loaded (input=${loadedInputName}, type=${loadedInputType})`);
      return true;
    } catch (err) {
      log.warn('[pose-engine] failed to load MoveNet:', (err as Error).message);
      if (loadedSession) {
        await releasePoseSessionBounded(loadedSession, 'failed MoveNet load');
      }
      if (loadGeneration === poseLoadGeneration) sessionRuntime = null;
      return false;
    } finally {
      if (loadGeneration === poseLoadGeneration && sessionRuntime === null) loadPromise = null;
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
  // Capture and detach this generation before any await. A replacement session
  // may load immediately; delayed retirement of this owner cannot touch it.
  const runtime = sessionRuntime;
  sessionRuntime = null;
  loadPromise = null;
  poseInferenceCircuit.reset('MoveNet session disposed or reconfigured');
  // Caller shutdown remains bounded. If ORT Run is still native-active, its
  // owner releases asynchronously only after the real promise settles.
  await runtime?.retireBounded('session');
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
    const runtime = sessionRuntime;
    if (!loaded || !runtime) {
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
    const input = runtime.inputType === 'float32'
      ? new Float32Array(inputValues)
      : runtime.inputType === 'uint8'
        ? new Uint8Array(inputValues)
        : new Int32Array(inputValues);
    const tensor = new (getOrt().Tensor)(runtime.inputType, input, [1, POSE_INPUT, POSE_INPUT, 3]);
    const startedAt = performance.now();
    const outputs = await runtime.run<Record<string, any>>({ [runtime.inputName]: tensor });
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
      inputName: runtime.inputName,
      inputType: runtime.inputType,
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
      sessionLoaded: sessionRuntime !== null,
      inferenceRan: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await disposePoseEngine();
  }
}

interface NormBox { x: number; y: number; width: number; height: number }

/** Crop a person box (normalised), letterbox to 256×256, build the input tensor. */
function buildCropTensor(img: Electron.NativeImage, box: NormBox, runtimeInputType: PoseInputType): any {
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
  const data = runtimeInputType === 'float32'
    ? new Float32Array(n)
    : runtimeInputType === 'uint8'
      ? new Uint8Array(n)
      : new Int32Array(n);
  const rOff = IS_BGRA_PLATFORM ? 2 : 0;
  const bOff = IS_BGRA_PLATFORM ? 0 : 2;
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const src = (y * rw + x) * 4;
      const dst = ((y + offY) * POSE_INPUT + (x + offX)) * 3;
      const r = bitmap[src + rOff];
      const g = bitmap[src + 1];
      const b = bitmap[src + bOff];
      if (runtimeInputType === 'float32') {
        data[dst] = r / 255; data[dst + 1] = g / 255; data[dst + 2] = b / 255;
      } else {
        data[dst] = r; data[dst + 1] = g; data[dst + 2] = b;
      }
    }
  }
  return new (getOrt().Tensor)(runtimeInputType, data, [1, POSE_INPUT, POSE_INPUT, 3]);
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
  const runtime = sessionRuntime;
  if (!ok || !runtime) return { poses: [], selectedCount: 0, successfulSelectedCount: 0 };

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

      const tensor = buildCropTensor(img, box, runtime.inputType);
      const out = await runtime.run<Record<string, any>>({ [runtime.inputName]: tensor });
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
      if (err instanceof PoseInferenceCircuitError) break;
    }
  }
  while (results.length < personBoxes.length) results.push({ keypoints: [], score: 0 });
  return { poses: results, selectedCount: selected.size, successfulSelectedCount };
}
