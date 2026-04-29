import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
const getDeviceIdentityMock = vi.fn();

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.2.0',
    getPath: () => '/tmp/userData',
  },
  net: {
    fetch: (...args: unknown[]) => fetchMock(...args),
  },
}));

vi.mock('../device-id', () => ({
  getDeviceIdentity: () => getDeviceIdentityMock(),
}));

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
}));

import { checkForUpdate, fetchUpdateHistory } from '../update-checker';

describe('update-checker', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    getDeviceIdentityMock.mockReset();
    getDeviceIdentityMock.mockResolvedValue({ id: 'dev-1', name: 'test' });
  });

  it('returns error for malformed metadata without latestVersion', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ allowed: true }) });
    const result = await checkForUpdate();
    expect(result.status).toBe('error');
    expect(result.message).toContain('malformed');
  });

  it('blocks downgrade attempts by returning up-to-date', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ allowed: true, latestVersion: '1.1.9' }) });
    const result = await checkForUpdate();
    expect(result.status).toBe('up-to-date');
    expect(result.latestVersion).toBe('1.1.9');
  });

  it('fails trust checks for non-allowlisted URLs', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ allowed: true, latestVersion: '1.3.0', downloadUrl: 'http://evil.example.com/a.exe' }) });
    const result = await checkForUpdate();
    expect(result.status).toBe('error');
    expect(result.message).toContain('trust checks');
  });

  it('handles unreachable feed as error', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const result = await checkForUpdate();
    expect(result.status).toBe('error');
    expect(result.message).toContain('network down');
  });

  it('skips malformed release history entries', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ releases: [{ version: '1.2.2' }, { releaseName: 'bad' }, { version: '1.2.2' }] }) });
    const history = await fetchUpdateHistory();
    expect(history).toHaveLength(1);
    expect(history[0]?.version).toBe('1.2.2');
  });
});
