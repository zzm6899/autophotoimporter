import type { MediaFile } from '../../shared/types';

function normalizePath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/\/+$/g, '')
    .toLocaleLowerCase();
}

export function isPathInsideSourceRoot(sourceRoot: string | null | undefined, filePath: string): boolean {
  if (!sourceRoot?.trim() || !filePath.trim()) return true;
  const root = normalizePath(sourceRoot);
  const candidate = normalizePath(filePath);
  return candidate === root || candidate.startsWith(`${root}/`);
}

export function getOutsideSourceFiles(sourceRoot: string | null | undefined, files: MediaFile[]): MediaFile[] {
  if (!sourceRoot?.trim()) return [];
  return files.filter((file) => !isPathInsideSourceRoot(sourceRoot, file.path));
}
