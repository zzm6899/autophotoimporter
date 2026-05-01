#!/usr/bin/env node

import { basename } from 'node:path';
import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);

function getArg(name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasArg(name) {
  return args.includes(`--${name}`);
}

const endpoint = getArg('endpoint') || process.env.UPDATE_ADMIN_ENDPOINT;
const token = getArg('token') || process.env.UPDATE_ADMIN_API_TOKEN;
const version = getArg('version');
const platform = getArg('platform');
const releaseName = getArg('release-name') || version;
const artifactUrl = getArg('artifact-url');
const filePath = getArg('file');
const releaseUrl = getArg('release-url');
const releaseNotes = getArg('notes') || '';
const channel = getArg('channel') || 'stable';
const rolloutState = getArg('rollout') || 'draft';
const uploadOnly = hasArg('upload-only');

if (!endpoint || !token || !platform || (!artifactUrl && !filePath) || (!uploadOnly && !version)) {
  console.error('Usage: node scripts/publish-update-release.mjs --endpoint https://admin.keptra.z2hs.au --token <token> --platform windows (--artifact-url https://keptra.z2hs.au/... | --file ./artifact.exe) [--version 1.1.1] [--release-name "..."] [--release-url "..."] [--notes "..."] [--channel stable] [--rollout live] [--upload-only]');
  process.exit(1);
}

function endpointCandidates(input) {
  const trimmed = input.replace(/\/$/, '');
  const candidates = [trimmed];

  try {
    const parsed = new URL(trimmed);
    const hostname = parsed.hostname.toLowerCase();
    const fallbacks = [];

    if (hostname.endsWith('.culler.z2hs.au')) {
      fallbacks.push(hostname.replace('.culler.z2hs.au', '.keptra.z2hs.au'));
      fallbacks.push('admin.keptra.z2hs.au');
      fallbacks.push('keptra.z2hs.au');
    } else if (hostname === 'culler.z2hs.au') {
      fallbacks.push('keptra.z2hs.au');
      fallbacks.push('admin.keptra.z2hs.au');
    }

    for (const fallbackHostname of fallbacks) {
      const fallback = new URL(parsed);
      fallback.hostname = fallbackHostname;
      const normalized = fallback.toString().replace(/\/$/, '');
      if (!candidates.includes(normalized)) candidates.push(normalized);
    }
  } catch {
    // Keep the original endpoint; fetch will report the actual error.
  }

  return candidates;
}

async function fetchWithEndpointFallback(path, options) {
  let lastError;
  for (const baseUrl of endpointCandidates(endpoint)) {
    const url = `${baseUrl}${path}`;
    try {
      const response = await fetch(url, options);
      if (baseUrl !== endpoint.replace(/\/$/, '')) {
        console.log(`[publish-update-release] used fallback endpoint ${baseUrl}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      console.warn(`[publish-update-release] endpoint failed: ${baseUrl} (${error.message})`);
    }
  }
  throw lastError;
}

let resolvedArtifactUrl = artifactUrl;

if (!resolvedArtifactUrl && filePath) {
  const filename = basename(filePath);
  const buffer = await readFile(filePath);
  const uploadResponse = await fetchWithEndpointFallback(
    `/admin/api/artifacts/upload?platform=${encodeURIComponent(platform)}&filename=${encodeURIComponent(filename)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
      },
      body: buffer,
    },
  );

  if (!uploadResponse.ok) {
    console.error(await uploadResponse.text());
    process.exit(1);
  }

  const uploadData = await uploadResponse.json();
  resolvedArtifactUrl = uploadData.artifactUrl;
}

if (uploadOnly) {
  console.log(resolvedArtifactUrl);
  process.exit(0);
}

const response = await fetchWithEndpointFallback('/admin/api/releases/import', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    version,
    platform,
    releaseName,
    artifactUrl: resolvedArtifactUrl,
    releaseUrl,
    releaseNotes,
    channel,
    rolloutState,
  }),
});

if (!response.ok) {
  console.error(await response.text());
  process.exit(1);
}

const data = await response.json();
console.log(`Release imported with id ${data.id}`);
