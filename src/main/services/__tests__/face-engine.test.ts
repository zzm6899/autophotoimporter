import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const previewMocks = vi.hoisted(() => ({
  peek: vi.fn(async (filePath: string) =>
    filePath.endsWith('.raw') ? '/cache/generated-preview.jpg' : undefined),
  thumbnailPeek: vi.fn<() => Promise<
    | { kind: 'file'; diskPath: string }
    | { kind: 'buffer'; buffer: Buffer; persisted: boolean }
    | undefined
  >>(async () => undefined),
}));

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

vi.mock('../exif-parser', async (importOriginal) => {
  const original = await importOriginal<typeof import('../exif-parser')>();
  return {
    ...original,
    peekPreviewFile: previewMocks.peek,
    peekThumbnailPayload: previewMocks.thumbnailPeek,
  };
});

vi.mock('exifr', () => ({
  default: {
    parse: vi.fn().mockResolvedValue(null),
    thumbnail: vi.fn().mockResolvedValue(null),
  },
}));

import {
  annotateEyeDetail,
  analysisSurfaceCacheKey,
  alignFaceBitmapForSFace,
  canReuseAnalysisSurfaceForRequest,
  canProductionFastBundleMutateRoute,
  choosePreferredProvider,
  estimateEyeDetailFromPixels,
  getFaceFeatureOptions,
  getFaceAnalysisResumePlan,
  getAnalysisSurfaceCacheDiagnostics,
  resolvePreprocessSource,
  isUsableDetectionPreviewSize,
  mapBoxToStoredOrientation,
  mapLandmarksToStoredForExif,
  mergeFastFacesWithLegacy,
  orientBitmapForExif,
  pixelsToSFaceCHW,
  PRODUCTION_NANODET_DECODE_PROFILE,
  productionFastFailurePlan,
  productionPersonDetectorId,
  productionNanoDetPersonPass,
  shouldRefinePersonDetection,
  shouldUseLegacyDetectorFallback,
  shouldResumePersonFallback,
  shouldResumeSportsSafeguards,
  shouldAttemptProductionFastRoute,
  verifyModelFileDigest,
} from '../face-engine';

const tempDirs: string[] = [];

function jpegHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(23);
  buffer.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  buffer.set([0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9], 11);
  return buffer;
}

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

describe('face-engine request profiles', () => {
  it('makes detect mode detector-only without mutating global settings', () => {
    expect(getFaceFeatureOptions('detect')).toEqual({
      faceMatching: false,
      personDetection: false,
      poseAnalysis: false,
      embeddingLimit: 0,
    });
    expect(getFaceFeatureOptions()).toEqual(expect.objectContaining({
      faceMatching: true,
      personDetection: true,
    }));
  });

  it('keeps subject detection but omits identity and pose work in subjects mode', () => {
    expect(getFaceFeatureOptions('subjects')).toEqual({
      faceMatching: false,
      personDetection: true,
      poseAnalysis: false,
      embeddingLimit: 0,
    });
  });

  it('turns a completed subjects result into enrichment-only full work', () => {
    const seed = {
      boxes: [{ x: 0.2, y: 0.2, width: 0.1, height: 0.2, score: 0.9, eyeScore: 2 }],
      personBoxes: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.8, score: 0.9 }],
      embeddings: [],
      features: {
        faceMatching: false,
        personDetection: true,
        poseAnalysis: false,
        embeddingLimit: 0,
        eyeDetail: true,
      },
    };
    expect(getFaceAnalysisResumePlan('full', seed)).toEqual({
      faceDetection: false,
      personDetection: false,
      eyeDetail: false,
      faceMatching: true,
      // Depends on the global pose setting; it is disabled in this fixture.
      poseAnalysis: false,
    });
    expect(seed.boxes[0].eyeScore).toBe(2);
  });

  it('resumes only the missing sports person fallback without repeating SSD', () => {
    const seed = {
      boxes: [{ x: 0.4, y: 0.2, width: 0.12, height: 0.18, score: 0.95 }],
      personBoxes: [],
      embeddings: [],
      features: {
        faceMatching: false, personDetection: true, poseAnalysis: false,
        embeddingLimit: 0, eyeDetail: true,
      },
    };
    expect(shouldResumePersonFallback(seed, true, true)).toBe(true);
    expect(getFaceAnalysisResumePlan('subjects', seed).personDetection).toBe(false);
    expect(shouldResumePersonFallback({
      ...seed, features: { ...seed.features, personFallback: true },
    }, true, true)).toBe(false);
    expect(shouldResumeSportsSafeguards(seed, true)).toBe(true);
    expect(shouldResumeSportsSafeguards({
      ...seed, features: { ...seed.features, sportsSafeguards: true },
    }, true)).toBe(false);
  });

  it('accepts scanner-sized previews but rejects tiny thumbnails for screening', () => {
    expect(isUsableDetectionPreviewSize(320, 213)).toBe(true);
    expect(isUsableDetectionPreviewSize(240, 120)).toBe(true);
    expect(isUsableDetectionPreviewSize(160, 120)).toBe(false);
    expect(isUsableDetectionPreviewSize(0, 320)).toBe(false);
  });

  it('exposes a bounded reusable analysis-surface budget', () => {
    const diagnostics = getAnalysisSurfaceCacheDiagnostics();
    expect(diagnostics.maxEntries).toBe(64);
    expect(diagnostics.maxBytes).toBe(256 * 1024 * 1024);
    expect(diagnostics.bytes).toBeLessThanOrEqual(diagnostics.maxBytes);
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

  it('keeps eye detail incomplete when any eligible crop fails', async () => {
    const boxes = [
      { x: 0.1, y: 0.1, width: 0.25, height: 0.3, score: 0.95 },
      { x: 0.55, y: 0.1, width: 0.25, height: 0.3, score: 0.94 },
    ];
    let cropCount = 0;
    const bitmap = Buffer.alloc(96 * 96 * 4, 128);
    const image = {
      getSize: () => ({ width: 400, height: 300 }),
      crop: () => {
        cropCount++;
        if (cropCount === 2) throw new Error('native crop failed');
        return {
          resize: () => ({ toBitmap: () => bitmap }),
        };
      },
    } as unknown as Electron.NativeImage;

    const result = await annotateEyeDetail(image, boxes);
    expect(result).toMatchObject({ complete: false, eligibleCount: 2, completedCount: 1 });
    expect(result.boxes).toHaveLength(2);
    expect(result.boxes[0].eyeScore).toBeDefined();
    expect(result.boxes[1].eyeScore).toBeUndefined();
  });

  it('marks eye detail complete when no face is eligible for sampling', async () => {
    const tiny = [{ x: 0.1, y: 0.1, width: 0.02, height: 0.02, score: 0.9 }];
    const image = {
      getSize: () => ({ width: 400, height: 300 }),
    } as unknown as Electron.NativeImage;
    await expect(annotateEyeDetail(image, tiny)).resolves.toMatchObject({
      complete: true, eligibleCount: 0, completedCount: 0,
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

  it.each([6, 8] as const)('retains orientation %i for direct source preprocessing', async (orientation) => {
    await expect(resolvePreprocessSource('/photos/frame.jpg', orientation)).resolves.toEqual({
      sourcePath: '/photos/frame.jpg',
      orientation,
      sourceKind: 'original',
    });
  });

  it('uses the scanner thumbnail before reopening a full-size JPEG for detector-only review', async () => {
    const thumbnail = jpegHeader(320, 213);
    previewMocks.thumbnailPeek.mockResolvedValueOnce({
      kind: 'buffer', buffer: thumbnail, persisted: false,
    });

    await expect(resolvePreprocessSource('/photos/frame.jpg', 6, true)).resolves.toEqual({
      sourcePath: '/photos/frame.jpg',
      inputBuffer: thumbnail,
      orientation: 6,
      useSourceOrientation: true,
      sourceKind: 'thumbnail-buffer',
    });
  });

  it('falls back to the original JPEG when the scanner thumbnail is unavailable', async () => {
    previewMocks.thumbnailPeek.mockResolvedValueOnce(undefined);

    await expect(resolvePreprocessSource('/photos/frame.jpg', 1, true)).resolves.toEqual({
      sourcePath: '/photos/frame.jpg',
      orientation: 1,
      sourceKind: 'original',
    });
  });

  it('rejects a tiny embedded JPEG thumbnail instead of weakening detector recall', async () => {
    previewMocks.thumbnailPeek.mockResolvedValueOnce({
      kind: 'buffer', buffer: jpegHeader(160, 120), persisted: false,
    });

    await expect(resolvePreprocessSource('/photos/frame.jpg', 1, true)).resolves.toEqual({
      sourcePath: '/photos/frame.jpg',
      orientation: 1,
      sourceKind: 'original',
    });
  });

  it.each([6, 8] as const)('retains orientation %i for a stored-pixel RAW preview', async (orientation) => {
    await expect(resolvePreprocessSource('/photos/frame.raw', orientation)).resolves.toEqual({
      sourcePath: '/cache/generated-preview.jpg',
      orientation,
      useSourceOrientation: true,
      sourceKind: 'preview-file',
    });
  });

  it.each([6, 8] as const)('delegates unseen RAW extraction and orientation resolution at O%i', async (orientation) => {
    const source = await resolvePreprocessSource('/photos/not-ready.nef', orientation);
    expect(source).toMatchObject({
      sourcePath: '/photos/not-ready.nef',
      orientation,
      sourceKind: 'original',
      extractEmbeddedJpeg: true,
      useSourceOrientation: true,
    });
  });

  it('uses a scanner thumbnail for detector-only RAW independently of persistent preview cache', async () => {
    const thumbnail = jpegHeader(320, 213);
    previewMocks.thumbnailPeek.mockResolvedValueOnce({
      kind: 'buffer', buffer: thumbnail, persisted: false,
    });
    const source = await resolvePreprocessSource('/photos/unseen.cr3', 1, true);
    expect(source.sourceKind).toBe('thumbnail-buffer');
    expect(source.inputBuffer).toEqual(thumbnail);
    expect(source.useSourceOrientation).toBe(true);
  });
});

describe('analysis-surface reuse safety', () => {
  it('forces supervised YuNet preprocessing during a legacy-to-fast route upgrade', () => {
    expect(canReuseAnalysisSurfaceForRequest({
      includeAnalysisSurface: true,
      includeDetectorTensor: false,
      includePersonTensors: false,
      includeYuNetTensor: false,
    })).toBe(true);
    expect(canReuseAnalysisSurfaceForRequest({
      includeAnalysisSurface: true,
      includeDetectorTensor: false,
      includePersonTensors: false,
      includeYuNetTensor: true,
    })).toBe(false);
  });

  it('changes identity when a source is overwritten at the same path', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'keptra-surface-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'tethered.jpg');
    await writeFile(file, Buffer.from('generation-a'));
    const first = await analysisSurfaceCacheKey(file, 1);
    await writeFile(file, Buffer.from('generation-b-with-a-different-size'));
    const second = await analysisSurfaceCacheKey(file, 1);

    expect(first).not.toBeNull();
    expect(second).not.toBe(first);
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

  it('spends one bounded sports safeguard pass on a zero-evidence frame', () => {
    expect(shouldRefinePersonDetection({
      width: 2400,
      height: 800,
      faceBoxes: [],
      fastBoxes: [],
      candidateCount: 0,
      sportsMode: true,
    })).toBe(true);
  });

  it('refines a sports face/body disagreement even when SSD found zero people', () => {
    expect(shouldRefinePersonDetection({
      width: 1200,
      height: 800,
      faceBoxes: [{ x: 0.42, y: 0.18, width: 0.12, height: 0.18, score: 0.94 }],
      fastBoxes: [],
      candidateCount: 0,
      sportsMode: true,
    })).toBe(true);
  });

  it('does not refine a sports frame for one weak extra proposal after a body was accepted', () => {
    expect(shouldRefinePersonDetection({
      width: 1600,
      height: 1000,
      faceBoxes: [{ x: 0.42, y: 0.18, width: 0.12, height: 0.18, score: 0.94 }],
      fastBoxes: [box],
      candidateCount: 2,
      sportsMode: true,
    })).toBe(false);
  });

  it('refines a sports frame when the fast pass has only a weak body proposal', () => {
    expect(shouldRefinePersonDetection({
      width: 1600,
      height: 1000,
      faceBoxes: [],
      fastBoxes: [],
      candidateCount: 1,
      sportsMode: true,
    })).toBe(true);
  });

  it('refines a crowded sports frame when multiple extra proposals remain unresolved', () => {
    expect(shouldRefinePersonDetection({
      width: 1600,
      height: 1000,
      faceBoxes: [box],
      fastBoxes: [box],
      candidateCount: 3,
      sportsMode: true,
    })).toBe(true);
  });

  it('refines zero-evidence sports scenery once regardless of aspect ratio', () => {
    expect(shouldRefinePersonDetection({
      width: 3000,
      height: 800,
      faceBoxes: [],
      fastBoxes: [],
      candidateCount: 0,
      sportsMode: true,
    })).toBe(true);
  });
});

describe('production fast-detector fallback policy', () => {
  const strong = { x: 0.2, y: 0.1, width: 0.3, height: 0.7, score: 0.92 };

  it('keeps a strong interior detection on the promoted fast path', () => {
    expect(shouldUseLegacyDetectorFallback([strong], 0.48)).toBe(false);
  });

  it('replans later photos to legacy tensors after a fast native circuit failure', () => {
    const plan = productionFastFailurePlan('DML device removed');
    expect(plan).toEqual({
      state: 'legacy-fallback',
      failure: 'DML device removed',
      retryAt: Number.POSITIVE_INFINITY,
      prepareFastTensors: false,
    });
    expect(shouldAttemptProductionFastRoute(plan.state, plan.retryAt, Date.now())).toBe(false);
    expect(canProductionFastBundleMutateRoute(7, 8)).toBe(false);
    expect(canProductionFastBundleMutateRoute(8, 8)).toBe(true);
  });

  it('does not claim SSD fallback corroboration when SSD returned zero boxes', () => {
    expect(productionPersonDetectorId(true, false)).toBe('nanodet-2022nov-fp32');
    expect(productionPersonDetectorId(true, true)).toBe(
      'nanodet-2022nov-fp32+ssd-fallback',
    );
  });

  it('never treats zero, low-confidence, or cropped-edge output as final', () => {
    expect(shouldUseLegacyDetectorFallback([], 0.48)).toBe(true);
    expect(shouldUseLegacyDetectorFallback([{ ...strong, score: 0.46 }], 0.48)).toBe(true);
    expect(shouldUseLegacyDetectorFallback([{ ...strong, x: 0.005 }], 0.48)).toBe(true);
    expect(shouldUseLegacyDetectorFallback([{ ...strong, y: 0.4, height: 0.6 }], 0.48)).toBe(true);
  });

  it('does not penalise a crowd for one weak edge detection', () => {
    expect(shouldUseLegacyDetectorFallback([
      strong,
      { ...strong, x: 0.55, width: 0.2, score: 0.86 },
      { ...strong, x: 0.92, width: 0.08, score: 0.3 },
    ], 0.48)).toBe(false);
  });

  it('preserves YuNet landmarks while appending unique UltraFace fallback boxes', () => {
    const points = [
      { x: 0.25, y: 0.2 }, { x: 0.35, y: 0.2 }, { x: 0.3, y: 0.3 },
      { x: 0.26, y: 0.4 }, { x: 0.34, y: 0.4 },
    ] as const;
    const merged = mergeFastFacesWithLegacy({ boxes: [strong], landmarks: [points] }, [
      { ...strong, x: 0.205, score: 0.96 },
      { ...strong, x: 0.65, width: 0.2, score: 0.84 },
    ]);
    expect(merged.boxes).toHaveLength(2);
    expect(merged.landmarks).toEqual([points, null]);
  });

  it('replaces an overlapping weak YuNet proposal with materially stronger UltraFace evidence', () => {
    const points = [
      { x: 0.25, y: 0.2 }, { x: 0.35, y: 0.2 }, { x: 0.3, y: 0.3 },
      { x: 0.26, y: 0.4 }, { x: 0.34, y: 0.4 },
    ] as const;
    const weakYuNet = { ...strong, score: 0.7 };
    const strongUltraFace = { ...strong, x: 0.205, score: 0.91 };
    const merged = mergeFastFacesWithLegacy(
      { boxes: [weakYuNet], landmarks: [points] },
      [strongUltraFace],
    );

    expect(merged.boxes).toEqual([strongUltraFace]);
    expect(merged.landmarks).toEqual([null]);
  });

  it('pins a bounded NanoDet production decode profile', () => {
    expect(PRODUCTION_NANODET_DECODE_PROFILE).toEqual({
      scoreThreshold: 0.4,
      nmsThreshold: 0.6,
      preNmsTopK: 512,
      maxDetections: 256,
      requireTopClass: true,
    });
  });

  it('keeps weak NanoDet proposals as disagreement evidence, not body boxes', () => {
    const pass = productionNanoDetPersonPass([
      { ...strong, score: 0.3, classId: 0 },
      { ...strong, x: 0.55, score: 0.67, classId: 0 },
    ]);
    expect(pass.candidateCount).toBe(2);
    expect(pass.boxes).toEqual([{ ...strong, x: 0.55, score: 0.67 }]);
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

  it('keeps an identity five-point SFace alignment pixel exact', () => {
    const width = 112;
    const height = 112;
    const pixels = Buffer.alloc(width * height * 4);
    for (let index = 0; index < width * height; index++) {
      pixels[index * 4] = index % 251;
      pixels[index * 4 + 1] = (index * 3) % 253;
      pixels[index * 4 + 2] = (index * 7) % 255;
      pixels[index * 4 + 3] = 255;
    }
    const landmarks = [
      { x: 38.2946 / width, y: 51.6963 / height },
      { x: 73.5318 / width, y: 51.5014 / height },
      { x: 56.0252 / width, y: 71.7366 / height },
      { x: 41.5493 / width, y: 92.3655 / height },
      { x: 70.7299 / width, y: 92.2041 / height },
    ] as const;
    expect(alignFaceBitmapForSFace(pixels, width, height, landmarks)).toEqual(pixels);
  });

  it('maps all five YuNet landmarks back through EXIF orientation', () => {
    const landmarks = [
      { x: 0.2, y: 0.3 }, { x: 0.4, y: 0.3 }, { x: 0.3, y: 0.4 },
      { x: 0.22, y: 0.5 }, { x: 0.38, y: 0.5 },
    ] as const;
    const mapped = mapLandmarksToStoredForExif(landmarks, 6);
    expect(mapped[0]).toEqual({ x: 0.3, y: 0.8 });
    expect(mapped).toHaveLength(5);
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
