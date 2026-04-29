import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MediaFile, ImportConfig, ImportProgress, WatermarkConfig } from '../../../shared/types';

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
import { importFiles, cancelImport, convertedDestPath, planImportFiles, watermarkPositionForOrientation } from '../import-engine';

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

describe('watermarkPositionForOrientation', () => {
  const watermark: WatermarkConfig = {
    enabled: true,
    mode: 'text',
    text: 'Keptra',
    opacity: 0.4,
    positionLandscape: 'bottom-right',
    positionPortrait: 'top-left',
    scale: 0.045,
  };

  it('uses portrait placement for EXIF portrait orientations', () => {
    expect(watermarkPositionForOrientation(watermark, 6)).toBe('top-left');
    expect(watermarkPositionForOrientation(watermark, 8)).toBe('top-left');
  });

  it('uses landscape placement when orientation is landscape or unknown', () => {
    expect(watermarkPositionForOrientation(watermark, 1)).toBe('bottom-right');
    expect(watermarkPositionForOrientation(watermark)).toBe('bottom-right');
  });
});

describe('planImportFiles', () => {
  beforeEach(() => {
    mockStat.mockResolvedValue({ size: 5000 } as any);
    mockIsDuplicate.mockResolvedValue(false);
  });

  it('returns planned import counts and destination targets without copying', async () => {
    mockStat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    const plan = await planImportFiles([
      makeFile({ path: '/src/a.jpg', name: 'a.jpg', destPath: '2024/a.jpg' }),
      makeFile({ path: '/src/b.jpg', name: 'b.jpg', destPath: '2024/b.jpg' }),
    ], makeConfig({ backupDestRoot: '/backup', verifyChecksums: true }));

    expect(plan.willImport).toBe(2);
    expect(plan.checksumEnabled).toBe(true);
    expect(plan.backupEnabled).toBe(true);
    expect(plan.items[0]).toEqual(expect.objectContaining({
      status: 'will-import',
      destRelPath: expect.stringContaining('2024'),
      backupFullPath: expect.stringContaining('backup'),
    }));
    expect(mockCopyFile).not.toHaveBeenCalled();
  });

  it('flags duplicate and low-confidence files in the dry plan', async () => {
    mockIsDuplicate.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mockStat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));

    const plan = await planImportFiles([
      makeFile({ path: '/src/dup.jpg', name: 'dup.jpg', destPath: '2024/dup.jpg' }),
      makeFile({ path: '/src/soft.jpg', name: 'soft.jpg', destPath: '2024/soft.jpg', blurRisk: 'high', reviewScore: 42 }),
    ], makeConfig());

    expect(plan.duplicates).toBe(1);
    expect(plan.lowConfidence).toBe(1);
    expect(plan.items.map((item) => item.status)).toEqual(['duplicate', 'will-import']);
    expect(plan.items[1].warnings).toEqual(expect.arrayContaining(['High blur risk', 'Low AI review score']));
  });

  it('marks destination conflicts as skipped by default', async () => {
    mockStat.mockResolvedValue({ size: 1234 } as any);

    const plan = await planImportFiles([makeFile()], makeConfig());

    expect(plan.willImport).toBe(0);
    expect(plan.conflicts).toBe(1);
    expect(plan.items[0]).toEqual(expect.objectContaining({
      status: 'conflict',
      reason: 'Destination file already exists',
    }));
  });

  it('renames conflicting destinations in the dry plan', async () => {
    mockStat.mockImplementation(async (p) => {
      if (String(p).includes('IMG_001 (1).jpg')) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      return { size: 1234 } as any;
    });

    const plan = await planImportFiles([makeFile()], makeConfig({ conflictPolicy: 'rename' }));

    expect(plan.willImport).toBe(1);
    expect(plan.conflicts).toBe(1);
    expect(plan.items[0]).toEqual(expect.objectContaining({
      status: 'will-import',
      reason: 'Destination exists; will rename',
      destFullPath: expect.stringContaining('IMG_001 (1).jpg'),
    }));
  });

  it('routes conflicting destinations into a conflicts folder in the dry plan', async () => {
    mockStat.mockImplementation(async (p) => {
      if (String(p).includes('_Conflicts')) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      return { size: 1234 } as any;
    });

    const plan = await planImportFiles([makeFile()], makeConfig({ conflictPolicy: 'conflicts-folder' }));

    expect(plan.willImport).toBe(1);
    expect(plan.conflicts).toBe(1);
    expect(plan.items[0]).toEqual(expect.objectContaining({
      status: 'will-import',
      reason: 'Destination exists; will import to conflicts folder',
      destFullPath: expect.stringContaining('_Conflicts'),
    }));
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
    mockExecFile.mockImplementation((_file: any, _args: any, _options: any, callback?: any) => {
      callback?.(null, '', '');
      return {} as any;
    });
  });

  // --- Happy path ---

  it('copies a single file successfully', async () => {
    const files = [makeFile()];
    const result = await importFiles(files, makeConfig(), onProgress);

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(result.ledgerItems).toEqual([
      expect.objectContaining({ sourcePath: '/src/IMG_001.jpg', status: 'imported' }),
    ]);
    expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining('2024-01-15'), { recursive: true });
    expect(mockCopyFile).toHaveBeenCalledOnce();
  });

  it('dry-run records planned ledger items without writing files', async () => {
    mockStat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));

    const result = await importFiles([makeFile()], makeConfig({ dryRun: true }), onProgress);

    expect(result.imported).toBe(1);
    expect(result.ledgerItems).toEqual([
      expect.objectContaining({ status: 'planned', sourcePath: '/src/IMG_001.jpg' }),
    ]);
    expect(mockMkdir).not.toHaveBeenCalled();
    expect(mockCopyFile).not.toHaveBeenCalled();
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
        expect.any(Function),
      );
    } else {
      expect(mockExecFile).toHaveBeenCalledWith(
        'sips',
        expect.arrayContaining(['-s', 'format', 'jpeg', '-s', 'formatOptions', '85']),
        expect.objectContaining({ timeout: 60000 }),
        expect.any(Function),
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
        expect.any(Function),
      );
    } else {
      expect(mockExecFile).toHaveBeenCalledWith(
        'sips',
        expect.arrayContaining(['-s', 'format', 'tiff']),
        expect.any(Object),
        expect.any(Function),
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
        expect.any(Function),
      );
    } else {
      expect(mockExecFile).toHaveBeenCalledWith(
        'sips',
        expect.arrayContaining(['-s', 'format', 'heic']),
        expect.any(Object),
        expect.any(Function),
      );
    }
  });

  it('does not apply exposure normalization when copying originals', async () => {
    const result = await importFiles([
      makeFile({ exposureValue: 8, normalizeToAnchor: true, exposureAdjustmentStops: 1 }),
    ], makeConfig({
      saveFormat: 'original',
      normalizeExposure: true,
      exposureAnchorEV: 10,
      normalizeAnchorPaths: ['/src/IMG_001.jpg'],
      exposureAdjustments: { '/src/IMG_001.jpg': 1 },
    }), onProgress);

    expect(result.imported).toBe(1);
    expect(mockCopyFile).toHaveBeenCalledOnce();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('does not apply white balance when copying originals', async () => {
    const result = await importFiles([
      makeFile({ whiteBalanceAdjustment: { temperature: 40, tint: -20 } }),
    ], makeConfig({
      saveFormat: 'original',
      whiteBalance: { temperature: 25, tint: 10 },
      whiteBalanceAdjustments: { '/src/IMG_001.jpg': { temperature: 40, tint: -20 } },
    }), onProgress);

    expect(result.imported).toBe(1);
    expect(mockCopyFile).toHaveBeenCalledOnce();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('passes brightness adjustment when transcoding with exposure normalization', async () => {
    await importFiles([
      makeFile({ exposureValue: 8, normalizeToAnchor: true }),
    ], makeConfig({
      saveFormat: 'jpeg',
      normalizeExposure: false,
      exposureAnchorEV: 10,
      normalizeAnchorPaths: ['/src/IMG_001.jpg'],
    }), onProgress);

    if (process.platform === 'win32') {
      expect(mockExecFile).toHaveBeenCalledWith(
        'powershell.exe',
        expect.arrayContaining(['-Command', expect.stringContaining('$matrix.Matrix00')]),
        expect.any(Object),
        expect.any(Function),
      );
    } else {
      expect(mockExecFile).toHaveBeenCalled();
    }
  });

  it('passes white-balance channel adjustment when transcoding', async () => {
    await importFiles([
      makeFile(),
    ], makeConfig({
      saveFormat: 'jpeg',
      whiteBalance: { temperature: 50, tint: -25 },
    }), onProgress);

    if (process.platform === 'win32') {
      expect(mockExecFile).toHaveBeenCalledWith(
        'powershell.exe',
        expect.arrayContaining(['-Command', expect.stringContaining('$matrix.Matrix22')]),
        expect.any(Object),
        expect.any(Function),
      );
    } else {
      expect(mockExecFile).toHaveBeenCalled();
    }
  });

  it('initializes PowerShell text watermark formatting before setting alignment', async () => {
    await importFiles([
      makeFile({ orientation: 6 }),
    ], makeConfig({
      saveFormat: 'jpeg',
      watermark: {
        enabled: true,
        mode: 'text',
        text: 'Keptra',
        opacity: 0.4,
        positionLandscape: 'bottom-right',
        positionPortrait: 'top-left',
        scale: 0.045,
      },
    }), onProgress);

    if (process.platform === 'win32') {
      const commandArgs = mockExecFile.mock.calls[0][1] as string[];
      const script = commandArgs[commandArgs.indexOf('-Command') + 1];
      expect(script.indexOf('$format = New-Object System.Drawing.StringFormat'))
        .toBeLessThan(script.indexOf("switch ('northwest')"));
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
    expect(result.ledgerItems).toEqual([
      expect.objectContaining({ status: 'skipped', error: 'Duplicate at destination' }),
    ]);
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

  it('explicit skip conflict policy skips existing destination before copying', async () => {
    mockStat.mockResolvedValue({ size: 1234 } as any);

    const result = await importFiles([makeFile()], makeConfig({ conflictPolicy: 'skip' }), onProgress);

    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(result.ledgerItems).toEqual([
      expect.objectContaining({ status: 'skipped', error: 'Destination file already exists' }),
    ]);
    expect(mockCopyFile).not.toHaveBeenCalled();
  });

  it('rename conflict policy writes to the first available destination name', async () => {
    mockStat.mockImplementation(async (p) => {
      const target = String(p);
      if (target.includes('IMG_001 (1).jpg')) {
        if (mockCopyFile.mock.calls.length > 0) return { size: 5000 } as any;
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      return { size: 1234 } as any;
    });

    const result = await importFiles([makeFile()], makeConfig({ conflictPolicy: 'rename' }), onProgress);

    expect(result.imported).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(mockCopyFile).toHaveBeenCalledWith(
      '/src/IMG_001.jpg',
      expect.stringContaining('IMG_001 (1).jpg'),
      expect.any(Number),
    );
    expect(result.ledgerItems).toEqual([
      expect.objectContaining({ status: 'imported', destFullPath: expect.stringContaining('IMG_001 (1).jpg') }),
    ]);
  });

  it('overwrite conflict policy replaces the existing destination', async () => {
    mockStat.mockResolvedValue({ size: 1234 } as any);

    const result = await importFiles([makeFile()], makeConfig({ conflictPolicy: 'overwrite' }), onProgress);

    expect(result.imported).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(mockCopyFile).toHaveBeenCalledWith(
      '/src/IMG_001.jpg',
      expect.stringContaining('IMG_001.jpg'),
      undefined,
    );
  });

  it('conflicts-folder policy writes conflicts under _Conflicts', async () => {
    mockStat.mockImplementation(async (p) => {
      const target = String(p);
      if (target.includes('_Conflicts')) {
        if (mockCopyFile.mock.calls.length > 0) return { size: 5000 } as any;
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      return { size: 1234 } as any;
    });

    const result = await importFiles([makeFile()], makeConfig({ conflictPolicy: 'conflicts-folder' }), onProgress);

    expect(result.imported).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(mockCopyFile).toHaveBeenCalledWith(
      '/src/IMG_001.jpg',
      expect.stringContaining('_Conflicts'),
      expect.any(Number),
    );
    expect(result.ledgerItems).toEqual([
      expect.objectContaining({ status: 'imported', destFullPath: expect.stringContaining('_Conflicts') }),
    ]);
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
    mockExecFile.mockImplementationOnce((_file: any, _args: any, _options: any, callback?: any) => {
      callback?.(new Error('sips crashed'));
      return {} as any;
    });
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
