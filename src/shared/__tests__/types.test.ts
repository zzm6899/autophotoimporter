import { describe, it, expect } from 'vitest';
import { PHOTO_EXTENSIONS, VIDEO_EXTENSIONS, ALL_MEDIA_EXTENSIONS, FOLDER_PRESETS, IPC, detectPhotographerFromFilename, resolvePattern } from '../types';

describe('Extension sets', () => {
  it('PHOTO_EXTENSIONS contains common RAW and JPEG formats', () => {
    expect(PHOTO_EXTENSIONS.has('.jpg')).toBe(true);
    expect(PHOTO_EXTENSIONS.has('.cr2')).toBe(true);
    expect(PHOTO_EXTENSIONS.has('.arw')).toBe(true);
    expect(PHOTO_EXTENSIONS.has('.heic')).toBe(true);
    expect(PHOTO_EXTENSIONS.has('.nef')).toBe(true);
    expect(PHOTO_EXTENSIONS.has('.dng')).toBe(true);
  });

  it('VIDEO_EXTENSIONS contains common video formats', () => {
    expect(VIDEO_EXTENSIONS.has('.mp4')).toBe(true);
    expect(VIDEO_EXTENSIONS.has('.mov')).toBe(true);
  });

  it('ALL_MEDIA_EXTENSIONS is union of photo and video', () => {
    for (const ext of PHOTO_EXTENSIONS) {
      expect(ALL_MEDIA_EXTENSIONS.has(ext)).toBe(true);
    }
    for (const ext of VIDEO_EXTENSIONS) {
      expect(ALL_MEDIA_EXTENSIONS.has(ext)).toBe(true);
    }
    expect(ALL_MEDIA_EXTENSIONS.size).toBe(PHOTO_EXTENSIONS.size + VIDEO_EXTENSIONS.size);
  });
});

describe('FOLDER_PRESETS', () => {
  it('has expected preset keys', () => {
    expect(Object.keys(FOLDER_PRESETS)).toEqual(
      expect.arrayContaining(['date-flat', 'date-nested', 'year-month', 'year', 'photographer-date', 'flat']),
    );
  });

  it('each preset has label and pattern', () => {
    for (const [, preset] of Object.entries(FOLDER_PRESETS)) {
      expect(preset).toHaveProperty('label');
      expect(preset).toHaveProperty('pattern');
      expect(typeof preset.label).toBe('string');
      expect(typeof preset.pattern).toBe('string');
    }
  });
});

describe('photographer codes', () => {
  it('detects a known filename prefix case-insensitively', () => {
    expect(detectPhotographerFromFilename('zmo_0001.JPG')).toEqual({
      code: 'ZMO',
      name: 'Zac Morgan',
    });
  });

  it('ignores unknown or unprefixed filenames', () => {
    expect(detectPhotographerFromFilename('ABC_0001.JPG')).toBeUndefined();
    expect(detectPhotographerFromFilename('IMG_0001.JPG')).toBeUndefined();
    expect(detectPhotographerFromFilename('ZMO0001.JPG')).toBeUndefined();
  });

  it('resolves photographer folder tokens with an unassigned fallback', () => {
    const date = new Date('2026-06-25T10:00:00.000Z');
    expect(resolvePattern('{photographerCode}/{photographerName}/{filename}', date, 'ZMO_0001.JPG', '.jpg', undefined, {
      code: 'ZMO',
      name: 'Zac Morgan',
    })).toBe('ZMO/Zac Morgan/ZMO_0001.JPG');
    expect(resolvePattern('{photographerCode}/{filename}', date, 'IMG_0001.JPG', '.jpg')).toBe('Unassigned/IMG_0001.JPG');
  });
});

describe('IPC channels', () => {
  it('all values are unique strings', () => {
    const values = Object.values(IPC);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  it('contains expected channel groups', () => {
    expect(IPC.VOLUMES_LIST).toBeDefined();
    expect(IPC.SCAN_START).toBeDefined();
    expect(IPC.IMPORT_START).toBeDefined();
    expect(IPC.SETTINGS_GET).toBeDefined();
    expect(IPC.DIALOG_SELECT_FOLDER).toBeDefined();
  });
});
