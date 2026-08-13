#!/usr/bin/env node
/**
 * publish-models.mjs
 *
 * Creates a stable "models-v1" GitHub release on zzm6899/autophotoimporter and
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
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CACHE_DIR = join(ROOT, 'models');
const DEPRECATED_ASSETS = ['w600k_mbf.onnx'];

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REPO = 'zzm6899/autophotoimporter';
const TAG  = 'models-v1';
const RELEASE_NAME = 'Culling Vision Models';
const RELEASE_BODY =
  'Stable, digest-pinned ONNX review-model assets for Keptra. Full provenance and license texts ship in `third_party/NOTICES.md`.\n\n' +
  '- `version-RFB-640.onnx` - UltraFace RFB face detector (MIT upstream)\n' +
  '- `face_recognition_sface_2021dec.onnx` - OpenCV SFace embeddings (Apache-2.0)\n' +
  '- `face_detection_yunet_2023mar.onnx` - YuNet fast face/landmark detector (MIT)\n' +
  '- `object_detection_nanodet_2022nov.onnx` - NanoDet fast person detector (Apache-2.0)\n' +
  '- `ssd_mobilenet_v1_12.onnx` - selective SSD MobileNet fallback (MIT ONNX artifact; Apache-2.0 TensorFlow lineage)\n\n' +
  'The deprecated InsightFace/WebFace600K embedding model is intentionally excluded.\n\n' +
  'Do not delete this release - the app downloads models from here on first launch.';

const MODELS = [
  {
    name: 'version-RFB-640.onnx',
    url: 'https://huggingface.co/onnxmodelzoo/version-RFB-640/resolve/c39647011b1d0eb48037ce3051438e51b19e2b11/version-RFB-640.onnx?download=true',
    approxBytes: 1_600_000,
    sha256: '8f4c659275977e7a3bfbfa339a9c769ad793df50f9c0baa8c14b11baa1646430',
  },
  {
    name: 'face_recognition_sface_2021dec.onnx',
    url: 'https://media.githubusercontent.com/media/opencv/opencv_zoo/ba91a3b91d00d76e86540d4013f944bd6b514e39/models/face_recognition_sface/face_recognition_sface_2021dec.onnx',
    approxBytes: 38_696_353,
    sha256: '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79',
  },
  {
    name: 'ssd_mobilenet_v1_12.onnx',
    url: 'https://huggingface.co/onnxmodelzoo/ssd_mobilenet_v1_12/resolve/019281f3fcb151a90e491f3b2f0273f9f31bd6be/ssd_mobilenet_v1_12.onnx?download=true',
    approxBytes: 29_000_000,
    sha256: 'b8fba5e404077d4048d27fcd1667e85e27e192eb9bf51e696c46a3acd7d21058',
  },
  {
    name: 'face_detection_yunet_2023mar.onnx',
    url: 'https://media.githubusercontent.com/media/opencv/opencv_zoo/f12e12798e8314f7c074a6656816c048dcc95b7a/models/face_detection_yunet/face_detection_yunet_2023mar.onnx',
    approxBytes: 232_589,
    sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
  },
  {
    name: 'object_detection_nanodet_2022nov.onnx',
    url: 'https://media.githubusercontent.com/media/opencv/opencv_zoo/510899a2a0adb8c25957915fd030d66dbd553919/models/object_detection_nanodet/object_detection_nanodet_2022nov.onnx',
    approxBytes: 3_800_954,
    sha256: '4b82da9944b88577175ee23a459dce2e26e6e4be573def65b1055dc2d9720186',
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

for (const name of DEPRECATED_ASSETS) {
  const existing = (release.assets ?? []).find((asset) => asset.name === name);
  if (!existing) continue;
  console.log(`Removing deprecated asset ${name} (id=${existing.id})...`);
  const response = await ghFetch(`/repos/${REPO}/releases/assets/${existing.id}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(`Could not remove deprecated asset ${name}: HTTP ${response.status}`);
  release.assets = release.assets.filter((asset) => asset.id !== existing.id);
  console.log('[ok] Removed\n');
}

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

  const fileBytes = await readFile(localPath);
  const digest = createHash('sha256').update(fileBytes).digest('hex');
  if (digest !== model.sha256) {
    throw new Error(`Refusing to publish ${model.name}: SHA-256 ${digest} did not match ${model.sha256}`);
  }
  console.log(`[ok] Verified SHA-256 ${digest}\n`);

  // Delete existing asset if present (so we can re-upload cleanly)
  const existing = (release.assets ?? []).find((a) => a.name === model.name);
  if (existing) {
    console.log(`Removing existing asset ${model.name} (id=${existing.id})...`);
    await ghFetch(`/repos/${REPO}/releases/assets/${existing.id}`, { method: 'DELETE' });
    console.log('[ok] Removed\n');
  }

  // Upload
  console.log(`Uploading ${model.name}...`);
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
