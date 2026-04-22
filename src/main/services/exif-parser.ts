import exifr from 'exifr';
import { stat, readFile, mkdir, open as fsOpen } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { app } from 'electron';
import path from 'node:path';
import crypto from 'node:crypto';
import type { MediaFile } from '../../shared/types';
import { resolvePattern } from '../../shared/types';
import { computeEV100 } from '../../shared/exposure';

const execFileAsync = promisify(execFile);

export const EXIFR_SUPPORTED = new Set([
  '.jpg', '.jpeg', '.heic', '.heif', '.tif', '.tiff',
  '.cr2', '.cr3', '.crw',
  '.nef', '.nrw',
  '.arw', '.srf', '.sr2',
  '.raf',
  '.orf',
  '.rw2',
  '.pef',
  '.srw',
  '.rwl',
  '.3fr', '.fff',
  '.dng',
  '.gpr',
  '.mrw',
  '.erf',
]);

const RAW_EXTENSIONS = new Set([
  '.cr2', '.cr3', '.crw',
  '.nef', '.nrw',
  '.arw', '.srf', '.sr2',
  '.raf', '.orf', '.rw2', '.pef', '.srw', '.rwl',
  '.3fr', '.fff', '.gpr', '.mrw', '.erf',
]);

const THUMB_WIDTH = 320;
const PREVIEW_WIDTH = 1920;
const PREVIEW_QUALITY = 85;

let thumbDir: string | null = null;

async function getThumbDir(): Promise<string> {
  if (!thumbDir) {
    thumbDir = path.join(app.getPath('temp'), 'photo-importer-thumbs');
    await mkdir(thumbDir, { recursive: true });
  }
  return thumbDir;
}

async function isFileProtected(filePath: string): Promise<boolean> {
  try {
    const s = await stat(filePath);
    return (s.mode & fsConstants.S_IWUSR) === 0;
  } catch {
    return false;
  }
}

export async function parseExifDate(
  file: MediaFile,
  folderPattern?: string,
): Promise<{
  dateTaken?: string;
  destPath?: string;
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

  if (file.type === 'photo' && EXIFR_SUPPORTED.has(file.extension)) {
    try {
      const exif = await exifr.parse(file.path, {
        pick: [
          'DateTimeOriginal', 'CreateDate', 'ModifyDate', 'Orientation',
          'ISO', 'FNumber', 'ExposureTime', 'FocalLength',
          'Make', 'Model', 'LensModel',
          'Rating', 'RatingPercent', 'ProtectStatus',
        ],
        reviveValues: true,
      });
      if (exif) {
        dateTaken = exif.DateTimeOriginal || exif.CreateDate || exif.ModifyDate || null;
        if (typeof exif.Orientation === 'number') orientation = exif.Orientation;
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

  const pattern = folderPattern || '{YYYY}-{MM}-{DD}/{filename}';
  const destPath = resolvePattern(pattern, dateTaken, file.name, file.extension, rating);
  const exposureValue = computeEV100(aperture, shutterSpeed, iso);
  return {
    dateTaken: dateTaken.toISOString(),
    destPath,
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
  };
}

export async function extractEmbeddedThumbnail(
  filePath: string,
  extension: string,
): Promise<string | undefined> {
  if (!EXIFR_SUPPORTED.has(extension)) return undefined;
  try {
    const thumbData = await exifr.thumbnail(filePath);
    if (!thumbData || thumbData.byteLength === 0) return undefined;
    const buffer = Buffer.isBuffer(thumbData) ? thumbData : Buffer.from(thumbData);
    return `data:image/jpeg;base64,${buffer.toString('base64')}`;
  } catch {
    return undefined;
  }
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
  if (process.platform === 'darwin') return sipsResize(srcPath, outPath, width, quality, timeoutMs);
  if (process.platform === 'win32') return powershellResize(srcPath, outPath, width, quality, timeoutMs);
  return linuxResize(srcPath, outPath, width, quality, timeoutMs);
}

// Most RAW files (NEF, CR2, ARW, DNG, RAF, ORF, RW2...) embed one or more JPEG
// previews inside the TIFF container. exifr.thumbnail() typically only returns
// the small ~160x120 IFD1 thumbnail, which is useless at loupe size. To get
// the usable full-size preview (~1620x1080 for NEF) we scan the raw bytes for
// JPEG SOI/EOI markers and keep the largest embedded JPEG.
async function extractLargestEmbeddedJpeg(filePath: string): Promise<Buffer | undefined> {
  const MAX_READ = 96 * 1024 * 1024;
  let buf: Buffer;
  try {
    const fullStat = await stat(filePath);
    const toRead = Math.min(Number(fullStat.size), MAX_READ);
    buf = Buffer.alloc(toRead);
    const handle = await fsOpen(filePath, 'r');
    try {
      await handle.read(buf, 0, toRead, 0);
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }

  let best: Buffer | undefined;
  let i = 0;
  while (i < buf.length - 4) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd8 && buf[i + 2] === 0xff) {
      const m = buf[i + 3];
      if (m === 0xe0 || m === 0xe1 || m === 0xdb || m === 0xc0 || m === 0xc4 || m === 0xfe) {
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

async function embeddedFallback(filePath: string, extension: string): Promise<string | undefined> {
  if (!EXIFR_SUPPORTED.has(extension)) return undefined;

  try {
    const big = await extractLargestEmbeddedJpeg(filePath);
    if (big && big.length > 32 * 1024) {
      return `data:image/jpeg;base64,${big.toString('base64')}`;
    }
  } catch {
    // fall through
  }

  try {
    const thumbData = await exifr.thumbnail(filePath);
    if (!thumbData || thumbData.byteLength === 0) return undefined;
    const buffer = Buffer.isBuffer(thumbData) ? thumbData : Buffer.from(thumbData);
    return `data:image/jpeg;base64,${buffer.toString('base64')}`;
  } catch {
    return undefined;
  }
}

/**
 * Lightweight embedded-thumbnail extractor used only for grid thumbnails.
 * Tries exifr.thumbnail() first (fast, no full file read) and only falls
 * back to the slower byte-scan when that returns nothing useful.
 */
async function embeddedFallbackForThumbnail(filePath: string, extension: string): Promise<string | undefined> {
  if (!EXIFR_SUPPORTED.has(extension)) return undefined;

  // Fast path: exifr parses the IFD1 thumbnail without reading the whole file.
  try {
    const thumbData = await exifr.thumbnail(filePath);
    if (thumbData && thumbData.byteLength > 0) {
      const buffer = Buffer.isBuffer(thumbData) ? thumbData : Buffer.from(thumbData);
      return `data:image/jpeg;base64,${buffer.toString('base64')}`;
    }
  } catch {
    // fall through to byte-scan
  }

  // Slow path: scan raw bytes for the largest embedded JPEG (covers RAW files
  // whose IFD1 thumbnail is missing or too small).
  try {
    const big = await extractLargestEmbeddedJpeg(filePath);
    if (big && big.length > 32 * 1024) {
      return `data:image/jpeg;base64,${big.toString('base64')}`;
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

const inflightPreviews = new Map<string, Promise<string | undefined>>();

export async function generatePreview(filePath: string): Promise<string | undefined> {
  const existing = inflightPreviews.get(filePath);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const dir = await getThumbDir();
      const key = await cacheKeyFor(filePath);
      const outPath = path.join(dir, `${key}_preview.jpg`);
      const ext = path.extname(filePath).toLowerCase();

      try {
        await stat(outPath);
        const cached = await readFile(outPath);
        return `data:image/jpeg;base64,${cached.toString('base64')}`;
      } catch {
        // not cached
      }

      if (RAW_EXTENSIONS.has(ext) && process.platform !== 'darwin') {
        const fallback = await embeddedFallback(filePath, ext);
        if (fallback) return fallback;
      }

      try {
        await platformResize(filePath, outPath, PREVIEW_WIDTH, PREVIEW_QUALITY, 30000);
        const buf = await readFile(outPath);
        return `data:image/jpeg;base64,${buf.toString('base64')}`;
      } catch {
        return embeddedFallback(filePath, ext);
      }
    } catch {
      return undefined;
    }
  })();

  inflightPreviews.set(filePath, promise);
  try {
    return await promise;
  } finally {
    inflightPreviews.delete(filePath);
  }
}

export async function generateThumbnail(filePath: string, _fileName: string): Promise<string | undefined> {
  try {
    const dir = await getThumbDir();
    const key = await cacheKeyFor(filePath);
    const outPath = path.join(dir, `${key}.jpg`);
    const ext = path.extname(filePath).toLowerCase();

    try {
      await stat(outPath);
      const buf = await readFile(outPath);
      return `data:image/jpeg;base64,${buf.toString('base64')}`;
    } catch {
      // not cached
    }

    // For RAW files on any platform, try to extract the embedded JPEG
    // preview first — this avoids spawning sips / ImageMagick / PowerShell for
    // files that already contain a usable preview in their header.
    // Uses the fast exifr.thumbnail() path before falling back to the full scan.
    if (RAW_EXTENSIONS.has(ext)) {
      const fallback = await embeddedFallbackForThumbnail(filePath, ext);
      if (fallback) return fallback;
    }

    try {
      await platformResize(filePath, outPath, THUMB_WIDTH, 60, 15000);
      const thumbBuffer = await readFile(outPath);
      return `data:image/jpeg;base64,${thumbBuffer.toString('base64')}`;
    } catch {
      return embeddedFallbackForThumbnail(filePath, ext);
    }
  } catch {
    return undefined;
  }
}
