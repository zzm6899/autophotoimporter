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
import { app } from 'electron';
import { log } from '../logger';
import type { PoseKeypoint, PoseKeypoints } from '../../shared/types';

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

function poseModelPath(): string | null {
  const candidates = app.isPackaged
    ? [
        path.join(app.getPath('userData'), 'models', 'movenet_thunder.onnx'),
        path.join(process.resourcesPath, 'models', 'movenet_thunder.onnx'),
      ]
    : [
        path.join(__dirname, '..', '..', '..', 'models', 'movenet_thunder.onnx'),
        path.join(process.cwd(), 'models', 'movenet_thunder.onnx'),
      ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

export function poseModelAvailable(): boolean {
  return poseModelPath() !== null;
}

let session: any | null = null;
let inputName = 'input';
let inputType: 'int32' | 'float32' | 'uint8' = 'int32';
let loadPromise: Promise<boolean> | null = null;
let poseEnabled = false;

export function configurePoseAnalysis(enabled: boolean): void {
  poseEnabled = enabled;
}

export function isPoseAnalysisEnabled(): boolean {
  return poseEnabled && poseModelAvailable();
}

async function loadPoseSession(): Promise<boolean> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const modelFile = poseModelPath();
    if (!modelFile) {
      log.info('[pose-engine] movenet_thunder.onnx not found — pose analysis disabled');
      return false;
    }
    try {
      const runtime = getOrt();
      const providers = process.platform === 'win32' ? ['dml', 'cpu'] : ['cpu'];
      session = await runtime.InferenceSession.create(modelFile, {
        executionProviders: providers,
        graphOptimizationLevel: 'all',
        logSeverityLevel: 3,
      });
      inputName = session.inputNames?.[0] ?? 'input';
      // MoveNet Thunder typically wants int32; some exports use uint8/float32.
      const meta = session.inputMetadata?.[0] ?? session.inputNames?.[0];
      const typeStr = typeof meta === 'object' && meta?.type ? String(meta.type) : '';
      inputType = typeStr.includes('float') ? 'float32' : typeStr.includes('uint8') ? 'uint8' : 'int32';
      log.info(`[pose-engine] MoveNet loaded (input=${inputName}, type=${inputType})`);
      return true;
    } catch (err) {
      log.warn('[pose-engine] failed to load MoveNet:', (err as Error).message);
      session = null;
      return false;
    }
  })();
  return loadPromise;
}

export async function disposePoseEngine(): Promise<void> {
  const s = session;
  session = null;
  loadPromise = null;
  await s?.release?.().catch(() => undefined);
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
  if (!isPoseAnalysisEnabled() || personBoxes.length === 0) return [];
  const ok = await loadPoseSession();
  if (!ok || !session) return [];

  const { width: imgW, height: imgH } = img.getSize();
  const results: PoseKeypoints[] = [];

  for (const box of personBoxes) {
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
      const out = await session.run({ [inputName]: tensor });
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
    } catch (err) {
      log.warn('[pose-engine] pose estimation failed for a box:', (err as Error).message);
    }
  }
  return results;
}
