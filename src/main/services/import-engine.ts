import { copyFile, mkdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { constants, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { Client } from 'basic-ftp';
import type { MediaFile, ImportConfig, ImportProgress, ImportResult, ImportError, SaveFormat, FtpConfig } from '../../shared/types';
import { isDuplicate } from './duplicate-detector';
import { stopsToMultiplier, clampStops } from '../../shared/exposure';

const execFileAsync = promisify(execFile);

let currentAbortController: AbortController | null = null;

const COPY_CONCURRENCY = 8;

function remoteJoin(...parts: string[]): string {
  const joined = parts
    .filter(Boolean)
    .join('/')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/');
  return joined.startsWith('/') ? joined : `/${joined}`;
}

async function connectFtp(config: FtpConfig): Promise<Client> {
  const client = new Client(30000);
  await client.access({
    host: config.host,
    port: config.port || 21,
    user: config.user || 'anonymous',
    password: config.password || 'guest',
    secure: config.secure,
  });
  return client;
}

const FORMAT_EXT: Record<Exclude<SaveFormat, 'original'>, string> = {
  jpeg: '.jpg',
  tiff: '.tiff',
  heic: '.heic',
};

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function convertedDestPath(destPath: string, format: SaveFormat): string {
  if (format === 'original') return destPath;
  const ext = FORMAT_EXT[format];
  const pathApi = destPath.includes('/') && !destPath.includes('\\') ? path.posix : path;
  const parsed = pathApi.parse(destPath);
  return pathApi.join(parsed.dir, `${parsed.name}${ext}`);
}

/**
 * Compose the final destination-relative path for a file, applying:
 *   - Protected subfolder prefix (if configured and the file is protected)
 *   - Format-based extension rewrite
 *
 * Callers join this with `destRoot` (or `backupDestRoot`) to get the full path.
 */
export function composeDestPath(
  file: MediaFile,
  baseDestPath: string,
  config: ImportConfig,
): string {
  let rel = baseDestPath;
  if (file.isProtected && config.separateProtected) {
    const folder = (config.protectedFolderName || '_Protected').replace(/^[/\\]+|[/\\]+$/g, '');
    rel = path.join(folder, rel);
  }
  return convertedDestPath(rel, config.saveFormat);
}

function psQuote(p: string): string {
  return `'${p.replace(/'/g, "''")}'`;
}

async function convertWithSips(
  srcPath: string,
  destFullPath: string,
  format: Exclude<SaveFormat, 'original'>,
  jpegQuality: number,
): Promise<void> {
  const args = [
    '-s', 'format', format,
    ...(format === 'jpeg' ? ['-s', 'formatOptions', String(jpegQuality)] : []),
    srcPath,
    '--out', destFullPath,
  ];
  await execFileAsync('sips', args, { timeout: 60000 });
}

// Windows System.Drawing path. We apply brightness by compositing the image
// through a ColorMatrix with the R/G/B diagonals scaled by the multiplier.
// A multiplier of 1 is a pass-through and is worth skipping so we don't pay
// for unnecessary matrix math.
async function convertWithPowerShell(
  srcPath: string,
  destFullPath: string,
  format: Exclude<SaveFormat, 'original'>,
  jpegQuality: number,
  brightness = 1,
): Promise<void> {
  const formatMap: Record<typeof format, string> = {
    jpeg: 'image/jpeg',
    tiff: 'image/tiff',
    heic: 'image/jpeg',
  };
  const mime = formatMap[format];
  const needsMatrix = Math.abs(brightness - 1) > 0.001;
  const b = brightness.toFixed(4);
  const matrixBlock = needsMatrix
    ? `
      $matrix = New-Object System.Drawing.Imaging.ColorMatrix
      $matrix.Matrix00 = ${b}
      $matrix.Matrix11 = ${b}
      $matrix.Matrix22 = ${b}
      $matrix.Matrix33 = 1
      $matrix.Matrix44 = 1
      $attrs = New-Object System.Drawing.Imaging.ImageAttributes
      $attrs.SetColorMatrix($matrix)
      $bmp = New-Object System.Drawing.Bitmap $src.Width, $src.Height
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      try {
        $g.DrawImage($src, [System.Drawing.Rectangle]::new(0, 0, $src.Width, $src.Height), 0, 0, $src.Width, $src.Height, [System.Drawing.GraphicsUnit]::Pixel, $attrs)
      } finally {
        $g.Dispose()
      }
      $out = $bmp
    `
    : `$out = $src`;
  const script = `
    Add-Type -AssemblyName System.Drawing
    $src = [System.Drawing.Image]::FromFile(${psQuote(srcPath)})
    try {
      ${matrixBlock}
      $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
        Where-Object { $_.MimeType -eq '${mime}' }
      $params = New-Object System.Drawing.Imaging.EncoderParameters 1
      $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
        [System.Drawing.Imaging.Encoder]::Quality, [long]${jpegQuality})
      $out.Save(${psQuote(destFullPath)}, $codec, $params)
      if ($out -ne $src) { $out.Dispose() }
    } finally {
      $src.Dispose()
    }
  `.trim();
  await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: 60000, windowsHide: true },
  );
}

// Does this system have an ImageMagick binary on PATH? Cached so we don't
// shell out once per file. Null = unknown / not yet checked.
let imageMagickBinary: 'magick' | 'convert' | null | undefined;
async function detectImageMagick(): Promise<'magick' | 'convert' | null> {
  if (imageMagickBinary !== undefined) return imageMagickBinary;
  for (const bin of ['magick', 'convert'] as const) {
    try {
      await execFileAsync(bin, ['-version'], { timeout: 5000 });
      imageMagickBinary = bin;
      return bin;
    } catch {
      // not installed, try next
    }
  }
  imageMagickBinary = null;
  return null;
}

async function convertWithImageMagick(
  srcPath: string,
  destFullPath: string,
  format: Exclude<SaveFormat, 'original'>,
  jpegQuality: number,
  brightness: number,
  binary: 'magick' | 'convert',
): Promise<void> {
  // magick is the v7 unified entry point; `convert` is v6 legacy. Arg
  // shape is the same for our purposes.
  const args: string[] = [srcPath];
  if (Math.abs(brightness - 1) > 0.001) {
    args.push('-evaluate', 'Multiply', brightness.toFixed(4));
  }
  if (format === 'jpeg') args.push('-quality', String(jpegQuality));
  args.push(destFullPath);
  await execFileAsync(binary, args, { timeout: 60000 });
}

async function convertAndCopy(
  srcPath: string,
  destFullPath: string,
  format: Exclude<SaveFormat, 'original'>,
  jpegQuality: number,
  brightness: number,
): Promise<{ normalized: boolean }> {
  const needsBrightness = Math.abs(brightness - 1) > 0.001;

  if (process.platform === 'win32') {
    await convertWithPowerShell(srcPath, destFullPath, format, jpegQuality, brightness);
    return { normalized: needsBrightness };
  }

  // For darwin + linux: prefer ImageMagick when brightness matters or when
  // we're on Linux. Fall back to sips (mac) / raises otherwise.
  if (needsBrightness) {
    const bin = await detectImageMagick();
    if (bin) {
      await convertWithImageMagick(srcPath, destFullPath, format, jpegQuality, brightness, bin);
      return { normalized: true };
    }
    // No IM available — we can't normalize. Fall through to plain conversion
    // and report the miss to the caller so it can surface a warning.
    if (process.platform === 'darwin') {
      await convertWithSips(srcPath, destFullPath, format, jpegQuality);
      return { normalized: false };
    }
    // Linux without IM — this would already be broken for normal conversion,
    // but throw a clearer error.
    throw new Error('ImageMagick (magick/convert) is required for exposure normalization on Linux');
  }

  if (process.platform === 'darwin') {
    await convertWithSips(srcPath, destFullPath, format, jpegQuality);
    return { normalized: false };
  }
  // Linux default path — convert is the historical invocation
  await execFileAsync(
    'convert',
    [
      srcPath,
      ...(format === 'jpeg' ? ['-quality', String(jpegQuality)] : []),
      destFullPath,
    ],
    { timeout: 60000 },
  );
  return { normalized: false };
}

export async function importFiles(
  files: MediaFile[],
  config: ImportConfig,
  onProgress: (progress: ImportProgress) => void,
): Promise<ImportResult> {
  currentAbortController?.abort();
  currentAbortController = new AbortController();
  const { signal } = currentAbortController;

  const startTime = Date.now();
  let imported = 0;
  let skipped = 0;
  let verified = 0;
  let checksumVerified = 0;
  let bytesTransferred = 0;
  const errors: ImportError[] = [];
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  const { saveFormat, jpegQuality } = config;
  const createdDirs = new Set<string>();
  let processedCount = 0;
  const ftpUploads: Array<{ localPath: string; remoteRelPath: string; fileName: string; size: number }> = [];
  const ftpMirrorActive =
    !!config.ftpDestEnabled &&
    !!config.ftpDestConfig?.host &&
    !!config.ftpDestConfig.remotePath;

  // Exposure normalization is only active when the user explicitly asked for
  // it AND we're transcoding AND we have an anchor EV to match. "Active"
  // just means we compute per-file brightness; individual files without an
  // EV pass through as brightness=1 (no-op).
  const normalizeActive =
    !!config.normalizeExposure &&
    config.saveFormat !== 'original' &&
    typeof config.exposureAnchorEV === 'number';
  // Per-file normalization: files the user explicitly marked "Normalize to
  // anchor" in the grid, regardless of the global normalizeExposure toggle.
  const perFileNormalizePaths = new Set(
    config.normalizeAnchorPaths && config.saveFormat !== 'original' && typeof config.exposureAnchorEV === 'number'
      ? config.normalizeAnchorPaths
      : [],
  );
  const maxStops = typeof config.exposureMaxStops === 'number' && config.exposureMaxStops > 0
    ? config.exposureMaxStops
    : 2;
  let normalizationMissing = 0; // how many files we couldn't normalize

  function brightnessFor(file: MediaFile): number {
    const shouldNormalize = normalizeActive || perFileNormalizePaths.has(file.path);
    const manualStops = config.exposureAdjustments?.[file.path] ?? file.exposureAdjustmentStops ?? 0;
    let normalizeStops = 0;
    if (shouldNormalize && typeof file.exposureValue === 'number') {
      const anchor = config.exposureAnchorEV as number;
      // Higher EV means less exposure captured. If this file's EV is above
      // the anchor, brighten it; if below, darken it.
      normalizeStops = file.exposureValue - anchor;
    }
    const correctionStops = clampStops(normalizeStops + manualStops, maxStops);
    return stopsToMultiplier(correctionStops);
  }

  async function ensureDir(dirPath: string): Promise<void> {
    if (createdDirs.has(dirPath)) return;
    await mkdir(dirPath, { recursive: true });
    createdDirs.add(dirPath);
  }

  async function importOne(file: MediaFile): Promise<void> {
    if (!file.destPath) {
      errors.push({ file: file.name, error: 'No destination path computed' });
      return;
    }

    const finalRelPath = composeDestPath(file, file.destPath, config);
    const destFullPath = path.join(config.destRoot, finalRelPath);
    const backupFullPath = config.backupDestRoot
      ? path.join(config.backupDestRoot, finalRelPath)
      : null;

    if (config.skipDuplicates) {
      const dup = await isDuplicate(config.destRoot, finalRelPath, file.size);
      if (dup) {
        skipped++;
        return;
      }
    }

    // Dry run — count what would happen, don't touch disk
    if (config.dryRun) {
      imported++;
      bytesTransferred += file.size;
      return;
    }

    try {
      await ensureDir(path.dirname(destFullPath));

      if (saveFormat === 'original') {
        await copyFile(file.path, destFullPath, constants.COPYFILE_EXCL);
      } else {
        const brightness = brightnessFor(file);
        const { normalized } = await convertAndCopy(
          file.path, destFullPath, saveFormat, jpegQuality, brightness,
        );
        if (normalizeActive && Math.abs(brightness - 1) > 0.001 && !normalized) {
          normalizationMissing++;
        }
      }

      // Mirror to backup destination after primary copy succeeds. Mirror
      // failures are recorded but don't roll back the primary — the user
      // asked for belt-and-braces; they'd rather have one good copy than
      // zero.
      if (backupFullPath) {
        try {
          await ensureDir(path.dirname(backupFullPath));
          if (saveFormat === 'original') {
            await copyFile(destFullPath, backupFullPath, constants.COPYFILE_EXCL);
          } else {
            // For converted files, copy the already-converted output rather
            // than re-running the platform converter.
            await copyFile(destFullPath, backupFullPath, constants.COPYFILE_EXCL);
          }
        } catch (mirrorErr: unknown) {
          const e = mirrorErr as NodeJS.ErrnoException;
          if (e.code !== 'EEXIST') {
            errors.push({ file: `${file.name} (backup)`, error: e.message || 'Backup copy failed' });
          }
        }
      }

      if (ftpMirrorActive) {
        ftpUploads.push({
          localPath: destFullPath,
          remoteRelPath: finalRelPath.replace(/\\/g, '/'),
          fileName: file.name,
          size: file.size,
        });
      }

      imported++;
      try {
        const s = await stat(destFullPath);
        if (s.size > 0 || saveFormat !== 'original') verified++;
        if (config.verifyChecksums && saveFormat === 'original') {
          const [srcHash, destHash] = await Promise.all([
            sha256File(file.path),
            sha256File(destFullPath),
          ]);
          if (srcHash !== destHash) {
            errors.push({ file: `${file.name} (checksum)`, error: 'Primary copy checksum mismatch' });
          } else {
            checksumVerified++;
          }
          if (backupFullPath) {
            const backupHash = await sha256File(backupFullPath);
            if (backupHash !== srcHash) {
              errors.push({ file: `${file.name} (backup checksum)`, error: 'Backup copy checksum mismatch' });
            }
          }
        }
      } catch (verifyErr: unknown) {
        const e = verifyErr as NodeJS.ErrnoException;
        errors.push({ file: `${file.name} (verify)`, error: e.message || 'Verification failed' });
      }
      bytesTransferred += file.size;
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;

      if (error.code === 'ENOSPC') {
        errors.push({ file: file.name, error: 'Disk full' });
        currentAbortController?.abort();
        return;
      }

      if (error.code === 'EEXIST') {
        skipped++;
      } else {
        errors.push({ file: file.name, error: error.message || 'Import failed' });
      }
    }
  }

  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (!signal.aborted) {
      const idx = nextIndex++;
      if (idx >= files.length) break;

      await importOne(files[idx]);
      processedCount++;

      onProgress({
        currentFile: files[idx].name,
        currentIndex: processedCount,
        totalFiles: files.length,
        bytesTransferred,
        totalBytes,
        skipped,
        errors: errors.length,
      });
    }
  }

  await Promise.all(Array.from({ length: Math.min(COPY_CONCURRENCY, files.length) }, () => worker()));

  if (ftpMirrorActive && ftpUploads.length > 0 && config.ftpDestConfig && !signal.aborted) {
    let client: Client | null = null;
    try {
      client = await connectFtp(config.ftpDestConfig);
      const baseRemote = config.ftpDestConfig.remotePath || '/';
      let uploaded = 0;
      for (const upload of ftpUploads) {
        if (signal.aborted) break;
        const remotePath = remoteJoin(baseRemote, upload.remoteRelPath);
        const remoteDir = path.posix.dirname(remotePath);
        const remoteName = path.posix.basename(remotePath);
        await client.ensureDir(remoteDir);
        await client.uploadFrom(upload.localPath, remoteName);
        uploaded++;
        onProgress({
          currentFile: `${upload.fileName} (FTP ${uploaded}/${ftpUploads.length})`,
          currentIndex: processedCount,
          totalFiles: files.length,
          bytesTransferred,
          totalBytes,
          skipped,
          errors: errors.length,
        });
      }
    } catch (ftpErr: unknown) {
      const e = ftpErr as Error;
      errors.push({ file: 'ftp-output', error: e.message || 'FTP upload failed' });
    } finally {
      client?.close();
    }
  }

  // One-line heads-up if the normalizer couldn't apply brightness because IM
  // wasn't on PATH. Reported as an error rather than silent so users know
  // what they installed the feature for isn't firing.
  if (normalizationMissing > 0) {
    errors.push({
      file: 'exposure-normalize',
      error: `Skipped exposure adjustment on ${normalizationMissing} file(s). Install ImageMagick ('magick' or 'convert' on PATH) to enable.`,
    });
  }

  return {
    imported,
    skipped,
    verified,
    checksumVerified,
    errors,
    totalBytes: bytesTransferred,
    durationMs: Date.now() - startTime,
  };
}

export function cancelImport(): void {
  currentAbortController?.abort();
  currentAbortController = null;
}
