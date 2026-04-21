import { net, app } from 'electron';
import type { UpdateInfo } from '../../shared/types';

const RELEASES_URL = 'https://api.github.com/repos/juanmnl/importer/releases/latest';
const TIMEOUT_MS = 10_000;

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

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await net.fetch(RELEASES_URL, {
      headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'photo-importer' },
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) return null;

    const data = await response.json();
    const tagName: string = data.tag_name ?? '';
    const latestVersion = tagName.replace(/^v/, '');
    const currentVersion = app.getVersion();

    if (!latestVersion || !isNewer(currentVersion, latestVersion)) {
      return null;
    }

    return {
      currentVersion,
      latestVersion,
      releaseUrl: data.html_url ?? `https://github.com/juanmnl/importer/releases/tag/${tagName}`,
      releaseName: data.name ?? tagName,
    };
  } catch {
    return null;
  }
}
