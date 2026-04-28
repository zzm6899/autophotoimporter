import { ipcMain, dialog, shell, app, BrowserWindow, autoUpdater } from 'electron';
import { readFile, writeFile, mkdir, open, rm, rename, statfs } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { IPC } from '../shared/types';
import type { ImportConfig, ImportResult, AppSettings, MediaFile, FtpConfig, FtpSyncStatus, Volume, UpdateState } from '../shared/types';
import { listVolumes, startWatching, stopWatching } from './services/volume-watcher';
import { scanFiles, cancelScan, pauseScan, resumeScan } from './services/file-scanner';
import { importFiles, cancelImport } from './services/import-engine';
import { isDuplicate } from './services/duplicate-detector';
import { generatePreview } from './services/exif-parser';
import { checkForUpdate, fetchUpdateHistory } from './services/update-checker';
import { probeFtp, mirrorFtp } from './services/ftp-source';
import { activateLicenseInput, checkHostedLicenseStatus, validateLicenseKey } from './services/license';
import { analyzeFaces, faceModelsAvailable, serializeEmbedding, isGpuAvailable, getActualExecutionProvider, configureGpuAcceleration, configureCpuOptimization, clearImageDecodeCache, diagnoseFaceEngine } from './services/face-engine';
import { getCachedFaceResult, setCachedFaceResult, clearFaceCache } from './services/face-cache';
import { detectDeviceTier, applyDeviceTier } from './services/device-tier';
import { setRawPreviewQuality } from './services/exif-parser';

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

const execFileAsync = promisify(execFile);

let scannedFiles: MediaFile[] = [];
let knownVolumePaths = new Set<string>();
let autoImportQueue: Volume[] = [];
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

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
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
    remotePath: '/PhotoImporter',
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
  autoImport: false,
  autoImportDestRoot: '',
  autoImportPromptSeen: false,
  burstGrouping: true,
  burstWindowSec: 2,
  normalizeExposure: false,
  exposureMaxStops: 2,
  exposureAdjustmentStep: 0.33,
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
  rawPreviewCache: true,        // Cache RAW previews by default
  cpuOptimization: false,       // Disabled by default (only enable for older CPUs)
  rawPreviewQuality: 70,        // 70% JPEG quality for RAW previews
  jobPresets: [],
  selectionSets: [],
  licenseKey: '',
  licenseActivationCode: '',
  licenseStatus: { valid: false, message: 'No license activated.' },
  perfTier: 'auto',
  fastKeeperMode: false,
  previewConcurrency: 2,
  faceConcurrency: 1,
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
  faceSemaphoreSlots = Math.max(1, Math.min(8, n));
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

async function loadSettings(): Promise<AppSettings> {
  try {
    const data = await readFile(getSettingsPath(), 'utf-8');
    const parsed = JSON.parse(data) as Partial<AppSettings>;
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
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
    
    // Apply performance settings immediately
    configureGpuAcceleration(merged.gpuFaceAcceleration ?? true);
    configureCpuOptimization(merged.cpuOptimization ?? false);
    setRawPreviewQuality(merged.rawPreviewQuality ?? 70);
    setFaceConcurrency(merged.faceConcurrency ?? 1);

    // Apply device-tier presets on first load (overridden by explicit user settings)
    const profile = detectDeviceTier(
      merged.perfTier && merged.perfTier !== 'auto' ? merged.perfTier : undefined
    );
    applyDeviceTier(profile, {
      setCpuOptimization: configureCpuOptimization,
      setRawPreviewQuality,
    }, {
      cpuOptimization: merged.cpuOptimization,
      rawPreviewQuality: merged.rawPreviewQuality,
    });

    return { ...merged, licenseStatus };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(settings: Partial<AppSettings>): Promise<void> {
  const current = await loadSettings();
  const merged: AppSettings = {
    ...current,
    ...settings,
    licenseStatus: settings.licenseStatus ?? current.licenseStatus,
  };
  const dir = path.dirname(getSettingsPath());
  await mkdir(dir, { recursive: true });
  await writeFile(getSettingsPath(), JSON.stringify(merged, null, 2));
  
  // Reapply settings to running services
  configureGpuAcceleration(merged.gpuFaceAcceleration ?? true);
  configureCpuOptimization(merged.cpuOptimization ?? false);
  setRawPreviewQuality(merged.rawPreviewQuality ?? 70);
  setFaceConcurrency(merged.faceConcurrency ?? 1);
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

  const status = storedActivationCode
    ? await activateLicenseInput(storedActivationCode)
    : await checkHostedLicenseStatus(storedKey!, settings.licenseStatus ?? undefined);

  await saveSettings({
    licenseKey: status.valid && status.key ? status.key : '',
    licenseActivationCode: status.valid ? (status.activationCode ?? storedActivationCode ?? '') : '',
    licenseStatus: status,
  });
  return status;
}

async function getStoredLicenseKey() {
  const status = await getLicenseStatus();
  return status.valid ? status.key?.trim() || undefined : undefined;
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
  lastUpdateState = { ...update, history };
  sendToRenderer(IPC.UPDATE_STATUS, lastUpdateState);
  return lastUpdateState;
}

function canUseNativeUpdater() {
  return process.platform === 'win32' && app.isPackaged;
}

function ensureAutoUpdaterConfigured(feedUrl?: string) {
  if (!feedUrl || !canUseNativeUpdater()) return;

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
  return value.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-').trim() || 'Photo-Importer-Update';
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
  // First request: no-redirect so we can capture the Content-Disposition header
  // from our server before it redirects to GitHub (which won't send it).
  let fileNameFromHeader: string | null = null;
  try {
    const headResp = await fetch(downloadUrl, { redirect: 'manual' });
    fileNameFromHeader = parseContentDispositionFilename(headResp.headers.get('content-disposition'));
  } catch {
    // ignore — fall through to redirect-following fetch below
  }

  const response = await fetch(downloadUrl);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed with status ${response.status}`);
  }

  const updatesDir = path.join(app.getPath('userData'), 'updates');
  await mkdir(updatesDir, { recursive: true });

  if (!fileNameFromHeader) {
    fileNameFromHeader = parseContentDispositionFilename(response.headers.get('content-disposition'));
  }
  const fallbackName = `Photo-Importer-${versionLabel}${installerExtensionForPlatform(downloadUrl)}`;
  const fileName = sanitizeDownloadName(fileNameFromHeader || path.basename(new URL(downloadUrl).pathname) || fallbackName);
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
          ? 'Downloading installer inside Photo Importer...'
          : `Downloading installer inside Photo Importer... ${progress}%`,
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
  try {
    const stats = await statfs(dirPath);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
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
  // Volumes
  ipcMain.handle(IPC.VOLUMES_LIST, async () => {
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
    void scheduleFtpSync(settings);
    if (settings.ftpSync?.enabled && settings.ftpSync.runOnLaunch) {
      setTimeout(() => {
        void runAutomatedFtpSync('launch');
      }, 2500);
    }
  }).catch(() => undefined);

  app.on('before-quit', () => {
    stopWatching();
    clearFtpSyncTimer();
    ftpSyncAbort?.abort();
  });

  // Scanning
  ipcMain.handle(IPC.SCAN_START, async (_event, sourcePath: string, folderPattern?: string) => {
    console.log(`[scan] Starting scan of: ${sourcePath}`);
    scannedFiles = [];
    clearImageDecodeCache(); // flush stale RAW decodes from previous source
    cancelPendingFaceJobs(); // drain queued face jobs from old source so they don't compete with new scan
    try {
      const total = await scanFiles(
        sourcePath,
        (batch) => {
          scannedFiles.push(...batch);
          sendToRenderer(IPC.SCAN_BATCH, batch);
        },
        (filePath, thumbnail) => {
          const file = scannedFiles.find((f) => f.path === filePath);
          if (file) file.thumbnail = thumbnail;
          sendToRenderer(IPC.SCAN_THUMBNAIL, filePath, thumbnail);
        },
        folderPattern,
      );
      console.log(`[scan] Complete: ${total} files`);
      sendToRenderer(IPC.SCAN_COMPLETE, total);
    } catch (err) {
      console.error('[scan] Error:', err);
      sendToRenderer(IPC.SCAN_COMPLETE, 0);
    }
  });

  ipcMain.handle(IPC.SCAN_CHECK_DUPLICATES, async (_event, destRoot: string) => {
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

  ipcMain.handle(IPC.SCAN_PREVIEW, async (_event, filePath: string, variant?: 'preview' | 'detail') => {
    return generatePreview(filePath, variant ?? 'preview');
  });

  ipcMain.handle(IPC.SCAN_CANCEL, async () => {
    cancelScan();
  });

  ipcMain.handle(IPC.SCAN_PAUSE, async () => {
    pauseScan();
  });

  ipcMain.handle(IPC.SCAN_RESUME, async () => {
    resumeScan();
  });

  // Import
  ipcMain.handle(IPC.IMPORT_START, async (_event, config: ImportConfig) => {
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
  });

  ipcMain.handle(IPC.IMPORT_CANCEL, async () => {
    cancelImport();
  });

  // Dialogs
  ipcMain.handle(IPC.DIALOG_SELECT_FOLDER, async (_event, title: string) => {
    const result = await dialog.showOpenDialog({
      title,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(IPC.DIALOG_SELECT_FILE, async (_event, title: string, filters?: Electron.FileFilter[]) => {
    const result = await dialog.showOpenDialog({
      title,
      properties: ['openFile'],
      filters,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(IPC.DIALOG_OPEN_PATH, async (_event, filePath: string) => {
    await shell.openPath(filePath);
  });

  // Settings
  ipcMain.handle(IPC.SETTINGS_GET, async () => {
    return loadSettings();
  });

  ipcMain.handle(IPC.SETTINGS_SET, async (_event, settings: Partial<AppSettings>) => {
    await saveSettings(settings);
    const merged = await loadSettings();
    await scheduleFtpSync(merged);
  });

  ipcMain.handle(IPC.LICENSE_ACTIVATE, async (_event, key: string) => {
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
    if (!status.valid) {
      await saveSettings({ licenseKey: '', licenseActivationCode: '', licenseStatus: status });
    }
    return status;
  });

  ipcMain.handle(IPC.LICENSE_CLEAR, async () => {
    await saveSettings({
      licenseKey: '',
      licenseActivationCode: '',
      licenseStatus: { valid: false, message: 'License removed.', status: 'unknown' as const },
    });
    return { valid: false, message: 'License removed.', status: 'unknown' as const };
  });

  ipcMain.handle(IPC.OPEN_EXTERNAL, async (_event, url: string) => {
    // Only allow https URLs to prevent arbitrary protocol abuse
    if (typeof url === 'string' && url.startsWith('https://')) {
      await shell.openExternal(url);
    }
  });

  // Updates
  ipcMain.handle(IPC.UPDATE_OPEN_RELEASE, async (_event, url: string) => {
    await shell.openExternal(url);
  });

  ipcMain.handle(IPC.UPDATE_CHECK_NOW, async () => {
    return refreshUpdateState();
  });

  ipcMain.handle(IPC.UPDATE_FETCH_HISTORY, async () => {
    const licenseKey = await getStoredLicenseKey();
    return fetchUpdateHistory(licenseKey);
  });

  ipcMain.handle(IPC.UPDATE_DOWNLOAD, async () => {
    const latest = lastUpdateState ?? await refreshUpdateState();
    const downloadUrl = latest.downloadUrl;

    // Prefer the hosted installer/package link. It's more reliable than the
    // legacy native updater feed and works for both Windows and macOS builds.
    if (downloadUrl) {
      if (downloadedInstallerPath && downloadedInstallerVersion === latest.latestVersion) {
        lastUpdateState = {
          ...latest,
          status: 'ready',
          message: 'Installer already downloaded. Install update when you are ready.',
        };
        sendToRenderer(IPC.UPDATE_STATUS, lastUpdateState);
        return { ok: true as const };
      }

      lastUpdateState = {
        ...latest,
        status: 'downloading',
        message: 'Downloading installer inside Photo Importer...',
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
          message: 'Installer downloaded. Install update to finish switching versions.',
        };
        sendToRenderer(IPC.UPDATE_STATUS, lastUpdateState);
        return { ok: true as const };
      } catch (error) {
        lastUpdateState = {
          ...latest,
          status: 'error',
          message: error instanceof Error
            ? error.message
            : 'Could not download the installer inside Photo Importer.',
        };
        sendToRenderer(IPC.UPDATE_STATUS, lastUpdateState);
        return {
          ok: false as const,
          message: lastUpdateState.message,
        };
      }
    }

    if (latest.releaseUrl) {
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

  ipcMain.handle(IPC.UPDATE_INSTALL, async () => {
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
  ipcMain.handle(IPC.FTP_PROBE, async (_event, config: FtpConfig) => {
    return probeFtp(config);
  });

  let ftpAbort: AbortController | null = null;
  ipcMain.handle(IPC.FTP_MIRROR_START, async (_event, config: FtpConfig) => {
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
  });

  ipcMain.handle(IPC.FTP_MIRROR_CANCEL, async () => {
    ftpAbort?.abort();
    ftpAbort = null;
  });

  ipcMain.handle(IPC.FTP_SYNC_RUN, async () => {
    const status = await runAutomatedFtpSync('manual');
    return { ok: status.state !== 'error', status };
  });

  // Eject
  ipcMain.handle(IPC.EJECT_VOLUME, async (_event, volumePath: string) => {
    return ejectVolume(volumePath);
  });

  // Free space
  ipcMain.handle(IPC.DISK_FREE_SPACE, async (_event, dirPath: string) => {
    return getFreeSpace(dirPath);
  });

  // Workflow — manifest export (CSV/JSON of the current scan list)
  ipcMain.handle(IPC.EXPORT_MANIFEST, async (_event, format: 'csv' | 'json') => {
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

  ipcMain.handle(IPC.EXPORT_CONTACT_SHEET, async (_event, files: MediaFile[]) => {
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
  ipcMain.handle(IPC.FACE_EXECUTION_PROVIDER, () => {
    return getActualExecutionProvider();
  });

  // Diagnostic: run a quick benchmark and return timing + EP info
  ipcMain.handle('face:diagnose', async () => {
    return diagnoseFaceEngine();
  });

  ipcMain.handle(IPC.FACE_MODELS_AVAILABLE, () => {
    return faceModelsAvailable();
  });

  /**
   * Returns GPU availability status (null = not yet determined, true/false after first analysis).
   * The renderer can show this in UI or logging for diagnostics.
   */
  ipcMain.handle(IPC.FACE_GPU_AVAILABLE, () => {
    return isGpuAvailable();
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

  ipcMain.handle(IPC.FACE_ANALYZE, (_event, input: string | string[]) => {
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
  });

  // Allow renderer to update face concurrency at runtime
  ipcMain.handle('face:set-concurrency', (_event, n: number) => {
    setFaceConcurrency(n);
  });

  // Clear the on-disk thumbnail/preview cache (temp folder).
  ipcMain.handle(IPC.CACHE_CLEAR, async () => {
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
  ipcMain.handle(IPC.FACE_CACHE_CLEAR, async () => {
    try {
      await clearFaceCache();
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Return the detected device performance tier profile
  ipcMain.handle(IPC.DEVICE_TIER_GET, async () => {
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

function queueAutoImport(volume: Volume): void {
  if (currentAutoImportPath === volume.path) return;
  if (autoImportQueue.some((queued) => queued.path === volume.path)) return;
  autoImportQueue.push(volume);
  void processAutoImportQueue();
}

async function processAutoImportQueue(): Promise<void> {
  if (autoImportRunning) return;
  autoImportRunning = true;
  try {
    while (autoImportQueue.length > 0) {
      const volume = autoImportQueue.shift();
      if (volume) {
        currentAutoImportPath = volume.path;
        await runAutoImport(volume);
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
async function runAutoImport(volume: Volume): Promise<void> {
  const settings = await loadSettings();
  if (!settings.autoImport) return;
  if (!settings.autoImportDestRoot) return;
  if (!settings.licenseStatus?.valid) return;

  sendToRenderer(IPC.AUTO_IMPORT_STARTED, {
    volumePath: volume.path,
    destRoot: settings.autoImportDestRoot,
  });

  try {
    scannedFiles = [];
    const pattern = settings.folderPreset === 'custom'
      ? settings.customPattern
      : undefined; // main-process default is '{YYYY}-{MM}-{DD}/{filename}'
    const total = await scanFiles(
      volume.path,
      (batch) => {
        scannedFiles.push(...batch);
        sendToRenderer(IPC.SCAN_BATCH, batch);
      },
      (filePath, thumbnail) => {
        const file = scannedFiles.find((f) => f.path === filePath);
        if (file) file.thumbnail = thumbnail;
        sendToRenderer(IPC.SCAN_THUMBNAIL, filePath, thumbnail);
      },
      pattern,
    );
    sendToRenderer(IPC.SCAN_COMPLETE, total);

    const importConfig: ImportConfig = {
      sourcePath: volume.path,
      destRoot: settings.autoImportDestRoot,
      skipDuplicates: settings.skipDuplicates,
      saveFormat: settings.saveFormat,
      jpegQuality: settings.jpegQuality,
      separateProtected: settings.separateProtected,
      protectedFolderName: settings.protectedFolderName,
      backupDestRoot: settings.backupDestRoot || undefined,
      autoEject: settings.autoEject,
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

    if (settings.autoEject && result.imported > 0) {
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
