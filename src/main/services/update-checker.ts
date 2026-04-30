import { app, net } from 'electron';
import type { UpdateReleaseSummary, UpdateState } from '../../shared/types';
import { getDeviceIdentity } from './device-id';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { log } from '../logger';

const UPDATE_BASE_URL = 'https://keptra.z2hs.au';
const UPDATE_FALLBACK_BASE_URL = 'https://updates.keptra.z2hs.au';
const UPDATE_ALLOWED_HOSTS = new Set(['keptra.z2hs.au', 'updates.keptra.z2hs.au', 'admin.keptra.z2hs.au']);
const UPDATE_ALLOWED_SCHEMES = new Set(['https:']);
const TIMEOUT_MS = 10_000;

type CheckResponse = {
  allowed: boolean;
  currentVersion: string;
  latestVersion?: string;
  releaseName?: string;
  releaseNotes?: string;
  releaseDate?: string;
  releaseUrl?: string;
  downloadUrl?: string;
  feedUrl?: string;
  message?: string;
};

type HistoryResponse = {
  releases?: Array<{
    version: string;
    releaseName?: string;
    notes?: string;
    publishedAt?: string;
    channel?: string;
  }>;
};

type UpdateFetchResponse = {
  ok: boolean;
  status: number;
  headers?: {
    get(name: string): string | null;
  };
  text?: () => Promise<string>;
  json?: () => Promise<unknown>;
};

export interface PersistedUpdateMetadata {
  latestVersion: string;
  releaseName?: string;
  releaseDate?: string;
  releaseUrl?: string;
  downloadUrl?: string;
  feedUrl?: string;
  savedAt: string;
}

function logUpdateDiagnostic(event: string, details: Record<string, unknown>) {
  log.info('[updates]', JSON.stringify({ event, ...details }));
}

class UpdateServiceMetadataError extends Error {
  constructor(message: string, readonly diagnostic: Record<string, unknown>) {
    super(message);
    this.name = 'UpdateServiceMetadataError';
  }
}

function isNewer(local: string, remote: string): boolean {
  const lp = local.split('.').map(Number);
  const rp = remote.split('.').map(Number);
  for (let i = 0; i < Math.max(lp.length, rp.length); i++) {
    const l = lp[i] ?? 0;
    const r = rp[i] ?? 0;
    if (r > l) return true;
    if (r < l) return false;
  }
  return false;
}

function createTimeoutController() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  return {
    controller,
    clear: () => clearTimeout(timer),
  };
}

function currentVersion() {
  return app.getVersion();
}

function currentPlatform() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return process.platform;
}

function isAllowedUpdateUrl(value?: string): boolean {
  if (!value) return true;
  try {
    const parsed = new URL(value);
    return UPDATE_ALLOWED_SCHEMES.has(parsed.protocol) && UPDATE_ALLOWED_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function normalizeUpdateUrl(value?: string): string | undefined {
  if (!value) return undefined;
  return value
    .replace(/^https:\/\/updates\.culler\.z2hs\.au/i, UPDATE_BASE_URL)
    .replace(/^https:\/\/admin\.culler\.z2hs\.au/i, UPDATE_BASE_URL)
    .replace(/^https:\/\/culler\.z2hs\.au/i, UPDATE_BASE_URL)
    .replace(/^https:\/\/updates\.keptra\.z2hs\.au/i, UPDATE_BASE_URL)
    .replace(/^https:\/\/admin\.keptra\.z2hs\.au/i, UPDATE_BASE_URL);
}

function getUpdateMetadataPath() {
  return path.join(app.getPath('userData'), 'update-metadata.json');
}

async function writeLastKnownGoodUpdateMetadata(data: PersistedUpdateMetadata) {
  const metadataPath = getUpdateMetadataPath();
  await mkdir(path.dirname(metadataPath), { recursive: true });
  await writeFile(metadataPath, JSON.stringify(data, null, 2), 'utf-8');
}

export async function readLastKnownGoodUpdateMetadata(): Promise<PersistedUpdateMetadata | null> {
  try {
    const raw = await readFile(getUpdateMetadataPath(), 'utf-8');
    return JSON.parse(raw) as PersistedUpdateMetadata;
  } catch {
    return null;
  }
}

function getResponseHeader(response: UpdateFetchResponse, name: string): string | null {
  try {
    return response.headers?.get(name) ?? null;
  } catch {
    return null;
  }
}

async function readUpdateJson<T>(response: UpdateFetchResponse): Promise<T> {
  const contentType = getResponseHeader(response, 'content-type') ?? '';

  if (typeof response.text === 'function') {
    const raw = await response.text();
    const trimmed = raw.trim();

    if (!trimmed) {
      throw new UpdateServiceMetadataError('Update service returned an empty response.', {
        reason: 'empty-json-response',
        contentType,
        bytes: raw.length,
      });
    }

    try {
      return JSON.parse(trimmed) as T;
    } catch {
      throw new UpdateServiceMetadataError('Update service returned invalid metadata JSON.', {
        reason: 'invalid-json-response',
        contentType,
        bytes: raw.length,
      });
    }
  }

  if (typeof response.json === 'function') {
    try {
      return await response.json() as T;
    } catch {
      throw new UpdateServiceMetadataError('Update service returned invalid metadata JSON.', {
        reason: 'invalid-json-response',
        contentType,
      });
    }
  }

  throw new UpdateServiceMetadataError('Update service response could not be read.', {
    reason: 'unreadable-response',
    contentType,
  });
}

async function fetchJson<T>(url: string, licenseKey?: string): Promise<T> {
  const { controller, clear } = createTimeoutController();
  try {
    const device = await getDeviceIdentity();
    const response = await net.fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'keptra',
        'X-Device-Id': device.id,
        'X-Device-Name': device.name,
        ...(licenseKey ? { 'X-License-Key': licenseKey } : {}),
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Update service returned ${response.status}`);
    }

    return await readUpdateJson<T>(response);
  } finally {
    clear();
  }
}

function describeUpdateNetworkError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err || '');
  if (
    message.includes('ERR_SSL_PROTOCOL_ERROR') ||
    message.includes('ERR_CERT') ||
    message.toLowerCase().includes('ssl') ||
    message.toLowerCase().includes('tls')
  ) {
    return 'Could not establish a secure connection to the update service. Please try again in a moment.';
  }
  return message || 'Could not reach the update service.';
}

export async function checkForUpdate(licenseKey?: string): Promise<UpdateState> {
  const version = currentVersion();
  const platform = currentPlatform();
  const checkedAt = new Date().toISOString();
  let lastError: unknown;

  for (const baseUrl of [UPDATE_BASE_URL, UPDATE_FALLBACK_BASE_URL]) {
    try {
      const url = `${baseUrl}/api/v1/app/update?platform=${encodeURIComponent(platform)}&version=${encodeURIComponent(version)}&channel=stable`;
      const data = await fetchJson<CheckResponse>(url, licenseKey);
      const releaseUrl = normalizeUpdateUrl(data.releaseUrl);
      const downloadUrl = normalizeUpdateUrl(data.downloadUrl);
      const feedUrl = normalizeUpdateUrl(data.feedUrl);

      if (!data.allowed) {
        return {
          status: 'denied',
          currentVersion: version,
          lastCheckedAt: checkedAt,
          message: data.message || 'This install is not entitled to updates.',
        };
      }

      if (!data.latestVersion) {
        logUpdateDiagnostic('metadata-malformed', { reason: 'missing-latest-version' });
        return {
          status: 'error',
          currentVersion: version,
          lastCheckedAt: checkedAt,
          message: 'Update metadata is malformed. Showing your last known update state.',
        };
      }

      if (!isNewer(version, data.latestVersion)) {
        if (data.latestVersion !== version) {
          logUpdateDiagnostic('downgrade-blocked', { currentVersion: version, offeredVersion: data.latestVersion });
        }
        return {
          status: 'up-to-date',
          currentVersion: version,
          latestVersion: data.latestVersion ?? version,
          lastCheckedAt: checkedAt,
          message: data.message || 'You already have the latest version.',
        };
      }

      if (!isAllowedUpdateUrl(feedUrl) || !isAllowedUpdateUrl(downloadUrl) || !isAllowedUpdateUrl(releaseUrl)) {
        logUpdateDiagnostic('metadata-malformed', { reason: 'url-not-allowlisted' });
        return {
          status: 'error',
          currentVersion: version,
          lastCheckedAt: checkedAt,
          message: 'Update metadata failed trust checks. Please contact support.',
        };
      }

      await writeLastKnownGoodUpdateMetadata({
        latestVersion: data.latestVersion,
        releaseName: data.releaseName,
        releaseDate: data.releaseDate,
        releaseUrl,
        downloadUrl,
        feedUrl,
        savedAt: checkedAt,
      });
      logUpdateDiagnostic('metadata-saved', { latestVersion: data.latestVersion, platform });

      return {
        status: 'available',
        currentVersion: version,
        latestVersion: data.latestVersion,
        releaseName: data.releaseName,
        releaseNotes: data.releaseNotes,
        releaseDate: data.releaseDate,
        releaseUrl,
        downloadUrl,
        feedUrl,
        lastCheckedAt: checkedAt,
        message: data.message,
      };
    } catch (err) {
      lastError = err;
      logUpdateDiagnostic('check-failed', {
        baseUrl,
        message: err instanceof Error ? err.message : 'unknown-error',
        ...(err instanceof UpdateServiceMetadataError ? err.diagnostic : {}),
      });
    }
  }

  {
    const err = lastError;
    logUpdateDiagnostic('check-failed', {
      message: err instanceof Error ? err.message : 'unknown-error',
      ...(err instanceof UpdateServiceMetadataError ? err.diagnostic : {}),
    });
    return {
      status: 'error',
      currentVersion: version,
      lastCheckedAt: checkedAt,
      message: describeUpdateNetworkError(err),
    };
  }
}

export async function fetchUpdateHistory(licenseKey?: string): Promise<UpdateReleaseSummary[]> {
  const platform = currentPlatform();
  const url = `${UPDATE_BASE_URL}/api/v1/app/history?platform=${encodeURIComponent(platform)}&channel=stable&limit=8`;
  const data = await fetchJson<HistoryResponse>(url, licenseKey);
  const unique = new Map<string, UpdateReleaseSummary>();
  for (const release of data.releases ?? []) {
    if (!release.version) {
      logUpdateDiagnostic('history-malformed-entry', { reason: 'missing-version' });
      continue;
    }
    if (!unique.has(release.version)) {
      unique.set(release.version, {
        version: release.version,
        releaseName: release.releaseName ?? release.version,
        notes: release.notes,
        publishedAt: release.publishedAt,
        channel: release.channel,
      });
    }
  }
  return Array.from(unique.values());
}
