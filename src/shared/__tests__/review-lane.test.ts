import { describe, expect, it } from 'vitest';
import type { MediaFile } from '../types';
import { getSecondPassReasons, needsSecondPass } from '../review-lane';

function makeFile(overrides: Partial<MediaFile> = {}): MediaFile {
  return {
    path: '/photo.jpg',
    name: 'photo.jpg',
    size: 1,
    type: 'photo',
    extension: '.jpg',
    ...overrides,
  };
}

describe('second pass review lane', () => {
  it('flags unreviewed unmarked photos', () => {
    expect(getSecondPassReasons(makeFile())).toEqual(['unreviewed', 'unmarked']);
  });

  it('flags low-confidence keepers and high blur risk', () => {
    expect(getSecondPassReasons(makeFile({ pick: 'selected', reviewScore: 42, blurRisk: 'high' }))).toEqual([
      'blur-risk',
      'low-confidence-keeper',
    ]);
  });

  it('does not resurface approved or non-photo files', () => {
    expect(needsSecondPass(makeFile({ reviewApproved: true }))).toBe(false);
    expect(needsSecondPass(makeFile({ type: 'video', extension: '.mp4' }))).toBe(false);
  });
});
