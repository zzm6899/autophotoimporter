#!/usr/bin/env node

const hosts = [
  process.env.KEPTRA_UPDATE_BASE_URL || 'https://keptra.z2hs.au',
  process.env.KEPTRA_UPDATE_FALLBACK_URL || 'https://updates.keptra.z2hs.au',
  process.env.CULLER_UPDATE_LEGACY_URL || 'https://updates.culler.z2hs.au',
];

const platform = process.env.UPDATE_PLATFORM || 'windows';
const version = process.env.UPDATE_FROM_VERSION || '1.4.0';
const channel = process.env.UPDATE_CHANNEL || 'stable';

function updateUrl(base) {
  const url = new URL('/api/v1/app/update', base);
  url.searchParams.set('platform', platform);
  url.searchParams.set('version', version);
  url.searchParams.set('channel', channel);
  return url;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'keptra-release-smoke/1.0' },
    redirect: 'follow',
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (_error) {
    throw new Error(`${url} returned non-JSON (${response.status})`);
  }
  if (!response.ok) {
    throw new Error(`${url} failed with ${response.status}: ${text.slice(0, 220)}`);
  }
  return { response, body };
}

async function probeDownload(url) {
  const response = await fetch(url, {
    method: 'HEAD',
    redirect: 'follow',
    headers: { 'user-agent': 'keptra-release-smoke/1.0' },
  });
  if (!response.ok) {
    throw new Error(`download HEAD failed with ${response.status}`);
  }
  const length = Number(response.headers.get('content-length') || 0);
  return {
    finalUrl: response.url,
    contentLength: Number.isFinite(length) ? length : 0,
    contentType: response.headers.get('content-type') || '',
  };
}

const failures = [];
const results = [];

for (const base of hosts) {
  const url = updateUrl(base);
  try {
    const { body } = await fetchJson(url);
    const allowed = body?.allowed === true;
    const latestVersion = body?.latestVersion || 'unknown';
    const downloadUrl = body?.downloadUrl || body?.artifactUrl || body?.url || '';
    if (!allowed) {
      throw new Error(`update check did not allow upgrade/test path: ${JSON.stringify(body).slice(0, 220)}`);
    }
    if (!downloadUrl) {
      throw new Error('update metadata did not include a downloadable URL');
    }
    const download = await probeDownload(downloadUrl);
    if (download.contentLength > 0 && download.contentLength < 1024 * 1024) {
      throw new Error(`installer content-length looks too small: ${download.contentLength}`);
    }
    results.push({
      host: base,
      latestVersion,
      downloadUrl,
      finalUrl: download.finalUrl,
      contentLength: download.contentLength,
      contentType: download.contentType,
    });
  } catch (error) {
    failures.push({ host: base, error: error instanceof Error ? error.message : String(error) });
  }
}

console.log(`Keptra release smoke (${platform} ${version} -> ${channel})`);
for (const result of results) {
  const size = result.contentLength > 0 ? `${Math.round(result.contentLength / 1024 / 1024)} MB` : 'unknown size';
  console.log(`OK ${result.host} latest=${result.latestVersion} installer=${size}`);
  console.log(`   ${result.finalUrl}`);
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL ${failure.host}: ${failure.error}`);
  }
  process.exitCode = 1;
}
