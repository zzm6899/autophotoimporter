/**
 * model-downloader.ts
 *
 * Downloads ONNX face models silently in the background on first launch.
 * Runs once per machine — skips files that already exist.
 *
 * Progress is broadcast to the renderer via the FACE_MODEL_DOWNLOAD_PROGRESS
 * IPC channel so the UI can show a small non-blocking status indicator.
 *
 * Called from main.ts after the window is ready:
 *   import { ensureModelsDownloaded } from './services/model-downloader';
 *   ensureModelsDownloaded(mainWindow);
 */

import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { get } from 'node:https';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { app } from 'electron';
import type { BrowserWindow } from 'electron';
import { IPC } from '../../shared/types';

// ---------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------

interface ModelSpec {
  name: string;
  url: string;
  /** Expected file size in bytes — used for progress estimation when
   *  Content-Length is absent. 0 = unknown. */
  approxBytes: number;
  /** Pinned content digest so a partial/corrupt download never reaches ONNX. */
  sha256: string;
}

// Core models are hosted as assets on a stable pinned release in this repo.
// Pose uses an immutable upstream revision until it is mirrored to that release.
const MODEL_RELEASE_BASE =
  'https://github.com/zzm6899/autophotoimporter/releases/download/models-v1';
const SFACE_MODEL_URL =
  'https://media.githubusercontent.com/media/opencv/opencv_zoo/ba91a3b91d00d76e86540d4013f944bd6b514e39/models/face_recognition_sface/face_recognition_sface_2021dec.onnx';
const DEPRECATED_MODELS = ['w600k_mbf.onnx'] as const;

const MODELS: ModelSpec[] = [
  {
    name: 'version-RFB-640.onnx',
    url: `${MODEL_RELEASE_BASE}/version-RFB-640.onnx`,
    approxBytes: 1_600_000,
    sha256: '8f4c659275977e7a3bfbfa339a9c769ad793df50f9c0baa8c14b11baa1646430',
  },
  {
    name: 'face_recognition_sface_2021dec.onnx',
    url: SFACE_MODEL_URL,
    approxBytes: 38_696_353,
    sha256: '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79',
  },
  {
    name: 'ssd_mobilenet_v1_12.onnx',
    url: `${MODEL_RELEASE_BASE}/ssd_mobilenet_v1_12.onnx`,
    approxBytes: 29_000_000,
    sha256: 'b8fba5e404077d4048d27fcd1667e85e27e192eb9bf51e696c46a3acd7d21058',
  },
  {
    name: 'movenet_thunder.onnx',
    url: 'https://huggingface.co/Xenova/movenet-singlepose-thunder/resolve/38296077a99667cdad67af5096ce7eeb9b327453/onnx/model.onnx?download=true',
    approxBytes: 25_067_197,
    sha256: '3dca9f6e5f8a64dc9935a5be06fd8bf81bf01e696c9c05c6f2a650e0a401b763',
  },
];

// ---------------------------------------------------------------------------
// Path resolution (mirrors face-engine.ts modelPath logic)
// ---------------------------------------------------------------------------

function downloadModelsDir(): string {
  return app.isPackaged
    ? path.join(app.getPath('userData'), 'models')
    : path.join(app.getAppPath(), 'models');
}

function modelSearchDirs(): string[] {
  if (app.isPackaged) {
    return [
      path.join(app.getPath('userData'), 'models'),
      path.join(process.resourcesPath, 'models'),
    ];
  }
  return [path.join(app.getAppPath(), 'models')];
}

async function digestFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function modelExists(model: ModelSpec): Promise<boolean> {
  for (const dir of modelSearchDirs()) {
    const file = path.join(dir, model.name);
    if (!existsSync(file)) continue;
    try {
      if (statSync(file).size < model.approxBytes * 0.85) continue;
      // Package contents and existing userData models can predate integrity
      // verification. Validate them before declaring the capability ready.
      if (await digestFile(file) === model.sha256) return true;
    } catch {
      continue;
    }
  }
  return false;
}

async function allModelsPresent(): Promise<boolean> {
  const present = await Promise.all(MODELS.map(modelExists));
  return present.every(Boolean);
}

// ---------------------------------------------------------------------------
// IPC broadcast helper
// ---------------------------------------------------------------------------

export interface ModelDownloadProgress {
  /** 'checking' | 'idle' | 'downloading' | 'done' | 'error' */
  status: 'checking' | 'idle' | 'downloading' | 'done' | 'error';
  /** Which model is currently being fetched */
  currentModel?: string;
  /** 0-100 */
  percent?: number;
  /** How many models are left to download */
  remaining?: number;
  error?: string;
}

function broadcast(win: BrowserWindow | null, progress: ModelDownloadProgress): void {
  if (!win || win.isDestroyed()) return;
  if (win.webContents.isDestroyed() || win.webContents.isCrashed()) return;
  try {
    win.webContents.send(IPC.FACE_MODEL_DOWNLOAD_PROGRESS, progress);
  } catch {
    // Progress is best-effort; the renderer may be restarting or shutting down.
  }
}

// ---------------------------------------------------------------------------
// Download one model with redirect following + progress
// ---------------------------------------------------------------------------

function downloadFile(
  url: string,
  dest: string,
  approxBytes: number,
  expectedSha256: string,
  onProgress: (received: number, total: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tmp = `${dest}.tmp`;
    let redirectCount = 0;

    function fetch(u: string): void {
      const request = get(u, (res) => {
        const { statusCode, headers } = res;

        if (statusCode === 301 || statusCode === 302 || statusCode === 307 || statusCode === 308) {
          if (++redirectCount > 8) {
            res.resume();
            return reject(new Error('Too many redirects'));
          }
          res.resume();
          if (!headers.location) return reject(new Error(`Redirect from ${u} omitted Location`));
          return fetch(new URL(headers.location, u).toString());
        }

        if (statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${statusCode} for ${u}`));
        }

        const total = parseInt(headers['content-length'] ?? '0', 10) || approxBytes;
        let received = 0;
        const hash = createHash('sha256');
        const file = createWriteStream(tmp);

        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          hash.update(chunk);
          onProgress(received, total);
        });

        res.pipe(file);

        file.on('finish', () => {
          file.close((err) => {
            if (err) return reject(err);
            const digest = hash.digest('hex');
            if (digest !== expectedSha256) {
              void unlink(tmp).catch(() => {});
              return reject(new Error(`Integrity check failed for ${path.basename(dest)}`));
            }
            rename(tmp, dest).then(resolve).catch(reject);
          });
        });

        file.on('error', (err) => {
          void unlink(tmp).catch(() => {});
          reject(err);
        });

        res.on('error', (err) => {
          void unlink(tmp).catch(() => {});
          reject(err);
        });
      });
      request.setTimeout(60_000, () => request.destroy(new Error(`Timed out downloading ${u}`)));
      request.on('error', (error) => {
        void unlink(tmp).catch(() => {});
        reject(error);
      });
    }

    fetch(url);
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let downloadInProgress = false;

/**
 * Called once from main.ts after the window is ready.
 * If all models are already present, does nothing (sub-millisecond).
 * Otherwise downloads missing models one by one in the background,
 * broadcasting progress to the renderer window.
 */
export async function ensureModelsDownloaded(win: BrowserWindow | null): Promise<void> {
  if (downloadInProgress) return;
  await Promise.all(DEPRECATED_MODELS.map((name) =>
    unlink(path.join(downloadModelsDir(), name)).catch(() => undefined),
  ));
  if (await allModelsPresent()) return;

  downloadInProgress = true;
  broadcast(win, { status: 'checking' });

  try {
    const targetDir = downloadModelsDir();
    await mkdir(targetDir, { recursive: true });

    const presence = await Promise.all(MODELS.map(modelExists));
    const missing = MODELS.filter((_, index) => !presence[index]);
    broadcast(win, { status: 'downloading', remaining: missing.length });

    for (const model of missing) {
      const dest = path.join(targetDir, model.name);

      await downloadFile(
        model.url,
        dest,
        model.approxBytes,
        model.sha256,
        (received, total) => {
          const percent = Math.round((received / total) * 100);
          broadcast(win, {
            status: 'downloading',
            currentModel: model.name,
            percent,
            remaining: missing.length,
          });
        },
      );
    }

    broadcast(win, { status: 'done' });
  } catch (err: unknown) {
    const message = (err as Error).message ?? 'Unknown error';
    broadcast(win, { status: 'error', error: message });
    // Non-fatal — face features just won't be available this session.
    // User can retry by restarting the app.
  } finally {
    downloadInProgress = false;
  }
}
