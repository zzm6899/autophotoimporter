import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/types';
import type { ImportConfig, AppSettings, MediaFile, Volume, ImportProgress, ImportResult, UpdateInfo, UpdateReleaseSummary, UpdateState, FtpConfig, FtpSyncStatus, ImportError, LicenseValidation } from '../shared/types';
import type { FaceBox } from './services/face-engine';
import type { ModelDownloadProgress } from './services/model-downloader';

export interface FtpProbeResult {
  ok: boolean;
  error?: string;
  fileCount?: number;
  totalBytes?: number;
}

export interface FtpMirrorResult {
  ok: boolean;
  stagingDir?: string;
  error?: string;
}

export interface FtpMirrorProgress {
  done: number;
  total: number;
  name: string;
}

const api = {
  // Volumes
  listVolumes: (): Promise<Volume[]> =>
    ipcRenderer.invoke(IPC.VOLUMES_LIST),
  onVolumesChanged: (cb: (volumes: Volume[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, volumes: Volume[]) => cb(volumes);
    ipcRenderer.on(IPC.VOLUMES_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.VOLUMES_CHANGED, handler);
  },

  // Scanning
  scanFiles: (sourcePath: string, folderPattern?: string): Promise<void> =>
    ipcRenderer.invoke(IPC.SCAN_START, sourcePath, folderPattern),
  onScanBatch: (cb: (files: MediaFile[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, files: MediaFile[]) => cb(files);
    ipcRenderer.on(IPC.SCAN_BATCH, handler);
    return () => ipcRenderer.removeListener(IPC.SCAN_BATCH, handler);
  },
  onScanComplete: (cb: (totalFiles: number) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, total: number) => cb(total);
    ipcRenderer.on(IPC.SCAN_COMPLETE, handler);
    return () => ipcRenderer.removeListener(IPC.SCAN_COMPLETE, handler);
  },
  onScanThumbnail: (cb: (filePath: string, thumbnail: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, filePath: string, thumbnail: string) => cb(filePath, thumbnail);
    ipcRenderer.on(IPC.SCAN_THUMBNAIL, handler);
    return () => ipcRenderer.removeListener(IPC.SCAN_THUMBNAIL, handler);
  },
  checkDuplicates: (destRoot: string): Promise<void> =>
    ipcRenderer.invoke(IPC.SCAN_CHECK_DUPLICATES, destRoot),
  onScanDuplicate: (cb: (filePath: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, filePath: string) => cb(filePath);
    ipcRenderer.on(IPC.SCAN_DUPLICATE, handler);
    return () => ipcRenderer.removeListener(IPC.SCAN_DUPLICATE, handler);
  },
  getPreview: (filePath: string, variant?: 'preview' | 'detail'): Promise<string | undefined> =>
    ipcRenderer.invoke(IPC.SCAN_PREVIEW, filePath, variant),
  cancelScan: (): Promise<void> =>
    ipcRenderer.invoke(IPC.SCAN_CANCEL),
  pauseScan: (): Promise<void> =>
    ipcRenderer.invoke(IPC.SCAN_PAUSE),
  resumeScan: (): Promise<void> =>
    ipcRenderer.invoke(IPC.SCAN_RESUME),

  // Import
  startImport: (config: ImportConfig): Promise<ImportResult> =>
    ipcRenderer.invoke(IPC.IMPORT_START, config),
  onImportProgress: (cb: (progress: ImportProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: ImportProgress) => cb(progress);
    ipcRenderer.on(IPC.IMPORT_PROGRESS, handler);
    return () => ipcRenderer.removeListener(IPC.IMPORT_PROGRESS, handler);
  },
  cancelImport: (): Promise<void> =>
    ipcRenderer.invoke(IPC.IMPORT_CANCEL),

  // Dialogs
  selectFolder: (title: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.DIALOG_SELECT_FOLDER, title),
  selectFile: (title: string, filters?: Electron.FileFilter[]): Promise<string | null> =>
    ipcRenderer.invoke(IPC.DIALOG_SELECT_FILE, title, filters),
  openPath: (path: string): Promise<void> =>
    ipcRenderer.invoke(IPC.DIALOG_OPEN_PATH, path),

  // Settings
  getSettings: (): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.SETTINGS_GET),
  setSettings: (settings: Partial<AppSettings>): Promise<void> =>
    ipcRenderer.invoke(IPC.SETTINGS_SET, settings),
  activateLicense: (key: string): Promise<LicenseValidation> =>
    ipcRenderer.invoke(IPC.LICENSE_ACTIVATE, key),
  clearLicense: (): Promise<LicenseValidation> =>
    ipcRenderer.invoke(IPC.LICENSE_CLEAR),

  // Updates
  onUpdateAvailable: (cb: (info: UpdateInfo) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: UpdateInfo) => cb(info);
    ipcRenderer.on(IPC.UPDATE_AVAILABLE, handler);
    return () => ipcRenderer.removeListener(IPC.UPDATE_AVAILABLE, handler);
  },
  onUpdateStatus: (cb: (state: UpdateState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: UpdateState) => cb(state);
    ipcRenderer.on(IPC.UPDATE_STATUS, handler);
    return () => ipcRenderer.removeListener(IPC.UPDATE_STATUS, handler);
  },
  checkForUpdates: (): Promise<UpdateState> =>
    ipcRenderer.invoke(IPC.UPDATE_CHECK_NOW),
  fetchUpdateHistory: (): Promise<UpdateReleaseSummary[]> =>
    ipcRenderer.invoke(IPC.UPDATE_FETCH_HISTORY),
  downloadUpdate: (): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke(IPC.UPDATE_DOWNLOAD),
  installUpdate: (): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke(IPC.UPDATE_INSTALL),
  openReleaseUrl: (url: string): Promise<void> =>
    ipcRenderer.invoke(IPC.UPDATE_OPEN_RELEASE, url),

  // FTP source
  probeFtp: (config: FtpConfig): Promise<FtpProbeResult> =>
    ipcRenderer.invoke(IPC.FTP_PROBE, config),
  mirrorFtp: (config: FtpConfig): Promise<FtpMirrorResult> =>
    ipcRenderer.invoke(IPC.FTP_MIRROR_START, config),
  cancelFtpMirror: (): Promise<void> =>
    ipcRenderer.invoke(IPC.FTP_MIRROR_CANCEL),
  onFtpMirrorProgress: (cb: (p: FtpMirrorProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, p: FtpMirrorProgress) => cb(p);
    ipcRenderer.on(IPC.FTP_MIRROR_PROGRESS, handler);
    return () => ipcRenderer.removeListener(IPC.FTP_MIRROR_PROGRESS, handler);
  },
  runFtpSync: (): Promise<{ ok: boolean; status: FtpSyncStatus }> =>
    ipcRenderer.invoke(IPC.FTP_SYNC_RUN),
  onFtpSyncStatus: (cb: (status: FtpSyncStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: FtpSyncStatus) => cb(status);
    ipcRenderer.on(IPC.FTP_SYNC_STATUS, handler);
    return () => ipcRenderer.removeListener(IPC.FTP_SYNC_STATUS, handler);
  },

  // Export manifest
  exportManifest: (format: 'csv' | 'json'): Promise<string | null> =>
    ipcRenderer.invoke(IPC.EXPORT_MANIFEST, format),
  exportContactSheet: (files: MediaFile[]): Promise<string | null> =>
    ipcRenderer.invoke(IPC.EXPORT_CONTACT_SHEET, files),

  // Eject volume (removable only, best-effort)
  ejectVolume: (volumePath: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.EJECT_VOLUME, volumePath),

  // Disk free-space check (for pre-import warnings)
  getDiskFreeSpace: (dirPath: string): Promise<number | null> =>
    ipcRenderer.invoke(IPC.DISK_FREE_SPACE, dirPath),

  // Auto-import — fires when a new device is inserted and the app has
  // autoImport enabled. UI uses this to jump into the import flow.
  onDeviceInserted: (cb: (volume: Volume) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, volume: Volume) => cb(volume);
    ipcRenderer.on(IPC.DEVICE_INSERTED, handler);
    return () => ipcRenderer.removeListener(IPC.DEVICE_INSERTED, handler);
  },
  onAutoImportStarted: (cb: (info: { volumePath: string; destRoot: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: { volumePath: string; destRoot: string }) => cb(info);
    ipcRenderer.on(IPC.AUTO_IMPORT_STARTED, handler);
    return () => ipcRenderer.removeListener(IPC.AUTO_IMPORT_STARTED, handler);
  },
  onAutoImportComplete: (cb: (result: ImportResult) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, result: ImportResult) => cb(result);
    ipcRenderer.on(IPC.AUTO_IMPORT_COMPLETE, handler);
    return () => ipcRenderer.removeListener(IPC.AUTO_IMPORT_COMPLETE, handler);
  },

  // Face analysis (onnxruntime-node ONNX face models)
  /** Returns true when the ONNX face models are downloaded and usable. */
  faceModelsAvailable: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC.FACE_MODELS_AVAILABLE),
  /**
   * Returns GPU acceleration status:
   *   null = not yet determined (no face analysis run yet)
   *   true = GPU available and active
   *   false = GPU not available, using CPU only
   */
  isGpuAvailable: (): Promise<boolean | null> =>
    ipcRenderer.invoke(IPC.FACE_GPU_AVAILABLE),
  /**
   * Analyse faces in one or more images.
   * Returns one result object per input path:
   *   { path, boxes, embeddings (hex strings), faceCount, error? }
   */
  analyzeFaces: (paths: string | string[]): Promise<Array<{
    path: string;
    boxes: FaceBox[];
    personBoxes: FaceBox[];
    embeddings: string[];
    faceCount: number;
    personCount: number;
    error?: string;
  }>> =>
    ipcRenderer.invoke(IPC.FACE_ANALYZE, paths),

  /** Cancel queued background face-analysis work. In-flight ONNX calls finish, but stale renderer batches are ignored. */
  cancelFaceAnalysis: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.FACE_CANCEL_QUEUE),

  /** Clear the on-disk thumbnail/preview cache. */
  clearCache: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.CACHE_CLEAR),

  /** Update how many face analyses run in parallel (1-32). */
  setFaceAnalysisConcurrency: (n: number): Promise<void> =>
    ipcRenderer.invoke('face:set-concurrency', n),

  /** Enumerate Windows display adapters so DirectML can target a specific GPU. */
  listGpus: (): Promise<Array<{ id: number; name: string; adapterCompatibility?: string; videoMemoryMB?: number }>> =>
    ipcRenderer.invoke(IPC.GPU_LIST),

  /** Clear the persistent face-analysis result cache. */
  clearFaceCache: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.FACE_CACHE_CLEAR),

  /** Returns execution provider diagnostics for the face engine. */
  getExecutionProvider: (): Promise<{
    ep: string | null;
    models: Array<{
      model: 'detector' | 'embedder' | 'person';
      provider: string;
      inputName?: string;
      loadMs?: number;
      avgInferenceMs?: number;
      cpuAvgInferenceMs?: number;
      dmlAvgInferenceMs?: number;
      deviceId?: number;
      fallbackReason?: string;
    }>;
  }> =>
    ipcRenderer.invoke(IPC.FACE_EXECUTION_PROVIDER),

  /** Run a quick DML benchmark — returns EP, avg inference time, session load time. */
  diagnoseFaceEngine: (): Promise<{
    ep: string | null;
    gpuAvailable: boolean | null;
    avgInferenceMs: number;
    sessionLoadMs: number;
    platform: string;
    providers: string[];
    models: Array<{
      model: 'detector' | 'embedder' | 'person';
      provider: string;
      inputName?: string;
      loadMs?: number;
      avgInferenceMs?: number;
      cpuAvgInferenceMs?: number;
      dmlAvgInferenceMs?: number;
      deviceId?: number;
      fallbackReason?: string;
    }>;
  }> =>
    ipcRenderer.invoke('face:diagnose'),

  /** Run a multi-second detector/embedder loop so Task Manager can show DirectML GPU Compute usage. */
  stressTestFaceGpu: (durationMs?: number, streams?: number): Promise<{
    ep: string | null;
    gpuAvailable: boolean | null;
    durationMs: number;
    streams: number;
    detectorRuns: number;
    embedderRuns: number;
    totalRuns: number;
    runsPerSecond: number;
    detectorAvgMs: number;
    embedderAvgMs: number;
    models: Array<{
      model: 'detector' | 'embedder' | 'person';
      provider: string;
      inputName?: string;
      loadMs?: number;
      avgInferenceMs?: number;
      cpuAvgInferenceMs?: number;
      dmlAvgInferenceMs?: number;
      deviceId?: number;
      fallbackReason?: string;
    }>;
  }> =>
    ipcRenderer.invoke(IPC.FACE_GPU_STRESS_TEST, durationMs, streams),

  /** Get the device performance tier profile. */
  getDeviceTier: (): Promise<{
    tier: 'low' | 'balanced' | 'high';
    cpuCores: number;
    totalMemGB: number;
    previewConcurrency: number;
    faceConcurrency: number;
    cpuOptimization: boolean;
    rawPreviewQuality: number;
  }> =>
    ipcRenderer.invoke(IPC.DEVICE_TIER_GET),

  /** Subscribe to background face-model download progress events. */
  onFaceModelDownloadProgress: (cb: (progress: ModelDownloadProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: ModelDownloadProgress) => cb(progress);
    ipcRenderer.on(IPC.FACE_MODEL_DOWNLOAD_PROGRESS, handler);
    return () => ipcRenderer.removeListener(IPC.FACE_MODEL_DOWNLOAD_PROGRESS, handler);
  },

  /** Open a URL in the system's default browser. Only https:// URLs are permitted. */
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke(IPC.OPEN_EXTERNAL, url),

  // Platform info (renderer uses this to show Ctrl vs ⌘ in shortcuts)
  platform: process.platform,
};

// Re-export so non-preload modules can reference these types on results.
export type { ImportError, FaceBox, ModelDownloadProgress };

export type ElectronAPI = typeof api;

contextBridge.exposeInMainWorld('electronAPI', api);
