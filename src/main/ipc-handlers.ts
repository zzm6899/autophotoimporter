import { ipcMain, dialog, shell, app, BrowserWindow, autoUpdater } from 'electron';
import { readFile, writeFile, mkdir, open, rm, rename, statfs } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { IPC } from '../shared/types';
import type { ImportConfig, ImportResult, AppSettings, MediaFile, FtpConfig, Volume, UpdateState } from '../shared/types';
import { listVolumes, startWatching, stopWatching } from './services/volume-watcher';
import { scanFiles, cancelScan, pauseScan, resumeScan } from './services/file-scanner';
import { importFiles, cancelImport } from './services/import-engine';
import { isDuplicate } from './services/duplicate-detector';
import { generatePreview } from './services/exif-parser';
import { checkForUpdate, fetchUpdateHistory } from './services/update-checker';
import { probeFtp, mirrorFtp } from './services/ftp-source';
import { activateLicenseInput, checkHostedLicenseStatus, validateLicenseKey } from './services/license';
import { analyzeFaces, faceModelsAvailable, serializeEmbedding } from './services/face-engine';

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
  ftpDestEnabled: false,
  ftpDestConfig: {
    host: '',
    port: 21,
    user: '',
    password: '',
    secure: false,
    remotePath: '/PhotoImporter',
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
  jobPresets: [],
  selectionSets: [],
  licenseKey: '',
  licenseStatus: { valid: false, message: 'No license activated.' },
};

async function loadSettings(): Promise<AppSettings> {
  try {
    const data = await readFile(getSettingsPath(), 'utf-8');
    const parsed = JSON.parse(data) as Partial<AppSettings>;
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    const licenseStatus = merged.licenseKey
      ? validateLicenseKey(merged.licenseKey)
      : { valid: false, message: 'No license activated.', status: 'unknown' as const };
    return { ...merged, licenseStatus };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(settings: Partial<AppSettings>): Promise<void> {
  const current = await loadSettings();
  const { licenseStatus: _currentStatus, ...safeCurrent } = current;
  const { licenseStatus: _incomingStatus, ...safeIncoming } = settings;
  const merged = { ...safeCurrent, ...safeIncoming };
  const dir = path.dirname(getSettingsPath());
  await mkdir(dir, { recursive: true });
  await writeFile(getSettingsPath(), JSON.stringify(merged, null, 2));
}

async function getLicenseStatus() {
  const settings = await loadSettings();
  const storedKey = settings.licenseKey?.trim();
  if (!storedKey) {
    return settings.licenseStatus ?? { valid: false, message: 'No license activated.', status: 'unknown' as const };
  }

  const status = await checkHostedLicenseStatus(storedKey, settings.licenseStatus ?? undefined);
  await saveSettings({ licenseKey: status.valid && status.key ? status.key : '' });
  return status;
}

async function getStoredLicenseKey() {
  const settings = await loadSettings();
  return settings.licenseKey?.trim() || undefined;
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
  const response = await fetch(downloadUrl);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed with status ${response.status}`);
  }

  const updatesDir = path.join(app.getPath('userData'), 'updates');
  await mkdir(updatesDir, { recursive: true });

  const fileNameFromHeader = parseContentDispositionFilename(response.headers.get('content-disposition'));
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

  app.on('before-quit', () => {
    stopWatching();
  });

  // Scanning
  ipcMain.handle(IPC.SCAN_START, async (_event, sourcePath: string, folderPattern?: string) => {
    console.log(`[scan] Starting scan of: ${sourcePath}`);
    scannedFiles = [];
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

  ipcMain.handle(IPC.SCAN_PREVIEW, async (_event, filePath: string) => {
    return generatePreview(filePath);
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
  });

  ipcMain.handle(IPC.LICENSE_ACTIVATE, async (_event, key: string) => {
    const status = await activateLicenseInput(key);
    if (status.valid && status.key) {
      await saveSettings({ licenseKey: status.key });
      const settings = await loadSettings();
      return settings.licenseStatus ?? status;
    }
    if (!status.valid) {
      await saveSettings({ licenseKey: '' });
    }
    return status;
  });

  ipcMain.handle(IPC.LICENSE_CLEAR, async () => {
    await saveSettings({ licenseKey: '' });
    return { valid: false, message: 'License removed.', status: 'unknown' as const };
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
  ipcMain.handle(IPC.FACE_MODELS_AVAILABLE, () => {
    return faceModelsAvailable();
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
  ipcMain.handle(IPC.FACE_ANALYZE, async (_event, input: string | string[]) => {
    const paths = Array.isArray(input) ? input : [input];
    const results = await Promise.all(
      paths.map(async (filePath) => {
        try {
          const { boxes, personBoxes, embeddings } = await analyzeFaces(filePath);
          return {
            path: filePath,
            boxes,
            personBoxes,
            embeddings: embeddings.map(serializeEmbedding),
            faceCount: boxes.length,
            personCount: personBoxes.length,
          };
        } catch (err: unknown) {
          return {
            path: filePath,
            boxes: [],
            personBoxes: [],
            embeddings: [],
            faceCount: 0,
            personCount: 0,
            error: (err as Error).message,
          };
        }
      }),
    );
    return results;
  });

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
