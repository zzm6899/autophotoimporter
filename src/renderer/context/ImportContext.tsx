import { createContext, useContext, useReducer, useRef, useMemo, useCallback, useEffect, useState, type Dispatch, type ReactNode } from 'react';
import type { Volume, MediaFile, ImportProgress, ImportResult, SaveFormat, SourceKind, FtpConfig, FtpSyncSettings, FtpSyncStatus, RatingFilter, SelectionSet, LicenseValidation, WatermarkPosition, WatermarkMode, KeybindMap, MetadataExportFlags, ViewOverlayPreferences, EventMode, CullConfidence, KeeperQuota, SourceProfile, ImportConflictPolicy, AppSession, ExperienceMode, ScanDiagnostics } from '../../shared/types';
import { FOLDER_PRESETS, DEFAULT_KEYBINDS, DEFAULT_METADATA_EXPORT, DEFAULT_VIEW_OVERLAY_PREFERENCES } from '../../shared/types';
import { groupBursts } from '../../shared/burst';
import { clampStops, normalizeExposureStops } from '../../shared/exposure';
import { FACE_GROUP_EMBEDDING_THRESHOLD, assignSceneBuckets, autoCullGroup, bestInGroup, clearEmbeddingCache, configureReviewProfile, groupByFaceSimilarity, groupByVisualHash, humanMomentQuality, isAutoCullBulkDecisionEligible, isUsablyFocused, rankBestShots, scoreReview, selectKeepersToTarget } from '../../shared/review';
import { isPathInsideSourceRoot } from '../utils/sourcePath';
import { appendCatalogueFiles, applyIndexedCatalogueMapUpdates, applyIndexedCatalogueUpdates, getCataloguePathIndex, inheritCataloguePathIndex } from '../utils/catalogueDelta';
import { markSessionCheckpointRequired, markSessionPathsChanged, resetSessionChangeJournal, stageRestoredSessionBaseline } from '../utils/sessionChangeJournal';
import { stripLocalFaceAndSubjectData, stripSceneSubjectAnalysis } from '../../shared/face-data';

export type AppPhase = 'idle' | 'scanning' | 'ready' | 'importing' | 'complete';
export type ViewMode = 'grid' | 'single' | 'split' | 'compare' | 'settings';

export type FilterMode = 'all' | 'protected' | 'picked' | 'rejected' | 'unrated' | 'duplicates' | 'catalog-duplicates' | 'outside-source' | 'unmarked' | 'queue' | 'best' | 'faces' | 'face-groups' | 'face-gallery' | 'group-photos' | 'blur-risk' | 'near-duplicates' | 'review-needed' | 'needs-exposure' | 'normalized' | 'adjusted' | 'photos' | 'videos' | 'jpeg' | 'raw' | 'import-failures' | 'color-red' | 'color-yellow' | 'color-green' | 'color-blue' | 'color-purple' | RatingFilter | `camera:${string}` | `lens:${string}` | `date:${string}` | `ext:${string}` | `scene:${string}` | `burst:${string}` | `face:${string}`;
const MAX_FACE_CONCURRENCY = 16;
const REVIEW_OVERLAY_SMALL_DELAY_MS = 80;
const REVIEW_OVERLAY_MEDIUM_DELAY_MS = 140;
const REVIEW_OVERLAY_LARGE_DELAY_MS = 240;
const REVIEW_OVERLAY_HUGE_DELAY_MS = 5_000;
const REVIEW_OVERLAY_MILLION_DELAY_MS = 60_000;

function isExpensiveImportFilter(filter: FilterMode): boolean {
  return filter === 'face-gallery' || filter === 'face-groups' || filter.startsWith('face:');
}

function reviewOverlayDelayMs(fileCount: number): number {
  if (fileCount >= 250_000) return REVIEW_OVERLAY_MILLION_DELAY_MS;
  if (fileCount >= 50_000) return REVIEW_OVERLAY_HUGE_DELAY_MS;
  if (fileCount >= 2500) return REVIEW_OVERLAY_LARGE_DELAY_MS;
  if (fileCount >= 800) return REVIEW_OVERLAY_MEDIUM_DELAY_MS;
  return REVIEW_OVERLAY_SMALL_DELAY_MS;
}

/** Remove detector-dependent ROI evidence while retaining scene-only metrics. */
export function invalidateSceneSubjectAnalysis(
  analysis: MediaFile['sceneAnalysis'],
): MediaFile['sceneAnalysis'] {
  return stripSceneSubjectAnalysis(analysis);
}

interface State {
  volumes: Volume[];
  selectedSource: string | null;
  activeScanId: string | null;
  scanDiagnostics: ScanDiagnostics | null;
  files: MediaFile[];
  phase: AppPhase;
  scanError: string | null;
  destination: string | null;
  skipDuplicates: boolean;
  saveFormat: SaveFormat;
  jpegQuality: number;
  folderPreset: string;
  customPattern: string;
  importRunning: boolean;
  importQueuedCount: number;
  importProgress: ImportProgress | null;
  importResult: ImportResult | null;
  importFailedPaths: string[];
  focusedIndex: number;
  focusedPath: string | null;
  viewMode: ViewMode;
  previousViewMode: Exclude<ViewMode, 'settings'> | null;
  thumbnailSize: number;
  theme: 'light' | 'dark';
  experienceMode: ExperienceMode;
  showLeftPanel: boolean;
  showRightPanel: boolean;
  sourceKind: SourceKind;
  ftpConfig: FtpConfig;
  ftpStatus: 'idle' | 'probing' | 'mirroring' | 'error';
  ftpMessage: string | null;
  ftpProgress: { done: number; total: number; name: string } | null;
  ftpSyncSettings: FtpSyncSettings;
  ftpSyncStatus: FtpSyncStatus;
  filter: FilterMode;
  gridSortOrder: 'capture-asc' | 'capture-desc' | 'score-desc' | 'name-asc';
  cullMode: boolean;
  /**
   * File paths corresponding to the user's click-selection in the grid
   * (Cmd/Ctrl+Click, Shift+Click). Lives in the store — not as indices in the
   * grid — so the Import button can respect "I selected 40 of 10k" and only
   * import those 40.
   */
  selectedPaths: string[];
  queuedPaths: string[];
  selectionSets: SelectionSet[];
  scanPaused: boolean;
  fileHistory: MediaFile[][];
  // Workflow options
  separateProtected: boolean;
  protectedFolderName: string;
  backupDestRoot: string;
  ftpDestEnabled: boolean;
  ftpDestConfig: FtpConfig;
  autoEject: boolean;
  playSoundOnComplete: boolean;
  completeSoundPath: string;
  openFolderOnComplete: boolean;
  autoLightroomHandoff: boolean;
  verifyChecksums: boolean;
  sourceProfile: SourceProfile;
  conflictPolicy: ImportConflictPolicy;
  conflictFolderName: string;
  lastSessionId: string;
  autoImport: boolean;
  autoImportDestRoot: string;
  volumeImportQueue: string[];
  // Burst
  burstGrouping: boolean;
  burstWindowSec: number;
  collapsedBursts: string[]; // burstIds the user has hidden in the grid
  // Exposure
  normalizeExposure: boolean;
  exposureAnchorPath: string | null;
  exposureMaxStops: number;
  exposureAdjustmentStep: number;
  whiteBalanceTemperature?: number;
  whiteBalanceTint?: number;
  eventMode: EventMode;
  scheduleCsvPath: string;
  scheduleSheetUrl: string;
  cullConfidence: CullConfidence;
  groupPhotoEveryoneGood: boolean;
  keeperQuota: KeeperQuota;
  metadataKeywords: string;
  metadataTitle: string;
  metadataCaption: string;
  metadataCreator: string;
  metadataCopyright: string;
  watermarkEnabled: boolean;
  watermarkMode: WatermarkMode;
  watermarkText: string;
  watermarkImagePath: string;
  watermarkOpacity: number;
  watermarkPositionLandscape: WatermarkPosition;
  watermarkPositionPortrait: WatermarkPosition;
  watermarkScale: number;
  autoStraighten: boolean;
  licenseStatus: LicenseValidation | null;
  licenseHydrated: boolean;
  licensePromptOpen: boolean;
  licenseBannerDismissed: boolean;
  // Performance
  gpuFaceAcceleration: boolean;
  gpuDeviceId?: number;
  rawPreviewCache: boolean;
  cpuOptimization: boolean;
  rawPreviewQuality: number;
  reviewFaceAnalysis: boolean;
  reviewFaceMatching: boolean;
  reviewPersonDetection: boolean;
  reviewVisualDuplicates: boolean;
  autoSpeedMode: boolean;
  superSpeedMode: boolean;
  perfTier: 'auto' | 'low' | 'balanced' | 'high';
  fastKeeperMode: boolean;
  aiReviewEnabled: boolean;
  previewConcurrency: number;
  faceConcurrency: number;
  // Keybind customization
  keybinds: KeybindMap;
  // Metadata export control
  metadataExport: MetadataExportFlags;
  viewOverlayPreferences: ViewOverlayPreferences;
}

export type Action =
  | { type: 'SET_VOLUMES'; volumes: Volume[] }
  | { type: 'SELECT_SOURCE'; path: string | null }
  | { type: 'SCAN_START'; scanId?: string; sourcePath?: string }
  | { type: 'SCAN_BATCH'; files: MediaFile[]; scanId?: string }
  | { type: 'SCAN_COMPLETE'; scanId?: string }
  | { type: 'SCAN_DIAGNOSTICS'; scanId?: string; diagnostics: ScanDiagnostics }
  | { type: 'SCAN_ERROR'; message: string }
  | { type: 'SCAN_PAUSE' }
  | { type: 'SCAN_RESUME' }
  | { type: 'SET_DESTINATION'; path: string }
  | { type: 'SET_SKIP_DUPLICATES'; value: boolean }
  | { type: 'SET_SAVE_FORMAT'; format: SaveFormat }
  | { type: 'SET_JPEG_QUALITY'; quality: number }
  | { type: 'SET_FOLDER_PRESET'; preset: string }
  | { type: 'SET_CUSTOM_PATTERN'; pattern: string }
  | { type: 'IMPORT_START' }
  | { type: 'SET_IMPORT_QUEUE_DEPTH'; count: number }
  | { type: 'IMPORT_PROGRESS'; progress: ImportProgress }
  | { type: 'IMPORT_COMPLETE'; result: ImportResult }
  | { type: 'DISMISS_SUMMARY' }
  | { type: 'SET_THUMBNAIL'; filePath: string; thumbnail: string }
  | { type: 'SET_THUMBNAILS'; thumbnails: Record<string, string>; scanId?: string }
  | { type: 'SET_DUPLICATE'; filePath: string; duplicate?: boolean; duplicateMemory?: MediaFile['duplicateMemory']; scanId?: string }
  | { type: 'SET_DUPLICATES'; duplicates: Record<string, { duplicate?: boolean; duplicateMemory?: MediaFile['duplicateMemory'] }>; scanId?: string }
  | { type: 'CLEAR_DUPLICATES' }
  | { type: 'CLEAR_CATALOG_MEMORY_FOR_SOURCE'; sourcePath: string }
  | { type: 'SET_PICK'; filePath: string; pick: 'selected' | 'rejected' | undefined }
  | { type: 'SET_PICK_BATCH'; filePaths: string[]; pick: 'selected' | 'rejected' | undefined }
  | { type: 'CLEAR_PICKS' }
  | { type: 'SET_FOCUSED'; index: number; path?: string | null }
  | { type: 'SET_VIEW_MODE'; mode: ViewMode }
  | { type: 'SET_THUMBNAIL_SIZE'; size: number }
  | { type: 'SET_COLOR_LABEL'; filePath: string; label: MediaFile['colorLabel'] }
  | { type: 'SET_COLOR_LABEL_BATCH'; filePaths: string[]; label: MediaFile['colorLabel'] }
  | { type: 'SET_THEME'; theme: 'light' | 'dark' }
  | { type: 'SET_EXPERIENCE_MODE'; mode: ExperienceMode }
  | { type: 'TOGGLE_LEFT_PANEL' }
  | { type: 'TOGGLE_RIGHT_PANEL' }
  | { type: 'RESET_FILES' }
  | { type: 'SET_RATING'; filePath: string; rating: number }
  | { type: 'SET_SOURCE_KIND'; kind: SourceKind }
  | { type: 'SET_FTP_CONFIG'; config: Partial<FtpConfig> }
  | { type: 'SET_FTP_STATUS'; status: 'idle' | 'probing' | 'mirroring' | 'error'; message?: string | null }
  | { type: 'SET_FTP_PROGRESS'; progress: { done: number; total: number; name: string } | null }
  | { type: 'SET_FTP_SYNC_SETTINGS'; settings: Partial<FtpSyncSettings> }
  | { type: 'SET_FTP_SYNC_STATUS'; status: FtpSyncStatus }
  | { type: 'SET_FILTER'; filter: FilterMode }
  | { type: 'SET_GRID_SORT_ORDER'; order: 'capture-asc' | 'capture-desc' | 'score-desc' | 'name-asc' }
  | { type: 'TOGGLE_CULL_MODE' }
  | { type: 'SET_SELECTED_PATHS'; paths: string[] }
  | { type: 'QUEUE_ADD_PATHS'; paths: string[]; preserveFilter?: boolean }
  | { type: 'QUEUE_SET_PATHS'; paths: string[] }
  | { type: 'QUEUE_REMOVE_PATHS'; paths: string[] }
  | { type: 'QUEUE_CLEAR' }
  | { type: 'SET_SELECTION_SETS'; sets: SelectionSet[] }
  | { type: 'SELECTION_SET_SAVE'; name: string; paths: string[]; createdAt?: string }
  | { type: 'SELECTION_SET_DELETE'; name: string }
  | { type: 'SELECTION_SET_APPLY'; name: string }
  | { type: 'SET_WORKFLOW_OPTION'; key:
      | 'separateProtected' | 'autoEject' | 'playSoundOnComplete'
      | 'openFolderOnComplete' | 'autoImport'
      | 'burstGrouping' | 'normalizeExposure' | 'verifyChecksums' | 'ftpDestEnabled'
      | 'watermarkEnabled' | 'autoStraighten' | 'autoLightroomHandoff'; value: boolean }
  | { type: 'SET_WORKFLOW_STRING'; key:
      | 'protectedFolderName' | 'backupDestRoot' | 'autoImportDestRoot' | 'completeSoundPath'
      | 'metadataKeywords' | 'metadataTitle' | 'metadataCaption' | 'metadataCreator' | 'metadataCopyright'
      | 'watermarkText' | 'watermarkImagePath' | 'conflictFolderName' | 'lastSessionId' | 'scheduleCsvPath' | 'scheduleSheetUrl'; value: string }
  | { type: 'SET_SOURCE_PROFILE'; profile: SourceProfile }
  | { type: 'SET_CONFLICT_POLICY'; policy: ImportConflictPolicy }
  | { type: 'SET_WATERMARK_NUMBER'; key: 'watermarkOpacity' | 'watermarkScale'; value: number }
  | { type: 'SET_WATERMARK_POSITION'; orientation: 'landscape' | 'portrait'; position: WatermarkPosition }
  | { type: 'SET_WATERMARK_MODE'; mode: WatermarkMode }
  | { type: 'SET_FTP_DEST_CONFIG'; config: Partial<FtpConfig> }
  | { type: 'SET_BURST_WINDOW'; seconds: number }
  | { type: 'TOGGLE_BURST_COLLAPSE'; burstId: string }
  | { type: 'COLLAPSE_ALL_BURSTS' }
  | { type: 'CLEAR_COLLAPSED_BURSTS' }
  | { type: 'SET_EXPOSURE_ANCHOR'; path: string | null }
  /**
   * Clear the exposure anchor AND reset all per-file normalizeToAnchor flags
   * so no file silently imports with normalization against a missing anchor.
   */
  | { type: 'CLEAR_EXPOSURE_ANCHOR' }
  | { type: 'SET_EXPOSURE_MAX_STOPS'; stops: number }
  | { type: 'SET_EXPOSURE_ADJUSTMENT_STEP'; step: number }
  | { type: 'SET_WHITE_BALANCE'; temperature: number; tint: number }
  | { type: 'SET_WHITE_BALANCE_ADJUSTMENT'; filePaths: string[]; temperature: number; tint: number }
  | { type: 'SET_EVENT_MODE'; mode: EventMode }
  | { type: 'SET_CULL_CONFIDENCE'; confidence: CullConfidence }
  | { type: 'SET_GROUP_PHOTO_EVERYONE_GOOD'; enabled: boolean }
  | { type: 'SET_KEEPER_QUOTA'; quota: KeeperQuota }
  | { type: 'SET_NORMALIZE_TO_ANCHOR'; filePaths: string[]; value: boolean }
  | { type: 'SET_EXPOSURE_ADJUSTMENT'; filePaths: string[]; stops: number }
  | { type: 'NUDGE_EXPOSURE_ADJUSTMENT'; filePaths: string[]; delta: number }
  | { type: 'NORMALIZE_SELECTION_TO_FOCUSED'; filePaths: string[]; anchorPath: string }
  | { type: 'PICK_BURST_KEEPERS' }
  | { type: 'CULL_TO_TARGET'; target: number; perGroupCap?: number }
  | { type: 'SET_SHARPNESS_BATCH'; scores: Record<string, number> }
  | { type: 'SET_REVIEW_SCORES'; scores: Record<string, Partial<MediaFile>> }
  | { type: 'COMMIT_REVIEW_SCORES' }
  | { type: 'APPLY_REVIEW_SNAPSHOT'; files: MediaFile[] }
  | { type: 'RESOLVE_SECOND_PASS'; filePaths: string[]; pick: 'selected' | 'rejected' }
  | { type: 'GROUP_VISUAL_DUPLICATES'; threshold?: number; files?: MediaFile[] }
  | { type: 'GROUP_FACE_SIMILAR'; threshold?: number; embeddingThreshold?: number; files?: MediaFile[] }
  | { type: 'GROUP_SCENE_BUCKETS' }
  | { type: 'PICK_BEST_IN_GROUPS'; files?: MediaFile[] }
  | { type: 'QUEUE_BEST' }
  | { type: 'AUTO_CULL_SAFE'; files?: MediaFile[] }
  | { type: 'APPLY_AUTO_CULL_PROPOSAL'; keep: string[]; reject: string[] }
  | { type: 'SYNC_EDITS_FROM_FOCUSED'; filePath?: string }
  | { type: 'REJECT_DUPLICATES' }
  | { type: 'UNDO_FILE_EDIT' }
  /**
   * Pick the median-EV file among the given paths as the exposure anchor,
   * and mark every other path in the set as "normalize-to-anchor". This is
   * the one-shot "make this batch consistent" workflow for bulk selection.
   */
  | { type: 'NORMALIZE_SELECTION_TO_MEDIAN'; filePaths: string[] }
  /**
   * Wipe faceBoxes + subjectSharpnessScore from every photo so the background
   * reviewer re-runs analyzeSubject with the now-available FaceDetector.
   */
  | { type: 'CLEAR_FACE_DATA' }
  | { type: 'SET_VOLUME_IMPORT_QUEUE'; paths: string[] }
  | { type: 'ADVANCE_VOLUME_IMPORT_QUEUE' }
  | { type: 'HYDRATE_LICENSE_STATUS'; status: LicenseValidation | null }
  | { type: 'SET_LICENSE_STATUS'; status: LicenseValidation | null }
  | { type: 'OPEN_LICENSE_PROMPT' }
  | { type: 'CLOSE_LICENSE_PROMPT' }
  | { type: 'DISMISS_LICENSE_BANNER' }
  | { type: 'SET_PERFORMANCE_OPTION'; key: 'gpuFaceAcceleration' | 'rawPreviewCache' | 'cpuOptimization'; value: boolean }
  | { type: 'SET_REVIEW_PERFORMANCE_OPTION'; key: 'reviewFaceAnalysis' | 'reviewFaceMatching' | 'reviewPersonDetection' | 'reviewVisualDuplicates'; value: boolean }
  | { type: 'SET_GPU_DEVICE_ID'; deviceId: number }
  | { type: 'SET_RAW_PREVIEW_QUALITY'; quality: number }
  | { type: 'SET_PERF_TIER'; tier: 'auto' | 'low' | 'balanced' | 'high' }
  | { type: 'SET_FAST_KEEPER_MODE'; enabled: boolean }
  | { type: 'SET_AI_REVIEW_ENABLED'; enabled: boolean }
  | { type: 'SET_AUTO_SPEED_MODE'; enabled: boolean }
  | { type: 'SET_SUPER_SPEED_MODE'; enabled: boolean }
  | { type: 'SET_PREVIEW_CONCURRENCY'; concurrency: number }
  | { type: 'SET_FACE_CONCURRENCY'; concurrency: number }
  | { type: 'SET_KEYBIND'; action: keyof KeybindMap; key: string }
  | { type: 'SET_KEYBINDS'; keybinds: Partial<KeybindMap> }
  | { type: 'RESET_KEYBINDS' }
  | { type: 'SET_METADATA_EXPORT'; flags: Partial<MetadataExportFlags> }
  | { type: 'SET_VIEW_OVERLAY_PREFERENCES'; preferences: Partial<ViewOverlayPreferences> }
  | { type: 'RESTORE_SESSION'; session: AppSession };

/**
 * Record the small set of durable file rows touched by an action. Thumbnail
 * URLs are intentionally excluded from sessions, so their high-frequency
 * updates never dirty persistence.
 */
function trackSessionFileChanges(action: Action): void {
  switch (action.type) {
    case 'SELECT_SOURCE':
    case 'SCAN_START':
    case 'RESET_FILES':
    case 'ADVANCE_VOLUME_IMPORT_QUEUE':
      resetSessionChangeJournal(true);
      return;
    case 'RESTORE_SESSION':
      stageRestoredSessionBaseline(action.session);
      return;
    case 'SET_THUMBNAIL':
    case 'SET_THUMBNAILS':
    case 'SCAN_BATCH':
    case 'SCAN_COMPLETE':
      return;
    case 'SET_DUPLICATE':
    case 'SET_PICK':
    case 'SET_COLOR_LABEL':
    case 'SET_RATING':
      markSessionPathsChanged([action.filePath]);
      return;
    case 'SET_DUPLICATES':
      markSessionPathsChanged(Object.keys(action.duplicates));
      return;
    case 'SET_PICK_BATCH':
    case 'SET_COLOR_LABEL_BATCH':
    case 'SET_WHITE_BALANCE_ADJUSTMENT':
    case 'SET_NORMALIZE_TO_ANCHOR':
    case 'SET_EXPOSURE_ADJUSTMENT':
    case 'NUDGE_EXPOSURE_ADJUSTMENT':
    case 'RESOLVE_SECOND_PASS':
      markSessionPathsChanged(action.filePaths);
      return;
    case 'NORMALIZE_SELECTION_TO_FOCUSED':
    case 'NORMALIZE_SELECTION_TO_MEDIAN':
      markSessionPathsChanged(action.filePaths);
      return;
    case 'SET_SHARPNESS_BATCH':
      markSessionPathsChanged(Object.keys(action.scores));
      return;
    case 'SET_REVIEW_SCORES':
      markSessionPathsChanged(Object.keys(action.scores));
      return;
    case 'APPLY_AUTO_CULL_PROPOSAL':
      markSessionPathsChanged([...action.keep, ...action.reject]);
      return;
    case 'SET_WORKFLOW_OPTION':
      if (action.key === 'burstGrouping') markSessionCheckpointRequired();
      return;
    case 'CLEAR_DUPLICATES':
    case 'CLEAR_CATALOG_MEMORY_FOR_SOURCE':
    case 'CLEAR_PICKS':
    case 'SET_BURST_WINDOW':
    case 'SET_EVENT_MODE':
    case 'CLEAR_EXPOSURE_ANCHOR':
    case 'PICK_BURST_KEEPERS':
    case 'CULL_TO_TARGET':
    case 'APPLY_REVIEW_SNAPSHOT':
    case 'GROUP_VISUAL_DUPLICATES':
    case 'GROUP_FACE_SIMILAR':
    case 'GROUP_SCENE_BUCKETS':
    case 'PICK_BEST_IN_GROUPS':
    case 'AUTO_CULL_SAFE':
    case 'SYNC_EDITS_FROM_FOCUSED':
    case 'REJECT_DUPLICATES':
    case 'UNDO_FILE_EDIT':
    case 'CLEAR_FACE_DATA':
      markSessionCheckpointRequired();
      return;
    default:
      return;
  }
}

const systemDark = typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;

const initialState: State = {
  volumes: [],
  selectedSource: null,
  activeScanId: null,
  scanDiagnostics: null,
  files: [],
  phase: 'idle',
  scanError: null,
  destination: null,
  skipDuplicates: true,
  saveFormat: 'original' as SaveFormat,
  jpegQuality: 90,
  folderPreset: 'date-flat',
  customPattern: FOLDER_PRESETS['date-flat'].pattern,
  importRunning: false,
  importQueuedCount: 0,
  importProgress: null,
  importResult: null,
  importFailedPaths: [],
  focusedIndex: -1,
  focusedPath: null,
  viewMode: 'grid' as ViewMode,
  previousViewMode: null,
  thumbnailSize: 160,
  theme: systemDark ? 'dark' : 'light',
  experienceMode: 'simple',
  showLeftPanel: true,
  showRightPanel: true,
  sourceKind: 'volume',
  ftpConfig: {
    host: '',
    port: 21,
    user: '',
    password: '',
    secure: false,
    remotePath: '/DCIM',
  },
  ftpStatus: 'idle',
  ftpMessage: null,
  ftpProgress: null,
  ftpSyncSettings: {
    enabled: false,
    runOnLaunch: true,
    intervalMinutes: 15,
    localDestRoot: '',
    reuploadToFtpDest: false,
  },
  ftpSyncStatus: {
    state: 'idle',
    stage: 'idle',
    message: 'FTP sync is idle.',
  },
  filter: 'all',
  gridSortOrder: 'capture-asc',
  cullMode: false,
  selectedPaths: [],
  queuedPaths: [],
  selectionSets: [],
  scanPaused: false,
  fileHistory: [],
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
    remotePath: '/Keptra',
  },
  autoEject: false,
  playSoundOnComplete: false,
  completeSoundPath: '',
  openFolderOnComplete: false,
  autoLightroomHandoff: false,
  verifyChecksums: false,
  sourceProfile: 'auto',
  conflictPolicy: 'rename',
  conflictFolderName: '_Conflicts',
  lastSessionId: '',
  autoImport: false,
  autoImportDestRoot: '',
  volumeImportQueue: [],
  burstGrouping: true,
  burstWindowSec: 2,
  collapsedBursts: [],
  normalizeExposure: false,
  exposureAnchorPath: null,
  exposureMaxStops: 2,
  exposureAdjustmentStep: 0.33,
  whiteBalanceTemperature: 0,
  whiteBalanceTint: 0,
  eventMode: 'general',
  scheduleCsvPath: '',
  scheduleSheetUrl: '',
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
  licenseStatus: null,
  licenseHydrated: false,
  licensePromptOpen: false,
  licenseBannerDismissed: false,
  gpuFaceAcceleration: true,
  gpuDeviceId: -1,
  rawPreviewCache: true,
  cpuOptimization: true,
  rawPreviewQuality: 70,
  reviewFaceAnalysis: true,
  // Local similar-face grouping is an explicit user choice. Face/body/eye
  // quality culling remains available without storing identity embeddings.
  reviewFaceMatching: false,
  reviewPersonDetection: true,
  reviewVisualDuplicates: true,
  autoSpeedMode: false,
  superSpeedMode: true,
  perfTier: 'auto',
  fastKeeperMode: false,
  aiReviewEnabled: true,
  previewConcurrency: 3,
  faceConcurrency: 2,
  keybinds: { ...DEFAULT_KEYBINDS },
  metadataExport: { ...DEFAULT_METADATA_EXPORT },
  viewOverlayPreferences: { ...DEFAULT_VIEW_OVERLAY_PREFERENCES },
};

function withFileHistory(state: State, files: MediaFile[]): State {
  const historyLimit = files.length >= 250_000 ? 3 : files.length >= 50_000 ? 8 : 20;
  inheritCataloguePathIndex(state.files, files);
  return {
    ...state,
    files,
    fileHistory: [state.files, ...state.fileHistory].slice(0, historyLimit),
  };
}

function withFileHistoryIfChanged(state: State, files: MediaFile[]): State {
  if (files.length === state.files.length && files.every((file, index) => file === state.files[index])) {
    return state;
  }
  return withFileHistory(state, files);
}

function withIndexedFileHistoryUpdate<U>(
  state: State,
  updates: ReadonlyMap<string, U>,
  update: (file: MediaFile, value: U) => MediaFile,
): State {
  const result = applyIndexedCatalogueMapUpdates(state.files, updates, update);
  return result.files === state.files ? state : withFileHistory(state, result.files);
}

function constantPathUpdates<U>(paths: readonly string[], value: U): Map<string, U> {
  const updates = new Map<string, U>();
  for (const filePath of paths) updates.set(filePath, value);
  return updates;
}

function sameWhiteBalanceAdjustment(
  a: MediaFile['whiteBalanceAdjustment'],
  b: MediaFile['whiteBalanceAdjustment'],
): boolean {
  if (!a && !b) return true;
  return a?.temperature === b?.temperature && a?.tint === b?.tint;
}

function collectReviewGroups(files: MediaFile[]): Map<string, MediaFile[]> {
  const groups = new Map<string, MediaFile[]>();
  const addToGroup = (id: string, file: MediaFile) => {
    const group = groups.get(id);
    if (group) group.push(file);
    else groups.set(id, [file]);
  };

  for (const f of files) {
    if (f.burstId && f.burstSize && f.burstSize > 1) {
      addToGroup(`burst:${f.burstId}`, f);
    }
    if (f.visualGroupId && f.visualGroupSize && f.visualGroupSize > 1) {
      addToGroup(`visual:${f.visualGroupId}`, f);
    }
  }
  return groups;
}

function normalizeKnownPaths(files: MediaFile[], paths: string[]): string[] {
  const valid = new Set(files.map((file) => file.path));
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const path of paths) {
    if (!valid.has(path) || seen.has(path)) continue;
    seen.add(path);
    normalized.push(path);
  }
  return normalized;
}

export function queueBestPaths(
  files: MediaFile[],
  options: { eventMode?: EventMode; cullConfidence?: CullConfidence; groupPhotoEveryoneGood?: boolean; keeperQuota?: KeeperQuota; skipDuplicates?: boolean } = {},
): string[] {
  const skipDuplicates = options.skipDuplicates ?? true;
  const eventMode = options.eventMode ?? 'general';
  const eligible = files.filter((f) => f.type === 'photo' && f.pick !== 'rejected' && (!skipDuplicates || !f.duplicate));
  const automaticEligible = (file: MediaFile) =>
    file.pick === 'selected' || file.isProtected || (file.rating ?? 0) > 0 ||
    (isAutoCullBulkDecisionEligible(file, eventMode) && isUsablyFocused(file));
  const groups = collectReviewGroups(eligible);
  const groupedPaths = new Set<string>();
  const queued = new Set<string>();

  for (const group of groups.values()) {
    for (const f of group) {
      groupedPaths.add(f.path);
      if (f.pick === 'selected' || f.isProtected || (f.rating ?? 0) > 0) queued.add(f.path);
    }
    const ranked = rankBestShots(group);
    const best = ranked.find(automaticEligible) ?? null;
    if (best) queued.add(best.path);

    if (options.cullConfidence === 'conservative') {
      const decision = autoCullGroup(group, {
        confidence: options.cullConfidence,
        groupPhotoEveryoneGood: options.groupPhotoEveryoneGood,
        keeperQuota: options.keeperQuota,
      });
      for (const path of decision.keep) queued.add(path);
    }

    const quota = options.keeperQuota ?? 'best-1';
    const autoCandidates = ranked.filter(automaticEligible);
    if (quota === 'top-2') {
      for (const file of autoCandidates.slice(0, 2)) queued.add(file.path);
    } else if (quota === 'smile-and-sharp') {
      const expressionScore = (file: MediaFile) => {
        const boxes = file.faceBoxes ?? [];
        if (boxes.length === 0) return 0;
        return boxes.reduce((bestExpression, box) => Math.max(bestExpression, box.smileScore ?? box.expressionScore ?? 0.5), 0);
      };
      const smileBest = autoCandidates.slice().sort((a, b) =>
        expressionScore(b) - expressionScore(a) ||
        humanMomentQuality(b) - humanMomentQuality(a),
      )[0];
      const sharpBest = autoCandidates.slice().sort((a, b) =>
        (b.subjectSharpnessScore ?? b.sharpnessScore ?? 0) - (a.subjectSharpnessScore ?? a.sharpnessScore ?? 0),
      )[0];
      if (smileBest) queued.add(smileBest.path);
      if (sharpBest) queued.add(sharpBest.path);
    }
  }

  for (const f of eligible) {
    if (!groupedPaths.has(f.path) && automaticEligible(f)) {
      queued.add(f.path);
    }
  }

  return eligible.filter((f) => queued.has(f.path)).map((f) => f.path);
}

function createEmptyScanDiagnostics(scanId: string | undefined, sourcePath: string | undefined): ScanDiagnostics {
  return {
    scanId,
    sourcePath,
    filesFound: 0,
    hiddenOrSystemEntriesSkipped: 0,
    inaccessibleDirectories: 0,
    statFailures: 0,
    catalogDuplicatesMarked: 0,
    staleEventsIgnored: 0,
  };
}

function withStaleScanEventIgnored(state: State): State {
  const diagnostics = state.scanDiagnostics ?? createEmptyScanDiagnostics(state.activeScanId ?? undefined, state.selectedSource ?? undefined);
  return {
    ...state,
    scanDiagnostics: {
      ...diagnostics,
      staleEventsIgnored: diagnostics.staleEventsIgnored + 1,
    },
  };
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'SET_VOLUMES':
      return { ...state, volumes: action.volumes };
    case 'SELECT_SOURCE':
      // Clear exposure anchor — its path belongs to the old source and would
      // resolve to `undefined` in `files.find()` once the new scan lands.
      return { ...state, selectedSource: action.path, activeScanId: null, scanDiagnostics: null, files: [], phase: 'idle', exposureAnchorPath: null, queuedPaths: [], selectedPaths: [], focusedPath: null };
    case 'SCAN_START':
      return {
        ...state,
        activeScanId: action.scanId ?? null,
        scanDiagnostics: createEmptyScanDiagnostics(action.scanId, action.sourcePath ?? state.selectedSource ?? undefined),
        files: [],
        phase: 'scanning',
        scanError: null,
        focusedIndex: -1,
        focusedPath: null,
        exposureAnchorPath: null,
        scanPaused: false,
        queuedPaths: [],
        selectedPaths: [],
        filter: 'all',
        collapsedBursts: [],
      };
    case 'SCAN_BATCH':
      if (state.phase !== 'scanning') return state;
      if (action.scanId && state.activeScanId && action.scanId !== state.activeScanId) return withStaleScanEventIgnored(state);
      return { ...state, files: appendCatalogueFiles(state.files, action.files) };
    case 'SCAN_COMPLETE': {
      // Guard: ignore stale SCAN_COMPLETE events that arrive after a new
      // SCAN_START has already been dispatched (or after import began).
      // This prevents a cancelled scan's completion from resetting the
      // phase to 'idle' before the new scan's batches arrive.
      if (state.phase !== 'scanning') return state;
      if (action.scanId && state.activeScanId && action.scanId !== state.activeScanId) return withStaleScanEventIgnored(state);
      // Bursts can only be reliably grouped once every file has a parsed
      // dateTaken, so we do it here (not per-batch). If the user has toggled
      // grouping off, just drop any stale burst data.
      const burstGrouped = state.burstGrouping
        ? groupBursts(state.files, { windowSec: state.burstWindowSec })
        : state.files.map((f) => {
            if (f.burstId || f.burstIndex || f.burstSize) {
              const { burstId: _b, burstIndex: _i, burstSize: _s, ...rest } = f;
              return rest;
            }
            return f;
          });
      const grouped = assignSceneBuckets(burstGrouped, state.eventMode);
      inheritCataloguePathIndex(state.files, grouped);
      return {
        ...state,
        files: grouped,
        phase: state.files.length > 0 ? 'ready' : 'idle',
        scanPaused: false,
        // Reset collapsed state on every rescan — otherwise old IDs accumulate
        collapsedBursts: [],
      };
    }
    case 'SCAN_DIAGNOSTICS':
      if (action.scanId && state.activeScanId && action.scanId !== state.activeScanId) return withStaleScanEventIgnored(state);
      return {
        ...state,
        scanDiagnostics: {
          ...action.diagnostics,
          staleEventsIgnored: state.scanDiagnostics?.staleEventsIgnored ?? action.diagnostics.staleEventsIgnored,
        },
      };
    case 'SCAN_ERROR':
      return { ...state, activeScanId: null, scanDiagnostics: null, phase: 'idle', scanError: action.message, scanPaused: false };
    case 'SCAN_PAUSE':
      return { ...state, scanPaused: true };
    case 'SCAN_RESUME':
      return { ...state, scanPaused: false };
    case 'SET_DESTINATION':
      return { ...state, destination: action.path };
    case 'SET_SKIP_DUPLICATES':
      return { ...state, skipDuplicates: action.value };
    case 'SET_SAVE_FORMAT':
      return { ...state, saveFormat: action.format };
    case 'SET_JPEG_QUALITY':
      return { ...state, jpegQuality: action.quality };
    case 'SET_FOLDER_PRESET':
      return { ...state, folderPreset: action.preset };
    case 'SET_CUSTOM_PATTERN':
      return { ...state, customPattern: action.pattern };
    case 'IMPORT_START':
      return {
        ...state,
        phase: state.phase === 'scanning' || state.phase === 'complete'
          ? (state.files.length > 0 ? 'ready' : 'idle')
          : state.phase,
        filter: isExpensiveImportFilter(state.filter) ? 'all' : state.filter,
        importRunning: true,
        importProgress: null,
        importResult: null,
        importFailedPaths: [],
      };
    case 'SET_IMPORT_QUEUE_DEPTH':
      return { ...state, importQueuedCount: Math.max(0, Math.floor(action.count)) };
    case 'IMPORT_PROGRESS':
      return { ...state, importProgress: action.progress };
    case 'IMPORT_COMPLETE': {
      const failedPaths = (action.result.ledgerItems ?? [])
        .filter((item) => item.status === 'failed' || item.status === 'pending')
        .map((item) => item.sourcePath);
      return { ...state, phase: 'complete', importRunning: false, importResult: action.result, importFailedPaths: failedPaths };
    }
    case 'DISMISS_SUMMARY':
      // If there are no files in the list (e.g. after auto-import cleared them),
      // return to idle rather than 'ready' — avoids a blank ready-but-empty state.
      return {
        ...state,
        phase: state.files.length > 0 ? 'ready' : 'idle',
        importRunning: false,
        importQueuedCount: 0,
        importResult: null,
        importProgress: null,
        filter: state.filter === 'import-failures' ? 'all' : state.filter,
      };
    case 'SET_THUMBNAIL':
      {
        const result = applyIndexedCatalogueUpdates(
          state.files,
          { [action.filePath]: action.thumbnail },
          (file, thumbnail) => thumbnail === file.thumbnail ? file : { ...file, thumbnail },
        );
        return result.files === state.files ? state : { ...state, files: result.files };
      }
    case 'SET_THUMBNAILS': {
      if (action.scanId && state.activeScanId && action.scanId !== state.activeScanId) return withStaleScanEventIgnored(state);
      const result = applyIndexedCatalogueUpdates(
        state.files,
        action.thumbnails,
        (file, thumbnail) => thumbnail === file.thumbnail ? file : { ...file, thumbnail },
      );
      return result.files === state.files ? state : { ...state, files: result.files };
    }
    case 'SET_DUPLICATE':
      if (action.scanId && state.activeScanId && action.scanId !== state.activeScanId) return withStaleScanEventIgnored(state);
      {
        const result = applyIndexedCatalogueUpdates(
          state.files,
          { [action.filePath]: { duplicate: action.duplicate, duplicateMemory: action.duplicateMemory } },
          (file, update) => ({
            ...file,
            // `duplicate` is deliberately limited to the active output
            // folder. Catalog memory is useful context, but it must not stop
            // a photographer importing the source elsewhere.
            duplicate: update.duplicate === true || (update.duplicate === undefined && !update.duplicateMemory),
            duplicateMemory: update.duplicateMemory ?? file.duplicateMemory,
          }),
        );
        return result.files === state.files ? state : { ...state, files: result.files };
      }
    case 'SET_DUPLICATES': {
      if (action.scanId && state.activeScanId && action.scanId !== state.activeScanId) return withStaleScanEventIgnored(state);
      const result = applyIndexedCatalogueUpdates(
        state.files,
        action.duplicates,
        (file, update) => ({
          ...file,
          duplicate: update.duplicate === true || (update.duplicate === undefined && !update.duplicateMemory),
          duplicateMemory: update.duplicateMemory ?? file.duplicateMemory,
        }),
      );
      return result.files === state.files ? state : { ...state, files: result.files };
    }
    case 'CLEAR_DUPLICATES':
      return {
        ...state,
        files: state.files.map((f) => ({ ...f, duplicate: false })),
      };
    case 'CLEAR_CATALOG_MEMORY_FOR_SOURCE':
      return {
        ...state,
        files: state.files.map((f) => {
          if (!f.duplicateMemory || !isPathInsideSourceRoot(action.sourcePath, f.path)) return f;
          return { ...f, duplicate: false, duplicateMemory: undefined };
        }),
        scanDiagnostics: state.scanDiagnostics
          ? { ...state.scanDiagnostics, catalogDuplicatesMarked: 0 }
          : state.scanDiagnostics,
      };
    case 'SET_PICK':
      return withIndexedFileHistoryUpdate(
        state,
        new Map([[action.filePath, action.pick]]),
        (file, pick) => file.pick === pick ? file : { ...file, pick },
      );
    case 'SET_PICK_BATCH': {
      return withIndexedFileHistoryUpdate(
        state,
        constantPathUpdates(action.filePaths, action.pick),
        (file, pick) => file.pick === pick ? file : { ...file, pick },
      );
    }
    case 'CLEAR_PICKS':
      return withFileHistory(state, state.files.map((f) => ({ ...f, pick: undefined })));
    case 'SET_FOCUSED':
      return {
        ...state,
        focusedIndex: action.index,
        // Use !== undefined to distinguish explicit null (clear) from omitted path (use index fallback).
        // action.index here is a sorted-view index and should not be used to index state.files directly;
        // callers are expected to pass path explicitly when index refers to a filtered/sorted position.
        focusedPath: action.path !== undefined ? action.path : (action.index >= 0 ? state.files[action.index]?.path ?? null : null),
      };
    case 'SET_VIEW_MODE':
      if (action.mode === 'settings') {
        return {
          ...state,
          viewMode: 'settings',
          previousViewMode: state.viewMode === 'settings'
            ? state.previousViewMode
            : state.viewMode as Exclude<ViewMode, 'settings'>,
        };
      }
      if (state.viewMode === 'settings' && action.mode === 'grid' && state.previousViewMode) {
        return { ...state, viewMode: state.previousViewMode, previousViewMode: null };
      }
      return { ...state, viewMode: action.mode };
    case 'SET_THUMBNAIL_SIZE':
      return { ...state, thumbnailSize: Math.max(80, Math.min(320, action.size)) };
    case 'SET_COLOR_LABEL':
      return withIndexedFileHistoryUpdate(
        state,
        new Map([[action.filePath, action.label]]),
        (file, colorLabel) => file.colorLabel === colorLabel ? file : { ...file, colorLabel },
      );
    case 'SET_COLOR_LABEL_BATCH': {
      return withIndexedFileHistoryUpdate(
        state,
        constantPathUpdates(action.filePaths, action.label),
        (file, colorLabel) => file.colorLabel === colorLabel ? file : { ...file, colorLabel },
      );
    }
    case 'SET_THEME':
      return { ...state, theme: action.theme };
    case 'SET_EXPERIENCE_MODE':
      return {
        ...state,
        experienceMode: action.mode,
        sourceKind: action.mode === 'simple' && state.sourceKind === 'ftp' ? 'volume' : state.sourceKind,
      };
    case 'TOGGLE_LEFT_PANEL':
      return { ...state, showLeftPanel: !state.showLeftPanel };
    case 'TOGGLE_RIGHT_PANEL':
      return { ...state, showRightPanel: !state.showRightPanel };
    case 'RESET_FILES':
      return { ...state, files: [], phase: 'idle', focusedIndex: -1, focusedPath: null, queuedPaths: [], selectedPaths: [] };
    case 'SET_RATING':
      return withIndexedFileHistoryUpdate(
        state,
        new Map([[action.filePath, action.rating]]),
        (file, rating) => file.rating === rating ? file : { ...file, rating },
      );
    case 'SET_SOURCE_KIND':
      return { ...state, sourceKind: action.kind };
    case 'SET_FTP_CONFIG':
      return { ...state, ftpConfig: { ...state.ftpConfig, ...action.config } };
    case 'SET_FTP_DEST_CONFIG':
      return { ...state, ftpDestConfig: { ...state.ftpDestConfig, ...action.config } };
    case 'SET_FTP_STATUS':
      return {
        ...state,
        ftpStatus: action.status,
        ftpMessage: action.message !== undefined ? action.message : state.ftpMessage,
      };
    case 'SET_FTP_PROGRESS':
      return { ...state, ftpProgress: action.progress };
    case 'SET_FTP_SYNC_SETTINGS':
      return { ...state, ftpSyncSettings: { ...state.ftpSyncSettings, ...action.settings } };
    case 'SET_FTP_SYNC_STATUS':
      return { ...state, ftpSyncStatus: action.status };
    case 'SET_FILTER':
      return { ...state, filter: action.filter };
    case 'SET_GRID_SORT_ORDER':
      return { ...state, gridSortOrder: action.order };
    case 'TOGGLE_CULL_MODE':
      return { ...state, cullMode: !state.cullMode, viewMode: !state.cullMode ? 'single' : 'grid' };
    case 'SET_SELECTED_PATHS':
      return { ...state, selectedPaths: normalizeKnownPaths(state.files, action.paths) };
    case 'QUEUE_ADD_PATHS': {
      const valid = new Set(state.files.map((f) => f.path));
      const next = new Set(state.queuedPaths);
      for (const p of action.paths) if (valid.has(p)) next.add(p);
      return { ...state, queuedPaths: [...next], filter: !action.preserveFilter && next.size > 0 ? 'queue' : state.filter };
    }
    case 'QUEUE_SET_PATHS': {
      const valid = new Set(state.files.map((f) => f.path));
      const next = [...new Set(action.paths)].filter((p) => valid.has(p));
      return { ...state, queuedPaths: next, filter: next.length > 0 ? 'queue' : state.filter === 'queue' ? 'all' : state.filter };
    }
    case 'QUEUE_REMOVE_PATHS': {
      const remove = new Set(action.paths);
      return { ...state, queuedPaths: state.queuedPaths.filter((p) => !remove.has(p)) };
    }
    case 'QUEUE_CLEAR':
      return { ...state, queuedPaths: [], filter: state.filter === 'queue' ? 'all' : state.filter };
    case 'SET_SELECTION_SETS':
      return { ...state, selectionSets: action.sets };
    case 'SELECTION_SET_SAVE': {
      const valid = getCataloguePathIndex(state.files);
      const paths = [...new Set(action.paths)].filter((p) => valid.has(p));
      if (paths.length === 0) return state;
      const set: SelectionSet = {
        name: action.name.trim(),
        paths,
        createdAt: action.createdAt ?? new Date().toISOString(),
      };
      if (!set.name) return state;
      return { ...state, selectionSets: [...state.selectionSets.filter((s) => s.name !== set.name), set] };
    }
    case 'SELECTION_SET_DELETE':
      return { ...state, selectionSets: state.selectionSets.filter((s) => s.name !== action.name) };
    case 'SELECTION_SET_APPLY': {
      const set = state.selectionSets.find((s) => s.name === action.name);
      if (!set) return state;
      const valid = getCataloguePathIndex(state.files);
      return { ...state, selectedPaths: set.paths.filter((p) => valid.has(p)) };
    }
    case 'SET_WORKFLOW_OPTION': {
      const next = { ...state, [action.key]: action.value } as State;
      // Toggling burst grouping live — re-run the grouper so the grid
      // reflects the change without requiring a rescan.
      if (action.key === 'burstGrouping') {
        next.files = action.value
          ? groupBursts(state.files, { windowSec: state.burstWindowSec })
          : state.files.map((f) => {
              if (f.burstId || f.burstIndex || f.burstSize) {
                const { burstId: _b, burstIndex: _i, burstSize: _s, ...rest } = f;
                return rest;
              }
              return f;
            });
        inheritCataloguePathIndex(state.files, next.files);
        next.collapsedBursts = [];
      }
      return next;
    }
    case 'SET_WORKFLOW_STRING':
      return { ...state, [action.key]: action.value } as State;
    case 'SET_SOURCE_PROFILE': {
      const cardSafeConflictPolicy = state.conflictPolicy === 'skip' ? 'rename' : state.conflictPolicy;
      if (action.profile === 'ssd') {
        return { ...state, sourceProfile: action.profile, conflictPolicy: cardSafeConflictPolicy, previewConcurrency: Math.max(4, state.previewConcurrency), faceConcurrency: Math.max(2, state.faceConcurrency), rawPreviewQuality: Math.max(78, state.rawPreviewQuality) };
      }
      if (action.profile === 'usb') {
        return { ...state, sourceProfile: action.profile, conflictPolicy: cardSafeConflictPolicy, previewConcurrency: 1, faceConcurrency: Math.min(state.faceConcurrency, 1), rawPreviewQuality: Math.min(state.rawPreviewQuality, 65) };
      }
      if (action.profile === 'nas') {
        return { ...state, sourceProfile: action.profile, previewConcurrency: 1, faceConcurrency: Math.min(state.faceConcurrency, 1), rawPreviewCache: true, rawPreviewQuality: Math.min(state.rawPreviewQuality, 68) };
      }
      return { ...state, sourceProfile: action.profile };
    }
    case 'SET_CONFLICT_POLICY':
      return { ...state, conflictPolicy: action.policy };
    case 'SET_WATERMARK_NUMBER':
      return { ...state, [action.key]: action.value } as State;
    case 'SET_WATERMARK_POSITION':
      return action.orientation === 'portrait'
        ? { ...state, watermarkPositionPortrait: action.position }
        : { ...state, watermarkPositionLandscape: action.position };
    case 'SET_WATERMARK_MODE':
      return { ...state, watermarkMode: action.mode };
    case 'SET_BURST_WINDOW': {
      const seconds = Math.max(0.25, Math.min(10, action.seconds));
      const files = state.burstGrouping
        ? groupBursts(state.files, { windowSec: seconds })
        : state.files;
      inheritCataloguePathIndex(state.files, files);
      return {
        ...state,
        burstWindowSec: seconds,
        files,
        collapsedBursts: [],
      };
    }
    case 'TOGGLE_BURST_COLLAPSE': {
      const has = state.collapsedBursts.includes(action.burstId);
      return {
        ...state,
        collapsedBursts: has
          ? state.collapsedBursts.filter((id) => id !== action.burstId)
          : [...state.collapsedBursts, action.burstId],
      };
    }
    case 'COLLAPSE_ALL_BURSTS': {
      const ids = new Set<string>();
      for (const f of state.files) {
        if (f.burstId && f.burstSize && f.burstSize > 1) ids.add(f.burstId);
      }
      return { ...state, collapsedBursts: [...ids] };
    }
    case 'CLEAR_COLLAPSED_BURSTS':
      return { ...state, collapsedBursts: [] };
    case 'SET_EXPOSURE_ANCHOR':
      return { ...state, exposureAnchorPath: action.path };
    case 'CLEAR_EXPOSURE_ANCHOR': {
      const next = withFileHistoryIfChanged(state, state.files.map((f) =>
        f.normalizeToAnchor ? { ...f, normalizeToAnchor: false } : f,
      ));
      if (next === state && state.exposureAnchorPath === null) return state;
      return {
        ...next,
        exposureAnchorPath: null,
      };
    }
    case 'SET_EXPOSURE_MAX_STOPS':
      return { ...state, exposureMaxStops: Math.max(0.33, Math.min(4, action.stops)) };
    case 'SET_EXPOSURE_ADJUSTMENT_STEP':
      return { ...state, exposureAdjustmentStep: Math.max(0.1, Math.min(2, action.step)) };
    case 'SET_WHITE_BALANCE':
      return {
        ...state,
        whiteBalanceTemperature: Math.max(-100, Math.min(100, action.temperature)),
        whiteBalanceTint: Math.max(-100, Math.min(100, action.tint)),
      };
    case 'SET_WHITE_BALANCE_ADJUSTMENT': {
      const temperature = Math.max(-100, Math.min(100, action.temperature));
      const tint = Math.max(-100, Math.min(100, action.tint));
      const nextAdjustment = Math.abs(temperature) >= 0.5 || Math.abs(tint) >= 0.5
        ? { temperature, tint }
        : undefined;
      return withIndexedFileHistoryUpdate(
        state,
        constantPathUpdates(action.filePaths, nextAdjustment),
        (file, adjustment) => sameWhiteBalanceAdjustment(file.whiteBalanceAdjustment, adjustment)
          ? file
          : { ...file, whiteBalanceAdjustment: adjustment },
      );
    }
    case 'SET_EVENT_MODE': {
      const files = assignSceneBuckets(state.files, action.mode);
      inheritCataloguePathIndex(state.files, files);
      return { ...state, eventMode: action.mode, files };
    }
    case 'SET_CULL_CONFIDENCE':
      return { ...state, cullConfidence: action.confidence };
    case 'SET_GROUP_PHOTO_EVERYONE_GOOD':
      return { ...state, groupPhotoEveryoneGood: action.enabled };
    case 'SET_KEEPER_QUOTA':
      return { ...state, keeperQuota: action.quota };
    case 'SET_NORMALIZE_TO_ANCHOR': {
      return withIndexedFileHistoryUpdate(state, constantPathUpdates(action.filePaths, action.value), (f, value) => {
        const normalizeToAnchor = value &&
          f.path !== state.exposureAnchorPath &&
          typeof f.exposureValue === 'number';
        return !!f.normalizeToAnchor === normalizeToAnchor ? f : { ...f, normalizeToAnchor };
      });
    }
    case 'SET_EXPOSURE_ADJUSTMENT': {
      const stops = normalizeExposureStops(clampStops(action.stops, state.exposureMaxStops));
      return withIndexedFileHistoryUpdate(
        state,
        constantPathUpdates(action.filePaths, stops),
        (file, nextStops) => normalizeExposureStops(file.exposureAdjustmentStops ?? 0) === nextStops
          ? file
          : { ...file, exposureAdjustmentStops: nextStops === 0 ? undefined : nextStops },
      );
    }
    case 'NUDGE_EXPOSURE_ADJUSTMENT': {
      return withIndexedFileHistoryUpdate(
        state,
        constantPathUpdates(action.filePaths, action.delta),
        (file, delta) => {
          const next = normalizeExposureStops(clampStops((file.exposureAdjustmentStops ?? 0) + delta, state.exposureMaxStops));
          return normalizeExposureStops(file.exposureAdjustmentStops ?? 0) === next
            ? file
            : { ...file, exposureAdjustmentStops: next === 0 ? undefined : next };
        },
      );
    }
    case 'NORMALIZE_SELECTION_TO_FOCUSED': {
      const anchorIndex = getCataloguePathIndex(state.files).get(action.anchorPath);
      const anchor = anchorIndex === undefined ? undefined : state.files[anchorIndex];
      if (anchor && typeof anchor.exposureValue !== 'number') return state;
      if (!anchor) return state;
      return {
        ...withIndexedFileHistoryUpdate(
          state,
          constantPathUpdates(action.filePaths, anchor.path),
          (file, anchorPath) => {
            const normalizeToAnchor = file.path !== anchorPath && typeof file.exposureValue === 'number';
            return !!file.normalizeToAnchor === normalizeToAnchor ? file : { ...file, normalizeToAnchor };
          },
        ),
        exposureAnchorPath: anchor.path,
      };
    }
    case 'PICK_BURST_KEEPERS': {
      const groups = new Map<string, MediaFile[]>();
      for (const f of state.files) {
        if (f.burstId && f.burstSize && f.burstSize > 1) {
          groups.set(f.burstId, [...(groups.get(f.burstId) ?? []), f]);
        }
      }
      const keepers = new Set<string>();
      for (const group of groups.values()) {
        const sorted = group.slice().sort((a, b) =>
          Number(!!b.isProtected) - Number(!!a.isProtected) ||
          (b.rating ?? 0) - (a.rating ?? 0) ||
          (b.sharpnessScore ?? -1) - (a.sharpnessScore ?? -1) ||
          (a.burstIndex ?? 0) - (b.burstIndex ?? 0),
        );
        if (sorted[0]) keepers.add(sorted[0].path);
      }
      return withFileHistory(state, state.files.map((f) =>
        f.burstId && groups.has(f.burstId)
          ? { ...f, pick: keepers.has(f.path) ? 'selected' : 'rejected' }
          : f,
      ));
    }
    case 'CULL_TO_TARGET': {
      // Cull the whole batch down to a hard keeper budget. Keeps the strongest
      // frame per burst/visual/face group first (variety), always retains
      // protected/rated/picked files, and rejects the rest. Photos only —
      // videos are left untouched.
      const photos = state.files.filter((f) =>
        f.type === 'photo' &&
        (isAutoCullBulkDecisionEligible(f, state.eventMode) ||
          f.isProtected || (f.rating ?? 0) > 0 || f.pick === 'selected'));
      if (photos.length === 0) return state;
      const { keep } = selectKeepersToTarget(photos, {
        target: action.target,
        perGroupCap: action.perGroupCap,
        eventMode: state.eventMode,
      });
      const keepSet = new Set(keep);
      const decisionPaths = new Set(photos.map((file) => file.path));
      return withFileHistory(state, state.files.map((f) =>
        f.type === 'photo' && decisionPaths.has(f.path)
          ? { ...f, pick: keepSet.has(f.path) ? 'selected' : 'rejected' }
          : f,
      ));
    }
    case 'SET_SHARPNESS_BATCH': {
      const result = applyIndexedCatalogueUpdates(state.files, action.scores, (file, sharpnessScore) => {
        const review = scoreReview({ ...file, sharpnessScore });
        return {
          ...file,
          sharpnessScore,
          blurRisk: review.blurRisk,
          reviewScore: review.score,
          reviewReasons: review.reasons,
        };
      });
      return result.files === state.files ? state : { ...state, files: result.files };
    }
    case 'SET_REVIEW_SCORES': {
      // In the live app this action is intercepted by ImportProvider before
      // reaching the reducer (see the dispatch override in ImportProvider),
      // so this path only runs in tests that call the reducer directly.
      const patchPaths = Object.keys(action.scores);
      if (patchPaths.length === 0) return state;
      const result = applyIndexedCatalogueUpdates(state.files, action.scores, (f, patch) => {
        if (!patch) return f;
        const merged = { ...f, ...patch };
        const review = scoreReview(merged);
        return {
          ...merged,
          blurRisk: patch.blurRisk ?? review.blurRisk,
          reviewScore: patch.reviewScore ?? review.score,
          reviewReasons: patch.reviewReasons ?? review.reasons,
        };
      });
      return result.files === state.files ? state : { ...state, files: result.files };
    }
    case 'COMMIT_REVIEW_SCORES':
      // ImportProvider intercepts this marker and materializes its renderer-held
      // overlay in one O(n) pass. Keeping the reducer branch a no-op makes the
      // action safe in isolated reducer tests.
      return state;
    case 'APPLY_REVIEW_SNAPSHOT':
      // A completed review sweep becomes durable session state without adding a
      // million-photo array to undo history.
      return action.files === state.files ? state : { ...state, files: action.files };
    case 'RESOLVE_SECOND_PASS': {
      if (action.filePaths.length === 0) return state;
      return withIndexedFileHistoryUpdate(
        state,
        constantPathUpdates(action.filePaths, action.pick),
        (file, pick) => ({ ...file, pick, reviewApproved: true }),
      );
    }
    case 'CLEAR_FACE_DATA':
      return {
        ...state,
        files: state.files.map((file) => file.type === 'photo' ? stripLocalFaceAndSubjectData(file) : file),
      };
    case 'GROUP_VISUAL_DUPLICATES': {
      const groups = groupByVisualHash(action.files ?? state.files, action.threshold ?? 8);
      const groupByPath = new Map<string, { id: string; size: number }>();
      for (const [id, paths] of Object.entries(groups)) {
        for (const p of paths) groupByPath.set(p, { id, size: paths.length });
      }
      return {
        ...state,
        files: state.files.map((f) => {
          const group = groupByPath.get(f.path);
          const next = group
            ? { ...f, visualGroupId: group.id, visualGroupSize: group.size }
            : { ...f, visualGroupId: undefined, visualGroupSize: undefined };
          if (next.visualGroupId === f.visualGroupId && next.visualGroupSize === f.visualGroupSize) return f;
          const review = scoreReview(next);
          return { ...next, reviewScore: review.score, blurRisk: review.blurRisk, reviewReasons: review.reasons };
        }),
      };
    }
    case 'GROUP_FACE_SIMILAR': {
      const groups = groupByFaceSimilarity(
        action.files ?? state.files,
        action.embeddingThreshold ?? FACE_GROUP_EMBEDDING_THRESHOLD,
        action.threshold ?? 10,
      );
      const groupByPath = new Map<string, { id: string; size: number }>();
      for (const [id, paths] of Object.entries(groups)) {
        for (const p of paths) {
          const current = groupByPath.get(p);
          if (!current || paths.length > current.size) groupByPath.set(p, { id, size: paths.length });
        }
      }
      return {
        ...state,
        files: state.files.map((f) => {
          const group = groupByPath.get(f.path);
          const faceGroupId = group?.id;
          const faceGroupSize = group?.size;
          if (f.faceGroupId === faceGroupId && f.faceGroupSize === faceGroupSize) return f;
          return { ...f, faceGroupId, faceGroupSize };
        }),
      };
    }
    case 'GROUP_SCENE_BUCKETS':
      return { ...state, files: assignSceneBuckets(state.files, state.eventMode) };
    case 'PICK_BEST_IN_GROUPS': {
      const groupFiles = action.files ?? state.files;
      const groups = collectReviewGroups(groupFiles);
      const keepers = new Set<string>();
      for (const group of groups.values()) {
        const best = bestInGroup(group);
        if (best) keepers.add(best.path);
      }
      return withFileHistory(state, state.files.map((f) => {
        const inGroup =
          (f.visualGroupId && groups.has(`visual:${f.visualGroupId}`)) ||
          (f.burstId && groups.has(`burst:${f.burstId}`));
        return inGroup ? { ...f, pick: keepers.has(f.path) ? 'selected' : 'rejected' } : f;
      }));
    }
    case 'QUEUE_BEST': {
      const next = queueBestPaths(state.files, {
        eventMode: state.eventMode,
        cullConfidence: state.cullConfidence,
        groupPhotoEveryoneGood: state.groupPhotoEveryoneGood,
        keeperQuota: state.keeperQuota,
        skipDuplicates: state.skipDuplicates,
      });
      return { ...state, queuedPaths: next, filter: next.length > 0 ? 'queue' : state.filter === 'queue' ? 'all' : state.filter };
    }
    case 'AUTO_CULL_SAFE': {
      const groupFiles = action.files ?? state.files;
      const groups = collectReviewGroups(groupFiles);
      const reject = new Set<string>();
      const keep = new Set<string>();
      for (const group of groups.values()) {
        const decision = autoCullGroup(group, {
          confidence: state.cullConfidence,
          groupPhotoEveryoneGood: state.groupPhotoEveryoneGood,
          keeperQuota: state.keeperQuota,
          eventMode: state.eventMode,
        });
        for (const p of decision.keep) {
          const file = group.find((item) => item.path === p);
          if (file && (isAutoCullBulkDecisionEligible(file, state.eventMode) ||
            file.isProtected || (file.rating ?? 0) > 0 || file.pick === 'selected')) keep.add(p);
        }
        for (const p of decision.reject) {
          const file = group.find((item) => item.path === p);
          if (file && isAutoCullBulkDecisionEligible(file, state.eventMode)) reject.add(p);
        }
      }

      return withFileHistory(state, state.files.map((f) => {
        if (keep.has(f.path)) return { ...f, pick: 'selected' };
        if (reject.has(f.path)) return { ...f, pick: 'rejected' };
        return f;
      }));
    }
    case 'APPLY_AUTO_CULL_PROPOSAL': {
      const updates = new Map<string, 'selected' | 'rejected'>();
      for (const filePath of action.keep) updates.set(filePath, 'selected');
      for (const filePath of action.reject) updates.set(filePath, 'rejected');
      if (updates.size === 0) return state;
      return withIndexedFileHistoryUpdate(
        state,
        updates,
        (file, pick) => file.pick === pick ? file : { ...file, pick },
      );
    }
    case 'REJECT_DUPLICATES':
      return withFileHistory(state, state.files.map((f) =>
        f.duplicate ? { ...f, pick: 'rejected' } : f,
      ));
    case 'SYNC_EDITS_FROM_FOCUSED': {
      const focusedIndex = action.filePath ? getCataloguePathIndex(state.files).get(action.filePath) : undefined;
      const focused = action.filePath
        ? focusedIndex === undefined ? undefined : state.files[focusedIndex]
        : state.focusedIndex >= 0 ? state.files[state.focusedIndex] : null;
      if (!focused) return state;
      const targetPaths = state.selectedPaths.length > 0
        ? new Set(state.selectedPaths)
        : new Set(state.files
            .filter((f) =>
              (focused.burstId && f.burstId === focused.burstId) ||
              (focused.visualGroupId && f.visualGroupId === focused.visualGroupId) ||
              (
                focused.sceneBucket &&
                !['scene', 'general'].includes(focused.sceneBucket.trim().toLowerCase()) &&
                f.sceneBucket === focused.sceneBucket
              ),
            )
            .map((f) => f.path));
      targetPaths.delete(focused.path);
      if (targetPaths.size === 0) return state;
      return withIndexedFileHistoryUpdate(
        state,
        constantPathUpdates([...targetPaths], true),
        (file) => ({
              ...file,
              exposureAdjustmentStops: focused.exposureAdjustmentStops,
              normalizeToAnchor: focused.normalizeToAnchor && typeof file.exposureValue === 'number',
              whiteBalanceAdjustment: focused.whiteBalanceAdjustment,
            }),
      );
    }
    case 'UNDO_FILE_EDIT':
      if (state.fileHistory.length === 0) return state;
      return {
        ...state,
        files: state.fileHistory[0],
        fileHistory: state.fileHistory.slice(1),
      };
    case 'NORMALIZE_SELECTION_TO_MEDIAN': {
      // Find files in the selection that actually have an EV — the median is
      // only meaningful over computed values. Ties break toward the lower
      // index (stable sort), which tends to be the earlier shot.
      const catalogueIndex = getCataloguePathIndex(state.files);
      const candidates = action.filePaths
        .map((filePath) => catalogueIndex.get(filePath))
        .filter((index): index is number => index !== undefined)
        .map((index) => state.files[index])
        .filter((file) => typeof file.exposureValue === 'number')
        .sort((a, b) => (a.exposureValue as number) - (b.exposureValue as number));
      if (candidates.length === 0) return state;
      const anchor = candidates[Math.floor((candidates.length - 1) / 2)];
      return {
        ...withIndexedFileHistoryUpdate(
          state,
          constantPathUpdates(action.filePaths, anchor.path),
          (file, anchorPath) => {
          if (file.path === anchorPath) {
            // The anchor itself never needs normalizing.
            return file.normalizeToAnchor ? { ...file, normalizeToAnchor: false } : file;
          }
          const normalizeToAnchor = typeof file.exposureValue === 'number';
          return !!file.normalizeToAnchor === normalizeToAnchor ? file : { ...file, normalizeToAnchor };
        }),
        exposureAnchorPath: anchor.path,
      };
    }
    case 'SET_VOLUME_IMPORT_QUEUE':
      return { ...state, volumeImportQueue: action.paths };
    case 'ADVANCE_VOLUME_IMPORT_QUEUE': {
      const [, ...rest] = state.volumeImportQueue;
      const nextSource = state.volumeImportQueue[1] ?? state.selectedSource;
      return {
        ...state,
        volumeImportQueue: rest,
        selectedSource: nextSource,
        activeScanId: null,
        scanDiagnostics: null,
        files: [],
        phase: 'idle',
        exposureAnchorPath: null,
        queuedPaths: [],
        selectedPaths: [],
        importResult: null,
        importRunning: false,
        importQueuedCount: 0,
        importProgress: null,
        fileHistory: [],
        focusedIndex: -1,
        focusedPath: null,
        filter: 'all',
      };
    }
    case 'HYDRATE_LICENSE_STATUS': {
      const valid = !!action.status?.valid;
      return {
        ...state,
        licenseStatus: action.status,
        licenseHydrated: true,
        licensePromptOpen: valid ? false : state.licensePromptOpen,
        licenseBannerDismissed: valid ? false : state.licenseBannerDismissed,
      };
    }
    case 'SET_LICENSE_STATUS':
      return {
        ...state,
        licenseStatus: action.status,
        licenseHydrated: true,
        licensePromptOpen: action.status?.valid ? false : state.licensePromptOpen,
        licenseBannerDismissed: action.status?.valid ? false : state.licenseBannerDismissed,
      };
    case 'OPEN_LICENSE_PROMPT':
      return { ...state, licensePromptOpen: true, licenseBannerDismissed: false };
    case 'CLOSE_LICENSE_PROMPT':
      return { ...state, licensePromptOpen: false };
    case 'DISMISS_LICENSE_BANNER':
      return { ...state, licenseBannerDismissed: true };
    case 'SET_PERFORMANCE_OPTION':
      return { ...state, [action.key]: action.value };
    case 'SET_GPU_DEVICE_ID':
      return { ...state, gpuDeviceId: Number.isFinite(action.deviceId) ? Math.max(-1, Math.round(action.deviceId)) : -1 };
    case 'SET_RAW_PREVIEW_QUALITY':
      return { ...state, rawPreviewQuality: action.quality };
    case 'SET_PERF_TIER':
      if (action.tier === 'low') {
        return {
          ...state,
          perfTier: action.tier,
          cpuOptimization: true,
          fastKeeperMode: true,
          previewConcurrency: 1,
          faceConcurrency: 1,
          rawPreviewQuality: Math.min(state.rawPreviewQuality, 60),
          reviewFaceAnalysis: false,
          reviewFaceMatching: false,
          reviewPersonDetection: false,
          reviewVisualDuplicates: false,
          autoSpeedMode: false,
        };
      }
      if (action.tier === 'balanced') {
        return {
          ...state,
          perfTier: action.tier,
          cpuOptimization: true,
          fastKeeperMode: false,
          previewConcurrency: 2,
          faceConcurrency: Math.max(2, state.faceConcurrency),
          rawPreviewQuality: Math.max(65, Math.min(state.rawPreviewQuality, 75)),
          reviewFaceAnalysis: true,
          reviewFaceMatching: state.reviewFaceMatching,
          reviewPersonDetection: true,
          reviewVisualDuplicates: true,
        };
      }
      if (action.tier === 'high') {
        return {
          ...state,
          perfTier: action.tier,
          fastKeeperMode: false,
          previewConcurrency: Math.max(3, state.previewConcurrency),
          faceConcurrency: Math.max(4, state.faceConcurrency),
          rawPreviewQuality: Math.max(state.rawPreviewQuality, 82),
          reviewFaceAnalysis: true,
          reviewFaceMatching: state.reviewFaceMatching,
          reviewPersonDetection: true,
          reviewVisualDuplicates: true,
        };
      }
      return { ...state, perfTier: action.tier };
    case 'SET_FAST_KEEPER_MODE':
      return { ...state, fastKeeperMode: action.enabled };
    case 'SET_AI_REVIEW_ENABLED':
      return { ...state, aiReviewEnabled: action.enabled };
    case 'SET_AUTO_SPEED_MODE':
      return { ...state, autoSpeedMode: action.enabled };
    case 'SET_SUPER_SPEED_MODE':
      return { ...state, superSpeedMode: action.enabled };
    case 'SET_REVIEW_PERFORMANCE_OPTION':
      return { ...state, [action.key]: action.value };
    case 'SET_PREVIEW_CONCURRENCY':
      return { ...state, previewConcurrency: action.concurrency };
    case 'SET_FACE_CONCURRENCY':
      return { ...state, faceConcurrency: Math.max(1, Math.min(MAX_FACE_CONCURRENCY, Math.round(action.concurrency))) };
    case 'SET_KEYBIND':
      return { ...state, keybinds: { ...state.keybinds, [action.action]: action.key } };
    case 'SET_KEYBINDS':
      return { ...state, keybinds: { ...state.keybinds, ...action.keybinds } };
    case 'RESET_KEYBINDS':
      return { ...state, keybinds: { ...DEFAULT_KEYBINDS } };
    case 'SET_METADATA_EXPORT':
      return { ...state, metadataExport: { ...state.metadataExport, ...action.flags } };
    case 'SET_VIEW_OVERLAY_PREFERENCES':
      return {
        ...state,
        viewOverlayPreferences: {
          ...state.viewOverlayPreferences,
          ...action.preferences,
        },
      };
    case 'RESTORE_SESSION': {
      const restoredFiles = action.session.files;
      const validPaths = new Set(restoredFiles.map((file) => file.path));
      const focusedPath = action.session.focusedPath && validPaths.has(action.session.focusedPath)
        ? action.session.focusedPath
        : null;
      const focusedIndex = focusedPath
        ? restoredFiles.findIndex((file) => file.path === focusedPath)
        : -1;
      const selectedPaths = normalizeKnownPaths(restoredFiles, action.session.selectedPaths ?? []);
      const queuedPaths = normalizeKnownPaths(restoredFiles, action.session.queuedPaths ?? []);
      const filter = action.session.filter === 'queue' && queuedPaths.length === 0
        ? 'all'
        : action.session.filter as FilterMode;
      return {
        ...state,
        selectedSource: action.session.sourcePath,
        activeScanId: null,
        scanDiagnostics: null,
        destination: action.session.destRoot,
        files: restoredFiles,
        selectedPaths,
        queuedPaths,
        filter,
        focusedIndex,
        focusedPath,
        phase: restoredFiles.length > 0 ? 'ready' : 'idle',
        importRunning: false,
        importQueuedCount: 0,
        importProgress: null,
        importResult: null,
        lastSessionId: action.session.id,
      };
    }
    default:
      return state;
  }
}

const StateContext = createContext<State>(initialState);
const DispatchContext = createContext<Dispatch<Action>>(() => {});

// ---------------------------------------------------------------------------
// Review scores overlay — kept outside the reducer so SET_REVIEW_SCORES
// dispatches don't trigger a full state.files.map() on every face completion.
// Components that need merged files call useMergedFiles() instead of
// reading state.files directly.
// ---------------------------------------------------------------------------
export type ReviewPatch = Partial<MediaFile> & { reviewScore?: number; blurRisk?: MediaFile['blurRisk']; reviewReasons?: string[] };
const ReviewScoresContext = createContext<Map<string, ReviewPatch>>(new Map());
const ReviewScoresVersionContext = createContext<number>(0);
const MergedFilesContext = createContext<MediaFile[]>(initialState.files);
const mergedReviewFileCache = new WeakMap<MediaFile, WeakMap<ReviewPatch, MediaFile>>();

function mergeReviewPatch(file: MediaFile, patch: ReviewPatch): MediaFile {
  let byPatch = mergedReviewFileCache.get(file);
  if (!byPatch) {
    byPatch = new WeakMap();
    mergedReviewFileCache.set(file, byPatch);
  }
  const cached = byPatch.get(patch);
  if (cached) return cached;

  const merged = { ...file, ...patch };
  if (patch.reviewScore === undefined) {
    const review = scoreReview(merged);
    merged.blurRisk = patch.blurRisk ?? review.blurRisk;
    merged.reviewScore = review.score;
    merged.reviewReasons = review.reasons;
  }
  byPatch.set(patch, merged);
  return merged;
}

function mergeReviewScoreOverlay(files: MediaFile[], overlay: Map<string, ReviewPatch>): MediaFile[] {
  if (overlay.size === 0) return files;
  return applyIndexedCatalogueMapUpdates(files, overlay, mergeReviewPatch).files;
}

/**
 * Preserve completed ONNX stages when a later canvas-only ROI patch arrives.
 * Derived review fields are invalidated unless the new patch explicitly owns
 * them, ensuring mergeReviewPatch recalculates them from the combined evidence.
 */
export function mergeReviewScorePatches(
  previous: ReviewPatch | undefined,
  next: ReviewPatch,
): ReviewPatch {
  if (!previous) return next;
  const merged: ReviewPatch = { ...previous, ...next };
  if (!Object.prototype.hasOwnProperty.call(next, 'reviewScore')) delete merged.reviewScore;
  if (!Object.prototype.hasOwnProperty.call(next, 'blurRisk')) delete merged.blurRisk;
  if (!Object.prototype.hasOwnProperty.call(next, 'reviewReasons')) delete merged.reviewReasons;
  return merged;
}

export function ImportProvider({ children }: { children: ReactNode }) {
  const [state, rawDispatch] = useReducer(reducer, initialState);

  // Mutable ref to current state so the dispatch interceptor can read files
  // without stale closure issues (the dispatch callback has [] deps).
  const stateRef = useRef(state);
  stateRef.current = state;

  // Mutable map of review score overlays — never triggers a re-render itself.
  const reviewScoresRef = useRef<Map<string, ReviewPatch>>(new Map());
  // Version counter: batched so per-file review updates do not remap every card.
  const [reviewVersion, setReviewVersion] = useState(0);
  const reviewVersionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bumpReviewVersionNow = useCallback(() => {
    if (reviewVersionTimerRef.current) {
      clearTimeout(reviewVersionTimerRef.current);
      reviewVersionTimerRef.current = null;
    }
    setReviewVersion((v) => v + 1);
  }, []);
  const bumpReviewVersionSoon = useCallback(() => {
    if (reviewVersionTimerRef.current) return;
    const delay = reviewOverlayDelayMs(stateRef.current.files.length);
    reviewVersionTimerRef.current = setTimeout(() => {
      reviewVersionTimerRef.current = null;
      setReviewVersion((v) => v + 1);
    }, delay);
  }, []);

  useEffect(() => () => {
    if (reviewVersionTimerRef.current) clearTimeout(reviewVersionTimerRef.current);
  }, []);

  // Keep the shared review scorer's profile in sync with the active event mode
  // so best-shot/keeper ranking in the grid reflects sports-action weighting.
  useEffect(() => {
    configureReviewProfile(state.eventMode);
  }, [state.eventMode]);

  // Compute the O(n) overlay merge once per flush and share the same array with
  // every consumer. Previously Grid, Destination, Help and bulk preview each
  // remapped the complete catalogue independently on every AI tick.
  const mergedFiles = useMemo(() => {
    const merged = mergeReviewScoreOverlay(state.files, reviewScoresRef.current);
    if (merged !== state.files) inheritCataloguePathIndex(state.files, merged);
    return merged;
  }, [state.files, reviewVersion]);

  // Intercept SET_REVIEW_SCORES before it hits the reducer.
  const dispatch = useCallback<Dispatch<Action>>((action) => {
    trackSessionFileChanges(action);
    if (action.type === 'COMMIT_REVIEW_SCORES') {
      if (reviewScoresRef.current.size === 0) return;
      const mergedFiles = mergeReviewScoreOverlay(stateRef.current.files, reviewScoresRef.current);
      reviewScoresRef.current.clear();
      rawDispatch({ type: 'APPLY_REVIEW_SNAPSHOT', files: mergedFiles });
      bumpReviewVersionNow();
      return;
    }
    if (action.type === 'SET_REVIEW_SCORES') {
      const scores = action.scores;
      if (Object.keys(scores).length === 0) return;
      let dirty = false;
      for (const [p, patch] of Object.entries(scores)) {
        if (patch) {
          reviewScoresRef.current.set(
            p,
            mergeReviewScorePatches(reviewScoresRef.current.get(p), patch),
          );
          dirty = true;
        }
      }
      if (dirty) bumpReviewVersionSoon();
      return;
    }
    // Wipe the overlay on source change or face rescan so stale scores
    // don't prevent re-analysis. CLEAR_FACE_DATA clears faceBoxes in the
    // reducer but the overlay would re-merge them on top — clear it too.
    if (
      action.type === 'SELECT_SOURCE' ||
      action.type === 'SCAN_START' ||
      action.type === 'SCAN_ERROR' ||
      action.type === 'RESET_FILES' ||
      action.type === 'CLEAR_FACE_DATA' ||
      action.type === 'ADVANCE_VOLUME_IMPORT_QUEUE' ||
      action.type === 'RESTORE_SESSION'
    ) {
      reviewScoresRef.current.clear();
      clearEmbeddingCache();
      bumpReviewVersionNow();
    }
    if (action.type === 'CLEAR_PICKS') {
      bumpReviewVersionNow();
    }
    // QUEUE_BEST runs inside the reducer against state.files which has NO
    // overlay data (face scores, review scores are only in the overlay Map).
    // Intercept it here, merge the overlay, run the same logic with full data,
    // then dispatch QUEUE_ADD_PATHS with the result so the reducer just stores paths.
    if (action.type === 'QUEUE_BEST') {
      // Access current state via the ref snapshot — we need state.files here.
      // We re-read it via a lazy getter trick: dispatch a dummy observer action
      // that is synchronous. Instead, capture state in a ref updated on every render.
      // Since this callback is recreated on every render via useCallback([], []),
      // we need stateRef to avoid stale closure. stateRef is set below.
      const overlay = reviewScoresRef.current;
      const rawFiles = stateRef.current.files;
      const mergedFiles = mergeReviewScoreOverlay(rawFiles, overlay);
      const current = stateRef.current;
      const next = queueBestPaths(mergedFiles, {
        eventMode: current.eventMode,
        cullConfidence: current.cullConfidence,
        groupPhotoEveryoneGood: current.groupPhotoEveryoneGood,
        keeperQuota: current.keeperQuota,
        skipDuplicates: current.skipDuplicates,
      });
      rawDispatch({ type: 'QUEUE_SET_PATHS', paths: next });
      if (next.length > 0) rawDispatch({ type: 'SET_FILTER', filter: 'queue' });
      return;
    }
    // Grouping and grouped bulk decisions depend on AI data held in the overlay.
    // Compute from merged files, then let the reducer write stable state by path.
    if (
      action.type === 'GROUP_FACE_SIMILAR' ||
      action.type === 'GROUP_VISUAL_DUPLICATES' ||
      action.type === 'AUTO_CULL_SAFE' ||
      action.type === 'PICK_BEST_IN_GROUPS'
    ) {
      rawDispatch({
        ...action,
        files: mergeReviewScoreOverlay(stateRef.current.files, reviewScoresRef.current),
      });
      return;
    }
    rawDispatch(action);
  }, [bumpReviewVersionNow, bumpReviewVersionSoon]);

  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>
        <ReviewScoresContext.Provider value={reviewScoresRef.current}>
          <ReviewScoresVersionContext.Provider value={reviewVersion}>
            <MergedFilesContext.Provider value={mergedFiles}>
              {children}
            </MergedFilesContext.Provider>
          </ReviewScoresVersionContext.Provider>
        </ReviewScoresContext.Provider>
      </DispatchContext.Provider>
    </StateContext.Provider>
  );
}

export function useAppState() {
  return useContext(StateContext);
}

export function useAppDispatch() {
  return useContext(DispatchContext);
}

/** Monotonic revision for renderer-held AI evidence. */
export function useReviewScoresVersion(): number {
  return useContext(ReviewScoresVersionContext);
}

/** Mutable, renderer-local AI evidence used by the background scheduler between
 * batched UI flushes. Consumers must dispatch SET_REVIEW_SCORES to mutate it. */
export function useReviewScoreOverlay(): Map<string, ReviewPatch> {
  return useContext(ReviewScoresContext);
}

/**
 * Returns the provider's single shared state.files + review overlay snapshot.
 * The O(n) merge runs once per batched version rather than once per consumer.
 * Use this instead of useAppState().files anywhere AI evidence is needed.
 */
export function useMergedFiles(): MediaFile[] {
  return useContext(MergedFilesContext);
}
