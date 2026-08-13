/**
 * End-to-end runtime used to evaluate pinned detector candidates.
 *
 * This module is deliberately isolated from face-engine.ts. A fast kernel is
 * not enough to promote a model into the culling path: preprocessing, output
 * decoding, NMS, coordinate mapping, and labelled-corpus accuracy all need to
 * be measured first. The CLI harness in scripts/eval-detector-candidates.mjs
 * exercises this exact implementation with real image pixels.
 */
import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DetectorCandidateModel } from './detector-model-manifest';

type OrtTensorData = Float32Array | Uint8Array | Int32Array | BigInt64Array;

interface OrtTensor {
  readonly data: OrtTensorData;
  readonly dims: readonly number[];
}

interface OrtSession {
  readonly inputNames?: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
  release?(): Promise<void>;
}

interface OrtModule {
  readonly InferenceSession: {
    create(modelPath: string, options: Record<string, unknown>): Promise<OrtSession>;
  };
  readonly Tensor: new (
    type: 'float32',
    data: Float32Array,
    dimensions: readonly number[],
  ) => unknown;
}

type SharpFactory = (typeof import('sharp'))['default'];
type ImageInput = string | Buffer;

const requireFromHere = createRequire(import.meta.url);

export type CandidateDetectorProvider = 'cpu' | 'dml';

export interface DetectorPoint {
  /** Normalised coordinate relative to the upright source image. */
  x: number;
  /** Normalised coordinate relative to the upright source image. */
  y: number;
}

export interface CandidateDetection {
  /** Normalised top-left coordinate relative to the upright source image. */
  x: number;
  /** Normalised top-left coordinate relative to the upright source image. */
  y: number;
  /** Normalised width relative to the upright source image. */
  width: number;
  /** Normalised height relative to the upright source image. */
  height: number;
  /** Detector confidence in [0, 1]. */
  score: number;
  /** COCO class id when the candidate is an object detector. */
  classId?: number;
  /** YuNet's right eye, left eye, nose, right mouth, and left mouth points. */
  landmarks?: readonly [DetectorPoint, DetectorPoint, DetectorPoint, DetectorPoint, DetectorPoint];
}

export interface LetterboxTransform {
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly targetWidth: number;
  readonly targetHeight: number;
  readonly resizedWidth: number;
  readonly resizedHeight: number;
  readonly padLeft: number;
  readonly padTop: number;
}

export interface PreparedDetectorInput {
  readonly data: Float32Array;
  readonly dimensions: readonly [number, number, number, number];
  readonly transform: LetterboxTransform;
}

export interface TensorOutput {
  readonly data: Float32Array;
  readonly dims: readonly number[];
}

export type CandidateOutputs = Readonly<Record<string, TensorOutput>>;

export interface CandidateRunResult {
  readonly detections: readonly CandidateDetection[];
  readonly timings: {
    readonly preprocessMs: number;
    readonly inferenceMs: number;
    readonly postprocessMs: number;
    readonly totalMs: number;
  };
}

export interface YuNetDecodeOptions {
  readonly scoreThreshold?: number;
  readonly nmsThreshold?: number;
  readonly preNmsTopK?: number;
  readonly maxDetections?: number;
}

export interface NanoDetDecodeOptions {
  readonly scoreThreshold?: number;
  readonly nmsThreshold?: number;
  readonly preNmsTopK?: number;
  readonly maxDetections?: number;
  /** Match the upstream decoder by requiring person to be the top class. */
  readonly requireTopClass?: boolean;
}

export interface DetectionLabel {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DetectionMetrics {
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
}

interface PixelDetection {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number;
  classId?: number;
  landmarks?: readonly [DetectorPoint, DetectorPoint, DetectorPoint, DetectorPoint, DetectorPoint];
  sourceIndex: number;
}

let sharpFactory: SharpFactory | null = null;
let ortModule: OrtModule | null = null;

function getSharp(): SharpFactory {
  if (sharpFactory) return sharpFactory;
  const loaded = requireFromHere('sharp') as SharpFactory | { default: SharpFactory };
  sharpFactory = typeof loaded === 'function' ? loaded : loaded.default;
  if (!sharpFactory) throw new Error('sharp is required by the detector candidate evaluator');
  return sharpFactory;
}

function getOrt(): OrtModule {
  if (ortModule) return ortModule;
  ortModule = requireFromHere('onnxruntime-node') as OrtModule;
  return ortModule;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function finite(value: number, description: string): number {
  if (!Number.isFinite(value)) throw new Error(`Non-finite ${description} in detector output`);
  return value;
}

function now(): number {
  return performance.now();
}

/** Decode and letterbox actual image pixels into the model's exact NCHW contract. */
export async function prepareCandidateInput(
  image: ImageInput,
  candidate: Pick<DetectorCandidateModel, 'id' | 'input' | 'decoder'>,
): Promise<PreparedDetectorInput> {
  const dimensions = candidate.input.dimensions;
  if (dimensions[0] !== 1 || dimensions[1] !== 3 || candidate.input.layout !== 'nchw') {
    throw new Error(`${candidate.id} has an unsupported input contract`);
  }

  const targetHeight = dimensions[2];
  const targetWidth = dimensions[3];
  const sharp = getSharp();
  const metadata = await sharp(image, { failOn: 'error', limitInputPixels: false }).metadata();
  const sourceWidth = metadata.autoOrient?.width ?? metadata.width;
  const sourceHeight = metadata.autoOrient?.height ?? metadata.height;
  if (!sourceWidth || !sourceHeight) throw new Error('Image decoder returned invalid dimensions');

  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const resizedWidth = Math.max(1, Math.min(targetWidth, Math.round(sourceWidth * scale)));
  const resizedHeight = Math.max(1, Math.min(targetHeight, Math.round(sourceHeight * scale)));
  const padLeft = Math.floor((targetWidth - resizedWidth) / 2);
  const padTop = Math.floor((targetHeight - resizedHeight) / 2);
  const padRight = targetWidth - resizedWidth - padLeft;
  const padBottom = targetHeight - resizedHeight - padTop;

  const { data: rgb, info } = await sharp(image, { failOn: 'error', limitInputPixels: false })
    .autoOrient()
    .resize(resizedWidth, resizedHeight, { fit: 'fill', kernel: 'lanczos3' })
    .removeAlpha()
    .toColourspace('srgb')
    .extend({
      top: padTop,
      bottom: padBottom,
      left: padLeft,
      right: padRight,
      background: { r: 0, g: 0, b: 0 },
    })
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.width !== targetWidth || info.height !== targetHeight || info.channels !== 3) {
    throw new Error(`Unexpected decoded shape ${info.width}x${info.height}x${info.channels}`);
  }

  const plane = targetWidth * targetHeight;
  const chw = new Float32Array(plane * 3);
  const nanoDet = candidate.decoder === 'nanodet-plus-gfl-v1';
  const means = [103.53, 116.28, 123.675] as const;
  const standardDeviations = [57.375, 57.12, 58.395] as const;

  for (let pixel = 0; pixel < plane; pixel++) {
    const sourceOffset = pixel * 3;
    for (let modelChannel = 0; modelChannel < 3; modelChannel++) {
      const rgbChannel = candidate.input.colourOrder === 'bgr' ? 2 - modelChannel : modelChannel;
      const byte = rgb[sourceOffset + rgbChannel];
      chw[modelChannel * plane + pixel] = nanoDet
        ? (byte - means[modelChannel]) / standardDeviations[modelChannel]
        : byte;
    }
  }

  return {
    data: chw,
    dimensions,
    transform: {
      sourceWidth,
      sourceHeight,
      targetWidth,
      targetHeight,
      resizedWidth,
      resizedHeight,
      padLeft,
      padTop,
    },
  };
}

function tensor(outputs: CandidateOutputs, name: string, width: number): Float32Array {
  const output = outputs[name];
  if (!output) throw new Error(`Detector output is missing ${name}`);
  if (!(output.data instanceof Float32Array)) throw new Error(`Detector output ${name} is not float32`);
  if (output.data.length % width !== 0) {
    throw new Error(`Detector output ${name} length ${output.data.length} is not divisible by ${width}`);
  }
  return output.data;
}

function remapPoint(point: DetectorPoint, transform: LetterboxTransform): DetectorPoint {
  return {
    x: clamp01((point.x - transform.padLeft) / transform.resizedWidth),
    y: clamp01((point.y - transform.padTop) / transform.resizedHeight),
  };
}

function remapDetection(box: PixelDetection, transform: LetterboxTransform): CandidateDetection | null {
  const contentRight = transform.padLeft + transform.resizedWidth;
  const contentBottom = transform.padTop + transform.resizedHeight;
  const x1 = clamp(box.x1, transform.padLeft, contentRight);
  const y1 = clamp(box.y1, transform.padTop, contentBottom);
  const x2 = clamp(box.x2, transform.padLeft, contentRight);
  const y2 = clamp(box.y2, transform.padTop, contentBottom);
  if (x2 - x1 < 1 || y2 - y1 < 1) return null;
  return {
    x: clamp01((x1 - transform.padLeft) / transform.resizedWidth),
    y: clamp01((y1 - transform.padTop) / transform.resizedHeight),
    width: clamp01((x2 - x1) / transform.resizedWidth),
    height: clamp01((y2 - y1) / transform.resizedHeight),
    score: clamp01(box.score),
    ...(box.classId === undefined ? {} : { classId: box.classId }),
    ...(box.landmarks ? {
      landmarks: box.landmarks.map((point) => remapPoint(point, transform)) as unknown as CandidateDetection['landmarks'],
    } : {}),
  };
}

function intersectionOverUnion(a: PixelDetection, b: PixelDetection): number {
  const left = Math.max(a.x1, b.x1);
  const top = Math.max(a.y1, b.y1);
  const right = Math.min(a.x2, b.x2);
  const bottom = Math.min(a.y2, b.y2);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  if (intersection <= 0) return 0;
  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
  return intersection / Math.max(Number.EPSILON, areaA + areaB - intersection);
}

function nms(
  candidates: PixelDetection[],
  threshold: number,
  preNmsTopK: number,
  maxDetections: number,
  classAgnostic = false,
): PixelDetection[] {
  const sorted = [...candidates]
    .sort((a, b) => b.score - a.score || a.sourceIndex - b.sourceIndex)
    .slice(0, preNmsTopK);
  const kept: PixelDetection[] = [];
  for (const candidate of sorted) {
    if (kept.some((other) =>
      (classAgnostic || other.classId === undefined || candidate.classId === undefined || other.classId === candidate.classId) &&
      intersectionOverUnion(other, candidate) >= threshold)) continue;
    kept.push(candidate);
    if (kept.length >= maxDetections) break;
  }
  return kept;
}

/** Decode YuNet's 12 raw heads using OpenCV FaceDetectorYN's published math. */
export function decodeYuNet(
  outputs: CandidateOutputs,
  transform: LetterboxTransform,
  options: YuNetDecodeOptions = {},
): CandidateDetection[] {
  const scoreThreshold = options.scoreThreshold ?? 0.7;
  const nmsThreshold = options.nmsThreshold ?? 0.3;
  const preNmsTopK = options.preNmsTopK ?? 5_000;
  const maxDetections = options.maxDetections ?? 512;
  const raw: PixelDetection[] = [];
  let sourceIndex = 0;

  for (const stride of [8, 16, 32] as const) {
    const rows = transform.targetHeight / stride;
    const columns = transform.targetWidth / stride;
    if (!Number.isInteger(rows) || !Number.isInteger(columns)) {
      throw new Error(`YuNet input ${transform.targetWidth}x${transform.targetHeight} is not divisible by ${stride}`);
    }
    const expected = rows * columns;
    const cls = tensor(outputs, `cls_${stride}`, 1);
    const obj = tensor(outputs, `obj_${stride}`, 1);
    const bbox = tensor(outputs, `bbox_${stride}`, 4);
    const keypoints = tensor(outputs, `kps_${stride}`, 10);
    if (cls.length !== expected || obj.length !== expected ||
        bbox.length !== expected * 4 || keypoints.length !== expected * 10) {
      throw new Error(`YuNet stride ${stride} output shape does not match ${transform.targetWidth}x${transform.targetHeight}`);
    }

    for (let index = 0; index < expected; index++) {
      const score = Math.sqrt(clamp(finite(cls[index], 'YuNet class score'), 0, 1) *
        clamp(finite(obj[index], 'YuNet object score'), 0, 1));
      if (score < scoreThreshold) continue;
      const row = Math.floor(index / columns);
      const column = index % columns;
      const cx = (column + finite(bbox[index * 4], 'YuNet box x')) * stride;
      const cy = (row + finite(bbox[index * 4 + 1], 'YuNet box y')) * stride;
      const width = Math.exp(clamp(finite(bbox[index * 4 + 2], 'YuNet box width'), -20, 20)) * stride;
      const height = Math.exp(clamp(finite(bbox[index * 4 + 3], 'YuNet box height'), -20, 20)) * stride;
      const landmarks = Array.from({ length: 5 }, (_, landmark): DetectorPoint => ({
        x: (column + finite(keypoints[index * 10 + landmark * 2], 'YuNet landmark x')) * stride,
        y: (row + finite(keypoints[index * 10 + landmark * 2 + 1], 'YuNet landmark y')) * stride,
      })) as unknown as PixelDetection['landmarks'];
      raw.push({
        x1: cx - width / 2,
        y1: cy - height / 2,
        x2: cx + width / 2,
        y2: cy + height / 2,
        score,
        landmarks,
        sourceIndex: sourceIndex++,
      });
    }
  }

  return nms(raw, nmsThreshold, preNmsTopK, maxDetections)
    .map((box) => remapDetection(box, transform))
    .filter((box): box is CandidateDetection => box !== null);
}

function stableSoftmaxExpectation(values: Float32Array, offset: number, bins: number): number {
  let max = -Infinity;
  for (let i = 0; i < bins; i++) max = Math.max(max, finite(values[offset + i], 'NanoDet DFL logit'));
  let denominator = 0;
  let numerator = 0;
  for (let i = 0; i < bins; i++) {
    const probability = Math.exp(values[offset + i] - max);
    denominator += probability;
    numerator += probability * i;
  }
  return numerator / Math.max(Number.EPSILON, denominator);
}

function nanoDetHeads(
  outputs: CandidateOutputs,
  stride: number,
  expectedLocations: number,
): { classes: Float32Array; boxes: Float32Array } {
  const matching = Object.entries(outputs).filter(([, output]) => output.dims[output.dims.length - 2] === expectedLocations);
  const classOutput = matching.find(([, output]) => output.data.length === expectedLocations * 80);
  const boxOutput = matching.find(([, output]) => output.data.length === expectedLocations * 32);
  if (!classOutput || !boxOutput) {
    throw new Error(`NanoDet stride ${stride} heads are missing or have unexpected shapes`);
  }
  return { classes: classOutput[1].data, boxes: boxOutput[1].data };
}

/** Decode NanoDet-Plus GFL outputs into class-0 person boxes. */
export function decodeNanoDetPersons(
  outputs: CandidateOutputs,
  transform: LetterboxTransform,
  options: NanoDetDecodeOptions = {},
): CandidateDetection[] {
  const scoreThreshold = options.scoreThreshold ?? 0.35;
  const nmsThreshold = options.nmsThreshold ?? 0.6;
  const preNmsTopK = options.preNmsTopK ?? 1_000;
  const maxDetections = options.maxDetections ?? 256;
  const requireTopClass = options.requireTopClass ?? true;
  const raw: PixelDetection[] = [];
  let sourceIndex = 0;

  for (const stride of [8, 16, 32] as const) {
    const rows = transform.targetHeight / stride;
    const columns = transform.targetWidth / stride;
    if (!Number.isInteger(rows) || !Number.isInteger(columns)) {
      throw new Error(`NanoDet input ${transform.targetWidth}x${transform.targetHeight} is not divisible by ${stride}`);
    }
    const locations = rows * columns;
    const heads = nanoDetHeads(outputs, stride, locations);
    const rankedLocations: Array<{ index: number; classId: number; score: number }> = [];
    for (let index = 0; index < locations; index++) {
      const classOffset = index * 80;
      const personScore = finite(heads.classes[classOffset], 'NanoDet person score');
      if (requireTopClass) {
        let topClass = 0;
        let topScore = personScore;
        for (let classId = 1; classId < 80; classId++) {
          const score = finite(heads.classes[classOffset + classId], 'NanoDet class score');
          if (score > topScore) {
            topScore = score;
            topClass = classId;
          }
        }
        rankedLocations.push({ index, classId: topClass, score: topScore });
      } else {
        rankedLocations.push({ index, classId: 0, score: personScore });
      }
    }

    // OpenCV Zoo keeps the strongest 1,000 anchors per feature level before
    // DFL decoding. Mirroring that detail is required for metric parity.
    rankedLocations.sort((a, b) => b.score - a.score || a.index - b.index);
    for (const location of rankedLocations.slice(0, preNmsTopK)) {
      if (location.score < scoreThreshold) break;
      const index = location.index;
      const row = Math.floor(index / columns);
      const column = index % columns;
      const anchorX = column * stride + 0.5 * (stride - 1);
      const anchorY = row * stride + 0.5 * (stride - 1);
      const boxOffset = index * 32;
      const left = stableSoftmaxExpectation(heads.boxes, boxOffset, 8) * stride;
      const top = stableSoftmaxExpectation(heads.boxes, boxOffset + 8, 8) * stride;
      const right = stableSoftmaxExpectation(heads.boxes, boxOffset + 16, 8) * stride;
      const bottom = stableSoftmaxExpectation(heads.boxes, boxOffset + 24, 8) * stride;
      raw.push({
        x1: clamp(anchorX - left, 0, transform.targetWidth),
        y1: clamp(anchorY - top, 0, transform.targetHeight),
        x2: clamp(anchorX + right, 0, transform.targetWidth),
        y2: clamp(anchorY + bottom, 0, transform.targetHeight),
        score: clamp01(location.score),
        classId: location.classId,
        sourceIndex: sourceIndex++,
      });
    }
  }

  // The pinned upstream decoder performs class-agnostic NMS, then returns
  // class ids. Filter class 0 only after NMS so the evaluator is comparable
  // with its published implementation and accuracy table.
  return nms(raw, nmsThreshold, raw.length, raw.length, true)
    .filter((box) => box.classId === 0)
    .slice(0, maxDetections)
    .map((box) => remapDetection(box, transform))
    .filter((box): box is CandidateDetection => box !== null);
}

function normalisedIoU(a: DetectionLabel, b: DetectionLabel): number {
  return intersectionOverUnion({
    x1: a.x,
    y1: a.y,
    x2: a.x + a.width,
    y2: a.y + a.height,
    score: 1,
    sourceIndex: 0,
  }, {
    x1: b.x,
    y1: b.y,
    x2: b.x + b.width,
    y2: b.y + b.height,
    score: 1,
    sourceIndex: 0,
  });
}

/** Greedy confidence-ordered matching for labelled-corpus precision/recall. */
export function scoreDetections(
  predictions: readonly CandidateDetection[],
  labels: readonly DetectionLabel[],
  iouThreshold = 0.5,
): DetectionMetrics {
  const matchedLabels = new Set<number>();
  let truePositives = 0;
  for (const prediction of [...predictions].sort((a, b) => b.score - a.score)) {
    let bestLabel = -1;
    let bestIou = iouThreshold;
    for (let index = 0; index < labels.length; index++) {
      if (matchedLabels.has(index)) continue;
      const overlap = normalisedIoU(prediction, labels[index]);
      if (overlap >= bestIou) {
        bestIou = overlap;
        bestLabel = index;
      }
    }
    if (bestLabel >= 0) {
      matchedLabels.add(bestLabel);
      truePositives++;
    }
  }
  const falsePositives = predictions.length - truePositives;
  const falseNegatives = labels.length - truePositives;
  const precision = truePositives / Math.max(1, truePositives + falsePositives);
  const recall = truePositives / Math.max(1, truePositives + falseNegatives);
  return {
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall),
  };
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function assertVerifiedModelFile(candidate: DetectorCandidateModel, modelPath: string): Promise<void> {
  let size: number;
  try {
    size = statSync(modelPath).size;
  } catch {
    throw new Error(`Candidate model is missing: ${modelPath}`);
  }
  if (size !== candidate.bytes) {
    throw new Error(`${candidate.id} model size mismatch (expected ${candidate.bytes}, received ${size})`);
  }
  const digest = await sha256File(modelPath);
  if (digest !== candidate.sha256) throw new Error(`${candidate.id} model SHA-256 mismatch`);
}

function asFloatOutputs(outputs: Record<string, OrtTensor>): CandidateOutputs {
  const converted: Record<string, TensorOutput> = {};
  for (const [name, output] of Object.entries(outputs)) {
    if (!(output.data instanceof Float32Array)) {
      throw new Error(`Candidate output ${name} was not float32`);
    }
    converted[name] = { data: output.data, dims: output.dims };
  }
  return converted;
}

/** Verified, opt-in runtime. It never downloads or selects a model implicitly. */
export class DetectorCandidateRuntime {
  readonly candidate: DetectorCandidateModel;
  readonly provider: CandidateDetectorProvider;
  private readonly session: OrtSession;
  private readonly inputName: string;

  private constructor(
    candidate: DetectorCandidateModel,
    provider: CandidateDetectorProvider,
    session: OrtSession,
    inputName: string,
  ) {
    this.candidate = candidate;
    this.provider = provider;
    this.session = session;
    this.inputName = inputName;
  }

  static async create(
    candidate: DetectorCandidateModel,
    modelPath: string,
    provider: CandidateDetectorProvider,
  ): Promise<DetectorCandidateRuntime> {
    if (candidate.decoder !== 'yunet-v1' && candidate.decoder !== 'nanodet-plus-gfl-v1') {
      const detail = candidate.decoder === 'yolox-v1' ? 'YOLOX-S' : candidate.decoder;
      throw new Error(`${detail} decoding is not implemented; keep this candidate evaluation-only`);
    }
    if (provider === 'dml' && process.platform !== 'win32') {
      throw new Error('DirectML detector evaluation is available only on Windows');
    }
    await assertVerifiedModelFile(candidate, modelPath);
    const runtime = getOrt();
    const session = await runtime.InferenceSession.create(modelPath, {
      executionProviders: provider === 'dml' ? [{ name: 'dml' }] : ['cpu'],
      executionMode: 'sequential',
      enableMemPattern: provider !== 'dml',
      graphOptimizationLevel: 'all',
      intraOpNumThreads: provider === 'cpu' ? Math.min(6, Math.max(1, requireFromHere('node:os').cpus().length)) : 1,
      interOpNumThreads: 1,
      logSeverityLevel: 3,
    });
    const inputName = session.inputNames?.[0];
    if (!inputName) {
      await session.release?.();
      throw new Error(`${candidate.id} session did not expose an input name`);
    }
    return new DetectorCandidateRuntime(candidate, provider, session, inputName);
  }

  async run(image: ImageInput): Promise<CandidateRunResult> {
    const startedAt = now();
    const prepared = await prepareCandidateInput(image, this.candidate);
    const preprocessedAt = now();
    const preparedResult = await this.runPrepared(prepared);
    const completedAt = now();
    return {
      detections: preparedResult.detections,
      timings: {
        preprocessMs: preprocessedAt - startedAt,
        inferenceMs: preparedResult.timings.inferenceMs,
        postprocessMs: preparedResult.timings.postprocessMs,
        totalMs: completedAt - startedAt,
      },
    };
  }

  /**
   * Run a real, already-preprocessed image tensor. This separates the model
   * ceiling from decode/resize cost without using misleading all-zero input.
   */
  async runPrepared(prepared: PreparedDetectorInput): Promise<CandidateRunResult> {
    const expectedDimensions = this.candidate.input.dimensions;
    if (prepared.dimensions.some((dimension, index) => dimension !== expectedDimensions[index])) {
      throw new Error(`${this.candidate.id} prepared tensor dimensions do not match its manifest`);
    }
    const expectedLength = expectedDimensions.reduce((product, dimension) => product * dimension, 1);
    if (prepared.data.length !== expectedLength) {
      throw new Error(`${this.candidate.id} prepared tensor length does not match its manifest`);
    }
    const startedAt = now();
    const runtime = getOrt();
    const input = new runtime.Tensor('float32', prepared.data, prepared.dimensions);
    const raw = await this.session.run({ [this.inputName]: input });
    const inferredAt = now();
    const outputs = asFloatOutputs(raw);
    const detections = this.candidate.decoder === 'yunet-v1'
      ? decodeYuNet(outputs, prepared.transform)
      : decodeNanoDetPersons(outputs, prepared.transform);
    const completedAt = now();
    return {
      detections,
      timings: {
        preprocessMs: 0,
        inferenceMs: inferredAt - startedAt,
        postprocessMs: completedAt - inferredAt,
        totalMs: completedAt - startedAt,
      },
    };
  }

  async close(): Promise<void> {
    await this.session.release?.();
  }
}
