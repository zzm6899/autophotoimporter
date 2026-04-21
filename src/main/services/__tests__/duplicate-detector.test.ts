import { describe, it, expect, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
}));

import { stat } from 'node:fs/promises';
import { isDuplicate } from '../duplicate-detector';

const mockStat = vi.mocked(stat);

describe('isDuplicate', () => {
  it('returns true when file exists with same size', async () => {
    mockStat.mockResolvedValue({ size: 5000 } as any);
    expect(await isDuplicate('/dest', '2024/photo.jpg', 5000)).toBe(true);
  });

  it('returns false when file exists with different size', async () => {
    mockStat.mockResolvedValue({ size: 9999 } as any);
    expect(await isDuplicate('/dest', '2024/photo.jpg', 5000)).toBe(false);
  });

  it('returns false when file not found', async () => {
    mockStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    expect(await isDuplicate('/dest', '2024/photo.jpg', 5000)).toBe(false);
  });

  it('returns false on stat error', async () => {
    mockStat.mockRejectedValue(new Error('permission denied'));
    expect(await isDuplicate('/dest', '2024/photo.jpg', 5000)).toBe(false);
  });

  it('constructs correct path from destRoot and destRelativePath', async () => {
    mockStat.mockResolvedValue({ size: 100 } as any);
    await isDuplicate('/dest/root', 'sub/dir/photo.jpg', 100);
    expect(mockStat).toHaveBeenCalledWith('/dest/root/sub/dir/photo.jpg');
  });
});
