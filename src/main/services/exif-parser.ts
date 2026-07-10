import exifr from 'exifr';
import { stat, readFile, mkdir, open as fsOpen, writeFile, unlink } from 'node:fs/promises';
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

// Lazy-loaded sharp (libvips). Decodes and resizes on libuv worker threads
// instead of the main process event loop, and replaces per-file process
// spawns (sips/PowerShell/ImageMagick) which cost ~300ms–2s each on Windows.
// Loader lives in sharp-loader so the import/export pipeline can share it.
import { getSharpModule } from './sharp-loader';
export { isSharpAvailable } from './sharp-loader';

function getSharp() {
  return getSharpModule();
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
  '.jpg', '.jpeg', '.heic', '.heif', '.tif', '.tiff',
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
    return (s.mode & fsConstants.S_IWUSR) === 0;
  } catch {
    return false;
  }
}

function normalizeExifOrientation(value: unknown): number | undefined {
  if (typeof value === 'number' && value >= 1 && value <= 8) return value;
  if (typeof value !== 'string') return undefined;
  const text = value.toLowerCase();
  if (/\b8\b/.test(text) || text.includes('270') || text.includes('ccw') || text.includes('left')) return 8;
  if (/\b6\b/.test(text) || text.includes('90') || text.includes('cw') || text.includes('right')) return 6;
  if (/\b3\b/.test(text) || text.includes('180')) return 3;
  if (/\b1\b/.test(text) || text.includes('horizontal') || text.includes('normal')) return 1;
  return undefined;
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
      const exif = await exifr.parse(file.path, {
        pick: [
          'DateTimeOriginal', 'CreateDate', 'ModifyDate', 'Orientation',
          'ISO', 'FNumber', 'ExposureTime', 'FocalLength',
          'Make', 'Model', 'LensModel',
          'Rating', 'RatingPercent', 'ProtectStatus',
          'latitude', 'longitude', 'GPSLatitude', 'GPSLongitude', 'GPSAltitude',
        ],
        reviveValues: true,
        gps: true,
      });
      if (exif) {
        dateTaken = exif.DateTimeOriginal || exif.CreateDate || exif.ModifyDate || null;
        orientation = normalizeExifOrientation(exif.Orientation);
        if (typeof exif.ISO === 'number') iso = exif.ISO;
        if (typeof exif.FNumber === 'number') aperture = exif.FNumber;
        if (typeof exif.ExposureTime === 'number') shutterSpeed = exif.ExposureTime;
        if (typeof exif.FocalLength === 'number') focalLength = exif.FocalLength;
        if (typeof exif.Make === 'string') cameraMake = exif.Make;
        if (typeof exif.Model === 'string') cameraModel = exif.Model;
        if (typeof exif.LensModel === 'string') lensModel = exif.LensModel;
        if (typeof exif.Rating === 'number') rating = exif.Rating;
        else if (typeof exif.RatingPercent === 'number') rating = Math.round(exif.RatingPercent / 20);
        if (exif.ProtectStatus && exif.ProtectStatus !== 0 && exif.ProtectStatus !== 'Off') {
          exifProtected = true;
        }
        gps = gpsFromExif(exif as Record<string, unknown>);
      }
    } catch {
      // EXIF parse failed
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
      if (cached) return cached;
    }

    const thumbData = await exifr.thumbnail(filePath);
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
    const thumbData = await exifr.thumbnail(filePath);
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
    const thumbData = await exifr.thumbnail(filePath);
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

export type PreviewPayload =
  | { kind: 'file'; diskPath: string }
  | { kind: 'buffer'; buffer: Buffer; persisted: boolean };

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
      return await readFile(outPath);
    } catch {
      // not cached
    }

    if (RAW_EXTENSIONS.has(ext)) {
      const fallback = await embeddedFallbackForThumbnail(filePath, ext, outPath);
      if (fallback) return fallback;
    }

    try {
      await platformResize(filePath, outPath, THUMB_WIDTH, 60, 15000);
      return await readFile(outPath);
    } catch {
      return embeddedFallbackForThumbnail(filePath, ext, outPath);
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
    return await promise;
  } finally {
    inflightThumbPayloads.delete(filePath);
  }
}
