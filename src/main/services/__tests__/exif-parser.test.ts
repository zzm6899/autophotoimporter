import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MediaFile } from '../../../shared/types';

// Mocks
vi.mock('exifr', () => ({
  ...(() => {
    const parse = vi.fn();
    const thumbnail = vi.fn();
    const closeHook = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const instances: Array<{
      file: { close: () => void | Promise<void>; closeSpy: ReturnType<typeof vi.fn> };
    }> = [];

    class Exifr {
      private input: unknown;
      private readonly options: unknown;
      readonly file: { close: () => void | Promise<void>; closeSpy: ReturnType<typeof vi.fn> };

      constructor(options?: unknown) {
        this.options = options;
        const closeSpy = vi.fn(() => closeHook());
        this.file = { close: closeSpy, closeSpy };
        instances.push(this);
      }

      async read(input: unknown): Promise<void> {
        this.input = input;
      }

      async parse(): Promise<unknown> {
        const result = await parse(this.input, this.options);
        // Mirror Exifr's successful parse path: it starts close without
        // awaiting it. The service helper must join this same close promise.
        void this.file.close();
        return result;
      }

      async extractThumbnail(): Promise<unknown> {
        // Deliberately do not close here. Real Exifr has an early return when
        // an image has no TIFF/IFD1 thumbnail; that is the leaking path the
        // service helper must close in its finally block.
        return thumbnail(this.input);
      }
    }

    const mocked = { parse, thumbnail, Exifr, __instances: instances, __closeHook: closeHook };
    return { Exifr, default: mocked };
  })(),
}));

vi.mock('exiftool-vendored', () => {
  const read = vi.fn(async () => ({} as Record<string, unknown>));
  return {
    exiftoolPath: vi.fn(async () => '/tmp/exiftool'),
    ExifTool: class {
      async read(): Promise<Record<string, unknown>> { return read(); }
    },
    __read: read,
  };
});

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
  access: vi.fn(),
  readFile: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
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
import * as exiftoolVendored from 'exiftool-vendored';
import { stat, access, readFile, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { resolvePattern } from '../../../shared/types';
import { parseExifDate, extractEmbeddedThumbnail, generatePreview, generateThumbnail, getRawPreviewCacheDiagnostics, normalizeExifOrientation, readExifOrientation, resetRawPreviewCacheDiagnostics, setRawPreviewCache, setRawPreviewQuality } from '../exif-parser';

const mockExifrParse = vi.mocked(exifr.parse);
const mockExifToolRead = (exiftoolVendored as typeof exiftoolVendored & {
  __read: ReturnType<typeof vi.fn>;
}).__read;
const mockExifrThumbnail = vi.mocked(exifr.thumbnail);
const mockExifrInstances = (exifr as typeof exifr & {
  __instances: Array<{ file: { closeSpy: ReturnType<typeof vi.fn> } }>;
}).__instances;
const mockExifrCloseHook = (exifr as typeof exifr & {
  __closeHook: ReturnType<typeof vi.fn>;
}).__closeHook;
const mockStat = vi.mocked(stat);
const mockAccess = vi.mocked(access);
const mockReadFile = vi.mocked(readFile);
const mockUnlink = vi.mocked(unlink);
const mockExecFile = vi.mocked(execFile);

beforeEach(() => {
  mockExifrInstances.length = 0;
  mockExifrCloseHook.mockReset().mockResolvedValue(undefined);
  mockAccess.mockResolvedValue(undefined);
  mockExifToolRead.mockReset().mockResolvedValue({});
});

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

  it('reads XMP/maker-note ratings and protection flags across camera brands', async () => {
    mockExifrParse.mockResolvedValue({
      DateTimeOriginal: new Date(2024, 0, 1),
      RatingPercent: '80',
      Protection: 'Locked',
    });

    const result = await parseExifDate(makeFile());

    expect(result.rating).toBe(4);
    expect(result.isProtected).toBe(true);
    expect(mockExifrParse).toHaveBeenCalledWith('/photos/IMG_001.jpg', expect.objectContaining({
      xmp: true,
      makerNote: true,
    }));
  });

  it('falls back to unfamiliar manufacturer-specific tag names', async () => {
    mockExifrParse.mockResolvedValue({
      DateTimeOriginal: new Date(2024, 0, 1),
      SomeNewBrandRating: '3 stars',
      SomeNewBrandImageLock: 1,
    });

    const result = await parseExifDate(makeFile());

    expect(result.rating).toBe(3);
    expect(result.isProtected).toBe(true);
  });

  it('uses ExifTool when a proprietary flag is not decoded by Exifr', async () => {
    mockExifrParse.mockResolvedValue(null);
    mockExifToolRead.mockResolvedValue({
      SonyImageRating: 5,
      CanonImageProtection: 'Locked',
    });

    const result = await parseExifDate(makeFile());

    expect(result.rating).toBe(5);
    expect(result.isProtected).toBe(true);
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

describe('EXIF orientation for AI preprocessing', () => {
  it('normalizes mirrored text orientations without treating them as normal', () => {
    expect(normalizeExifOrientation('Mirror horizontal')).toBe(2);
    expect(normalizeExifOrientation('Mirror vertical')).toBe(4);
    expect(normalizeExifOrientation('Mirror horizontal and rotate 270 CW')).toBe(5);
    expect(normalizeExifOrientation('Mirror horizontal and rotate 90 CW')).toBe(7);
  });

  it('reads only orientation and safely defaults malformed metadata', async () => {
    mockExifrParse.mockResolvedValueOnce({ Orientation: 'Rotate 270 CW' });
    await expect(readExifOrientation('/photos/portrait.jpg')).resolves.toBe(8);
    mockExifrParse.mockRejectedValueOnce(new Error('broken EXIF'));
    await expect(readExifOrientation('/photos/broken.jpg')).resolves.toBe(1);
  });
});

describe('managed Exifr file-handle lifecycle', () => {
  beforeEach(() => {
    mockExifrParse.mockReset();
    mockExifrThumbnail.mockReset();
    mockStat.mockRejectedValue(new Error('stat-not-needed'));
  });

  it('waits for Exifr\'s fire-and-forget close before returning a successful parse', async () => {
    mockExifrParse.mockResolvedValue({ Orientation: 6 });
    let releaseClose!: () => void;
    mockExifrCloseHook.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseClose = resolve;
    }));

    let settled = false;
    const resultPromise = readExifOrientation('/photos/portrait.jpg').then((result) => {
      settled = true;
      return result;
    });

    await vi.waitFor(() => expect(mockExifrCloseHook).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    releaseClose();

    await expect(resultPromise).resolves.toBe(6);
    // Exifr's own close and the service finally block share one promise.
    expect(mockExifrInstances[0].file.closeSpy).toHaveBeenCalledTimes(1);
  });

  it('closes the chunked reader when metadata parsing throws', async () => {
    mockExifrParse.mockRejectedValue(new Error('corrupt EXIF'));

    await expect(readExifOrientation('/photos/corrupt.jpg')).resolves.toBe(1);

    expect(mockExifrCloseHook).toHaveBeenCalledTimes(1);
    expect(mockExifrInstances[0].file.closeSpy).toHaveBeenCalledTimes(1);
  });

  it('closes the chunked reader on Exifr\'s missing-thumbnail early return', async () => {
    mockExifrThumbnail.mockResolvedValue(undefined);

    await expect(extractEmbeddedThumbnail('/photos/no-ifd1.nef', '.nef')).resolves.toBeUndefined();

    expect(mockExifrCloseHook).toHaveBeenCalledTimes(1);
    expect(mockExifrInstances[0].file.closeSpy).toHaveBeenCalledTimes(1);
  });
});

// --- extractEmbeddedThumbnail ---

describe('extractEmbeddedThumbnail', () => {
  beforeEach(() => {
    // stat is called for the mem-cache key; reject gracefully so caching is skipped
    mockStat.mockRejectedValue(new Error('stat-not-needed'));
  });

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

describe('generatePreview RAW cache setting', () => {
  beforeEach(() => {
    setRawPreviewCache(true);
    setRawPreviewQuality(70);
    resetRawPreviewCacheDiagnostics();
    mockStat.mockReset();
    mockReadFile.mockReset();
    mockUnlink.mockReset();
    mockExecFile.mockReset();
    mockUnlink.mockResolvedValue(undefined);
    mockExecFile.mockRejectedValue(new Error('resize unavailable'));
    mockExifrThumbnail.mockReset();
  });

  it('uses cached RAW previews when the cache setting is enabled', async () => {
    mockStat.mockResolvedValue({ mtimeMs: 1, size: 100 } as any);
    mockReadFile.mockResolvedValue(Buffer.from('cached-preview'));

    const result = await generatePreview('/photos/card/IMG_0001.cr3');

    expect(result).toBe(`data:image/jpeg;base64,${Buffer.from('cached-preview').toString('base64')}`);
    expect(mockReadFile).toHaveBeenCalledTimes(1);
    expect(getRawPreviewCacheDiagnostics()).toMatchObject({
      enabled: true,
      hits: 1,
      misses: 0,
    });
  });

  it('skips RAW preview cache reads and removes transient files when disabled', async () => {
    setRawPreviewCache(false);
    mockStat.mockResolvedValue({ mtimeMs: 1, size: 100 } as any);
    mockReadFile.mockResolvedValue(Buffer.from('cached-preview'));
    mockExifrThumbnail.mockResolvedValue(Buffer.from('embedded-preview'));

    const result = await generatePreview('/photos/card/IMG_0002.cr3');

    expect(result).toBe(`data:image/jpeg;base64,${Buffer.from('embedded-preview').toString('base64')}`);
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockUnlink).toHaveBeenCalled();
    expect(getRawPreviewCacheDiagnostics()).toMatchObject({
      enabled: false,
      transientGenerations: 1,
      embeddedFallbacks: 1,
      cleanups: 1,
      hits: 0,
    });
  });

  it('treats DNG as RAW and uses the embedded preview path before platform resize', async () => {
    mockStat.mockImplementation(async (filePath) => {
      if (String(filePath) === '/photos/card/IMG_0004.dng') return { mtimeMs: 1, size: 100 } as any;
      throw new Error('cache miss');
    });
    mockExifrThumbnail.mockResolvedValue(Buffer.from('dng-embedded-preview'));

    const result = await generatePreview('/photos/card/IMG_0004.dng');

    expect(result).toBe(`data:image/jpeg;base64,${Buffer.from('dng-embedded-preview').toString('base64')}`);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(getRawPreviewCacheDiagnostics()).toMatchObject({
      embeddedFallbacks: 1,
      platformResizes: 0,
    });
  });

  it('does not reuse a stale cached RAW preview after quality changes', async () => {
    const sourcePath = '/photos/card/IMG_0003.cr3';
    const sourceStat = { mtimeMs: 1, size: 100 } as any;
    setRawPreviewQuality(55);
    mockStat.mockImplementation(async (filePath) => {
      if (String(filePath) === sourcePath) return sourceStat;
      throw new Error('cache miss');
    });
    mockExifrThumbnail.mockResolvedValue(Buffer.from('first-embedded-preview'));

    await generatePreview(sourcePath);
    const staleCachePath = mockStat.mock.calls
      .map(([filePath]) => String(filePath))
      .find((filePath) => filePath.includes('photo-importer-thumbs') && filePath.includes('_preview.jpg'));
    expect(staleCachePath).toBeDefined();

    setRawPreviewQuality(80);
    mockStat.mockReset();
    mockReadFile.mockReset();
    mockExifrThumbnail.mockReset();
    mockStat.mockImplementation(async (filePath) => {
      const normalized = String(filePath);
      if (normalized === sourcePath) return sourceStat;
      if (normalized === staleCachePath) return { mtimeMs: 2, size: 200 } as any;
      throw new Error('cache miss');
    });
    mockReadFile.mockResolvedValue(Buffer.from('stale-cache-preview'));
    mockExifrThumbnail.mockResolvedValue(Buffer.from('fresh-embedded-preview'));

    const result = await generatePreview(sourcePath);

    expect(result).toBe(`data:image/jpeg;base64,${Buffer.from('fresh-embedded-preview').toString('base64')}`);
    expect(mockReadFile).not.toHaveBeenCalled();
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
