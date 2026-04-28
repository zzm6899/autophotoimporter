import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { constants, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { Client } from 'basic-ftp';
import type { MediaFile, ImportConfig, ImportProgress, ImportResult, ImportError, SaveFormat, BatchMetadata, WatermarkConfig, WatermarkPosition, MetadataExportFlags } from '../../shared/types';
import { DEFAULT_METADATA_EXPORT } from '../../shared/types';
import { isDuplicate } from './duplicate-detector';
import { stopsToSafeMultiplier, getEffectiveExposureStops, hasWhiteBalanceAdjustment, whiteBalanceMultipliers } from '../../shared/exposure';

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

async function connectFtp(config: NonNullable<ImportConfig['ftpDestConfig']>): Promise<Client> {
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

type ConvertResult = {
  normalized: boolean;
  watermarked: boolean;
  straightened: boolean;
  whiteBalanced: boolean;
};

function sidecarPathFor(destFullPath: string): string {
  const parsed = path.parse(destFullPath);
  return path.join(parsed.dir, `${parsed.name}.xmp`);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Resolve effective export flags, merging user overrides onto defaults. */
function resolveFlags(flags: Partial<MetadataExportFlags> | undefined): MetadataExportFlags {
  return { ...DEFAULT_METADATA_EXPORT, ...flags };
}

function hasMetadata(
  metadata: BatchMetadata | undefined,
  flags: MetadataExportFlags,
  rating: number | undefined,
  pick: 'selected' | 'rejected' | undefined,
  file?: MediaFile,
): boolean {
  if (flags.rating && typeof rating === 'number' && rating > 0) return true;
  if (flags.pickLabel && pick !== undefined) return true;
  if (!flags.stripGps && (file?.gps || file?.locationName)) return true;
  if (flags.keywords && file?.sceneBucket) return true;
  if (!metadata) return false;
  return (
    (flags.keywords && (metadata.keywords?.length ?? 0) > 0) ||
    (flags.title && !!metadata.title?.trim()) ||
    (flags.caption && !!metadata.caption?.trim()) ||
    (flags.creator && !!metadata.creator?.trim()) ||
    (flags.copyright && !!metadata.copyright?.trim())
  );
}

/**
 * XMP Label values used by Lightroom / Capture One for pick/reject.
 * Pick = "Green" (Lightroom "Pick" label), Reject = "Red".
 * photoshop:Urgency: 1 = highest (pick), 8 = lowest (reject).
 */
function pickToXmpLabel(pick: 'selected' | 'rejected'): { label: string; urgency: number } {
  return pick === 'selected'
    ? { label: 'Green', urgency: 1 }
    : { label: 'Red', urgency: 8 };
}

function buildXmpSidecar(
  metadata: BatchMetadata | undefined,
  flags: MetadataExportFlags,
  rating?: number,
  pick?: 'selected' | 'rejected',
  file?: MediaFile,
): string {
  const smartKeywords = [
    file?.sceneBucket,
    file?.locationName && !flags.stripGps ? file.locationName : undefined,
  ].filter(Boolean) as string[];
  const keywords  = flags.keywords
    ? [...(metadata?.keywords?.filter(Boolean) ?? []), ...smartKeywords]
        .filter((value, index, all) => all.findIndex((other) => other.toLowerCase() === value.toLowerCase()) === index)
    : [];
  const title     = flags.title     ? metadata?.title?.trim()      : undefined;
  const caption   = flags.caption   ? metadata?.caption?.trim()    : undefined;
  const creator   = flags.creator   ? metadata?.creator?.trim()    : undefined;
  const copyright = flags.copyright ? metadata?.copyright?.trim()  : undefined;
  const ratingVal = flags.rating && typeof rating === 'number' && rating > 0 ? Math.min(5, rating) : undefined;
  const pickInfo  = flags.pickLabel && pick !== undefined ? pickToXmpLabel(pick) : undefined;
  const gps = flags.stripGps ? undefined : file?.gps;
  const locationName = flags.stripGps ? undefined : file?.locationName;

  return [
    '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '    <rdf:Description rdf:about=""',
    '      xmlns:dc="http://purl.org/dc/elements/1.1/"',
    '      xmlns:xmp="http://ns.adobe.com/xap/1.0/"',
    '      xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/"',
    '      xmlns:exif="http://ns.adobe.com/exif/1.0/"',
    '      xmlns:tiff="http://ns.adobe.com/tiff/1.0/"',
    '      xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/">',
    title    ? `      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(title)}</rdf:li></rdf:Alt></dc:title>` : '',
    caption  ? `      <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(caption)}</rdf:li></rdf:Alt></dc:description>` : '',
    creator  ? `      <dc:creator><rdf:Seq><rdf:li>${escapeXml(creator)}</rdf:li></rdf:Seq></dc:creator>` : '',
    creator  ? `      <tiff:Artist>${escapeXml(creator)}</tiff:Artist>` : '',
    copyright ? `      <dc:rights><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(copyright)}</rdf:li></rdf:Alt></dc:rights>` : '',
    copyright ? `      <xmpRights:Marked>True</xmpRights:Marked>` : '',
    copyright ? `      <photoshop:CopyrightFlag>True</photoshop:CopyrightFlag>` : '',
    keywords.length > 0
      ? `      <dc:subject><rdf:Bag>${keywords.map((kw) => `<rdf:li>${escapeXml(kw)}</rdf:li>`).join('')}</rdf:Bag></dc:subject>`
      : '',
    ratingVal !== undefined ? `      <xmp:Rating>${ratingVal}</xmp:Rating>` : '',
    pickInfo  ? `      <xmp:Label>${escapeXml(pickInfo.label)}</xmp:Label>` : '',
    pickInfo  ? `      <photoshop:Urgency>${pickInfo.urgency}</photoshop:Urgency>` : '',
    locationName ? `      <photoshop:Location>${escapeXml(locationName)}</photoshop:Location>` : '',
    gps ? `      <exif:GPSLatitude>${gps.latitude.toFixed(8)}</exif:GPSLatitude>` : '',
    gps ? `      <exif:GPSLongitude>${gps.longitude.toFixed(8)}</exif:GPSLongitude>` : '',
    gps && typeof gps.altitude === 'number' ? `      <exif:GPSAltitude>${gps.altitude.toFixed(2)}</exif:GPSAltitude>` : '',
    '    </rdf:Description>',
    '  </rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>',
  ].filter(Boolean).join('\n');
}

async function writeMetadataSidecar(
  destFullPath: string,
  metadata: BatchMetadata | undefined,
  flags: MetadataExportFlags,
  rating?: number,
  pick?: 'selected' | 'rejected',
  file?: MediaFile,
): Promise<string | null> {
  if (!hasMetadata(metadata, flags, rating, pick, file)) return null;
  const sidecarPath = sidecarPathFor(destFullPath);
  await writeFile(sidecarPath, buildXmpSidecar(metadata, flags, rating, pick, file), 'utf8');
  return sidecarPath;
}

function watermarkGravity(position: WatermarkPosition): string {
  switch (position) {
    case 'bottom-left': return 'southwest';
    case 'top-right': return 'northeast';
    case 'top-left': return 'northwest';
    case 'center': return 'center';
    case 'bottom-right':
    default:
      return 'southeast';
  }
}

function watermarkPointSize(scale = 0.045): number {
  return Math.max(16, Math.round(scale * 1600));
}

function hasRenderableWatermark(watermark?: WatermarkConfig): boolean {
  if (!watermark?.enabled) return false;
  if (watermark.mode === 'image') return !!watermark.imagePath?.trim();
  return !!watermark.text?.trim();
}

function isPortraitOrientation(orientation?: number): boolean {
  return orientation === 5 || orientation === 6 || orientation === 7 || orientation === 8;
}

function watermarkPositionForOrientation(
  watermark: WatermarkConfig | undefined,
  orientation?: number,
): WatermarkPosition {
  if (!watermark) return 'bottom-right';
  return isPortraitOrientation(orientation)
    ? watermark.positionPortrait
    : watermark.positionLandscape;
}

function watermarkImageScalePercent(scale = 0.045): number {
  return Math.max(8, Math.min(28, Math.round(scale * 420)));
}

function rotateFlipType(orientation?: number): string | null {
  switch (orientation) {
    case 2: return 'RotateNoneFlipX';
    case 3: return 'Rotate180FlipNone';
    case 4: return 'Rotate180FlipX';
    case 5: return 'Rotate90FlipX';
    case 6: return 'Rotate90FlipNone';
    case 7: return 'Rotate270FlipX';
    case 8: return 'Rotate270FlipNone';
    default: return null;
  }
}

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
  autoStraighten = false,
): Promise<void> {
  const args = [
    '-s', 'format', format,
    ...(format === 'jpeg' ? ['-s', 'formatOptions', String(jpegQuality)] : []),
    ...(autoStraighten ? ['-s', 'formatOptions', String(jpegQuality)] : []),
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
  whiteBalance?: ImportConfig['whiteBalance'],
  orientation?: number,
  watermark?: WatermarkConfig,
): Promise<ConvertResult> {
  const formatMap: Record<typeof format, string> = {
    jpeg: 'image/jpeg',
    tiff: 'image/tiff',
    heic: 'image/jpeg',
  };
  const mime = formatMap[format];
  const wb = whiteBalanceMultipliers(whiteBalance);
  const whiteBalanced = hasWhiteBalanceAdjustment(whiteBalance);
  const red = brightness * wb.red;
  const green = brightness * wb.green;
  const blue = brightness * wb.blue;
  const needsMatrix = [red, green, blue].some((v) => Math.abs(v - 1) > 0.001);
  const rotateFlip = rotateFlipType(orientation);
  const hasWatermark = hasRenderableWatermark(watermark);
  const needsRasterPass = needsMatrix || !!rotateFlip || hasWatermark;
  const r = red.toFixed(4);
  const gChannel = green.toFixed(4);
  const b = blue.toFixed(4);
  const opacity = Math.max(0.05, Math.min(1, watermark?.opacity ?? 0.3)).toFixed(3);
  const shadowOpacity = Math.max(0.05, Math.min(0.6, (watermark?.opacity ?? 0.3) * 0.6)).toFixed(3);
  const pointSize = watermarkPointSize(watermark?.scale);
  const gravity = watermarkGravity(watermarkPositionForOrientation(watermark, orientation));
  const margin = Math.max(12, Math.round(pointSize * 0.7));
  const text = watermark?.text?.replace(/'/g, "''") ?? '';
  const watermarkImagePath = watermark?.imagePath ?? '';
  const watermarkScalePercent = watermarkImageScalePercent(watermark?.scale);
  const script = `
    Add-Type -AssemblyName System.Drawing
    $src = [System.Drawing.Image]::FromFile(${psQuote(srcPath)})
    try {
      ${rotateFlip ? `$src.RotateFlip([System.Drawing.RotateFlipType]::${rotateFlip})` : ''}
      ${needsRasterPass ? `
      ${needsMatrix ? `
      $matrix = New-Object System.Drawing.Imaging.ColorMatrix
      $matrix.Matrix00 = ${r}
      $matrix.Matrix11 = ${gChannel}
      $matrix.Matrix22 = ${b}
      $matrix.Matrix33 = 1
      $matrix.Matrix44 = 1
      $attrs = New-Object System.Drawing.Imaging.ImageAttributes
      $attrs.SetColorMatrix($matrix)
      ` : '$attrs = $null'}
      $bmp = New-Object System.Drawing.Bitmap $src.Width, $src.Height
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
      try {
        if ($attrs -ne $null) {
          $g.DrawImage($src, [System.Drawing.Rectangle]::new(0, 0, $src.Width, $src.Height), 0, 0, $src.Width, $src.Height, [System.Drawing.GraphicsUnit]::Pixel, $attrs)
        } else {
          $g.DrawImage($src, 0, 0, $src.Width, $src.Height)
        }
        ${hasWatermark ? `
        switch ('${gravity}') {
          'southwest' { $format.Alignment = [System.Drawing.StringAlignment]::Near; $format.LineAlignment = [System.Drawing.StringAlignment]::Far; $x = ${margin}; $y = $bmp.Height - ${margin} }
          'northeast' { $format.Alignment = [System.Drawing.StringAlignment]::Far; $format.LineAlignment = [System.Drawing.StringAlignment]::Near; $x = $bmp.Width - ${margin}; $y = ${margin} }
          'northwest' { $format.Alignment = [System.Drawing.StringAlignment]::Near; $format.LineAlignment = [System.Drawing.StringAlignment]::Near; $x = ${margin}; $y = ${margin} }
          'center' { $format.Alignment = [System.Drawing.StringAlignment]::Center; $format.LineAlignment = [System.Drawing.StringAlignment]::Center; $x = $bmp.Width / 2; $y = $bmp.Height / 2 }
          default { $format.Alignment = [System.Drawing.StringAlignment]::Far; $format.LineAlignment = [System.Drawing.StringAlignment]::Far; $x = $bmp.Width - ${margin}; $y = $bmp.Height - ${margin} }
        }
        ${watermark?.mode === 'image' ? `
        $format = New-Object System.Drawing.StringFormat
        $wm = [System.Drawing.Image]::FromFile(${psQuote(watermarkImagePath)})
        try {
          $targetWidth = [Math]::Max(48, [int]($bmp.Width * (${watermarkScalePercent} / 100.0)))
          $ratio = $wm.Height / [Math]::Max(1, $wm.Width)
          $targetHeight = [Math]::Max(24, [int]($targetWidth * $ratio))
          $destRect = switch ('${gravity}') {
            'southwest' { [System.Drawing.RectangleF]::new(${margin}, $bmp.Height - $targetHeight - ${margin}, $targetWidth, $targetHeight) }
            'northeast' { [System.Drawing.RectangleF]::new($bmp.Width - $targetWidth - ${margin}, ${margin}, $targetWidth, $targetHeight) }
            'northwest' { [System.Drawing.RectangleF]::new(${margin}, ${margin}, $targetWidth, $targetHeight) }
            'center' { [System.Drawing.RectangleF]::new(($bmp.Width - $targetWidth) / 2, ($bmp.Height - $targetHeight) / 2, $targetWidth, $targetHeight) }
            default { [System.Drawing.RectangleF]::new($bmp.Width - $targetWidth - ${margin}, $bmp.Height - $targetHeight - ${margin}, $targetWidth, $targetHeight) }
          }
          $wmMatrix = New-Object System.Drawing.Imaging.ColorMatrix
          $wmMatrix.Matrix33 = ${opacity}
          $wmAttrs = New-Object System.Drawing.Imaging.ImageAttributes
          $wmAttrs.SetColorMatrix($wmMatrix)
          $g.DrawImage($wm, $destRect, 0, 0, $wm.Width, $wm.Height, [System.Drawing.GraphicsUnit]::Pixel, $wmAttrs)
          $wmAttrs.Dispose()
        } finally {
          $wm.Dispose()
          $format.Dispose()
        }
        ` : `
        $font = New-Object System.Drawing.Font('Arial', [float]${pointSize}, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
        $shadowBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb([int](255 * ${shadowOpacity}), 0, 0, 0))
        $textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb([int](255 * ${opacity}), 255, 255, 255))
        $format = New-Object System.Drawing.StringFormat
        $g.DrawString('${text}', $font, $shadowBrush, [float]($x + 2), [float]($y + 2), $format)
        $g.DrawString('${text}', $font, $textBrush, [float]$x, [float]$y, $format)
        $textBrush.Dispose()
        $shadowBrush.Dispose()
        $font.Dispose()
        $format.Dispose()
        `}
        ` : ''}
      } finally {
        $g.Dispose()
      }
      $out = $bmp
      ` : '$out = $src'}
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
  return {
    normalized: needsMatrix,
    watermarked: hasWatermark,
    straightened: !!rotateFlip,
    whiteBalanced,
  };
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
  whiteBalance: ImportConfig['whiteBalance'] | undefined,
  binary: 'magick' | 'convert',
  autoStraighten = false,
  watermark?: WatermarkConfig,
): Promise<ConvertResult> {
  // magick is the v7 unified entry point; `convert` is v6 legacy. Arg
  // shape is the same for our purposes.
  const args: string[] = [srcPath];
  const hasWatermark = hasRenderableWatermark(watermark);
  const wb = whiteBalanceMultipliers(whiteBalance);
  const whiteBalanced = hasWhiteBalanceAdjustment(whiteBalance);
  const channelMultipliers = {
    red: brightness * wb.red,
    green: brightness * wb.green,
    blue: brightness * wb.blue,
  };
  if (autoStraighten) {
    args.push('-auto-orient');
  }
  if (Object.values(channelMultipliers).some((v) => Math.abs(v - 1) > 0.001)) {
    args.push(
      '-channel', 'R', '-evaluate', 'Multiply', channelMultipliers.red.toFixed(4),
      '-channel', 'G', '-evaluate', 'Multiply', channelMultipliers.green.toFixed(4),
      '-channel', 'B', '-evaluate', 'Multiply', channelMultipliers.blue.toFixed(4),
      '+channel',
    );
  }
  if (hasWatermark) {
    const gravity = watermarkGravity(watermarkPositionForOrientation(watermark, autoStraighten ? undefined : undefined));
    if (watermark?.mode === 'image' && watermark.imagePath?.trim()) {
      args.push(
        '(',
        watermark.imagePath,
        '-resize', `${watermarkImageScalePercent(watermark.scale)}%`,
        '-alpha', 'set',
        '-channel', 'A',
        '-evaluate', 'Multiply', Math.max(0.05, Math.min(1, watermark.opacity ?? 0.3)).toFixed(3),
        ')',
        '-gravity', gravity,
        '-geometry', '+24+24',
        '-composite',
      );
    } else if (watermark?.text?.trim()) {
      args.push(
        '-gravity', gravity,
        '-fill', `rgba(255,255,255,${Math.max(0.05, Math.min(1, watermark?.opacity ?? 0.3)).toFixed(3)})`,
        '-stroke', `rgba(0,0,0,${Math.max(0.05, Math.min(0.6, (watermark?.opacity ?? 0.3) * 0.6)).toFixed(3)})`,
        '-strokewidth', '1',
        '-pointsize', String(watermarkPointSize(watermark?.scale)),
        '-annotate', '+24+24', watermark.text,
      );
    }
  }
  if (format === 'jpeg') args.push('-quality', String(jpegQuality));
  args.push(destFullPath);
  await execFileAsync(binary, args, { timeout: 60000 });
  return {
    normalized: Math.abs(brightness - 1) > 0.001,
    watermarked: hasWatermark,
    straightened: autoStraighten,
    whiteBalanced,
  };
}

async function convertAndCopy(
  srcPath: string,
  destFullPath: string,
  format: Exclude<SaveFormat, 'original'>,
  jpegQuality: number,
  brightness: number,
  whiteBalance?: ImportConfig['whiteBalance'],
  orientation?: number,
  watermark?: WatermarkConfig,
  autoStraighten = false,
): Promise<ConvertResult> {
  const needsBrightness = Math.abs(brightness - 1) > 0.001;
  const wantsWhiteBalance = hasWhiteBalanceAdjustment(whiteBalance);
  const wantsWatermark = hasRenderableWatermark(watermark);
  const wantsStraighten = !!autoStraighten && !!rotateFlipType(orientation);

  if (process.platform === 'win32') {
    return convertWithPowerShell(srcPath, destFullPath, format, jpegQuality, brightness, whiteBalance, wantsStraighten ? orientation : undefined, watermark);
  }

  // For darwin + linux: prefer ImageMagick when brightness matters or when
  // we're on Linux. Fall back to sips (mac) / raises otherwise.
  if (needsBrightness || wantsWhiteBalance || wantsWatermark || wantsStraighten) {
    const bin = await detectImageMagick();
    if (bin) {
      return convertWithImageMagick(srcPath, destFullPath, format, jpegQuality, brightness, whiteBalance, bin, wantsStraighten, watermark);
    }
    // No IM available — we can't run advanced transforms. Fall through to plain conversion
    // and report the miss to the caller so it can surface a warning.
    if (process.platform === 'darwin') {
      await convertWithSips(srcPath, destFullPath, format, jpegQuality, false);
      return { normalized: false, watermarked: false, straightened: false, whiteBalanced: false };
    }
    // Linux without IM — this would already be broken for normal conversion,
    // but throw a clearer error.
    throw new Error('ImageMagick (magick/convert) is required for watermarking, exposure normalization, white balance, or auto-straightening on Linux');
  }

  if (process.platform === 'darwin') {
    await convertWithSips(srcPath, destFullPath, format, jpegQuality, false);
    return { normalized: false, watermarked: false, straightened: false, whiteBalanced: false };
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
  return { normalized: false, watermarked: false, straightened: false, whiteBalanced: false };
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
  let watermarkMissing = 0;
  let straightenMissing = 0;
  let whiteBalanceMissing = 0;

  function brightnessFor(file: MediaFile): number {
    const shouldNormalize = normalizeActive || perFileNormalizePaths.has(file.path);
    const correctionStops = getEffectiveExposureStops(
      config.exposureAdjustments?.[file.path] ?? file.exposureAdjustmentStops,
      file.exposureValue,
      shouldNormalize ? config.exposureAnchorEV : undefined,
      shouldNormalize,
      maxStops,
    );
    return stopsToSafeMultiplier(correctionStops);
  }

  function whiteBalanceFor(file: MediaFile): ImportConfig['whiteBalance'] | undefined {
    if (config.saveFormat === 'original') return undefined;
    return config.whiteBalanceAdjustments?.[file.path] ?? file.whiteBalanceAdjustment ?? config.whiteBalance;
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
        const whiteBalance = whiteBalanceFor(file);
        const { normalized, watermarked, straightened, whiteBalanced } = await convertAndCopy(
          file.path, destFullPath, saveFormat, jpegQuality, brightness, whiteBalance, file.orientation, config.watermark, config.autoStraighten,
        );
        if (normalizeActive && Math.abs(brightness - 1) > 0.001 && !normalized) {
          normalizationMissing++;
        }
        if (hasRenderableWatermark(config.watermark) && !watermarked) {
          watermarkMissing++;
        }
        if (config.autoStraighten && rotateFlipType(file.orientation) && !straightened) {
          straightenMissing++;
        }
        if (hasWhiteBalanceAdjustment(whiteBalance) && !whiteBalanced) {
          whiteBalanceMissing++;
        }
      }

      const flags = resolveFlags(config.metadataExportFlags);
      const primarySidecarPath = await writeMetadataSidecar(destFullPath, config.metadata, flags, file.rating, file.pick, file);

      // Mirror to backup destination after primary copy succeeds. Mirror
      // failures are recorded but don't roll back the primary — the user
      // asked for belt-and-braces; they'd rather have one good copy than
      // zero.
      if (backupFullPath) {
        try {
          await ensureDir(path.dirname(backupFullPath));
          // Always copy from the (possibly converted) primary destination so
          // the backup is identical to what was written there.
          await copyFile(destFullPath, backupFullPath, constants.COPYFILE_EXCL);
          if (primarySidecarPath) {
            await copyFile(primarySidecarPath, sidecarPathFor(backupFullPath), constants.COPYFILE_EXCL);
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
        if (primarySidecarPath) {
          const sidecarName = path.posix.basename(sidecarPathFor(finalRelPath.replace(/\\/g, '/')));
          ftpUploads.push({
            localPath: primarySidecarPath,
            remoteRelPath: path.posix.join(path.posix.dirname(finalRelPath.replace(/\\/g, '/')), sidecarName),
            fileName: `${file.name}.xmp`,
            size: Buffer.byteLength(buildXmpSidecar(config.metadata, resolveFlags(config.metadataExportFlags), file.rating, file.pick, file)),
          });
        }
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

  // Rolling 3-second window for transfer speed calculation.
  // Each sample is { t: epochMs, bytes: bytesTransferred at that point }.
  const SPEED_WINDOW_MS = 3000;
  const speedSamples: Array<{ t: number; bytes: number }> = [];

  function recordSpeedSample() {
    const now = Date.now();
    speedSamples.push({ t: now, bytes: bytesTransferred });
    // Trim samples older than the window
    const cutoff = now - SPEED_WINDOW_MS;
    while (speedSamples.length > 1 && speedSamples[0].t < cutoff) {
      speedSamples.shift();
    }
  }

  function computeSpeed(): { bytesPerSec?: number; etaSec?: number } {
    if (speedSamples.length < 2) return {};
    const oldest = speedSamples[0];
    const newest = speedSamples[speedSamples.length - 1];
    const elapsedSec = (newest.t - oldest.t) / 1000;
    if (elapsedSec < 0.1) return {};
    const bytesPerSec = (newest.bytes - oldest.bytes) / elapsedSec;
    if (bytesPerSec <= 0) return {};
    const remaining = totalBytes - bytesTransferred;
    const etaSec = remaining > 0 ? Math.round(remaining / bytesPerSec) : 0;
    return { bytesPerSec: Math.round(bytesPerSec), etaSec };
  }

  async function worker(): Promise<void> {
    while (!signal.aborted) {
      const idx = nextIndex++;
      if (idx >= files.length) break;

      await importOne(files[idx]);
      processedCount++;
      recordSpeedSample();

      onProgress({
        currentFile: files[idx].name,
        currentIndex: processedCount,
        totalFiles: files.length,
        bytesTransferred,
        totalBytes,
        skipped,
        errors: errors.length,
        ...computeSpeed(),
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
        recordSpeedSample();
        onProgress({
          currentFile: `${upload.fileName} (FTP ${uploaded}/${ftpUploads.length})`,
          currentIndex: processedCount,
          totalFiles: files.length,
          bytesTransferred,
          totalBytes,
          skipped,
          errors: errors.length,
          ...computeSpeed(),
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
  if (watermarkMissing > 0) {
    errors.push({
      file: 'watermark',
      error: `Skipped watermarking on ${watermarkMissing} file(s). Install ImageMagick ('magick' or 'convert' on PATH) to enable this on macOS/Linux.`,
    });
  }
  if (straightenMissing > 0) {
    errors.push({
      file: 'auto-straighten',
      error: `Skipped auto-straighten/upright conversion on ${straightenMissing} file(s). Install ImageMagick ('magick' or 'convert' on PATH) to enable this on macOS/Linux.`,
    });
  }
  if (whiteBalanceMissing > 0) {
    errors.push({
      file: 'white-balance',
      error: `Skipped white-balance correction on ${whiteBalanceMissing} file(s). Install ImageMagick ('magick' or 'convert' on PATH) to enable this on macOS/Linux.`,
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
