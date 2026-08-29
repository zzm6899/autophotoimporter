import exifr, { Exifr } from 'exifr';
import { ExifTool, exiftoolPath } from 'exiftool-vendored';
import { stat, access, readFile, mkdir, open as fsOpen, writeFile, unlink } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { app, nativeImage } from 'electron';
import path from 'node:path';
import crypto from 'node:crypto';
import type { MediaFile } from '../../shared/types';
import { detectPhotographerFromFilename, resolvePattern, VIDEO_EXTENSIONS } from '../../shared/types';
import { computeEV100 } from '../../shared/exposure';

const execFileAsync = promisify(execFile);

const exifTool = new ExifTool({
  // Electron's packaged app runs from an ASAR archive, so point the helper at
  // the copy shipped as an extra resource. Development falls back to the
  // package's normal vendored binary.
  exiftoolPath: async () => {
    if (app.isPackaged) {
      const packageName = process.platform === 'win32' ? 'exiftool-vendored.exe' : 'exiftool-vendored.pl';
      const binaryName = process.platform === 'win32' ? 'exiftool.exe' : 'exiftool';
      return path.join(process.resourcesPath, packageName, 'bin', binaryName);
    }
    return exiftoolPath();
  },
});

// Lazy-loaded sharp (libvips). Decodes and resizes on libuv worker threads
// instead of the main process event loop, and replaces per-file process
// spawns (sips/PowerShell/ImageMagick) which cost ~300ms–2s each on Windows.
// Loader lives in sharp-loader so the import/export pipeline can share it.
import { getSharpModule } from './sharp-loader';
export { isSharpAvailable } from './sharp-loader';

function getSharp() {
  return getSharpModule();
}

type ExifrOptions = Exclude<Parameters<typeof exifr.parse>[1], unknown[] | boolean>;
type ExifrReader = {
  close?: () => void | Promise<void>;
};
type ManagedExifr = Exifr & {
  // Exifr exposes the reader at runtime but omits it from its public typings.
  // Keeping access scoped to this helper lets us close its chunked FsReader
  // without changing the dependency or reading an entire multi-gigabyte RAW.
  file?: ExifrReader;
};

/**
 * Run a path-based Exifr operation and deterministically close its chunked
 * FsReader. Exifr 7 calls `file.close()` without awaiting it and skips that
 * call on several early-return/error paths (notably a missing IFD1 thumbnail),
 * which otherwise leaves FileHandles for the GC to close (Node DEP0137).
 *
 * The close wrapper memoizes the first close promise. This means Exifr's own
 * fire-and-forget close and this finally block share the same promise, so the
 * caller does not complete until the descriptor is actually released.
 */
async function withManagedExifr<T>(
  filePath: string,
  options: ExifrOptions,
  operation: (parser: Exifr) => Promise<T>,
): Promise<T> {
  const parser = new Exifr(options) as ManagedExifr;
  try {
    await parser.read(filePath);
    const reader = parser.file;
    if (reader?.close) {
      const closeReader = reader.close.bind(reader);
      let closePromise: Promise<void> | undefined;
      reader.close = () => {
        closePromise ??= Promise.resolve(closeReader()).catch(() => undefined);
        return closePromise;
      };
    }
    return await operation(parser);
  } finally {
    // A parser/read failure must retain its original outcome; close is cleanup.
    // Awaiting it here still prevents unhandled rejections and descriptor GC.
    await parser.file?.close?.();
  }
}

function parseExifFile(filePath: string, options: ExifrOptions): Promise<any> {
  return withManagedExifr(filePath, options, (parser) => parser.parse());
}

function extractExifThumbnail(filePath: string): Promise<Uint8Array | undefined> {
  return withManagedExifr(filePath, undefined, (parser) => parser.extractThumbnail());
}

// IMPORTANT: no .rotate() here — the renderer ignores embedded EXIF orientation
// (imageOrientation: 'none') and applies rotation via CSS from file.orientation,
// so preview pixels must stay exactly as stored in the file.
async function sharpResizeFile(
  srcPath: string,
  outPath: string,
  width: number,
  quality: number,
): Promise<void> {
  const sharp = getSharp();
  if (!sharp) throw new Error('sharp unavailable');
  await sharp(srcPath, { failOn: 'none' })
    .resize({ width, withoutEnlargement: true })
    .jpeg({ quality })
    .toFile(outPath);
}

async function sharpResizeBufferToBuffer(
  jpeg: Buffer,
  width: number,
  quality: number,
): Promise<Buffer | undefined> {
  const sharp = getSharp();
  if (!sharp) return undefined;
  try {
    return await sharp(jpeg, { failOn: 'none' })
      .resize({ width, withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer();
  } catch {
    return undefined;
  }
}

export const EXIFR_SUPPORTED = new Set([
  '.jpg', '.jpeg', '.jpe', '.heic', '.heif', '.hif', '.tif', '.tiff',
  // Canon
  '.cr2', '.cr3', '.crw',
  // Nikon
  '.nef', '.nrw',
  // Sony
  '.arw', '.srf', '.sr2',
  // Fujifilm
  '.raf',
  // Olympus / OM System
  '.orf',
  // Panasonic
  '.rw2',
  // Pentax
  '.pef',
  // Samsung
  '.srw',
  // Leica
  '.rwl',
  // Sigma
  '.x3f',
  // Hasselblad
  '.3fr', '.fff',
  // Phase One
  '.iiq',
  // Adobe / Generic
  '.dng',
  // GoPro
  '.gpr',
  // Minolta (legacy)
  '.mrw',
  // Epson
  '.erf',
]);

const RAW_EXTENSIONS = new Set([
  '.cr2', '.cr3', '.crw',
  '.nef', '.nrw',
  '.arw', '.srf', '.sr2',
  '.raf', '.orf', '.rw2', '.pef', '.srw', '.rwl',
  '.x3f', '.3fr', '.fff', '.iiq', '.dng', '.gpr', '.mrw', '.erf',
]);

const THUMB_WIDTH = 320;
const PREVIEW_WIDTH = 1920;
const PREVIEW_QUALITY = 85;
const DETAIL_PREVIEW_WIDTH = 3840;
const DETAIL_PREVIEW_QUALITY = 92;
// Most cameras embed their full preview within the first 3MB of the RAW file.
// We try 3MB first; if no large JPEG is found we extend to 12MB as a fallback.
const MAX_RAW_SCAN_BYTES_FAST = 3 * 1024 * 1024;
const MAX_RAW_SCAN_BYTES = 12 * 1024 * 1024;
const MAX_DIRECT_THUMB_BYTES = 512 * 1024;
const MAX_DIRECT_PREVIEW_BYTES = 6 * 1024 * 1024;

// In-memory thumbnail result cache — avoids re-reading RAW files across
// repeated scans of the same source. Keyed by "path|mtime|size". Stores raw
// JPEG buffers (served by the preview protocol); max 2000 entries (~120MB at
// 60KB/thumb average) — evict oldest on overflow.
const thumbMemCache = new Map<string, Buffer>();
const THUMB_MEM_CACHE_MAX = 2000;
type CachedThumbnailPayload =
  | { kind: 'file'; diskPath: string }
  | { kind: 'buffer'; buffer: Buffer; persisted: boolean };
// Path-keyed handoff from the scanner/grid to detector-only AI. The scan
// already invalidates this map at source start/change, so the AI fast path can
// avoid repeating source-drive stat/hash/EXIF work for every frame.
const resolvedThumbnailPayloads = new Map<string, CachedThumbnailPayload>();
const RESOLVED_THUMBNAIL_MAX = 2000;

function rememberResolvedThumbnail(filePath: string, payload: CachedThumbnailPayload): void {
  if (resolvedThumbnailPayloads.has(filePath)) resolvedThumbnailPayloads.delete(filePath);
  resolvedThumbnailPayloads.set(filePath, payload);
  if (resolvedThumbnailPayloads.size > RESOLVED_THUMBNAIL_MAX) {
    const oldest = resolvedThumbnailPayloads.keys().next().value as string | undefined;
    if (oldest) resolvedThumbnailPayloads.delete(oldest);
  }
}

function thumbMemCacheKey(filePath: string, mtimeMs: number, size: number): string {
  return `${filePath}|${mtimeMs}|${size}`;
}

function thumbMemCacheSet(key: string, buffer: Buffer): void {
  if (thumbMemCache.size >= THUMB_MEM_CACHE_MAX) {
    // Evict oldest entry
    thumbMemCache.delete(thumbMemCache.keys().next().value as string);
  }
  thumbMemCache.set(key, buffer);
}

export function clearThumbnailMemCache(): void {
  thumbMemCache.clear();
  resolvedThumbnailPayloads.clear();
}

// Settings-driven overrides (will be set at runtime by ipc-handlers)
let rawPreviewQuality = PREVIEW_QUALITY;  // Can be overridden by user settings
let rawPreviewCacheEnabled = true;
const rawPreviewCacheCounters = {
  hits: 0,
  misses: 0,
  transientGenerations: 0,
  embeddedFallbacks: 0,
  platformResizes: 0,
  failures: 0,
  cleanups: 0,
};

let thumbDir: string | null = null;
const PREVIEW_CACHE_SCHEMA_VERSION = 'preview-v2';

async function getThumbDir(): Promise<string> {
  if (!thumbDir) {
    thumbDir = path.join(app.getPath('temp'), 'photo-importer-thumbs');
    await mkdir(thumbDir, { recursive: true });
  }
  return thumbDir;
}

export async function getPreviewCacheDirectory(): Promise<string> {
  return getThumbDir();
}

export function setRawPreviewQuality(quality: number): void {
  const requested = typeof quality === 'number' && Number.isFinite(quality) ? quality : PREVIEW_QUALITY;
  rawPreviewQuality = Math.max(30, Math.min(100, requested));
}

export function setRawPreviewCache(enabled: boolean): void {
  rawPreviewCacheEnabled = enabled;
}

export function getRawPreviewCacheDiagnostics() {
  return {
    enabled: rawPreviewCacheEnabled,
    quality: rawPreviewQuality,
    ...rawPreviewCacheCounters,
  };
}

export function resetRawPreviewCacheDiagnostics(): void {
  rawPreviewCacheCounters.hits = 0;
  rawPreviewCacheCounters.misses = 0;
  rawPreviewCacheCounters.transientGenerations = 0;
  rawPreviewCacheCounters.embeddedFallbacks = 0;
  rawPreviewCacheCounters.platformResizes = 0;
  rawPreviewCacheCounters.failures = 0;
  rawPreviewCacheCounters.cleanups = 0;
}

async function isFileProtected(filePath: string): Promise<boolean> {
  try {
    const s = await stat(filePath);
    if ((s.mode & fsConstants.S_IWUSR) === 0) return true;

    // On Windows, camera "protected" images are commonly exposed as the DOS
    // read-only attribute rather than a POSIX permission bit. W_OK is the
    // native access check and correctly catches that attribute without
    // spawning a process for every file in a card scan.
    if (process.platform === 'win32') {
      try {
        await access(filePath, fsConstants.W_OK);
      } catch {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function metadataValue(exif: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    const exact = exif[name];
    if (exact !== undefined && exact !== null) return exact;
    const key = Object.keys(exif).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    if (key && exif[key] !== undefined && exif[key] !== null) return exif[key];
  }
  return undefined;
}

function metadataEntriesMatching(exif: Record<string, unknown>, pattern: RegExp): Array<[string, unknown]> {
  return Object.entries(exif).filter(([key, value]) => pattern.test(key) && value !== undefined && value !== null);
}

function normalizeCameraRating(value: unknown, percent = false): number | undefined {
  const numeric = numberFromExif(value) ?? (typeof value === 'string'
    ? numberFromExif(value.match(/-?\d+(?:\.\d+)?/)?.[0])
    : undefined);
  if (numeric === undefined) return undefined;
  const stars = percent || numeric > 5 ? Math.round(numeric / 20) : Math.round(numeric);
  return Math.max(0, Math.min(5, stars));
}

function metadataBoolean(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
  if (typeof value !== 'string') return false;
  return /^(true|yes|on|locked?|protected|protect(ed|ion)?|read[- ]?only|1)$/i.test(value.trim());
}

async function readExifToolMetadata(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    // Do not use ExifTool's -fast mode here: some proprietary maker-note
    // protection fields are only reached during a complete metadata walk.
    const tags = await exifTool.read<Record<string, unknown>>(filePath, { readArgs: [] });
    return tags;
  } catch {
    return undefined;
  }
}

function applyFlagMetadata(
  exif: Record<string, unknown>,
  currentRating: number | undefined,
  currentProtected: boolean,
): { rating: number | undefined; isProtected: boolean } {
  let rating = currentRating;
  let isProtected = currentProtected;
  if (rating === undefined) {
    rating = normalizeCameraRating(metadataValue(exif,
      ['Rating', 'RatingStars', 'RatingValue', 'ImageRating', 'UserRating']));
  }
  if (rating === undefined) {
    rating = normalizeCameraRating(metadataValue(exif, ['RatingPercent']), true);
  }
  if (rating === undefined) {
    const ratingEntry = metadataEntriesMatching(exif, /rating|stars?/i)
      .find(([key]) => !/percent/i.test(key));
    rating = normalizeCameraRating(ratingEntry?.[1]);
  }
  if (!isProtected) {
    isProtected = [
      'ProtectStatus', 'Protected', 'Protection', 'Protect', 'FileProtection',
      'ImageProtection', 'LockStatus', 'Locked',
    ].some((name) => metadataBoolean(metadataValue(exif, [name])));
  }
  if (!isProtected) {
    isProtected = metadataEntriesMatching(exif, /protect|lock/i)
      .some(([, value]) => metadataBoolean(value));
  }
  return { rating, isProtected };
}

export function normalizeExifOrientation(value: unknown): number | undefined {
  if (typeof value === 'number' && value >= 1 && value <= 8) return value;
  if (typeof value !== 'string') return undefined;
  const text = value.toLowerCase();
  if (/\b[1-8]\b/.test(text)) {
    const numeric = Number(text.match(/\b([1-8])\b/)?.[1]);
    if (numeric >= 1 && numeric <= 8) return numeric;
  }
  if (text.includes('transpose')) return 5;
  if (text.includes('transverse')) return 7;
  const mirrored = text.includes('mirror') || text.includes('flip');
  if (mirrored && (text.includes('270') || text.includes('ccw') || text.includes('left'))) return 5;
  if (mirrored && (text.includes('90') || text.includes('cw') || text.includes('right'))) return 7;
  if (mirrored && text.includes('vertical')) return 4;
  if (mirrored && text.includes('horizontal')) return 2;
  if (text.includes('270') || text.includes('ccw') || text.includes('left')) return 8;
  if (text.includes('90') || text.includes('cw') || text.includes('right')) return 6;
  if (/\b3\b/.test(text) || text.includes('180')) return 3;
  if (text.includes('horizontal') || text.includes('normal')) return 1;
  return undefined;
}

/**
 * Read only the orientation tag needed by native AI preprocessing.
 * Failure is deliberately represented as orientation 1: detection should still
 * run when metadata is absent or malformed, while never turning a metadata
 * problem into a false "zero faces" result.
 */
export async function readExifOrientation(filePath: string): Promise<number> {
  try {
    const metadata = await parseExifFile(filePath, {
      pick: ['Orientation'],
      reviveValues: true,
    });
    return normalizeExifOrientation(metadata?.Orientation) ?? 1;
  } catch {
    return 1;
  }
}

function numberFromExif(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function gpsFromExif(exif: Record<string, unknown>): MediaFile['gps'] | undefined {
  const latitude = numberFromExif(exif.latitude ?? exif.GPSLatitude);
  const longitude = numberFromExif(exif.longitude ?? exif.GPSLongitude);
  if (latitude === undefined || longitude === undefined) return undefined;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return undefined;
  const altitude = numberFromExif(exif.GPSAltitude);
  return altitude === undefined ? { latitude, longitude } : { latitude, longitude, altitude };
}

function locationLabelFromGps(gps: MediaFile['gps']): string | undefined {
  if (!gps) return undefined;
  return `${gps.latitude.toFixed(4)}, ${gps.longitude.toFixed(4)}`;
}

export async function parseExifDate(
  file: MediaFile,
  folderPattern?: string,
): Promise<{
  dateTaken?: string;
  destPath?: string;
  photographerCode?: string;
  photographerName?: string;
  orientation?: number;
  iso?: number;
  aperture?: number;
  shutterSpeed?: number;
  focalLength?: number;
  cameraMake?: string;
  cameraModel?: string;
  lensModel?: string;
  rating?: number;
  isProtected?: boolean;
  exposureValue?: number;
  gps?: MediaFile['gps'];
  locationName?: string;
}> {
  let dateTaken: Date | null = null;
  let orientation: number | undefined;
  let iso: number | undefined;
  let aperture: number | undefined;
  let shutterSpeed: number | undefined;
  let focalLength: number | undefined;
  let cameraMake: string | undefined;
  let cameraModel: string | undefined;
  let lensModel: string | undefined;
  let rating: number | undefined;
  let exifProtected = false;
  let gps: MediaFile['gps'] | undefined;

  if (file.type === 'photo' && EXIFR_SUPPORTED.has(file.extension)) {
    try {
      const exif = await parseExifFile(file.path, {
        pick: [
          'DateTimeOriginal', 'CreateDate', 'ModifyDate', 'Orientation',
          'ISO', 'FNumber', 'ExposureTime', 'FocalLength',
          'Make', 'Model', 'LensModel',
          'Rating', 'RatingPercent', 'ProtectStatus',
          'RatingStars', 'RatingValue', 'ImageRating', 'UserRating',
          'Protected', 'Protection', 'Protect', 'FileProtection', 'ImageProtection', 'LockStatus', 'Locked',
          'latitude', 'longitude', 'GPSLatitude', 'GPSLongitude', 'GPSAltitude',
        ],
        // Camera applications store these values in XMP and/or proprietary
        // maker notes. Both readers are opt-in in Exifr; without them the
        // same image can scan correctly on one camera and lose its flags on
        // another.
        xmp: true,
        makerNote: true,
        reviveValues: true,
        gps: true,
      });
      if (exif) {
        const exifRecord = exif as Record<string, unknown>;
        dateTaken = exif.DateTimeOriginal || exif.CreateDate || exif.ModifyDate || null;
        orientation = normalizeExifOrientation(exif.Orientation);
        if (typeof exif.ISO === 'number') iso = exif.ISO;
        if (typeof exif.FNumber === 'number') aperture = exif.FNumber;
        if (typeof exif.ExposureTime === 'number') shutterSpeed = exif.ExposureTime;
        if (typeof exif.FocalLength === 'number') focalLength = exif.FocalLength;
        if (typeof exif.Make === 'string') cameraMake = exif.Make;
        if (typeof exif.Model === 'string') cameraModel = exif.Model;
        if (typeof exif.LensModel === 'string') lensModel = exif.LensModel;
        ({ rating, isProtected: exifProtected } = applyFlagMetadata(exifRecord, rating, exifProtected));
        gps = gpsFromExif(exif as Record<string, unknown>);
      }
    } catch {
      // EXIF parse failed
    }
  }

  // ExifTool carries the broadest maintained database of proprietary camera
  // tags. Use it only when Exifr did not expose one of the two user flags so
  // normal scans retain the fast in-process path for ordinary JPEGs.
  if (file.type === 'photo' && (rating === undefined || !exifProtected)) {
    const toolExif = await readExifToolMetadata(file.path);
    if (toolExif) {
      ({ rating, isProtected: exifProtected } = applyFlagMetadata(toolExif, rating, exifProtected));
    }
  }

  if (!dateTaken) {
    try {
      const fileStat = await stat(file.path);
      dateTaken = fileStat.mtime;
    } catch {
      dateTaken = new Date();
    }
  }

  const fsProtected = await isFileProtected(file.path);
  const isProtected = fsProtected || exifProtected;

  const photographer = detectPhotographerFromFilename(file.name);
  const pattern = folderPattern || '{YYYY}-{MM}-{DD}/{filename}';
  const destPath = resolvePattern(pattern, dateTaken, file.name, file.extension, rating, photographer);
  const exposureValue = computeEV100(aperture, shutterSpeed, iso);
  const locationName = locationLabelFromGps(gps);
  return {
    dateTaken: dateTaken.toISOString(),
    destPath,
    photographerCode: photographer?.code,
    photographerName: photographer?.name,
    orientation,
    iso,
    aperture,
    shutterSpeed,
    focalLength,
    cameraMake,
    cameraModel,
    lensModel,
    rating,
    isProtected,
    exposureValue,
    gps,
    locationName,
  };
}

async function extractEmbeddedThumbnailBuffer(
  filePath: string,
  extension: string,
): Promise<Buffer | undefined> {
  if (!EXIFR_SUPPORTED.has(extension)) return undefined;
  try {
    // Check memory cache first — avoids re-reading the same RAW on repeated scans.
    const s = await stat(filePath).catch(() => null);
    const memKey = s ? thumbMemCacheKey(filePath, s.mtimeMs, s.size) : null;
    if (memKey) {
      const cached = thumbMemCache.get(memKey);
      if (cached) {
        rememberResolvedThumbnail(filePath, { kind: 'buffer', buffer: cached, persisted: false });
        return cached;
      }
    }

    const thumbData = await extractExifThumbnail(filePath);
    if (!thumbData || thumbData.byteLength === 0) return undefined;
    const buffer = Buffer.isBuffer(thumbData) ? thumbData : Buffer.from(thumbData);
    let result: Buffer | undefined;
    if (buffer.length > MAX_DIRECT_THUMB_BYTES) {
      // Larger than ideal for a grid thumbnail — resize in-process (no process
      // spawn; sharp with a nativeImage fallback).
      result = await resizeEmbeddedJpegToBuffer(buffer, undefined, THUMB_WIDTH, 70);
    } else {
      result = buffer;
    }
    if (result && memKey) thumbMemCacheSet(memKey, result);
    if (result) rememberResolvedThumbnail(filePath, { kind: 'buffer', buffer: result, persisted: false });
    return result;
  } catch {
    return undefined;
  }
}

export async function extractEmbeddedThumbnail(
  filePath: string,
  extension: string,
): Promise<string | undefined> {
  const buf = await extractEmbeddedThumbnailBuffer(filePath, extension);
  return buf ? `data:image/jpeg;base64,${buf.toString('base64')}` : undefined;
}

// Ensure-style variants used by the scanner: they generate/cache the
// thumbnail bytes but return only success — the renderer receives a
// keptra-preview:// URL and fetches the bytes via the protocol instead of a
// base64 payload over IPC.
export async function ensureEmbeddedThumbnail(filePath: string, extension: string): Promise<boolean> {
  return !!(await extractEmbeddedThumbnailBuffer(filePath, extension));
}

export async function ensureGeneratedThumbnail(filePath: string): Promise<boolean> {
  return !!(await generateThumbnailBuffer(filePath));
}

async function sipsResize(
  srcPath: string,
  outPath: string,
  width: number,
  quality: number,
  timeoutMs: number,
): Promise<void> {
  await execFileAsync(
    'sips',
    [
      '-s', 'format', 'jpeg',
      '-s', 'formatOptions', String(quality),
      '--resampleWidth', String(width),
      srcPath,
      '--out', outPath,
    ],
    { timeout: timeoutMs },
  );
}

function psQuote(p: string): string {
  return `'${p.replace(/'/g, "''")}'`;
}

async function powershellResize(
  srcPath: string,
  outPath: string,
  width: number,
  quality: number,
  timeoutMs: number,
): Promise<void> {
  const script = `
    Add-Type -AssemblyName System.Drawing
    $src = [System.Drawing.Image]::FromFile(${psQuote(srcPath)})
    try {
      $ratio = $src.Height / $src.Width
      $w = [int]${width}
      $h = [int]($w * $ratio)
      if ($h -lt 1) { $h = 1 }
      $bmp = New-Object System.Drawing.Bitmap $w, $h
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.DrawImage($src, 0, 0, $w, $h)
      $g.Dispose()
      $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
        Where-Object { $_.MimeType -eq 'image/jpeg' }
      $params = New-Object System.Drawing.Imaging.EncoderParameters 1
      $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
        [System.Drawing.Imaging.Encoder]::Quality, [long]${quality})
      $bmp.Save(${psQuote(outPath)}, $codec, $params)
      $bmp.Dispose()
    } finally {
      $src.Dispose()
    }
  `.trim();

  await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: timeoutMs, windowsHide: true },
  );
}

async function linuxResize(
  srcPath: string,
  outPath: string,
  width: number,
  quality: number,
  timeoutMs: number,
): Promise<void> {
  const binary = 'convert';
  await execFileAsync(
    binary,
    [srcPath, '-resize', `${width}x`, '-quality', String(quality), outPath],
    { timeout: timeoutMs },
  );
}

async function platformResize(
  srcPath: string,
  outPath: string,
  width: number,
  quality: number,
  timeoutMs: number,
): Promise<void> {
  // Fast path: in-process libvips resize (no process spawn, off the event
  // loop). Falls through to the platform tools for formats sharp can't decode
  // (e.g. HEIC without libheif, camera RAW).
  if (getSharp()) {
    try {
      await sharpResizeFile(srcPath, outPath, width, quality);
      return;
    } catch {
      // unsupported format — fall back to platform tools below
    }
  }
  if (process.platform === 'darwin') return sipsResize(srcPath, outPath, width, quality, timeoutMs);
  if (process.platform === 'win32') return powershellResize(srcPath, outPath, width, quality, timeoutMs);
  return linuxResize(srcPath, outPath, width, quality, timeoutMs);
}

// Resize an already-decoded JPEG buffer in-process using Electron's nativeImage.
// No process spawn needed — this is ~100x faster than PowerShell/sips per call.
async function resizeEmbeddedJpegToBuffer(
  jpeg: Buffer,
  outPath: string | undefined,
  width: number,
  quality: number,
): Promise<Buffer | undefined> {
  // Prefer sharp: runs on worker threads instead of blocking the main process
  // event loop the way the synchronous nativeImage resize below does.
  let buf = await sharpResizeBufferToBuffer(jpeg, width, quality);
  if (!buf) {
    try {
      const img = nativeImage.createFromBuffer(jpeg);
      if (img.isEmpty()) return undefined;
      buf = img.resize({ width }).toJPEG(quality);
    } catch {
      return undefined;
    }
  }
  if (outPath) {
    try {
      await writeFile(outPath, buf);
    } catch {
      // best-effort cache write
    }
  }
  return buf;
}

// Most RAW files (NEF, CR2, ARW, DNG, RAF, ORF, RW2...) embed one or more JPEG
// previews inside the TIFF container. exifr.thumbnail() typically only returns
// the small ~160x120 IFD1 thumbnail, which is useless at loupe size. To get
// the usable full-size preview (~1620x1080 for NEF) we scan the raw bytes for
// JPEG SOI/EOI markers and keep the largest embedded JPEG.
export async function extractLargestEmbeddedJpeg(filePath: string): Promise<Buffer | undefined> {
  let buf: Buffer;
  try {
    const fullStat = await stat(filePath);
    const fileSize = Number(fullStat.size);
    // Two-pass strategy: try first 3MB (covers ~95% of cameras). Only extend
    // to 12MB if no preview-sized JPEG (>256KB) was found in the fast pass.
    const fastRead = Math.min(fileSize, MAX_RAW_SCAN_BYTES_FAST);
    buf = Buffer.alloc(fastRead);
    const handle = await fsOpen(filePath, 'r');
    try {
      await handle.read(buf, 0, fastRead, 0);
      const fast = scanBufferForLargestJpeg(buf);
      if (fast && fast.length > 256 * 1024) return fast;
      // Fast pass found nothing useful — extend to full limit
      if (fileSize > fastRead) {
        const fullRead = Math.min(fileSize, MAX_RAW_SCAN_BYTES);
        const fullBuf = Buffer.alloc(fullRead);
        await handle.read(fullBuf, 0, fullRead, 0);
        buf = fullBuf;
      }
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }

  return scanBufferForLargestJpeg(buf);
}

function scanBufferForLargestJpeg(buf: Buffer): Buffer | undefined {
  let best: Buffer | undefined;
  let i = 0;
  while (i < buf.length - 4) {
    // Skip quickly to the next 0xFF rather than advancing one byte at a time.
    i = buf.indexOf(0xff, i);
    if (i < 0 || i >= buf.length - 4) break;
    if (buf[i + 1] === 0xd8 && buf[i + 2] === 0xff) {
      const m = buf[i + 3];
      // Accept any valid JPEG starting sequence: all APP markers (0xe0–0xef covers
      // JFIF, EXIF, ICC profile, Photoshop IPTC/APP13=0xed, etc.), bare quantisation
      // tables (0xdb), SOF (0xc0), Huffman tables (0xc4), or a comment (0xfe).
      if ((m >= 0xe0 && m <= 0xef) || m === 0xdb || m === 0xc0 || m === 0xc4 || m === 0xfe) {
        const eoi = findJpegEnd(buf, i + 2);
        if (eoi > i) {
          const segLen = eoi - i + 2;
          if (!best || segLen > best.length) {
            best = buf.subarray(i, eoi + 2);
          }
          i = eoi + 2;
          continue;
        }
      }
    }
    i += 1;
  }
  return best;
}

function findJpegEnd(buf: Buffer, start: number): number {
  let i = start;
  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    let j = i;
    while (j < buf.length - 1 && buf[j] === 0xff) j += 1;
    const marker = buf[j];
    if (marker === 0x00) { i = j + 1; continue; }
    if (marker === 0xd9) return j;
    if (marker === 0xd8) { i = j + 1; continue; }
    if (marker >= 0xd0 && marker <= 0xd7) { i = j + 1; continue; }
    if (j + 2 >= buf.length) return -1;
    const segLen = buf.readUInt16BE(j + 1);
    if (segLen < 2) return -1;
    if (marker === 0xda) {
      i = j + 1 + segLen;
      while (i < buf.length - 1) {
        if (buf[i] === 0xff) {
          const nxt = buf[i + 1];
          if (nxt === 0x00) { i += 2; continue; }
          if (nxt >= 0xd0 && nxt <= 0xd7) { i += 2; continue; }
          break;
        }
        i += 1;
      }
      continue;
    }
    i = j + 1 + segLen;
  }
  return -1;
}

async function embeddedFallbackBuffer(
  filePath: string,
  extension: string,
  width: number,
  quality: number,
  persistPath?: string,
): Promise<Buffer | undefined> {
  if (!EXIFR_SUPPORTED.has(extension)) return undefined;

  try {
    const big = await extractLargestEmbeddedJpeg(filePath);
    if (big && big.length > 32 * 1024) {
      if (big.length > MAX_DIRECT_PREVIEW_BYTES) {
        const resized = await resizeEmbeddedJpegToBuffer(big, persistPath, width, quality);
        if (resized) return resized;
      }
      // Copy out of the (up to 12MB) scan buffer so it can be GC'd, and
      // persist so the preview protocol can serve future requests from disk.
      const buf = Buffer.from(big);
      if (persistPath) {
        try { await writeFile(persistPath, buf); } catch { /* best-effort */ }
      }
      return buf;
    }
  } catch {
    // fall through
  }

  try {
    const thumbData = await extractExifThumbnail(filePath);
    if (!thumbData || thumbData.byteLength === 0) return undefined;
    const buffer = Buffer.from(thumbData);
    if (persistPath) {
      try { await writeFile(persistPath, buffer); } catch { /* best-effort */ }
    }
    return buffer;
  } catch {
    return undefined;
  }
}

/**
 * Lightweight embedded-thumbnail extractor used only for grid thumbnails.
 * Tries exifr.thumbnail() first (fast, no full file read). Falls back to
 * byte-scan only when exifr returns nothing at all (not when it returns a
 * small thumbnail — a small thumb is better than a 3–12MB RAW read stalling
 * the queue for 1000 other files).
 */
async function embeddedFallbackForThumbnail(
  filePath: string,
  extension: string,
  outPath?: string,
): Promise<Buffer | undefined> {
  if (!EXIFR_SUPPORTED.has(extension)) return undefined;

  // Check memory cache first.
  const s = await stat(filePath).catch(() => null);
  const memKey = s ? thumbMemCacheKey(filePath, s.mtimeMs, s.size) : null;
  if (memKey) {
    const cached = thumbMemCache.get(memKey);
    if (cached) return cached;
  }

  // Fast path: exifr parses the IFD1 thumbnail without reading the whole file.
  try {
    const thumbData = await extractExifThumbnail(filePath);
    if (thumbData && thumbData.byteLength > 0) {
      const buffer = Buffer.isBuffer(thumbData) ? thumbData : Buffer.from(thumbData);
      let result: Buffer | undefined;
      if (outPath && buffer.length > MAX_DIRECT_THUMB_BYTES) {
        result = await resizeEmbeddedJpegToBuffer(buffer, outPath, THUMB_WIDTH, 60);
      }
      if (!result) result = buffer;
      // Accept any size — even a small IFD1 thumb is instantly usable in the grid.
      if (memKey) thumbMemCacheSet(memKey, result);
      return result;
    }
  } catch {
    // Fall through to the byte-scan path. Some RAW files have no IFD1 thumb
    // but still contain a usable embedded JPEG preview.
  }

  // Slow path: only when exifr returned nothing (missing/no IFD1 thumbnail).
  // This reads up to 3MB (fast pass) then up to 12MB if needed.
  try {
    const big = await extractLargestEmbeddedJpeg(filePath);
    if (big && big.length > 32 * 1024) {
      const resized = outPath
        ? await resizeEmbeddedJpegToBuffer(big, outPath, THUMB_WIDTH, 60)
        : undefined;
      const result = resized
        ?? (big.length <= MAX_DIRECT_THUMB_BYTES ? Buffer.from(big) : undefined);
      if (result && memKey) thumbMemCacheSet(memKey, result);
      return result;
    }
  } catch {
    // fall through
  }

  return undefined;
}

async function cacheKeyFor(filePath: string): Promise<string> {
  try {
    const s = await stat(filePath);
    return crypto
      .createHash('md5')
      .update(`${filePath}|${s.mtimeMs}|${s.size}`)
      .digest('hex')
      .slice(0, 16);
  } catch {
    return crypto.createHash('md5').update(filePath).digest('hex').slice(0, 16);
  }
}

async function previewCacheKeyFor(
  filePath: string,
  variant: 'preview' | 'detail',
  width: number,
  quality: number,
): Promise<string> {
  const fileIdentity = await cacheKeyFor(filePath);
  return crypto
    .createHash('md5')
    .update(`${PREVIEW_CACHE_SCHEMA_VERSION}|${fileIdentity}|${variant}|w${width}|q${quality}`)
    .digest('hex')
    .slice(0, 16);
}

export type PreviewPayload = CachedThumbnailPayload;

const inflightPreviews = new Map<string, Promise<PreviewPayload | undefined>>();

export function getRawPreviewQualitySetting(): number {
  return rawPreviewQuality;
}

function previewVariantParams(variant: 'preview' | 'detail'): { width: number; quality: number; suffix: string } {
  return {
    width: variant === 'detail' ? DETAIL_PREVIEW_WIDTH : PREVIEW_WIDTH,
    quality: variant === 'detail' ? DETAIL_PREVIEW_QUALITY : rawPreviewQuality,
    suffix: variant === 'detail' ? 'detail' : 'preview',
  };
}

// Returns the on-disk cache path for a preview if (and only if) it has
// already been generated. Lets the preview protocol and the SCAN_PREVIEW
// fast path serve cached previews without occupying a generation slot.
export async function peekPreviewFile(
  filePath: string,
  variant: 'preview' | 'detail' = 'preview',
): Promise<string | undefined> {
  const ext = path.extname(filePath).toLowerCase();
  if (!rawPreviewCacheEnabled && RAW_EXTENSIONS.has(ext)) return undefined;
  try {
    const { width, quality, suffix } = previewVariantParams(variant);
    const dir = await getThumbDir();
    const key = await previewCacheKeyFor(filePath, variant, width, quality);
    const outPath = path.join(dir, `${key}_${suffix}.jpg`);
    await stat(outPath);
    return outPath;
  } catch {
    return undefined;
  }
}

export async function generatePreviewPayload(
  filePath: string,
  variant: 'preview' | 'detail' = 'preview',
): Promise<PreviewPayload | undefined> {
  const ext = path.extname(filePath).toLowerCase();
  const isRawPreview = RAW_EXTENSIONS.has(ext);
  const cacheEnabled = rawPreviewCacheEnabled || !isRawPreview;
  const { width, quality, suffix } = previewVariantParams(variant);
  const inflightKey = `${filePath}|${variant}|q${quality}|${cacheEnabled ? 'cache' : 'nocache'}`;
  const existing = inflightPreviews.get(inflightKey);
  if (existing) return existing;

  const promise = (async (): Promise<PreviewPayload | undefined> => {
    let outPath: string | null = null;
    try {
      const dir = await getThumbDir();
      const key = cacheEnabled
        ? await previewCacheKeyFor(filePath, variant, width, quality)
        : crypto.createHash('md5').update(`${filePath}|${variant}|${quality}`).digest('hex').slice(0, 16);
      outPath = cacheEnabled
        ? path.join(dir, `${key}_${suffix}.jpg`)
        : path.join(dir, `${key}_${suffix}_${process.pid}_${Date.now()}.jpg`);
      if (!cacheEnabled && isRawPreview) rawPreviewCacheCounters.transientGenerations++;

      if (cacheEnabled) {
        try {
          await stat(outPath);
          if (isRawPreview) rawPreviewCacheCounters.hits++;
          return { kind: 'file', diskPath: outPath };
        } catch {
          if (isRawPreview) rawPreviewCacheCounters.misses++;
          // not cached
        }
      }

      if (isRawPreview) {
        const fallback = await embeddedFallbackBuffer(filePath, ext, width, quality, cacheEnabled ? outPath : undefined);
        if (fallback) {
          rawPreviewCacheCounters.embeddedFallbacks++;
          return { kind: 'buffer', buffer: fallback, persisted: cacheEnabled };
        }
      }

      try {
        await platformResize(filePath, outPath, width, quality, 30000);
        if (isRawPreview) rawPreviewCacheCounters.platformResizes++;
        if (cacheEnabled) return { kind: 'file', diskPath: outPath };
        const transient = await readFile(outPath);
        return { kind: 'buffer', buffer: transient, persisted: false };
      } catch {
        const fallback = await embeddedFallbackBuffer(filePath, ext, width, quality, cacheEnabled ? outPath : undefined);
        if (fallback && isRawPreview) rawPreviewCacheCounters.embeddedFallbacks++;
        if (!fallback && isRawPreview) rawPreviewCacheCounters.failures++;
        return fallback ? { kind: 'buffer', buffer: fallback, persisted: cacheEnabled } : undefined;
      }
    } catch {
      if (isRawPreview) rawPreviewCacheCounters.failures++;
      return undefined;
    } finally {
      if (!cacheEnabled && outPath) {
        await unlink(outPath)
          .then(() => { if (isRawPreview) rawPreviewCacheCounters.cleanups++; })
          .catch(() => undefined);
      }
    }
  })();

  inflightPreviews.set(inflightKey, promise);
  try {
    return await promise;
  } finally {
    inflightPreviews.delete(inflightKey);
  }
}

export async function generatePreview(
  filePath: string,
  variant: 'preview' | 'detail' = 'preview',
): Promise<string | undefined> {
  try {
    const payload = await generatePreviewPayload(filePath, variant);
    if (!payload) return undefined;
    const buf = payload.kind === 'buffer' ? payload.buffer : await readFile(payload.diskPath);
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch {
    return undefined;
  }
}

async function generateThumbnailBuffer(filePath: string): Promise<Buffer | undefined> {
  try {
    const dir = await getThumbDir();
    const key = await cacheKeyFor(filePath);
    const outPath = path.join(dir, `${key}.jpg`);
    const ext = path.extname(filePath).toLowerCase();

    try {
      await stat(outPath);
      const buffer = await readFile(outPath);
      rememberResolvedThumbnail(filePath, { kind: 'file', diskPath: outPath });
      return buffer;
    } catch {
      // not cached
    }

    if (RAW_EXTENSIONS.has(ext)) {
      const fallback = await embeddedFallbackForThumbnail(filePath, ext, outPath);
      if (fallback) {
        rememberResolvedThumbnail(filePath, { kind: 'buffer', buffer: fallback, persisted: false });
        return fallback;
      }
    }

    try {
      await platformResize(filePath, outPath, THUMB_WIDTH, 60, 15000);
      const buffer = await readFile(outPath);
      rememberResolvedThumbnail(filePath, { kind: 'file', diskPath: outPath });
      return buffer;
    } catch {
      const fallback = await embeddedFallbackForThumbnail(filePath, ext, outPath);
      if (fallback) rememberResolvedThumbnail(filePath, { kind: 'buffer', buffer: fallback, persisted: false });
      return fallback;
    }
  } catch {
    return undefined;
  }
}

export async function generateThumbnail(filePath: string, _fileName: string): Promise<string | undefined> {
  const buf = await generateThumbnailBuffer(filePath);
  return buf ? `data:image/jpeg;base64,${buf.toString('base64')}` : undefined;
}

// ---- Video thumbnails (system ffmpeg, optional) ----------------------------
// Keptra doesn't ship ffmpeg; if the user has it on PATH we use it to grab a
// grid frame for videos, otherwise videos keep their placeholder as before.

let ffmpegBinaryPromise: Promise<string | null> | null = null;

function detectFfmpeg(): Promise<string | null> {
  if (!ffmpegBinaryPromise) {
    ffmpegBinaryPromise = (async () => {
      try {
        await execFileAsync('ffmpeg', ['-version'], { timeout: 5000, windowsHide: true });
        return 'ffmpeg';
      } catch {
        return null;
      }
    })();
  }
  return ffmpegBinaryPromise;
}

export async function isVideoThumbnailSupported(): Promise<boolean> {
  return (await detectFfmpeg()) !== null;
}

async function videoThumbnailToFile(filePath: string, outPath: string): Promise<boolean> {
  const bin = await detectFfmpeg();
  if (!bin) return false;
  // Try a frame at t=1s first (skips black lead-ins); retry at t=0 for clips
  // shorter than a second.
  for (const seek of [true, false]) {
    try {
      await execFileAsync(
        bin,
        ['-y', ...(seek ? ['-ss', '1'] : []), '-i', filePath, '-frames:v', '1', '-vf', `scale=${THUMB_WIDTH}:-2`, '-q:v', '5', outPath],
        { timeout: 15000, windowsHide: true },
      );
      await stat(outPath);
      return true;
    } catch {
      // try the next strategy
    }
  }
  return false;
}

export async function ensureVideoThumbnail(filePath: string): Promise<boolean> {
  try {
    const dir = await getThumbDir();
    const key = await cacheKeyFor(filePath);
    const outPath = path.join(dir, `${key}.jpg`);
    try {
      await stat(outPath);
      return true;
    } catch {
      // not cached
    }
    return await videoThumbnailToFile(filePath, outPath);
  } catch {
    return false;
  }
}

// ---- Thumbnail payloads for the preview protocol ---------------------------
// Bounded independently of the preview/detail lanes so a burst of grid
// <img> fetches can't stampede RAW byte-scans or ffmpeg spawns.

const inflightThumbPayloads = new Map<string, Promise<PreviewPayload | undefined>>();
const THUMB_FETCH_CONCURRENCY = 6;
let thumbFetchActive = 0;
const thumbFetchQueue: Array<() => void> = [];

async function acquireThumbFetchSlot(): Promise<void> {
  if (thumbFetchActive < THUMB_FETCH_CONCURRENCY) {
    thumbFetchActive++;
    return;
  }
  await new Promise<void>((resolve) => thumbFetchQueue.push(resolve));
}

function releaseThumbFetchSlot(): void {
  thumbFetchActive = Math.max(0, thumbFetchActive - 1);
  if (thumbFetchQueue.length > 0 && thumbFetchActive < THUMB_FETCH_CONCURRENCY) {
    thumbFetchActive++;
    thumbFetchQueue.shift()?.();
  }
}

export async function getThumbnailPayload(filePath: string): Promise<PreviewPayload | undefined> {
  const resolved = resolvedThumbnailPayloads.get(filePath);
  if (resolved) {
    // Refresh bounded insertion order because active AI work should not be
    // evicted behind thumbnails that have not reached review yet.
    rememberResolvedThumbnail(filePath, resolved);
    return resolved;
  }
  const existing = inflightThumbPayloads.get(filePath);
  if (existing) return existing;

  const promise = (async (): Promise<PreviewPayload | undefined> => {
    await acquireThumbFetchSlot();
    try {
      const ext = path.extname(filePath).toLowerCase();
      const dir = await getThumbDir();
      const key = await cacheKeyFor(filePath);
      const outPath = path.join(dir, `${key}.jpg`);

      // Scan-time embedded thumbnails live in the memory cache.
      const s = await stat(filePath).catch(() => null);
      if (s) {
        const cached = thumbMemCache.get(thumbMemCacheKey(filePath, s.mtimeMs, s.size));
        if (cached) return { kind: 'buffer', buffer: cached, persisted: false };
      }
      try {
        await stat(outPath);
        return { kind: 'file', diskPath: outPath };
      } catch {
        // not on disk
      }

      if (VIDEO_EXTENSIONS.has(ext)) {
        const ok = await videoThumbnailToFile(filePath, outPath);
        return ok ? { kind: 'file', diskPath: outPath } : undefined;
      }
      const embedded = await extractEmbeddedThumbnailBuffer(filePath, ext);
      if (embedded) return { kind: 'buffer', buffer: embedded, persisted: false };
      const generated = await generateThumbnailBuffer(filePath);
      return generated ? { kind: 'buffer', buffer: generated, persisted: false } : undefined;
    } finally {
      releaseThumbFetchSlot();
    }
  })();

  inflightThumbPayloads.set(filePath, promise);
  try {
    const payload = await promise;
    if (payload) rememberResolvedThumbnail(filePath, payload);
    return payload;
  } finally {
    inflightThumbPayloads.delete(filePath);
  }
}

/**
 * Read-only scanner-to-AI handoff. Unlike getThumbnailPayload(), this never
 * decodes, resizes, invokes Sharp/nativeImage, or spawns a platform converter.
 * It is therefore safe to use before dispatching RAW work to the supervised
 * preprocessing utility process.
 */
export async function peekThumbnailPayload(filePath: string): Promise<PreviewPayload | undefined> {
  const resolved = resolvedThumbnailPayloads.get(filePath);
  if (resolved) {
    rememberResolvedThumbnail(filePath, resolved);
    return resolved;
  }
  try {
    const dir = await getThumbDir();
    const key = await cacheKeyFor(filePath);
    const outPath = path.join(dir, `${key}.jpg`);
    await stat(outPath);
    return { kind: 'file', diskPath: outPath };
  } catch {
    return undefined;
  }
}

/**
 * Raw RGB pixels prepared from the scanner's existing thumbnail. Sharp/libvips
 * performs JPEG decode and resize off the Electron main thread, avoiding the
 * synchronous nativeImage resize/toBitmap pair in high-volume detector-only
 * review. The original thumbnail dimensions are retained so face-engine can
 * reject tiny camera thumbnails and use its higher-resolution fallback.
 */
export interface DetectionPixelPayload {
  data: Buffer;
  width: number;
  height: number;
  channels: 3;
  sourceWidth: number;
  sourceHeight: number;
}

/** Read JPEG SOF dimensions without decoding pixels. Exported for regression tests. */
export function jpegDimensions(buffer: Buffer): { width: number; height: number } | undefined {
  if (buffer.length < 10 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }
    while (offset < buffer.length && buffer[offset] === 0xff) offset++;
    if (offset >= buffer.length) break;
    const marker = buffer[offset++];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
    if (offset + 2 > buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
    const isStartOfFrame = (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame && segmentLength >= 7) {
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    offset += segmentLength;
  }
  return undefined;
}

export async function getDetectionPixels(
  filePath: string,
  targetWidth: number,
  targetHeight: number,
): Promise<DetectionPixelPayload | undefined> {
  if (!Number.isInteger(targetWidth) || !Number.isInteger(targetHeight)
    || targetWidth <= 0 || targetHeight <= 0
    || targetWidth > 4096 || targetHeight > 4096) return undefined;

  const sharp = getSharp();
  if (!sharp) return undefined;

  try {
    const directJpeg = new Set(['.jpg', '.jpeg', '.jpe']).has(path.extname(filePath).toLowerCase());
    if (directJpeg) {
      // A detector cache miss must not enter generateThumbnailBuffer(), whose
      // final fallback can launch a platform resizer. libjpeg can decode JPEGs
      // directly at a reduced DCT scale (shrink-on-load), avoiding both the
      // 320px intermediate encode and synchronous nativeImage work.
      const pipeline = sharp(filePath, {
        failOn: 'error', sequentialRead: true, limitInputPixels: 180_000_000,
      });
      const metadata = await pipeline.metadata();
      const sourceWidth = metadata.width ?? 0;
      const sourceHeight = metadata.height ?? 0;
      if (sourceWidth <= 0 || sourceHeight <= 0) return undefined;
      const { data, info } = await sharp(filePath, {
        failOn: 'error', sequentialRead: true, limitInputPixels: 180_000_000,
      })
        .resize({ width: targetWidth, height: targetHeight, fit: 'fill' })
        .toColourspace('srgb')
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      if (info.width !== targetWidth || info.height !== targetHeight || info.channels !== 3) return undefined;
      return { data, width: info.width, height: info.height, channels: 3, sourceWidth, sourceHeight };
    }

    const payload = await getThumbnailPayload(filePath);
    if (!payload) return undefined;
    // Scanner thumbnails are deliberately bounded. Read a disk payload once
    // and share that buffer between header validation and libvips instead of
    // making separate header and decoder reads from removable storage.
    const input = payload.kind === 'file' ? await readFile(payload.diskPath) : payload.buffer;
    let sourceDimensions = jpegDimensions(input);
    if (!sourceDimensions) {
      // Defensive support for any future non-JPEG thumbnail payload.
      const metadata = await sharp(input, { failOn: 'none', sequentialRead: true }).metadata();
      if (metadata.width && metadata.height) {
        sourceDimensions = { width: metadata.width, height: metadata.height };
      }
    }
    const sourceWidth = sourceDimensions?.width ?? 0;
    const sourceHeight = sourceDimensions?.height ?? 0;
    if (sourceWidth <= 0 || sourceHeight <= 0) return undefined;

    const { data, info } = await sharp(input, { failOn: 'none', sequentialRead: true })
      .resize({ width: targetWidth, height: targetHeight, fit: 'fill' })
      .toColourspace('srgb')
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.width !== targetWidth || info.height !== targetHeight || info.channels !== 3) {
      return undefined;
    }
    return {
      data,
      width: info.width,
      height: info.height,
      channels: 3,
      sourceWidth,
      sourceHeight,
    };
  } catch {
    // Unsupported/corrupt formats retain the established nativeImage/RAW
    // fallback in face-engine. Detector preparation must never make analysis
    // fail merely because the accelerated decoder rejected one file.
    return undefined;
  }
}
