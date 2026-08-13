import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp',
  },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true }),
    createFromBuffer: () => ({ isEmpty: () => true }),
    createFromBitmap: () => ({ isEmpty: () => false }),
  },
}));

vi.mock('exifr', () => ({
  default: {
    parse: vi.fn().mockResolvedValue(null),
    thumbnail: vi.fn().mockResolvedValue(null),
  },
}));

import {
  choosePreferredProvider,
  estimateEyeDetailFromPixels,
  mapBoxToStoredOrientation,
  orientBitmapForExif,
  pixelsToSFaceCHW,
  shouldRefinePersonDetection,
  verifyModelFileDigest,
} from '../face-engine';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('face-engine provider planning', () => {
  it('uses DirectML on Windows when benchmarked faster', () => {
    expect(choosePreferredProvider({
      model: 'detector',
      gpuEnabled: true,
      platform: 'win32',
      cpuAvgMs: 18,
      dmlAvgMs: 2,
    })).toEqual({ provider: 'dml' });
  });

  it('falls back to CPU when DirectML is slower', () => {
    const choice = choosePreferredProvider({
      model: 'embedder',
      gpuEnabled: true,
      platform: 'win32',
      cpuAvgMs: 4,
      dmlAvgMs: 5,
    });
    expect(choice.provider).toBe('cpu');
    expect(choice.fallbackReason).toContain('not faster');
  });

  it('keeps person detection on CPU', () => {
    const choice = choosePreferredProvider({
      model: 'person',
      gpuEnabled: true,
      platform: 'win32',
      cpuAvgMs: 16,
      dmlAvgMs: 2,
    });
    expect(choice.provider).toBe('cpu');
    expect(choice.fallbackReason).toContain('person detector');
  });

  it('falls back to CPU when DirectML fails', () => {
    const choice = choosePreferredProvider({
      model: 'detector',
      gpuEnabled: true,
      platform: 'win32',
      cpuAvgMs: 12,
      dmlError: 'DML provider unavailable',
    });
    expect(choice).toEqual({ provider: 'cpu', fallbackReason: 'DML provider unavailable' });
  });
});

describe('face-engine eye detail', () => {
  function rgbaFixture(width = 96, height = 96): Uint8Array {
    const pixels = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      pixels[i * 4] = 128;
      pixels[i * 4 + 1] = 128;
      pixels[i * 4 + 2] = 128;
      pixels[i * 4 + 3] = 255;
    }
    return pixels;
  }

  function addDetail(pixels: Uint8Array, left: number, right: number, width = 96): void {
    for (let y = 23; y < 50; y++) {
      for (let x = left; x < right; x++) {
        const value = (x + y) % 4 < 2 ? 24 : 232;
        const index = (y * width + x) * 4;
        pixels[index] = value;
        pixels[index + 1] = value;
        pixels[index + 2] = value;
      }
    }
  }

  it('marks both expected eye regions usable when they contain local detail', () => {
    const pixels = rgbaFixture();
    addDetail(pixels, 10, 45);
    addDetail(pixels, 51, 86);
    const result = estimateEyeDetailFromPixels(pixels, 96, 96, false);
    expect(result.eyeScore).toBe(2);
    expect(result.eyeSharpness).toBeGreaterThan(0.5);
  });

  it('keeps smooth face crops out of eye-quality scoring', () => {
    expect(estimateEyeDetailFromPixels(rgbaFixture(), 96, 96, false)).toEqual({
      eyeScore: 0,
      eyeSharpness: 0,
    });
  });

  it('returns a safe empty result for undersized crops', () => {
    expect(estimateEyeDetailFromPixels(new Uint8Array(12 * 12 * 4), 12, 12, false)).toEqual({
      eyeScore: 0,
      eyeSharpness: 0,
    });
  });
});

describe('face-engine EXIF orientation', () => {
  function markerBitmap(markers: number[]): Uint8Array {
    const pixels = new Uint8Array(markers.length * 4);
    markers.forEach((marker, index) => {
      pixels[index * 4] = marker;
      pixels[index * 4 + 3] = 255;
    });
    return pixels;
  }

  function markersFrom(pixels: Uint8Array): number[] {
    return Array.from({ length: pixels.length / 4 }, (_, index) => pixels[index * 4]);
  }

  it.each([
    [1, 2, 3, [1, 2, 3, 4, 5, 6]],
    [2, 2, 3, [2, 1, 4, 3, 6, 5]],
    [3, 2, 3, [6, 5, 4, 3, 2, 1]],
    [4, 2, 3, [5, 6, 3, 4, 1, 2]],
    [5, 3, 2, [1, 3, 5, 2, 4, 6]],
    [6, 3, 2, [5, 3, 1, 6, 4, 2]],
    [7, 3, 2, [6, 4, 2, 5, 3, 1]],
    [8, 3, 2, [2, 4, 6, 1, 3, 5]],
  ])('normalizes stored pixels for EXIF orientation %i', (
    orientation,
    expectedWidth,
    expectedHeight,
    expectedMarkers,
  ) => {
    const result = orientBitmapForExif(
      markerBitmap([1, 2, 3, 4, 5, 6]),
      2,
      3,
      orientation,
    );
    expect({ width: result.width, height: result.height }).toEqual({
      width: expectedWidth,
      height: expectedHeight,
    });
    expect(markersFrom(result.data)).toEqual(expectedMarkers);
  });

  it('handles bitmap views whose byte offset is not word-aligned', () => {
    const backing = new Uint8Array(1 + 2 * 2 * 4);
    backing.set(markerBitmap([1, 2, 3, 4]), 1);
    const result = orientBitmapForExif(backing.subarray(1), 2, 2, 3);
    expect(markersFrom(result.data)).toEqual([4, 3, 2, 1]);
  });

  it('maps upright boxes back to stored coordinates for existing overlays', () => {
    const mapped = mapBoxToStoredOrientation({
      x: 0.2,
      y: 0.3,
      width: 0.1,
      height: 0.2,
      score: 0.9,
      eyeScore: 2,
    }, 6);
    expect(mapped.x).toBeCloseTo(0.3);
    expect(mapped.y).toBeCloseTo(0.7);
    expect(mapped.width).toBeCloseTo(0.2);
    expect(mapped.height).toBeCloseTo(0.1);
    expect(mapped.eyeScore).toBe(2);
  });
});

describe('face-engine adaptive person pass', () => {
  const box = { x: 0.2, y: 0.1, width: 0.3, height: 0.8, score: 0.9 };

  it('keeps an ordinary single-subject frame on the fast pass', () => {
    expect(shouldRefinePersonDetection({
      width: 1200,
      height: 800,
      faceBoxes: [{ ...box, width: 0.1, height: 0.15 }],
      fastBoxes: [box],
      candidateCount: 1,
      sportsMode: false,
    })).toBe(false);
  });

  it('refines group frames when the fast body count trails face evidence', () => {
    expect(shouldRefinePersonDetection({
      width: 1200,
      height: 800,
      faceBoxes: [box, { ...box, x: 0.6 }],
      fastBoxes: [box],
      candidateCount: 2,
      sportsMode: false,
    })).toBe(true);
  });

  it('does not spend a second sports pass on an empty frame', () => {
    expect(shouldRefinePersonDetection({
      width: 2400,
      height: 800,
      faceBoxes: [],
      fastBoxes: [],
      candidateCount: 0,
      sportsMode: true,
    })).toBe(false);
  });
});

describe('face-engine model integrity', () => {
  it('matches OpenCV SFace raw RGB input preprocessing', () => {
    // Electron returns BGRA on Windows/macOS and RGBA on Linux.
    const input = Buffer.from([10, 20, 30, 255, 40, 50, 60, 255]);
    const chw = pixelsToSFaceCHW(input, 2, 1);
    const bgra = process.platform === 'win32' || process.platform === 'darwin';
    expect(Array.from(chw)).toEqual(bgra
      ? [30, 60, 20, 50, 10, 40]
      : [10, 40, 20, 50, 30, 60]);
  });

  it('accepts the pinned digest and rejects a different digest', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'keptra-model-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'model.onnx');
    const content = Buffer.from('known model bytes');
    await writeFile(file, content);
    const digest = createHash('sha256').update(content).digest('hex');

    await expect(verifyModelFileDigest(file, digest)).resolves.toBe(true);
    await expect(verifyModelFileDigest(file, '0'.repeat(64))).resolves.toBe(false);
  });
});
