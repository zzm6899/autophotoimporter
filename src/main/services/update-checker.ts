import { app, net } from 'electron';
import type { UpdateReleaseSummary, UpdateState } from '../../shared/types';
import { getDeviceIdentity } from './device-id';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { log } from '../logger';

const UPDATE_BASE_URL = 'https://updates.culler.z2hs.au';
const UPDATE_ALLOWED_HOSTS = new Set(['updates.culler.z2hs.au']);
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

async function fetchJson<T>(url: string, licenseKey?: string): Promise<T> {
  const { controller, clear } = createTimeoutController();
  try {
    const device = await getDeviceIdentity();
    const response = await net.fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'photo-importer',
        'X-Device-Id': device.id,
        'X-Device-Name': device.name,
        ...(licenseKey ? { 'X-License-Key': licenseKey } : {}),
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Update service returned ${response.status}`);
    }

    return await response.json() as T;
  } finally {
    clear();
  }
}

export async function checkForUpdate(licenseKey?: string): Promise<UpdateState> {
  const version = currentVersion();
  const platform = currentPlatform();
  const checkedAt = new Date().toISOString();

  try {
    const url = `${UPDATE_BASE_URL}/api/v1/app/update?platform=${encodeURIComponent(platform)}&version=${encodeURIComponent(version)}&channel=stable`;
    const data = await fetchJson<CheckResponse>(url, licenseKey);

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

    if (!isAllowedUpdateUrl(data.feedUrl) || !isAllowedUpdateUrl(data.downloadUrl) || !isAllowedUpdateUrl(data.releaseUrl)) {
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
      releaseUrl: data.releaseUrl,
      downloadUrl: data.downloadUrl,
      feedUrl: data.feedUrl,
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
      releaseUrl: data.releaseUrl,
      downloadUrl: data.downloadUrl,
      feedUrl: data.feedUrl,
      lastCheckedAt: checkedAt,
      message: data.message,
    };
  } catch (err) {
    logUpdateDiagnostic('check-failed', { message: err instanceof Error ? err.message : 'unknown-error' });
    return {
      status: 'error',
      currentVersion: version,
      lastCheckedAt: checkedAt,
      message: err instanceof Error ? err.message : 'Could not reach the update service.',
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
