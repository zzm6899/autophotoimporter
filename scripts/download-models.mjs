#!/usr/bin/env node
/**
 * download-models.mjs
 *
 * Downloads the ONNX face models needed by the face-engine service.
 * Run once before building or developing:
 *
 *   npm run models
 *
 * Models are cached in ./models/ and skipped if already present.
 * They are listed in .gitignore (large binary files, not source).
 *
 * Model sources (all MIT / Apache-2.0 licensed):
 *  - ultraface-slim-640.onnx  ~1.1 MB  — face detection (Ultra-Light-Fast)
 *  - mobilefacenet.onnx       ~4.0 MB  — 128-d face embeddings (MobileFaceNet)
 */

import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from 'node:https';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = join(__dirname, '..', 'models');

// ---------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------
// Models are served from a stable pinned release in this repo.
// Run `node scripts/publish-models.mjs --token <ghp_xxx>` once to create
// the release and upload the files before using this script.
const MODEL_RELEASE_BASE =
  'https://github.com/juanmnl/importer/releases/download/models-v1';

const MODELS = [
  {
    name: 'ultraface-slim-640.onnx',
    url: `${MODEL_RELEASE_BASE}/ultraface-slim-640.onnx`,
    sha256: null,
  },
  {
    name: 'mobilefacenet.onnx',
    url: `${MODEL_RELEASE_BASE}/mobilefacenet.onnx`,
    sha256: null,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const tmp = dest + '.tmp';
    const file = createWriteStream(tmp);
    let redirectCount = 0;

    function fetch(u) {
      get(u, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          if (++redirectCount > 5) return reject(new Error('Too many redirects'));
          return fetch(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total) {
            const pct = Math.round((received / total) * 100);
            process.stdout.write(`\r  ${pct}% (${(received / 1024 / 1024).toFixed(1)} MB)`);
          }
        });
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => rename(tmp, dest).then(resolve).catch(reject));
        });
      }).on('error', reject);
    }

    fetch(url);
  });
}

async function sha256File(filePath) {
  const { createReadStream } = await import('node:fs');
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
await mkdir(MODELS_DIR, { recursive: true });

let allOk = true;
for (const model of MODELS) {
  const dest = join(MODELS_DIR, model.name);

  if (existsSync(dest)) {
    if (model.sha256) {
      const actual = await sha256File(dest);
      if (actual === model.sha256) {
        console.log(`[skip] ${model.name} — already downloaded and verified`);
        continue;
      }
      console.log(`[warn] ${model.name} — checksum mismatch, re-downloading`);
    } else {
      console.log(`[skip] ${model.name} — already downloaded`);
      continue;
    }
  }

  console.log(`[dl]   ${model.name}`);
  console.log(`       ${model.url}`);
  try {
    await download(model.url, dest);
    process.stdout.write('\n');
    if (model.sha256) {
      const actual = await sha256File(dest);
      if (actual !== model.sha256) {
        console.error(`[FAIL] ${model.name} — checksum mismatch after download`);
        console.error(`       expected: ${model.sha256}`);
        console.error(`       actual:   ${actual}`);
        allOk = false;
        continue;
      }
    }
    console.log(`[ok]   ${model.name}`);
  } catch (err) {
    process.stdout.write('\n');
    console.error(`[FAIL] ${model.name} — ${err.message}`);
    allOk = false;
  }
}

if (!allOk) {
  console.error('\nOne or more models failed to download. See errors above.');
  process.exit(1);
}

console.log('\nAll models ready in ./models/');
