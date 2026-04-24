import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MediaFile } from '../../../shared/types';

// Mocks
vi.mock('exifr', () => ({
  default: {
    parse: vi.fn(),
    thumbnail: vi.fn(),
  },
}));

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
  readFile: vi.fn(),
  mkdir: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => fn,
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp'),
  },
}));

import exifr from 'exifr';
import { stat, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { resolvePattern } from '../../../shared/types';
import { parseExifDate, extractEmbeddedThumbnail, generatePreview, generateThumbnail } from '../exif-parser';

const mockExifrParse = vi.mocked(exifr.parse);
const mockExifrThumbnail = vi.mocked(exifr.thumbnail);
const mockStat = vi.mocked(stat);
const mockReadFile = vi.mocked(readFile);
const mockExecFile = vi.mocked(execFile);

function makeFile(overrides: Partial<MediaFile> = {}): MediaFile {
  return {
    path: '/photos/IMG_001.jpg',
    name: 'IMG_001.jpg',
    size: 5000,
    type: 'photo',
    extension: '.jpg',
    ...overrides,
  };
}

// --- resolvePattern (pure, no mocks needed) ---

describe('resolvePattern', () => {
  const date = new Date(2024, 0, 15); // Jan 15, 2024

  it('resolves {YYYY}', () => {
    expect(resolvePattern('{YYYY}', date, 'test.jpg', '.jpg')).toBe('2024');
  });

  it('resolves {MM} with zero-padding', () => {
    expect(resolvePattern('{MM}', date, 'test.jpg', '.jpg')).toBe('01');
  });

  it('resolves {DD} with zero-padding', () => {
    expect(resolvePattern('{DD}', date, 'test.jpg', '.jpg')).toBe('15');
  });

  it('resolves {filename}', () => {
    expect(resolvePattern('{filename}', date, 'IMG_001.jpg', '.jpg')).toBe('IMG_001.jpg');
  });

  it('resolves {name} (without extension)', () => {
    expect(resolvePattern('{name}', date, 'IMG_001.jpg', '.jpg')).toBe('IMG_001');
  });

  it('resolves {ext} (without dot)', () => {
    expect(resolvePattern('{ext}', date, 'IMG_001.jpg', '.jpg')).toBe('jpg');
  });

  it('resolves nested date pattern', () => {
    expect(resolvePattern('{YYYY}/{MM}/{DD}/{filename}', date, 'test.jpg', '.jpg')).toBe('2024/01/15/test.jpg');
  });

  it('resolves flat pattern', () => {
    expect(resolvePattern('{filename}', date, 'test.jpg', '.jpg')).toBe('test.jpg');
  });

  it('handles multiple occurrences of same token', () => {
    expect(resolvePattern('{YYYY}-{YYYY}', date, 'test.jpg', '.jpg')).toBe('2024-2024');
  });

  it('preserves literal characters', () => {
    expect(resolvePattern('photos/{YYYY}/roll_{MM}/{filename}', date, 'test.jpg', '.jpg'))
      .toBe('photos/2024/roll_01/test.jpg');
  });

  it('pads month correctly for December', () => {
    const dec = new Date(2024, 11, 5);
    expect(resolvePattern('{MM}-{DD}', dec, 'x.jpg', '.jpg')).toBe('12-05');
  });
});

// --- parseExifDate ---

describe('parseExifDate', () => {
  beforeEach(() => {
    mockExifrParse.mockResolvedValue(null);
    mockStat.mockResolvedValue({ mtime: new Date(2024, 2, 10) } as any);
  });

  it('uses DateTimeOriginal from EXIF', async () => {
    const exifDate = new Date(2024, 5, 20);
    mockExifrParse.mockResolvedValue({ DateTimeOriginal: exifDate });

    const result = await parseExifDate(makeFile());
    expect(result.dateTaken).toBe(exifDate.toISOString());
  });

  it('falls back to CreateDate when DateTimeOriginal missing', async () => {
    const createDate = new Date(2024, 3, 1);
    mockExifrParse.mockResolvedValue({ CreateDate: createDate });

    const result = await parseExifDate(makeFile());
    expect(result.dateTaken).toBe(createDate.toISOString());
  });

  it('falls back to ModifyDate', async () => {
    const modifyDate = new Date(2024, 4, 5);
    mockExifrParse.mockResolvedValue({ ModifyDate: modifyDate });

    const result = await parseExifDate(makeFile());
    expect(result.dateTaken).toBe(modifyDate.toISOString());
  });

  it('falls back to mtime when no EXIF date', async () => {
    const mtime = new Date(2024, 2, 10);
    mockExifrParse.mockResolvedValue(null);
    mockStat.mockResolvedValue({ mtime } as any);

    const result = await parseExifDate(makeFile());
    expect(result.dateTaken).toBe(mtime.toISOString());
  });

  it('falls back to Date.now() when stat fails', async () => {
    mockExifrParse.mockResolvedValue(null);
    mockStat.mockRejectedValue(new Error('no file'));

    const before = Date.now();
    const result = await parseExifDate(makeFile());
    const after = Date.now();

    const taken = new Date(result.dateTaken!).getTime();
    expect(taken).toBeGreaterThanOrEqual(before);
    expect(taken).toBeLessThanOrEqual(after);
  });

  it('extracts camera metadata', async () => {
    mockExifrParse.mockResolvedValue({
      DateTimeOriginal: new Date(2024, 0, 1),
      ISO: 400,
      FNumber: 2.8,
      ExposureTime: 0.004,
      FocalLength: 50,
      Make: 'Canon',
      Model: 'EOS R5',
      LensModel: 'RF 50mm F1.2L',
      Orientation: 6,
    });

    const result = await parseExifDate(makeFile());
    expect(result.iso).toBe(400);
    expect(result.aperture).toBe(2.8);
    expect(result.shutterSpeed).toBe(0.004);
    expect(result.focalLength).toBe(50);
    expect(result.cameraMake).toBe('Canon');
    expect(result.cameraModel).toBe('EOS R5');
    expect(result.lensModel).toBe('RF 50mm F1.2L');
    expect(result.orientation).toBe(6);
  });

  it('normalizes text EXIF orientation values', async () => {
    mockExifrParse.mockResolvedValue({
      DateTimeOriginal: new Date(2024, 0, 1),
      Orientation: 'Rotate 90 CW',
    });

    const result = await parseExifDate(makeFile());
    expect(result.orientation).toBe(6);
  });

  it('computes destPath from EXIF date', async () => {
    mockExifrParse.mockResolvedValue({ DateTimeOriginal: new Date(2024, 0, 15) });

    const result = await parseExifDate(makeFile());
    expect(result.destPath).toBe('2024-01-15/IMG_001.jpg');
  });

  it('uses custom pattern when provided', async () => {
    mockExifrParse.mockResolvedValue({ DateTimeOriginal: new Date(2024, 0, 15) });

    const result = await parseExifDate(makeFile(), '{YYYY}/{MM}/{filename}');
    expect(result.destPath).toBe('2024/01/IMG_001.jpg');
  });

  it('gracefully handles exifr failure', async () => {
    mockExifrParse.mockRejectedValue(new Error('corrupt'));
    const mtime = new Date(2024, 2, 10);
    mockStat.mockResolvedValue({ mtime } as any);

    const result = await parseExifDate(makeFile());
    expect(result.dateTaken).toBe(mtime.toISOString());
    expect(result.destPath).toBeDefined();
  });

  it('skips EXIF for non-supported extensions', async () => {
    const file = makeFile({ extension: '.png', type: 'photo' });
    mockStat.mockResolvedValue({ mtime: new Date(2024, 0, 1) } as any);

    await parseExifDate(file);
    expect(mockExifrParse).not.toHaveBeenCalled();
  });

  it('skips EXIF for video files', async () => {
    const file = makeFile({ extension: '.mp4', type: 'video' });
    mockStat.mockResolvedValue({ mtime: new Date(2024, 0, 1) } as any);

    await parseExifDate(file);
    expect(mockExifrParse).not.toHaveBeenCalled();
  });
});

// --- extractEmbeddedThumbnail ---

describe('extractEmbeddedThumbnail', () => {
  it('returns base64 data URI on success', async () => {
    const thumbData = Buffer.from('fake-jpeg-data');
    mockExifrThumbnail.mockResolvedValue(thumbData);

    const result = await extractEmbeddedThumbnail('/photo.jpg', '.jpg');
    expect(result).toBe(`data:image/jpeg;base64,${thumbData.toString('base64')}`);
  });

  it('returns undefined for unsupported extension', async () => {
    const result = await extractEmbeddedThumbnail('/photo.png', '.png');
    expect(result).toBeUndefined();
    expect(mockExifrThumbnail).not.toHaveBeenCalled();
  });

  it('returns undefined when thumbnail is null', async () => {
    mockExifrThumbnail.mockResolvedValue(null as any);
    const result = await extractEmbeddedThumbnail('/photo.jpg', '.jpg');
    expect(result).toBeUndefined();
  });

  it('returns undefined when thumbnail is empty', async () => {
    mockExifrThumbnail.mockResolvedValue(new Uint8Array(0));
    const result = await extractEmbeddedThumbnail('/photo.jpg', '.jpg');
    expect(result).toBeUndefined();
  });

  it('returns undefined when exifr throws', async () => {
    mockExifrThumbnail.mockRejectedValue(new Error('corrupt'));
    const result = await extractEmbeddedThumbnail('/photo.jpg', '.jpg');
    expect(result).toBeUndefined();
  });
});

// --- generatePreview / generateThumbnail ---
//
// The resize path calls sips on macOS, PowerShell on Windows, and `convert`
// on Linux. The assertions below inspect the subprocess argv and are only
// meaningful on macOS; on Windows/Linux the embedded-JPEG fallback via
// exifr.thumbnail is exercised directly by the extractEmbeddedThumbnail
// tests above.
const runOnMac = process.platform === 'darwin' ? describe : describe.skip;

runOnMac('generatePreview (macOS sips)', () => {
  beforeEach(() => {
    mockStat.mockReset();
    mockExecFile.mockReset();
    mockReadFile.mockReset();
    mockExifrThumbnail.mockReset();
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' } as any);
    mockReadFile.mockResolvedValue(Buffer.from('jpeg-data'));
  });

  it('returns cached preview on stat hit', async () => {
    mockStat.mockResolvedValue({ size: 100 } as any);
    mockReadFile.mockResolvedValue(Buffer.from('cached'));

    const result = await generatePreview('/photo.jpg');
    expect(result).toContain('data:image/jpeg;base64,');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('generates via sips on cache miss', async () => {
    mockStat.mockRejectedValue(new Error('ENOENT'));
    mockReadFile.mockResolvedValue(Buffer.from('new-preview'));

    const result = await generatePreview('/photo.jpg');
    expect(result).toContain('data:image/jpeg;base64,');
    expect(mockExecFile).toHaveBeenCalledWith(
      'sips',
      expect.arrayContaining(['--resampleWidth', '1920']),
      expect.any(Object),
    );
  });

  it('returns undefined on failure', async () => {
    mockStat.mockRejectedValue(new Error('ENOENT'));
    mockExecFile.mockRejectedValue(new Error('sips fail'));
    mockExifrThumbnail.mockRejectedValue(new Error('no embedded thumb'));

    const result = await generatePreview('/photo.jpg');
    expect(result).toBeUndefined();
  });
});

runOnMac('generateThumbnail (macOS sips)', () => {
  beforeEach(() => {
    mockStat.mockReset();
    mockExecFile.mockReset();
    mockReadFile.mockReset();
    mockExifrThumbnail.mockReset();
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' } as any);
    mockReadFile.mockResolvedValue(Buffer.from('thumb-data'));
  });

  it('returns base64 data URI from sips output', async () => {
    mockStat.mockRejectedValue(new Error('ENOENT'));

    const result = await generateThumbnail('/photo.tiff', 'photo.tiff');
    expect(result).toContain('data:image/jpeg;base64,');
    expect(mockExecFile).toHaveBeenCalledWith(
      'sips',
      expect.arrayContaining(['--resampleWidth', '320']),
      expect.any(Object),
    );
  });

  it('returns undefined on sips failure with no embedded fallback', async () => {
    mockStat.mockRejectedValue(new Error('ENOENT'));
    mockExecFile.mockRejectedValue(new Error('timeout'));
    mockExifrThumbnail.mockRejectedValue(new Error('no embedded thumb'));

    const result = await generateThumbnail('/photo.tiff', 'photo.tiff');
    expect(result).toBeUndefined();
  });
});
