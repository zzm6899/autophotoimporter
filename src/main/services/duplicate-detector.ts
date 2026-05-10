import { stat } from 'node:fs/promises';
import path from 'node:path';

export async function isDuplicate(
  destRoot: string,
  destRelativePath: string,
  sourceSize: number,
  sourceMtimeMs?: number,
): Promise<boolean> {
  const fullPath = path.join(destRoot, destRelativePath);
  try {
    const destStat = await stat(fullPath);
    if (destStat.size !== sourceSize) return false;
    // Size alone is insufficient — same-camera RAW files at consistent settings
    // can share a file size while containing different images. When the source
    // mtime is available, require it to match within a 2-second tolerance
    // (FAT32 filesystem rounds mtimes to 2-second boundaries).
    if (sourceMtimeMs !== undefined) {
      return Math.abs(destStat.mtimeMs - sourceMtimeMs) <= 2000;
    }
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    // Surface unexpected errors (permission denied, broken path, etc.) so
    // callers can decide whether to abort rather than silently skipping.
    throw err;
  }
}
