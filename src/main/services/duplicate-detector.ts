import { stat } from 'node:fs/promises';
import path from 'node:path';

export async function isDuplicate(
  destRoot: string,
  destRelativePath: string,
  sourceSize: number,
): Promise<boolean> {
  const pathApi = destRoot.includes('\\') || /^[A-Za-z]:[\\/]/.test(destRoot) ? path : path.posix;
  const fullPath = pathApi.join(destRoot, destRelativePath);
  try {
    const destStat = await stat(fullPath);
    return destStat.size === sourceSize;
  } catch {
    return false;
  }
}
