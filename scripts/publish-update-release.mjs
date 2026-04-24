#!/usr/bin/env node

const args = process.argv.slice(2);

function getArg(name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

const endpoint = getArg('endpoint') || process.env.UPDATE_ADMIN_ENDPOINT;
const token = getArg('token') || process.env.UPDATE_ADMIN_API_TOKEN;
const version = getArg('version');
const platform = getArg('platform');
const releaseName = getArg('release-name') || version;
const artifactUrl = getArg('artifact-url');
const releaseUrl = getArg('release-url');
const releaseNotes = getArg('notes') || '';
const channel = getArg('channel') || 'stable';
const rolloutState = getArg('rollout') || 'draft';

if (!endpoint || !token || !version || !platform || !artifactUrl) {
  console.error('Usage: node scripts/publish-update-release.mjs --endpoint https://admin.culler.z2hs.au --token <token> --version 1.1.1 --platform windows --artifact-url https://updates.culler.z2hs.au/... [--release-name "..."] [--release-url "..."] [--notes "..."] [--channel stable] [--rollout live]');
  process.exit(1);
}

const response = await fetch(`${endpoint.replace(/\/$/, '')}/admin/api/releases/import`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    version,
    platform,
    releaseName,
    artifactUrl,
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
