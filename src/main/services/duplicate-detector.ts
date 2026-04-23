import { stat } from 'node:fs/promises';
import path from 'node:path';

export async function isDuplicate(
  destRoot: string,
  destRelativePath: string,
  sourceSize: number,
): Promise<boolean> {
  const fullPath = path.join(destRoot, destRelativePath);
  try {
    const destStat = await stat(fullPath);
    return destStat.size === sourceSize;
  } catch {
    return false;
  }
}
