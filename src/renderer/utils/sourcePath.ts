import type { MediaFile } from '../../shared/types';

function normalizePath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/\/+$/g, '')
    .toLocaleLowerCase();
}

function displayPath(value: string): string {
  return value.replace(/\\/g, '/');
}

export function isPathInsideSourceRoot(sourceRoot: string | null | undefined, filePath: string): boolean {
  if (!sourceRoot?.trim() || !filePath.trim()) return true;
  const root = normalizePath(sourceRoot);
  const candidate = normalizePath(filePath);
  return candidate === root || candidate.startsWith(`${root}/`);
}

export function getSourceRelativePath(sourceRoot: string | null | undefined, filePath: string): string {
  const path = displayPath(filePath.trim());
  if (!path) return '';
  if (!sourceRoot?.trim()) return path;

  const root = displayPath(sourceRoot.trim()).replace(/\/+$/g, '');
  const normalizedRoot = normalizePath(root);
  const normalizedPath = normalizePath(path);
  if (normalizedPath === normalizedRoot) return '';
  if (!normalizedPath.startsWith(`${normalizedRoot}/`)) return path;
  return path.slice(root.length).replace(/^\/+/g, '');
}

export function getSourceFolderLabel(sourceRoot: string | null | undefined, filePath: string): string {
  const relativePath = getSourceRelativePath(sourceRoot, filePath);
  const lastSeparator = relativePath.lastIndexOf('/');
  if (lastSeparator <= 0) return '(root)';
  return relativePath.slice(0, lastSeparator);
}

export function getOutsideSourceFiles(sourceRoot: string | null | undefined, files: MediaFile[]): MediaFile[] {
  if (!sourceRoot?.trim()) return [];
  return files.filter((file) => !isPathInsideSourceRoot(sourceRoot, file.path));
}
