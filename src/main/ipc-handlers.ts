import { ipcMain, dialog, shell, app, BrowserWindow, autoUpdater } from 'electron';
import { readFile, writeFile, mkdir, open, rm, rename, statfs, readdir, stat, copyFile, chmod } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { DEFAULT_VIEW_OVERLAY_PREFERENCES, IPC, PHOTO_EXTENSIONS } from '../shared/types';
import type { ImportConfig, ImportResult, AppSettings, MediaFile, FtpConfig, FtpSyncStatus, Volume, UpdateState, ImportLedger, ImportHealthSummary, MacFirstRunDoctor, AppDiagnosticsSnapshot, UpdateRepairResult, AppSession, WatchFolder, CatalogBrowserQuery } from '../shared/types';
import { listVolumes, startWatching, stopWatching } from './services/volume-watcher';
import { scanFiles, cancelScan, pauseScan, resumeScan } from './services/file-scanner';
import { importFiles, cancelImport, planImportFiles } from './services/import-engine';
import { writeLightroomHandoff } from './services/lightroom-handoff';
import { isDuplicate } from './services/duplicate-detector';
import { generatePreview } from './services/exif-parser';
import { checkForUpdate, fetchUpdateHistory, readLastKnownGoodUpdateMetadata } from './services/update-checker';
import { probeFtp, mirrorFtp } from './services/ftp-source';
import { activateLicenseInput, checkHostedLicenseStatus, validateLicenseKey } from './services/license';
import { analyzeFaces, faceModelsAvailable, serializeEmbedding, isGpuAvailable, getActualExecutionProvider, getFaceProviderDiagnostics, configureGpuAcceleration, configureGpuDevice, configureCpuOptimization, configureFaceThroughput, clearImageDecodeCache, diagnoseFaceEngine, runFaceGpuStressTest } from './services/face-engine';
import { getCachedFaceResult, setCachedFaceResult, clearFaceCache } from './services/face-cache';
import { detectDeviceTier, applyDeviceTier } from './services/device-tier';
import { setRawPreviewQuality } from './services/exif-parser';
import { openCatalog, type CatalogService } from './services/catalog';
import { normalizeWatchFolders, WatchFolderManager, type WatchFolderTrigger } from './services/watch-folders';
import { registerSettingsHandlers } from './ipc/settings-handlers';
import { registerScanHandlers } from './ipc/scan-handlers';
import { registerImportHandlers } from './ipc/import-handlers';
import { registerUpdateHandlers } from './ipc/update-handlers';
import { registerFtpHandlers } from './ipc/ftp-handlers';
import { registerLicenseHandlers } from './ipc/license-handlers';
import { registerFaceHandlers } from './ipc/face-handlers';
import { log } from './logger';



type IpcErrorResponse = { ok: false; code: string; message: string };

function ipcError(code: string, message: string): IpcErrorResponse {
  return { ok: false, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isFtpConfig(value: unknown): value is FtpConfig {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.host)
    && isNumber(value.port)
    && value.port >= 1
    && value.port <= 65535
    && isNonEmptyString(value.user)
    && typeof value.password === 'string'
    && isBoolean(value.secure)
    && isNonEmptyString(value.remotePath);
}

function isViewOverlayPreferencesPatch(value: unknown): boolean {
  if (!isRecord(value)) return false;
  for (const key of ['photoStats', 'histogram', 'faceBoxes', 'peopleBoxes', 'aiReasons']) {
    if (value[key] != null && !isBoolean(value[key])) return false;
  }
  return true;
}

function isImportConfig(value: unknown): value is ImportConfig {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.sourcePath)
    && isNonEmptyString(value.destRoot)
    && isBoolean(value.skipDuplicates)
    && (value.conflictPolicy == null || value.conflictPolicy === 'skip' || value.conflictPolicy === 'rename' || value.conflictPolicy === 'overwrite' || value.conflictPolicy === 'conflicts-folder')
    && (value.conflictFolderName == null || typeof value.conflictFolderName === 'string')
    && (value.saveFormat === 'original' || value.saveFormat === 'jpeg' || value.saveFormat === 'tiff' || value.saveFormat === 'heic')
    && isNumber(value.jpegQuality);
}

function isSafeHttpUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function isSafePath(value: unknown): value is string {
  return isNonEmptyString(value) && !value.includes('\0');
}

const BLOCKED_SHELL_OPEN_EXTENSIONS = new Set([
  '.app',
  '.bat',
  '.cmd',
  '.com',
  '.cpl',
  '.exe',
  '.hta',
  '.jar',
  '.js',
  '.jse',
  '.lnk',
  '.msi',
  '.msp',
  '.ps1',
  '.scr',
  '.sh',
  '.url',
  '.vb',
  '.vbe',
  '.vbs',
  '.wsf',
]);

function isSafeOpenPath(value: unknown): value is string {
  if (!isSafePath(value)) return false;
  const normalized = path.normalize(value);
  if (!path.isAbsolute(normalized)) return false;
  return !BLOCKED_SHELL_OPEN_EXTENSIONS.has(path.extname(normalized).toLowerCase());
}

const MAX_FACE_ANALYSIS_BATCH = 256;

function isFaceAnalysisPath(value: unknown): value is string {
  if (!isSafePath(value)) return false;
  const normalized = path.normalize(value);
  return path.isAbsolute(normalized) && PHOTO_EXTENSIONS.has(path.extname(normalized).toLowerCase());
}

function isFaceAnalysisInput(value: unknown): value is string | string[] {
  const paths = Array.isArray(value) ? value : [value];
  return paths.length > 0
    && paths.length <= MAX_FACE_ANALYSIS_BATCH
    && paths.every(isFaceAnalysisPath);
}

function isOptionalBoundedNumber(value: unknown, min: number, max: number): boolean {
  return value == null || (isNumber(value) && value >= min && value <= max);
}

function isSettingsPatch(value: unknown): value is Partial<AppSettings> {
  if (!isRecord(value)) return false;
  if (value.ftpConfig != null && !isFtpConfig(value.ftpConfig)) return false;
  if (value.ftpDestConfig != null && !isFtpConfig(value.ftpDestConfig)) return false;
  if (value.viewOverlayPreferences != null && !isViewOverlayPreferencesPatch(value.viewOverlayPreferences)) return false;
  if (value.lastDestination != null && typeof value.lastDestination !== 'string') return false;
  if (value.sourceProfile != null && !['auto', 'ssd', 'usb', 'nas'].includes(String(value.sourceProfile))) return false;
  if (value.defaultConflictPolicy != null && !['skip', 'rename', 'overwrite', 'conflicts-folder'].includes(String(value.defaultConflictPolicy))) return false;
  if (value.conflictFolderName != null && typeof value.conflictFolderName !== 'string') return false;
  if (value.watchFolders != null && !Array.isArray(value.watchFolders)) return false;
  return true;
}

function isAppSession(value: unknown): value is AppSession {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.updatedAt === 'string'
    && (value.sourcePath === null || typeof value.sourcePath === 'string')
    && (value.destRoot === null || typeof value.destRoot === 'string')
    && Array.isArray(value.files)
    && Array.isArray(value.selectedPaths)
    && Array.isArray(value.queuedPaths)
    && typeof value.filter === 'string'
    && isRecord(value.stats);
}

function isMediaFileArray(value: unknown): value is MediaFile[] {
  return Array.isArray(value) && value.every((file) =>
    isRecord(file)
    && isNonEmptyString(file.path)
    && isNonEmptyString(file.name)
    && isNumber(file.size)
    && (file.type === 'photo' || file.type === 'video')
    && typeof file.extension === 'string'
  );
}

function isCatalogBrowserQuery(value: unknown): value is CatalogBrowserQuery {
  if (value == null) return true;
  if (!isRecord(value)) return false;
  if (value.search != null && typeof value.search !== 'string') return false;
  if (value.sourcePath != null && typeof value.sourcePath !== 'string') return false;
  if (value.destinationPath != null && typeof value.destinationPath !== 'string') return false;
  if (value.camera != null && typeof value.camera !== 'string') return false;
  if (value.lens != null && typeof value.lens !== 'string') return false;
  if (value.visualHash != null && typeof value.visualHash !== 'string') return false;
  if (value.imported != null && !['any', 'imported', 'not-imported'].includes(String(value.imported))) return false;
  if (value.limit != null && !isNumber(value.limit)) return false;
  if (value.offset != null && !isNumber(value.offset)) return false;
  if (value.sortBy != null && !['lastSeenAt', 'lastImportedAt', 'name', 'size'].includes(String(value.sortBy))) return false;
  if (value.sortDirection != null && !['asc', 'desc'].includes(String(value.sortDirection))) return false;
  return true;
}

type IpcValidator = (args: unknown[]) => IpcErrorResponse | null;

function handleIpc(channel: string, handler: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown | Promise<unknown>, validator?: IpcValidator): void {
  ipcMain.handle(channel, async (event, ...args) => {
    const invalid = validator?.(args);
    if (invalid) return invalid;
    try {
      return await handler(event, ...args);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected IPC failure';
      log.error(`[ipc:${channel}]`, error);
      return ipcError('INTERNAL_ERROR', message);
    }
  });
}

function buildImportMetadata(settings: AppSettings): ImportConfig['metadata'] {
  const keywords = settings.metadataKeywords
    ?.split(/[\n,;]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const title = settings.metadataTitle?.trim();
  const caption = settings.metadataCaption?.trim();
  const creator = settings.metadataCreator?.trim();
  const copyright = settings.metadataCopyright?.trim();
  if (!keywords?.length && !title && !caption && !creator && !copyright) {
    return undefined;
  }
  return {
    keywords: keywords && keywords.length > 0 ? keywords : undefined,
    title: title || undefined,
    caption: caption || undefined,
    creator: creator || undefined,
    copyright: copyright || undefined,
  };
}

function buildWatermarkConfig(settings: AppSettings): ImportConfig['watermark'] {
  const mode = settings.watermarkMode ?? 'text';
  const text = settings.watermarkText?.trim();
  const imagePath = settings.watermarkImagePath?.trim();
  if (!settings.watermarkEnabled) return undefined;
  if (mode === 'image' && !imagePath) return undefined;
  if (mode === 'text' && !text) return undefined;
  return {
    enabled: true,
    mode,
    text: mode === 'text' ? text : undefined,
    imagePath: mode === 'image' ? imagePath : undefined,
    opacity: settings.watermarkOpacity ?? 0.3,
    positionLandscape: settings.watermarkPositionLandscape ?? 'bottom-right',
    positionPortrait: settings.watermarkPositionPortrait ?? settings.watermarkPositionLandscape ?? 'bottom-right',
    scale: settings.watermarkScale ?? 0.045,
  };
}

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

let scannedFiles: MediaFile[] = [];
let scannedFilesByPath = new Map<string, MediaFile>();
let knownVolumePaths = new Set<string>();
type QueuedAutoImport = {
  volume: Volume;
  destRoot?: string;
  requireGlobalAutoImport?: boolean;
  autoEject?: boolean;
};

let autoImportQueue: QueuedAutoImport[] = [];
let autoImportRunning = false;
let currentAutoImportPath: string | null = null;
let lastUpdateState: UpdateState | null = null;
let configuredFeedUrl: string | null = null;
let autoUpdaterReady = false;
let downloadedInstallerPath: string | null = null;
let downloadedInstallerVersion: string | null = null;
let downloadedUpdateKind: 'installer' | 'native' | null = null;
let ftpSyncAbort: AbortController | null = null;
let ftpSyncRunning = false;
let ftpSyncTimer: NodeJS.Timeout | null = null;
let lastFtpSyncStatus: FtpSyncStatus = {
  state: 'idle',
  stage: 'idle',
  message: 'FTP sync is idle.',
};
let watchFolderManager: WatchFolderManager | null = null;
let catalogService: Promise<CatalogService> | null = null;

function getCatalogService(): Promise<CatalogService> {
  catalogService ??= openCatalog(path.join(app.getPath('userData'), 'catalog'));
  return catalogService;
}

const UPDATE_ALLOWED_HOSTS = new Set([
  'keptra.z2hs.au',
  'updates.keptra.z2hs.au',
  'admin.keptra.z2hs.au',
  'github.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);
const UPDATE_ALLOWED_SCHEMES = new Set(['https:']);
const UPDATE_DIAGNOSTIC_ENDPOINTS: AppDiagnosticsSnapshot['endpoints'] = [
  { url: 'https://keptra.z2hs.au/api/v1/app/update', role: 'primary' },
  { url: 'https://updates.keptra.z2hs.au/api/v1/app/update', role: 'fallback' },
  { url: 'https://culler.z2hs.au/api/v1/app/update', role: 'legacy' },
  { url: 'https://updates.culler.z2hs.au/api/v1/app/update', role: 'legacy' },
];

function logUpdateDiagnostic(event: string, details: Record<string, unknown>) {
  console.info('[updates-ipc]', JSON.stringify({ event, ...details }));
}

function isAllowlistedUpdateUrl(value?: unknown): boolean {
  if (value == null) return true;
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return false;
    if (!UPDATE_ALLOWED_SCHEMES.has(parsed.protocol) || !UPDATE_ALLOWED_HOSTS.has(parsed.hostname)) {
      return false;
    }
    if (parsed.hostname === 'github.com') {
      return /^\/[^/]+\/[^/]+\/releases\/download\//.test(parsed.pathname);
    }
    return true;
  } catch {
    return false;
  }
}

function resolveRedirectUrl(currentUrl: string, location: string | null): string | null {
  if (!location) return null;
  try {
    return new URL(location, currentUrl).toString();
  } catch {
    return null;
  }
}

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function getLegacySettingsPath(): string {
  return path.join(app.getPath('appData'), 'Photo Importer', 'settings.json');
}

function getLedgersDir(): string {
  return path.join(app.getPath('userData'), 'import-ledgers');
}

function getLatestLedgerPath(): string {
  return path.join(getLedgersDir(), 'latest.json');
}

function getSessionsDir(): string {
  return path.join(app.getPath('userData'), 'sessions');
}

function getLatestSessionPath(): string {
  return path.join(getSessionsDir(), 'latest.json');
}

function getUpdateMetadataPath(): string {
  return path.join(app.getPath('userData'), 'update-metadata.json');
}

function getUpdatesCachePath(): string {
  return path.join(app.getPath('userData'), 'updates');
}

function getDiagnosticsDir(): string {
  return path.join(app.getPath('userData'), 'diagnostics');
}

function getBenchmarkOutputDir(): string {
  return path.resolve(process.cwd(), 'artifacts', 'benchmarks');
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

async function walkFiles(dirPath: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dirPath, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(entryPath));
      return;
    }
    if (entry.isFile()) files.push(entryPath);
  }));
  return files;
}

async function runSmokeBenchmark(): Promise<{ ok: boolean; outPath: string; files: number; bytes: number; records: number; error?: string }> {
  const fixtureDir = path.resolve(process.cwd(), 'fixtures', 'smoke');
  const outDir = getBenchmarkOutputDir();
  const outPath = path.join(outDir, 'smoke.jsonl');
  await mkdir(outDir, { recursive: true });

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const records: Array<Record<string, unknown>> = [];
  const mark = (phase: string, status: string, extra: Record<string, unknown> = {}) => {
    records.push({
      at: new Date().toISOString(),
      runId,
      suite: 'smoke-fixtures',
      phase,
      status,
      ...extra,
    });
  };

  try {
    mark('run', 'started');
    const discoverStart = performance.now();
    const files = await Promise.all((await walkFiles(fixtureDir)).map(async (filePath) => {
      const info = await stat(filePath);
      return {
        path: path.relative(process.cwd(), filePath),
        bytes: info.size,
        ext: path.extname(filePath).toLowerCase() || '(none)',
      };
    }));
    mark('discover', 'completed', {
      files: files.length,
      wallMs: roundMs(performance.now() - discoverStart),
    });

    const aggregateStart = performance.now();
    const extensionMix = Object.fromEntries(
      [...new Set(files.map((file) => file.ext))].sort().map((ext) => [
        ext,
        files.filter((file) => file.ext === ext).length,
      ]),
    );
    const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
    mark('aggregate', 'completed', {
      bytes,
      extensionMix,
      wallMs: roundMs(performance.now() - aggregateStart),
    });

    const wallMs = roundMs(performance.now() - start);
    const summary = {
      at: startedAt,
      runId,
      suite: 'smoke-fixtures',
      phase: 'summary',
      status: 'completed',
      files: files.length,
      bytes,
      extensionMix,
      wallMs,
      p50Ms: wallMs,
      p95Ms: wallMs,
      cacheHitRate: null,
      provider: getActualExecutionProvider(),
      faceConcurrency: faceSemaphoreSlots,
      previewConcurrency: null,
    };
    mark('run', 'completed', { files: files.length, bytes, wallMs });
    const outputRecords = [...records, summary];
    await writeFile(outPath, outputRecords.map((record) => JSON.stringify(record)).join('\n') + '\n', { encoding: 'utf8', flag: 'a' });
    return { ok: true, outPath, files: files.length, bytes, records: outputRecords.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Smoke benchmark failed.';
    mark('run', 'failed', { error: message, wallMs: roundMs(performance.now() - start) });
    await writeFile(outPath, records.map((record) => JSON.stringify(record)).join('\n') + '\n', { encoding: 'utf8', flag: 'a' });
    return { ok: false, outPath, files: 0, bytes: 0, records: records.length, error: message };
  }
}

async function getDirectoryStats(dirPath: string): Promise<{ files: number; bytes: number; missing?: boolean }> {
  let files = 0;
  let bytes = 0;
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        return;
      }
      if (entry.isFile()) {
        files++;
        const info = await stat(entryPath);
        bytes += info.size;
      }
    }));
  }
  try {
    await walk(dirPath);
  } catch {
    return { files: 0, bytes: 0, missing: true };
  }
  return { files, bytes };
}

async function getModelResourceStatus(): Promise<MacFirstRunDoctor['resources']> {
  const resourcesPath = process.resourcesPath;
  const models = ['version-RFB-640.onnx', 'w600k_mbf.onnx', 'ssd_mobilenet_v1_12.onnx'];
  return {
    resourcesPath,
    onnxRuntimeNode: await stat(path.join(resourcesPath, 'onnxruntime-node', 'dist', 'index.js')).then(() => true).catch(() => false),
    models: await Promise.all(models.map(async (name) => {
      const modelPath = path.join(resourcesPath, 'models', name);
      const info = await stat(modelPath).catch(() => null);
      return { name, exists: !!info, bytes: info?.size };
    })),
  };
}

function makeLedgerId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function persistImportLedger(config: ImportConfig, result: ImportResult): Promise<ImportLedger> {
  const items = result.ledgerItems ?? [];
  const failed = items.filter((item) => item.status === 'failed').length;
  const pending = items.filter((item) => item.status === 'pending').length;
  const id = result.ledgerId || makeLedgerId();
  const ledger: ImportLedger = {
    id,
    createdAt: new Date().toISOString(),
    sourcePath: config.sourcePath,
    destRoot: config.destRoot,
    saveFormat: config.saveFormat,
    totalFiles: items.length,
    imported: result.imported,
    skipped: result.skipped,
    failed,
    pending,
    verified: result.verified,
    checksumVerified: result.checksumVerified,
    totalBytes: result.totalBytes,
    durationMs: result.durationMs,
    items,
  };
  const dir = getLedgersDir();
  await mkdir(dir, { recursive: true });
  const content = JSON.stringify(ledger, null, 2);
  await writeFile(path.join(dir, `${id}.json`), content, { encoding: 'utf8', mode: 0o600 });
  await writeFile(getLatestLedgerPath(), content, { encoding: 'utf8', mode: 0o600 });
  result.ledgerId = id;
  result.recoveryCount = items.filter((item) => item.status === 'failed' || item.status === 'pending').length;
  return ledger;
}

async function readLatestImportLedger(): Promise<ImportLedger | null> {
  try {
    return JSON.parse(await readFile(getLatestLedgerPath(), 'utf8')) as ImportLedger;
  } catch {
    return null;
  }
}

async function writePostImportLightroomHandoff(config: ImportConfig, ledger: ImportLedger): Promise<ImportResult['lightroomHandoff'] | undefined> {
  if (!scannedFiles.length) return undefined;
  return writeLightroomHandoff(scannedFiles, {
    config,
    ledger,
    outputRoot: config.destRoot,
    source: 'post-import',
  });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readCatalogStatsForHealth(): Promise<ImportHealthSummary['catalog']> {
  try {
    return (await getCatalogService()).getStats();
  } catch (error) {
    log.warn('[health] catalog stats unavailable', error);
    return null;
  }
}

async function buildImportHealthSummary(): Promise<ImportHealthSummary> {
  const [settings, latestLedger, catalog] = await Promise.all([
    loadSettings(),
    readLatestImportLedger(),
    readCatalogStatsForHealth(),
  ]);
  const retryableItems = latestLedger?.items.filter((item) => item.status === 'failed' || item.status === 'pending') ?? [];
  const failed = latestLedger?.failed ?? latestLedger?.items.filter((item) => item.status === 'failed').length ?? 0;
  const pending = latestLedger?.pending ?? latestLedger?.items.filter((item) => item.status === 'pending').length ?? 0;
  const imported = latestLedger?.imported ?? 0;
  const lastImportState: ImportHealthSummary['lastImport']['state'] = !latestLedger
    ? 'none'
    : failed > 0 && imported === 0
      ? 'failed'
      : failed + pending > 0
        ? 'attention'
        : 'healthy';

  const checksumVerified = latestLedger?.checksumVerified ?? 0;
  const checksumExpected = latestLedger?.imported ?? 0;
  const checksumAvailable = typeof latestLedger?.checksumVerified === 'number';
  const checksumEnabled = !!settings.verifyChecksums || checksumAvailable;
  const checksumStatus: ImportHealthSummary['checksum']['status'] = !checksumEnabled
    ? 'disabled'
    : !latestLedger
      ? 'unavailable'
      : checksumExpected === 0
        ? 'missing'
        : checksumVerified >= checksumExpected
          ? 'verified'
          : checksumVerified > 0
            ? 'partial'
            : 'missing';

  const backupTargets = latestLedger?.items.filter((item) => item.backupFullPath) ?? [];
  const copiedBackups = backupTargets.filter((item) => item.status === 'imported' || item.status === 'verified').length;
  const failedBackups = backupTargets.filter((item) => item.status === 'failed' && /backup/i.test(item.error ?? '')).length;
  const backupEnabled = !!settings.backupDestRoot || backupTargets.length > 0;
  const backupStatus: ImportHealthSummary['backup']['status'] = !backupEnabled
    ? 'disabled'
    : !latestLedger
      ? 'unavailable'
      : failedBackups > 0
        ? 'attention'
        : backupTargets.length > 0 && copiedBackups < backupTargets.length
          ? 'partial'
          : 'ok';

  const ftpEnabled = !!settings.ftpDestEnabled || !!settings.ftpSync?.enabled;
  const normalizedWatchFolders = normalizeWatchFolders(settings.watchFolders ?? []);
  const watchFolderStatuses = await Promise.all(normalizedWatchFolders.map(async (folder) => {
    const exists = folder.enabled ? await pathExists(folder.path) : false;
    const needsDestination = folder.enabled && folder.autoImport && !(folder.destination || folder.destRoot);
    const status: ImportHealthSummary['watchFolders']['folders'][number]['status'] = !folder.enabled
      ? 'disabled'
      : !exists
        ? 'missing'
        : needsDestination
          ? 'needs-destination'
          : 'ready';
    return {
      id: folder.id,
      label: folder.label,
      path: folder.path,
      enabled: folder.enabled,
      autoScan: folder.autoScan,
      autoImport: folder.autoImport,
      exists,
      status,
      lastTriggeredAt: folder.lastTriggeredAt,
      lastImportedAt: folder.lastImportedAt,
    };
  }));
  const triggeredDates = watchFolderStatuses
    .map((folder) => folder.lastTriggeredAt)
    .filter((value): value is string => !!value)
    .sort();

  return {
    generatedAt: new Date().toISOString(),
    latestLedger,
    lastImport: {
      state: lastImportState,
      createdAt: latestLedger?.createdAt,
      sourcePath: latestLedger?.sourcePath,
      destRoot: latestLedger?.destRoot,
      totalFiles: latestLedger?.totalFiles ?? 0,
      imported,
      skipped: latestLedger?.skipped ?? 0,
      failed,
      pending,
      totalBytes: latestLedger?.totalBytes ?? 0,
      durationMs: latestLedger?.durationMs ?? 0,
    },
    retryableItems,
    checksum: {
      enabled: checksumEnabled,
      status: checksumStatus,
      verified: checksumVerified,
      expected: checksumExpected,
    },
    backup: {
      enabled: backupEnabled,
      status: backupStatus,
      targetRoot: settings.backupDestRoot || undefined,
      copied: copiedBackups,
      failed: failedBackups,
      totalTargets: backupTargets.length,
    },
    ftp: {
      enabled: ftpEnabled,
      status: ftpEnabled ? lastFtpSyncStatus.state : 'disabled',
      stage: lastFtpSyncStatus.stage,
      message: ftpEnabled ? lastFtpSyncStatus.message : 'FTP workflow is disabled.',
      lastRunAt: lastFtpSyncStatus.lastRunAt,
      lastSuccessAt: lastFtpSyncStatus.lastSuccessAt,
      imported: lastFtpSyncStatus.imported,
      skipped: lastFtpSyncStatus.skipped,
      errors: lastFtpSyncStatus.errors,
    },
    catalog,
    watchFolders: {
      total: watchFolderStatuses.length,
      enabled: watchFolderStatuses.filter((folder) => folder.enabled).length,
      active: watchFolderStatuses.filter((folder) => folder.enabled && (folder.autoScan || folder.autoImport)).length,
      autoScan: watchFolderStatuses.filter((folder) => folder.enabled && folder.autoScan).length,
      autoImport: watchFolderStatuses.filter((folder) => folder.enabled && folder.autoImport).length,
      missing: watchFolderStatuses.filter((folder) => folder.status === 'missing').length,
      needsDestination: watchFolderStatuses.filter((folder) => folder.status === 'needs-destination').length,
      lastTriggeredAt: triggeredDates.at(-1),
      folders: watchFolderStatuses,
    },
  };
}

async function applyCatalogScanMemory(sourcePath: string): Promise<void> {
  catalogService ??= openCatalog(path.join(app.getPath('userData'), 'catalog'));
  const db = await catalogService;
  const { duplicateCandidates } = await db.upsertMediaFiles(scannedFiles, sourcePath);
  const byPath = new Map(duplicateCandidates.map((candidate) => [candidate.sourcePath, candidate]));
  for (const file of scannedFiles) {
    const candidate = byPath.get(file.path);
    if (!candidate) continue;
    file.duplicate = true;
    file.duplicateMemory = {
      kind: candidate.importedCount > 0 ? 'previous-import' : 'same-visual',
      matchedPath: candidate.matchedPaths[0] ?? file.path,
      importedAt: candidate.lastImportedAt,
    };
    sendToRenderer(IPC.SCAN_DUPLICATE, file.path);
  }
}

async function recordCatalogImport(config: ImportConfig, result: ImportResult): Promise<void> {
  if (!result.ledgerId || !result.ledgerItems?.length) return;
  catalogService ??= openCatalog(path.join(app.getPath('userData'), 'catalog'));
  const db = await catalogService;
  await db.recordImportLedgerItems(result.ledgerId, result.ledgerItems, { sessionId: config.sourcePath });
}

async function persistAppSession(session: AppSession): Promise<AppSession> {
  const dir = getSessionsDir();
  await mkdir(dir, { recursive: true });
  const content = JSON.stringify(session, null, 2);
  await writeFile(path.join(dir, `${session.id}.json`), content, { encoding: 'utf8', mode: 0o600 });
  await writeFile(getLatestSessionPath(), content, { encoding: 'utf8', mode: 0o600 });
  await saveSettings({ lastSessionId: session.id });
  return session;
}

async function readLatestAppSession(): Promise<AppSession | null> {
  try {
    return JSON.parse(await readFile(getLatestSessionPath(), 'utf8')) as AppSession;
  } catch {
    return null;
  }
}

async function readSettingsData(): Promise<string> {
  const currentPath = getSettingsPath();
  try {
    return await readFile(currentPath, 'utf-8');
  } catch (currentError) {
    const legacyPath = getLegacySettingsPath();
    if (legacyPath !== currentPath) {
      try {
        return await readFile(legacyPath, 'utf-8');
      } catch {
        // Fall through to the original error so first-run behavior stays the same.
      }
    }
    throw currentError;
  }
}

const DEFAULT_SETTINGS: AppSettings = {
  lastDestination: '',
  skipDuplicates: true,
  saveFormat: 'original',
  jpegQuality: 90,
  folderPreset: 'date-flat',
  customPattern: '{YYYY}-{MM}-{DD}/{filename}',
  theme: 'dark',
  separateProtected: false,
  protectedFolderName: '_Protected',
  backupDestRoot: '',
  ftpConfig: {
    host: '',
    port: 21,
    user: '',
    password: '',
    secure: false,
    remotePath: '/DCIM',
  },
  ftpDestEnabled: false,
  ftpDestConfig: {
    host: '',
    port: 21,
    user: '',
    password: '',
    secure: false,
    remotePath: '/Keptra',
  },
  ftpSync: {
    enabled: false,
    runOnLaunch: true,
    intervalMinutes: 15,
    localDestRoot: '',
    reuploadToFtpDest: false,
  },
  autoEject: false,
  playSoundOnComplete: false,
  completeSoundPath: '',
  openFolderOnComplete: false,
  verifyChecksums: false,
  sourceProfile: 'auto',
  watchFolders: [],
  lastSessionId: '',
  defaultConflictPolicy: 'skip',
  conflictFolderName: '_Conflicts',
  autoImport: false,
  autoImportDestRoot: '',
  autoImportPromptSeen: false,
  burstGrouping: true,
  burstWindowSec: 2,
  normalizeExposure: false,
  exposureMaxStops: 2,
  exposureAdjustmentStep: 0.33,
  whiteBalanceTemperature: 0,
  whiteBalanceTint: 0,
  eventMode: 'general',
  cullConfidence: 'balanced',
  groupPhotoEveryoneGood: false,
  keeperQuota: 'best-1',
  metadataKeywords: '',
  metadataTitle: '',
  metadataCaption: '',
  metadataCreator: '',
  metadataCopyright: '',
  watermarkEnabled: false,
  watermarkMode: 'text',
  watermarkText: '',
  watermarkImagePath: '',
  watermarkOpacity: 0.3,
  watermarkPositionLandscape: 'bottom-right',
  watermarkPositionPortrait: 'bottom-right',
  watermarkScale: 0.045,
  autoStraighten: true,
  // Performance optimizations
  gpuFaceAcceleration: true,    // Enable GPU by default if available
  gpuDeviceId: -1,              // -1 = DirectML default adapter
  gpuStressStreams: 8,
  rawPreviewCache: true,        // Cache RAW previews by default
  cpuOptimization: false,       // Disabled by default (only enable for older CPUs)
  rawPreviewQuality: 70,        // 70% JPEG quality for RAW previews
  jobPresets: [],
  selectionSets: [],
  licenseKey: '',
  licenseActivationCode: '',
  licenseStatus: { valid: false, message: 'No license activated.' },
  perfTier: 'auto',
  performancePromptSeenVersion: '',
  fastKeeperMode: false,
  previewConcurrency: 2,
  faceConcurrency: 2,
  viewOverlayPreferences: { ...DEFAULT_VIEW_OVERLAY_PREFERENCES },
};

// ---------------------------------------------------------------------------
// Face analysis semaphore — module-level so loadSettings can initialise it
// ---------------------------------------------------------------------------
let faceSemaphoreSlots = 1;
let faceSemaphoreQueue: Array<() => void> = [];
let faceActiveCount = 0;

// Incremented on every SCAN_START so in-flight semaphore waiters from the
// previous source can detect they've been superseded and bail out early.
let faceQueueGeneration = 0;

/** Call on SCAN_START to immediately drain all queued (not yet running) face jobs. */
function cancelPendingFaceJobs(): void {
  faceQueueGeneration++;
  // Drain the queue — each resolve() unblocks the awaiting acquireFaceSemaphore()
  // call; the generation check inside will then throw STALE_FACE_JOB.
  const drained = faceSemaphoreQueue.splice(0);
  for (const resolve of drained) resolve();
}

const STALE_FACE_JOB = 'stale-face-job';

function setFaceConcurrency(n: number): void {
  faceSemaphoreSlots = Math.max(1, Math.min(32, Math.round(n)));
  configureFaceThroughput(faceSemaphoreSlots);
  while (faceActiveCount < faceSemaphoreSlots && faceSemaphoreQueue.length > 0) {
    faceActiveCount++;
    faceSemaphoreQueue.shift()?.();
  }
}

async function acquireFaceSemaphore(gen: number): Promise<void> {
  // Check generation before acquiring any slot — stale jobs should never
  // consume a semaphore slot, so check first and throw without incrementing.
  if (gen !== faceQueueGeneration) throw new Error(STALE_FACE_JOB);
  if (faceActiveCount < faceSemaphoreSlots) {
    faceActiveCount++;
    return;
  }
  // Wait to be woken by releaseFaceSemaphore. The release already increments
  // faceActiveCount on our behalf before calling resolve() — do NOT increment
  // again here, or the count leaks above slots and the queue deadlocks.
  await new Promise<void>((resolve) => faceSemaphoreQueue.push(resolve));
  // Check generation AFTER waking. If a new scan started while we waited,
  // release the slot that was pre-claimed for us and throw so the caller bails.
  if (gen !== faceQueueGeneration) {
    faceActiveCount--;
    // Wake the next waiter if one is queued (we're giving the slot back).
    if (faceSemaphoreQueue.length > 0 && faceActiveCount < faceSemaphoreSlots) {
      faceActiveCount++;
      faceSemaphoreQueue.shift()?.();
    }
    throw new Error(STALE_FACE_JOB);
  }
}

function releaseFaceSemaphore(): void {
  faceActiveCount--;
  if (faceSemaphoreQueue.length > 0 && faceActiveCount < faceSemaphoreSlots) {
    // Pre-claim the slot for the next waiter before waking it, so the waiter
    // does not need to increment faceActiveCount itself.
    faceActiveCount++;
    faceSemaphoreQueue.shift()?.();
  }
}

async function listWindowsGpus(): Promise<Array<{ id: number; name: string; adapterCompatibility?: string; videoMemoryMB?: number }>> {
  if (process.platform !== 'win32') return [];
  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    'Get-CimInstance Win32_VideoController | ForEach-Object -Begin {$i=0} -Process {',
    '  [PSCustomObject]@{ id=$i; name=$_.Name; adapterCompatibility=$_.AdapterCompatibility; videoMemoryMB=[math]::Round(($_.AdapterRAM / 1MB),0) }',
    '  $i++',
    '} | ConvertTo-Json -Compress',
  ].join('; ');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: 8000, windowsHide: true },
  );
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list
    .map((item, index) => {
      const record = item as Record<string, unknown>;
      return {
        id: Number(record.id ?? index),
        name: String(record.name ?? `GPU ${index}`),
        adapterCompatibility: typeof record.adapterCompatibility === 'string' ? record.adapterCompatibility : undefined,
        videoMemoryMB: typeof record.videoMemoryMB === 'number' ? record.videoMemoryMB : undefined,
      };
    })
    .filter((gpu) => Number.isFinite(gpu.id) && gpu.name.trim().length > 0);
}

async function loadSettings(): Promise<AppSettings> {
  try {
    const data = await readSettingsData();
    const parsed = JSON.parse(data) as Partial<AppSettings>;
    const merged = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      watchFolders: normalizeWatchFolders(parsed.watchFolders),
      viewOverlayPreferences: {
        ...DEFAULT_VIEW_OVERLAY_PREFERENCES,
        ...(isRecord(parsed.viewOverlayPreferences) ? parsed.viewOverlayPreferences : {}),
      },
    };
    const storedActivationCode = merged.licenseActivationCode?.trim();
    const licenseStatus = merged.licenseKey
      ? {
          ...validateLicenseKey(merged.licenseKey),
          activationCode: storedActivationCode || undefined,
          activatedAt: merged.licenseStatus?.activatedAt,
          expiresAt: merged.licenseStatus?.expiresAt,
          entitlement: merged.licenseStatus?.entitlement,
        }
      : { valid: false, message: 'No license activated.', status: 'unknown' as const };
    
    const profile = detectDeviceTier(
      merged.perfTier && merged.perfTier !== 'auto' ? merged.perfTier : undefined
    );
    const resolvedFaceConcurrency =
      (!merged.perfTier || merged.perfTier === 'auto') && (merged.faceConcurrency ?? 0) <= 1
        ? profile.faceConcurrency
        : merged.faceConcurrency ?? profile.faceConcurrency;

    // Apply performance settings immediately
    configureGpuAcceleration(merged.gpuFaceAcceleration ?? true);
    configureGpuDevice(merged.gpuDeviceId);
    configureCpuOptimization(merged.cpuOptimization ?? false);
    setRawPreviewQuality(merged.rawPreviewQuality ?? 70);
    setFaceConcurrency(resolvedFaceConcurrency);

    // Apply device-tier presets on first load (overridden by explicit user settings)
    applyDeviceTier(profile, {
      setCpuOptimization: configureCpuOptimization,
      setRawPreviewQuality,
    }, {
      cpuOptimization: merged.cpuOptimization,
      rawPreviewQuality: merged.rawPreviewQuality,
    });

    return { ...merged, faceConcurrency: resolvedFaceConcurrency, licenseStatus };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

let settingsSaveQueue: Promise<void> = Promise.resolve();

async function writeSettingsFile(settings: AppSettings): Promise<void> {
  const settingsPath = getSettingsPath();
  const dir = path.dirname(settingsPath);
  await mkdir(dir, { recursive: true });
  const tempPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(tempPath, settingsPath);
  await chmod(settingsPath, 0o600).catch(() => undefined);
}

async function saveSettings(settings: Partial<AppSettings>): Promise<void> {
  const write = async (): Promise<void> => {
  const current = await loadSettings();
  const merged: AppSettings = {
    ...current,
    ...settings,
    watchFolders: settings.watchFolders != null ? normalizeWatchFolders(settings.watchFolders) : current.watchFolders,
    licenseStatus: settings.licenseStatus ?? current.licenseStatus,
  };
  await writeSettingsFile(merged);
  
  // Reapply settings to running services
  configureGpuAcceleration(merged.gpuFaceAcceleration ?? true);
  configureGpuDevice(merged.gpuDeviceId);
  configureCpuOptimization(merged.cpuOptimization ?? false);
  setRawPreviewQuality(merged.rawPreviewQuality ?? 70);
  setFaceConcurrency(merged.faceConcurrency ?? 1);
  watchFolderManager?.update(merged.watchFolders ?? []);
  };

  const nextSave = settingsSaveQueue.then(write, write);
  settingsSaveQueue = nextSave.catch(() => undefined);
  return nextSave;
}

function publishFtpSyncStatus(status: FtpSyncStatus): FtpSyncStatus {
  lastFtpSyncStatus = status;
  sendToRenderer(IPC.FTP_SYNC_STATUS, status);
  return status;
}

function clearFtpSyncTimer(): void {
  if (ftpSyncTimer) {
    clearTimeout(ftpSyncTimer);
    ftpSyncTimer = null;
  }
}

async function scheduleFtpSync(settings?: AppSettings): Promise<void> {
  clearFtpSyncTimer();
  const resolved = settings ?? await loadSettings();
  if (!resolved.ftpSync?.enabled) return;
  const intervalMinutes = Math.max(5, resolved.ftpSync.intervalMinutes || 15);
  ftpSyncTimer = setTimeout(() => {
    void runAutomatedFtpSync('interval');
  }, intervalMinutes * 60 * 1000);
}

async function runAutomatedFtpSync(trigger: 'manual' | 'launch' | 'interval'): Promise<FtpSyncStatus> {
  if (ftpSyncRunning) {
    return publishFtpSyncStatus({
      ...lastFtpSyncStatus,
      message: 'FTP sync is already running.',
    });
  }

  const settings = await loadSettings();
  const sync = settings.ftpSync;
  if (!sync) {
    return publishFtpSyncStatus({
      state: 'error',
      stage: 'idle',
      trigger,
      message: 'FTP sync settings are missing.',
      lastRunAt: new Date().toISOString(),
    });
  }

  if (!settings.ftpConfig.host || !settings.ftpConfig.remotePath) {
    return publishFtpSyncStatus({
      state: 'error',
      stage: 'probing',
      trigger,
      message: 'FTP source needs a host and remote path.',
      lastRunAt: new Date().toISOString(),
    });
  }

  if (!sync.localDestRoot) {
    return publishFtpSyncStatus({
      state: 'error',
      stage: 'idle',
      trigger,
      message: 'Choose a local destination for automated FTP sync.',
      lastRunAt: new Date().toISOString(),
    });
  }

  const licenseStatus = await getLicenseStatus();
  if (!licenseStatus.valid) {
    return publishFtpSyncStatus({
      state: 'error',
      stage: 'idle',
      trigger,
      message: licenseStatus.message || 'A valid license is required for automated FTP sync.',
      lastRunAt: new Date().toISOString(),
    });
  }

  ftpSyncRunning = true;
  ftpSyncAbort?.abort();
  ftpSyncAbort = new AbortController();
  const startedAt = new Date().toISOString();
  const publish = (status: Omit<FtpSyncStatus, 'trigger' | 'startedAt' | 'lastRunAt'>) =>
    publishFtpSyncStatus({
      trigger,
      startedAt,
      lastRunAt: startedAt,
      ...status,
    });

  try {
    publish({
      state: 'running',
      stage: 'probing',
      message: 'Checking FTP source...',
    });

    const stagingDir = await mirrorFtp(
      settings.ftpConfig,
      (done, total, name) => {
        publish({
          state: 'running',
          stage: 'mirroring',
          message: total > 0 ? `Mirroring ${done}/${total} files...` : 'Mirroring FTP source...',
          done,
          total,
          currentFile: name,
        });
      },
      ftpSyncAbort.signal,
    );

    publish({
      state: 'running',
      stage: 'scanning',
      message: 'Indexing mirrored files...',
    });

    const scanned: MediaFile[] = [];
    const pattern = settings.folderPreset === 'custom' ? settings.customPattern : undefined;
    await scanFiles(
      stagingDir,
      (batch) => {
        scanned.push(...batch);
      },
      () => undefined,
      pattern,
      { generateThumbnails: false },
    );

    const importConfig: ImportConfig = {
      sourcePath: stagingDir,
      destRoot: sync.localDestRoot,
      skipDuplicates: settings.skipDuplicates,
      saveFormat: settings.saveFormat,
      jpegQuality: settings.jpegQuality,
      conflictPolicy: settings.defaultConflictPolicy,
      conflictFolderName: settings.conflictFolderName,
      separateProtected: settings.separateProtected,
      protectedFolderName: settings.protectedFolderName,
      backupDestRoot: settings.backupDestRoot || undefined,
      ftpDestEnabled: sync.reuploadToFtpDest && settings.ftpDestEnabled,
      ftpDestConfig: sync.reuploadToFtpDest ? settings.ftpDestConfig : undefined,
      verifyChecksums: settings.verifyChecksums,
      normalizeExposure: settings.normalizeExposure,
      exposureMaxStops: settings.exposureMaxStops,
      metadata: buildImportMetadata(settings),
      metadataExportFlags: settings.metadataExport,
      watermark: buildWatermarkConfig(settings),
      autoStraighten: settings.autoStraighten,
    };

    const filesToImport = filterFilesForImport(scanned, importConfig);
    if (filesToImport.length === 0) {
      return publish({
        state: 'success',
        stage: 'complete',
        message: 'FTP sync checked for changes. No new files were needed.',
        total: scanned.length,
        imported: 0,
        skipped: 0,
        errors: 0,
        lastSuccessAt: new Date().toISOString(),
      });
    }

    const result = await importFiles(filesToImport, importConfig, (progress) => {
      publish({
        state: 'running',
        stage: 'importing',
        message: `Importing ${progress.currentIndex}/${progress.totalFiles} files...`,
        done: progress.currentIndex,
        total: progress.totalFiles,
        currentFile: progress.currentFile,
        skipped: progress.skipped,
        errors: progress.errors,
      });
    });

    return publish({
      state: result.errors.length > 0 ? 'error' : 'success',
      stage: 'complete',
      message: result.errors.length > 0
        ? `FTP sync finished with ${result.errors.length} issue${result.errors.length === 1 ? '' : 's'}.`
        : `FTP sync finished. Imported ${result.imported} file${result.imported === 1 ? '' : 's'}.`,
      imported: result.imported,
      skipped: result.skipped,
      errors: result.errors.length,
      total: filesToImport.length,
      lastSuccessAt: result.errors.length > 0 ? lastFtpSyncStatus.lastSuccessAt : new Date().toISOString(),
    });
  } catch (err) {
    return publish({
      state: 'error',
      stage: 'complete',
      message: err instanceof Error ? err.message : 'FTP sync failed.',
    });
  } finally {
    ftpSyncRunning = false;
    ftpSyncAbort = null;
    await scheduleFtpSync(settings).catch(() => undefined);
  }
}

async function getLicenseStatus() {
  const settings = await loadSettings();
  const storedActivationCode = settings.licenseActivationCode?.trim();
  const storedKey = settings.licenseKey?.trim();
  if (!storedActivationCode && !storedKey) {
    return settings.licenseStatus ?? { valid: false, message: 'No license activated.', status: 'unknown' as const };
  }

  let status = storedActivationCode
    ? await activateLicenseInput(storedActivationCode)
    : await checkHostedLicenseStatus(storedKey!, settings.licenseStatus ?? undefined);
  if (!status.valid && status.status === 'unknown' && storedKey) {
    status = await checkHostedLicenseStatus(storedKey, settings.licenseStatus ?? undefined);
  }

  await saveSettings({
    licenseKey: status.key?.trim() || storedKey || '',
    licenseActivationCode: status.activationCode?.trim() || storedActivationCode || '',
    licenseStatus: status,
  });
  return status;
}

async function getStoredLicenseKey() {
  const status = await getLicenseStatus();
  return status.valid ? status.key?.trim() || undefined : undefined;
}

async function buildDiagnosticsSnapshot(): Promise<AppDiagnosticsSnapshot> {
  const [settings, cachedUpdate] = await Promise.all([
    loadSettings().catch(() => null),
    readLastKnownGoodUpdateMetadata().catch(() => null),
  ]);
  const license = settings?.licenseStatus;
  const update = lastUpdateState;
  return {
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    userDataPath: app.getPath('userData'),
    settingsPath: getSettingsPath(),
    legacySettingsPath: getLegacySettingsPath(),
    updateMetadataPath: getUpdateMetadataPath(),
    updatesCachePath: getUpdatesCachePath(),
    license: {
      valid: !!license?.valid,
      status: license?.status,
      message: license?.message,
      hasStoredKey: !!settings?.licenseKey?.trim(),
      hasActivationCode: !!settings?.licenseActivationCode?.trim(),
      activationCode: settings?.licenseActivationCode?.trim() || license?.activationCode,
    },
    update: {
      status: update?.status ?? 'unknown',
      currentVersion: update?.currentVersion ?? app.getVersion(),
      latestVersion: update?.latestVersion,
      lastCheckedAt: update?.lastCheckedAt,
      message: update?.message,
      releaseUrl: update?.releaseUrl,
      downloadUrl: update?.downloadUrl,
      feedUrl: update?.feedUrl,
      cachedLatestVersion: cachedUpdate?.latestVersion,
      cachedAt: cachedUpdate?.savedAt,
    },
    endpoints: UPDATE_DIAGNOSTIC_ENDPOINTS,
  };
}

function userSafeUpdateMessage(message?: string): string {
  const text = String(message || '').trim();
  const lower = text.toLowerCase();
  if (
    lower.includes('err_ssl_protocol_error') ||
    lower.includes('ssl') ||
    lower.includes('tls') ||
    lower.includes('cert')
  ) {
    return 'Keptra could not make a secure update connection. This is usually temporary; use Repair updates or try again shortly.';
  }
  if (lower.includes('fetch failed') || lower.includes('network') || lower.includes('timeout') || lower.includes('aborted')) {
    return 'Keptra could not reach the update service. Check your connection, then try again.';
  }
  if (lower.includes('json') || lower.includes('metadata')) {
    return 'The update service answered with unexpected metadata. Keptra will keep using the last trusted update information if available.';
  }
  return text || 'Keptra could not check for updates. Try again in a moment.';
}

async function repairUpdates(): Promise<UpdateRepairResult> {
  const cleared: string[] = [];
  const metadataPath = getUpdateMetadataPath();
  const cachePath = getUpdatesCachePath();
  await rm(metadataPath, { force: true }).then(() => cleared.push(metadataPath)).catch(() => undefined);
  await rm(cachePath, { force: true, recursive: true }).then(() => cleared.push(cachePath)).catch(() => undefined);
  downloadedInstallerPath = null;
  downloadedInstallerVersion = null;
  downloadedUpdateKind = null;
  const updateState = await refreshUpdateState();
  const diagnostics = await buildDiagnosticsSnapshot();
  return {
    ok: updateState.status !== 'error',
    cleared,
    updateState,
    diagnostics,
    message: updateState.status === 'error'
      ? userSafeUpdateMessage(updateState.message)
      : 'Update cache repaired and Keptra checked the update service again.',
  };
}

async function refreshUpdateState() {
  sendToRenderer(IPC.UPDATE_STATUS, {
    status: 'checking',
    currentVersion: app.getVersion(),
    lastCheckedAt: new Date().toISOString(),
  } satisfies UpdateState);

  const licenseKey = await getStoredLicenseKey();
  const update = await checkForUpdate(licenseKey);
  const history = update.status !== 'error'
    ? await fetchUpdateHistory(licenseKey).catch(() => [])
    : [];
  lastUpdateState = {
    ...update,
    history,
    installMode: process.platform === 'darwin' ? 'manual-dmg' : update.downloadUrl ? 'installer' : canUseNativeUpdater() ? 'native' : undefined,
  };
  if (update.status === 'error') {
    const fallback = await readLastKnownGoodUpdateMetadata();
    if (fallback) {
      lastUpdateState = {
        ...lastUpdateState,
        latestVersion: fallback.latestVersion,
        releaseName: fallback.releaseName,
        releaseDate: fallback.releaseDate,
        releaseUrl: fallback.releaseUrl,
        downloadUrl: fallback.downloadUrl,
        feedUrl: fallback.feedUrl,
        installMode: process.platform === 'darwin' ? 'manual-dmg' : fallback.downloadUrl ? 'installer' : canUseNativeUpdater() ? 'native' : undefined,
        message: `${update.message ?? 'Update check failed.'} Using last known update metadata from ${fallback.savedAt}.`,
      };
      logUpdateDiagnostic('fallback-last-known-good', { fallbackVersion: fallback.latestVersion, savedAt: fallback.savedAt });
    }
  }
  if (lastUpdateState.status === 'error') {
    lastUpdateState = {
      ...lastUpdateState,
      message: userSafeUpdateMessage(lastUpdateState.message),
    };
  }
  sendToRenderer(IPC.UPDATE_STATUS, lastUpdateState);
  return lastUpdateState;
}

function canUseNativeUpdater() {
  return process.platform === 'win32' && app.isPackaged;
}

function ensureAutoUpdaterConfigured(feedUrl?: string) {
  if (!feedUrl || !canUseNativeUpdater()) return;
  if (!isAllowlistedUpdateUrl(feedUrl)) {
    throw new Error('Feed URL failed allowlist trust checks.');
  }

  if (!autoUpdaterReady) {
    const updater = autoUpdater as unknown as {
      on: (event: string, listener: (...args: any[]) => void) => void;
      setFeedURL: (options: { url: string }) => void;
      checkForUpdates: () => void;
      quitAndInstall: () => void;
    };

    updater.on('error', (_event, error) => {
      lastUpdateState = {
        ...(lastUpdateState ?? { currentVersion: app.getVersion() }),
        status: 'error',
        message: error?.message || 'Could not download the update.',
      };
      sendToRenderer(IPC.UPDATE_STATUS, lastUpdateState);
    });

    updater.on('update-available', () => {
      lastUpdateState = {
        ...(lastUpdateState ?? { currentVersion: app.getVersion() }),
        status: 'downloading',
        message: 'Downloading the latest update...',
      };
      sendToRenderer(IPC.UPDATE_STATUS, lastUpdateState);
    });

    updater.on('update-not-available', () => {
      lastUpdateState = {
        ...(lastUpdateState ?? { currentVersion: app.getVersion() }),
        status: 'up-to-date',
        latestVersion: lastUpdateState?.latestVersion ?? app.getVersion(),
        message: 'You already have the latest version.',
      };
      sendToRenderer(IPC.UPDATE_STATUS, lastUpdateState);
    });

    updater.on('update-downloaded', (_event, releaseNotes, releaseName) => {
      lastUpdateState = {
        ...(lastUpdateState ?? { currentVersion: app.getVersion() }),
        status: 'ready',
        releaseName: releaseName || lastUpdateState?.releaseName,
        releaseNotes: releaseNotes || lastUpdateState?.releaseNotes,
        message: 'Update ready. Restart the app to install it.',
      };
      sendToRenderer(IPC.UPDATE_STATUS, lastUpdateState);
    });

    autoUpdaterReady = true;
  }

  if (configuredFeedUrl !== feedUrl) {
    (autoUpdater as unknown as { setFeedURL: (options: { url: string }) => void }).setFeedURL({ url: feedUrl });
    configuredFeedUrl = feedUrl;
  }
}

function sendToRenderer(channel: string, ...args: unknown[]): void {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send(channel, ...args);
  }
}

function sanitizeDownloadName(value: string) {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-').trim() || 'Keptra-Update';
}

function installerExtensionForPlatform(downloadUrl: string) {
  const ext = path.extname(new URL(downloadUrl).pathname || '').toLowerCase();
  if (ext) return ext;
  if (process.platform === 'darwin') return '.dmg';
  if (process.platform === 'win32') return '.exe';
  return '.zip';
}

function parseContentDispositionFilename(header: string | null) {
  if (!header) return null;
  const utfMatch = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utfMatch?.[1]) return decodeURIComponent(utfMatch[1].trim().replace(/^"|"$/g, ''));
  const plainMatch = header.match(/filename\s*=\s*("?)([^";]+)\1/i);
  if (plainMatch?.[2]) return plainMatch[2].trim();
  return null;
}

async function downloadInstallerAsset(downloadUrl: string, versionLabel: string) {
  // Follow redirects manually so every hop stays inside the update allowlist.
  let fileNameFromHeader: string | null = null;
  let currentUrl = downloadUrl;
  let response: Response | null = null;

  for (let hop = 0; hop < 5; hop += 1) {
    if (!isAllowlistedUpdateUrl(currentUrl)) {
      throw new Error('Update download redirect failed trust checks.');
    }
    response = await fetch(currentUrl, { redirect: 'manual' });
    fileNameFromHeader ??= parseContentDispositionFilename(response.headers.get('content-disposition'));

    if (response.status >= 300 && response.status < 400) {
      const nextUrl = resolveRedirectUrl(currentUrl, response.headers.get('location'));
      if (!nextUrl || !isAllowlistedUpdateUrl(nextUrl)) {
        throw new Error('Update download redirect failed trust checks.');
      }
      currentUrl = nextUrl;
      continue;
    }

    break;
  }

  if (!response || response.status >= 300 && response.status < 400) {
    throw new Error('Update download redirected too many times.');
  }
  if (!response.ok || !response.body) {
    throw new Error(`Download failed with status ${response.status}`);
  }

  const updatesDir = path.join(app.getPath('userData'), 'updates');
  await mkdir(updatesDir, { recursive: true });

  if (!fileNameFromHeader) {
    fileNameFromHeader = parseContentDispositionFilename(response.headers.get('content-disposition'));
  }
  const fallbackName = `Keptra-${versionLabel}${installerExtensionForPlatform(currentUrl)}`;
  const fileName = sanitizeDownloadName(fileNameFromHeader || path.basename(new URL(currentUrl).pathname) || fallbackName);
  const targetPath = path.join(updatesDir, fileName);
  const tempPath = `${targetPath}.partial`;
  const totalBytes = Number(response.headers.get('content-length') || 0);

  await rm(tempPath, { force: true });

  const file = await open(tempPath, 'w');
  let writtenBytes = 0;

  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      await file.write(value);
      writtenBytes += value.byteLength;

      const progress = totalBytes > 0 ? Math.min(99, Math.round((writtenBytes / totalBytes) * 100)) : null;
      sendToRenderer(IPC.UPDATE_STATUS, {
        ...(lastUpdateState ?? { currentVersion: app.getVersion() }),
        status: 'downloading',
        message: progress == null
          ? 'Downloading installer inside Keptra...'
          : `Downloading installer inside Keptra... ${progress}%`,
      } satisfies UpdateState);
    }
  } catch (error) {
    await file.close();
    await rm(tempPath, { force: true });
    throw error;
  }

  await file.close();
  await rm(targetPath, { force: true });
  await rename(tempPath, targetPath);
  return targetPath;
}

async function launchDownloadedInstaller(installerPath: string) {
  if (process.platform === 'win32') {
    const child = spawn(installerPath, [], {
      detached: true,
      windowsHide: false,
    });
    child.unref();
    app.quit();
    return;
  }

  const openResult = await shell.openPath(installerPath);
  if (openResult) {
    throw new Error(openResult);
  }
}

// Attempt to eject the given volume. Best-effort — returns ok=false if the
// platform tool doesn't know about the path, or if the volume is busy.
async function ejectVolume(volumePath: string): Promise<{ ok: boolean; error?: string }> {
  try {
    if (process.platform === 'darwin') {
      await execFileAsync('diskutil', ['eject', volumePath], { timeout: 15000 });
      return { ok: true };
    }
    if (process.platform === 'win32') {
      // PowerShell via Shell.Application verb — works on most removable drives.
      const parsed = path.parse(path.resolve(volumePath));
      const drive = parsed.root || volumePath;
      const script = `
        $sa = New-Object -comObject Shell.Application
        $drv = $sa.Namespace(17).ParseName('${drive.replace(/'/g, "''")}')
        if ($drv) { $drv.InvokeVerb('Eject') } else { throw 'Drive not found' }
      `.trim();
      await execFileAsync('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { timeout: 15000, windowsHide: true });
      return { ok: true };
    }
    // Linux
    await execFileAsync('umount', [volumePath], { timeout: 15000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Eject failed' };
  }
}

async function getFreeSpace(dirPath: string): Promise<number | null> {
  if (typeof dirPath !== 'string' || dirPath.trim().length === 0) return null;
  try {
    const stats = await statfs(dirPath);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

function isSafeHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    if (url.username || url.password) return false;
    return [
      'keptra.z2hs.au',
      'updates.keptra.z2hs.au',
      'admin.keptra.z2hs.au',
      'github.com',
      'checkout.stripe.com',
    ].includes(url.hostname);
  } catch {
    return false;
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function contactSheetHtml(files: MediaFile[]): string {
  const cards = files.slice(0, 500).map((f) => {
    const stars = f.rating ? '★'.repeat(Math.min(5, f.rating)) : '';
    const badge = f.isProtected ? 'Protected' : (f.pick === 'selected' ? 'Picked' : '');
    return `
      <article>
        ${f.thumbnail ? `<img src="${escapeHtml(f.thumbnail)}" />` : '<div class="empty">No preview</div>'}
        <strong>${escapeHtml(f.name)}</strong>
        <span>${escapeHtml([stars, badge, f.dateTaken?.slice(0, 10)].filter(Boolean).join(' · '))}</span>
      </article>
    `;
  }).join('');
  return `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          body { margin: 24px; font: 10px system-ui, sans-serif; color: #111; }
          h1 { font-size: 18px; margin: 0 0 14px; }
          main { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
          article { break-inside: avoid; border: 1px solid #ddd; padding: 7px; }
          img, .empty { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; background: #eee; display: flex; align-items: center; justify-content: center; }
          strong { display: block; margin-top: 5px; overflow-wrap: anywhere; }
          span { color: #555; }
        </style>
      </head>
      <body>
        <h1>Import contact sheet · ${files.length} files</h1>
        <main>${cards}</main>
      </body>
    </html>`;
}

async function contactSheetFiles(files: MediaFile[]): Promise<MediaFile[]> {
  const sheetFiles = files.slice(0, 500);
  const hydrated: MediaFile[] = [];
  for (const file of sheetFiles) {
    if (file.thumbnail || file.type !== 'photo') {
      hydrated.push(file);
      continue;
    }
    try {
      hydrated.push({ ...file, thumbnail: await generatePreview(file.path) });
    } catch {
      hydrated.push(file);
    }
  }
  return hydrated;
}

export function registerIpcHandlers(): void {
  // Composition root: domain modules are registered here.
  registerSettingsHandlers();
  registerScanHandlers();
  registerImportHandlers();
  registerUpdateHandlers();
  registerFtpHandlers();
  registerLicenseHandlers();
  registerFaceHandlers();
  watchFolderManager ??= new WatchFolderManager((trigger: WatchFolderTrigger) => {
    log.info('[watch-folder]', {
      id: trigger.folder.id,
      path: trigger.folder.path,
      eventType: trigger.eventType,
      filename: trigger.filename,
      autoImport: trigger.folder.autoImport,
    });
    sendToRenderer(IPC.WATCH_FOLDER_TRIGGERED, trigger);
    void (async () => {
      const settings = await loadSettings();
      const triggeredAt = trigger.triggeredAt;
      const watchFolders = normalizeWatchFolders(settings.watchFolders ?? []).map((folder) =>
        folder.id === trigger.folder.id
          ? { ...folder, lastTriggeredAt: triggeredAt, updatedAt: triggeredAt }
          : folder,
      );
      await saveSettings({ watchFolders });
      const watchDestRoot = trigger.folder.destination || trigger.folder.destRoot || '';
      if (!trigger.folder.autoImport || !watchDestRoot || !settings.licenseStatus?.valid) return;
      queueAutoImport({
        name: trigger.folder.label ?? path.basename(trigger.folder.path),
        path: trigger.folder.path,
        isRemovable: false,
        isExternal: true,
        hasDcim: true,
      }, {
        destRoot: watchDestRoot,
        requireGlobalAutoImport: false,
        autoEject: false,
      });
    })().catch((error) => log.warn('[watch-folder] trigger failed', error));
  });
  // Volumes
  handleIpc(IPC.VOLUMES_LIST, async () => {
    return listVolumes();
  });

  // Watch for mounts. On volume change, diff against the known set to find
  // "new" volumes — a freshly inserted card — and route through the auto-
  // import pipeline when the setting is enabled.
  startWatching((volumes) => {
    sendToRenderer(IPC.VOLUMES_CHANGED, volumes);

    const currentPaths = new Set(volumes.map((v) => v.path));
    const newlyInserted = volumes.filter((v) => !knownVolumePaths.has(v.path));
    knownVolumePaths = currentPaths;

    for (const vol of newlyInserted) {
      // Only auto-act on actual camera cards (DCIM present).
      if (!vol.hasDcim) continue;
      sendToRenderer(IPC.DEVICE_INSERTED, vol);
      queueAutoImport(vol);
    }
  });

  // Seed the "known volumes" set so the first listing on app launch doesn't
  // fire a flood of "new device" events for already-mounted drives.
  void Promise.resolve(listVolumes()).then((vols) => {
    if (Array.isArray(vols)) {
      knownVolumePaths = new Set(vols.map((v) => v.path));
    }
  }).catch(() => {
    knownVolumePaths = new Set();
  });

  void loadSettings().then((settings) => {
    watchFolderManager?.update(settings.watchFolders ?? []);
    void scheduleFtpSync(settings);
    if (settings.ftpSync?.enabled && settings.ftpSync.runOnLaunch) {
      setTimeout(() => {
        void runAutomatedFtpSync('launch');
      }, 2500);
    }
  }).catch(() => undefined);

  app.on('before-quit', () => {
    stopWatching();
    watchFolderManager?.stop();
    clearFtpSyncTimer();
    ftpSyncAbort?.abort();
  });

  // Scanning
  handleIpc(IPC.SCAN_START, async (_event, sourcePath: string, folderPattern?: string) => {
    console.log(`[scan] Starting scan of: ${sourcePath}`);
    scannedFiles = [];
    scannedFilesByPath = new Map();
    clearImageDecodeCache(); // flush stale RAW decodes from previous source
    cancelPendingFaceJobs(); // drain queued face jobs from old source so they don't compete with new scan
    try {
      const total = await scanFiles(
        sourcePath,
        (batch) => {
          scannedFiles.push(...batch);
          for (const file of batch) scannedFilesByPath.set(file.path, file);
          sendToRenderer(IPC.SCAN_BATCH, batch);
        },
        (filePath, thumbnail) => {
          const file = scannedFilesByPath.get(filePath);
          if (file) file.thumbnail = thumbnail;
          sendToRenderer(IPC.SCAN_THUMBNAIL, filePath, thumbnail);
        },
        folderPattern,
      );
      console.log(`[scan] Complete: ${total} files`);
      await applyCatalogScanMemory(sourcePath).catch((error) => log.warn('[catalog] scan memory failed', error));
      sendToRenderer(IPC.SCAN_COMPLETE, total);
    } catch (err) {
      console.error('[scan] Error:', err);
      sendToRenderer(IPC.SCAN_COMPLETE, 0);
    }
  });

  handleIpc(IPC.SCAN_CHECK_DUPLICATES, async (_event, destRoot: string) => {
    // Use the same path composition as the import pipeline so protected files
    // land in _Protected/ and are matched there (otherwise they look like new
    // files forever because we'd check `destRoot/destPath` while they're
    // actually at `destRoot/_Protected/destPath`).
    const settings = await loadSettings();
    const sep = settings.separateProtected;
    const folder = (settings.protectedFolderName || '_Protected').replace(/^[/\\]+|[/\\]+$/g, '');
    for (const file of scannedFiles) {
      if (!file.destPath) continue;
      const relPath = file.isProtected && sep
        ? path.join(folder, file.destPath)
        : file.destPath;
      const dup = await isDuplicate(destRoot, relPath, file.size);
      if (dup) {
        file.duplicate = true;
        sendToRenderer(IPC.SCAN_DUPLICATE, file.path);
      }
    }
  });

  handleIpc(IPC.SCAN_PREVIEW, async (_event, filePath: string, variant?: 'preview' | 'detail') => {
    if (typeof filePath !== 'string') return undefined;
    if (variant !== undefined && variant !== 'preview' && variant !== 'detail') return undefined;
    if (!scannedFilesByPath.has(filePath)) return undefined;
    return generatePreview(filePath, variant ?? 'preview');
  });

  handleIpc(IPC.SCAN_CANCEL, async () => {
    cancelScan();
  });

  handleIpc(IPC.SCAN_PAUSE, async () => {
    pauseScan();
  });

  handleIpc(IPC.SCAN_RESUME, async () => {
    resumeScan();
  });

  // Import
  handleIpc(IPC.IMPORT_PREFLIGHT, async (_event, config: ImportConfig) => {
    const filesToImport = filterFilesForImport(scannedFiles, config);
    const [plan, ledger] = await Promise.all([
      planImportFiles(filesToImport, config),
      readLatestImportLedger(),
    ]);
    const recoveryAvailable = !!ledger?.items?.some((item) => item.status === 'failed' || item.status === 'pending');
    return {
      ...plan,
      recoveryAvailable,
      sessionWarnings: [
        ...plan.sessionWarnings,
        ...(recoveryAvailable ? ['A previous failed/pending import can be retried from the recovery ledger.'] : []),
      ],
    };
  }, ([config]) => isImportConfig(config) ? null : ipcError('VALIDATION_ERROR', 'Invalid import config payload.'));

  handleIpc(IPC.IMPORT_LEDGER_LATEST, async () => {
    return readLatestImportLedger();
  });

  handleIpc(IPC.IMPORT_HEALTH_SUMMARY, async () => {
    return buildImportHealthSummary();
  });

  handleIpc(IPC.CATALOG_STATS, async () => {
    return (await getCatalogService()).getStats();
  });

  handleIpc(IPC.CATALOG_BROWSE, async (_event, query: CatalogBrowserQuery = {}) => {
    return (await getCatalogService()).browse(query);
  }, ([query]) => isCatalogBrowserQuery(query) ? null : ipcError('VALIDATION_ERROR', 'Invalid catalog query payload.'));

  handleIpc(IPC.CATALOG_VERIFY_MISSING, async () => {
    return (await getCatalogService()).verifyMissingPaths();
  });

  handleIpc(IPC.CATALOG_PRUNE_MISSING, async () => {
    return (await getCatalogService()).pruneMissingEntries();
  });

  handleIpc(IPC.CATALOG_EXPORT_BACKUP, async () => {
    const defaultPath = path.join(
      app.getPath('documents'),
      `keptra-catalog-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    );
    const result = await dialog.showSaveDialog({
      title: 'Export Catalog Backup',
      defaultPath,
      filters: [{ name: 'JSON backup', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return null;
    return (await getCatalogService()).exportBackup(result.filePath);
  });

  handleIpc(IPC.SESSION_SAVE, async (_event, session: AppSession) => {
    return persistAppSession(session);
  }, ([session]) => isAppSession(session) ? null : ipcError('VALIDATION_ERROR', 'Invalid session payload.'));

  handleIpc(IPC.SESSION_LATEST, async () => {
    return readLatestAppSession();
  });

  handleIpc(IPC.IMPORT_START, async (_event, config: ImportConfig) => {
    try {
      const licenseStatus = await getLicenseStatus();
      if (!licenseStatus.valid) {
        return {
          imported: 0,
          skipped: 0,
          verified: 0,
          errors: [{ file: 'license', error: licenseStatus.message || 'A valid license is required to import.' }],
          totalBytes: 0,
          durationMs: 0,
        } satisfies ImportResult;
      }
      const filesToImport = filterFilesForImport(scannedFiles, config);
      const result = await importFiles(filesToImport, config, (progress) => {
        sendToRenderer(IPC.IMPORT_PROGRESS, progress);
      });
      const ledger = await persistImportLedger(config, result);
      result.lightroomHandoff = await writePostImportLightroomHandoff(config, ledger)
        .catch((error) => {
          log.warn('[lightroom-handoff] post-import handoff failed', error);
          result.errors.push({
            file: 'lightroom-handoff',
            error: error instanceof Error ? error.message : 'Could not write Lightroom handoff artifacts',
          });
          return undefined;
        });
      await recordCatalogImport(config, result).catch((error) => log.warn('[catalog] import record failed', error));
      if (config.autoEject && result.imported > 0 && config.sourcePath) {
        const eject = await ejectVolume(config.sourcePath);
        if (!eject.ok) {
          result.errors.push({
            file: 'source-eject',
            error: eject.error || 'Could not eject source volume',
          });
        }
      }
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown import error';
      return {
        imported: 0,
        skipped: 0,
        verified: 0,
        errors: [{ file: 'system', error: message }],
        totalBytes: 0,
        durationMs: 0,
      } satisfies ImportResult;
    }
  }, ([config]) => isImportConfig(config) ? null : ipcError('VALIDATION_ERROR', 'Invalid import config payload.'));

  handleIpc(IPC.IMPORT_RETRY_FAILED, async (_event, config: ImportConfig) => {
    const licenseStatus = await getLicenseStatus();
    if (!licenseStatus.valid) {
      return {
        imported: 0,
        skipped: 0,
        verified: 0,
        errors: [{ file: 'license', error: licenseStatus.message || 'A valid license is required to retry import recovery.' }],
        totalBytes: 0,
        durationMs: 0,
      } satisfies ImportResult;
    }
    const latest = await readLatestImportLedger();
    if (!latest) {
      return {
        imported: 0,
        skipped: 0,
        verified: 0,
        errors: [{ file: 'ledger', error: 'No previous import ledger found.' }],
        totalBytes: 0,
        durationMs: 0,
      } satisfies ImportResult;
    }
    const retryPaths = latest.items
      .filter((item) => item.status === 'failed' || item.status === 'pending')
      .map((item) => item.sourcePath);
    if (retryPaths.length === 0) {
      return {
        imported: 0,
        skipped: 0,
        verified: 0,
        errors: [],
        totalBytes: 0,
        durationMs: 0,
        recoveryCount: 0,
      } satisfies ImportResult;
    }
    const retryConfig: ImportConfig = { ...config, selectedPaths: retryPaths };
    const filesToImport = filterFilesForImport(scannedFiles, retryConfig);
    const result = await importFiles(filesToImport, retryConfig, (progress) => {
      sendToRenderer(IPC.IMPORT_PROGRESS, progress);
    });
    result.recoveryCount = retryPaths.length;
    const ledger = await persistImportLedger(retryConfig, result);
    result.lightroomHandoff = await writePostImportLightroomHandoff(retryConfig, ledger)
      .catch((error) => {
        log.warn('[lightroom-handoff] retry handoff failed', error);
        result.errors.push({
          file: 'lightroom-handoff',
          error: error instanceof Error ? error.message : 'Could not write Lightroom handoff artifacts',
        });
        return undefined;
      });
    await recordCatalogImport(retryConfig, result).catch((error) => log.warn('[catalog] retry record failed', error));
    return result;
  }, ([config]) => isImportConfig(config) ? null : ipcError('VALIDATION_ERROR', 'Invalid import config payload.'));

  handleIpc(IPC.IMPORT_CANCEL, async () => {
    cancelImport();
  });

  // Dialogs
  handleIpc(IPC.DIALOG_SELECT_FOLDER, async (_event, title: string) => {
    const result = await dialog.showOpenDialog({
      title,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  handleIpc(IPC.DIALOG_SELECT_FILE, async (_event, title: string, filters?: Electron.FileFilter[]) => {
    const result = await dialog.showOpenDialog({
      title,
      properties: ['openFile'],
      filters,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  handleIpc(IPC.DIALOG_OPEN_PATH, async (_event, filePath: string) => {
    await shell.openPath(filePath);
  }, ([filePath]) => isSafeOpenPath(filePath) ? null : ipcError('VALIDATION_ERROR', 'Invalid path payload.'));

  handleIpc(IPC.BENCHMARK_SMOKE_RUN, async () => {
    return runSmokeBenchmark();
  });

  handleIpc(IPC.BENCHMARK_OPEN_OUTPUT, async () => {
    const dir = getBenchmarkOutputDir();
    await mkdir(dir, { recursive: true });
    const error = await shell.openPath(dir);
    if (error) throw new Error(error);
    return dir;
  });

  handleIpc(IPC.DIAGNOSTICS_EXPORT, async () => {
    const dir = path.join(getDiagnosticsDir(), new Date().toISOString().replace(/[:.]/g, '-'));
    await mkdir(dir, { recursive: true });
    const [settings, ledger] = await Promise.all([
      loadSettings().catch(() => null),
      readLatestImportLedger(),
    ]);
    const device = detectDeviceTier(settings?.perfTier && settings.perfTier !== 'auto' ? settings.perfTier : undefined);
    const provider = {
      ep: getActualExecutionProvider(),
      models: getFaceProviderDiagnostics(),
    };
    const cacheStats = {
      face: await getDirectoryStats(path.join(app.getPath('userData'), 'face-cache')),
      thumbnails: await getDirectoryStats(path.join(app.getPath('temp'), 'photo-importer-thumbs')),
      importLedgers: await getDirectoryStats(getLedgersDir()),
    };
    const benchmarkDir = getBenchmarkOutputDir();
    const benchmarkSummaries: Array<{ name: string; bytes: number }> = [];
    try {
      const outputDir = path.join(dir, 'benchmarks');
      await mkdir(outputDir, { recursive: true });
      for (const entry of await readdir(benchmarkDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const source = path.join(benchmarkDir, entry.name);
        const info = await stat(source);
        benchmarkSummaries.push({ name: entry.name, bytes: info.size });
        await copyFile(source, path.join(outputDir, entry.name));
      }
    } catch {
      // Benchmark output is optional and often absent on end-user machines.
    }
    await writeFile(path.join(dir, 'diagnostics.json'), JSON.stringify({
      exportedAt: new Date().toISOString(),
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      device,
      provider,
      cacheStats,
      benchmarkSummaries,
      latestLedger: ledger,
      scannedFiles: scannedFiles.length,
      faceQueue: {
        active: faceActiveCount,
        queued: faceSemaphoreQueue.length,
        slots: faceSemaphoreSlots,
      },
    }, null, 2), 'utf8');
    if (settings) {
      const redacted = {
        ...settings,
        licenseKey: settings.licenseKey ? '[redacted]' : '',
        licenseActivationCode: settings.licenseActivationCode ? '[redacted]' : '',
        ftpConfig: { ...settings.ftpConfig, password: settings.ftpConfig.password ? '[redacted]' : '' },
        ftpDestConfig: { ...settings.ftpDestConfig, password: settings.ftpDestConfig.password ? '[redacted]' : '' },
      };
      await writeFile(path.join(dir, 'settings-redacted.json'), JSON.stringify(redacted, null, 2), 'utf8');
    }
    try {
      const file = log.transports.file.getFile();
      if (file?.path) await copyFile(file.path, path.join(dir, 'keptra.log'));
    } catch {
      // Log export is best-effort; diagnostics JSON is still useful.
    }
    return dir;
  });

  handleIpc(IPC.DIAGNOSTICS_SNAPSHOT, async () => {
    return buildDiagnosticsSnapshot();
  });

  handleIpc(IPC.MAC_FIRST_RUN_DOCTOR, async (): Promise<MacFirstRunDoctor> => {
    const resources = await getModelResourceStatus();
    const checks: MacFirstRunDoctor['checks'] = [
      {
        id: 'manual-dmg',
        label: 'Manual DMG updates',
        ok: process.platform === 'darwin',
        detail: process.platform === 'darwin'
          ? 'macOS updates are presented as DMG downloads and manual drag-to-Applications installs.'
          : 'This doctor is intended for macOS release checks.',
      },
      {
        id: 'onnx-runtime',
        label: 'ONNX runtime resource',
        ok: resources.onnxRuntimeNode,
        detail: resources.onnxRuntimeNode ? 'Packaged onnxruntime-node resource found.' : 'Missing packaged onnxruntime-node resource.',
      },
      {
        id: 'models',
        label: 'Face model resources',
        ok: resources.models.every((model) => model.exists && (model.bytes ?? 0) > 0),
        detail: resources.models.map((model) => `${model.name}:${model.exists ? `${model.bytes ?? 0} bytes` : 'missing'}`).join(', '),
      },
    ];

    if (process.platform === 'darwin') {
      const appPath = app.getPath('exe');
      const quarantine = await execFileAsync('xattr', ['-p', 'com.apple.quarantine', appPath], { timeout: 5000 })
        .then((result) => result.stdout.trim())
        .catch(() => '');
      checks.push({
        id: 'quarantine',
        label: 'Quarantine flag',
        ok: quarantine.length === 0,
        detail: quarantine ? `Quarantine attribute present: ${quarantine}` : 'No quarantine attribute reported on the executable.',
      });
      const spctl = await execFileAsync('spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath], { timeout: 10000 })
        .then((result) => result.stderr.trim() || result.stdout.trim())
        .catch((error) => error instanceof Error ? error.message : String(error));
      checks.push({
        id: 'gatekeeper',
        label: 'Gatekeeper assessment',
        ok: /accepted/i.test(spctl),
        detail: spctl || 'No Gatekeeper output.',
      });
    }

    return {
      platform: process.platform,
      arch: process.arch,
      supported: process.platform === 'darwin',
      appVersion: app.getVersion(),
      updateMode: process.platform === 'darwin' ? 'manual-dmg' : 'installer',
      resources,
      checks,
    };
  });

  // Settings
  handleIpc(IPC.SETTINGS_GET, async () => {
    return loadSettings();
  });

  handleIpc(IPC.SETTINGS_SET, async (_event, settings: Partial<AppSettings>) => {
    await saveSettings(settings);
    const merged = await loadSettings();
    await scheduleFtpSync(merged);
  }, ([settings]) => isSettingsPatch(settings) ? null : ipcError('VALIDATION_ERROR', 'Invalid settings patch payload.'));

  handleIpc(IPC.WATCH_FOLDERS_GET, async () => {
    const settings = await loadSettings();
    return settings.watchFolders ?? [];
  });

  handleIpc(IPC.WATCH_FOLDERS_SET, async (_event, folders: WatchFolder[]) => {
    const watchFolders = normalizeWatchFolders(folders);
    await saveSettings({ watchFolders });
    return watchFolders;
  }, ([folders]) => Array.isArray(folders) ? null : ipcError('VALIDATION_ERROR', 'Invalid watch folders payload.'));

  handleIpc(IPC.LICENSE_ACTIVATE, async (_event, key: string) => {
    const existing = await loadSettings();
    const status = await activateLicenseInput(key);
    if (status.valid && status.key) {
      await saveSettings({
        licenseKey: status.key,
        licenseActivationCode: status.activationCode ?? '',
        licenseStatus: status,
      });
      const settings = await loadSettings();
      return settings.licenseStatus ?? status;
    }
    if (!status.valid && !existing.licenseKey?.trim() && !existing.licenseActivationCode?.trim()) {
      await saveSettings({ licenseKey: '', licenseActivationCode: '', licenseStatus: status });
    }
    return status;
  });

  handleIpc(IPC.LICENSE_CLEAR, async () => {
    await saveSettings({
      licenseKey: '',
      licenseActivationCode: '',
      licenseStatus: { valid: false, message: 'License removed.', status: 'unknown' as const },
    });
    return { valid: false, message: 'License removed.', status: 'unknown' as const };
  });

  handleIpc(IPC.OPEN_EXTERNAL, async (_event, url: string) => {
    await shell.openExternal(url);
  }, ([url]) => isSafeHttpsUrl(url) ? null : ipcError('VALIDATION_ERROR', 'Invalid URL payload.'));

  // Updates
  handleIpc(IPC.UPDATE_OPEN_RELEASE, async (_event, url: string) => {
    await shell.openExternal(url);
  }, ([url]) => isAllowlistedUpdateUrl(url) ? null : ipcError('VALIDATION_ERROR', 'Release URL failed allowlist trust checks.'));

  handleIpc(IPC.UPDATE_CHECK_NOW, async () => {
    return refreshUpdateState();
  });

  handleIpc(IPC.UPDATE_REPAIR, async () => {
    return repairUpdates();
  });

  handleIpc(IPC.UPDATE_FETCH_HISTORY, async () => {
    const licenseKey = await getStoredLicenseKey();
    return fetchUpdateHistory(licenseKey);
  });

  handleIpc(IPC.UPDATE_DOWNLOAD, async () => {
    const latest = lastUpdateState ?? await refreshUpdateState();
    const downloadUrl = latest.downloadUrl;

    // Prefer the hosted installer/package link. It's more reliable than the
    // legacy native updater feed and works for both Windows and macOS builds.
    if (downloadUrl) {
      if (!isAllowlistedUpdateUrl(downloadUrl)) {
        logUpdateDiagnostic('blocked-download-url', { latestVersion: latest.latestVersion });
        return { ok: false as const, message: 'Update download URL failed trust checks.' };
      }
      if (downloadedInstallerPath && downloadedInstallerVersion === latest.latestVersion) {
        lastUpdateState = {
          ...latest,
          status: 'ready',
          installMode: process.platform === 'darwin' ? 'manual-dmg' : 'installer',
          message: process.platform === 'darwin'
            ? 'DMG already downloaded. Open it and drag Keptra to Applications.'
            : 'Installer already downloaded. Install update when you are ready.',
        };
        sendToRenderer(IPC.UPDATE_STATUS, lastUpdateState);
        return { ok: true as const };
      }

      lastUpdateState = {
        ...latest,
        status: 'downloading',
        installMode: process.platform === 'darwin' ? 'manual-dmg' : 'installer',
        message: process.platform === 'darwin' ? 'Downloading DMG inside Keptra...' : 'Downloading installer inside Keptra...',
      };
      sendToRenderer(IPC.UPDATE_STATUS, lastUpdateState);

      try {
        const versionLabel = latest.latestVersion || latest.releaseName || app.getVersion();
        const localInstaller = await downloadInstallerAsset(downloadUrl, versionLabel);
        downloadedInstallerPath = localInstaller;
        downloadedInstallerVersion = latest.latestVersion || versionLabel;
        downloadedUpdateKind = 'installer';

        lastUpdateState = {
          ...latest,
          status: 'ready',
          installMode: process.platform === 'darwin' ? 'manual-dmg' : 'installer',
          message: process.platform === 'darwin'
            ? 'DMG downloaded. Open it and drag Keptra to Applications.'
            : 'Installer downloaded. Install update to finish switching versions.',
        };
        sendToRenderer(IPC.UPDATE_STATUS, lastUpdateState);
        return { ok: true as const };
      } catch (error) {
        lastUpdateState = {
          ...latest,
          status: 'error',
          message: error instanceof Error
            ? error.message
            : 'Could not download the installer inside Keptra.',
        };
        sendToRenderer(IPC.UPDATE_STATUS, lastUpdateState);
        return {
          ok: false as const,
          message: lastUpdateState.message,
        };
      }
    }

    if (latest.releaseUrl) {
      if (!isAllowlistedUpdateUrl(latest.releaseUrl)) {
        logUpdateDiagnostic('blocked-release-url', { latestVersion: latest.latestVersion });
        return { ok: false as const, message: 'Release URL failed trust checks.' };
      }
      return {
        ok: false as const,
        message: 'This release only has notes right now. Add a hosted installer package to download inside the app.',
      };
    }

    if (latest.feedUrl && canUseNativeUpdater()) {
      try {
        ensureAutoUpdaterConfigured(latest.feedUrl);
        downloadedUpdateKind = 'native';
        downloadedInstallerPath = null;
        downloadedInstallerVersion = latest.latestVersion ?? null;
        lastUpdateState = {
          ...latest,
          status: 'downloading',
          message: 'Downloading the latest update...',
        };
        sendToRenderer(IPC.UPDATE_STATUS, lastUpdateState);
        (autoUpdater as unknown as { checkForUpdates: () => void }).checkForUpdates();
        return { ok: true as const };
      } catch (error) {
        return { ok: false as const, message: error instanceof Error ? error.message : 'Could not start the updater.' };
      }
    }

    return { ok: false as const, message: 'No download is available for this release yet.' };
  });

  handleIpc(IPC.UPDATE_INSTALL, async () => {
    if (downloadedInstallerPath && downloadedUpdateKind === 'installer') {
      // Verify the file still exists — it may have been cleared since download
      const { existsSync } = await import('node:fs');
      if (!existsSync(downloadedInstallerPath)) {
        downloadedInstallerPath = null;
        downloadedInstallerVersion = null;
        downloadedUpdateKind = null;
        lastUpdateState = { ...(lastUpdateState ?? { currentVersion: app.getVersion() }), status: 'available' };
        sendToRenderer(IPC.UPDATE_STATUS, lastUpdateState);
        return { ok: false as const, message: 'Installer file was removed. Please download the update again.' };
      }
      try {
        await launchDownloadedInstaller(downloadedInstallerPath);
        return { ok: true as const };
      } catch (error) {
        return {
          ok: false as const,
          message: error instanceof Error ? error.message : 'Could not launch the installer.',
        };
      }
    }

    if (canUseNativeUpdater() && downloadedUpdateKind === 'native') {
      try {
        (autoUpdater as unknown as { quitAndInstall: () => void }).quitAndInstall();
        return { ok: true as const };
      } catch (error) {
        return {
          ok: false as const,
          message: error instanceof Error ? error.message : 'Could not apply the downloaded update.',
        };
      }
    }

    if (!canUseNativeUpdater()) {
      return { ok: false as const, message: 'No downloaded installer is ready yet.' };
    }
    if (lastUpdateState?.status !== 'ready') {
      return { ok: false as const, message: 'No downloaded update is ready to install yet.' };
    }
    (autoUpdater as unknown as { quitAndInstall: () => void }).quitAndInstall();
    return { ok: true as const };
  });

  // FTP source
  handleIpc(IPC.FTP_PROBE, async (_event, config: FtpConfig) => {
    return probeFtp(config);
  }, ([config]) => isFtpConfig(config) ? null : ipcError('VALIDATION_ERROR', 'Invalid FTP config payload.'));

  let ftpAbort: AbortController | null = null;
  handleIpc(IPC.FTP_MIRROR_START, async (_event, config: FtpConfig) => {
    ftpAbort?.abort();
    ftpAbort = new AbortController();
    try {
      const stagingDir = await mirrorFtp(
        config,
        (done, total, name) => {
          sendToRenderer(IPC.FTP_MIRROR_PROGRESS, { done, total, name });
        },
        ftpAbort.signal,
      );
      return { ok: true as const, stagingDir };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'FTP mirror failed';
      return { ok: false as const, error: message };
    }
  }, ([config]) => isFtpConfig(config) ? null : ipcError('VALIDATION_ERROR', 'Invalid FTP config payload.'));

  handleIpc(IPC.FTP_MIRROR_CANCEL, async () => {
    ftpAbort?.abort();
    ftpAbort = null;
  });

  handleIpc(IPC.FTP_SYNC_RUN, async () => {
    const status = await runAutomatedFtpSync('manual');
    return { ok: status.state !== 'error', status };
  });

  // Eject
  handleIpc(IPC.EJECT_VOLUME, async (_event, volumePath: string) => {
    return ejectVolume(volumePath);
  }, ([volumePath]) => isSafePath(volumePath) ? null : ipcError('VALIDATION_ERROR', 'Invalid volume path payload.'));

  // Free space
  handleIpc(IPC.DISK_FREE_SPACE, async (_event, dirPath: string) => {
    return getFreeSpace(dirPath);
  }, ([dirPath]) => isSafePath(dirPath) ? null : ipcError('VALIDATION_ERROR', 'Invalid directory path payload.'));

  // Workflow — manifest export (CSV/JSON of the current scan list)
  handleIpc(IPC.EXPORT_MANIFEST, async (_event, format: 'csv' | 'json') => {
    const result = await dialog.showSaveDialog({
      title: 'Export import manifest',
      defaultPath: `import-manifest.${format}`,
      filters: [
        format === 'csv'
          ? { name: 'CSV', extensions: ['csv'] }
          : { name: 'JSON', extensions: ['json'] },
      ],
    });
    if (result.canceled || !result.filePath) return null;

    if (format === 'json') {
      await writeFile(result.filePath, JSON.stringify(scannedFiles, null, 2));
    } else {
      const headers = [
        'name', 'path', 'size', 'type', 'extension', 'dateTaken',
        'destPath', 'pick', 'rating', 'isProtected', 'duplicate',
        'cameraMake', 'cameraModel', 'lensModel', 'iso', 'aperture',
        'shutterSpeed', 'focalLength', 'exposureValue', 'normalizeToAnchor',
        'exposureAdjustmentStops',
      ];
      const esc = (v: unknown) => {
        if (v == null) return '';
        const s = String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = [headers.join(',')];
      for (const f of scannedFiles) {
        lines.push(headers.map((h) => esc((f as unknown as Record<string, unknown>)[h])).join(','));
      }
      await writeFile(result.filePath, lines.join('\n'));
    }
    return result.filePath;
  });

  handleIpc(IPC.EXPORT_LIGHTROOM_HANDOFF, async (_event, files?: MediaFile[]) => {
    const handoffFiles = Array.isArray(files) && files.length > 0 ? files : scannedFiles;
    const result = await dialog.showOpenDialog({
      title: 'Choose Lightroom handoff folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const latestLedger = await readLatestImportLedger();
    const sourcePaths = new Set(handoffFiles.map((file) => file.path));
    const matchingLedger = latestLedger
      ? {
          ...latestLedger,
          items: latestLedger.items.filter((item) => sourcePaths.has(item.sourcePath)),
        }
      : undefined;
    return writeLightroomHandoff(handoffFiles, {
      ledger: matchingLedger && matchingLedger.items.length > 0 ? matchingLedger : undefined,
      outputRoot: result.filePaths[0],
      source: 'current-session',
    });
  }, ([files]) => files == null || isMediaFileArray(files) ? null : ipcError('VALIDATION_ERROR', 'Invalid Lightroom handoff file payload.'));

  handleIpc(IPC.EXPORT_CONTACT_SHEET, async (_event, files: MediaFile[]) => {
    const result = await dialog.showSaveDialog({
      title: 'Export contact sheet',
      defaultPath: 'import-contact-sheet.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePath) return null;

    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    try {
      const selectedFiles = Array.isArray(files) && files.length > 0 ? files : scannedFiles;
      const html = contactSheetHtml(await contactSheetFiles(selectedFiles));
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      await win.webContents.executeJavaScript(`
        Promise.all(Array.from(document.images).map((img) => {
          if (img.complete) return true;
          return new Promise((resolve) => {
            img.onload = img.onerror = resolve;
          });
        }))
      `);
      const pdf = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        margins: { marginType: 'default' },
      });
      await writeFile(result.filePath, pdf);
      return result.filePath;
    } finally {
      win.destroy();
    }
  });

  // ---------------------------------------------------------------------------
  // Face analysis (onnxruntime-node)
  // ---------------------------------------------------------------------------

  /**
   * Returns true when the ONNX face models are present on disk.
   * The renderer uses this to show/hide face-related UI affordances.
   */
  handleIpc(IPC.FACE_EXECUTION_PROVIDER, () => {
    return {
      ep: getActualExecutionProvider(),
      models: getFaceProviderDiagnostics(),
    };
  });

  // Diagnostic: run a quick benchmark and return timing + EP info
  handleIpc('face:diagnose', async () => {
    return diagnoseFaceEngine();
  });

  handleIpc(IPC.FACE_MODELS_AVAILABLE, () => {
    return faceModelsAvailable();
  });

  /**
   * Returns GPU availability status (null = not yet determined, true/false after first analysis).
   * The renderer can show this in UI or logging for diagnostics.
   */
  handleIpc(IPC.FACE_GPU_AVAILABLE, () => {
    return isGpuAvailable();
  });

  handleIpc(IPC.FACE_CANCEL_QUEUE, () => {
    cancelPendingFaceJobs();
    return { ok: true };
  });

  handleIpc(IPC.FACE_GPU_STRESS_TEST, async (_event, durationMs?: number, streams?: number) => {
    return runFaceGpuStressTest(durationMs, streams);
  }, ([durationMs, streams]) =>
    isOptionalBoundedNumber(durationMs, 2000, 30000) && isOptionalBoundedNumber(streams, 1, 32)
      ? null
      : ipcError('VALIDATION_ERROR', 'Invalid face GPU stress-test payload.'));

  handleIpc(IPC.GPU_LIST, async () => {
    return listWindowsGpus().catch(() => []);
  });

  /**
   * Analyse faces in one or more image files.
   *
   * Input:  string | string[]  — absolute path(s) to image files
   * Output: Array<{
   *   path: string,
   *   boxes: FaceBox[],
   *   personBoxes: FaceBox[],
   *   embeddings: string[],   // hex-serialised Float32Array per face
   *   faceCount: number,
   *   personCount: number,
   * }>
   *
   * Errors per file are returned as { path, error } rather than throwing, so
   * one bad file doesn't abort the whole batch.
   */
  // Semaphore is now module-level (see top of file) so loadSettings can init it.

  handleIpc(IPC.FACE_ANALYZE, (_event, input: string | string[]) => {
    const paths = Array.isArray(input) ? input : [input];

    const task = async (): Promise<object[]> => {
      // ── Phase 1: parallel cache lookup (no semaphore — pure disk reads) ──
      const cacheResults = await Promise.all(paths.map(async (filePath) => {
        const cached = await getCachedFaceResult(filePath).catch(() => null);
        return { filePath, cached };
      }));

      const hits: object[] = [];
      const misses: string[] = [];
      for (const { filePath, cached } of cacheResults) {
        if (cached) {
          hits.push({
            path: filePath,
            boxes: cached.result.boxes,
            personBoxes: cached.result.personBoxes,
            embeddings: cached.hexEmbeddings,
            faceCount: cached.result.boxes.length,
            personCount: cached.result.personBoxes.length,
          });
        } else {
          misses.push(filePath);
        }
      }
      if (misses.length === 0) return hits;

      // ── Phase 2: ONNX inference for cache misses (semaphore-limited) ──
      // Capture generation before any awaits so stale jobs from a previous
      // source can be detected and dropped without running ONNX inference.
      const capturedGen = faceQueueGeneration;
      const onnxResults = await Promise.all(misses.map(async (filePath) => {
        try {
          await acquireFaceSemaphore(capturedGen);
        } catch (err: unknown) {
          // Stale job (scan source changed) — return empty result silently.
          if ((err as Error).message === STALE_FACE_JOB) {
            return { path: filePath, boxes: [], personBoxes: [], embeddings: [], faceCount: 0, personCount: 0 };
          }
          throw err;
        }
        try {
          const { boxes, personBoxes, embeddings } = await analyzeFaces(filePath);
          const hexEmbeddings = embeddings.map(serializeEmbedding);
          await setCachedFaceResult(filePath, { boxes, personBoxes, embeddings }, hexEmbeddings).catch(() => undefined);
          await new Promise<void>((resolve) => setImmediate(resolve));
          return {
            path: filePath,
            boxes,
            personBoxes,
            embeddings: hexEmbeddings,
            faceCount: boxes.length,
            personCount: personBoxes.length,
          };
        } catch (err: unknown) {
          return {
            path: filePath,
            boxes: [] as object[],
            personBoxes: [] as object[],
            embeddings: [] as string[],
            faceCount: 0,
            personCount: 0,
            error: (err as Error).message,
          };
        } finally {
          releaseFaceSemaphore();
        }
      }));

      // Merge hits + misses in original path order
      const allByPath = new Map<string, object>();
      for (const r of [...hits, ...onnxResults]) {
        allByPath.set((r as { path: string }).path, r);
      }
      return paths.map((p) => allByPath.get(p) ?? {
        path: p, boxes: [], personBoxes: [], embeddings: [], faceCount: 0, personCount: 0,
        error: 'result missing',
      });
    };

    return task();
  }, ([input]) => isFaceAnalysisInput(input) ? null : ipcError('VALIDATION_ERROR', 'Invalid face analysis payload.'));

  // Allow renderer to update face concurrency at runtime
  handleIpc('face:set-concurrency', (_event, n: number) => {
    setFaceConcurrency(n);
  }, ([n]) => isNumber(n) && n >= 1 && n <= 32 ? null : ipcError('VALIDATION_ERROR', 'Invalid face concurrency payload.'));

  // Clear the on-disk thumbnail/preview cache (temp folder).
  handleIpc(IPC.CACHE_CLEAR, async () => {
    try {
      const tmpDir = path.join(app.getPath('temp'), 'photo-importer-thumbs');
      await rm(tmpDir, { recursive: true, force: true });
      await mkdir(tmpDir, { recursive: true });
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Clear the persistent face-analysis result cache
  handleIpc(IPC.FACE_CACHE_CLEAR, async () => {
    try {
      await clearFaceCache();
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Return the detected device performance tier profile
  handleIpc(IPC.DEVICE_TIER_GET, async () => {
    const settings = await loadSettings();
    return detectDeviceTier(
      settings.perfTier && settings.perfTier !== 'auto' ? settings.perfTier : undefined
    );
  });

  // Prewarm ONNX face engine 5s after startup so first analysis is fast
  setTimeout(() => {
    void (async () => {
      try {
        const { prewarmFaceEngine } = await import('./services/face-engine');
        await prewarmFaceEngine();
      } catch { /* non-fatal */ }
    })();
  }, 5000);

  setTimeout(() => {
    void refreshUpdateState();
  }, 3000);
}

/**
 * Apply the renderer's intent to the current scan.
 *
 *   1. If config.selectedPaths is non-empty, keep only those files — this is
 *      the "I Cmd+clicked 40 thumbnails and hit Import" case.
 *   2. Else, drop rejected files. If skipDuplicates, also drop known dupes.
 *
 * Files with no destPath computed are always dropped (date parse failed).
 */
function filterFilesForImport(all: MediaFile[], config: ImportConfig): MediaFile[] {
  const selected = config.selectedPaths && config.selectedPaths.length > 0
    ? new Set(config.selectedPaths)
    : null;
  return all.filter((f) => {
    if (!f.destPath) return false;
    if (selected) return selected.has(f.path);
    if (f.pick === 'rejected') return false;
    if (config.skipDuplicates && f.duplicate) return false;
    return true;
  });
}

function autoImportQueueKey(item: QueuedAutoImport): string {
  return `${item.volume.path}\0${item.destRoot ?? ''}`;
}

function queueAutoImport(volume: Volume, options: Omit<QueuedAutoImport, 'volume'> = {}): void {
  const item: QueuedAutoImport = { volume, ...options };
  const key = autoImportQueueKey(item);
  if (currentAutoImportPath === key) return;
  if (autoImportQueue.some((queued) => autoImportQueueKey(queued) === key)) return;
  autoImportQueue.push(item);
  void processAutoImportQueue();
}

async function processAutoImportQueue(): Promise<void> {
  if (autoImportRunning) return;
  autoImportRunning = true;
  try {
    while (autoImportQueue.length > 0) {
      const item = autoImportQueue.shift();
      if (item) {
        currentAutoImportPath = autoImportQueueKey(item);
        await runAutoImport(item.volume, item);
        currentAutoImportPath = null;
      }
    }
  } finally {
    currentAutoImportPath = null;
    autoImportRunning = false;
  }
}

// Auto-import worker. Runs one volume at a time because the scan/import
// services share process-level state and importFiles aborts a previous run.
async function runAutoImport(volume: Volume, options: Omit<QueuedAutoImport, 'volume'> = {}): Promise<void> {
  const settings = await loadSettings();
  if (options.requireGlobalAutoImport !== false && !settings.autoImport) return;
  const destRoot = (options.destRoot || settings.autoImportDestRoot || '').trim();
  if (!destRoot) return;
  if (!settings.licenseStatus?.valid) return;
  const autoEject = options.autoEject ?? settings.autoEject;

  sendToRenderer(IPC.AUTO_IMPORT_STARTED, {
    volumePath: volume.path,
    destRoot,
  });

  try {
    scannedFiles = [];
    scannedFilesByPath = new Map();
    const pattern = settings.folderPreset === 'custom'
      ? settings.customPattern
      : undefined; // main-process default is '{YYYY}-{MM}-{DD}/{filename}'
    const total = await scanFiles(
      volume.path,
      (batch) => {
        scannedFiles.push(...batch);
        for (const file of batch) scannedFilesByPath.set(file.path, file);
        sendToRenderer(IPC.SCAN_BATCH, batch);
      },
      (filePath, thumbnail) => {
        const file = scannedFilesByPath.get(filePath);
        if (file) file.thumbnail = thumbnail;
        sendToRenderer(IPC.SCAN_THUMBNAIL, filePath, thumbnail);
      },
      pattern,
    );
    await applyCatalogScanMemory(volume.path).catch((error) => log.warn('[catalog] auto scan memory failed', error));
    sendToRenderer(IPC.SCAN_COMPLETE, total);

    const importConfig: ImportConfig = {
      sourcePath: volume.path,
      destRoot,
      skipDuplicates: settings.skipDuplicates,
      saveFormat: settings.saveFormat,
      jpegQuality: settings.jpegQuality,
      separateProtected: settings.separateProtected,
      protectedFolderName: settings.protectedFolderName,
      backupDestRoot: settings.backupDestRoot || undefined,
      autoEject,
      verifyChecksums: settings.verifyChecksums,
      metadata: buildImportMetadata(settings),
      metadataExportFlags: settings.metadataExport,
      watermark: buildWatermarkConfig(settings),
      autoStraighten: settings.autoStraighten,
    };

    const filesToImport = filterFilesForImport(scannedFiles, importConfig);
    sendToRenderer(IPC.IMPORT_PROGRESS, {
      currentFile: filesToImport.length > 0 ? 'Preparing import...' : 'No files to import',
      currentIndex: 0,
      totalFiles: filesToImport.length,
      bytesTransferred: 0,
      totalBytes: filesToImport.reduce((sum, f) => sum + f.size, 0),
      skipped: 0,
      errors: 0,
    });
    const result = await importFiles(filesToImport, importConfig, (progress) => {
      sendToRenderer(IPC.IMPORT_PROGRESS, progress);
    });
    const ledger = await persistImportLedger(importConfig, result);
    result.lightroomHandoff = await writePostImportLightroomHandoff(importConfig, ledger)
      .catch((error) => {
        log.warn('[lightroom-handoff] auto import handoff failed', error);
        result.errors.push({
          file: 'lightroom-handoff',
          error: error instanceof Error ? error.message : 'Could not write Lightroom handoff artifacts',
        });
        return undefined;
      });
    await recordCatalogImport(importConfig, result).catch((error) => log.warn('[catalog] auto import record failed', error));

    if (autoEject && result.imported > 0) {
      void ejectVolume(volume.path);
    }
    sendToRenderer(IPC.AUTO_IMPORT_COMPLETE, result);
  } catch (err) {
    console.error('[auto-import] failed:', err);
    const message = err instanceof Error ? err.message : 'Auto-import failed';
    sendToRenderer(IPC.AUTO_IMPORT_COMPLETE, {
      imported: 0,
      skipped: 0,
      verified: 0,
      errors: [{ file: 'auto-import', error: message }],
      totalBytes: 0,
      durationMs: 0,
    } satisfies ImportResult);
  }
}
