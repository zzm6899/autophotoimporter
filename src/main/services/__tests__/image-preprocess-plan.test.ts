import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  imagePreprocessPlan,
  sharpOrientationOperations,
  sourcePixelOrientation,
} from '../image-preprocess-plan';

describe('image preprocess work plan', () => {
  it('omits NanoDet packing from the default subjects path', () => {
    expect(imagePreprocessPlan({
      includeDetectorTensor: false,
      includeAnalysisSurface: true,
      includePersonTensors: true,
      includeNanoDetTensor: false,
    })).toEqual({ detector: false, surface: true, fastPerson: true, nanoDet: false });
  });

  it('adds NanoDet only for an explicitly installed sports fallback', () => {
    expect(imagePreprocessPlan({
      includeDetectorTensor: true,
      includeAnalysisSurface: true,
      includePersonTensors: true,
      includeNanoDetTensor: true,
    }).nanoDet).toBe(true);
  });
});

describe('Sharp EXIF orientation operations', () => {
  it('uses original O6/O8 for stored pixels but an embedded preview own O1 exactly once', () => {
    expect(sourcePixelOrientation(6, 6, false)).toBe(6);
    expect(sourcePixelOrientation(8, undefined, true)).toBe(8);
    expect(sourcePixelOrientation(6, 1, true)).toBe(1);
    expect(sourcePixelOrientation(8, 1, true)).toBe(1);
  });

  it.each([
    [1, 2, 3, [1, 2, 3, 4, 5, 6]],
    [2, 2, 3, [2, 1, 4, 3, 6, 5]],
    [3, 2, 3, [6, 5, 4, 3, 2, 1]],
    [4, 2, 3, [5, 6, 3, 4, 1, 2]],
    [5, 3, 2, [1, 3, 5, 2, 4, 6]],
    [6, 3, 2, [5, 3, 1, 6, 4, 2]],
    [7, 3, 2, [6, 4, 2, 5, 3, 1]],
    [8, 3, 2, [2, 4, 6, 1, 3, 5]],
  ] as const)('maps orientation %i to upright pixels', async (
    orientation, expectedWidth, expectedHeight, expected,
  ) => {
    let pipeline = sharp(Buffer.from([1, 2, 3, 4, 5, 6]), {
      raw: { width: 2, height: 3, channels: 1 },
    });
    for (const operation of sharpOrientationOperations(orientation)) {
      if (operation === 'rotate90') pipeline = pipeline.rotate(90);
      else if (operation === 'rotate180') pipeline = pipeline.rotate(180);
      else if (operation === 'rotate270') pipeline = pipeline.rotate(270);
      else if (operation === 'flip') pipeline = pipeline.flip();
      else pipeline = pipeline.flop();
    }
    const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([expectedWidth, expectedHeight]);
    expect(Array.from({ length: info.width * info.height }, (_, index) => data[index * info.channels]))
      .toEqual(expected);
  });
});
