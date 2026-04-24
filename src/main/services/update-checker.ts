import { app, net } from 'electron';
import type { UpdateReleaseSummary, UpdateState } from '../../shared/types';

const UPDATE_BASE_URL = 'https://updates.culler.z2hs.au';
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

async function fetchJson<T>(url: string, licenseKey?: string): Promise<T> {
  const { controller, clear } = createTimeoutController();
  try {
    const response = await net.fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'photo-importer',
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

    if (!data.latestVersion || !isNewer(version, data.latestVersion)) {
      return {
        status: 'up-to-date',
        currentVersion: version,
        latestVersion: data.latestVersion ?? version,
        lastCheckedAt: checkedAt,
        message: data.message || 'You already have the latest version.',
      };
    }

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
  return (data.releases ?? []).map((release) => ({
    version: release.version,
    releaseName: release.releaseName ?? release.version,
    notes: release.notes,
    publishedAt: release.publishedAt,
    channel: release.channel,
  }));
}
