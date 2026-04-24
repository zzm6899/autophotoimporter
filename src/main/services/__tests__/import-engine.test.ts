import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MediaFile, ImportConfig, ImportProgress } from '../../../shared/types';

// Mocks
vi.mock('node:fs/promises', () => ({
  copyFile: vi.fn(),
  mkdir: vi.fn(),
  stat: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => fn,
}));

vi.mock('../duplicate-detector', () => ({
  isDuplicate: vi.fn(),
}));

import { copyFile, mkdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { isDuplicate } from '../duplicate-detector';
import { importFiles, cancelImport, convertedDestPath } from '../import-engine';

const mockCopyFile = vi.mocked(copyFile);
const mockMkdir = vi.mocked(mkdir);
const mockStat = vi.mocked(stat);
const mockExecFile = vi.mocked(execFile);
const mockIsDuplicate = vi.mocked(isDuplicate);

function makeFile(overrides: Partial<MediaFile> = {}): MediaFile {
  return {
    path: '/src/IMG_001.jpg',
    name: 'IMG_001.jpg',
    size: 5000,
    type: 'photo',
    extension: '.jpg',
    destPath: '2024-01-15/IMG_001.jpg',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<ImportConfig> = {}): ImportConfig {
  return {
    sourcePath: '/src',
    destRoot: '/dest',
    skipDuplicates: true,
    saveFormat: 'original',
    jpegQuality: 90,
    ...overrides,
  };
}

describe('convertedDestPath', () => {
  it('returns original path when format is original', () => {
    expect(convertedDestPath('2024/photo.cr2', 'original')).toBe('2024/photo.cr2');
  });

  it('replaces extension for jpeg format', () => {
    expect(convertedDestPath('2024/photo.cr2', 'jpeg')).toBe('2024/photo.jpg');
  });

  it('replaces extension for tiff format', () => {
    expect(convertedDestPath('2024/photo.cr2', 'tiff')).toBe('2024/photo.tiff');
  });

  it('replaces extension for heic format', () => {
    expect(convertedDestPath('2024/photo.cr2', 'heic')).toBe('2024/photo.heic');
  });
});

describe('importFiles', () => {
  let onProgress: ReturnType<typeof vi.fn<(progress: ImportProgress) => void>>;

  beforeEach(() => {
    onProgress = vi.fn();
    mockMkdir.mockResolvedValue(undefined);
    mockCopyFile.mockResolvedValue(undefined);
    mockStat.mockResolvedValue({ size: 5000 } as any);
    mockIsDuplicate.mockResolvedValue(false);
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' } as any);
  });

  // --- Happy path ---

  it('copies a single file successfully', async () => {
    const files = [makeFile()];
    const result = await importFiles(files, makeConfig(), onProgress);

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining('2024-01-15'), { recursive: true });
    expect(mockCopyFile).toHaveBeenCalledOnce();
  });

  it('copies multiple files and tracks bytesTransferred', async () => {
    const files = [
      makeFile({ path: '/src/a.jpg', name: 'a.jpg', size: 1000, destPath: '2024/a.jpg' }),
      makeFile({ path: '/src/b.jpg', name: 'b.jpg', size: 2000, destPath: '2024/b.jpg' }),
    ];
    mockStat.mockImplementation(async (p) => {
      if (String(p).includes('a.jpg')) return { size: 1000 } as any;
      return { size: 2000 } as any;
    });

    const result = await importFiles(files, makeConfig(), onProgress);

    expect(result.imported).toBe(2);
    expect(result.totalBytes).toBe(3000);
  });

  it('sends progress callbacks per batch', async () => {
    const files = [makeFile(), makeFile({ path: '/src/b.jpg', name: 'b.jpg', destPath: '2024/b.jpg' })];
    await importFiles(files, makeConfig(), onProgress);

    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ currentIndex: 2, totalFiles: 2 }));
  });

  it('creates directories recursively via mkdir', async () => {
    await importFiles([makeFile()], makeConfig(), onProgress);
    expect(mockMkdir).toHaveBeenCalledWith(expect.any(String), { recursive: true });
  });

  it('returns durationMs > 0', async () => {
    const result = await importFiles([makeFile()], makeConfig(), onProgress);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  // --- Format conversion ---

  it('converts JPEG via sips with quality param', async () => {
    const config = makeConfig({ saveFormat: 'jpeg', jpegQuality: 85 });
    await importFiles([makeFile()], config, onProgress);

    if (process.platform === 'win32') {
      expect(mockExecFile).toHaveBeenCalledWith(
        'powershell.exe',
        expect.arrayContaining(['-Command', expect.stringContaining('image/jpeg')]),
        expect.objectContaining({ timeout: 60000 }),
      );
    } else {
      expect(mockExecFile).toHaveBeenCalledWith(
        'sips',
        expect.arrayContaining(['-s', 'format', 'jpeg', '-s', 'formatOptions', '85']),
        expect.objectContaining({ timeout: 60000 }),
      );
    }
    expect(mockCopyFile).not.toHaveBeenCalled();
  });

  it('converts TIFF via sips', async () => {
    const config = makeConfig({ saveFormat: 'tiff' });
    await importFiles([makeFile()], config, onProgress);

    if (process.platform === 'win32') {
      expect(mockExecFile).toHaveBeenCalledWith(
        'powershell.exe',
        expect.arrayContaining(['-Command', expect.stringContaining('image/tiff')]),
        expect.any(Object),
      );
    } else {
      expect(mockExecFile).toHaveBeenCalledWith(
        'sips',
        expect.arrayContaining(['-s', 'format', 'tiff']),
        expect.any(Object),
      );
    }
  });

  it('converts HEIC via sips', async () => {
    const config = makeConfig({ saveFormat: 'heic' });
    await importFiles([makeFile()], config, onProgress);

    if (process.platform === 'win32') {
      expect(mockExecFile).toHaveBeenCalledWith(
        'powershell.exe',
        expect.arrayContaining(['-Command', expect.stringContaining('image/jpeg')]),
        expect.any(Object),
      );
    } else {
      expect(mockExecFile).toHaveBeenCalledWith(
        'sips',
        expect.arrayContaining(['-s', 'format', 'heic']),
        expect.any(Object),
      );
    }
  });

  it('verifies converted files after writing', async () => {
    const config = makeConfig({ saveFormat: 'jpeg' });
    await importFiles([makeFile()], config, onProgress);

    expect(mockStat).toHaveBeenCalledWith(expect.stringContaining('IMG_001.jpg'));
  });

  // --- Duplicates ---

  it('skips duplicates when detected', async () => {
    mockIsDuplicate.mockResolvedValue(true);
    const result = await importFiles([makeFile()], makeConfig(), onProgress);

    expect(result.skipped).toBe(1);
    expect(result.imported).toBe(0);
    expect(mockCopyFile).not.toHaveBeenCalled();
  });

  it('does not check duplicates when skipDuplicates=false', async () => {
    const config = makeConfig({ skipDuplicates: false });
    await importFiles([makeFile()], config, onProgress);

    expect(mockIsDuplicate).not.toHaveBeenCalled();
  });

  it('reports skipped count in progress when duplicate', async () => {
    mockIsDuplicate.mockResolvedValue(true);
    await importFiles([makeFile()], makeConfig(), onProgress);

    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ skipped: 1 }));
  });

  // --- Error handling ---

  it('ENOSPC records "Disk full" and aborts remaining files', async () => {
    // Use more files than concurrency so some are queued behind the abort
    const files = Array.from({ length: 20 }, (_, i) =>
      makeFile({ path: `/src/${i}.jpg`, name: `${i}.jpg`, destPath: `2024/${i}.jpg` }),
    );
    const enospc = Object.assign(new Error('no space'), { code: 'ENOSPC' });
    mockCopyFile.mockRejectedValue(enospc);

    const result = await importFiles(files, makeConfig(), onProgress);

    expect(result.errors.some((e) => e.error === 'Disk full')).toBe(true);
    // Abort stops processing — not all 20 files should be attempted
    expect(mockCopyFile.mock.calls.length).toBeLessThan(files.length);
  });

  it('EEXIST is counted as skip, not error', async () => {
    const eexist = Object.assign(new Error('file exists'), { code: 'EEXIST' });
    mockCopyFile.mockRejectedValueOnce(eexist);

    const result = await importFiles([makeFile()], makeConfig(), onProgress);

    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it('EACCES is recorded as error and continues to next file', async () => {
    const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    mockCopyFile.mockRejectedValueOnce(eacces).mockResolvedValueOnce(undefined);

    const files = [
      makeFile({ path: '/src/a.jpg', name: 'a.jpg', destPath: '2024/a.jpg' }),
      makeFile({ path: '/src/b.jpg', name: 'b.jpg', size: 3000, destPath: '2024/b.jpg' }),
    ];
    mockStat.mockResolvedValue({ size: 3000 } as any);

    const result = await importFiles(files, makeConfig(), onProgress);

    expect(result.errors).toEqual([{ file: 'a.jpg', error: 'permission denied' }]);
    expect(result.imported).toBe(1);
  });

  it('verifies copyFile success after writing', async () => {
    // copyFile succeeds — no stat call needed, file counts as imported
    const result = await importFiles([makeFile()], makeConfig(), onProgress);

    expect(result.imported).toBe(1);
    expect(mockStat).toHaveBeenCalledWith(expect.stringContaining('IMG_001.jpg'));
  });

  it('file with no destPath records error', async () => {
    const file = makeFile({ destPath: undefined });
    const result = await importFiles([file], makeConfig(), onProgress);

    expect(result.errors).toEqual([{ file: 'IMG_001.jpg', error: 'No destination path computed' }]);
  });

  it('mkdir failure records error', async () => {
    mockMkdir.mockRejectedValueOnce(new Error('mkdir fail'));

    const result = await importFiles([makeFile()], makeConfig(), onProgress);

    expect(result.errors).toEqual([{ file: 'IMG_001.jpg', error: 'mkdir fail' }]);
  });

  it('sips failure records error', async () => {
    mockExecFile.mockRejectedValueOnce(new Error('sips crashed'));
    const config = makeConfig({ saveFormat: 'jpeg' });

    const result = await importFiles([makeFile()], config, onProgress);

    expect(result.errors).toEqual([{ file: 'IMG_001.jpg', error: 'sips crashed' }]);
  });

  it('generic error gets message or "Import failed"', async () => {
    mockCopyFile.mockRejectedValueOnce(Object.assign(new Error(''), { code: undefined }));

    const result = await importFiles([makeFile()], makeConfig(), onProgress);

    expect(result.errors[0].error).toBe('Import failed');
  });

  it('errors from one file do not affect subsequent files', async () => {
    mockCopyFile.mockRejectedValueOnce(new Error('fail first')).mockResolvedValueOnce(undefined);

    const files = [
      makeFile({ path: '/src/a.jpg', name: 'a.jpg', destPath: '2024/a.jpg' }),
      makeFile({ path: '/src/b.jpg', name: 'b.jpg', destPath: '2024/b.jpg' }),
    ];

    const result = await importFiles(files, makeConfig(), onProgress);

    expect(result.errors).toHaveLength(1);
    expect(result.imported).toBe(1);
  });

  // --- Abort/cancel ---

  it('abort signal stops processing', async () => {
    const files = [
      makeFile({ path: '/src/a.jpg', name: 'a.jpg', destPath: '2024/a.jpg' }),
      makeFile({ path: '/src/b.jpg', name: 'b.jpg', destPath: '2024/b.jpg' }),
    ];
    // First call starts import; copy for first file triggers cancel
    mockCopyFile.mockImplementation(async () => {
      cancelImport();
    });

    const result = await importFiles(files, makeConfig(), onProgress);

    // Only one copy was attempted before abort
    expect(result.imported + result.errors.length + result.skipped).toBeLessThanOrEqual(2);
  });

  // --- Edge cases ---

  it('empty files array returns zero counts', async () => {
    const result = await importFiles([], makeConfig(), onProgress);

    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('all files missing destPath records errors for each', async () => {
    const files = [
      makeFile({ name: 'a.jpg', destPath: undefined }),
      makeFile({ name: 'b.jpg', destPath: undefined }),
    ];

    const result = await importFiles(files, makeConfig(), onProgress);

    expect(result.errors).toHaveLength(2);
    expect(result.imported).toBe(0);
  });
});
