import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  stat: vi.fn(),
  access: vi.fn(),
  list: vi.fn(),
  downloadTo: vi.fn(),
  close: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/user-data'),
  },
}));

vi.mock('node:fs/promises', () => ({
  mkdir: mocks.mkdir,
  stat: mocks.stat,
}));

vi.mock('basic-ftp', () => ({
  FileType: {
    File: 1,
    Directory: 2,
  },
  Client: vi.fn(),
}));

import { Client, FileType } from 'basic-ftp';
import { mirrorFtp } from '../ftp-source';
import type { FtpConfig } from '../../../shared/types';

const config: FtpConfig = {
  host: 'camera.local',
  port: 21,
  user: 'user',
  password: 'pass',
  secure: false,
  remotePath: '/DCIM',
};

describe('mirrorFtp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Client).mockImplementation(function MockClient() {
      return {
      access: mocks.access,
      list: mocks.list,
      downloadTo: mocks.downloadTo,
      close: mocks.close,
      };
    } as unknown as typeof Client);
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.stat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    mocks.access.mockResolvedValue(undefined);
    mocks.list.mockResolvedValue([
      { name: 'IMG_001.JPG', type: FileType.File, size: 1234 },
    ]);
  });

  it('throws after failed downloads instead of returning a partial mirror as success', async () => {
    mocks.downloadTo.mockRejectedValue(new Error('network dropped'));
    const onProgress = vi.fn();

    await expect(mirrorFtp(config, onProgress)).rejects.toThrow('FTP mirror failed for 1/1 file(s)');

    expect(onProgress).toHaveBeenCalledWith(1, 1, 'IMG_001.JPG');
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('returns the staging directory when every download succeeds', async () => {
    mocks.downloadTo.mockResolvedValue(undefined);

    await expect(mirrorFtp(config, vi.fn())).resolves.toContain('ftp-cache');
  });
});
