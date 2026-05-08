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

  it('keeps a camera burst together when another camera is interleaved by time', () => {
    const grouped = groupBursts([
      file('/canon-1.jpg', { cameraMake: 'Canon', cameraModel: 'R5', dateTaken: '2026-04-22T10:00:00.000Z' }),
      file('/sony-1.jpg', { cameraMake: 'Sony', cameraModel: 'A7 IV', dateTaken: '2026-04-22T10:00:00.500Z' }),
      file('/canon-2.jpg', { cameraMake: 'Canon', cameraModel: 'R5', dateTaken: '2026-04-22T10:00:01.000Z' }),
    ], { windowSec: 2 });

    expect(grouped[0].burstId).toBeTruthy();
    expect(grouped[2].burstId).toBe(grouped[0].burstId);
    expect(grouped[0].burstIndex).toBe(1);
    expect(grouped[2].burstIndex).toBe(2);
    expect(grouped[1].burstId).toBeUndefined();
  });

  it('does not group shots when only broad camera make metadata is known', () => {
    const grouped = groupBursts([
      file('/canon-a.jpg', { cameraMake: 'Canon', dateTaken: '2026-04-22T10:00:00.000Z' }),
      file('/canon-b.jpg', { cameraMake: 'Canon', dateTaken: '2026-04-22T10:00:01.000Z' }),
    ], { windowSec: 2 });

    expect(grouped.every((entry) => entry.burstId === undefined)).toBe(true);
  });

  it('ignores invalid capture timestamps when building burst groups', () => {
    const grouped = groupBursts([
      file('/valid-1.jpg', { cameraMake: 'Canon', cameraModel: 'R5', dateTaken: '2026-04-22T10:00:00.000Z' }),
      file('/invalid.jpg', { cameraMake: 'Canon', cameraModel: 'R5', dateTaken: 'not-a-date', burstId: 'stale', burstIndex: 1, burstSize: 2 }),
      file('/valid-2.jpg', { cameraMake: 'Canon', cameraModel: 'R5', dateTaken: '2026-04-22T10:00:01.000Z' }),
    ], { windowSec: 2 });

    expect(grouped[0].burstId).toBeTruthy();
    expect(grouped[2].burstId).toBe(grouped[0].burstId);
    expect(grouped[1].burstId).toBeUndefined();
    expect(grouped[1].burstIndex).toBeUndefined();
    expect(grouped[1].burstSize).toBeUndefined();
  });
});
