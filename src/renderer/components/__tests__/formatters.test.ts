import { describe, it, expect } from 'vitest';
import {
  formatSize,
  formatDuration,
  formatFileSize,
  fmtAperture,
  fmtShutter,
  fmtFocal,
  buildExposure,
  formatExposure,
  isPortrait,
} from '../../utils/formatters';
import type { MediaFile } from '../../../shared/types';

describe('formatSize', () => {
  it('formats gigabytes', () => {
    expect(formatSize(2.5e9)).toBe('2.50 GB');
  });

  it('formats megabytes', () => {
    expect(formatSize(500e6)).toBe('500 MB');
  });

  it('formats exactly 1 GB', () => {
    expect(formatSize(1e9)).toBe('1.00 GB');
  });
});

describe('formatDuration', () => {
  it('formats seconds under a minute', () => {
    expect(formatDuration(45000)).toBe('45s');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(125000)).toBe('2m 5s');
  });

  it('formats zero', () => {
    expect(formatDuration(0)).toBe('0s');
  });
});

describe('formatFileSize', () => {
  it('formats kilobytes for small files', () => {
    expect(formatFileSize(500000)).toBe('500 KB');
  });

  it('formats megabytes for large files', () => {
    expect(formatFileSize(5.5e6)).toBe('5.5 MB');
  });
});

describe('fmtAperture', () => {
  it('formats integer aperture', () => {
    expect(fmtAperture(2)).toBe('f/2');
  });

  it('formats decimal aperture', () => {
    expect(fmtAperture(2.8)).toBe('f/2.8');
  });
});

describe('fmtShutter', () => {
  it('formats fast shutter speed as fraction', () => {
    expect(fmtShutter(1 / 250)).toBe('1/250s');
  });

  it('formats slow shutter speed as whole seconds', () => {
    expect(fmtShutter(2)).toBe('2s');
  });
});

describe('fmtFocal', () => {
  it('formats focal length', () => {
    expect(fmtFocal(50)).toBe('50mm');
  });

  it('rounds decimal focal length', () => {
    expect(fmtFocal(85.3)).toBe('85mm');
  });
});

describe('buildExposure', () => {
  it('combines all metadata', () => {
    const result = buildExposure({ aperture: 2.8, shutterSpeed: 1 / 250, iso: 400, focalLength: 50 } as MediaFile);
    expect(result).toBe('f/2.8 · 1/250s · ISO 400 · 50mm');
  });

  it('returns null with no metadata', () => {
    expect(buildExposure({} as MediaFile)).toBeNull();
  });
});

describe('formatExposure', () => {
  it('combines aperture, shutter, and ISO', () => {
    const result = formatExposure({ aperture: 5.6, shutterSpeed: 1 / 125, iso: 200 } as MediaFile);
    expect(result).toBe('f/5.6 1/125 200');
  });

  it('returns null with no metadata', () => {
    expect(formatExposure({} as MediaFile)).toBeNull();
  });
});

describe('isPortrait', () => {
  it('returns true for orientation 6', () => {
    expect(isPortrait(6)).toBe(true);
  });

  it('returns true for orientation 8', () => {
    expect(isPortrait(8)).toBe(true);
  });

  it('returns false for orientation 1', () => {
    expect(isPortrait(1)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isPortrait(undefined)).toBe(false);
  });
});
