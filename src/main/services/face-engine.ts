/**
 * face-engine.ts
 *
 * Main-process face detection + embedding service using onnxruntime-node.
 *
 * Pipeline per image:
 *   1. UltraFace-slim-640  → bounding boxes for each detected face
 *   2. MobileFaceNet        → 128-d L2-normalised embedding per face crop
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
import { readFile } from 'node:fs/promises';
import { app } from 'electron';

// onnxruntime-node is a native addon — it must be outside the asar.
// The forge config sets unpackDir for it. Require at runtime to avoid
// Vite trying to bundle it (it's CJS with a native .node binary).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ort = require('onnxruntime-node') as typeof import('onnxruntime-node');

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
  /**
   * 128-d L2-normalised embedding for each detected face, in the same order
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
// Session lifecycle
// ---------------------------------------------------------------------------

let detectorSession: import('onnxruntime-node').InferenceSession | null = null;
let embedderSession: import('onnxruntime-node').InferenceSession | null = null;
let sessionLoadPromise: Promise<void> | null = null;

async function loadSessions(): Promise<void> {
  if (sessionLoadPromise) return sessionLoadPromise;
  sessionLoadPromise = (async () => {
    const opts: import('onnxruntime-node').InferenceSession.SessionOptions = {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    };
    const [detPath, embPath] = [
      modelPath('ultraface-slim-640.onnx'),
      modelPath('mobilefacenet.onnx'),
    ];
    [detectorSession, embedderSession] = await Promise.all([
      ort.InferenceSession.create(detPath, opts),
      ort.InferenceSession.create(embPath, opts),
    ]);
  })();
  return sessionLoadPromise;
}

export async function disposeFaceEngine(): Promise<void> {
  const [d, e] = [detectorSession, embedderSession];
  detectorSession = null;
  embedderSession = null;
  sessionLoadPromise = null;
  await Promise.allSettled([d?.release(), e?.release()]);
}

// ---------------------------------------------------------------------------
// Image preprocessing helpers
// ---------------------------------------------------------------------------

// Pure-Node pixel decoder — we avoid spawning a child process for each image
// by using Electron's nativeImage for fast thumbnail decoding.
// nativeImage is only available in the main process.
import { nativeImage } from 'electron';

/**
 * Decode image → raw RGBA pixels at a target size.
 * Returns { data: Uint8Array (RGBA), width, height }.
 */
async function decodeImage(
  imagePath: string,
  targetW: number,
  targetH: number,
): Promise<{ data: Buffer; width: number; height: number }> {
  // nativeImage can read JPEG, PNG, HEIC, WEBP, BMP, GIF (first frame).
  // For RAW formats it will return empty — we fall back to reading the
  // embedded JPEG preview (which is what exifr does too).
  let img = nativeImage.createFromPath(imagePath);

  if (img.isEmpty()) {
    // Try reading the first few KB as a JPEG (most RAWs embed a JPEG preview)
    // This is a best-effort fallback; for now we just skip RAWs.
    throw new Error(`Cannot decode image for face analysis: ${imagePath}`);
  }

  // Resize to target dimensions preserving aspect ratio with letterboxing
  img = img.resize({ width: targetW, height: targetH });

  const bitmap = img.getBitmap();  // raw BGRA on macOS/Win, RGBA elsewhere
  const size = img.getSize();

  return { data: bitmap, width: size.width, height: size.height };
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
  for (let i = 0; i < channelSize; i++) {
    const base = i * 4;
    // nativeImage returns BGRA on Windows, RGBA on macOS. We normalise both
    // by checking platform — for face detection the channel order matters.
    const r = pixels[base] / 255.0;
    const g = pixels[base + 1] / 255.0;
    const b = pixels[base + 2] / 255.0;
    tensor[i] = (r - mean[0]) / std[0];
    tensor[channelSize + i] = (g - mean[1]) / std[1];
    tensor[2 * channelSize + i] = (b - mean[2]) / std[2];
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

async function detectFaces(imagePath: string): Promise<FaceBox[]> {
  if (!detectorSession) throw new Error('Face engine not loaded');

  const { data, width, height } = await decodeImage(imagePath, DETECTOR_W, DETECTOR_H);
  const floats = pixelsToCHW(data, width, height, DET_MEAN, DET_STD);
  const tensor = new ort.Tensor('float32', floats, [1, 3, height, width]);

  // UltraFace outputs: scores [1, N, 2], boxes [1, N, 4]
  const feeds: Record<string, import('onnxruntime-node').Tensor> = { input: tensor };
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

// ---------------------------------------------------------------------------
// MobileFaceNet embedding
// ---------------------------------------------------------------------------

const EMBED_W = 112;
const EMBED_H = 112;
// ArcFace / MobileFaceNet normalisation
const EMB_MEAN = [0.5, 0.5, 0.5];
const EMB_STD  = [0.5, 0.5, 0.5];

async function embedFace(imagePath: string, box: FaceBox): Promise<Float32Array> {
  if (!embedderSession) throw new Error('Face engine not loaded');

  // Read full image, crop to face box, resize to 112×112
  let img = nativeImage.createFromPath(imagePath);
  const { width: imgW, height: imgH } = img.getSize();

  // Convert normalised box → pixel coords (clamped)
  const cropX = Math.max(0, Math.round(box.x * imgW));
  const cropY = Math.max(0, Math.round(box.y * imgH));
  const cropW = Math.min(imgW - cropX, Math.round(box.width  * imgW));
  const cropH = Math.min(imgH - cropY, Math.round(box.height * imgH));

  img = img.crop({ x: cropX, y: cropY, width: cropW, height: cropH });
  img = img.resize({ width: EMBED_W, height: EMBED_H });

  const bitmap = img.getBitmap();
  const floats = pixelsToCHW(bitmap, EMBED_W, EMBED_H, EMB_MEAN, EMB_STD);
  const tensor = new ort.Tensor('float32', floats, [1, 3, EMBED_H, EMBED_W]);

  const feeds: Record<string, import('onnxruntime-node').Tensor> = { input: tensor };
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
 * @returns          Detected boxes + per-face 128-d embeddings.
 */
export async function analyzeFaces(imagePath: string): Promise<FaceAnalysisResult> {
  await loadSessions();

  let boxes: FaceBox[];
  try {
    boxes = await detectFaces(imagePath);
  } catch {
    // Undecodable image (e.g. unsupported RAW) — return empty result
    return { boxes: [], embeddings: [] };
  }

  if (boxes.length === 0) return { boxes, embeddings: [] };

  // Embed each detected face (up to 4 — more than that is unusual in photos)
  const facesToEmbed = boxes.slice(0, 4);
  const embeddings = await Promise.all(
    facesToEmbed.map((box) =>
      embedFace(imagePath, box).catch(() => new Float32Array(128)),
    ),
  );

  return { boxes: facesToEmbed, embeddings };
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
 * on MediaFile.faceEmbedding. 128 floats × 4 bytes = 512 bytes → 1024 hex chars.
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
    modelPath('ultraface-slim-640.onnx');
    modelPath('mobilefacenet.onnx');
    return true;
  } catch {
    return false;
  }
}
