import { describe, expect, it } from 'vitest';
import { orientationQuarterTurns, orientationSwapsAxes, orientationTransform } from '../orientation';

describe('preview orientation helpers', () => {
  it('covers every EXIF orientation without relying on browser auto-rotation', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((orientation) => orientationTransform(orientation))).toEqual([
      undefined,
      'scaleX(-1)',
      'rotate(180deg)',
      'scaleY(-1)',
      'rotate(90deg) scaleX(-1)',
      'rotate(90deg)',
      'rotate(270deg) scaleX(-1)',
      'rotate(270deg)',
    ]);
  });

  it('reports axis swaps and quarter turns for portrait orientations', () => {
    expect([1, 2, 3, 4].every((orientation) => !orientationSwapsAxes(orientation))).toBe(true);
    expect([5, 6, 7, 8].every((orientation) => orientationSwapsAxes(orientation))).toBe(true);
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((orientation) => orientationQuarterTurns(orientation))).toEqual([
      0, 0, 2, 2, 1, 1, 3, 3,
    ]);
  });
});
