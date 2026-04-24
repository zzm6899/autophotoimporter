import { describe, expect, it } from 'vitest';
import { bestInGroup, groupByVisualHash, hammingDistanceHex, scoreReview, subjectPresenceQuality } from '../review';
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
});
