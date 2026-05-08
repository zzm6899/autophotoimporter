import { describe, expect, it } from 'vitest';
import { groupBursts } from '../burst';
import type { MediaFile } from '../types';

function file(path: string, overrides: Partial<MediaFile> = {}): MediaFile {
  return {
    path,
    name: path.split('/').pop() ?? path,
    size: 1,
    type: 'photo',
    extension: '.jpg',
    dateTaken: '2026-04-22T10:00:00.000Z',
    ...overrides,
  };
}

describe('burst grouping', () => {
  it('does not group close-timestamp photos when camera metadata is missing', () => {
    const grouped = groupBursts([
      file('/a.jpg'),
      file('/b.jpg', { dateTaken: '2026-04-22T10:00:01.000Z' }),
    ], { windowSec: 2 });

    expect(grouped.every((entry) => entry.burstId === undefined)).toBe(true);
  });

  it('groups close-timestamp photos from the same known camera', () => {
    const grouped = groupBursts([
      file('/a.jpg', { cameraMake: 'Canon', cameraModel: 'R5' }),
      file('/b.jpg', { dateTaken: '2026-04-22T10:00:01.000Z', cameraMake: 'Canon', cameraModel: 'R5' }),
    ], { windowSec: 2 });

    expect(grouped[0].burstId).toBeTruthy();
    expect(grouped[1].burstId).toBe(grouped[0].burstId);
    expect(grouped.map((entry) => entry.burstIndex)).toEqual([1, 2]);
  });
});
