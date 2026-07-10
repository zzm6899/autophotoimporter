import { mkdir, readdir, rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';

export interface CacheLifecycleReport {
  directory: string;
  files: number;
  bytes: number;
  removedFiles: number;
  removedBytes: number;
  maxBytes: number;
  freeBytes?: number;
  reason: 'inspect' | 'age' | 'budget' | 'low-disk';
}

export interface CacheLifecycleOptions {
  maxBytes?: number;
  maxAgeMs?: number;
  minFreeBytes?: number;
  now?: number;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MIN_FREE_BYTES = 5 * 1024 * 1024 * 1024;

export async function maintainPreviewCache(
  directory: string,
  options: CacheLifecycleOptions = {},
): Promise<CacheLifecycleReport> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const minFreeBytes = options.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES;
  const now = options.now ?? Date.now();
  await mkdir(directory, { recursive: true });

  const entries = await readdir(directory, { withFileTypes: true });
  const files = (await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
    const filePath = path.join(directory, entry.name);
    try {
      const info = await stat(filePath);
      return { path: filePath, bytes: info.size, touchedAt: Math.max(info.atimeMs, info.mtimeMs) };
    } catch {
      return null;
    }
  }))).filter((entry): entry is { path: string; bytes: number; touchedAt: number } => !!entry);

  let freeBytes: number | undefined;
  try {
    const disk = await statfs(directory);
    freeBytes = Number(disk.bavail) * Number(disk.bsize);
  } catch {
    // Disk statistics are best-effort on network and removable filesystems.
  }

  let bytes = files.reduce((sum, entry) => sum + entry.bytes, 0);
  let removedFiles = 0;
  let removedBytes = 0;
  let reason: CacheLifecycleReport['reason'] = 'inspect';
  const freeBytesValue = freeBytes ?? Number.POSITIVE_INFINITY;
  const lowDisk = freeBytesValue < minFreeBytes;
  const targetBytes = lowDisk ? Math.min(maxBytes, Math.max(0, maxBytes - (minFreeBytes - freeBytesValue))) : maxBytes;

  for (const entry of files.sort((a, b) => a.touchedAt - b.touchedAt)) {
    const expired = now - entry.touchedAt > maxAgeMs;
    if (!expired && bytes <= targetBytes) continue;
    try {
      await rm(entry.path, { force: true });
      bytes -= entry.bytes;
      removedFiles++;
      removedBytes += entry.bytes;
      reason = lowDisk ? 'low-disk' : expired ? 'age' : 'budget';
    } catch {
      // A preview may be in use; leave it for the next maintenance pass.
    }
  }

  return {
    directory,
    files: files.length - removedFiles,
    bytes: Math.max(0, bytes),
    removedFiles,
    removedBytes,
    maxBytes,
    freeBytes,
    reason,
  };
}
