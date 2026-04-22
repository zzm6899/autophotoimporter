import { describe, expect, it } from 'vitest';
import { bestInGroup, groupByVisualHash, hammingDistanceHex, scoreReview } from '../review';
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

  it('chooses protected/rated files before sharpness alone', () => {
    const chosen = bestInGroup([
      file('/sharp.jpg', undefined, { sharpnessScore: 500, reviewScore: 90 }),
      file('/protected.jpg', undefined, { isProtected: true, sharpnessScore: 50, reviewScore: 40 }),
    ]);
    expect(chosen?.path).toBe('/protected.jpg');
  });
});
