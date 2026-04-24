#!/usr/bin/env node
/**
 * publish-models.mjs
 *
 * Creates a stable "models-v1" GitHub release on zzm6899/importer and
 * uploads the ONNX culling models as release assets.
 *
 * Run once (or whenever you want to update the models):
 *
 *   node scripts/publish-models.mjs --token ghp_xxxxxxxxxxxx
 *   # or
 *   GH_TOKEN=ghp_xxxxxxxxxxxx node scripts/publish-models.mjs
 *
 * The script is idempotent:
 *   - If the release already exists it reuses it.
 *   - If an asset with the same name already exists it deletes it first,
 *     then re-uploads (so you can re-run to update a model file).
 *
 * After a successful run the model URLs in model-downloader.ts will be live.
 */

import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, unlink, rename } from 'node:fs/promises';
import { get } from 'node:https';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CACHE_DIR = join(ROOT, 'models');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REPO = 'zzm6899/importer';
const TAG  = 'models-v1';
const RELEASE_NAME = 'Culling Vision Models';
const RELEASE_BODY =
  'Stable ONNX review-model assets for Photo Importer.\n\n' +
  '- `version-RFB-640.onnx` - UltraFace RFB face detector (~1.6 MB)\n' +
  '- `w600k_mbf.onnx` - MobileFaceNet WebFace600K embeddings (~5 MB)\n\n' +
  '- `ssd_mobilenet_v1_12.onnx` - SSD MobileNet person detector (~28 MB)\n\n' +
  'Do not delete this release - the app downloads models from here on first launch.';

const MODELS = [
  {
    name: 'version-RFB-640.onnx',
    url: 'https://huggingface.co/onnxmodelzoo/version-RFB-640/resolve/main/version-RFB-640.onnx?download=true',
    approxBytes: 1_600_000,
  },
  {
    name: 'w600k_mbf.onnx',
    url: 'https://github.com/ruhyadi/vision-fr/releases/download/v1.0.0/w600k_mbf.onnx',
    approxBytes: 5_200_000,
  },
  {
    name: 'ssd_mobilenet_v1_12.onnx',
    url: 'https://huggingface.co/onnxmodelzoo/ssd_mobilenet_v1_12/resolve/main/ssd_mobilenet_v1_12.onnx?download=true',
    approxBytes: 29_000_000,
  },
];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const token = getArg('token') || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

if (!token) {
  console.error(
    'Error: GitHub token required.\n' +
    'Usage: node scripts/publish-models.mjs --token ghp_xxxx\n' +
    '   or: GH_TOKEN=ghp_xxxx node scripts/publish-models.mjs',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

async function ghFetch(path, opts = {}) {
  const url = path.startsWith('https://') ? path : `https://api.github.com${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'photo-importer-publish-models',
      ...(opts.headers ?? {}),
    },
  });
  return res;
}

async function ghJSON(path, opts = {}) {
  const res = await ghFetch(path, opts);
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

// ---------------------------------------------------------------------------
// File download helper
// ---------------------------------------------------------------------------

function downloadFile(url, dest, approxBytes) {
  return new Promise((resolve, reject) => {
    const tmp = `${dest}.tmp`;
    let redirectCount = 0;

    function fetch(u) {
      get(u, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode)) {
          if (++redirectCount > 8) { res.resume(); return reject(new Error('Too many redirects')); }
          res.resume();
          return fetch(res.headers.location);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} downloading ${u}`));
        }
        const total = parseInt(res.headers['content-length'] ?? '0', 10) || approxBytes;
        let received = 0;
        const file = createWriteStream(tmp);
        res.on('data', (chunk) => {
          received += chunk.length;
          const pct = Math.round((received / total) * 100);
          process.stdout.write(`\r  ${pct}% (${(received / 1024 / 1024).toFixed(1)} MB)`);
        });
        res.pipe(file);
        file.on('finish', () => file.close((err) => {
          if (err) return reject(err);
          rename(tmp, dest).then(resolve).catch(reject);
        }));
        file.on('error', (err) => { unlink(tmp).catch(() => {}); reject(err); });
        res.on('error', (err) => { unlink(tmp).catch(() => {}); reject(err); });
      }).on('error', reject);
    }
    fetch(url);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`\nPublishing face models to ${REPO} @ ${TAG}\n`);

// 1. Verify token works
console.log('Checking GitHub token...');
const user = await ghJSON('/user');
console.log(`[ok] Authenticated as ${user.login}\n`);

// 2. Get or create the release
console.log(`Looking for release "${TAG}"...`);
let release;
try {
  release = await ghJSON(`/repos/${REPO}/releases/tags/${TAG}`);
  console.log(`[ok] Found existing release id=${release.id}\n`);
} catch {
  console.log(`Not found — creating release "${TAG}"...`);
  release = await ghJSON(`/repos/${REPO}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: TAG,
      name: RELEASE_NAME,
      body: RELEASE_BODY,
      prerelease: false,
      draft: false,
      // Create a lightweight tag on the default branch HEAD
      target_commitish: 'main',
    }),
  });
  console.log(`[ok] Created release id=${release.id}\n`);
}

const uploadBaseUrl = release.upload_url.replace('{?name,label}', '');

// 3. Download models locally (cache in models/ dir) then upload
await mkdir(CACHE_DIR, { recursive: true });

for (const model of MODELS) {
  const localPath = join(CACHE_DIR, model.name);

  // Download from upstream if not cached
  if (!existsSync(localPath)) {
    console.log(`Downloading ${model.name} from upstream...`);
    console.log(`  ${model.url}`);
    await downloadFile(model.url, localPath, model.approxBytes);
    process.stdout.write('\n');
    console.log(`[ok] Downloaded\n`);
  } else {
    console.log(`[skip] ${model.name} already in ./models/ cache\n`);
  }

  // Delete existing asset if present (so we can re-upload cleanly)
  const existing = (release.assets ?? []).find((a) => a.name === model.name);
  if (existing) {
    console.log(`Removing existing asset ${model.name} (id=${existing.id})...`);
    await ghFetch(`/repos/${REPO}/releases/assets/${existing.id}`, { method: 'DELETE' });
    console.log('[ok] Removed\n');
  }

  // Upload
  console.log(`Uploading ${model.name}...`);
  const fileBytes = await readFile(localPath);
  const uploadUrl = `${uploadBaseUrl}?name=${encodeURIComponent(model.name)}`;
  const uploadRes = await ghFetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: fileBytes,
  });
  const uploadData = await uploadRes.json();
  if (!uploadRes.ok) {
    throw new Error(`Upload failed: ${JSON.stringify(uploadData)}`);
  }
  console.log(`[ok] Uploaded — ${uploadData.browser_download_url}\n`);
}

// 4. Print the final asset URLs for reference
console.log('='.repeat(60));
console.log('All models published. Asset URLs:');
const finalRelease = await ghJSON(`/repos/${REPO}/releases/tags/${TAG}`);
for (const asset of finalRelease.assets) {
  console.log(`  ${asset.browser_download_url}`);
}
console.log('='.repeat(60));
console.log('\nmodel-downloader.ts is already pointing at these URLs.');
console.log('Done.\n');
