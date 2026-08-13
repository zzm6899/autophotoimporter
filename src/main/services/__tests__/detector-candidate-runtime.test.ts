import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import type { DetectorCandidateModel } from '../detector-model-manifest';
import {
  DetectorCandidateRuntime,
  candidateSessionOptions,
  decodeNanoDetPersons,
  decodeYuNet,
  prepareCandidateInput,
  scoreDetections,
  type CandidateOutputs,
  type LetterboxTransform,
} from '../detector-candidate-runtime';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function transform(size = 32): LetterboxTransform {
  return {
    sourceWidth: size,
    sourceHeight: size,
    targetWidth: size,
    targetHeight: size,
    resizedWidth: size,
    resizedHeight: size,
    padLeft: 0,
    padTop: 0,
  };
}

function fill(length: number, value: number): Float32Array {
  const data = new Float32Array(length);
  data.fill(value);
  return data;
}

function yunetOutputs(size = 32): Record<string, { data: Float32Array; dims: number[] }> {
  const outputs: Record<string, { data: Float32Array; dims: number[] }> = {};
  for (const stride of [8, 16, 32]) {
    const locations = (size / stride) ** 2;
    outputs[`cls_${stride}`] = { data: fill(locations, 0.01), dims: [1, locations, 1] };
    outputs[`obj_${stride}`] = { data: fill(locations, 0.01), dims: [1, locations, 1] };
    outputs[`bbox_${stride}`] = { data: fill(locations * 4, 0.01), dims: [1, locations, 4] };
    outputs[`kps_${stride}`] = { data: fill(locations * 10, 0.01), dims: [1, locations, 10] };
  }
  return outputs;
}

function nanodetOutputs(size = 32): Record<string, { data: Float32Array; dims: number[] }> {
  const outputs: Record<string, { data: Float32Array; dims: number[] }> = {};
  let name = 100;
  for (const stride of [8, 16, 32]) {
    const locations = (size / stride) ** 2;
    outputs[String(name++)] = { data: fill(locations * 80, 0.001), dims: [1, locations, 80] };
    outputs[String(name++)] = { data: fill(locations * 32, -20), dims: [1, locations, 32] };
  }
  return outputs;
}

describe('candidate detector preprocessing', () => {
  it('uses the same explicit DirectML adapter selected by the face engine', () => {
    expect(candidateSessionOptions('dml', 16, { dmlDeviceId: 2 })).toMatchObject({
      executionProviders: [{ name: 'dml', deviceId: 2 }],
      executionMode: 'sequential',
      intraOpNumThreads: 1,
    });
    expect(candidateSessionOptions('dml', 16)).toMatchObject({
      executionProviders: [{ name: 'dml' }],
    });
  });

  it('auto-orients, centre-letterboxes, and writes YuNet BGR planes from real pixels', async () => {
    const pixels = Buffer.from([
      10, 20, 30, 40, 50, 60,
      70, 80, 90, 100, 110, 120,
    ]);
    const image = await sharp(pixels, { raw: { width: 2, height: 2, channels: 3 } })
      .png()
      .toBuffer();
    const candidate = {
      id: 'fixture-yunet',
      decoder: 'yunet-v1',
      input: {
        type: 'float32',
        layout: 'nchw',
        dimensions: [1, 3, 4, 8],
        colourOrder: 'bgr',
        resize: 'letterbox',
      },
    } as unknown as Pick<DetectorCandidateModel, 'id' | 'input' | 'decoder'>;

    const prepared = await prepareCandidateInput(image, candidate);

    expect(prepared.transform).toEqual({
      sourceWidth: 2,
      sourceHeight: 2,
      targetWidth: 8,
      targetHeight: 4,
      resizedWidth: 4,
      resizedHeight: 4,
      padLeft: 2,
      padTop: 0,
    });
    const plane = 32;
    expect(prepared.data[0]).toBe(0); // left padding
    expect(prepared.data[2]).toBeGreaterThan(20); // B plane from the first source pixel
    expect(prepared.data[plane + 2]).toBeGreaterThan(10); // G plane
    expect(prepared.data[plane * 2 + 2]).toBeGreaterThan(0); // R plane
  });

  it('applies the pinned NanoDet channel normalisation to non-zero image pixels', async () => {
    const image = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 104, g: 116, b: 124 } },
    }).png().toBuffer();
    const candidate = {
      id: 'fixture-nanodet',
      decoder: 'nanodet-plus-gfl-v1',
      input: {
        type: 'float32',
        layout: 'nchw',
        dimensions: [1, 3, 2, 2],
        colourOrder: 'rgb',
        resize: 'letterbox',
      },
    } as unknown as Pick<DetectorCandidateModel, 'id' | 'input' | 'decoder'>;

    const prepared = await prepareCandidateInput(image, candidate);

    expect(prepared.data[0]).toBeCloseTo((104 - 103.53) / 57.375, 5);
    expect(prepared.data[4]).toBeCloseTo((116 - 116.28) / 57.12, 5);
    expect(prepared.data[8]).toBeCloseTo((124 - 123.675) / 58.395, 5);
  });
});

describe('YuNet raw output decoder', () => {
  it('decodes non-zero boxes and five landmarks, then suppresses an overlapping box', () => {
    const outputs = yunetOutputs();
    const primary = 1 * 4 + 2;
    outputs.cls_8.data[primary] = 0.81;
    outputs.obj_8.data[primary] = 0.81;
    outputs.bbox_8.data.set([0.5, 0.5, Math.log(2), Math.log(2)], primary * 4);
    outputs.kps_8.data.set([
      0.25, 0.25, 0.75, 0.25, 0.5, 0.5, 0.3, 0.75, 0.7, 0.75,
    ], primary * 10);

    const overlapping = 0 * 4 + 1;
    outputs.cls_8.data[overlapping] = 0.64;
    outputs.obj_8.data[overlapping] = 0.64;
    outputs.bbox_8.data.set([1.5, 1.5, Math.log(2), Math.log(2)], overlapping * 4);

    const decoded = decodeYuNet(outputs as CandidateOutputs, transform(), { scoreThreshold: 0.6 });

    expect(decoded).toHaveLength(1);
    expect(decoded[0].x).toBeCloseTo(0.375, 6);
    expect(decoded[0].y).toBeCloseTo(0.125, 6);
    expect(decoded[0].width).toBeCloseTo(0.5, 6);
    expect(decoded[0].height).toBeCloseTo(0.5, 6);
    expect(decoded[0].score).toBeCloseTo(0.81, 6);
    expect(decoded[0].landmarks).toHaveLength(5);
    expect(decoded[0].landmarks?.[0]).toEqual({ x: 0.5625, y: 0.3125 });
  });

  it('fails closed when a raw output head has an unexpected shape', () => {
    const outputs = yunetOutputs();
    outputs.cls_8.data = new Float32Array(15);
    expect(() => decodeYuNet(outputs as CandidateOutputs, transform())).toThrow('output shape');
  });
});

describe('NanoDet person decoder', () => {
  it('decodes a non-zero class-0 GFL distribution into the expected person box', () => {
    const outputs = nanodetOutputs();
    const classHead = outputs['100'].data;
    const boxHead = outputs['101'].data;
    const location = 1 * 4 + 1;
    classHead[location * 80] = 0.9;
    for (let side = 0; side < 4; side++) boxHead[location * 32 + side * 8 + 1] = 20;

    const decoded = decodeNanoDetPersons(outputs as CandidateOutputs, transform());

    expect(decoded).toHaveLength(1);
    expect(decoded[0].classId).toBe(0);
    expect(decoded[0].score).toBeCloseTo(0.9, 6);
    expect(decoded[0].x).toBeCloseTo(3.5 / 32, 5);
    expect(decoded[0].y).toBeCloseTo(3.5 / 32, 5);
    expect(decoded[0].width).toBeCloseTo(16 / 32, 5);
    expect(decoded[0].height).toBeCloseTo(16 / 32, 5);
  });

  it('requires person to be the top class unless explicitly configured otherwise', () => {
    const outputs = nanodetOutputs();
    outputs['100'].data[0] = 0.8;
    outputs['100'].data[1] = 0.9;
    for (let side = 0; side < 4; side++) outputs['101'].data[side * 8 + 1] = 20;

    expect(decodeNanoDetPersons(outputs as CandidateOutputs, transform())).toHaveLength(0);
    expect(decodeNanoDetPersons(outputs as CandidateOutputs, transform(), { requireTopClass: false })).toHaveLength(1);
  });
});

describe('candidate accuracy metrics and safety gates', () => {
  it('scores confidence-ordered IoU matches without matching a label twice', () => {
    const metrics = scoreDetections([
      { x: 0.1, y: 0.1, width: 0.3, height: 0.3, score: 0.9 },
      { x: 0.11, y: 0.11, width: 0.3, height: 0.3, score: 0.8 },
    ], [
      { x: 0.1, y: 0.1, width: 0.3, height: 0.3 },
      { x: 0.6, y: 0.6, width: 0.2, height: 0.2 },
    ]);

    expect(metrics).toEqual({
      truePositives: 1,
      falsePositives: 1,
      falseNegatives: 1,
      precision: 0.5,
      recall: 0.5,
      f1: 0.5,
    });
  });

  it('rejects an unverified model before ONNX Runtime can load it', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'keptra-candidate-runtime-'));
    tempDirs.push(directory);
    const modelPath = path.join(directory, 'candidate.onnx');
    const payload = Buffer.from('not-an-onnx-model');
    await writeFile(modelPath, payload);
    const candidate = {
      id: 'yunet-2023mar-fp32',
      decoder: 'yunet-v1',
      bytes: payload.length,
      sha256: createHash('sha256').update('different').digest('hex'),
    } as DetectorCandidateModel;

    await expect(DetectorCandidateRuntime.create(candidate, modelPath, 'cpu'))
      .rejects.toThrow('SHA-256 mismatch');
  });

  it('does not claim an unfinished YOLOX decoder is runnable', async () => {
    const candidate = { id: 'yolox-s-2022nov-fp32', decoder: 'yolox-v1' } as DetectorCandidateModel;
    await expect(DetectorCandidateRuntime.create(candidate, 'unused.onnx', 'cpu'))
      .rejects.toThrow('YOLOX-S decoding is not implemented');
  });
});
