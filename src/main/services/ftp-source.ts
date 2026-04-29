import { Client, FileInfo, FileType } from 'basic-ftp';
import { app } from 'electron';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FtpConfig, MediaFile } from '../../shared/types';
import { PHOTO_EXTENSIONS, VIDEO_EXTENSIONS } from '../../shared/types';
import { JobController } from './job-controller';

// FTP source: pulls the remote DCIM tree down to a local staging directory,
// then the rest of the pipeline (scan → import) runs against that staging
// directory as if it were a plain folder. This keeps the scanner, EXIF
// reader, and import engine unchanged, and lets the FTP mirror be re-scanned
// quickly if the user picks the same camera twice.

let ftpJob: JobController | null = null;

function getFileType(ext: string): 'photo' | 'video' | null {
  if (PHOTO_EXTENSIONS.has(ext)) return 'photo';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  return null;
}

/**
 * Returns a stable staging directory for a given FTP config. We key on
 * host + port + user + remotePath so two cameras under different accounts
 * stay isolated.
 */
export function getFtpStagingDir(config: FtpConfig): string {
  const key = `${config.host}_${config.port}_${config.user}_${config.remotePath.replace(/[\\/:]/g, '-')}`;
  const safe = key.replace(/[^a-zA-Z0-9_\-]/g, '_');
  return path.join(app.getPath('userData'), 'ftp-cache', safe);
}

/** Open and authenticate a new FTP client. Caller is responsible for closing it. */
async function openClient(config: FtpConfig, timeoutMs: number): Promise<Client> {
  const client = new Client(timeoutMs);
  await client.access({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    secure: config.secure,
  });
  return client;
}

/**
 * Test the credentials & path without transferring anything. Returns the
 * count of media files found under `remotePath` and free bytes estimate.
 */
export async function probeFtp(config: FtpConfig): Promise<{
  ok: boolean;
  error?: string;
  fileCount?: number;
  totalBytes?: number;
}> {
  ftpJob?.cancel();
  ftpJob = new JobController('ftp-mirror');
  ftpJob.start();
  let client: Client | undefined;
  try {
    client = await openClient(config, 30_000);
    const entries = await listMediaRecursive(client, config.remotePath);
    return {
      ok: true,
      fileCount: entries.length,
      totalBytes: entries.reduce((sum, e) => sum + e.size, 0),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'FTP connection failed';
    ftpJob?.fail(message);
    return { ok: false, error: message };
  } finally {
    client?.close();
  }
}

interface RemoteEntry {
  remotePath: string; // full path on the server
  relPath: string; // path relative to config.remotePath
  name: string;
  size: number;
  type: 'photo' | 'video';
  extension: string;
}

async function listMediaRecursive(client: Client, root: string, rel = ''): Promise<RemoteEntry[]> {
  const results: RemoteEntry[] = [];
  const here = rel ? `${root}/${rel}`.replace(/\/+/g, '/') : root;

  let entries: FileInfo[];
  try {
    entries = await client.list(here);
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..') continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const childAbs = `${here}/${entry.name}`.replace(/\/+/g, '/');

    if (entry.type === FileType.Directory) {
      const sub = await listMediaRecursive(client, root, childRel);
      results.push(...sub);
    } else if (entry.type === FileType.File) {
      const ext = path.extname(entry.name).toLowerCase();
      const type = getFileType(ext);
      if (!type) continue;
      results.push({
        remotePath: childAbs,
        relPath: childRel,
        name: entry.name,
        size: entry.size,
        type,
        extension: ext,
      });
    }
  }
  return results;
}

/**
 * Download remote files into the staging directory. Skips files that are
 * already present locally at the expected size (so re-scanning is cheap).
 * Yields progress via onProgress.
 */
export async function mirrorFtp(
  config: FtpConfig,
  onProgress: (done: number, total: number, currentName: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const stagingDir = getFtpStagingDir(config);
  await mkdir(stagingDir, { recursive: true });

  const client = await openClient(config, 60_000);
  try {
    const entries = await listMediaRecursive(client, config.remotePath);
    let done = 0;
    const failures: Array<{ remotePath: string; message: string }> = [];

    for (const e of entries) {
      if (signal?.aborted) break;
      const localPath = path.join(stagingDir, e.relPath.replace(/\//g, path.sep));
      await mkdir(path.dirname(localPath), { recursive: true });

      // Skip if already mirrored at the same size.
      try {
        const s = await stat(localPath);
        if (s.size === e.size) {
          done++;
          onProgress(done, entries.length, e.name);
          continue;
        }
      } catch {
        // not present yet — fall through to download
      }

      try {
        await client.downloadTo(localPath, e.remotePath);
        done++;
        onProgress(done, entries.length, e.name);
      } catch (err) {
        done++;
        failures.push({
          remotePath: e.remotePath,
          message: err instanceof Error ? err.message : 'download failed',
        });
        onProgress(done, entries.length, e.name);
      }
    }
    if (failures.length > 0) {
      const sample = failures.slice(0, 3).map((f) => `${f.remotePath}: ${f.message}`).join('; ');
      throw new Error(`FTP mirror failed for ${failures.length}/${entries.length} file(s): ${sample}`);
    }

    return stagingDir;
  } finally {
    client.close();
  }
}

/**
 * Fetch just the media manifest (paths + sizes) without downloading bytes.
 * Useful if the UI wants to offer "preview on-demand" instead of full mirror.
 */
export async function listFtpMedia(config: FtpConfig): Promise<MediaFile[]> {
  const client = await openClient(config, 30_000);
  try {
    const entries = await listMediaRecursive(client, config.remotePath);
    const stagingDir = getFtpStagingDir(config);
    return entries.map<MediaFile>((e) => ({
      path: path.join(stagingDir, e.relPath.replace(/\//g, path.sep)),
      name: e.name,
      size: e.size,
      type: e.type,
      extension: e.extension,
    }));
  } finally {
    client.close();
  }
}
