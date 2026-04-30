import { createContext, useContext, useReducer, useRef, useMemo, useCallback, useState, type Dispatch, type ReactNode } from 'react';
import type { Volume, MediaFile, ImportProgress, ImportResult, SaveFormat, SourceKind, FtpConfig, FtpSyncSettings, FtpSyncStatus, RatingFilter, SelectionSet, LicenseValidation, WatermarkPosition, WatermarkMode, KeybindMap, MetadataExportFlags, ViewOverlayPreferences, EventMode, CullConfidence, KeeperQuota } from '../../shared/types';
import { FOLDER_PRESETS, DEFAULT_KEYBINDS, DEFAULT_METADATA_EXPORT, DEFAULT_VIEW_OVERLAY_PREFERENCES } from '../../shared/types';
import { groupBursts } from '../../shared/burst';
import { clampStops, normalizeExposureStops } from '../../shared/exposure';
import { assignSceneBuckets, autoCullGroup, bestInGroup, groupByFaceSimilarity, groupByVisualHash, scoreReview } from '../../shared/review';

export type AppPhase = 'idle' | 'scanning' | 'ready' | 'importing' | 'complete';
export type ViewMode = 'grid' | 'single' | 'split' | 'compare' | 'settings';

export type FilterMode = 'all' | 'protected' | 'picked' | 'rejected' | 'unrated' | 'duplicates' | 'unmarked' | 'queue' | 'best' | 'faces' | 'face-groups' | 'blur-risk' | 'near-duplicates' | 'review-needed' | 'needs-exposure' | 'normalized' | 'adjusted' | 'photos' | 'videos' | 'raw' | RatingFilter | `camera:${string}` | `lens:${string}` | `date:${string}` | `ext:${string}` | `scene:${string}` | `burst:${string}`;

interface State {
  volumes: Volume[];
  selectedSource: string | null;
  files: MediaFile[];
  phase: AppPhase;
  scanError: string | null;
  destination: string | null;
  skipDuplicates: boolean;
  saveFormat: SaveFormat;
  jpegQuality: number;
  folderPreset: string;
  customPattern: string;
  importProgress: ImportProgress | null;
  importResult: ImportResult | null;
  focusedIndex: number;
  viewMode: ViewMode;
  previousViewMode: Exclude<ViewMode, 'settings'> | null;
  theme: 'light' | 'dark';
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
  verifyChecksums: boolean;
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
  perfTier: 'auto' | 'low' | 'balanced' | 'high';
  fastKeeperMode: boolean;
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
  | { type: 'SCAN_START' }
  | { type: 'SCAN_BATCH'; files: MediaFile[] }
  | { type: 'SCAN_COMPLETE' }
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
  | { type: 'IMPORT_PROGRESS'; progress: ImportProgress }
  | { type: 'IMPORT_COMPLETE'; result: ImportResult }
  | { type: 'DISMISS_SUMMARY' }
  | { type: 'SET_THUMBNAIL'; filePath: string; thumbnail: string }
  | { type: 'SET_THUMBNAILS'; thumbnails: Record<string, string> }
  | { type: 'SET_DUPLICATE'; filePath: string }
  | { type: 'CLEAR_DUPLICATES' }
  | { type: 'SET_PICK'; filePath: string; pick: 'selected' | 'rejected' | undefined }
  | { type: 'SET_PICK_BATCH'; filePaths: string[]; pick: 'selected' | 'rejected' | undefined }
  | { type: 'CLEAR_PICKS' }
  | { type: 'SET_FOCUSED'; index: number }
  | { type: 'SET_VIEW_MODE'; mode: ViewMode }
  | { type: 'SET_THEME'; theme: 'light' | 'dark' }
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
  | { type: 'TOGGLE_CULL_MODE' }
  | { type: 'SET_SELECTED_PATHS'; paths: string[] }
  | { type: 'QUEUE_ADD_PATHS'; paths: string[] }
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
      | 'watermarkEnabled' | 'autoStraighten'; value: boolean }
  | { type: 'SET_WORKFLOW_STRING'; key:
      | 'protectedFolderName' | 'backupDestRoot' | 'autoImportDestRoot' | 'completeSoundPath'
      | 'metadataKeywords' | 'metadataTitle' | 'metadataCaption' | 'metadataCreator' | 'metadataCopyright'
      | 'watermarkText' | 'watermarkImagePath'; value: string }
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
  | { type: 'SET_SHARPNESS_BATCH'; scores: Record<string, number> }
  | { type: 'SET_REVIEW_SCORES'; scores: Record<string, Partial<MediaFile>> }
  | { type: 'GROUP_VISUAL_DUPLICATES'; threshold?: number }
  | { type: 'GROUP_FACE_SIMILAR'; threshold?: number }
  | { type: 'GROUP_SCENE_BUCKETS' }
  | { type: 'PICK_BEST_IN_GROUPS' }
  | { type: 'QUEUE_BEST' }
  | { type: 'AUTO_CULL_SAFE' }
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
  | { type: 'SET_GPU_DEVICE_ID'; deviceId: number }
  | { type: 'SET_RAW_PREVIEW_QUALITY'; quality: number }
  | { type: 'SET_PERF_TIER'; tier: 'auto' | 'low' | 'balanced' | 'high' }
  | { type: 'SET_FAST_KEEPER_MODE'; enabled: boolean }
  | { type: 'SET_PREVIEW_CONCURRENCY'; concurrency: number }
  | { type: 'SET_FACE_CONCURRENCY'; concurrency: number }
  | { type: 'SET_KEYBIND'; action: keyof KeybindMap; key: string }
  | { type: 'SET_KEYBINDS'; keybinds: Partial<KeybindMap> }
  | { type: 'RESET_KEYBINDS' }
  | { type: 'SET_METADATA_EXPORT'; flags: Partial<MetadataExportFlags> }
  | { type: 'SET_VIEW_OVERLAY_PREFERENCES'; preferences: Partial<ViewOverlayPreferences> };

const systemDark = typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;

const initialState: State = {
  volumes: [],
  selectedSource: null,
  files: [],
  phase: 'idle',
  scanError: null,
  destination: null,
  skipDuplicates: true,
  saveFormat: 'original' as SaveFormat,
  jpegQuality: 90,
  folderPreset: 'date-flat',
  customPattern: FOLDER_PRESETS['date-flat'].pattern,
  importProgress: null,
  importResult: null,
  focusedIndex: -1,
  viewMode: 'grid' as ViewMode,
  previousViewMode: null,
  theme: systemDark ? 'dark' : 'light',
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
  verifyChecksums: false,
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
  perfTier: 'auto',
  fastKeeperMode: false,
  previewConcurrency: 2,
  faceConcurrency: 1,
  keybinds: { ...DEFAULT_KEYBINDS },
  metadataExport: { ...DEFAULT_METADATA_EXPORT },
  viewOverlayPreferences: { ...DEFAULT_VIEW_OVERLAY_PREFERENCES },
};

function withFileHistory(state: State, files: MediaFile[]): State {
  return {
    ...state,
    files,
    fileHistory: [state.files, ...state.fileHistory].slice(0, 20),
  };
}

function collectReviewGroups(files: MediaFile[], includeFace = true): Map<string, MediaFile[]> {
  const groups = new Map<string, MediaFile[]>();
  for (const f of files) {
    if (f.burstId && f.burstSize && f.burstSize > 1) {
      const id = `burst:${f.burstId}`;
      groups.set(id, [...(groups.get(id) ?? []), f]);
    }
    if (f.visualGroupId && f.visualGroupSize && f.visualGroupSize > 1) {
      const id = `visual:${f.visualGroupId}`;
      groups.set(id, [...(groups.get(id) ?? []), f]);
    }
    if (includeFace && f.faceGroupId && f.faceGroupSize && f.faceGroupSize > 1) {
      const id = `face:${f.faceGroupId}`;
      groups.set(id, [...(groups.get(id) ?? []), f]);
    }
  }
  return groups;
}

function queueBestPaths(
  files: MediaFile[],
  _options: { cullConfidence?: CullConfidence; groupPhotoEveryoneGood?: boolean; keeperQuota?: KeeperQuota } = {},
): string[] {
  const eligible = files.filter((f) => f.type === 'photo' && f.pick !== 'rejected' && !f.duplicate);
  const groups = collectReviewGroups(eligible, false);
  const groupedPaths = new Set<string>();
  const queued = new Set<string>();

  for (const group of groups.values()) {
    for (const f of group) {
      groupedPaths.add(f.path);
      if (f.pick === 'selected' || f.isProtected || (f.rating ?? 0) > 0) queued.add(f.path);
    }
    const best = bestInGroup(group);
    if (best) queued.add(best.path);
  }

  for (const f of eligible) {
    if (!groupedPaths.has(f.path)) queued.add(f.path);
  }

  return eligible.filter((f) => queued.has(f.path)).map((f) => f.path);
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'SET_VOLUMES':
      return { ...state, volumes: action.volumes };
    case 'SELECT_SOURCE':
      // Clear exposure anchor — its path belongs to the old source and would
      // resolve to `undefined` in `files.find()` once the new scan lands.
      return { ...state, selectedSource: action.path, files: [], phase: 'idle', exposureAnchorPath: null, queuedPaths: [], selectedPaths: [] };
    case 'SCAN_START':
      return { ...state, files: [], phase: 'scanning', scanError: null, focusedIndex: -1, exposureAnchorPath: null, scanPaused: false };
    case 'SCAN_BATCH':
      return { ...state, files: [...state.files, ...action.files] };
    case 'SCAN_COMPLETE': {
      // Guard: ignore stale SCAN_COMPLETE events that arrive after a new
      // SCAN_START has already been dispatched (or after import began).
      // This prevents a cancelled scan's completion from resetting the
      // phase to 'idle' before the new scan's batches arrive.
      if (state.phase !== 'scanning') return state;
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
      return {
        ...state,
        files: grouped,
        phase: state.files.length > 0 ? 'ready' : 'idle',
        scanPaused: false,
        // Reset collapsed state on every rescan — otherwise old IDs accumulate
        collapsedBursts: [],
      };
    }
    case 'SCAN_ERROR':
      return { ...state, phase: 'idle', scanError: action.message, scanPaused: false };
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
      return { ...state, phase: 'importing', importProgress: null, importResult: null };
    case 'IMPORT_PROGRESS':
      return { ...state, importProgress: action.progress };
    case 'IMPORT_COMPLETE':
      return { ...state, phase: 'complete', importResult: action.result };
    case 'DISMISS_SUMMARY':
      // If there are no files in the list (e.g. after auto-import cleared them),
      // return to idle rather than 'ready' — avoids a blank ready-but-empty state.
      return { ...state, phase: state.files.length > 0 ? 'ready' : 'idle', importResult: null, importProgress: null };
    case 'SET_THUMBNAIL':
      return {
        ...state,
        files: state.files.map((f) =>
          f.path === action.filePath ? { ...f, thumbnail: action.thumbnail } : f,
        ),
      };
    case 'SET_THUMBNAILS': {
      const updates = action.thumbnails;
      let changed = false;
      const files = state.files.map((f) => {
        const thumbnail = updates[f.path];
        if (thumbnail === undefined || thumbnail === f.thumbnail) return f;
        changed = true;
        return { ...f, thumbnail };
      });
      return changed ? { ...state, files } : state;
    }
    case 'SET_DUPLICATE':
      return {
        ...state,
        files: state.files.map((f) =>
          f.path === action.filePath ? { ...f, duplicate: true } : f,
        ),
      };
    case 'CLEAR_DUPLICATES':
      return {
        ...state,
        files: state.files.map((f) => ({ ...f, duplicate: false })),
      };
    case 'SET_PICK':
      return withFileHistory(state, state.files.map((f) =>
        f.path === action.filePath ? { ...f, pick: action.pick } : f,
      ));
    case 'SET_PICK_BATCH': {
      const pathSet = new Set(action.filePaths);
      return withFileHistory(state, state.files.map((f) =>
        pathSet.has(f.path) ? { ...f, pick: action.pick } : f,
      ));
    }
    case 'CLEAR_PICKS':
      return withFileHistory(state, state.files.map((f) => ({ ...f, pick: undefined })));
    case 'SET_FOCUSED':
      return { ...state, focusedIndex: action.index };
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
    case 'SET_THEME':
      return { ...state, theme: action.theme };
    case 'TOGGLE_LEFT_PANEL':
      return { ...state, showLeftPanel: !state.showLeftPanel };
    case 'TOGGLE_RIGHT_PANEL':
      return { ...state, showRightPanel: !state.showRightPanel };
    case 'RESET_FILES':
      return { ...state, files: [], phase: 'idle', focusedIndex: -1, queuedPaths: [], selectedPaths: [] };
    case 'SET_RATING':
      return withFileHistory(state, state.files.map((f) =>
        f.path === action.filePath ? { ...f, rating: action.rating } : f,
      ));
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
    case 'TOGGLE_CULL_MODE':
      return { ...state, cullMode: !state.cullMode, viewMode: !state.cullMode ? 'single' : 'grid' };
    case 'SET_SELECTED_PATHS':
      return { ...state, selectedPaths: action.paths };
    case 'QUEUE_ADD_PATHS': {
      const valid = new Set(state.files.map((f) => f.path));
      const next = new Set(state.queuedPaths);
      for (const p of action.paths) if (valid.has(p)) next.add(p);
      return { ...state, queuedPaths: [...next], filter: next.size > 0 ? 'queue' : state.filter };
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
      const paths = [...new Set(action.paths)].filter((p) => state.files.some((f) => f.path === p));
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
      const valid = new Set(state.files.map((f) => f.path));
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
        next.collapsedBursts = [];
      }
      return next;
    }
    case 'SET_WORKFLOW_STRING':
      return { ...state, [action.key]: action.value } as State;
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
      return {
        ...state,
        burstWindowSec: seconds,
        files: state.burstGrouping
          ? groupBursts(state.files, { windowSec: seconds })
          : state.files,
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
    case 'CLEAR_EXPOSURE_ANCHOR':
      return {
        ...withFileHistory(state, state.files.map((f) =>
          f.normalizeToAnchor ? { ...f, normalizeToAnchor: false } : f,
        )),
        exposureAnchorPath: null,
      };
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
      const pathSet = new Set(action.filePaths);
      const temperature = Math.max(-100, Math.min(100, action.temperature));
      const tint = Math.max(-100, Math.min(100, action.tint));
      const nextAdjustment = Math.abs(temperature) >= 0.5 || Math.abs(tint) >= 0.5
        ? { temperature, tint }
        : undefined;
      return withFileHistory(state, state.files.map((f) =>
        pathSet.has(f.path) ? { ...f, whiteBalanceAdjustment: nextAdjustment } : f,
      ));
    }
    case 'SET_EVENT_MODE':
      return { ...state, eventMode: action.mode, files: assignSceneBuckets(state.files, action.mode) };
    case 'SET_CULL_CONFIDENCE':
      return { ...state, cullConfidence: action.confidence };
    case 'SET_GROUP_PHOTO_EVERYONE_GOOD':
      return { ...state, groupPhotoEveryoneGood: action.enabled };
    case 'SET_KEEPER_QUOTA':
      return { ...state, keeperQuota: action.quota };
    case 'SET_NORMALIZE_TO_ANCHOR': {
      const pathSet = new Set(action.filePaths);
      return withFileHistory(state, state.files.map((f) =>
        pathSet.has(f.path)
          ? {
              ...f,
              normalizeToAnchor: action.value &&
                f.path !== state.exposureAnchorPath &&
                typeof f.exposureValue === 'number',
            }
          : f,
      ));
    }
    case 'SET_EXPOSURE_ADJUSTMENT': {
      const pathSet = new Set(action.filePaths);
      const stops = normalizeExposureStops(clampStops(action.stops, state.exposureMaxStops));
      return withFileHistory(state, state.files.map((f) =>
        pathSet.has(f.path) ? { ...f, exposureAdjustmentStops: stops === 0 ? undefined : stops } : f,
      ));
    }
    case 'NUDGE_EXPOSURE_ADJUSTMENT': {
      const pathSet = new Set(action.filePaths);
      return withFileHistory(state, state.files.map((f) => {
        if (!pathSet.has(f.path)) return f;
        const next = normalizeExposureStops(clampStops((f.exposureAdjustmentStops ?? 0) + action.delta, state.exposureMaxStops));
        return { ...f, exposureAdjustmentStops: next === 0 ? undefined : next };
      }));
    }
    case 'NORMALIZE_SELECTION_TO_FOCUSED': {
      const anchor = state.files.find((f) => f.path === action.anchorPath && typeof f.exposureValue === 'number');
      if (!anchor) return state;
      const pathSet = new Set(action.filePaths);
      return {
        ...withFileHistory(state, state.files.map((f) =>
          pathSet.has(f.path)
            ? {
                ...f,
                normalizeToAnchor: f.path !== anchor.path && typeof f.exposureValue === 'number',
              }
            : f,
        )),
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
    case 'SET_SHARPNESS_BATCH':
      return {
        ...state,
        files: state.files.map((f) =>
          Object.prototype.hasOwnProperty.call(action.scores, f.path)
            ? (() => {
                const sharpnessScore = action.scores[f.path];
                const review = scoreReview({ ...f, sharpnessScore });
                return {
                  ...f,
                  sharpnessScore,
                  blurRisk: review.blurRisk,
                  reviewScore: review.score,
                  reviewReasons: review.reasons,
                };
              })()
            : f,
        ),
      };
    case 'SET_REVIEW_SCORES': {
      // In the live app this action is intercepted by ImportProvider before
      // reaching the reducer (see the dispatch override in ImportProvider),
      // so this path only runs in tests that call the reducer directly.
      const patchPaths = Object.keys(action.scores);
      if (patchPaths.length === 0) return state;
      const patchSet = new Set(patchPaths);
      let changed = false;
      const files = state.files.map((f) => {
        if (!patchSet.has(f.path)) return f;
        const patch = action.scores[f.path];
        if (!patch) return f;
        changed = true;
        const merged = { ...f, ...patch };
        const review = scoreReview(merged);
        return {
          ...merged,
          blurRisk: patch.blurRisk ?? review.blurRisk,
          reviewScore: patch.reviewScore ?? review.score,
          reviewReasons: patch.reviewReasons ?? review.reasons,
        };
      });
      return changed ? { ...state, files } : state;
    }
    case 'CLEAR_FACE_DATA':
      // Wipe faceBoxes + subjectSharpnessScore so the background reviewer
      // re-runs analyzeSubject for every photo using the current FaceDetector.
      return {
        ...state,
        files: state.files.map((f) =>
          f.type !== 'photo' ? f : {
            ...f,
            faceBoxes: undefined,
            faceCount: undefined,
            faceDetection: undefined,
            faceEmbedding: undefined,
            faceSignature: undefined,
            faceGroupId: undefined,
            faceGroupSize: undefined,
            personCount: undefined,
            personBoxes: undefined,
            subjectSharpnessScore: undefined,
          },
        ),
      };
    case 'GROUP_VISUAL_DUPLICATES': {
      const groups = groupByVisualHash(state.files, action.threshold ?? 8);
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
          const review = scoreReview(next);
          return { ...next, reviewScore: review.score, blurRisk: review.blurRisk, reviewReasons: review.reasons };
        }),
      };
    }
    case 'GROUP_FACE_SIMILAR': {
      const groups = groupByFaceSimilarity(state.files, 0.69, action.threshold ?? 10);
      const groupByPath = new Map<string, { id: string; size: number }>();
      for (const [id, paths] of Object.entries(groups)) {
        for (const p of paths) groupByPath.set(p, { id, size: paths.length });
      }
      return {
        ...state,
        files: state.files.map((f) => {
          const group = groupByPath.get(f.path);
          const next = group
            ? { ...f, faceGroupId: group.id, faceGroupSize: group.size }
            : { ...f, faceGroupId: undefined, faceGroupSize: undefined };
          const review = scoreReview(next);
          return { ...next, reviewScore: review.score, blurRisk: review.blurRisk, reviewReasons: review.reasons };
        }),
      };
    }
    case 'GROUP_SCENE_BUCKETS':
      return { ...state, files: assignSceneBuckets(state.files, state.eventMode) };
    case 'PICK_BEST_IN_GROUPS': {
      const groups = collectReviewGroups(state.files, true);
      const keepers = new Set<string>();
      for (const group of groups.values()) {
        const best = bestInGroup(group);
        if (best) keepers.add(best.path);
      }
      return withFileHistory(state, state.files.map((f) => {
        const inGroup =
          (f.visualGroupId && groups.has(`visual:${f.visualGroupId}`)) ||
          (f.burstId && groups.has(`burst:${f.burstId}`)) ||
          (f.faceGroupId && groups.has(`face:${f.faceGroupId}`));
        return inGroup ? { ...f, pick: keepers.has(f.path) ? 'selected' : 'rejected' } : f;
      }));
    }
    case 'QUEUE_BEST': {
      const next = queueBestPaths(state.files, {
        cullConfidence: state.cullConfidence,
        groupPhotoEveryoneGood: state.groupPhotoEveryoneGood,
        keeperQuota: state.keeperQuota,
      });
      return { ...state, queuedPaths: next, filter: next.length > 0 ? 'queue' : state.filter };
    }
    case 'AUTO_CULL_SAFE': {
      const groups = collectReviewGroups(state.files, true);
      const reject = new Set<string>();
      const keep = new Set<string>();
      for (const group of groups.values()) {
        const decision = autoCullGroup(group, {
          confidence: state.cullConfidence,
          groupPhotoEveryoneGood: state.groupPhotoEveryoneGood,
          keeperQuota: state.keeperQuota,
        });
        for (const p of decision.keep) keep.add(p);
        for (const p of decision.reject) reject.add(p);
      }

      return withFileHistory(state, state.files.map((f) => {
        if (keep.has(f.path)) return { ...f, pick: 'selected' };
        if (reject.has(f.path)) return { ...f, pick: 'rejected' };
        return f;
      }));
    }
    case 'REJECT_DUPLICATES':
      return withFileHistory(state, state.files.map((f) =>
        f.duplicate ? { ...f, pick: 'rejected' } : f,
      ));
    case 'SYNC_EDITS_FROM_FOCUSED': {
      const focused = action.filePath
        ? state.files.find((f) => f.path === action.filePath)
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
      return withFileHistory(state, state.files.map((f) =>
        targetPaths.has(f.path)
          ? {
              ...f,
              exposureAdjustmentStops: focused.exposureAdjustmentStops,
              normalizeToAnchor: focused.normalizeToAnchor && typeof f.exposureValue === 'number',
              whiteBalanceAdjustment: focused.whiteBalanceAdjustment,
            }
          : f,
      ));
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
      const pathSet = new Set(action.filePaths);
      const candidates = state.files
        .filter((f) => pathSet.has(f.path) && typeof f.exposureValue === 'number')
        .slice()
        .sort((a, b) => (a.exposureValue as number) - (b.exposureValue as number));
      if (candidates.length === 0) return state;
      const anchor = candidates[Math.floor((candidates.length - 1) / 2)];
      return {
        ...withFileHistory(state, state.files.map((f) => {
          if (!pathSet.has(f.path)) return f;
          if (f.path === anchor.path) {
            // The anchor itself never needs normalizing.
            return { ...f, normalizeToAnchor: false };
          }
          return { ...f, normalizeToAnchor: typeof f.exposureValue === 'number' };
        })),
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
        files: [],
        phase: 'idle',
        exposureAnchorPath: null,
        queuedPaths: [],
        selectedPaths: [],
        importResult: null,
        importProgress: null,
        fileHistory: [],
        focusedIndex: -1,
        filter: 'all',
      };
    }
    case 'HYDRATE_LICENSE_STATUS': {
      const valid = !!action.status?.valid;
      return {
        ...state,
        licenseStatus: action.status,
        licenseHydrated: true,
        licensePromptOpen: false,
        licenseBannerDismissed: false,
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
        };
      }
      if (action.tier === 'balanced') {
        return {
          ...state,
          perfTier: action.tier,
          cpuOptimization: true,
          fastKeeperMode: false,
          previewConcurrency: 2,
          faceConcurrency: 1,
          rawPreviewQuality: Math.max(65, Math.min(state.rawPreviewQuality, 75)),
        };
      }
      if (action.tier === 'high') {
        return {
          ...state,
          perfTier: action.tier,
          fastKeeperMode: false,
          previewConcurrency: Math.max(3, state.previewConcurrency),
          faceConcurrency: Math.max(2, state.faceConcurrency),
          rawPreviewQuality: Math.max(state.rawPreviewQuality, 82),
        };
      }
      return { ...state, perfTier: action.tier };
    case 'SET_FAST_KEEPER_MODE':
      return { ...state, fastKeeperMode: action.enabled };
    case 'SET_PREVIEW_CONCURRENCY':
      return { ...state, previewConcurrency: action.concurrency };
    case 'SET_FACE_CONCURRENCY':
      return { ...state, faceConcurrency: action.concurrency };
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
type ReviewPatch = Partial<MediaFile> & { reviewScore?: number; blurRisk?: MediaFile['blurRisk']; reviewReasons?: string[] };
const ReviewScoresContext = createContext<Map<string, ReviewPatch>>(new Map());
const ReviewScoresVersionContext = createContext<number>(0);

export function ImportProvider({ children }: { children: ReactNode }) {
  const [state, rawDispatch] = useReducer(reducer, initialState);

  // Mutable ref to current state so the dispatch interceptor can read files
  // without stale closure issues (the dispatch callback has [] deps).
  const stateRef = useRef(state);
  stateRef.current = state;

  // Mutable map of review score overlays — never triggers a re-render itself.
  const reviewScoresRef = useRef<Map<string, ReviewPatch>>(new Map());
  // Version counter: bumped on every SET_REVIEW_SCORES so consumers re-render.
  const [reviewVersion, setReviewVersion] = useState(0);

  // Intercept SET_REVIEW_SCORES before it hits the reducer.
  const dispatch = useCallback<Dispatch<Action>>((action) => {
    if (action.type === 'SET_REVIEW_SCORES') {
      const scores = action.scores;
      if (Object.keys(scores).length === 0) return;
      let dirty = false;
      for (const [p, patch] of Object.entries(scores)) {
        if (patch) { reviewScoresRef.current.set(p, patch); dirty = true; }
      }
      if (dirty) setReviewVersion((v) => v + 1);
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
      action.type === 'ADVANCE_VOLUME_IMPORT_QUEUE'
    ) {
      reviewScoresRef.current.clear();
      setReviewVersion((v) => v + 1);
    }
    if (action.type === 'CLEAR_PICKS') {
      setReviewVersion((v) => v + 1);
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
      const mergedFiles: MediaFile[] = rawFiles.map((f) => {
        const patch = overlay.get(f.path);
        if (!patch) return f;
        const merged = { ...f, ...patch };
        if (patch.reviewScore === undefined) {
          const review = scoreReview(merged);
          merged.blurRisk = patch.blurRisk ?? review.blurRisk;
          merged.reviewScore = review.score;
          merged.reviewReasons = review.reasons;
        }
        return merged;
      });
      const current = stateRef.current;
      const next = queueBestPaths(mergedFiles, {
        cullConfidence: current.cullConfidence,
        groupPhotoEveryoneGood: current.groupPhotoEveryoneGood,
        keeperQuota: current.keeperQuota,
      });
      rawDispatch({ type: 'QUEUE_ADD_PATHS', paths: next });
      if (next.length > 0) rawDispatch({ type: 'SET_FILTER', filter: 'queue' });
      return;
    }
    rawDispatch(action);
  }, []);

  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>
        <ReviewScoresContext.Provider value={reviewScoresRef.current}>
          <ReviewScoresVersionContext.Provider value={reviewVersion}>
            {children}
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

/**
 * Returns state.files with review score overlays merged in.
 * Re-renders when either the files array or review scores change.
 * Use this instead of useAppState().files anywhere face scores are needed.
 */
export function useMergedFiles(): MediaFile[] {
  const { files } = useContext(StateContext);
  const scores = useContext(ReviewScoresContext);
  const version = useContext(ReviewScoresVersionContext);

  return useMemo(() => {
    if (scores.size === 0) return files;
    return files.map((f) => {
      const patch = scores.get(f.path);
      if (!patch) return f;
      const merged = { ...f, ...patch };
      // Only recompute review score if not already provided in the patch
      if (patch.reviewScore === undefined) {
        const review = scoreReview(merged);
        merged.blurRisk = patch.blurRisk ?? review.blurRisk;
        merged.reviewScore = review.score;
        merged.reviewReasons = review.reasons;
      }
      return merged;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, version]);
}
