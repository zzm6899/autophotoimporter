import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { PHOTO_EXTENSIONS, VIDEO_EXTENSIONS } from '../../shared/types';
import type { MediaFile } from '../../shared/types';
import { parseExifDate, generateThumbnail, extractEmbeddedThumbnail, EXIFR_SUPPORTED, clearThumbnailMemCache } from './exif-parser';

const BATCH_SIZE = 50;
const FAST_THUMB_CONCURRENCY = 60;  // exifr embedded thumbs — I/O bound, saturate disk queue
const SLOW_THUMB_CONCURRENCY = 4;   // PowerShell resize — one per process, keep low
const SLOW_THUMB_TIMEOUT_MS = 8000; // Per-file timeout; corrupted/huge files abort

/** Wraps a promise with a hard deadline — rejects if it exceeds timeoutMs. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms),
    ),
  ]);
}
const RAW_PRIORITY_EXTENSIONS = new Set([
  '.cr2', '.cr3', '.crw',
  '.nef', '.nrw',
  '.arw', '.srf', '.sr2',
  '.raf', '.orf', '.rw2', '.pef', '.srw', '.rwl',
  '.3fr', '.fff', '.gpr', '.mrw', '.erf',
  '.dng',
]);

let currentAbortController: AbortController | null = null;
let paused = false;
const pauseWaiters: Array<() => void> = [];

async function waitIfPaused(signal: AbortSignal): Promise<void> {
  while (paused && !signal.aborted) {
    await new Promise<void>((resolve) => pauseWaiters.push(resolve));
  }
}

function getFileType(ext: string): 'photo' | 'video' | null {
  if (PHOTO_EXTENSIONS.has(ext)) return 'photo';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  return null;
}

async function walkDirectory(
  dirPath: string,
  files: MediaFile[],
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (signal.aborted) return;
    await waitIfPaused(signal);

    const fullPath = path.join(dirPath, entry.name);

    if (entry.name.startsWith('.')) continue;

    if (entry.isDirectory()) {
      await walkDirectory(fullPath, files, signal);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      const type = getFileType(ext);
      if (type) {
        try {
          const fileStat = await stat(fullPath);
          files.push({
            path: fullPath,
            name: entry.name,
            size: fileStat.size,
            type,
            extension: ext,
          });
        } catch {
          // Skip files we can't stat
        }
      }
    }
  }
}

export async function scanFiles(
  sourcePath: string,
  onBatch: (files: MediaFile[]) => void,
  onThumbnail: (filePath: string, thumbnail: string) => void,
  folderPattern?: string,
): Promise<number> {
  currentAbortController?.abort();
  currentAbortController = new AbortController();
  paused = false;
  clearThumbnailMemCache(); // clear before each scan so modified files get fresh thumbnails
  const { signal } = currentAbortController;

  // Phase 1: Walk directory and get metadata + dates (fast)
  const allFiles: MediaFile[] = [];
  await walkDirectory(sourcePath, allFiles, signal);
  if (signal.aborted) return 0;

  // Enrich with dates only (no thumbnails yet)
  for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
    if (signal.aborted) return 0;
    await waitIfPaused(signal);
    const batch = allFiles.slice(i, i + BATCH_SIZE);
    const enriched = await Promise.all(
      batch.map(async (file) => {
        const dateInfo = await parseExifDate(file, folderPattern);
        return { ...file, ...dateInfo };
      }),
    );
    onBatch(enriched);
  }

  // Thumbnails load in the background — don't block scan completion
  generateThumbnailsInBackground(allFiles, onThumbnail, signal);

  return allFiles.length;
}

function generateThumbnailsInBackground(
  allFiles: MediaFile[],
  onThumbnail: (filePath: string, thumbnail: string) => void,
  signal: AbortSignal,
): void {
  const run = async () => {
    // Phase 2A: Fast thumbnails — extract embedded JPEG from EXIF (exifr-supported formats)
    const photos = allFiles.filter((f) => f.type === 'photo');
    const fastFiles = photos
      .filter((f) => EXIFR_SUPPORTED.has(f.extension))
      .sort((a, b) => {
        const aRaw = RAW_PRIORITY_EXTENSIONS.has(a.extension) ? 1 : 0;
        const bRaw = RAW_PRIORITY_EXTENSIONS.has(b.extension) ? 1 : 0;
        return bRaw - aRaw;
      });
    const slowFiles: MediaFile[] = [];

    for (let i = 0; i < fastFiles.length; i += FAST_THUMB_CONCURRENCY) {
      if (signal.aborted) break;
      await waitIfPaused(signal);
      const batch = fastFiles.slice(i, i + FAST_THUMB_CONCURRENCY);
      await Promise.all(
        batch.map(async (file) => {
          if (signal.aborted) return;
          try {
            const thumbnail = await withTimeout(
              extractEmbeddedThumbnail(file.path, file.extension),
              5000, // embedded JPEG extract should be near-instant
            );
            if (thumbnail) {
              onThumbnail(file.path, thumbnail);
            } else {
              slowFiles.push(file); // exifr failed, fall back to slow path
            }
          } catch {
            slowFiles.push(file); // timeout or corrupt — try slow path
          }
        }),
      );
    }

    // Phase 2B: Slow thumbnails — PowerShell/sips for unsupported formats.
    // Exclude video files — they require ffmpeg which we don't ship; they'd
    // hang the pipeline or silently fail, causing "stuck at 99%" behaviour.
    const sipsFiles = [
      ...photos.filter((f) => !EXIFR_SUPPORTED.has(f.extension)),
      ...slowFiles,
    ].filter((f) => f.type === 'photo'); // never slow-thumb videos
    for (let i = 0; i < sipsFiles.length; i += SLOW_THUMB_CONCURRENCY) {
      if (signal.aborted) break;
      await waitIfPaused(signal);
      const batch = sipsFiles.slice(i, i + SLOW_THUMB_CONCURRENCY);
      await Promise.all(
        batch.map(async (file) => {
          if (signal.aborted) return;
          try {
            // Hard per-file timeout so a single corrupted/huge file can't
            // block the entire thumbnail queue indefinitely.
            const thumbnail = await withTimeout(
              generateThumbnail(file.path, file.name),
              SLOW_THUMB_TIMEOUT_MS,
            );
            if (thumbnail) onThumbnail(file.path, thumbnail);
          } catch {
            // Corrupted file or timeout — skip silently, grid shows placeholder
          }
        }),
      );
    }
  };

  run().catch((err) => {
    if (!signal.aborted) console.error('[thumbnails] Background error:', err);
  });
}

export function cancelScan(): void {
  currentAbortController?.abort();
  currentAbortController = null;
  paused = false;
  while (pauseWaiters.length) pauseWaiters.shift()?.();
  clearThumbnailMemCache(); // free memory when scan is cancelled / source changes
}

export function pauseScan(): void {
  if (currentAbortController && !currentAbortController.signal.aborted) paused = true;
}

export function resumeScan(): void {
  paused = false;
  while (pauseWaiters.length) pauseWaiters.shift()?.();
}
