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
 * Model files have separate upstream terms. A checksum pins identity; it does
 * not grant redistribution or commercial rights. Verify each model's current
 * license and obtain any required permission before publishing a build.
 *  - version-RFB-640.onnx     ~1.6 MB  - stronger face detection (UltraFace RFB)
 *  - face_recognition_sface_2021dec.onnx ~37 MB - face embeddings (OpenCV SFace, Apache-2.0)
 *  - ssd_mobilenet_v1_12.onnx ~28 MB   - person/body detection for culling
 */

import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from 'node:https';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = join(__dirname, '..', 'models');
const DEPRECATED_MODELS = ['w600k_mbf.onnx'];

// ---------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------
// Bootstrap: fetch from upstream sources the first time, before the
// models-v1 release exists on this repo. Once publish-models.mjs has
// been run successfully, update these URLs to point at the release assets.
const MODELS = [
  {
    name: 'version-RFB-640.onnx',
    url: 'https://huggingface.co/onnxmodelzoo/version-RFB-640/resolve/main/version-RFB-640.onnx?download=true',
    sha256: '8f4c659275977e7a3bfbfa339a9c769ad793df50f9c0baa8c14b11baa1646430',
  },
  {
    name: 'face_recognition_sface_2021dec.onnx',
    // OpenCV Zoo pins this model and its directory-level Apache-2.0 license.
    url: 'https://media.githubusercontent.com/media/opencv/opencv_zoo/ba91a3b91d00d76e86540d4013f944bd6b514e39/models/face_recognition_sface/face_recognition_sface_2021dec.onnx',
    sha256: '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79',
  },
  {
    name: 'ssd_mobilenet_v1_12.onnx',
    url: 'https://huggingface.co/onnxmodelzoo/ssd_mobilenet_v1_12/resolve/main/ssd_mobilenet_v1_12.onnx?download=true',
    sha256: 'b8fba5e404077d4048d27fcd1667e85e27e192eb9bf51e696c46a3acd7d21058',
  },
  {
    // Optional: pose estimation for sports modes (measured kick straightness +
    // foot-to-torso contact). MoveNet SinglePose Thunder, 17 COCO keypoints,
    // 256x256 input. The app runs fine without it — sports scoring falls back
    // to person-box proxies when this file is absent.
    name: 'movenet_thunder.onnx',
    url: 'https://huggingface.co/Xenova/movenet-singlepose-thunder/resolve/38296077a99667cdad67af5096ce7eeb9b327453/onnx/model.onnx?download=true',
    sha256: '3dca9f6e5f8a64dc9935a5be06fd8bf81bf01e696c9c05c6f2a650e0a401b763',
    optional: true,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fetchModel(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      if ([301, 302, 307, 308].includes(response.statusCode ?? 0)) {
        const location = response.headers.location;
        response.resume();
        if (!location) return reject(new Error(`Redirect from ${url} omitted Location`));
        if (redirectCount >= 5) return reject(new Error('Too many redirects'));
        fetchModel(new URL(location, url).toString(), redirectCount + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode} for ${url}`));
        return;
      }
      resolve(response);
    });
    request.setTimeout(60_000, () => request.destroy(new Error(`Timed out downloading ${url}`)));
    request.once('error', reject);
  });
}

async function download(url, dest) {
  const tmp = dest + '.tmp';
  try {
    const response = await fetchModel(url);
    const total = parseInt(response.headers['content-length'] || '0', 10);
    let received = 0;
    response.on('data', (chunk) => {
      received += chunk.length;
      if (total) {
        const pct = Math.round((received / total) * 100);
        process.stdout.write(`\r  ${pct}% (${(received / 1024 / 1024).toFixed(1)} MB)`);
      }
    });
    await pipeline(response, createWriteStream(tmp, { flags: 'w' }));
    await rename(tmp, dest);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

async function sha256File(filePath) {
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
for (const deprecated of DEPRECATED_MODELS) {
  await unlink(join(MODELS_DIR, deprecated)).catch(() => undefined);
}

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
    if (model.optional) {
      console.warn(`[warn] ${model.name} — optional model failed to download (${err.message}); skipping.`);
    } else {
      console.error(`[FAIL] ${model.name} — ${err.message}`);
      allOk = false;
    }
  }
}

if (!allOk) {
  console.error('\nOne or more models failed to download. See errors above.');
  process.exit(1);
}

console.log('\nAll models ready in ./models/');
