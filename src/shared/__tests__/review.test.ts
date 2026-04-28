import { describe, expect, it } from 'vitest';
import { autoCullGroup, bestInGroup, groupByFaceEmbedding, groupByFaceSimilarity, groupByVisualHash, hammingDistanceHex, humanMomentQuality, rankBestShots, scoreReview, subjectPresenceQuality } from '../review';
import type { MediaFile } from '../types';

function file(path: string, hash?: string, overrides: Partial<MediaFile> = {}): MediaFile {
  return {
    path,
    name: path.split('/').pop() ?? path,
    size: 1,
    type: 'photo',
    extension: '.jpg',
    visualHash: hash,
    ...overrides,
  };
}

function embeddingHex(values: number[]): string {
  const array = new Float32Array(values);
  return Buffer.from(array.buffer).toString('hex');
}

describe('review utilities', () => {
  it('computes hamming distance for hex hashes', () => {
    expect(hammingDistanceHex('0000', '0000')).toBe(0);
    expect(hammingDistanceHex('0000', 'ffff')).toBe(16);
  });

  it('groups visually similar hashes under a threshold', () => {
    const groups = groupByVisualHash([
      file('/a.jpg', '0000000000000000'),
      file('/b.jpg', '0000000000000001'),
      file('/c.jpg', 'ffffffffffffffff'),
    ], 2);
    expect(Object.values(groups)).toEqual([['/a.jpg', '/b.jpg']]);
  });

  it('scores protected and rated files above soft unrated files', () => {
    const strong = scoreReview({ sharpnessScore: 120, rating: 4, isProtected: true });
    const weak = scoreReview({ sharpnessScore: 10 });
    expect(strong.score).toBeGreaterThan(weak.score);
    expect(weak.blurRisk).toBe('high');
  });

  it('groups face embeddings with cosine similarity', () => {
    const groups = groupByFaceEmbedding([
      file('/a.jpg', undefined, { faceCount: 1, faceEmbedding: embeddingHex([1, 0, 0, 0]) }),
      file('/b.jpg', undefined, { faceCount: 1, faceEmbedding: embeddingHex([0.98, 0.02, 0, 0]) }),
      file('/c.jpg', undefined, { faceCount: 1, faceEmbedding: embeddingHex([0, 1, 0, 0]) }),
    ], 0.9);
    expect(Object.values(groups)).toEqual([['/a.jpg', '/b.jpg']]);
  });

  it('falls back to legacy face signatures when embeddings are unavailable', () => {
    const groups = groupByFaceSimilarity([
      file('/a.jpg', undefined, { faceCount: 1, faceSignature: '0000000000000000' }),
      file('/b.jpg', undefined, { faceCount: 1, faceSignature: '0000000000000001' }),
      file('/c.jpg', undefined, { faceCount: 1, faceSignature: 'ffffffffffffffff' }),
    ], 0.9, 2);
    expect(Object.values(groups)).toEqual([['/a.jpg', '/b.jpg']]);
  });

  it('rewards clear person detections even when no face is found', () => {
    const review = scoreReview({
      sharpnessScore: 95,
      subjectSharpnessScore: 110,
      personCount: 1,
      personBoxes: [{ x: 0.2, y: 0.05, width: 0.45, height: 0.88, score: 0.94 }],
    });
    expect(review.score).toBeGreaterThan(40);
    expect(review.reasons).toContain('1 person');
    expect(subjectPresenceQuality({
      personCount: 1,
      personBoxes: [{ x: 0.2, y: 0.05, width: 0.45, height: 0.88, score: 0.94 }],
      subjectSharpnessScore: 110,
    })).toBeGreaterThan(20);
  });

  it('chooses protected and rated files before face/subject tie-breakers', () => {
    const chosen = bestInGroup([
      file('/protected.jpg', undefined, { isProtected: true, rating: 5, sharpnessScore: 200, reviewScore: 95 }),
      file('/face.jpg', undefined, { faceCount: 1, subjectSharpnessScore: 120, sharpnessScore: 80, reviewScore: 70 }),
    ]);
    expect(chosen?.path).toBe('/protected.jpg');
  });

  it('ranks burst keepers by face, eye, and subject quality', () => {
    const ranked = rankBestShots([
      file('/soft.jpg', undefined, { faceCount: 1, faceBoxes: [{ x: 0.2, y: 0.2, width: 0.2, height: 0.2, eyeScore: 0, score: 0.65 }], subjectSharpnessScore: 32, sharpnessScore: 120, reviewScore: 54 }),
      file('/sharp-eyes.jpg', undefined, { faceCount: 1, faceBoxes: [{ x: 0.2, y: 0.2, width: 0.22, height: 0.22, eyeScore: 2, score: 0.96 }], subjectSharpnessScore: 135, sharpnessScore: 155, reviewScore: 80 }),
    ]);
    expect(ranked[0].path).toBe('/sharp-eyes.jpg');
  });

  it('prefers open eyes and smiles for portrait burst picks', () => {
    const ranked = rankBestShots([
      file('/sharper-blink.jpg', undefined, {
        faceCount: 1,
        faceBoxes: [{ x: 0.33, y: 0.2, width: 0.2, height: 0.24, eyeScore: 0, smileScore: 0.15, score: 0.96 }],
        subjectSharpnessScore: 160,
        sharpnessScore: 190,
        reviewScore: 84,
      }),
      file('/open-smile.jpg', undefined, {
        faceCount: 1,
        faceBoxes: [{ x: 0.34, y: 0.2, width: 0.2, height: 0.24, eyeScore: 2, smileScore: 0.9, score: 0.93 }],
        subjectSharpnessScore: 128,
        sharpnessScore: 150,
        reviewScore: 78,
      }),
    ]);
    expect(ranked[0].path).toBe('/open-smile.jpg');
    expect(humanMomentQuality(ranked[0])).toBeGreaterThan(humanMomentQuality(ranked[1]));
  });

  it('prefers group frames where more people have usable faces', () => {
    const ranked = rankBestShots([
      file('/missing-face.jpg', undefined, {
        faceCount: 2,
        personCount: 3,
        faceBoxes: [
          { x: 0.2, y: 0.18, width: 0.14, height: 0.17, eyeScore: 2, smileScore: 0.7, score: 0.94 },
          { x: 0.46, y: 0.19, width: 0.13, height: 0.16, eyeScore: 2, smileScore: 0.7, score: 0.92 },
        ],
        personBoxes: [
          { x: 0.15, y: 0.12, width: 0.2, height: 0.78, score: 0.93 },
          { x: 0.4, y: 0.12, width: 0.2, height: 0.78, score: 0.93 },
          { x: 0.65, y: 0.12, width: 0.2, height: 0.78, score: 0.9 },
        ],
        subjectSharpnessScore: 160,
        sharpnessScore: 180,
        reviewScore: 82,
      }),
      file('/full-group.jpg', undefined, {
        faceCount: 3,
        personCount: 3,
        faceBoxes: [
          { x: 0.2, y: 0.18, width: 0.14, height: 0.17, eyeScore: 2, smileScore: 0.65, score: 0.9 },
          { x: 0.46, y: 0.19, width: 0.13, height: 0.16, eyeScore: 2, smileScore: 0.7, score: 0.9 },
          { x: 0.67, y: 0.2, width: 0.12, height: 0.15, eyeScore: 2, smileScore: 0.6, score: 0.88 },
        ],
        personBoxes: [
          { x: 0.15, y: 0.12, width: 0.2, height: 0.78, score: 0.93 },
          { x: 0.4, y: 0.12, width: 0.2, height: 0.78, score: 0.93 },
          { x: 0.65, y: 0.12, width: 0.2, height: 0.78, score: 0.9 },
        ],
        subjectSharpnessScore: 132,
        sharpnessScore: 150,
        reviewScore: 78,
      }),
    ]);
    expect(ranked[0].path).toBe('/full-group.jpg');
  });

  it('auto cull keeps manual picks and rejects only clear losers', () => {
    const decision = autoCullGroup([
      file('/best.jpg', undefined, { faceCount: 1, faceBoxes: [{ x: 0.2, y: 0.2, width: 0.25, height: 0.25, eyeScore: 2, score: 0.97 }], subjectSharpnessScore: 150, sharpnessScore: 190, reviewScore: 85 }),
      file('/keeper.jpg', undefined, { pick: 'selected', subjectSharpnessScore: 40, blurRisk: 'high', reviewScore: 30 }),
      file('/reject.jpg', undefined, { faceCount: 1, faceBoxes: [{ x: 0.2, y: 0.2, width: 0.12, height: 0.12, eyeScore: 0, score: 0.55 }], subjectSharpnessScore: 20, sharpnessScore: 35, blurRisk: 'high', reviewScore: 20 }),
    ]);
    expect(decision.best?.path).toBe('/best.jpg');
    expect(decision.keep).toContain('/keeper.jpg');
    expect(decision.reject).toContain('/reject.jpg');
  });

  it('supports conservative vs aggressive cull confidence', () => {
    const group = [
      file('/best.jpg', undefined, { faceCount: 1, faceBoxes: [{ x: 0.25, y: 0.2, width: 0.24, height: 0.24, eyeScore: 2, score: 0.95 }], subjectSharpnessScore: 135, sharpnessScore: 160, reviewScore: 78 }),
      file('/maybe.jpg', undefined, { faceCount: 1, faceBoxes: [{ x: 0.25, y: 0.2, width: 0.23, height: 0.23, eyeScore: 2, score: 0.9 }], subjectSharpnessScore: 122, sharpnessScore: 150, reviewScore: 52 }),
    ];
    expect(autoCullGroup(group, { confidence: 'conservative' }).reject).not.toContain('/maybe.jpg');
    expect(autoCullGroup(group, { confidence: 'aggressive' }).reject).toContain('/maybe.jpg');
  });

  it('keeps smile and sharpness alternates when requested', () => {
    const decision = autoCullGroup([
      file('/overall.jpg', undefined, { faceCount: 1, faceBoxes: [{ x: 0.3, y: 0.2, width: 0.2, height: 0.22, eyeScore: 2, smileScore: 0.45, score: 0.94 }], subjectSharpnessScore: 132, sharpnessScore: 150, reviewScore: 82 }),
      file('/smile.jpg', undefined, { faceCount: 1, faceBoxes: [{ x: 0.3, y: 0.2, width: 0.2, height: 0.22, eyeScore: 2, smileScore: 1, score: 0.9 }], subjectSharpnessScore: 92, sharpnessScore: 110, reviewScore: 72 }),
      file('/sharp.jpg', undefined, { faceCount: 1, faceBoxes: [{ x: 0.3, y: 0.2, width: 0.2, height: 0.22, eyeScore: 1, smileScore: 0.3, score: 0.86 }], subjectSharpnessScore: 175, sharpnessScore: 190, reviewScore: 68 }),
    ], { keeperQuota: 'smile-and-sharp' });
    expect(decision.keep).toContain('/smile.jpg');
    expect(decision.keep).toContain('/sharp.jpg');
  });
});
