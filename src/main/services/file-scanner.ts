import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { PHOTO_EXTENSIONS, VIDEO_EXTENSIONS } from '../../shared/types';
import type { MediaFile } from '../../shared/types';
import { parseExifDate, ensureGeneratedThumbnail, ensureEmbeddedThumbnail, ensureVideoThumbnail, isVideoThumbnailSupported, EXIFR_SUPPORTED, clearThumbnailMemCache, isSharpAvailable } from './exif-parser';
import { JobController } from './job-controller';

const BATCH_SIZE = 50;
const FAST_THUMB_CONCURRENCY_MIN = 4;
const FAST_THUMB_CONCURRENCY_DEFAULT = 24;
const FAST_THUMB_CONCURRENCY_MAX = 48;
const SLOW_THUMB_CONCURRENCY = 4;   // PowerShell resize — one per process, keep low
const SHARP_THUMB_CONCURRENCY = 10; // sharp resizes in-process on worker threads — no spawn cost
const SLOW_THUMB_TIMEOUT_MS = 8000; // Per-file timeout; corrupted/huge files abort

/** Wraps a promise with a hard deadline — rejects if it exceeds timeoutMs. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}
const RAW_PRIORITY_EXTENSIONS = new Set([
  '.cr2', '.cr3', '.crw',
  '.nef', '.nrw',
  '.arw', '.srf', '.sr2',
  '.raf', '.orf', '.rw2', '.pef', '.srw', '.rwl',
  '.3fr', '.fff', '.gpr', '.mrw', '.erf',
  '.dng',
]);

export interface FileScanDiagnostics {
  filesFound: number;
  hiddenOrSystemEntriesSkipped: number;
  inaccessibleDirectories: number;
  statFailures: number;
}

export interface FileScanOptions {
  generateThumbnails?: boolean;
  onDiagnostics?: (diagnostics: FileScanDiagnostics) => void;
}

let currentJob: JobController | null = null;
let backgroundThumbnailAbort: AbortController | null = null;
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
  diagnostics: FileScanDiagnostics,
): Promise<void> {
  if (signal.aborted) return;

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    diagnostics.inaccessibleDirectories++;
    return;
  }

  const subdirectories: string[] = [];
  const mediaEntries: Array<{ name: string; fullPath: string; ext: string; type: 'photo' | 'video' }> = [];
  for (const entry of entries) {
    if (signal.aborted) return;

    if (entry.name.startsWith('.')) {
      diagnostics.hiddenOrSystemEntriesSkipped++;
      continue;
    }
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      subdirectories.push(fullPath);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      const type = getFileType(ext);
      if (type) mediaEntries.push({ name: entry.name, fullPath, ext, type });
    }
  }

  // Stat media files in bounded batches — on cards with thousands of files a
  // sequential stat-per-file walk left most of the bus idle.
  const STAT_BATCH = 16;
  for (let i = 0; i < mediaEntries.length; i += STAT_BATCH) {
    if (signal.aborted) return;
    await waitIfPaused(signal);
    const batch = mediaEntries.slice(i, i + STAT_BATCH);
    const stats = await Promise.all(batch.map((entry) => stat(entry.fullPath).catch(() => null)));
    for (let j = 0; j < batch.length; j++) {
      const fileStat = stats[j];
      if (!fileStat) {
        diagnostics.statFailures++;
        continue; // Skip files we can't stat
      }
      files.push({
        path: batch[j].fullPath,
        name: batch[j].name,
        size: fileStat.size,
        sourceModifiedAtMs: fileStat.mtimeMs,
        type: batch[j].type,
        extension: batch[j].ext,
      });
    }
  }

  for (const subdirectory of subdirectories) {
    if (signal.aborted) return;
    await waitIfPaused(signal);
    await walkDirectory(subdirectory, files, signal, diagnostics);
  }
}

export async function scanFiles(
  sourcePath: string,
  onBatch: (files: MediaFile[]) => void,
  onThumbnail: (filePath: string) => void,
  folderPattern?: string,
  options?: FileScanOptions,
): Promise<number> {
  currentJob?.cancel();
  // Cancel any background thumbnail task from a previous scan so stale
  // onThumbnail callbacks don't pollute the new scan's state.
  backgroundThumbnailAbort?.abort();
  backgroundThumbnailAbort = null;
  while (pauseWaiters.length) pauseWaiters.shift()?.();
  const job = new JobController('file-scan');
  currentJob = job;
  job.start();
  paused = false;
  clearThumbnailMemCache(); // clear before each scan so modified files get fresh thumbnails
  const { signal } = job;

  // Phase 1: Walk directory and get metadata + dates (fast)
  const allFiles: MediaFile[] = [];
  const diagnostics: FileScanDiagnostics = {
    filesFound: 0,
    hiddenOrSystemEntriesSkipped: 0,
    inaccessibleDirectories: 0,
    statFailures: 0,
  };
  await walkDirectory(sourcePath, allFiles, signal, diagnostics);
  diagnostics.filesFound = allFiles.length;
  options?.onDiagnostics?.({ ...diagnostics });
  if (signal.aborted) { job.cancel(); if (currentJob === job) currentJob = null; return 0; }

  // Enrich with dates only (no thumbnails yet)
  for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
    if (signal.aborted) { job.cancel(); if (currentJob === job) currentJob = null; return 0; }
    await waitIfPaused(signal);
    const batch = allFiles.slice(i, i + BATCH_SIZE);
    const enriched = await Promise.all(
      batch.map(async (file) => {
        const dateInfo = await parseExifDate(file, folderPattern);
        return { ...file, ...dateInfo };
      }),
    );
    if (signal.aborted) { job.cancel(); if (currentJob === job) currentJob = null; return 0; }
    onBatch(enriched);
    job.progress({ current: Math.min(i + BATCH_SIZE, allFiles.length), total: allFiles.length, percent: allFiles.length ? Math.round(((i + BATCH_SIZE) / allFiles.length) * 100) : 0 });
  }

  // Thumbnails load in the background — don't block scan completion.
  // Use a dedicated AbortController so a subsequent scanFiles call can cancel
  // this task even after the job's own signal has already resolved.
  if (options?.generateThumbnails !== false) {
    const bgAbort = new AbortController();
    backgroundThumbnailAbort = bgAbort;
    generateThumbnailsInBackground(allFiles, onThumbnail, bgAbort.signal);
  }

  job.complete({ current: allFiles.length, total: allFiles.length, percent: 100 });
  if (currentJob === job) currentJob = null;
  // backgroundThumbnailAbort is intentionally kept alive until the next scan
  // starts so the background task can still be cancelled if needed.
  return allFiles.length;
}

type FastThumbConcurrencyController = {
  value: number;
  onBatch: (elapsedMs: number, batchSize: number) => void;
};

function createFastThumbConcurrencyController(): FastThumbConcurrencyController {
  let concurrency = FAST_THUMB_CONCURRENCY_DEFAULT;

  const onBatch = (elapsedMs: number, batchSize: number): void => {
    if (batchSize <= 0) return;
    const msPerFile = elapsedMs / batchSize;

    if (msPerFile < 8 && concurrency < FAST_THUMB_CONCURRENCY_MAX) {
      concurrency = Math.min(FAST_THUMB_CONCURRENCY_MAX, concurrency + 4);
      return;
    }

    if (msPerFile > 40 && concurrency > FAST_THUMB_CONCURRENCY_MIN) {
      concurrency = Math.max(FAST_THUMB_CONCURRENCY_MIN, concurrency - 8);
    }
  };

  return {
    get value() {
      return concurrency;
    },
    onBatch,
  };
}

function generateThumbnailsInBackground(
  allFiles: MediaFile[],
  onThumbnail: (filePath: string) => void,
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

    const fastThumbConcurrency = createFastThumbConcurrencyController();
    for (let i = 0; i < fastFiles.length;) {
      if (signal.aborted) break;
      await waitIfPaused(signal);
      const batchSize = fastThumbConcurrency.value;
      const batch = fastFiles.slice(i, i + batchSize);
      const startedAt = Date.now();
      await Promise.all(
        batch.map(async (file) => {
          if (signal.aborted) return;
          try {
            const ok = await withTimeout(
              ensureEmbeddedThumbnail(file.path, file.extension),
              5000, // embedded JPEG extract should be near-instant
            );
            if (ok) {
              onThumbnail(file.path);
            } else {
              slowFiles.push(file); // exifr failed, fall back to slow path
            }
          } catch {
            slowFiles.push(file); // timeout or corrupt — try slow path
          }
        }),
      );
      fastThumbConcurrency.onBatch(Date.now() - startedAt, batch.length);
      i += batch.length;
    }

    // Phase 2B: Slow thumbnails — PowerShell/sips for unsupported formats.
    // Exclude video files — they require ffmpeg which we don't ship; they'd
    // hang the pipeline or silently fail, causing "stuck at 99%" behaviour.
    const sipsFiles = [
      ...photos.filter((f) => !EXIFR_SUPPORTED.has(f.extension)),
      ...slowFiles,
    ].filter((f) => f.type === 'photo'); // never slow-thumb videos
    // sharp handles these in-process (no per-file process spawn), so it can
    // safely run wider than the PowerShell/sips fallback.
    const slowConcurrency = isSharpAvailable() ? SHARP_THUMB_CONCURRENCY : SLOW_THUMB_CONCURRENCY;
    for (let i = 0; i < sipsFiles.length; i += slowConcurrency) {
      if (signal.aborted) break;
      await waitIfPaused(signal);
      const batch = sipsFiles.slice(i, i + slowConcurrency);
      await Promise.all(
        batch.map(async (file) => {
          if (signal.aborted) return;
          try {
            // Hard per-file timeout so a single corrupted/huge file can't
            // block the entire thumbnail queue indefinitely.
            const ok = await withTimeout(
              ensureGeneratedThumbnail(file.path),
              SLOW_THUMB_TIMEOUT_MS,
            );
            if (ok) onThumbnail(file.path);
          } catch {
            // Corrupted file or timeout — skip silently, grid shows placeholder
          }
        }),
      );
    }

    // Phase 2C: video thumbnails via system ffmpeg, when available. Keptra
    // doesn't ship ffmpeg — without it, videos keep their placeholder.
    const videos = allFiles.filter((f) => f.type === 'video');
    if (videos.length > 0 && !signal.aborted && await isVideoThumbnailSupported()) {
      const VIDEO_THUMB_CONCURRENCY = 2;
      for (let i = 0; i < videos.length; i += VIDEO_THUMB_CONCURRENCY) {
        if (signal.aborted) break;
        await waitIfPaused(signal);
        const batch = videos.slice(i, i + VIDEO_THUMB_CONCURRENCY);
        await Promise.all(
          batch.map(async (file) => {
            if (signal.aborted) return;
            try {
              const ok = await withTimeout(ensureVideoThumbnail(file.path), 20000);
              if (ok) onThumbnail(file.path);
            } catch {
              // Corrupt clip or ffmpeg stall — placeholder stays.
            }
          }),
        );
      }
    }
  };

  run().catch((err) => {
    if (!signal.aborted) console.error('[thumbnails] Background error:', err);
  });
}

export function cancelScan(): void {
  const job = currentJob;
  job?.cancel();
  currentJob = null;
  backgroundThumbnailAbort?.abort();
  backgroundThumbnailAbort = null;
  paused = false;
  job?.resume();
  while (pauseWaiters.length) pauseWaiters.shift()?.();
  clearThumbnailMemCache(); // free memory when scan is cancelled / source changes
}

export function pauseScan(): void {
  if (currentJob && !currentJob.signal.aborted) { paused = true; currentJob.pause(); }
}

export function resumeScan(): void {
  paused = false;
  currentJob?.resume();
  while (pauseWaiters.length) pauseWaiters.shift()?.();
}
