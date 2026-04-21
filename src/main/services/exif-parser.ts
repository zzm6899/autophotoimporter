import exifr from 'exifr';
import { stat, readFile, mkdir } from 'node:fs/promises';
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
  '.cr2', '.cr3', '.crw',        // Canon
  '.nef', '.nrw',                 // Nikon
  '.arw', '.srf', '.sr2',        // Sony
  '.raf',                         // Fujifilm
  '.orf',                         // Olympus / OM System
  '.rw2',                         // Panasonic
  '.pef',                         // Pentax
  '.srw',                         // Samsung
  '.rwl',                         // Leica
  '.3fr', '.fff',                 // Hasselblad
  '.dng',                         // Adobe / Generic
  '.gpr',                         // GoPro (DNG-based)
  '.mrw',                         // Minolta
  '.erf',                         // Epson
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

// Detect whether the file is write-protected at the filesystem level.
// On POSIX this is the user-write bit; on Windows, fs.stat reports the
// `readonly` attribute as a lack of write permission on `mode`.
async function isFileProtected(filePath: string): Promise<boolean> {
  try {
    const s = await stat(filePath);
    // Owner-write bit: 0o200. If absent, the file is read-only.
    return (s.mode & fsConstants.S_IWUSR) === 0;
  } catch {
    return false;
  }
}

// Fast: only extract date, no thumbnail
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
        // ProtectStatus — present on many in-camera "protect" flags (Canon, Nikon MakerNotes).
        // Any non-zero / truthy value is treated as protected.
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
  const destPath = resolvePattern(pattern, dateTaken, file.name, file.extension);
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

// Fast: extract embedded JPEG thumbnail from EXIF data (no RAW decoding)
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

// --- Platform resize primitives ----------------------------------------
//
// macOS: `sips` ships with the OS and can read most RAW formats via ImageIO.
// Windows: PowerShell + System.Drawing handles JPEG/PNG/TIFF/HEIF (with
//   Windows 10 HEIF codec) but NOT proprietary RAW. For RAW on Windows we
//   try to pull the embedded JPEG from the file header directly (exifr).
// Linux: `convert` (ImageMagick) if present, else we just skip.

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

// Escape a path for embedding inside a PowerShell single-quoted string.
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
  // System.Drawing load-and-resize. Not available for ARW/CR3/etc. — caller
  // is expected to have tried the embedded-thumb fast path first.
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
  // `magick` (IM7) or fallback to `convert` (IM6)
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

// Most RAW files (NEF, CR2, ARW, DNG, RAF, ORF, RW2…) embed one or more JPEG
// previews at byte offsets inside the TIFF container. The "thumbnail" that
// exifr.thumbnail() returns is typically the small ~160×120 IFD1 thumbnail,
// which looks awful at loupe size.
//
// For a usable preview we scan the raw bytes for JPEG SOI/EOI markers
// (0xFFD8…0xFFD9) and keep the largest embedded JPEG. This works for
// essentially every TIFF-based RAW format, including Nikon NEF where the
// full-size preview lives inside SubIFD0 but isn't easily reachable via
// exifr's high-level API.
//
// Bounded read: we cap at 96 MB so we don't blow memory on very large RAWs
// (Nikon Z9 .NEF can be 60+ MB; Canon CR3 larger). The embedded preview is
// almost always in the first ~20 MB but we give headroom.
async function extractLargestEmbeddedJpeg(filePath: string): Promise<Buffer | undefined> {
  const MAX_READ = 96 * 1024 * 1024;
  let buf: Buffer;
  try {
    const fullStat = await stat(filePath);
    const toRead = Math.min(Number(fullStat.size), MAX_READ);
    buf = Buffer.alloc(toRead);
    const { open } = await import('node:fs/promises');
    const handle = await open(filePath, 'r');
    try {
      await handle.read(buf, 0, toRead, 0);
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }

  // Scan for JPEG SOI (0xFFD8 0xFFDB or 0xFFD8 0xFFE0 / 0xFFE1). We accept
  // any SOI followed by a valid marker byte to reduce false positives from
  // compressed RAW data that happens to contain 0xFFD8.
  let best: Buffer | undefined;
  let i = 0;
  while (i < buf.length - 4) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd8 && buf[i + 2] === 0xff) {
      const m = buf[i + 3];
      // Common: 0xE0 JFIF, 0xE1 EXIF, 0xDB DQT, 0xC0 SOF0, 0xFE COM
      if (m === 0xe0 || m === 0xe1 || m === 0xdb || m === 0xc0 || m === 0xc4 || m === 0xfe) {
        // Find matching EOI
        const eoi = findJpegEnd(buf, i + 2);
        if (eoi > i) {
          const segLen = eoi - i + 2;
          if (!best || segLen > best.length) {
            best = buf.slice(i, eoi + 2);
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

// Find 0xFFD9 (JPEG end-of-image) after a given start offset. Skip over
// 0xFF 0x00 (stuffed byte) and marker segments that declare their own length
// so we don't trip on payload bytes that look like EOI.
function findJpegEnd(buf: Buffer, start: number): number {
  let i = start;
  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    // Skip fill 0xFF bytes
    let j = i;
    while (j < buf.length - 1 && buf[j] === 0xff) j += 1;
    const marker = buf[j];
    if (marker === 0x00) { i = j + 1; continue; }     // stuffed byte
    if (marker === 0xd9) return j;                    // EOI
    if (marker === 0xd8) { i = j + 1; continue; }     // nested SOI — unusual
    if (marker >= 0xd0 && marker <= 0xd7) { i = j + 1; continue; } // RST markers
    // Length-prefixed marker segments
    if (j + 2 >= buf.length) return -1;
    const segLen = buf.readUInt16BE(j + 1);
    if (segLen < 2) return -1;
    // After the segment: for SOS (0xDA), scan compressed data for next marker
    if (marker === 0xda) {
      i = j + 1 + segLen;
      // Compressed data — walk until we hit the next non-RST/non-stuffed marker
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

// Last-resort: if the platform decoder can't open the RAW, pull the
// largest embedded JPEG from the f