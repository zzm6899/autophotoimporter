import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MediaFile } from '../../../shared/types';

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
  stat: vi.fn(),
}));

vi.mock('../exif-parser', () => ({
  parseExifDate: vi.fn(),
  ensureEmbeddedThumbnail: vi.fn(),
  ensureGeneratedThumbnail: vi.fn(),
  ensureVideoThumbnail: vi.fn(async () => false),
  isVideoThumbnailSupported: vi.fn(async () => false),
  clearThumbnailMemCache: vi.fn(),
  isSharpAvailable: vi.fn(() => false),
  EXIFR_SUPPORTED: new Set(['.jpg', '.jpeg', '.heic', '.dng', '.cr2', '.cr3', '.arw', '.nef', '.raf']),
}));

import { readdir, stat } from 'node:fs/promises';
import { parseExifDate, ensureEmbeddedThumbnail, ensureGeneratedThumbnail } from '../exif-parser';
import { scanFiles, cancelScan } from '../file-scanner';

const mockReaddir = vi.mocked(readdir);
const mockStat = vi.mocked(stat);
const mockParseExifDate = vi.mocked(parseExifDate);
const mockEnsureEmbeddedThumbnail = vi.mocked(ensureEmbeddedThumbnail);
const mockEnsureGeneratedThumbnail = vi.mocked(ensureGeneratedThumbnail);

function makeDirent(name: string, isDir: boolean, isFile: boolean) {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => isFile,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
    path: '',
    parentPath: '',
  };
}

describe('scanFiles', () => {
  let onBatch: ReturnType<typeof vi.fn<(files: MediaFile[]) => void>>;
  let onThumbnail: ReturnType<typeof vi.fn<(filePath: string) => void>>;

  beforeEach(() => {
    onBatch = vi.fn();
    onThumbnail = vi.fn();
    mockParseExifDate.mockResolvedValue({ dateTaken: '2024-01-15T00:00:00.000Z', destPath: '2024-01-15/test.jpg' });
    mockEnsureEmbeddedThumbnail.mockResolvedValue(false);
    mockEnsureGeneratedThumbnail.mockResolvedValue(false);
  });

  it('walks directory and finds media files', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('photo.jpg', false, true),
      makeDirent('video.mp4', false, true),
    ] as any);
    mockStat.mockResolvedValue({ size: 1000, mtimeMs: 12345 } as any);

    const total = await scanFiles('/source', onBatch, onThumbnail);

    expect(total).toBe(2);
    expect(onBatch).toHaveBeenCalled();
    expect(onBatch.mock.calls[0][0][0]).toEqual(expect.objectContaining({ sourceModifiedAtMs: 12345 }));
  });

  it('filters non-media extensions', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('readme.txt', false, true),
      makeDirent('photo.jpg', false, true),
    ] as any);
    mockStat.mockResolvedValue({ size: 1000 } as any);

    const total = await scanFiles('/source', onBatch, onThumbnail);

    expect(total).toBe(1);
  });

  it('recognizes Lumix HIF stills as photo files', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('P1000123.HIF', false, true),
    ] as any);
    mockStat.mockResolvedValue({ size: 1000, mtimeMs: 12345 } as any);

    const total = await scanFiles('/source', onBatch, onThumbnail, undefined, { generateThumbnails: false });

    expect(total).toBe(1);
    expect(onBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'P1000123.HIF',
        extension: '.hif',
        type: 'photo',
      }),
    ]);
  });

  it('skips hidden files', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('.hidden.jpg', false, true),
      makeDirent('visible.jpg', false, true),
    ] as any);
    mockStat.mockResolvedValue({ size: 1000 } as any);

    const total = await scanFiles('/source', onBatch, onThumbnail);

    expect(total).toBe(1);
  });

  it('reports scan diagnostics for skipped and failed entries', async () => {
    const onDiagnostics = vi.fn();
    mockReaddir.mockResolvedValue([
      makeDirent('.hidden.jpg', false, true),
      makeDirent('visible.jpg', false, true),
      makeDirent('blocked.jpg', false, true),
    ] as any);
    mockStat
      .mockResolvedValueOnce({ size: 1000, mtimeMs: 10 } as any)
      .mockRejectedValueOnce(new Error('EACCES'));

    const total = await scanFiles('/source', onBatch, onThumbnail, undefined, { generateThumbnails: false, onDiagnostics });

    expect(total).toBe(1);
    expect(onDiagnostics).toHaveBeenCalledWith({
      filesFound: 1,
      hiddenOrSystemEntriesSkipped: 1,
      inaccessibleDirectories: 0,
      statFailures: 1,
    });
  });

  it('recurses into subdirectories', async () => {
    mockReaddir
      .mockResolvedValueOnce([
        makeDirent('subdir', true, false),
        makeDirent('root.jpg', false, true),
      ] as any)
      .mockResolvedValueOnce([
        makeDirent('nested.cr2', false, true),
      ] as any);
    mockStat.mockResolvedValue({ size: 500 } as any);

    const total = await scanFiles('/source', onBatch, onThumbnail);

    expect(total).toBe(2);
  });

  it('enriches files with EXIF data via parseExifDate', async () => {
    mockReaddir.mockResolvedValue([makeDirent('photo.jpg', false, true)] as any);
    mockStat.mockResolvedValue({ size: 1000 } as any);
    mockParseExifDate.mockResolvedValue({
      dateTaken: '2024-06-01T00:00:00.000Z',
      destPath: '2024-06/photo.jpg',
    });

    await scanFiles('/source', onBatch, onThumbnail);

    expect(mockParseExifDate).toHaveBeenCalled();
    expect(onBatch).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ destPath: '2024-06/photo.jpg' }),
      ]),
    );
  });

  it('signals the thumbnail when the embedded extract succeeds', async () => {
    mockReaddir.mockResolvedValue([makeDirent('photo.jpg', false, true)] as any);
    mockStat.mockResolvedValue({ size: 1000 } as any);
    mockEnsureEmbeddedThumbnail.mockResolvedValue(true);

    await scanFiles('/source', onBatch, onThumbnail);
    // Thumbnails load in the background — flush microtasks
    await new Promise((r) => setTimeout(r, 0));

    expect(onThumbnail).toHaveBeenCalledWith(expect.stringContaining('photo.jpg'));
  });

  it('falls back to the generated thumbnail when the embedded extract fails', async () => {
    mockReaddir.mockResolvedValue([makeDirent('photo.jpg', false, true)] as any);
    mockStat.mockResolvedValue({ size: 1000 } as any);
    mockEnsureEmbeddedThumbnail.mockResolvedValue(false);
    mockEnsureGeneratedThumbnail.mockResolvedValue(true);

    await scanFiles('/source', onBatch, onThumbnail);
    // Thumbnails load in the background — flush microtasks
    await new Promise((r) => setTimeout(r, 0));

    expect(mockEnsureGeneratedThumbnail).toHaveBeenCalled();
    expect(onThumbnail).toHaveBeenCalledWith(expect.stringContaining('photo.jpg'));
  });

  it('returns total count', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('a.jpg', false, true),
      makeDirent('b.mov', false, true),
      makeDirent('c.cr2', false, true),
    ] as any);
    mockStat.mockResolvedValue({ size: 100 } as any);

    const total = await scanFiles('/source', onBatch, onThumbnail);
    expect(total).toBe(3);
  });

  it('gracefully handles readdir failure (silent skip)', async () => {
    mockReaddir.mockRejectedValue(new Error('EACCES'));

    const total = await scanFiles('/source', onBatch, onThumbnail);
    expect(total).toBe(0);
  });

  it('gracefully handles stat failure (skips file)', async () => {
    mockReaddir.mockResolvedValue([makeDirent('photo.jpg', false, true)] as any);
    mockStat.mockRejectedValue(new Error('EACCES'));

    const total = await scanFiles('/source', onBatch, onThumbnail);
    expect(total).toBe(0);
  });

  it('abort signal stops processing', async () => {
    // Simulate many files, but cancel after first batch
    const entries = Array.from({ length: 60 }, (_, i) => makeDirent(`photo${i}.jpg`, false, true));
    mockReaddir.mockResolvedValue(entries as any);
    mockStat.mockResolvedValue({ size: 100 } as any);

    // Cancel during EXIF enrichment
    mockParseExifDate.mockImplementation(async () => {
      cancelScan();
      return { dateTaken: '2024-01-01T00:00:00.000Z', destPath: '2024/test.jpg' };
    });

    const total = await scanFiles('/source', onBatch, onThumbnail);
    // Should return 0 because it was aborted
    expect(total).toBe(0);
    expect(onBatch).not.toHaveBeenCalled();
  });

  it('batches files in groups of 50', async () => {
    const entries = Array.from({ length: 75 }, (_, i) => makeDirent(`photo${i}.jpg`, false, true));
    mockReaddir.mockResolvedValue(entries as any);
    mockStat.mockResolvedValue({ size: 100 } as any);

    await scanFiles('/source', onBatch, onThumbnail);

    // 75 files at batch size 50 = 2 batches
    expect(onBatch).toHaveBeenCalledTimes(2);
    const firstBatch = onBatch.mock.calls[0][0];
    expect(firstBatch).toHaveLength(50);
  });
});
