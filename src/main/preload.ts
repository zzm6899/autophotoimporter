import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/types';
import type { ImportConfig, AppSettings, MediaFile, Volume, ImportProgress, ImportResult, UpdateInfo, UpdateReleaseSummary, UpdateState, FtpConfig, FtpSyncStatus, ImportError, LicenseValidation, ImportPreflight, ImportBenchmarkQuery, ImportBenchmarkResult, ImportLedger, ImportHealthSummary, MacFirstRunDoctor, AppDiagnosticsSnapshot, UpdateRepairResult, AppSession, AppSessionSummary, WatchFolder, CatalogStats, CatalogBrowserQuery, CatalogBrowserResult, CatalogFaceSearchQuery, CatalogFaceSearchResult, CatalogFaceMetadataWriteResult, CatalogMaintenanceResult, CatalogPruneResult, CatalogBackupResult, CatalogClearSourceResult, ScanDiagnostics, LightroomHandoffResult, SessionFileRegistrationRequest, SessionFileRegistrationResult, SessionRestoreAbortRequest, SessionRestorePage, SessionRestorePageRequest, LocalFaceDataPurgeResult } from '../shared/types';
import type { FaceBox } from './services/face-engine';
import type { ModelDownloadProgress } from './services/model-downloader';
import type { PoseKeypoints } from '../shared/types';

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

const SESSION_REGISTRATION_CHUNK_SIZE = 10_000;
let sessionRegistrationSequence = 0;

async function invokeSessionRegistration(
  request: SessionFileRegistrationRequest,
): Promise<SessionFileRegistrationResult> {
  const result = await ipcRenderer.invoke(IPC.SESSION_REGISTER_FILES, request) as
    | SessionFileRegistrationResult
    | { ok: false; message?: string };
  if (!('generation' in result)) {
    throw new Error(result.message || 'Session file registration failed.');
  }
  return result;
}

async function registerSessionFiles(
  files: MediaFile[],
  restoreSessionId?: string,
): Promise<SessionFileRegistrationResult> {
  const generation = `restore-${Date.now().toString(36)}-${(++sessionRegistrationSequence).toString(36)}`;
  await invokeSessionRegistration({ action: 'begin', generation, totalFiles: files.length, restoreSessionId });
  for (let offset = 0; offset < files.length; offset += SESSION_REGISTRATION_CHUNK_SIZE) {
    await invokeSessionRegistration({
      action: 'append',
      generation,
      offset,
      files: files.slice(offset, offset + SESSION_REGISTRATION_CHUNK_SIZE),
    });
  }
  return invokeSessionRegistration({ action: 'finalize', generation });
}

async function saveSession(session: AppSession): Promise<AppSession> {
  const result = await ipcRenderer.invoke(IPC.SESSION_SAVE, session) as AppSession | { ok: false; message?: string };
  if (!('id' in result)) throw new Error(result.message || 'Session save failed.');
  return result;
}

async function getSessionRestorePage(request: SessionRestorePageRequest): Promise<SessionRestorePage> {
  const result = await ipcRenderer.invoke(IPC.SESSION_RESTORE_PAGE, request) as
    | SessionRestorePage
    | { ok: false; message?: string };
  if (!result || typeof result !== 'object' || !('generation' in result)) {
    throw new Error(result?.message || 'Session restore page failed.');
  }
  return result;
}

async function abortSessionRestore(request: SessionRestoreAbortRequest): Promise<boolean> {
  const result = await ipcRenderer.invoke(IPC.SESSION_RESTORE_ABORT, request) as
    | { generation: string; aborted: boolean }
    | { ok: false; message?: string };
  if (!result || typeof result !== 'object' || !('generation' in result) || !('aborted' in result)) {
    throw new Error(result?.message || 'Session restore abort failed.');
  }
  if (result.generation !== request.generation) throw new Error('Session restore abort generation changed.');
  return result.aborted;
}

async function getLatestSessionSummary(): Promise<AppSessionSummary | null> {
  const result = await ipcRenderer.invoke(IPC.SESSION_LATEST_SUMMARY) as
    | AppSessionSummary
    | null
    | { ok: false; message?: string };
  if (result === null) return null;
  if (!result || typeof result !== 'object' || !('id' in result) || !('stats' in result)) {
    throw new Error(result?.message || 'Session summary failed.');
  }
  return result;
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
  scanFiles: (sourcePath: string, folderPattern?: string, scanId?: string): Promise<void> =>
    ipcRenderer.invoke(IPC.SCAN_START, sourcePath, folderPattern, scanId),
  onScanBatch: (cb: (scanId: string, files: MediaFile[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, scanId: string, files: MediaFile[]) => cb(scanId, files);
    ipcRenderer.on(IPC.SCAN_BATCH, handler);
    return () => ipcRenderer.removeListener(IPC.SCAN_BATCH, handler);
  },
  onScanComplete: (cb: (scanId: string, totalFiles: number) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, scanId: string, total: number) => cb(scanId, total);
    ipcRenderer.on(IPC.SCAN_COMPLETE, handler);
    return () => ipcRenderer.removeListener(IPC.SCAN_COMPLETE, handler);
  },
  onScanThumbnail: (cb: (scanId: string, filePath: string, thumbnail: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, scanId: string, filePath: string, thumbnail: string) => cb(scanId, filePath, thumbnail);
    ipcRenderer.on(IPC.SCAN_THUMBNAIL, handler);
    return () => ipcRenderer.removeListener(IPC.SCAN_THUMBNAIL, handler);
  },
  checkDuplicates: (destRoot: string, scanId?: string): Promise<void> =>
    ipcRenderer.invoke(IPC.SCAN_CHECK_DUPLICATES, destRoot, scanId),
  onScanDuplicate: (cb: (scanId: string, filePath: string, duplicateMemory?: MediaFile['duplicateMemory'], duplicate?: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, scanId: string, filePath: string, duplicateMemory?: MediaFile['duplicateMemory'], duplicate?: boolean) => cb(scanId, filePath, duplicateMemory, duplicate);
    ipcRenderer.on(IPC.SCAN_DUPLICATE, handler);
    return () => ipcRenderer.removeListener(IPC.SCAN_DUPLICATE, handler);
  },
  onScanDiagnostics: (cb: (scanId: string, diagnostics: ScanDiagnostics) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, scanId: string, diagnostics: ScanDiagnostics) => cb(scanId, diagnostics);
    ipcRenderer.on(IPC.SCAN_DIAGNOSTICS, handler);
    return () => ipcRenderer.removeListener(IPC.SCAN_DIAGNOSTICS, handler);
  },
  getPreview: (filePath: string, variant?: 'preview' | 'detail' | 'thumb', priority?: 'high' | 'normal' | 'low'): Promise<{ src: string } | undefined> =>
    ipcRenderer.invoke(IPC.SCAN_PREVIEW, filePath, variant, priority),
  cancelScan: (): Promise<void> =>
    ipcRenderer.invoke(IPC.SCAN_CANCEL),
  pauseScan: (): Promise<void> =>
    ipcRenderer.invoke(IPC.SCAN_PAUSE),
  resumeScan: (): Promise<void> =>
    ipcRenderer.invoke(IPC.SCAN_RESUME),

  // Import
  startImport: (config: ImportConfig): Promise<ImportResult> =>
    ipcRenderer.invoke(IPC.IMPORT_START, config),
  preflightImport: (config: ImportConfig): Promise<ImportPreflight> =>
    ipcRenderer.invoke(IPC.IMPORT_PREFLIGHT, config),
  runImportBenchmark: (query: ImportBenchmarkQuery): Promise<ImportBenchmarkResult> =>
    ipcRenderer.invoke(IPC.IMPORT_BENCHMARK, query),
  retryFailedImport: (config: ImportConfig): Promise<ImportResult> =>
    ipcRenderer.invoke(IPC.IMPORT_RETRY_FAILED, config),
  getLatestImportLedger: (): Promise<ImportLedger | null> =>
    ipcRenderer.invoke(IPC.IMPORT_LEDGER_LATEST),
  getImportHealthSummary: (): Promise<ImportHealthSummary> =>
    ipcRenderer.invoke(IPC.IMPORT_HEALTH_SUMMARY),
  saveSession,
  getLatestSession: (): Promise<AppSession | null> =>
    ipcRenderer.invoke(IPC.SESSION_LATEST),
  getLatestSessionSummary,
  getSessionRestorePage,
  abortSessionRestore,
  registerSessionFiles,
  onSessionFlushRequest: (cb: (token: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, token: string) => cb(token);
    ipcRenderer.on(IPC.SESSION_FLUSH_REQUEST, handler);
    return () => ipcRenderer.removeListener(IPC.SESSION_FLUSH_REQUEST, handler);
  },
  acknowledgeSessionFlush: (token: string, success: boolean, message?: string): Promise<void> =>
    ipcRenderer.invoke(IPC.SESSION_FLUSH_ACK, token, success, message),
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
  exportDiagnostics: (): Promise<string> =>
    ipcRenderer.invoke(IPC.DIAGNOSTICS_EXPORT),
  getDiagnosticsSnapshot: (): Promise<AppDiagnosticsSnapshot> =>
    ipcRenderer.invoke(IPC.DIAGNOSTICS_SNAPSHOT),
  runBenchmarkSmoke: (): Promise<{ ok: boolean; outPath: string; files: number; bytes: number; records: number; error?: string }> =>
    ipcRenderer.invoke(IPC.BENCHMARK_SMOKE_RUN),
  openBenchmarkOutput: (): Promise<string> =>
    ipcRenderer.invoke(IPC.BENCHMARK_OPEN_OUTPUT),
  runMacFirstRunDoctor: (): Promise<MacFirstRunDoctor> =>
    ipcRenderer.invoke(IPC.MAC_FIRST_RUN_DOCTOR),

  // Settings
  getSettings: (): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.SETTINGS_GET),
  setSettings: (settings: Partial<AppSettings>): Promise<void> =>
    ipcRenderer.invoke(IPC.SETTINGS_SET, settings),
  getWatchFolders: (): Promise<WatchFolder[]> =>
    ipcRenderer.invoke(IPC.WATCH_FOLDERS_GET),
  setWatchFolders: (folders: WatchFolder[]): Promise<WatchFolder[]> =>
    ipcRenderer.invoke(IPC.WATCH_FOLDERS_SET, folders),
  getCatalogStats: (): Promise<CatalogStats> =>
    ipcRenderer.invoke(IPC.CATALOG_STATS),
  browseCatalog: (query: CatalogBrowserQuery = {}): Promise<CatalogBrowserResult> =>
    ipcRenderer.invoke(IPC.CATALOG_BROWSE, query),
  searchCatalogFaces: (query: CatalogFaceSearchQuery): Promise<CatalogFaceSearchResult> =>
    ipcRenderer.invoke(IPC.CATALOG_SEARCH_FACES, query),
  upsertCatalogFaceMetadata: (files: MediaFile[], sessionId?: string): Promise<CatalogFaceMetadataWriteResult> =>
    ipcRenderer.invoke(IPC.CATALOG_UPSERT_FACE_METADATA, files, sessionId),
  verifyCatalogMissingPaths: (): Promise<CatalogMaintenanceResult> =>
    ipcRenderer.invoke(IPC.CATALOG_VERIFY_MISSING),
  pruneCatalogMissingEntries: (): Promise<CatalogPruneResult> =>
    ipcRenderer.invoke(IPC.CATALOG_PRUNE_MISSING),
  exportCatalogBackup: (): Promise<CatalogBackupResult | null> =>
    ipcRenderer.invoke(IPC.CATALOG_EXPORT_BACKUP),
  clearCatalogSource: (sourcePath: string): Promise<CatalogClearSourceResult> =>
    ipcRenderer.invoke(IPC.CATALOG_CLEAR_SOURCE, sourcePath),
  onWatchFolderTriggered: (cb: (trigger: { folder: WatchFolder; eventType: string; filename?: string; triggeredAt: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, trigger: { folder: WatchFolder; eventType: string; filename?: string; triggeredAt: string }) => cb(trigger);
    ipcRenderer.on(IPC.WATCH_FOLDER_TRIGGERED, handler);
    return () => ipcRenderer.removeListener(IPC.WATCH_FOLDER_TRIGGERED, handler);
  },
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
  repairUpdates: (): Promise<UpdateRepairResult> =>
    ipcRenderer.invoke(IPC.UPDATE_REPAIR),

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
  exportLightroomHandoff: (files?: MediaFile[]): Promise<LightroomHandoffResult | null> =>
    ipcRenderer.invoke(IPC.EXPORT_LIGHTROOM_HANDOFF, files),
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
   *   { path, boxes, embeddings (hex strings), embeddingBoxes, faceCount, error? }
   */
  analyzeFaces: (
    paths: string | string[],
    options?: {
      profile?: 'detect' | 'subjects' | 'full';
      orientation?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
      /** Batch-aligned scan-time EXIF orientations; length must match paths. */
      orientations?: Array<1 | 2 | 3 | 4 | 5 | 6 | 7 | 8>;
      /** Scan-time identity hint; main verifies it against the registered source. */
      identity?: { size: number; mtimeMs: number };
      /** Batch-aligned scan-time file identities. */
      identities?: Array<{ size: number; mtimeMs: number }>;
      /** Enables sports-specific body-disagreement safeguards for this pass. */
      sportsMode?: boolean;
      /** Shortlist the strongest faces for local SFace similarity vectors. */
      embeddingLimit?: number;
    },
  ): Promise<Array<{
    path: string;
    boxes: FaceBox[];
    personBoxes: FaceBox[];
    embeddings: string[];
    embeddingBoxes: FaceBox[];
    faceLandmarks?: Array<ReadonlyArray<{ x: number; y: number }> | null>;
    poses?: PoseKeypoints[];
    faceCount: number;
    personCount: number;
    features?: {
      faceDetection: boolean;
      personDetection: boolean;
      faceMatching: boolean;
      poseAnalysis: boolean;
      /** False when the optional pose model is not installed. */
      poseAnalysisAvailable?: boolean;
      /** True when the opt-in alternate body detector was evaluated. */
      personFallback?: boolean;
      personFallbackExecuted?: boolean;
      personFallbackCorroborated?: boolean;
      /** True when per-face eye-detail measurement completed. */
      eyeDetail?: boolean;
      /** True when sports zero-evidence/disagreement safeguards completed. */
      sportsSafeguards?: boolean;
      fastFaceDetection?: boolean;
      fastPersonDetection?: boolean;
      faceLandmarks?: boolean;
      faceDetectorId?: string;
      personDetectorId?: string;
      detectorPipelineFingerprint?: string;
    };
    error?: string;
    /** Stable native-stage error code for retry policy (for example PREVIEW_PENDING). */
    errorCode?: string;
  }>> =>
    ipcRenderer.invoke(IPC.FACE_ANALYZE, paths, options),

  /** Cancel queued background face-analysis work. In-flight ONNX calls finish, but stale renderer batches are ignored. */
  cancelFaceAnalysis: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.FACE_CANCEL_QUEUE),

  /** Clear the on-disk thumbnail/preview cache. */
  clearCache: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.CACHE_CLEAR),

  /** Update how many whole-photo analyses run in parallel (1-16). */
  setFaceAnalysisConcurrency: (n: number): Promise<void> =>
    ipcRenderer.invoke('face:set-concurrency', n),

  /** Enumerate Windows display adapters for diagnostics (not DirectML device IDs). */
  listGpus: (): Promise<Array<{ id: number; name: string; adapterCompatibility?: string; videoMemoryMB?: number }>> =>
    ipcRenderer.invoke(IPC.GPU_LIST),

  /** Purge local face/subject AI cache, session evidence, and catalog evidence. */
  clearFaceCache: (): Promise<LocalFaceDataPurgeResult> =>
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
    productionFastDetectors: {
      state: 'unchecked' | 'active' | 'legacy-fallback';
      active: boolean;
      faceModel: string;
      personModel: string;
      faceProvider?: 'cpu' | 'dml';
      personProvider?: 'cpu' | 'dml';
      faceRuns: number;
      personRuns: number;
      ssdFallbacks: number;
      ssdFallbackRate: number | null;
      legacyFaceFallbacks: number;
      legacyPersonFallbacks: number;
      failure?: string;
    };
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
