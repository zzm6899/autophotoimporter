const MIN_SCAN_BATCH = 256;
const MAX_SCAN_BATCH = 65_536;

/**
 * Grow scan commits with the catalogue. Up to one million files this keeps
 * immutable array appends to a small bounded number instead of one per 50-file
 * scanner IPC batch.
 */
export function scanCommitTarget(dispatchedFiles: number): number {
  if (dispatchedFiles < MIN_SCAN_BATCH) return MIN_SCAN_BATCH;
  const power = 2 ** Math.floor(Math.log2(Math.max(MIN_SCAN_BATCH, dispatchedFiles)));
  return Math.min(MAX_SCAN_BATCH, Math.max(MIN_SCAN_BATCH, power));
}

export function scanIdleFlushDelay(fileCount: number): number {
  if (fileCount >= 250_000) return 1_200;
  if (fileCount >= 50_000) return 800;
  if (fileCount >= 2_500) return 500;
  return 220;
}

/** Limit full-catalogue shallow copies to roughly 16–32 over a large scan. */
export function thumbnailCommitTarget(fileCount: number): number {
  if (fileCount < 800) return 96;
  if (fileCount < 2_500) return 256;
  if (fileCount < 50_000) return Math.min(4_096, Math.max(512, Math.ceil(fileCount / 16)));
  if (fileCount < 250_000) return Math.min(16_384, Math.max(4_096, Math.ceil(fileCount / 16)));
  return Math.min(65_536, Math.max(16_384, Math.ceil(fileCount / 16)));
}

export function thumbnailIdleFlushDelay(fileCount: number): number {
  if (fileCount >= 250_000) return 30_000;
  if (fileCount >= 50_000) return 10_000;
  if (fileCount >= 2_500) return 2_000;
  if (fileCount >= 800) return 250;
  return 120;
}

export function flattenSegments<T>(segments: readonly (readonly T[])[], total: number): T[] {
  const result = new Array<T>(total);
  let offset = 0;
  for (const segment of segments) {
    for (let i = 0; i < segment.length; i++) result[offset++] = segment[i];
  }
  return result;
}
