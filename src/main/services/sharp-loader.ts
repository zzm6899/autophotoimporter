// Lazy-loaded sharp (libvips) native module, shared by the preview pipeline
// (exif-parser) and the export/convert pipeline (import-engine). Kept free of
// Electron imports so services can be unit-tested without an Electron mock.
// If the native module is unavailable (foreign-arch packaged build, missing
// binaries), every caller falls back to the platform tools.
export type SharpFn = (typeof import('sharp'))['default'];

let sharpModule: SharpFn | null | undefined;

export function getSharpModule(): SharpFn | null {
  if (sharpModule !== undefined) return sharpModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('sharp') as SharpFn | { default: SharpFn };
    sharpModule = typeof mod === 'function' ? mod : mod.default;
  } catch {
    sharpModule = null;
  }
  return sharpModule ?? null;
}

export function isSharpAvailable(): boolean {
  return getSharpModule() !== null;
}
