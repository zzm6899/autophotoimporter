import { describe, expect, it } from 'vitest';
import { clampStops, computeEV100, getEffectiveExposureStops, getNormalizedExposureStops } from '../exposure';

describe('exposure utilities', () => {
  it('clamps exposure deltas with an absolute safe max', () => {
    expect(clampStops(3, 2)).toBe(2);
    expect(clampStops(-3, 2)).toBe(-2);
    expect(clampStops(3, -2)).toBe(2);
    expect(clampStops(-3, -2)).toBe(-2);
  });

  it('returns neutral exposure when the clamp limit is invalid', () => {
    expect(clampStops(1, Number.NaN)).toBe(0);
    expect(getNormalizedExposureStops(8, 10, Number.NaN)).toBe(0);
  });

  it('does not flip signs when effective exposure receives a negative limit', () => {
    expect(getEffectiveExposureStops(-3, 8, 10, true, -2)).toBe(-2);
  });

  it('brightens a darker file to match a brighter exposure anchor', () => {
    const brighterAnchor = computeEV100(2.8, 1 / 50, 100);
    const darkerFile = computeEV100(2.8, 1 / 100, 100);

    expect(brighterAnchor).toBeDefined();
    expect(darkerFile).toBeDefined();
    expect(getNormalizedExposureStops(darkerFile, brighterAnchor, 4)).toBe(1);
  });

  it('darkens a brighter file to match a darker exposure anchor', () => {
    const darkerAnchor = computeEV100(2.8, 1 / 100, 100);
    const brighterFile = computeEV100(2.8, 1 / 50, 100);

    expect(darkerAnchor).toBeDefined();
    expect(brighterFile).toBeDefined();
    expect(getNormalizedExposureStops(brighterFile, darkerAnchor, 4)).toBe(-1);
  });
});
