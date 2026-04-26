/**
 * face-engine.ts
 *
 * Main-process face detection + embedding service using onnxruntime-node.
 *
 * Pipeline per image:
 *   1. UltraFace-slim-640  → bounding boxes for each detected face
 *   2. MobileFaceNet        → L2-normalised embedding per face crop
 *
 * The embedding can be stored on MediaFile.faceEmbedding and used to cluster
 * similar faces across a session via cosine similarity (see cosineSimilarity
 * below). This replaces the old pixel-hash faceSignature with real identity
 * matching that is robust to lighting/angle/JPEG compression changes.
 *
 * Usage:
 *   const result = await analyzeFaces('/path/to/photo.jpg');
 *   // result.boxes   — face bounding boxes normalised 0..1
 *   // result.embeddings — 128-d Float32Array per detected face
 *
 * Session management:
 *   Sessions are loaded lazily on first call and reused for the process
 *   lifetime. Call disposeFaceEngine() before quitting if you need clean
 *   shutdown, but Electron's process exit handles it automatically.
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import { app } from 'electron';

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
}

export interface FaceAnalysisResult {
  /** Detected face bounding boxes (may be empty if no faces found) */
  boxes: FaceBox[];
  /** Detected person/body bounding boxes (may be empty if no people found) */
  personBoxes: FaceBox[];
  /**
   * L2-normalised embedding for each detected face, in the same order
   * as boxes. Use cosineSimilarity() to compare embeddings across images.
   */
  embeddings: Float32Array[];
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the path to a bundled model file.
 *
 * In dev mode: looks in <projectRoot>/models/
 * In packaged app: looks in process.resourcesPath/models/ (extraResources)
 */
function modelPath(fileName: string): string {
  const candidates: string[] = [];

  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'models', fileName));
  } else {
    // Dev: relative to the project root (two levels up from src/main/services/)
    candidates.push(path.join(__dirname, '..', '..', '..', 'models', fileName));
    // Fallback for different CWD contexts
    candidates.push(path.join(process.cwd(), 'models', fileName));
  }

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  throw new Error(
    `Face model "${fileName}" not found. Run "npm run models" to download it.\n` +
    `Searched:\n${candidates.map((p) => `  ${p}`).join('\n')}`,
  );
}

// ---------------------------------------------------------------------------
// Session lifecycle & configuration
// ---------------------------------------------------------------------------

let detectorSession: any | null = null;
let embedderSession: any | null = null;
let personSession: any | null = null;
let sessionLoadPromise: Promise<void> | null = null;
let gpuAvailable: boolean | null = null;
let actualExecutionProvider: string | null = null; // verified after first inference

// Settings-driven configuration
let gpuFaceAccelerationEnabled = true;  // Can be disabled by user
let cpuOptimizationMode = false;        // Lighter models for older CPUs

export function configureGpuAcceleration(enabled: boolean): void {
  gpuFaceAccelerationEnabled = enabled;
}

export function configureCpuOptimization(enabled: boolean): void {
  cpuOptimizationMode = enabled;
}

/**
 * Determine optimal execution providers based on platform & GPU availability.
 * Tries GPU first (CUDA, TensorRT, CoreML, DirectML) then falls back to CPU.
 * Caches result so we don't repeatedly probe unavailable GPUs.
 */
function getExecutionProviders(): string[] {
  // UltraFace (RFB-640) and MobileFaceNet ops don't fully fuse on DML/CoreML —
  // unsupported ops fall back through a slow CPU<->GPU copy loop making DML ~4x
  // SLOWER than optimised CPU (measured: 684ms/img DML vs ~180ms CPU on RTX 4070).
  // Always use CPU with ORT's full graph optimisation for these models.
  return ['cpu'];
}

async function loadSessions(): Promise<void> {
  if (sessionLoadPromise) return sessionLoadPromise;
  sessionLoadPromise = (async () => {
    try {
      const runtime = getOrt();
      const cpuCount = Math.max(2, require('os').cpus().length);

      // CPU-optimised session options — 'all' graph optimisation fuses Conv+BN+ReLU
      // chains for the best throughput on these small detection/embedding models.
      const opts: Record<string, unknown> = {
        executionProviders: ['cpu'],
        graphOptimizationLevel: cpuOptimizationMode ? 'basic' : 'all',
        intraOpNumThreads: cpuOptimizationMode ? 2 : Math.min(cpuCount, 6),
        interOpNumThreads: 1,
      };

      const [detPath, embPath, personPath] = [
        modelPath('version-RFB-640.onnx'),
        modelPath('w600k_mbf.onnx'),
        modelPath('ssd_mobilenet_v1_12.onnx'),
      ];

      console.log('[face-engine] Loading sessions (CPU optimised, threads:', Math.min(cpuCount, 6), ')');

      [detectorSession, embedderSession, personSession] = await Promise.all([
        runtime.InferenceSession.create(detPath, opts),
        runtime.InferenceSession.create(embPath, opts),
        runtime.InferenceSession.create(personPath, opts),
      ]);
      gpuAvailable = false;
      actualExecutionProvider = 'cpu';
      console.log('[face-engine] Sessions loaded — EP: cpu');
    } catch (e) {
      sessionLoadPromise = null;
      throw e;
    }
  })();
  return sessionLoadPromise;
}

export async function disposeFaceEngine(): Promise<void> {
  const [d, e, p] = [detectorSession, embedderSession, personSession];
  detectorSession = null;
  embedderSession = null;
  personSession = null;
  sessionLoadPromise = null;
  gpuAvailable = null;
  actualExecutionProvider = null;
  await Promise.allSettled([d?.release(), e?.release(), p?.release()]);
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
  await loadSessions();
}

/**
 * Returns the actual execution provider in use ('cpu', 'dml', 'coreml', etc.)
 * or null if sessions haven't been loaded yet.
 */
export function getActualExecutionProvider(): string | null {
  return actualExecutionProvider;
}

// ---------------------------------------------------------------------------
// Image preprocessing helpers
// ---------------------------------------------------------------------------

// Pure-Node pixel decoder — we avoid spawning a child process for each image
// by using Electron's nativeImage for fast thumbnail decoding.
// nativeImage is only available in the main process.
import { nativeImage } from 'electron';
import exifr from 'exifr';
import { extractLargestEmbeddedJpeg } from './exif-parser';

/**
 * Load a nativeImage from a path, with RAW fallback via exifr.thumbnail().
 * Returns a decoded nativeImage ready for resizing/cropping.
 * Result is NOT cached — callers that need to reuse it should keep the reference.
 */
// Short-lived decode cache: avoid re-loading the same RAW file within one
// analyzeFaces() call chain. Max 8 entries; evict oldest when full.
const imageDecodeCache = new Map<string, Electron.NativeImage>();
const MAX_DECODE_CACHE = 8;

/** Clear the in-process image decode cache. Call when the scan source changes. */
export function clearImageDecodeCache(): void {
  imageDecodeCache.clear();
}

async function loadNativeImageCached(imagePath: string): Promise<Electron.NativeImage> {
  const cached = imageDecodeCache.get(imagePath);
  if (cached) return cached;
  const img = await loadNativeImage(imagePath);
  if (imageDecodeCache.size >= MAX_DECODE_CACHE) {
    // Evict oldest entry
    const firstKey = imageDecodeCache.keys().next().value;
    if (firstKey !== undefined) imageDecodeCache.delete(firstKey);
  }
  imageDecodeCache.set(imagePath, img);
  return img;
}

async function loadNativeImage(imagePath: string): Promise<Electron.NativeImage> {
  let img = nativeImage.createFromPath(imagePath);
  if (!img.isEmpty()) return img;

  // RAW file — try exifr.thumbnail() first (fast IFD1 parse), then fall back
  // to the full JPEG byte-scanner which finds the largest embedded preview.
  // Some NEF/ARW files have no IFD1 thumbnail but always have a large preview.
  const thumbData = await exifr.thumbnail(imagePath).catch(() => null);
  if (thumbData && thumbData.length > 0) {
    img = nativeImage.createFromBuffer(Buffer.from(thumbData));
    if (!img.isEmpty()) return img;
  }

  // Deep fallback: scan first 8MB of the RAW file for the largest JPEG block
  const jpegBuf = await extractLargestEmbeddedJpeg(imagePath).catch(() => null);
  if (jpegBuf && jpegBuf.length > 0) {
    img = nativeImage.createFromBuffer(jpegBuf);
    if (!img.isEmpty()) return img;
  }

  throw new Error(`Cannot decode image for face analysis: ${imagePath}`);
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
const PERSON_CLASS_ID = 1;
// Electron nativeImage.toBitmap() returns BGRA on Windows/macOS, RGBA elsewhere
const IS_BGRA_PLATFORM = process.platform === 'win32' || process.platform === 'darwin';

interface RawBox {
  x1: number; y1: number; x2: number; y2: number; score: number;
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

async function detectFaces(imagePath: string, cachedImg?: Electron.NativeImage): Promise<FaceBox[]> {
  if (!detectorSession) throw new Error('Face engine not loaded');

  const img = cachedImg ?? await loadNativeImage(imagePath);
  const { data, width, height } = resizeToPixels(img, DETECTOR_W, DETECTOR_H);
  const floats = pixelsToCHW(data, width, height, DET_MEAN, DET_STD);
  const tensor = new (getOrt().Tensor)('float32', floats, [1, 3, height, width]);

  // UltraFace outputs: scores [1, N, 2], boxes [1, N, 4]
  const feeds: Record<string, any> = { input: tensor };
  const result = await detectorSession.run(feeds);

  // Output names vary by export — try common variants
  const scoresKey = Object.keys(result).find((k) => k.includes('score') || k.includes('conf')) ?? Object.keys(result)[0];
  const boxesKey  = Object.keys(result).find((k) => k.includes('box')   || k.includes('loc'))  ?? Object.keys(result)[1];

  const scores = result[scoresKey].data as Float32Array;
  const boxes  = result[boxesKey].data  as Float32Array;

  const raw: RawBox[] = [];
  const numBoxes = boxes.length / 4;

  for (let i = 0; i < numBoxes; i++) {
    // scores layout: [bg_prob, face_prob] per anchor
    const faceProb = scores[i * 2 + 1];
    if (faceProb < CONF_THRESHOLD) continue;

    // boxes are [x1, y1, x2, y2] normalised 0..1
    const x1 = boxes[i * 4];
    const y1 = boxes[i * 4 + 1];
    const x2 = boxes[i * 4 + 2];
    const y2 = boxes[i * 4 + 3];
    raw.push({ x1, y1, x2, y2, score: faceProb });
  }

  return nms(raw).map((b) => ({
    x: b.x1,
    y: b.y1,
    width:  b.x2 - b.x1,
    height: b.y2 - b.y1,
    score: b.score,
  }));
}

async function detectPersons(imagePath: string, cachedImg?: Electron.NativeImage): Promise<FaceBox[]> {
  if (!personSession) throw new Error('Person detector not loaded');

  let img = cachedImg ?? await loadNativeImage(imagePath);

  const original = img.getSize();
  const scale = Math.min(1, 320 / Math.max(original.width, original.height)); // 320 sufficient for body detection, faster than 640
  const targetW = Math.max(32, Math.round(original.width * scale));
  const targetH = Math.max(32, Math.round(original.height * scale));
  img = img.resize({ width: targetW, height: targetH });

  const bitmap = (img.toBitmap?.() ?? img.getBitmap()) as unknown as Buffer;
  const input = pixelsToHWCUint8(bitmap, targetW, targetH);
  const tensor = new (getOrt().Tensor)('uint8', input, [1, targetH, targetW, 3]);
  const result = await personSession.run({ 'image_tensor:0': tensor });

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
  for (let i = 0; i < detectionCount; i++) {
    const klass = Math.round(classes[i]);
    const score = scores[i];
    if (klass !== PERSON_CLASS_ID || score < PERSON_THRESHOLD) continue;
    const top = boxes[i * 4];
    const left = boxes[i * 4 + 1];
    const bottom = boxes[i * 4 + 2];
    const right = boxes[i * 4 + 3];
    raw.push({ x1: left, y1: top, x2: right, y2: bottom, score });
  }

  return nms(raw).map((b) => ({
    x: Math.max(0, b.x1),
    y: Math.max(0, b.y1),
    width: Math.max(0, b.x2 - b.x1),
    height: Math.max(0, b.y2 - b.y1),
    score: b.score,
  }));
}

// ---------------------------------------------------------------------------
// MobileFaceNet embedding
// ---------------------------------------------------------------------------

const EMBED_W = 112;
const EMBED_H = 112;
// ArcFace / MobileFaceNet normalisation
const EMB_MEAN = [0.5, 0.5, 0.5];
const EMB_STD  = [0.5, 0.5, 0.5];

async function embedFace(imagePath: string, box: FaceBox, cachedImg?: Electron.NativeImage): Promise<Float32Array> {
  if (!embedderSession) throw new Error('Face engine not loaded');

  // Read full image, crop to face box, resize to 112×112
  let img = cachedImg ?? await loadNativeImage(imagePath);
  const { width: imgW, height: imgH } = img.getSize();

  // Convert normalised box → pixel coords (clamped)
  const cropX = Math.max(0, Math.round(box.x * imgW));
  const cropY = Math.max(0, Math.round(box.y * imgH));
  const cropW = Math.min(imgW - cropX, Math.round(box.width  * imgW));
  const cropH = Math.min(imgH - cropY, Math.round(box.height * imgH));

  img = img.crop({ x: cropX, y: cropY, width: cropW, height: cropH });
  img = img.resize({ width: EMBED_W, height: EMBED_H });

  const bitmap = (img.toBitmap?.() ?? img.getBitmap()) as unknown as Buffer;
  const floats = pixelsToCHW(bitmap, EMBED_W, EMBED_H, EMB_MEAN, EMB_STD);
  const tensor = new (getOrt().Tensor)('float32', floats, [1, 3, EMBED_H, EMBED_W]);

  const feeds: Record<string, any> = { input: tensor };
  const result = await embedderSession.run(feeds);

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

// Per-image inference timeout — if ONNX hangs (corrupt model, driver issue),
// we reject after 30s so the semaphore slot is released and the loop recovers.
const ANALYZE_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`face-engine timeout: ${label}`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export function analyzeFaces(imagePath: string): Promise<FaceAnalysisResult> {
  return withTimeout(_analyzeFacesInner(imagePath), ANALYZE_TIMEOUT_MS, imagePath);
}

async function _analyzeFacesInner(imagePath: string): Promise<FaceAnalysisResult> {
  await loadSessions();
  const t0 = Date.now();

  // Decode the image once — for RAW files this extracts the embedded JPEG preview.
  // We reuse the same nativeImage for detection, person detection, and embedding
  // so we don't re-read (and re-decode) the file multiple times.
  const img = await loadNativeImageCached(imagePath);

  // Run sequentially — both use the same CPU cores so parallel just causes
  // cache thrashing and L3 contention with no throughput benefit.
  const boxes = await detectFaces(imagePath, img).catch(() => [] as FaceBox[]);
  const personBoxes = await detectPersons(imagePath, img).catch(() => [] as FaceBox[]);

  if (boxes.length === 0) return { boxes, personBoxes, embeddings: [] };

  // Embed each detected face (up to 4 - more than that is unusual in photos)
  const facesToEmbed = boxes.slice(0, 4);
  const embeddings = await Promise.all(
    facesToEmbed.map((box) =>
      embedFace(imagePath, box, img).catch(() => new Float32Array(512)),
    ),
  );

  // Clear cached decode now that all ONNX passes are done
  imageDecodeCache.delete(imagePath);

  // Diagnostic timing — log every 10 images so we can see GPU vs CPU throughput
  _analyzeCallCount++;
  _analyzeTotalMs += Date.now() - t0;
  if (_analyzeCallCount % 10 === 0) {
    const avg = (_analyzeTotalMs / _analyzeCallCount).toFixed(0);
    console.log(`[face-engine] EP:${actualExecutionProvider ?? '?'} avg=${avg}ms/img over ${_analyzeCallCount} images`);
  }

  return { boxes: facesToEmbed, personBoxes, embeddings };
}

/**
 * Run a quick DML diagnostic — creates a session with DML, runs 5 dummy inferences,
 * and reports timing + actual EP. Call from ipc-handlers for a /diagnose endpoint.
 */
export async function diagnoseFaceEngine(): Promise<{
  ep: string | null;
  gpuAvailable: boolean | null;
  avgInferenceMs: number;
  sessionLoadMs: number;
  platform: string;
  providers: string[];
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
    try { await detectorSession!.run({ input: tensor }); } catch { /* ignore */ }
    times.push(Date.now() - t);
  }
  const avgInferenceMs = times.reduce((a, b) => a + b, 0) / times.length;

  console.log('[face-engine] DIAG: EP=%s sessionLoad=%dms avgInference=%dms times=%s',
    actualExecutionProvider, sessionLoadMs, avgInferenceMs.toFixed(1), JSON.stringify(times));

  return {
    ep: actualExecutionProvider,
    gpuAvailable,
    avgInferenceMs,
    sessionLoadMs,
    platform: process.platform,
    providers,
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
 * on MediaFile.faceEmbedding.
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
    modelPath('version-RFB-640.onnx');
    modelPath('w600k_mbf.onnx');
    modelPath('ssd_mobilenet_v1_12.onnx');
    return true;
  } catch {
    return false;
  }
}
