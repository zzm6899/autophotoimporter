import { ipcMain, dialog, shell, app, BrowserWindow } from 'electron';
import { readFile, writeFile, mkdir, statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { IPC } from '../shared/types';
import type { ImportConfig, ImportResult, AppSettings, MediaFile, FtpConfig, Volume } from '../shared/types';
import { listVolumes, startWatching, stopWatching } from './services/volume-watcher';
import { scanFiles, cancelScan } from './services/file-scanner';
import { importFiles, cancelImport } from './services/import-engine';
import { isDuplicate } from './services/duplicate-detector';
import { generatePreview } from './services/exif-parser';
import { checkForUpdate } from './services/update-checker';
import { probeFtp, mirrorFtp } from './services/ftp-source';

const execFileAsync = promisify(execFile);

let scannedFiles: MediaFile[] = [];
let knownVolumePaths = new Set<string>();

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
  autoEject: false,
  playSoundOnComplete: false,
  openFolderOnComplete: false,
  autoImport: false,
  autoImportDestRoot: '',
  autoImportPromptSeen: false,
  burstGrouping: true,
  burstWindowSec: 2,
  normalizeExposure: false,
  exposureMaxStops: 2,
};

async function loadSettings(): Promise<AppSettings> {
  try {
    const data = await readFile(getSettingsPath(), 'utf-8');
    const parsed = JSON.parse(data) as Partial<AppSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(settings: Partial<AppSettings>): Promise<void> {
  const current = await loadSettings();
  const merged = { ...current, ...settings };
  const dir = path.dirname(getSettingsPath());
  await mkdir(dir, { recursive: true });
  await writeFile(getSettingsPath(), JSON.stringify(merged, null, 2));
}

function sendToRenderer(channel: string, ...args: unknown[]): void {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send(channel, ...args);
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
      const drive = volumePath.replace(/\\+$/, '').replace(/:$/, ':');
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
      void maybeAutoImport(vol);
    }
  });

  // Seed the "known volumes" set so the first listing on app launch doesn't
  // fire a flood of "new device" events for already-mounted drives.
  void listVolumes().then((vols) => {
    knownVolumePaths = new Set(vols.map((v) => v.path));
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
    for (const file of scannedFiles) {
      if (!file.destPath) continue;
      const dup = await isDuplicate(destRoot, file.destPath, file.size);
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

  // Import
  ipcMain.handle(IPC.IMPORT_START, async (_event, config: ImportConfig) => {
    try {
      const filesToImport = filterFilesForImport(scannedFiles, config);
      const result = await importFiles(filesToImport, config, (progress) => {
        sendToRenderer(IPC.IMPORT_PROGRESS, progress);
      });
      if (config.autoEject && result.imported > 0 && config.sourcePath) {
        void ejectVolume(config.sourcePath);
      }
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown import error';
      return {
        imported: 0,
        skipped: 0,
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

  // Updates
  ipcMain.handle(IPC.UPDATE_OPEN_RELEASE, async (_event, url: string) => {
    await shell.openExternal(url);
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
        'shutterSpeed', 'focalLength',
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

  setTimeout(async () => {
    const update = await checkForUpdate();
    if (update) {
      sendToRenderer(IPC.UPDATE_AVAILABLE, update);
    }
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

// Auto-import orchestrator. Runs off a fresh device-inserted event when the
// user has opted in. Does a full scan + import using the saved default
// config, then notifies the renderer.
async function maybeAutoImport(volume: Volume): Promise<void> {
  const settings = await loadSettings();
  if (!settings.autoImport) return;
  if (!settings.autoImportDestRoot) return;

  sendToRenderer(IPC.AUTO_IMPORT_STARTED, {
    volumePath: volume.path,
    destRoot: settings.autoImportDestRoot,
  });

  try {
    scannedFiles = [];
    const pattern = settings.folderPreset === 'custom'
      ? settings.customPattern
      : undefined; // main-process default is '{YYYY}-{MM}-{DD}/{filename}'
    await scanFiles(
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
    sendToRenderer(IPC.SCAN_COMPLETE, scannedFiles.length);

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
    };

    const filesToImport = filterFilesForImport(scannedFiles, importConfig);
    const result = await importFiles(filesToImport, importConfig, (progress) => {
      sendToRenderer(IPC.IMPORT_PROGRESS, progress);
    });

    if (settings.autoEject && result.imported > 0) {
      void ejectVolume(volume.path);
    }
  } catch (err) {
    console.error('[auto-import] failed:', err);
  }
}
