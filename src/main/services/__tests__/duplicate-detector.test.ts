import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
}));

import { stat } from 'node:fs/promises';
import { isDuplicate } from '../duplicate-detector';

const mockStat = vi.mocked(stat);

describe('isDuplicate', () => {
  it('returns true when file exists with same size and no mtime provided', async () => {
    mockStat.mockResolvedValue({ size: 5000, mtimeMs: 1000000 } as any);
    expect(await isDuplicate('/dest', '2024/photo.jpg', 5000)).toBe(true);
  });

  it('returns false when file exists with different size', async () => {
    mockStat.mockResolvedValue({ size: 9999, mtimeMs: 1000000 } as any);
    expect(await isDuplicate('/dest', '2024/photo.jpg', 5000)).toBe(false);
  });

  it('returns true when size and mtime match within 2s tolerance', async () => {
    mockStat.mockResolvedValue({ size: 5000, mtimeMs: 1000001 } as any);
    expect(await isDuplicate('/dest', '2024/photo.jpg', 5000, 1000000)).toBe(true);
  });

  it('returns true when size matches and mtime difference is exactly 2000ms (FAT32 boundary)', async () => {
    mockStat.mockResolvedValue({ size: 5000, mtimeMs: 1002000 } as any);
    expect(await isDuplicate('/dest', '2024/photo.jpg', 5000, 1000000)).toBe(true);
  });

  it('returns false when size matches but mtime differs by more than 2s', async () => {
    mockStat.mockResolvedValue({ size: 5000, mtimeMs: 9000000 } as any);
    expect(await isDuplicate('/dest', '2024/photo.jpg', 5000, 1000000)).toBe(false);
  });

  it('returns false when file not found', async () => {
    mockStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    expect(await isDuplicate('/dest', '2024/photo.jpg', 5000)).toBe(false);
  });

  it('throws on unexpected stat errors (e.g. permission denied)', async () => {
    mockStat.mockRejectedValue(new Error('permission denied'));
    await expect(isDuplicate('/dest', '2024/photo.jpg', 5000)).rejects.toThrow('permission denied');
  });

  it('constructs correct path from destRoot and destRelativePath', async () => {
    mockStat.mockResolvedValue({ size: 100, mtimeMs: 0 } as any);
    await isDuplicate('/dest/root', 'sub/dir/photo.jpg', 100);
    expect(mockStat).toHaveBeenCalledWith(path.join('/dest/root', 'sub/dir/photo.jpg'));
  });
});
