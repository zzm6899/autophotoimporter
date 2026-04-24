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

import { existsSync, createWriteStream } from 'node:fs';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { get } from 'node:https';
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
}

// Models are hosted as assets on a stable pinned release in this repo.
// Run `node scripts/publish-models.mjs --token <ghp_xxx>` once to create
// the release and upload the files. The tag never changes between app versions
// so these URLs remain stable indefinitely.
const MODEL_RELEASE_BASE =
  'https://github.com/zzm6899/autophotoimporter/releases/download/models-v1';

const MODELS: ModelSpec[] = [
  {
    name: 'version-RFB-640.onnx',
    url: `${MODEL_RELEASE_BASE}/version-RFB-640.onnx`,
    approxBytes: 1_600_000,
  },
  {
    name: 'w600k_mbf.onnx',
    url: `${MODEL_RELEASE_BASE}/w600k_mbf.onnx`,
    approxBytes: 5_200_000,
  },
  {
    name: 'ssd_mobilenet_v1_12.onnx',
    url: `${MODEL_RELEASE_BASE}/ssd_mobilenet_v1_12.onnx`,
    approxBytes: 29_000_000,
  },
];

// ---------------------------------------------------------------------------
// Path resolution (mirrors face-engine.ts modelPath logic)
// ---------------------------------------------------------------------------

function modelsDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'models');
  }
  return path.join(app.getAppPath(), 'models');
}

function modelExists(name: string): boolean {
  return existsSync(path.join(modelsDir(), name));
}

function allModelsPresent(): boolean {
  return MODELS.every((m) => modelExists(m.name));
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
  win.webContents.send(IPC.FACE_MODEL_DOWNLOAD_PROGRESS, progress);
}

// ---------------------------------------------------------------------------
// Download one model with redirect following + progress
// ---------------------------------------------------------------------------

function downloadFile(
  url: string,
  dest: string,
  approxBytes: number,
  onProgress: (received: number, total: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tmp = `${dest}.tmp`;
    let redirectCount = 0;

    function fetch(u: string): void {
      get(u, (res) => {
        const { statusCode, headers } = res;

        if (statusCode === 301 || statusCode === 302 || statusCode === 307 || statusCode === 308) {
          if (++redirectCount > 8) {
            res.resume();
            return reject(new Error('Too many redirects'));
          }
          res.resume();
          return fetch(headers.location as string);
        }

        if (statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${statusCode} for ${u}`));
        }

        const total = parseInt(headers['content-length'] ?? '0', 10) || approxBytes;
        let received = 0;
        const file = createWriteStream(tmp);

        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          onProgress(received, total);
        });

        res.pipe(file);

        file.on('finish', () => {
          file.close((err) => {
            if (err) return reject(err);
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
      }).on('error', reject);
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
  if (allModelsPresent()) return; // fast path — nothing to do

  downloadInProgress = true;
  broadcast(win, { status: 'checking' });

  try {
    await mkdir(modelsDir(), { recursive: true });

    const missing = MODELS.filter((m) => !modelExists(m.name));
    broadcast(win, { status: 'downloading', remaining: missing.length });

    for (const model of missing) {
      const dest = path.join(modelsDir(), model.name);

      await downloadFile(
        model.url,
        dest,
        model.approxBytes,
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
