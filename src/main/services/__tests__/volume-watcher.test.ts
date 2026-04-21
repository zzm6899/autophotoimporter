import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => fn,
}));

vi.mock('node:fs', () => ({
  watch: vi.fn(() => ({ close: vi.fn() })),
  existsSync: vi.fn(() => true),
}));

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
  stat: vi.fn(),
}));

import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { listVolumes } from '../volume-watcher';

const mockReaddir = vi.mocked(readdir);
const mockExistsSync = vi.mocked(existsSync);
const mockExecFile = vi.mocked(execFile);

// These assertions exercise the macOS /Volumes + diskutil code path; on
// Windows/Linux CI runners, listVolumes() takes a different branch that
// doesn't touch any of the mocked primitives. Skip rather than invent a
// brittle process.platform override.
const runOnMac = process.platform === 'darwin' ? describe : describe.skip;

runOnMac('listVolumes (macOS)', () => {
  beforeEach(() => {
    mockExistsSync.mockReturnValue(true);
    // Default detectDcim to a directory that has no DCIM entry. Tests
    // that care about readdir output override this.
    mockReaddir.mockResolvedValue(['not-dcim'] as never);
  });

  it('returns empty array when /Volumes does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    const result = await listVolumes();
    expect(result).toEqual([]);
  });

  it('filters out system volumes (Macintosh HD)', async () => {
    mockReaddir.mockResolvedValue(['Macintosh HD', 'Macintosh HD - Data', 'SD Card'] as any);
    mockExecFile.mockResolvedValue({
      stdout: '<key>Internal</key>\n\t<false/>\n<key>Removable</key>\n\t<true/>\n<key>Network</key>\n\t<false/>',
      stderr: '',
    } as any);

    const result = await listVolumes();
    // Only SD Card should be checked
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('includes external removable volumes', async () => {
    mockReaddir.mockResolvedValue(['EOS_DIGITAL'] as any);
    mockExecFile.mockResolvedValue({
      stdout: '<key>Internal</key>\n\t<false/>\n<key>Removable</key>\n\t<true/>\n<key>Network</key>\n\t<false/>\n<key>TotalSize</key>\n<integer>32000000000</integer>\n<key>FreeSpace</key>\n<integer>16000000000</integer>',
      stderr: '',
    } as any);

    const result = await listVolumes();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('EOS_DIGITAL');
    expect(result[0].isExternal).toBe(true);
  });

  it('excludes network volumes', async () => {
    mockReaddir.mockResolvedValue(['NAS_Share'] as any);
    mockExecFile.mockResolvedValue({
      stdout: '<key>Internal</key>\n\t<false/>\n<key>Network</key>\n\t<true/>',
      stderr: '',
    } as any);

    const result = await listVolumes();
    expect(result).toHaveLength(0);
  });

  it('parses diskutil output for size info', async () => {
    mockReaddir.mockResolvedValue(['SD'] as any);
    mockExecFile.mockResolvedValue({
      stdout: '<key>Internal</key>\n\t<false/>\n<key>RemovableMedia</key>\n\t<true/>\n<key>Network</key>\n\t<false/>\n<key>TotalSize</key>\n<integer>64000000000</integer>\n<key>APFSContainerFree</key>\n<integer>32000000000</integer>',
      stderr: '',
    } as any);

    const result = await listVolumes();
    expect(result[0].totalSize).toBe(64000000000);
    expect(result[0].freeSpace).toBe(32000000000);
  });

  it('handles diskutil failure gracefully', async () => {
    mockReaddir.mockResolvedValue(['BadDrive'] as any);
    mockExecFile.mockRejectedValue(new Error('diskutil failed'));

    const result = await listVolumes();
    expect(result).toHaveLength(0);
  });
});
