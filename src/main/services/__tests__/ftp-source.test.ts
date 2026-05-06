import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  stat: vi.fn(),
  access: vi.fn(),
  list: vi.fn(),
  downloadTo: vi.fn(),
  close: vi.fn(),
  jobInstances: [] as Array<{ start: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>; fail: ReturnType<typeof vi.fn> }>,
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

vi.mock('../job-controller', () => ({
  JobController: class MockJobController {
    start = vi.fn();
    cancel = vi.fn();
    fail = vi.fn();

    constructor() {
      mocks.jobInstances.push(this);
    }
  },
}));

import { Client, FileType } from 'basic-ftp';
import { mirrorFtp, probeFtp } from '../ftp-source';
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
    mocks.jobInstances.length = 0;
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

describe('probeFtp', () => {
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
    mocks.list.mockResolvedValue([
      { name: 'IMG_001.JPG', type: FileType.File, size: 1234 },
    ]);
    mocks.jobInstances.length = 0;
  });

  it('does not fail the newer probe job when an older probe errors later', async () => {
    let rejectFirst!: (error: Error) => void;
    let resolveSecond!: () => void;
    mocks.access
      .mockReturnValueOnce(new Promise((_resolve, reject) => { rejectFirst = reject; }))
      .mockReturnValueOnce(new Promise<void>((resolve) => { resolveSecond = resolve; }));

    const first = probeFtp(config);
    const second = probeFtp(config);

    expect(mocks.jobInstances[0].cancel).toHaveBeenCalledOnce();
    resolveSecond();
    await expect(second).resolves.toMatchObject({ ok: true, fileCount: 1, totalBytes: 1234 });

    rejectFirst(new Error('old connection failed'));
    await expect(first).resolves.toMatchObject({ ok: false, error: 'old connection failed' });

    expect(mocks.jobInstances[0].fail).toHaveBeenCalledWith('old connection failed');
    expect(mocks.jobInstances[1].fail).not.toHaveBeenCalled();
  });
});
