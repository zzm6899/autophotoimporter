import path from 'node:path';
import { availableParallelism } from 'node:os';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { app, utilityProcess } from 'electron';

export type ImagePreprocessStage =
  | 'queued'
  | 'open'
  | 'metadata'
  | 'decode-resize'
  | 'tensor-pack'
  | 'complete';

export interface ImagePreprocessRequest {
  /** Original user file identity used for errors/quarantine. */
  imagePath: string;
  /** Optional generated preview file that the worker should decode. */
  sourcePath?: string;
  /** Optional encoded preview bytes (not raw pixels), used for cache-off RAW previews. */
  inputBuffer?: Uint8Array;
  /** Extract the largest bounded embedded JPEG in the supervised process. */
  extractEmbeddedJpeg?: boolean;
  /** Honor the encoded preview's own EXIF tag when it has one. */
  useSourceOrientation?: boolean;
  orientation: number;
  /** Defaults to true; seeded enrichment can omit the 3.7 MiB detector tensor. */
  includeDetectorTensor?: boolean;
  includeAnalysisSurface: boolean;
  includePersonTensors: boolean;
  includeNanoDetTensor?: boolean;
  includeYuNetTensor?: boolean;
  analysisMaxDimension?: number;
  /** Test-only protocol command understood by worker fixtures. */
  testMode?: 'hang' | 'echo';
}

export interface PreparedPersonTensor {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface PreparedImagePayload {
  /** Empty when includeDetectorTensor=false. */
  detectorCHW: Float32Array;
  surfaceBitmap?: Uint8Array;
  surfaceWidth?: number;
  surfaceHeight?: number;
  fastPerson?: PreparedPersonTensor;
  refinedPerson?: PreparedPersonTensor;
  nanoDet?: {
    data: Float32Array;
    sourceWidth: number;
    sourceHeight: number;
    targetWidth: 416;
    targetHeight: 416;
    resizedWidth: number;
    resizedHeight: number;
    padLeft: number;
    padTop: number;
  };
  yuNet?: {
    data: Float32Array;
    sourceWidth: number;
    sourceHeight: number;
    targetWidth: 640;
    targetHeight: 640;
    resizedWidth: number;
    resizedHeight: number;
    padLeft: number;
    padTop: number;
  };
  sourceWidth: number;
  sourceHeight: number;
}

interface WorkerRequestMessage extends ImagePreprocessRequest {
  type: 'prepare';
  id: number;
  bitmapOrder: 'bgra' | 'rgba';
}

type WorkerResponseMessage =
  | { type: 'ready' }
  | { type: 'stage'; id: number; imagePath: string; stage: ImagePreprocessStage }
  | { type: 'result'; id: number; imagePath: string; payload: PreparedImagePayload }
  | { type: 'error'; id: number; imagePath: string; stage: ImagePreprocessStage; message: string };

export interface PreprocessChild {
  postMessage(message: WorkerRequestMessage): void;
  on(event: 'message', listener: (message: WorkerResponseMessage) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  kill(): boolean;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
}

export type PreprocessChildFactory = () => PreprocessChild;

export class ImagePreprocessError extends Error {
  readonly code: 'PREPROCESS_TIMEOUT' | 'PREPROCESS_FAILED' | 'PREPROCESS_WORKER_EXIT' | 'PREVIEW_PENDING';
  readonly imagePath: string;
  readonly stage: ImagePreprocessStage;

  constructor(
    code: ImagePreprocessError['code'],
    imagePath: string,
    stage: ImagePreprocessStage,
    detail: string,
  ) {
    super(`image preprocessing ${stage} failed for "${imagePath}": ${detail}`);
    this.name = 'ImagePreprocessError';
    this.code = code;
    this.imagePath = imagePath;
    this.stage = stage;
  }
}

interface PendingRequest {
  request: ImagePreprocessRequest;
  resolve: (payload: PreparedImagePayload) => void;
  reject: (error: Error) => void;
}

interface WorkerSlot {
  child: PreprocessChild;
  ready: boolean;
  startupTimer: NodeJS.Timeout | null;
  current?: PendingRequest & { id: number; stage: ImagePreprocessStage; timer: NodeJS.Timeout };
}

/**
 * A small persistent process pool around Sharp/libvips preprocessing.
 *
 * Native decoders cannot be cancelled safely from a Promise.race. Each slot is
 * therefore a real utility process: a deadline destroys the whole process,
 * rejects only that file, and schedules a bounded clean replacement. The
 * Electron event loop and every other pool slot remain available throughout.
 */
export class ImagePreprocessSupervisor {
  private readonly slots: WorkerSlot[] = [];
  private readonly queue: PendingRequest[] = [];
  private readonly quarantined = new Map<string, ImagePreprocessError>();
  private nextId = 1;
  private disposed = false;
  private consecutiveStartupFailures = 0;
  private replenishTimer: NodeJS.Timeout | null = null;
  private lastStartupFailure = 'worker factory did not start';

  constructor(
    private readonly spawnChild: PreprocessChildFactory,
    private readonly poolSize = 2,
    private readonly timeoutMs = 15_000,
    private readonly startupTimeoutMs = 10_000,
  ) {
    // Slot creation includes filesystem integrity checks and utilityProcess.fork,
    // both of which can throw synchronously. Capacity management treats that as
    // a failed startup probe instead of letting construction tear down the app.
    this.ensurePoolCapacity(false);
  }

  prepare(request: ImagePreprocessRequest): Promise<PreparedImagePayload> {
    const quarantined = this.quarantined.get(request.imagePath);
    if (quarantined) return Promise.reject(quarantined);
    if (this.disposed) {
      return Promise.reject(new ImagePreprocessError(
        'PREPROCESS_WORKER_EXIT', request.imagePath, 'queued', 'worker pool has been disposed',
      ));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ request, resolve, reject });
      this.ensurePoolCapacity(true);
      this.dispatch();
    });
  }

  clearQuarantine(imagePath?: string): void {
    if (imagePath) this.quarantined.delete(imagePath);
    else this.quarantined.clear();
  }

  dispose(): void {
    this.disposed = true;
    if (this.replenishTimer) clearTimeout(this.replenishTimer);
    this.replenishTimer = null;
    const error = new Error('image preprocess supervisor disposed');
    for (const pending of this.queue.splice(0)) pending.reject(error);
    for (const slot of this.slots.splice(0)) {
      if (slot.startupTimer) clearTimeout(slot.startupTimer);
      if (slot.current) {
        clearTimeout(slot.current.timer);
        slot.current.reject(error);
      }
      try { slot.child.kill(); } catch { /* already gone */ }
    }
  }

  private addSlot(): boolean {
    if (this.disposed) return false;

    let child: PreprocessChild;
    try {
      child = this.spawnChild();
    } catch (error) {
      this.recordStartupFailure(`worker spawn failed: ${errorDetail(error)}`);
      return false;
    }

    const slot: WorkerSlot = { child, ready: false, startupTimer: null };
    this.slots.push(slot);
    try {
      child.on('message', (message) => {
        try {
          this.onMessage(slot, message);
        } catch (error) {
          this.replaceSlotSafely(slot, `message handler failed: ${errorDetail(error)}`);
        }
      });
      const logWorkerOutput = (lane: 'stdout' | 'stderr', chunk: unknown) => {
        const detail = String(chunk).replace(/[\r\n]+/g, ' ').slice(0, 2000);
        if (detail) console.error(`[image-preprocess:${lane}] ${detail}`);
      };
      child.stdout?.on('data', (chunk) => logWorkerOutput('stdout', chunk));
      child.stderr?.on('data', (chunk) => logWorkerOutput('stderr', chunk));
      child.on('error', (error) => {
        this.replaceSlotSafely(slot, `worker error: ${error.message}`);
      });
      child.on('exit', (code) => {
        this.replaceSlotSafely(slot, `worker exited with code ${code}`);
      });
      slot.startupTimer = setTimeout(() => {
        try {
          if (slot.ready || this.slots.indexOf(slot) < 0) return;
          // Never sacrifice an arbitrary queued file for a slot that was not
          // assigned work. Healthy lanes can continue while this lane backs off.
          this.replaceSlot(slot, 'worker startup timeout', false);
        } catch (error) {
          this.replaceSlotSafely(slot, `startup timeout handler failed: ${errorDetail(error)}`);
        }
      }, this.startupTimeoutMs);
      return true;
    } catch (error) {
      const index = this.slots.indexOf(slot);
      if (index >= 0) this.slots.splice(index, 1);
      if (slot.startupTimer) clearTimeout(slot.startupTimer);
      try { child.kill(); } catch { /* partially constructed child */ }
      this.recordStartupFailure(`worker setup failed: ${errorDetail(error)}`);
      return false;
    }
  }

  private onMessage(slot: WorkerSlot, rawMessage: unknown): void {
    if (!isWorkerResponseEnvelope(rawMessage)) {
      this.failProtocol(slot, 'malformed message envelope');
      return;
    }
    const message = rawMessage;
    if (message.type === 'ready') {
      if (slot.startupTimer) clearTimeout(slot.startupTimer);
      slot.startupTimer = null;
      this.consecutiveStartupFailures = 0;
      slot.ready = true;
      // One successful probe proves the runtime can start. Restore any slots
      // lost while the pool was idle instead of permanently running shrunken.
      this.ensurePoolCapacity(false);
      this.dispatch();
      return;
    }
    const current = slot.current;
    if (!current || message.id !== current.id || message.imagePath !== current.request.imagePath) {
      this.failProtocol(slot, 'response id/path did not match the active request');
      return;
    }
    if (message.type === 'stage') {
      if (!isImagePreprocessStage(message.stage)) {
        this.failProtocol(slot, `unknown stage ${String(message.stage)}`);
        return;
      }
      current.stage = message.stage;
      return;
    }
    clearTimeout(current.timer);
    slot.current = undefined;
    if (message.type === 'result') {
      try {
        current.resolve(normalizePreparedPayload(message.payload, current.request));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        current.reject(new ImagePreprocessError(
          'PREPROCESS_FAILED', current.request.imagePath, current.stage,
          `worker protocol violation: ${detail}`,
        ));
        // A malformed native-worker response is a process integrity failure,
        // not an image-level zero result. Replace only that slot and allow the
        // remaining healthy workers to continue draining the queue.
        this.replaceSlot(slot, `worker protocol violation: ${detail}`, false);
        return;
      }
    } else {
      current.reject(new ImagePreprocessError(
        'PREPROCESS_FAILED', current.request.imagePath, message.stage, message.message,
      ));
    }
    this.dispatch();
  }

  private failProtocol(slot: WorkerSlot, detail: string): void {
    const current = slot.current;
    if (current) {
      clearTimeout(current.timer);
      slot.current = undefined;
      current.reject(new ImagePreprocessError(
        'PREPROCESS_FAILED', current.request.imagePath, current.stage,
        `worker protocol violation: ${detail}`,
      ));
    }
    this.replaceSlot(slot, `worker protocol violation: ${detail}`, false);
  }

  private dispatch(): void {
    if (this.disposed) return;
    for (const slot of this.slots) {
      if (!slot.ready || slot.current || this.queue.length === 0) continue;
      const pending = this.queue.shift()!;
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (slot.current?.id !== id) return;
        const error = new ImagePreprocessError(
          'PREPROCESS_TIMEOUT', pending.request.imagePath, slot.current.stage,
          `hard timeout after ${this.timeoutMs}ms; worker was terminated`,
        );
        this.quarantined.set(pending.request.imagePath, error);
        pending.reject(error);
        // Reject/clear before kill because an exit event may fire synchronously
        // in test adapters. replaceSlot is idempotent for detached slots.
        clearTimeout(slot.current.timer);
        slot.current = undefined;
        this.replaceSlot(slot, error.message, false);
      }, this.timeoutMs);
      slot.current = { ...pending, id, stage: 'queued', timer };
      try {
        slot.child.postMessage({
          ...pending.request,
          type: 'prepare',
          id,
          bitmapOrder: process.platform === 'win32' || process.platform === 'darwin' ? 'bgra' : 'rgba',
        });
      } catch (error) {
        clearTimeout(timer);
        slot.current = undefined;
        pending.reject(new ImagePreprocessError(
          'PREPROCESS_WORKER_EXIT', pending.request.imagePath, 'queued',
          error instanceof Error ? error.message : String(error),
        ));
        this.replaceSlot(slot, 'postMessage failed', false);
      }
    }
  }

  private replaceSlot(slot: WorkerSlot, detail: string, rejectCurrent = true): void {
    const index = this.slots.indexOf(slot);
    if (index < 0) return;
    this.slots.splice(index, 1);
    console.error(`[image-preprocess] replacing utility process: ${detail}`);
    if (slot.startupTimer) clearTimeout(slot.startupTimer);
    slot.startupTimer = null;
    const current = slot.current;
    const wasReady = slot.ready;
    slot.current = undefined;
    if (current) {
      clearTimeout(current.timer);
      if (rejectCurrent) current.reject(new ImagePreprocessError(
        'PREPROCESS_WORKER_EXIT', current.request.imagePath, current.stage, detail,
      ));
    }
    try { slot.child.kill(); } catch { /* already gone */ }
    if (!wasReady) this.recordStartupFailure(detail);
    else if (!this.disposed) {
      if (this.startupCircuitOpen() && !this.slots.some((candidate) => candidate.ready)) {
        this.rejectQueuedForStartupCircuit();
      } else {
        this.scheduleReplenish();
      }
    }
    this.dispatch();
  }

  private replaceSlotSafely(slot: WorkerSlot, detail: string, rejectCurrent = true): void {
    try {
      this.replaceSlot(slot, detail, rejectCurrent);
    } catch (error) {
      // EventEmitter and timer callbacks must never surface an uncaught
      // exception into Electron's main process. The slot is already suspect;
      // make a best-effort detach and let a later bounded probe replenish it.
      console.error(`[image-preprocess] failed to replace utility process: ${errorDetail(error)}`);
      const index = this.slots.indexOf(slot);
      if (index >= 0) this.slots.splice(index, 1);
      if (slot.startupTimer) clearTimeout(slot.startupTimer);
      if (slot.current) {
        clearTimeout(slot.current.timer);
        slot.current.reject(new ImagePreprocessError(
          'PREPROCESS_WORKER_EXIT', slot.current.request.imagePath, slot.current.stage, detail,
        ));
        slot.current = undefined;
      }
      try { slot.child.kill(); } catch { /* already gone */ }
      this.recordStartupFailure(detail);
    }
  }

  private startupFailureLimit(): number {
    return Math.max(3, this.desiredPoolSize() * 2);
  }

  private startupCircuitOpen(): boolean {
    return this.consecutiveStartupFailures >= this.startupFailureLimit();
  }

  private recordStartupFailure(detail: string): void {
    if (this.disposed) return;
    this.consecutiveStartupFailures++;
    this.lastStartupFailure = detail;
    console.error(
      `[image-preprocess] startup failure ${this.consecutiveStartupFailures}/` +
      `${this.startupFailureLimit()}: ${detail}`,
    );

    const healthySlots = this.slots.filter((candidate) => candidate.ready).length;
    if (this.startupCircuitOpen()) {
      // A broken loader or repeatedly throwing process factory must not create
      // an unbounded timer/fork loop. Preserve healthy lanes; when none remain,
      // fail queued work deterministically. A later prepare() gets one probe.
      if (healthySlots === 0) this.rejectQueuedForStartupCircuit();
      return;
    }
    // Retry even an idle initial/replacement failure, but only through the
    // delayed exponential path. startupCircuitOpen() provides the hard bound.
    this.scheduleReplenish();
  }

  private rejectQueuedForStartupCircuit(): void {
    for (const pending of this.queue.splice(0)) pending.reject(new ImagePreprocessError(
      'PREPROCESS_WORKER_EXIT',
      pending.request.imagePath,
      'queued',
      `workers failed to start ${this.consecutiveStartupFailures} consecutive times: ` +
      this.lastStartupFailure,
    ));
  }

  private desiredPoolSize(): number {
    return Math.max(1, Math.floor(this.poolSize));
  }

  private ensurePoolCapacity(allowSingleStartupProbe: boolean): void {
    if (this.disposed) return;
    const desired = this.desiredPoolSize();
    // After a full set of startup failures, do not create an idle respawn
    // storm. A later real request is allowed one probe; its ready message then
    // restores the remainder of the configured pool.
    const startupCircuitOpen = this.startupCircuitOpen();
    const target = startupCircuitOpen && allowSingleStartupProbe && this.slots.length === 0
      ? 1
      : startupCircuitOpen ? this.slots.length : desired;
    while (this.slots.length < target) {
      // A synchronous digest/read/fork failure must end this capacity pass.
      // recordStartupFailure schedules the next bounded, backed-off probe.
      if (!this.addSlot()) break;
    }
  }

  private scheduleReplenish(): void {
    if (this.replenishTimer || this.disposed || this.startupCircuitOpen()) return;
    // Back off synchronous factory failures and startup timeouts. Runtime exits
    // from a previously healthy child use the minimum delay.
    const delayMs = Math.min(2_000, 125 * (2 ** Math.min(4, this.consecutiveStartupFailures)));
    this.replenishTimer = setTimeout(() => {
      this.replenishTimer = null;
      try {
        this.ensurePoolCapacity(this.queue.length > 0);
        this.dispatch();
      } catch (error) {
        // Defensive boundary for callbacks owned by Node. addSlot handles the
        // expected digest/read/fork throws, but no future implementation error
        // should become an uncaught timer exception.
        this.recordStartupFailure(`replenishment failed: ${errorDetail(error)}`);
      }
    }, delayMs);
  }
}

export interface ImagePreprocessSupervisorDiagnostics {
  poolSize: number;
  workers: number;
  readyWorkers: number;
  active: number;
  queued: number;
  quarantined: number;
  startupFailures: number;
  disposed: boolean;
}

export function getImagePreprocessSupervisorDiagnostics(
  supervisor = productionSupervisor,
): ImagePreprocessSupervisorDiagnostics {
  if (!supervisor) {
    return {
      poolSize: 0,
      workers: 0,
      readyWorkers: 0,
      active: 0,
      queued: 0,
      quarantined: 0,
      startupFailures: 0,
      disposed: false,
    };
  }
  // Keep the mutable pool private to production callers while exposing a
  // bounded aggregate for diagnostics and performance regression tests.
  const state = supervisor as unknown as {
    poolSize: number;
    slots: WorkerSlot[];
    queue: PendingRequest[];
    quarantined: Map<string, ImagePreprocessError>;
    consecutiveStartupFailures: number;
    disposed: boolean;
  };
  return {
    poolSize: state.poolSize,
    workers: state.slots.length,
    readyWorkers: state.slots.filter((slot) => slot.ready).length,
    active: state.slots.filter((slot) => !!slot.current).length,
    queued: state.queue.length,
    quarantined: state.quarantined.size,
    startupFailures: state.consecutiveStartupFailures,
    disposed: state.disposed,
  };
}

function errorDetail(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ').slice(0, 2000);
}

const IMAGE_PREPROCESS_STAGES = new Set<ImagePreprocessStage>([
  'queued', 'open', 'metadata', 'decode-resize', 'tensor-pack', 'complete',
]);

function isImagePreprocessStage(value: unknown): value is ImagePreprocessStage {
  return typeof value === 'string' && IMAGE_PREPROCESS_STAGES.has(value as ImagePreprocessStage);
}

function isWorkerResponseEnvelope(value: unknown): value is WorkerResponseMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  if (message.type === 'ready') return true;
  if (message.type !== 'stage' && message.type !== 'result' && message.type !== 'error') return false;
  if (!Number.isSafeInteger(message.id) || typeof message.imagePath !== 'string') return false;
  if (message.type === 'stage') return isImagePreprocessStage(message.stage);
  if (message.type === 'error') {
    return isImagePreprocessStage(message.stage) && typeof message.message === 'string';
  }
  return 'payload' in message;
}

function normalizePreparedPayload(
  payload: PreparedImagePayload,
  request: ImagePreprocessRequest,
): PreparedImagePayload {
  if (!payload || typeof payload !== 'object') throw new Error('missing payload object');
  const dimension = (value: unknown, label: string, max = 200_000): number => {
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
      throw new Error(`${label} is outside the supported range`);
    }
    return value as number;
  };
  const sourceWidth = dimension(payload.sourceWidth, 'sourceWidth');
  const sourceHeight = dimension(payload.sourceHeight, 'sourceHeight');

  // Electron structured clone may materialise typed arrays as Uint8Array
  // views. Re-wrap them without copying so ORT receives the exact tensor type.
  const detector = payload.detectorCHW ?? new Float32Array(0);
  const detectorCHW = detector instanceof Float32Array
    ? detector
    : new Float32Array(
      (detector as unknown as Uint8Array).buffer,
      (detector as unknown as Uint8Array).byteOffset,
      (detector as unknown as Uint8Array).byteLength / Float32Array.BYTES_PER_ELEMENT,
    );
  if (detectorCHW.length !== 0 && detectorCHW.length !== 3 * 640 * 480) {
    throw new Error(`detector tensor has invalid length ${detectorCHW.length}`);
  }
  if (request.includeDetectorTensor !== false && detectorCHW.length !== 3 * 640 * 480) {
    throw new Error('worker omitted the requested detector tensor');
  }

  const surfaceBitmap = payload.surfaceBitmap
    ? payload.surfaceBitmap instanceof Uint8Array
      ? payload.surfaceBitmap
      : new Uint8Array(payload.surfaceBitmap)
    : undefined;
  let surfaceWidth: number | undefined;
  let surfaceHeight: number | undefined;
  if (surfaceBitmap || payload.surfaceWidth !== undefined || payload.surfaceHeight !== undefined) {
    surfaceWidth = dimension(payload.surfaceWidth, 'surfaceWidth', 4096);
    surfaceHeight = dimension(payload.surfaceHeight, 'surfaceHeight', 4096);
    if (!surfaceBitmap || surfaceBitmap.length !== surfaceWidth * surfaceHeight * 4) {
      throw new Error('analysis surface byte length does not match its dimensions');
    }
  }
  if (request.includeAnalysisSurface && !surfaceBitmap) {
    throw new Error('worker omitted the requested analysis surface');
  }

  const normalizePersonTensor = (
    tensor: PreparedPersonTensor | undefined,
    label: string,
  ): PreparedPersonTensor | undefined => {
    if (!tensor) return undefined;
    const width = dimension(tensor.width, `${label}.width`, 2048);
    const height = dimension(tensor.height, `${label}.height`, 2048);
    const data = tensor.data instanceof Uint8Array ? tensor.data : new Uint8Array(tensor.data);
    if (data.length !== width * height * 3) {
      throw new Error(`${label} byte length does not match its dimensions`);
    }
    return { data, width, height };
  };

  let nanoDet: PreparedImagePayload['nanoDet'];
  if (payload.nanoDet) {
    const raw = payload.nanoDet.data;
    const data = raw instanceof Float32Array
      ? raw
      : new Float32Array(
        (raw as unknown as Uint8Array).buffer,
        (raw as unknown as Uint8Array).byteOffset,
        (raw as unknown as Uint8Array).byteLength / Float32Array.BYTES_PER_ELEMENT,
      );
    if (data.length !== 3 * 416 * 416) throw new Error('NanoDet tensor has invalid length');
    const nanoSourceWidth = dimension(payload.nanoDet.sourceWidth, 'nanoDet.sourceWidth');
    const nanoSourceHeight = dimension(payload.nanoDet.sourceHeight, 'nanoDet.sourceHeight');
    const resizedWidth = dimension(payload.nanoDet.resizedWidth, 'nanoDet.resizedWidth', 416);
    const resizedHeight = dimension(payload.nanoDet.resizedHeight, 'nanoDet.resizedHeight', 416);
    if (payload.nanoDet.targetWidth !== 416 || payload.nanoDet.targetHeight !== 416 ||
      !Number.isSafeInteger(payload.nanoDet.padLeft) || !Number.isSafeInteger(payload.nanoDet.padTop) ||
      payload.nanoDet.padLeft < 0 || payload.nanoDet.padTop < 0 ||
      payload.nanoDet.padLeft + resizedWidth > 416 || payload.nanoDet.padTop + resizedHeight > 416) {
      throw new Error('NanoDet transform is invalid');
    }
    nanoDet = {
      ...payload.nanoDet,
      data,
      sourceWidth: nanoSourceWidth,
      sourceHeight: nanoSourceHeight,
      resizedWidth,
      resizedHeight,
    };
  }
  const fastPerson = normalizePersonTensor(payload.fastPerson, 'fastPerson');
  const refinedPerson = normalizePersonTensor(payload.refinedPerson, 'refinedPerson');
  if (request.includePersonTensors && !fastPerson) {
    throw new Error('worker omitted the requested person tensor');
  }
  if (request.includeNanoDetTensor && !nanoDet) {
    throw new Error('worker omitted the requested NanoDet tensor');
  }

  let yuNet: PreparedImagePayload['yuNet'];
  if (payload.yuNet) {
    const raw = payload.yuNet.data;
    const data = raw instanceof Float32Array
      ? raw
      : new Float32Array(
        (raw as unknown as Uint8Array).buffer,
        (raw as unknown as Uint8Array).byteOffset,
        (raw as unknown as Uint8Array).byteLength / Float32Array.BYTES_PER_ELEMENT,
      );
    if (data.length !== 3 * 640 * 640) throw new Error('YuNet tensor has invalid length');
    const yuSourceWidth = dimension(payload.yuNet.sourceWidth, 'yuNet.sourceWidth');
    const yuSourceHeight = dimension(payload.yuNet.sourceHeight, 'yuNet.sourceHeight');
    const resizedWidth = dimension(payload.yuNet.resizedWidth, 'yuNet.resizedWidth', 640);
    const resizedHeight = dimension(payload.yuNet.resizedHeight, 'yuNet.resizedHeight', 640);
    if (payload.yuNet.targetWidth !== 640 || payload.yuNet.targetHeight !== 640 ||
      !Number.isSafeInteger(payload.yuNet.padLeft) || !Number.isSafeInteger(payload.yuNet.padTop) ||
      payload.yuNet.padLeft < 0 || payload.yuNet.padTop < 0 ||
      payload.yuNet.padLeft + resizedWidth > 640 || payload.yuNet.padTop + resizedHeight > 640) {
      throw new Error('YuNet transform is invalid');
    }
    yuNet = {
      ...payload.yuNet, data, sourceWidth: yuSourceWidth, sourceHeight: yuSourceHeight,
      resizedWidth, resizedHeight,
    };
  }
  if (request.includeYuNetTensor && !yuNet) {
    throw new Error('worker omitted the requested YuNet tensor');
  }

  return {
    ...payload,
    sourceWidth,
    sourceHeight,
    detectorCHW,
    // Electron's structured clone normally already gives typed-array views.
    // Preserve those views to avoid another ~4 MiB surface copy per frame.
    surfaceBitmap,
    surfaceWidth,
    surfaceHeight,
    fastPerson,
    refinedPerson,
    nanoDet,
    yuNet,
  };
}

let productionSupervisor: ImagePreprocessSupervisor | null = null;

function productionWorkerPath(): string {
  const external = path.join(process.resourcesPath, 'image-preprocess-worker.js');
  return app.isPackaged
    ? external
    : path.join(app.getAppPath(), '.vite', 'build', 'image-preprocess-worker.js');
}

function verifiedWorkerPath(): string {
  const external = productionWorkerPath();
  if (!app.isPackaged) return external;
  // The utility process must execute outside ASAR, but that loose copy is not
  // covered by Electron's embedded-ASAR integrity fuse. Bind it byte-for-byte
  // to the Vite worker copy inside the integrity-protected archive before fork.
  const protectedWorker = path.join(
    process.resourcesPath, 'app.asar', '.vite', 'build', 'image-preprocess-worker.js',
  );
  const digest = (filePath: string) => createHash('sha256').update(readFileSync(filePath)).digest('hex');
  const externalDigest = digest(external);
  const protectedDigest = digest(protectedWorker);
  if (externalDigest !== protectedDigest) {
    throw new Error(
      `Image preprocessing worker integrity mismatch (${externalDigest} != ${protectedDigest})`,
    );
  }
  return external;
}

export function getImagePreprocessSupervisor(): ImagePreprocessSupervisor {
  if (!productionSupervisor) {
    const cpuCount = availableParallelism();
    // Sharp/libvips also uses native worker threads internally. More than four
    // lanes oversubscribed a 16-thread workstation and reduced measured sports
    // throughput, so retain the conservative quarter-core policy and hard cap.
    const poolSize = Math.max(1, Math.min(4, Math.floor(cpuCount / 4) || 1));
    productionSupervisor = new ImagePreprocessSupervisor(
      () => utilityProcess.fork(verifiedWorkerPath(), [], {
        serviceName: 'Keptra image preprocessing',
        // Pipe both lanes so startup/native-loader failures are captured in
        // diagnostics. Messages are bounded and never include image pixels.
        stdio: 'pipe',
        env: {
          ...process.env,
          KEPTRA_RESOURCES_PATH: process.resourcesPath,
        },
      }) as unknown as PreprocessChild,
      poolSize,
      15_000,
    );
  }
  return productionSupervisor;
}

export function disposeImagePreprocessSupervisor(): void {
  productionSupervisor?.dispose();
  productionSupervisor = null;
}

export function clearImagePreprocessQuarantine(imagePath?: string): void {
  productionSupervisor?.clearQuarantine(imagePath);
}
