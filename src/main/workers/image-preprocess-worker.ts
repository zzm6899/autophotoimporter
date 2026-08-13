/* eslint-disable @typescript-eslint/no-require-imports */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import {
  imagePreprocessPlan,
  sharpOrientationOperations,
  sourcePixelOrientation,
} from '../services/image-preprocess-plan';
type ParentPort = {
  on(event: 'message', listener: (event: { data: WorkerRequest }) => void): void;
  postMessage(message: unknown): void;
};

interface WorkerRequest {
  type: 'prepare';
  id: number;
  imagePath: string;
  sourcePath?: string;
  inputBuffer?: Uint8Array;
  extractEmbeddedJpeg?: boolean;
  useSourceOrientation?: boolean;
  orientation: number;
  includeDetectorTensor?: boolean;
  includeAnalysisSurface: boolean;
  includePersonTensors: boolean;
  includeNanoDetTensor?: boolean;
  includeYuNetTensor?: boolean;
  analysisMaxDimension?: number;
  bitmapOrder: 'bgra' | 'rgba';
}

const parentPort = (process as typeof process & { parentPort?: ParentPort }).parentPort;
if (!parentPort) throw new Error('image preprocess worker must run as an Electron utility process');

type SharpFn = (typeof import('sharp'))['default'];
const resourcesPath = process.env.KEPTRA_RESOURCES_PATH ||
  (process as typeof process & { resourcesPath?: string }).resourcesPath;
const packagedSharpPath = resourcesPath
  ? path.join(resourcesPath, 'sharp-runtime', 'node_modules', 'sharp')
  : '';
const sharpModulePath = packagedSharpPath && existsSync(packagedSharpPath)
  ? packagedSharpPath
  : 'sharp';
let sharpModule: SharpFn | { default: SharpFn };
try {
  sharpModule = require(sharpModulePath) as SharpFn | { default: SharpFn };
} catch (error) {
  console.error(`[image-preprocess-worker] Sharp failed to load from ${sharpModulePath}:`, error);
  throw error;
}
const sharp = (typeof sharpModule === 'function' ? sharpModule : sharpModule.default) as SharpFn;
sharp.concurrency(1);

function send(message: unknown): void {
  parentPort!.postMessage(message);
}

function stage(request: WorkerRequest, value: string): void {
  send({ type: 'stage', id: request.id, imagePath: request.imagePath, stage: value });
}

function orientedPipeline(input: ReturnType<typeof sharp>, orientation: number): ReturnType<typeof sharp> {
  let pipeline = input;
  for (const operation of sharpOrientationOperations(orientation)) {
    if (operation === 'rotate90') pipeline = pipeline.rotate(90);
    else if (operation === 'rotate180') pipeline = pipeline.rotate(180);
    else if (operation === 'rotate270') pipeline = pipeline.rotate(270);
    else if (operation === 'flip') pipeline = pipeline.flip();
    else pipeline = pipeline.flop();
  }
  return pipeline;
}

const MAX_RAW_SCAN_BYTES = 12 * 1024 * 1024;

function jpegEnd(buffer: Buffer, start: number): number {
  let index = start;
  while (index < buffer.length - 1) {
    if (buffer[index] !== 0xff) { index++; continue; }
    let markerIndex = index;
    while (markerIndex < buffer.length - 1 && buffer[markerIndex] === 0xff) markerIndex++;
    const marker = buffer[markerIndex];
    if (marker === 0x00) { index = markerIndex + 1; continue; }
    if (marker === 0xd9) return markerIndex;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      index = markerIndex + 1;
      continue;
    }
    if (markerIndex + 2 >= buffer.length) return -1;
    const segmentLength = buffer.readUInt16BE(markerIndex + 1);
    if (segmentLength < 2) return -1;
    if (marker === 0xda) {
      index = markerIndex + 1 + segmentLength;
      while (index < buffer.length - 1) {
        if (buffer[index] === 0xff) {
          const next = buffer[index + 1];
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { index += 2; continue; }
          break;
        }
        index++;
      }
      continue;
    }
    index = markerIndex + 1 + segmentLength;
  }
  return -1;
}

function largestEmbeddedJpeg(buffer: Buffer): Buffer | undefined {
  let best: Buffer | undefined;
  let index = 0;
  while (index < buffer.length - 4) {
    index = buffer.indexOf(0xff, index);
    if (index < 0 || index >= buffer.length - 4) break;
    if (buffer[index + 1] === 0xd8 && buffer[index + 2] === 0xff) {
      const marker = buffer[index + 3];
      if ((marker >= 0xe0 && marker <= 0xef) ||
        marker === 0xdb || marker === 0xc0 || marker === 0xc4 || marker === 0xfe) {
        const end = jpegEnd(buffer, index + 2);
        if (end > index) {
          if (!best || end + 2 - index > best.length) best = buffer.subarray(index, end + 2);
          index = end + 2;
          continue;
        }
      }
    }
    index++;
  }
  return best;
}

async function extractEmbeddedJpeg(filePath: string): Promise<Buffer> {
  const fileSize = Number((await stat(filePath)).size);
  const bytesToRead = Math.min(fileSize, MAX_RAW_SCAN_BYTES);
  const bytes = Buffer.alloc(bytesToRead);
  const handle = await open(filePath, 'r');
  try {
    await handle.read(bytes, 0, bytesToRead, 0);
  } finally {
    await handle.close();
  }
  const jpeg = largestEmbeddedJpeg(bytes);
  if (!jpeg) throw new Error(`no embedded JPEG found in first ${bytesToRead} RAW bytes`);
  // Copy away from the complete RAW scan allocation before tensor work.
  return Buffer.from(jpeg);
}

function rgbToDetectorCHW(rgb: Uint8Array): Float32Array {
  const count = 640 * 480;
  const output = new Float32Array(count * 3);
  for (let pixel = 0, source = 0; pixel < count; pixel++, source += 3) {
    output[pixel] = (rgb[source] - 127) / 128;
    output[count + pixel] = (rgb[source + 1] - 127) / 128;
    output[count * 2 + pixel] = (rgb[source + 2] - 127) / 128;
  }
  return output;
}

function rgbaToPlatformBitmap(rgba: Uint8Array, order: 'bgra' | 'rgba'): Uint8Array {
  if (order === 'rgba') return rgba;
  for (let index = 0; index < rgba.length; index += 4) {
    const red = rgba[index];
    rgba[index] = rgba[index + 2];
    rgba[index + 2] = red;
  }
  return rgba;
}

async function personTensor(root: ReturnType<typeof sharp>, dimension: number) {
  const { data, info } = await root.clone()
    .resize({ width: dimension, height: dimension, fit: 'inside', withoutEnlargement: true })
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

async function nanoDetTensor(
  root: ReturnType<typeof sharp>,
  sourceWidth: number,
  sourceHeight: number,
) {
  const targetWidth = 416 as const;
  const targetHeight = 416 as const;
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const resizedWidth = Math.max(1, Math.min(targetWidth, Math.round(sourceWidth * scale)));
  const resizedHeight = Math.max(1, Math.min(targetHeight, Math.round(sourceHeight * scale)));
  const padLeft = Math.floor((targetWidth - resizedWidth) / 2);
  const padTop = Math.floor((targetHeight - resizedHeight) / 2);
  const { data: rgb } = await root.clone()
    .resize(resizedWidth, resizedHeight, { fit: 'fill', kernel: 'lanczos3' })
    .removeAlpha()
    .toColourspace('srgb')
    .extend({
      top: padTop,
      bottom: targetHeight - resizedHeight - padTop,
      left: padLeft,
      right: targetWidth - resizedWidth - padLeft,
      background: { r: 0, g: 0, b: 0 },
    })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const plane = targetWidth * targetHeight;
  const chw = new Float32Array(plane * 3);
  const means = [103.53, 116.28, 123.675] as const;
  const deviations = [57.375, 57.12, 58.395] as const;
  for (let pixel = 0; pixel < plane; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      chw[channel * plane + pixel] = (rgb[pixel * 3 + channel] - means[channel]) / deviations[channel];
    }
  }
  return {
    data: chw, sourceWidth, sourceHeight, targetWidth, targetHeight,
    resizedWidth, resizedHeight, padLeft, padTop,
  };
}

async function yuNetTensor(
  root: ReturnType<typeof sharp>,
  sourceWidth: number,
  sourceHeight: number,
) {
  const targetWidth = 640 as const;
  const targetHeight = 640 as const;
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const resizedWidth = Math.max(1, Math.min(targetWidth, Math.round(sourceWidth * scale)));
  const resizedHeight = Math.max(1, Math.min(targetHeight, Math.round(sourceHeight * scale)));
  const padLeft = Math.floor((targetWidth - resizedWidth) / 2);
  const padTop = Math.floor((targetHeight - resizedHeight) / 2);
  const rgb = await root.clone()
    .resize(resizedWidth, resizedHeight, { fit: 'fill', kernel: 'lanczos3' })
    .removeAlpha()
    .toColourspace('srgb')
    .extend({
      top: padTop,
      bottom: targetHeight - resizedHeight - padTop,
      left: padLeft,
      right: targetWidth - resizedWidth - padLeft,
      background: { r: 0, g: 0, b: 0 },
    })
    .raw()
    .toBuffer();
  const plane = targetWidth * targetHeight;
  const chw = new Float32Array(plane * 3);
  // OpenCV FaceDetectorYN consumes BGR float pixels at their 0..255 scale.
  for (let pixel = 0; pixel < plane; pixel++) {
    chw[pixel] = rgb[pixel * 3 + 2];
    chw[plane + pixel] = rgb[pixel * 3 + 1];
    chw[plane * 2 + pixel] = rgb[pixel * 3];
  }
  return {
    data: chw, sourceWidth, sourceHeight, targetWidth, targetHeight,
    resizedWidth, resizedHeight, padLeft, padTop,
  };
}

async function prepare(request: WorkerRequest): Promise<void> {
  let currentStage = 'open';
  try {
    stage(request, currentStage);
    // sequentialRead enables libjpeg's shrink-on-load path for JPEG inputs.
    // limitInputPixels prevents malformed headers from allocating unbounded RAM.
    const encodedInput = request.extractEmbeddedJpeg
      ? await extractEmbeddedJpeg(request.sourcePath ?? request.imagePath)
      : request.inputBuffer
      ? Buffer.from(request.inputBuffer.buffer, request.inputBuffer.byteOffset, request.inputBuffer.byteLength)
      : request.sourcePath ?? request.imagePath;
    const opened = sharp(encodedInput, {
      failOn: 'error',
      sequentialRead: true,
      limitInputPixels: 180_000_000,
    });
    currentStage = 'metadata';
    stage(request, currentStage);
    const metadata = await opened.metadata();
    if (!metadata.width || !metadata.height) throw new Error('image dimensions are unavailable');
    const effectiveOrientation = sourcePixelOrientation(
      request.orientation,
      typeof metadata.orientation === 'number' ? metadata.orientation : undefined,
      request.useSourceOrientation === true,
    );
    const swapsAxes = effectiveOrientation >= 5 && effectiveOrientation <= 8;
    const sourceWidth = swapsAxes ? metadata.height : metadata.width;
    const sourceHeight = swapsAxes ? metadata.width : metadata.height;

    currentStage = 'decode-resize';
    stage(request, currentStage);
    const root = orientedPipeline(sharp(encodedInput, {
      failOn: 'error', sequentialRead: true, limitInputPixels: 180_000_000,
    }), effectiveOrientation);
    const plan = imagePreprocessPlan(request);
    const detectorPromise = plan.detector
      ? root.clone()
        .resize({ width: 640, height: 480, fit: 'fill' })
        .toColourspace('srgb')
        .removeAlpha()
        .raw()
        .toBuffer()
      : Promise.resolve(undefined);
    const surfacePromise = plan.surface
      ? root.clone()
        .resize({
          width: request.analysisMaxDimension ?? 1024,
          height: request.analysisMaxDimension ?? 1024,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .toColourspace('srgb')
        .ensureAlpha(1)
        .raw()
        .toBuffer({ resolveWithObject: true })
      : Promise.resolve(undefined);
    const fastPersonPromise = plan.fastPerson ? personTensor(root, 320) : Promise.resolve(undefined);
    const nanoDetPromise = plan.nanoDet
      ? nanoDetTensor(root, sourceWidth, sourceHeight)
      : Promise.resolve(undefined);
    const yuNetPromise = plan.yuNet
      ? yuNetTensor(root, sourceWidth, sourceHeight)
      : Promise.resolve(undefined);
    const [detectorRgb, surface, fastPerson, nanoDet, yuNet] = await Promise.all([
      detectorPromise, surfacePromise, fastPersonPromise, nanoDetPromise, yuNetPromise,
    ]);

    currentStage = 'tensor-pack';
    stage(request, currentStage);
    const detectorCHW = detectorRgb ? rgbToDetectorCHW(detectorRgb) : new Float32Array(0);
    const payload = {
      detectorCHW,
      sourceWidth,
      sourceHeight,
      ...(surface ? {
        surfaceBitmap: rgbaToPlatformBitmap(new Uint8Array(surface.data), request.bitmapOrder),
        surfaceWidth: surface.info.width,
        surfaceHeight: surface.info.height,
      } : {}),
      ...(fastPerson ? { fastPerson } : {}),
      ...(nanoDet ? { nanoDet } : {}),
      ...(yuNet ? { yuNet } : {}),
    };
    currentStage = 'complete';
    stage(request, currentStage);
    send({ type: 'result', id: request.id, imagePath: request.imagePath, payload });
  } catch (error) {
    send({
      type: 'error', id: request.id, imagePath: request.imagePath, stage: currentStage,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

parentPort.on('message', (event) => {
  const request = event.data;
  if (request?.type === 'prepare') void prepare(request);
});
send({ type: 'ready' });
