import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

vi.mock('electron', () => ({
  app: {
    getPath: () => process.env.TEMP ?? 'C:\\Temp',
  },
  nativeImage: {},
}));

import { clearThumbnailMemCache, getDetectionPixels, jpegDimensions } from '../exif-parser';

const tempDirs: string[] = [];

afterEach(async () => {
  clearThumbnailMemCache();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })));
});

describe('detector thumbnail preprocessing', () => {
  it('decodes a scanner thumbnail to fixed RGB pixels off the nativeImage path', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'keptra-detector-preprocess-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'unique-camera-frame.jpg');
    await sharp({
      create: {
        width: 1200,
        height: 800,
        channels: 3,
        background: { r: 24, g: 96, b: 180 },
      },
    }).jpeg({ quality: 88 }).toFile(filePath);

    const result = await getDetectionPixels(filePath, 640, 480);

    expect(result).toBeDefined();
    expect(result).toMatchObject({
      width: 640,
      height: 480,
      channels: 3,
      sourceWidth: 1200,
    });
    expect(result?.sourceHeight).toBe(800);
    expect(result?.data).toHaveLength(640 * 480 * 3);
  });

  it('reads thumbnail dimensions from JPEG headers without a pixel decode', async () => {
    const jpeg = await sharp({
      create: {
        width: 731,
        height: 487,
        channels: 3,
        background: { r: 16, g: 32, b: 48 },
      },
    }).jpeg().toBuffer();

    expect(jpegDimensions(jpeg)).toEqual({ width: 731, height: 487 });
    expect(jpegDimensions(Buffer.from('not-a-jpeg'))).toBeUndefined();
  });

  it('rejects invalid target sizes without attempting a decode', async () => {
    await expect(getDetectionPixels('/does/not/exist.jpg', 0, 480)).resolves.toBeUndefined();
    await expect(getDetectionPixels('/does/not/exist.jpg', 640, 5000)).resolves.toBeUndefined();
  });
});
