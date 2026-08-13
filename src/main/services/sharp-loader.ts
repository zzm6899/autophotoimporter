// Lazy-loaded sharp (libvips) native module, shared by the preview pipeline
// (exif-parser) and the export/convert pipeline (import-engine). Kept free of
// Electron imports so services can be unit-tested without an Electron mock.
// If the native module is unavailable (foreign-arch packaged build, missing
// binaries), every caller falls back to the platform tools.
export type SharpFn = (typeof import('sharp'))['default'];

import path from 'node:path';
import { existsSync } from 'node:fs';

let sharpModule: SharpFn | null | undefined;

export function getSharpModule(): SharpFn | null {
  if (sharpModule !== undefined) return sharpModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const resourcesPath = (process as typeof process & { resourcesPath?: string }).resourcesPath;
    const packagedPath = resourcesPath
      ? path.join(resourcesPath, 'sharp-runtime', 'node_modules', 'sharp')
      : '';
    const modulePath = packagedPath && existsSync(packagedPath) ? packagedPath : 'sharp';
    const mod = require(modulePath) as SharpFn | { default: SharpFn };
    sharpModule = typeof mod === 'function' ? mod : mod.default;
  } catch {
    sharpModule = null;
  }
  return sharpModule ?? null;
}

export function isSharpAvailable(): boolean {
  return getSharpModule() !== null;
}
