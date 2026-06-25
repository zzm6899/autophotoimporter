import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { constants, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { Client } from 'basic-ftp';
import type { MediaFile, ImportConfig, ImportProgress, ImportResult, ImportError, SaveFormat, BatchMetadata, WatermarkConfig, WatermarkPosition, MetadataExportFlags, ImportLedgerItem, ImportPreflight, ImportPlanItem, ImportConflictPolicy } from '../../shared/types';
import { DEFAULT_METADATA_EXPORT } from '../../shared/types';
import { isDuplicate } from './duplicate-detector';
import { stopsToSafeMultiplier, getEffectiveExposureStops, hasWhiteBalanceAdjustment, whiteBalanceMultipliers } from '../../shared/exposure';
import { JobController } from './job-controller';

function execFileAsync(
  file: string,
  args: string[],
  options: Parameters<typeof execFile>[2] = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

let currentJob: JobController | null = null;

const RAW_COPY_CONCURRENCY = 6;
const MIRRORED_COPY_CONCURRENCY = 3;
const HEAVY_IMPORT_CONCURRENCY = 2;
const SOURCE_MTIME_TOLERANCE_MS = 1;

type SourceSnapshot = {
  size: number;
  mtimeMs?: number;
};

type ScheduleEntry = {
  day: string;
  startMinutes: number;
  endMinutes: number;
  location: string;
  event: string;
  coveredBy: string;
};

type ScheduleMatch = Pick<ImportLedgerItem, 'scheduleLocation' | 'scheduleEvent' | 'scheduleCoveredBy'>;

function importPlanWarnings(file: MediaFile): string[] {
  const warnings: string[] = [];
  if (file.blurRisk === 'high') warnings.push('High blur risk');
  if (typeof file.reviewScore === 'number' && file.reviewScore < 58) warnings.push('Low AI review score');
  if (file.pick === 'selected' && typeof file.reviewScore !== 'number') warnings.push('Selected before AI review completed');
  return warnings;
}

function hasSourceSnapshot(file: MediaFile): boolean {
  return typeof file.sourceModifiedAtMs === 'number' && Number.isFinite(file.sourceModifiedAtMs);
}

function sourceSnapshotChanged(before: SourceSnapshot, after: SourceSnapshot): boolean {
  return before.size !== after.size ||
    (
      typeof before.mtimeMs === 'number' &&
      typeof after.mtimeMs === 'number' &&
      Math.abs(before.mtimeMs - after.mtimeMs) > SOURCE_MTIME_TOLERANCE_MS
    );
}

async function readSourceSnapshot(sourcePath: string): Promise<SourceSnapshot> {
  const sourceStat = await stat(sourcePath);
  return { size: sourceStat.size, mtimeMs: sourceStat.mtimeMs };
}

function sourceSnapshotError(file: MediaFile, snapshot: SourceSnapshot): string | null {
  if (snapshot.size !== file.size) {
    return `Source changed since scan (size ${file.size} -> ${snapshot.size}). Wait for it to finish writing, then rescan or retry.`;
  }
  if (
    typeof snapshot.mtimeMs === 'number' &&
    typeof file.sourceModifiedAtMs === 'number' &&
    Math.abs(snapshot.mtimeMs - file.sourceModifiedAtMs) > SOURCE_MTIME_TOLERANCE_MS
  ) {
    return 'Source changed since scan (modified time changed). Wait for it to finish writing, then rescan or retry.';
  }
  return null;
}

async function getStableSourceSnapshot(file: MediaFile): Promise<{ snapshot: SourceSnapshot | null; error: string | null }> {
  if (!hasSourceSnapshot(file)) return { snapshot: null, error: null };
  try {
    const snapshot = await readSourceSnapshot(file.path);
    return { snapshot, error: sourceSnapshotError(file, snapshot) };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Source file is unavailable';
    return { snapshot: null, error: `Source file is unavailable: ${message}` };
  }
}

async function sourceStabilityError(file: MediaFile): Promise<string | null> {
  return (await getStableSourceSnapshot(file)).error;
}

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

function resolveImportConcurrency(config: ImportConfig): number {
  if (config.saveFormat !== 'original') return HEAVY_IMPORT_CONCURRENCY;
  if (config.verifyChecksums || !!config.backupDestRoot || !!config.ftpDestEnabled) {
    return MIRRORED_COPY_CONCURRENCY;
  }
  return RAW_COPY_CONCURRENCY;
}

function isPortraitOrientation(orientation?: number): boolean {
  return orientation === 5 || orientation === 6 || orientation === 7 || orientation === 8;
}

export function watermarkPositionForOrientation(
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

function tempOutputPath(destFullPath: string): string {
  const parsed = path.parse(destFullPath);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return path.join(parsed.dir, `${parsed.name}.keptra-${token}.tmp${parsed.ext}`);
}

async function removeFileIfExists(filePath: string | null): Promise<void> {
  if (!filePath) return;
  try {
    await unlink(filePath);
  } catch {
    // Best-effort cleanup for temp outputs; the import result should still report the root cause.
  }
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.length > 0)) rows.push(row);
  return rows;
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase();
}

function parseTimeMinutes(value: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})(?:\s*([ap]m))?$/i.exec(value.trim());
  if (!match) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute < 0 || minute > 59) return undefined;
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour < 0 || hour > 23) return undefined;
  return hour * 60 + minute;
}

function weekdayName(date: Date): string {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][date.getDay()];
}

function parseScheduleCsv(text: string): ScheduleEntry[] {
  const rows = parseCsvRows(text);
  const headerIndex = rows.findIndex((row) => {
    const headers = row.map(normalizeHeader);
    return headers.includes('day') && headers.includes('start') && headers.includes('end') && headers.includes('location');
  });
  if (headerIndex < 0) return [];
  const headers = rows[headerIndex].map(normalizeHeader);
  const col = (name: string) => headers.indexOf(name);
  const dayCol = col('day');
  const startCol = col('start');
  const endCol = col('end');
  const locationCol = col('location');
  const eventCol = col('event');
  const coveredByCol = col('covered by');
  const entries: ScheduleEntry[] = [];
  for (const row of rows.slice(headerIndex + 1)) {
    const start = parseTimeMinutes(row[startCol] ?? '');
    const end = parseTimeMinutes(row[endCol] ?? '');
    const day = (row[dayCol] ?? '').trim();
    const location = (row[locationCol] ?? '').trim();
    if (!day || start === undefined || end === undefined || !location) continue;
    entries.push({
      day,
      startMinutes: start,
      endMinutes: end > start ? end : end + 24 * 60,
      location,
      event: eventCol >= 0 ? (row[eventCol] ?? '').trim() : '',
      coveredBy: coveredByCol >= 0 ? (row[coveredByCol] ?? '').trim() : '',
    });
  }
  return entries;
}

function googleSheetCsvExportUrl(source: string): string | undefined {
  const trimmed = source.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:') return undefined;
    if (url.hostname !== 'docs.google.com') {
      return trimmed.toLowerCase().endsWith('.csv') ? trimmed : undefined;
    }
    const match = /^\/spreadsheets\/d\/([^/]+)/.exec(url.pathname);
    if (!match) return undefined;
    const gid = url.searchParams.get('gid') || /^#gid=(\d+)/.exec(url.hash)?.[1];
    const exportUrl = new URL(`https://docs.google.com/spreadsheets/d/${match[1]}/export`);
    exportUrl.searchParams.set('format', 'csv');
    if (gid) exportUrl.searchParams.set('gid', gid);
    return exportUrl.toString();
  } catch {
    return undefined;
  }
}

async function fetchScheduleCsv(scheduleSheetUrl?: string): Promise<string | undefined> {
  const exportUrl = scheduleSheetUrl ? googleSheetCsvExportUrl(scheduleSheetUrl) : undefined;
  if (!exportUrl) return undefined;
  const response = await fetch(exportUrl, {
    headers: { accept: 'text/csv,text/plain,*/*' },
  });
  if (!response.ok) throw new Error(`Schedule fetch failed (${response.status})`);
  return response.text();
}

async function loadScheduleEntries(
  scheduleCsvPath?: string,
  scheduleSheetUrl?: string,
): Promise<{ entries: ScheduleEntry[]; error?: string }> {
  let liveError: string | undefined;
  try {
    const liveCsv = await fetchScheduleCsv(scheduleSheetUrl);
    if (liveCsv) return { entries: parseScheduleCsv(liveCsv) };
  } catch (error) {
    liveError = error instanceof Error ? error.message : 'Live schedule fetch failed';
  }
  const csvPath = scheduleCsvPath?.trim();
  if (!csvPath) return { entries: [], error: liveError };
  try {
    return { entries: parseScheduleCsv(await readFile(csvPath, 'utf8')), error: liveError };
  } catch (error) {
    const fileError = error instanceof Error ? error.message : 'Schedule CSV read failed';
    return { entries: [], error: liveError ? `${liveError}; fallback CSV failed: ${fileError}` : fileError };
  }
}

function normalizeRosterText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function photographerRosterAliases(file: MediaFile): string[] {
  const aliases = new Set<string>();
  if (file.photographerCode) aliases.add(file.photographerCode);
  if (file.photographerName) {
    aliases.add(file.photographerName);
    for (const part of file.photographerName.split(/\s+/)) {
      const cleaned = part.replace(/[^a-z0-9]/gi, '');
      if (cleaned.length >= 2) aliases.add(cleaned);
    }
  }
  return [...aliases].map(normalizeRosterText).filter(Boolean);
}

function rosterCoversPhotographer(coveredBy: string, file: MediaFile): boolean {
  const normalized = normalizeRosterText(coveredBy);
  if (!normalized || normalized === '—' || normalized === '-') return false;
  const aliases = photographerRosterAliases(file);
  return aliases.some((alias) => normalized.split(/\s+/).includes(alias) || normalized.includes(alias));
}

function matchSchedule(file: MediaFile, entries: ScheduleEntry[]): ScheduleMatch | undefined {
  if (!file.dateTaken || entries.length === 0) return undefined;
  const date = new Date(file.dateTaken);
  if (Number.isNaN(date.getTime())) return undefined;
  const day = weekdayName(date).toLowerCase();
  const minutes = date.getHours() * 60 + date.getMinutes();
  const match = entries.find((entry) =>
    entry.day.trim().toLowerCase() === day
    && minutes >= entry.startMinutes
    && minutes < entry.endMinutes
    && rosterCoversPhotographer(entry.coveredBy, file)
  );
  if (!match) return undefined;
  return {
    scheduleLocation: match.location,
    scheduleEvent: match.event,
    scheduleCoveredBy: match.coveredBy,
  };
}

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function importLogName(): string {
  return `import-log-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
}

async function writeImportLogCsv(config: ImportConfig, items: ImportLedgerItem[]): Promise<string | undefined> {
  if (config.dryRun || items.length === 0) return undefined;
  const outputDir = path.join(config.destRoot, '_Keptra Logs');
  const outputPath = path.join(outputDir, importLogName());
  const importedAt = new Date().toISOString();
  const headers = [
    'importedAt',
    'eventMode',
    'photographerCode',
    'photographerName',
    'scheduleLocation',
    'scheduleEvent',
    'scheduleCoveredBy',
    'dateTaken',
    'sourceFile',
    'destinationFile',
    'status',
    'sizeBytes',
    'error',
  ];
  const rows = items.map((item) => [
    importedAt,
    config.eventMode ?? '',
    item.photographerCode ?? '',
    item.photographerName ?? '',
    item.scheduleLocation ?? '',
    item.scheduleEvent ?? '',
    item.scheduleCoveredBy ?? '',
    item.dateTaken ?? '',
    item.sourcePath,
    item.destFullPath ?? item.destRelPath ?? '',
    item.status,
    item.size,
    item.error ?? '',
  ]);
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    outputPath,
    [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n',
    'utf8',
  );
  return outputPath;
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

function fullDestPaths(file: MediaFile, config: ImportConfig): {
  destRelPath?: string;
  destFullPath?: string;
  backupFullPath?: string;
  error?: string;
} {
  if (!file.destPath) return { error: 'No destination path computed' };
  return fullDestPathsFromRel(composeDestPath(file, file.destPath, config), config);
}

function fullDestPathsFromRel(destRelPath: string, config: ImportConfig): {
  destRelPath?: string;
  destFullPath?: string;
  backupFullPath?: string;
  error?: string;
} {
  const destFullPath = path.join(config.destRoot, destRelPath);
  const backupFullPath = config.backupDestRoot ? path.join(config.backupDestRoot, destRelPath) : undefined;
  const primaryRelative = path.relative(path.resolve(config.destRoot), path.resolve(destFullPath));
  if (primaryRelative.startsWith('..') || path.isAbsolute(primaryRelative)) {
    return { destRelPath, destFullPath, backupFullPath, error: 'Destination path escapes the selected folder' };
  }
  if (backupFullPath && config.backupDestRoot) {
    const backupRelative = path.relative(path.resolve(config.backupDestRoot), path.resolve(backupFullPath));
    if (backupRelative.startsWith('..') || path.isAbsolute(backupRelative)) {
      return { destRelPath, destFullPath, backupFullPath, error: 'Backup path escapes the selected folder' };
    }
  }
  return { destRelPath, destFullPath, backupFullPath };
}

type ResolvedImportPaths = ReturnType<typeof fullDestPaths> & {
  conflict: boolean;
  policy: ImportConflictPolicy;
  skipped?: boolean;
  reason?: string;
};

type DestinationReservations = Set<string>;

function conflictPolicyFor(config: ImportConfig): ImportConflictPolicy {
  return config.conflictPolicy ?? 'skip';
}

function cleanConflictFolderName(config: ImportConfig): string {
  const folder = (config.conflictFolderName || '_Conflicts').replace(/^[/\\]+|[/\\]+$/g, '').trim();
  return folder || '_Conflicts';
}

async function destinationExists(fullPath?: string): Promise<boolean> {
  if (!fullPath) return false;
  try {
    await stat(fullPath);
    return true;
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw err;
  }
}

async function primaryDestinationExists(paths: ReturnType<typeof fullDestPaths>): Promise<boolean> {
  return await destinationExists(paths.destFullPath);
}

function destinationReservationKey(fullPath?: string): string | undefined {
  if (!fullPath) return undefined;
  const resolved = path.resolve(fullPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function tryReserveDestination(
  paths: ReturnType<typeof fullDestPaths>,
  reservations?: DestinationReservations,
): boolean {
  const key = destinationReservationKey(paths.destFullPath);
  if (!key || !reservations) return true;
  if (reservations.has(key)) return false;
  reservations.add(key);
  return true;
}

function releaseDestination(
  paths: ReturnType<typeof fullDestPaths>,
  reservations?: DestinationReservations,
): void {
  const key = destinationReservationKey(paths.destFullPath);
  if (key) reservations?.delete(key);
}

function renameCandidateRelPath(destRelPath: string, index: number): string {
  const parsed = path.parse(destRelPath);
  const suffix = index === 0 ? '' : ` (${index})`;
  return path.join(parsed.dir, `${parsed.name}${suffix}${parsed.ext}`);
}

async function findAvailableDestPaths(
  startRelPath: string,
  config: ImportConfig,
  startIndex: number,
  reservations?: DestinationReservations,
): Promise<ReturnType<typeof fullDestPaths>> {
  for (let index = startIndex; index < 10000; index++) {
    const candidate = fullDestPathsFromRel(renameCandidateRelPath(startRelPath, index), config);
    if (candidate.error) return candidate;
    if (!tryReserveDestination(candidate, reservations)) continue;
    if (!await primaryDestinationExists(candidate)) return candidate;
    releaseDestination(candidate, reservations);
  }
  return {
    ...fullDestPathsFromRel(startRelPath, config),
    error: 'Could not find an available destination name',
  };
}

async function resolveImportDestPaths(
  file: MediaFile,
  config: ImportConfig,
  reservations?: DestinationReservations,
): Promise<ResolvedImportPaths> {
  const paths = fullDestPaths(file, config);
  const policy = conflictPolicyFor(config);
  if (paths.error) return { ...paths, conflict: false, policy };
  const reservedConflict = !tryReserveDestination(paths, reservations);
  const diskConflict = await primaryDestinationExists(paths);
  const conflict = reservedConflict || diskConflict;
  if (!conflict) {
    return { ...paths, conflict: false, policy };
  }

  if (policy === 'skip') {
    if (!reservedConflict) releaseDestination(paths, reservations);
    return {
      ...paths,
      conflict: true,
      policy,
      skipped: true,
      reason: reservedConflict
        ? 'Destination path is already used by another file in this import'
        : 'Destination file already exists',
    };
  }

  if (policy === 'overwrite' && !reservedConflict) {
    return { ...paths, conflict: true, policy, reason: 'Destination exists; will overwrite' };
  }

  if (policy === 'conflicts-folder' && paths.destRelPath) {
    if (!reservedConflict) releaseDestination(paths, reservations);
    const conflictRelPath = path.join(cleanConflictFolderName(config), paths.destRelPath);
    const resolved = await findAvailableDestPaths(conflictRelPath, config, 0, reservations);
    return { ...resolved, conflict: true, policy, reason: 'Destination exists; will import to conflicts folder' };
  }

  if (paths.destRelPath) {
    if (!reservedConflict) releaseDestination(paths, reservations);
    const resolved = await findAvailableDestPaths(paths.destRelPath, config, 1, reservations);
    return {
      ...resolved,
      conflict: true,
      policy,
      reason: reservedConflict
        ? 'Destination path is already used in this import; will rename'
        : 'Destination exists; will rename',
    };
  }

  return { ...paths, conflict: true, policy, skipped: true, reason: 'Destination file already exists' };
}

export async function planImportFiles(files: MediaFile[], config: ImportConfig): Promise<ImportPreflight> {
  const items: ImportPlanItem[] = [];
  let duplicates = 0;
  let conflicts = 0;
  let invalid = 0;
  let willImport = 0;
  let lowConfidence = 0;
  const destinationReservations: DestinationReservations = new Set();

  for (const file of files) {
    const paths = fullDestPaths(file, config);
    const warnings = importPlanWarnings(file);
    if (warnings.length > 0) lowConfidence++;
    const base = {
      sourcePath: file.path,
      name: file.name,
      size: file.size,
      destRelPath: paths.destRelPath,
      destFullPath: paths.destFullPath,
      backupFullPath: paths.backupFullPath,
      warnings,
    };
    if (paths.error) {
      invalid++;
      items.push({ ...base, status: 'invalid', reason: paths.error });
      continue;
    }
    const unstableSource = await sourceStabilityError(file);
    if (unstableSource) {
      invalid++;
      items.push({ ...base, status: 'invalid', reason: unstableSource });
      continue;
    }
    if (config.skipDuplicates && paths.destRelPath && await isDuplicate(config.destRoot, paths.destRelPath, file.size, file.sourceModifiedAtMs)) {
      duplicates++;
      items.push({ ...base, status: 'duplicate', reason: 'Already exists at destination with matching size and mtime' });
      continue;
    }
    const resolved = await resolveImportDestPaths(file, config, destinationReservations);
    if (resolved.error) {
      invalid++;
      items.push({ ...base, status: 'invalid', reason: resolved.error });
      continue;
    }
    if (resolved.conflict) conflicts++;
    if (resolved.skipped) {
      items.push({ ...base, status: 'conflict', reason: resolved.reason });
      continue;
    }
    willImport++;
    items.push({
      ...base,
      destRelPath: resolved.destRelPath,
      destFullPath: resolved.destFullPath,
      backupFullPath: resolved.backupFullPath,
      status: 'will-import',
      reason: resolved.reason,
    });
  }

  return {
    totalFiles: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    willImport,
    duplicates,
    conflicts,
    invalid,
    lowConfidence,
    conflictPolicy: conflictPolicyFor(config),
    conflictFolderName: cleanConflictFolderName(config),
    sessionWarnings: [
      ...(files.length === 0 ? ['No importable files match the current selection.'] : []),
      ...(lowConfidence > 0 ? [`${lowConfidence} selected file${lowConfidence === 1 ? '' : 's'} should get a second-pass review.`] : []),
      ...(conflicts > 0 && conflictPolicyFor(config) === 'skip' ? [`${conflicts} conflict${conflicts === 1 ? '' : 's'} will be skipped.`] : []),
      ...(conflicts > 0 && conflictPolicyFor(config) === 'overwrite' ? [`${conflicts} conflict${conflicts === 1 ? '' : 's'} will overwrite existing destination files.`] : []),
      ...(config.backupDestRoot ? [] : ['No backup destination is enabled for this import.']),
      ...(config.verifyChecksums ? [] : ['Checksum verification is off.']),
    ],
    recoveryAvailable: false,
    backupEnabled: !!config.backupDestRoot,
    ftpEnabled: !!config.ftpDestEnabled,
    checksumEnabled: !!config.verifyChecksums,
    metadataEnabled: !!config.metadata || !!config.metadataExportFlags,
    watermarkEnabled: !!config.watermark?.enabled,
    dryRun: !!config.dryRun,
    items,
  };
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
  // sips does not support auto-orient; the autoStraighten flag is handled by
  // the ImageMagick path. Only add formatOptions once (for JPEG quality).
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
        ${watermark?.mode === 'image' ? `
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
        }
        ` : `
        $font = New-Object System.Drawing.Font('Arial', [float]${pointSize}, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
        $shadowBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb([int](255 * ${shadowOpacity}), 0, 0, 0))
        $textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb([int](255 * ${opacity}), 255, 255, 255))
        $format = New-Object System.Drawing.StringFormat
        switch ('${gravity}') {
          'southwest' { $format.Alignment = [System.Drawing.StringAlignment]::Near; $format.LineAlignment = [System.Drawing.StringAlignment]::Far; $x = ${margin}; $y = $bmp.Height - ${margin} }
          'northeast' { $format.Alignment = [System.Drawing.StringAlignment]::Far; $format.LineAlignment = [System.Drawing.StringAlignment]::Near; $x = $bmp.Width - ${margin}; $y = ${margin} }
          'northwest' { $format.Alignment = [System.Drawing.StringAlignment]::Near; $format.LineAlignment = [System.Drawing.StringAlignment]::Near; $x = ${margin}; $y = ${margin} }
          'center' { $format.Alignment = [System.Drawing.StringAlignment]::Center; $format.LineAlignment = [System.Drawing.StringAlignment]::Center; $x = $bmp.Width / 2; $y = $bmp.Height / 2 }
          default { $format.Alignment = [System.Drawing.StringAlignment]::Far; $format.LineAlignment = [System.Drawing.StringAlignment]::Far; $x = $bmp.Width - ${margin}; $y = $bmp.Height - ${margin} }
        }
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
let imageMagickBinary: string | null | undefined;
async function detectImageMagick(): Promise<string | null> {
  if (imageMagickBinary !== undefined) return imageMagickBinary;
  const candidates = process.platform === 'darwin'
    ? ['magick', '/opt/homebrew/bin/magick', '/usr/local/bin/magick', 'convert', '/opt/homebrew/bin/convert', '/usr/local/bin/convert']
    : ['magick', 'convert'];
  for (const bin of candidates) {
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
  binary: string,
  autoStraighten = false,
  orientation?: number,
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
    const gravity = watermarkGravity(watermarkPositionForOrientation(watermark, orientation));
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
    return convertWithPowerShell(srcPath, destFullPath, format, jpegQuality, brightness, whiteBalance, orientation, watermark);
  }

  // For darwin + linux: prefer ImageMagick when brightness matters or when
  // we're on Linux. Fall back to sips (mac) / raises otherwise.
  if (needsBrightness || wantsWhiteBalance || wantsWatermark || wantsStraighten) {
    const bin = await detectImageMagick();
    if (bin) {
      return convertWithImageMagick(srcPath, destFullPath, format, jpegQuality, brightness, whiteBalance, bin, wantsStraighten, orientation, watermark);
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
  currentJob?.cancel();
  const job = new JobController('import');
  currentJob = job;
  job.start();
  const { signal } = job;

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
  const destinationReservations: DestinationReservations = new Set();
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
  const ledgerItemsBySource = new Map<string, ImportLedgerItem>();
  const scheduleLoad = await loadScheduleEntries(config.scheduleCsvPath, config.scheduleSheetUrl);
  const scheduleEntries = scheduleLoad.entries;
  if (scheduleLoad.error) {
    errors.push({ file: 'schedule-source', error: scheduleLoad.error });
  }
  for (const file of files) {
    const plannedPaths = fullDestPaths(file, config);
    const scheduleMatch = matchSchedule(file, scheduleEntries);
    ledgerItemsBySource.set(file.path, {
      sourcePath: file.path,
      name: file.name,
      size: file.size,
      dateTaken: file.dateTaken,
      destRelPath: plannedPaths.destRelPath,
      destFullPath: plannedPaths.destFullPath,
      backupFullPath: plannedPaths.backupFullPath,
      photographerCode: file.photographerCode,
      photographerName: file.photographerName,
      ...scheduleMatch,
      status: 'pending',
    });
  }

  function recordLedgerItem(file: MediaFile, item: ImportLedgerItem): void {
    ledgerItemsBySource.set(file.path, item);
  }

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

  function assertInside(root: string, target: string): void {
    const relative = path.relative(path.resolve(root), path.resolve(target));
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Destination path escapes the selected folder');
    }
  }

  async function importOne(file: MediaFile): Promise<void> {
    const plannedPaths = fullDestPaths(file, config);
    const scheduleMatch = matchSchedule(file, scheduleEntries);
    const ledgerBase: ImportLedgerItem = {
      sourcePath: file.path,
      name: file.name,
      size: file.size,
      dateTaken: file.dateTaken,
      destRelPath: plannedPaths.destRelPath,
      destFullPath: plannedPaths.destFullPath,
      backupFullPath: plannedPaths.backupFullPath,
      photographerCode: file.photographerCode,
      photographerName: file.photographerName,
      ...scheduleMatch,
      status: 'pending',
    };
    if (plannedPaths.error) {
      errors.push({ file: file.name, error: plannedPaths.error });
      recordLedgerItem(file, { ...ledgerBase, status: 'failed', error: plannedPaths.error });
      return;
    }

    try {
      if (plannedPaths.destFullPath) assertInside(config.destRoot, plannedPaths.destFullPath);
      if (plannedPaths.backupFullPath && config.backupDestRoot) {
        assertInside(config.backupDestRoot, plannedPaths.backupFullPath);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Destination path rejected';
      errors.push({ file: file.name, error: message });
      recordLedgerItem(file, { ...ledgerBase, status: 'failed', error: message });
      return;
    }

    let sourceBeforeCopy: SourceSnapshot | null = null;
    if (!config.dryRun) {
      const sourceCheck = await getStableSourceSnapshot(file);
      if (sourceCheck.error) {
        errors.push({ file: file.name, error: sourceCheck.error });
        recordLedgerItem(file, { ...ledgerBase, status: 'pending', error: sourceCheck.error });
        return;
      }
      sourceBeforeCopy = sourceCheck.snapshot;
    }

    if (config.skipDuplicates) {
      const dup = plannedPaths.destRelPath
        ? await isDuplicate(config.destRoot, plannedPaths.destRelPath, file.size, file.sourceModifiedAtMs)
        : false;
      if (dup) {
        skipped++;
        recordLedgerItem(file, { ...ledgerBase, status: 'skipped', error: 'Duplicate at destination' });
        return;
      }
    }

    const resolvedPaths = (config.dryRun || config.conflictPolicy || sourceBeforeCopy)
      ? await resolveImportDestPaths(file, config, destinationReservations)
      : { ...plannedPaths, conflict: false, policy: conflictPolicyFor(config) };
    const resolvedLedgerBase: ImportLedgerItem = {
      ...ledgerBase,
      destRelPath: resolvedPaths.destRelPath,
      destFullPath: resolvedPaths.destFullPath,
      backupFullPath: resolvedPaths.backupFullPath,
    };
    if (resolvedPaths.error) {
      errors.push({ file: file.name, error: resolvedPaths.error });
      recordLedgerItem(file, { ...resolvedLedgerBase, status: 'failed', error: resolvedPaths.error });
      return;
    }
    if (resolvedPaths.skipped) {
      skipped++;
      recordLedgerItem(file, { ...resolvedLedgerBase, status: 'skipped', error: resolvedPaths.reason || 'Destination already exists' });
      return;
    }

    const finalRelPath = resolvedPaths.destRelPath;
    const destFullPath = resolvedPaths.destFullPath;
    const backupFullPath = resolvedPaths.backupFullPath ?? null;
    if (!finalRelPath || !destFullPath) {
      const message = 'No destination path computed';
      errors.push({ file: file.name, error: message });
      recordLedgerItem(file, { ...resolvedLedgerBase, status: 'failed', error: message });
      return;
    }
    const copyMode = conflictPolicyFor(config) === 'overwrite' ? undefined : constants.COPYFILE_EXCL;

    // Dry run — count what would happen, don't touch disk
    if (config.dryRun) {
      imported++;
      bytesTransferred += file.size;
      recordLedgerItem(file, { ...resolvedLedgerBase, status: 'planned' });
      return;
    }

    let primaryTempPath: string | null = null;
    try {
      await ensureDir(path.dirname(destFullPath));
      primaryTempPath = sourceBeforeCopy ? tempOutputPath(destFullPath) : null;
      const primaryWritePath = primaryTempPath ?? destFullPath;

      if (saveFormat === 'original') {
        await copyFile(file.path, primaryWritePath, primaryTempPath ? constants.COPYFILE_EXCL : copyMode);
      } else {
        const brightness = brightnessFor(file);
        const whiteBalance = whiteBalanceFor(file);
        const { normalized, watermarked, straightened, whiteBalanced } = await convertAndCopy(
          file.path, primaryWritePath, saveFormat, jpegQuality, brightness, whiteBalance, file.orientation, config.watermark, config.autoStraighten,
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

      if (sourceBeforeCopy && primaryTempPath) {
        let sourceAfterCopy: SourceSnapshot;
        try {
          sourceAfterCopy = await readSourceSnapshot(file.path);
        } catch (sourceErr) {
          const message = sourceErr instanceof Error ? sourceErr.message : 'Source file became unavailable during import';
          const error = `Source file changed during import: ${message}. Wait for it to finish writing, then retry.`;
          await removeFileIfExists(primaryTempPath);
          primaryTempPath = null;
          errors.push({ file: file.name, error });
          recordLedgerItem(file, { ...resolvedLedgerBase, status: 'pending', error });
          return;
        }

        if (sourceSnapshotChanged(sourceBeforeCopy, sourceAfterCopy)) {
          const error = 'Source changed during import. Wait for it to finish writing, then retry.';
          await removeFileIfExists(primaryTempPath);
          primaryTempPath = null;
          errors.push({ file: file.name, error });
          recordLedgerItem(file, { ...resolvedLedgerBase, status: 'pending', error });
          return;
        }

        if (saveFormat === 'original') {
          const tempStat = await stat(primaryTempPath);
          if (tempStat.size !== sourceAfterCopy.size) {
            const error = `Copied file size mismatch (${tempStat.size} != ${sourceAfterCopy.size}). Wait for the source to settle, then retry.`;
            await removeFileIfExists(primaryTempPath);
            primaryTempPath = null;
            errors.push({ file: file.name, error });
            recordLedgerItem(file, { ...resolvedLedgerBase, status: 'pending', error });
            return;
          }
        }
      }

      if (primaryTempPath) {
        if (conflictPolicyFor(config) !== 'overwrite' && await destinationExists(destFullPath)) {
          throw Object.assign(new Error('Destination already exists'), { code: 'EEXIST' });
        }
        await rename(primaryTempPath, destFullPath);
        primaryTempPath = null;
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
          await copyFile(destFullPath, backupFullPath, copyMode);
          if (primarySidecarPath) {
            await copyFile(primarySidecarPath, sidecarPathFor(backupFullPath), copyMode);
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
      let finalStatus: ImportLedgerItem['status'] = 'imported';
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
            finalStatus = 'verified';
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
      recordLedgerItem(file, { ...resolvedLedgerBase, status: finalStatus });
    } catch (err: unknown) {
      await removeFileIfExists(primaryTempPath);
      const error = err as NodeJS.ErrnoException;

      if (error.code === 'ENOSPC') {
        const message = 'Disk full';
        errors.push({ file: file.name, error: message });
        recordLedgerItem(file, { ...resolvedLedgerBase, status: 'failed', error: message });
        job.cancel();
        return;
      }

      if (error.code === 'EEXIST') {
        skipped++;
        recordLedgerItem(file, { ...resolvedLedgerBase, status: 'skipped', error: 'Destination already exists' });
      } else {
        const message = error.message || 'Import failed';
        errors.push({ file: file.name, error: message });
        recordLedgerItem(file, { ...resolvedLedgerBase, status: 'failed', error: message });
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

  const PROGRESS_MIN_INTERVAL_MS = 120;
  const PROGRESS_MIN_FILE_DELTA = 16;
  let lastProgressAt = 0;
  let lastProgressIndex = 0;
  function emitProgress(currentFile: string, force = false): void {
    const now = Date.now();
    const enoughTime = now - lastProgressAt >= PROGRESS_MIN_INTERVAL_MS;
    const enoughFiles = processedCount - lastProgressIndex >= PROGRESS_MIN_FILE_DELTA;
    if (!force && !enoughTime && !enoughFiles) return;
    lastProgressAt = now;
    lastProgressIndex = processedCount;
    onProgress({
      currentFile,
      currentIndex: processedCount,
      totalFiles: files.length,
      bytesTransferred,
      totalBytes,
      skipped,
      errors: errors.length,
      ...computeSpeed(),
    });
  }

  async function worker(): Promise<void> {
    while (!signal.aborted) {
      const idx = nextIndex++;
      if (idx >= files.length) break;

      await importOne(files[idx]);
      processedCount++;
      recordSpeedSample();
      emitProgress(files[idx].name, processedCount >= files.length || signal.aborted);
    }
  }

  const importConcurrency = Math.min(resolveImportConcurrency(config), files.length);
  await Promise.all(Array.from({ length: importConcurrency }, () => worker()));

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
        await client.ensureDir(remoteDir);
        // Use the absolute remote path so concurrent sidecar uploads that change
        // the client CWD cannot redirect this file to the wrong directory.
        await client.uploadFrom(upload.localPath, remotePath);
        uploaded++;
        recordSpeedSample();
        emitProgress(`${upload.fileName} (FTP ${uploaded}/${ftpUploads.length})`, uploaded >= ftpUploads.length);
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

  if (signal.aborted) {
    job.cancel();
  } else if (errors.length > 0) {
    job.fail(new Error('Import completed with errors'));
  } else {
    job.complete({ current: files.length, total: files.length, percent: 100 });
  }
  if (currentJob === job) currentJob = null;

  let importLogCsvPath: string | undefined;
  try {
    if (imported + skipped > 0) {
      importLogCsvPath = await writeImportLogCsv(config, [...ledgerItemsBySource.values()]);
    }
  } catch (logErr) {
    errors.push({
      file: 'import-log',
      error: logErr instanceof Error ? logErr.message : 'Could not write local import log CSV',
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
    importLogCsvPath,
    ledgerItems: [...ledgerItemsBySource.values()],
  };
}

export function cancelImport(): void {
  currentJob?.cancel();
  currentJob = null;
}
