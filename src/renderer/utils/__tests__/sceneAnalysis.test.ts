import { describe, expect, it } from 'vitest';
import { analyzeScenePixels } from '../sceneAnalysis';

function pixels(width: number, height: number, valueAt: (x: number, y: number) => number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = Math.max(0, Math.min(255, Math.round(valueAt(x, y))));
      const index = (y * width + x) * 4;
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
      data[index + 3] = 255;
    }
  }
  return data;
}

describe('scene analysis', () => {
  it('reports low focus coverage and tonal range for a flat frame', () => {
    const width = 64;
    const height = 48;
    const result = analyzeScenePixels(pixels(width, height, () => 120), width, height);

    expect(result.focusCoverage).toBe(0);
    expect(result.dynamicRange).toBe(0);
    expect(result.kind).toBe('general');
  });

  it('recognises broadly distributed detail in a wide landscape-like frame', () => {
    const width = 96;
    const height = 48;
    const result = analyzeScenePixels(
      pixels(width, height, (x, y) => ((x + y) % 4 < 2 ? 28 : 226)),
      width,
      height,
    );

    expect(result.focusCoverage).toBeGreaterThan(0.7);
    expect(result.dynamicRange).toBeGreaterThan(0.7);
    expect(result.kind).toBe('landscape');
    expect(result.reasons).toContain('broad frame focus');
  });

  it('detects strong architectural axes and exposes tilt evidence', () => {
    const width = 80;
    const height = 64;
    const result = analyzeScenePixels(
      pixels(width, height, (x, y) => (x % 16 < 2 || y % 16 < 2 ? 245 : 45)),
      width,
      height,
    );

    expect(result.lineStrength).toBeGreaterThan(0.5);
    expect(result.kind).toBe('architecture');
    expect(Math.abs(result.horizonTiltDeg ?? 99)).toBeLessThan(1);
    expect(Math.abs(result.verticalTiltDeg ?? 99)).toBeLessThan(1);
  });

  it('respects an explicit interior profile and people classification', () => {
    const width = 48;
    const height = 48;
    const data = pixels(width, height, (x, y) => (x + y) % 2 ? 220 : 30);

    expect(analyzeScenePixels(data, width, height, { preferredKind: 'interior' })).toMatchObject({
      kind: 'interior',
      confidence: 1,
    });
    expect(analyzeScenePixels(data, width, height, { hasPeople: true })).toMatchObject({
      kind: 'people',
      confidence: 1,
    });
  });

  it('tracks highlight and shadow clipping separately', () => {
    const width = 64;
    const height = 64;
    const result = analyzeScenePixels(
      pixels(width, height, (x) => x < 8 ? 0 : x >= 56 ? 255 : 128),
      width,
      height,
    );

    expect(result.shadowClipping).toBeGreaterThan(0.09);
    expect(result.highlightClipping).toBeGreaterThan(0.09);
  });

  it('measures focus inside a detected face separately from a soft background', () => {
    const width = 160;
    const height = 120;
    const face = { x: 0.25, y: 0.2, width: 0.5, height: 0.6, score: 0.98 };
    const result = analyzeScenePixels(
      pixels(width, height, (x, y) => {
        const inside = x >= 40 && x < 120 && y >= 24 && y < 96;
        return inside ? ((x + y) % 4 < 2 ? 24 : 232) : 112;
      }),
      width,
      height,
      { hasPeople: true, faceBoxes: [face] },
    );

    expect(result.subjectSharpnessScore).toBeGreaterThan((result.backgroundSharpnessScore ?? 0) * 3);
    expect(result.subjectFocusConfidence).toBeGreaterThan(0.9);
    expect(result.subjectArea).toBeCloseTo(0.3, 1);
    expect(result.subjectReasons).toContain('face-area focus measured');
    expect(result.reasons).toContain('sharp subject against softer background');
  });

  it('reports when the detected subject is softer than its surroundings', () => {
    const width = 160;
    const height = 120;
    const face = { x: 0.3, y: 0.25, width: 0.4, height: 0.5, score: 0.99 };
    const result = analyzeScenePixels(
      pixels(width, height, (x, y) => {
        const inside = x >= 48 && x < 112 && y >= 30 && y < 90;
        return inside ? 118 : ((x + y) % 4 < 2 ? 24 : 232);
      }),
      width,
      height,
      { hasPeople: true, faceBoxes: [face] },
    );

    expect(result.subjectSharpnessScore).toBeLessThan((result.backgroundSharpnessScore ?? 0) * 0.4);
    expect(result.subjectReasons).toContain('subject softer than surrounding scene');
  });

  it('limits tiny high-frequency subjects by area and sampling confidence', () => {
    const width = 160;
    const height = 120;
    const data = pixels(width, height, (x, y) => {
      const inside = x >= 76 && x < 84 && y >= 55 && y < 65;
      return inside ? ((x + y) % 2 ? 250 : 8) : 112;
    });
    const tiny = analyzeScenePixels(data, width, height, {
      hasPeople: true,
      faceBoxes: [{ x: 0.475, y: 0.458, width: 0.05, height: 0.084, score: 0.99 }],
    });
    const large = analyzeScenePixels(
      pixels(width, height, (x, y) => {
        const inside = x >= 40 && x < 120 && y >= 24 && y < 96;
        return inside ? ((x + y) % 2 ? 250 : 8) : 112;
      }),
      width,
      height,
      { hasPeople: true, faceBoxes: [{ x: 0.25, y: 0.2, width: 0.5, height: 0.6, score: 0.99 }] },
    );

    expect(tiny.subjectFocusConfidence).toBeLessThan(0.15);
    expect(tiny.subjectSharpnessScore).toBeLessThan(large.subjectSharpnessScore ?? 0);
    expect(tiny.subjectReasons).toContain('small subject area limits focus confidence');
    expect(large.subjectFocusConfidence).toBeGreaterThan(0.9);
  });

  it.each([
    [1, { x: 0.18, y: 0.12, width: 0.28, height: 0.22 }],
    [2, { x: 0.54, y: 0.12, width: 0.28, height: 0.22 }],
    [3, { x: 0.54, y: 0.66, width: 0.28, height: 0.22 }],
    [4, { x: 0.18, y: 0.66, width: 0.28, height: 0.22 }],
    [5, { x: 0.12, y: 0.18, width: 0.22, height: 0.28 }],
    [6, { x: 0.12, y: 0.54, width: 0.22, height: 0.28 }],
    [7, { x: 0.66, y: 0.54, width: 0.22, height: 0.28 }],
    [8, { x: 0.66, y: 0.18, width: 0.22, height: 0.28 }],
  ])('maps upright detector boxes to stored pixels for EXIF orientation %i', (orientation, expected) => {
    const width = 100;
    const height = 140;
    const uprightBox = { x: 0.18, y: 0.12, width: 0.28, height: 0.22, score: 0.96 };
    const data = pixels(width, height, (x, y) => {
      const normalizedX = x / width;
      const normalizedY = y / height;
      const inside = normalizedX >= expected.x && normalizedX < expected.x + expected.width &&
        normalizedY >= expected.y && normalizedY < expected.y + expected.height;
      return inside ? ((x + y) % 3 ? 230 : 20) : 105;
    });
    const fromUpright = analyzeScenePixels(data, width, height, {
      orientation,
      boxCoordinateSpace: 'upright',
      faceBoxes: [uprightBox],
    });
    const fromStored = analyzeScenePixels(data, width, height, {
      orientation,
      faceBoxes: [{ ...expected, score: 0.96 }],
    });

    expect(fromUpright.subjectSharpnessScore).toBeCloseTo(fromStored.subjectSharpnessScore ?? 0, 4);
    expect(fromUpright.subjectFocusConfidence).toBeCloseTo(fromStored.subjectFocusConfidence ?? 0, 6);
    expect(fromUpright.subjectArea).toBeCloseTo(fromStored.subjectArea ?? 0, 4);
  });

  it('prioritises a reliable face region over a larger body box', () => {
    const width = 160;
    const height = 120;
    const data = pixels(width, height, (x, y) => {
      const inPerson = x >= 32 && x < 128 && y >= 12 && y < 108;
      const inFace = x >= 64 && x < 96 && y >= 18 && y < 42;
      if (inFace) return 118;
      return inPerson ? ((x + y) % 3 ? 232 : 20) : 118;
    });
    const personBox = { x: 0.2, y: 0.1, width: 0.6, height: 0.8, score: 0.98 };
    const personOnly = analyzeScenePixels(data, width, height, {
      hasPeople: true,
      personBoxes: [personBox],
    });
    const faceAndPerson = analyzeScenePixels(data, width, height, {
      hasPeople: true,
      faceBoxes: [{ x: 0.4, y: 0.15, width: 0.2, height: 0.2, score: 0.98 }],
      personBoxes: [personBox],
    });

    expect(faceAndPerson.subjectSharpnessScore).toBeLessThan((personOnly.subjectSharpnessScore ?? 0) * 0.55);
    expect(faceAndPerson.subjectReasons).toContain('face-area focus measured');
  });
});
