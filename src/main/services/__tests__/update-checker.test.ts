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

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number; contentType?: string }) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const contentType = init?.contentType ?? 'application/json';

  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    headers: {
      get: (name: string) => name.toLowerCase() === 'content-type' ? contentType : null,
    },
    text: async () => raw,
    json: async () => JSON.parse(raw),
  };
}

describe('update-checker', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    getDeviceIdentityMock.mockReset();
    getDeviceIdentityMock.mockResolvedValue({ id: 'dev-1', name: 'test' });
  });

  it('returns error for malformed metadata without latestVersion', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ allowed: true }));
    const result = await checkForUpdate();
    expect(result.status).toBe('error');
    expect(result.message).toContain('malformed');
  });

  it('checks the live Keptra update host', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ allowed: true, latestVersion: '1.2.0' }));
    await checkForUpdate();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('https://keptra.z2hs.au/api/v1/app/update');
  });

  it('returns a clear error for an empty update response', async () => {
    fetchMock.mockResolvedValue(jsonResponse(''));
    const result = await checkForUpdate();
    expect(result.status).toBe('error');
    expect(result.message).toContain('empty response');
    expect(result.message).not.toContain('Unexpected end');
  });

  it('returns a clear error for invalid update metadata JSON', async () => {
    fetchMock.mockResolvedValue(jsonResponse('{'));
    const result = await checkForUpdate();
    expect(result.status).toBe('error');
    expect(result.message).toContain('invalid metadata JSON');
    expect(result.message).not.toContain('Unexpected end');
  });

  it('blocks downgrade attempts by returning up-to-date', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ allowed: true, latestVersion: '1.1.9' }));
    const result = await checkForUpdate();
    expect(result.status).toBe('up-to-date');
    expect(result.latestVersion).toBe('1.1.9');
  });

  it('fails trust checks for non-allowlisted URLs', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ allowed: true, latestVersion: '1.3.0', downloadUrl: 'http://evil.example.com/a.exe' }));
    const result = await checkForUpdate();
    expect(result.status).toBe('error');
    expect(result.message).toContain('trust checks');
  });

  it('normalizes legacy public release URLs to the Keptra host', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      allowed: true,
      latestVersion: '1.3.0',
      releaseUrl: 'https://updates.culler.z2hs.au/releases/1.3.0',
      downloadUrl: 'https://updates.culler.z2hs.au/api/v1/app/download/1?token=abc',
      feedUrl: 'https://updates.culler.z2hs.au/artifacts/windows',
    }));
    const result = await checkForUpdate();
    expect(result.status).toBe('available');
    expect(result.releaseUrl).toBe('https://keptra.z2hs.au/releases/1.3.0');
    expect(result.downloadUrl).toBe('https://keptra.z2hs.au/api/v1/app/download/1?token=abc');
    expect(result.feedUrl).toBe('https://keptra.z2hs.au/artifacts/windows');
  });

  it('handles unreachable feed as error', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const result = await checkForUpdate();
    expect(result.status).toBe('error');
    expect(result.message).toContain('network down');
  });

  it('tries the updates subdomain when the primary update host fails', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('net::ERR_SSL_PROTOCOL_ERROR'))
      .mockResolvedValueOnce(jsonResponse({ allowed: true, latestVersion: '1.2.0' }));
    const result = await checkForUpdate();
    expect(result.status).toBe('up-to-date');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('https://keptra.z2hs.au/api/v1/app/update');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('https://updates.keptra.z2hs.au/api/v1/app/update');
  });

  it('tries legacy culler update hosts before giving up', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('net::ERR_SSL_PROTOCOL_ERROR'))
      .mockRejectedValueOnce(new Error('net::ERR_SSL_PROTOCOL_ERROR'))
      .mockRejectedValueOnce(new Error('net::ERR_SSL_PROTOCOL_ERROR'))
      .mockResolvedValueOnce(jsonResponse({ allowed: true, latestVersion: '1.2.0' }));
    const result = await checkForUpdate();
    expect(result.status).toBe('up-to-date');
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain('https://culler.z2hs.au/api/v1/app/update');
    expect(String(fetchMock.mock.calls[3]?.[0])).toContain('https://updates.culler.z2hs.au/api/v1/app/update');
  });

  it('shows a friendly message when secure update checks fail', async () => {
    fetchMock.mockRejectedValue(new Error('net::ERR_SSL_PROTOCOL_ERROR'));
    const result = await checkForUpdate();
    expect(result.status).toBe('error');
    expect(result.message).toContain('secure connection');
    expect(result.message).not.toContain('ERR_SSL_PROTOCOL_ERROR');
  });

  it('skips malformed release history entries', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ releases: [{ version: '1.2.2' }, { releaseName: 'bad' }, { version: '1.2.2' }] }));
    const history = await fetchUpdateHistory();
    expect(history).toHaveLength(1);
    expect(history[0]?.version).toBe('1.2.2');
  });

  it('uses the public releases endpoint when fetching history without a license', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ releases: [{ version: '1.2.3' }] }));
    await fetchUpdateHistory();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/v1/app/releases');
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('/api/v1/app/history');
  });

  it('falls back to public release history when licensed history is forbidden', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'Forbidden' }, { ok: false, status: 403 }))
      .mockResolvedValueOnce(jsonResponse({ releases: [{ version: '1.2.4' }] }));
    const history = await fetchUpdateHistory('bad-license');
    expect(history[0]?.version).toBe('1.2.4');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/v1/app/history');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/api/v1/app/releases');
  });
});
