import { createContext, useContext, useReducer, type Dispatch, type ReactNode } from 'react';
import type { Volume, MediaFile, ImportProgress, ImportResult, SaveFormat, SourceKind, FtpConfig, RatingFilter, SelectionSet } from '../../shared/types';
import { FOLDER_PRESETS } from '../../shared/types';
import { groupBursts } from '../../shared/burst';
import { bestInGroup, faceQuality, groupByFaceSignature, groupByVisualHash, keeperScore, scoreReview } from '../../shared/review';

export type AppPhase = 'idle' | 'scanning' | 'ready' | 'importing' | 'complete';
export type ViewMode = 'grid' | 'single' | 'split' | 'compare' | 'settings';

export type FilterMode = 'all' | 'protected' | 'picked' | 'rejected' | 'unrated' | 'duplicates' | 'unmarked' | 'queue' | 'best' | 'faces' | 'face-groups' | 'blur-risk' | 'near-duplicates' | 'review-needed' | 'needs-exposure' | 'normalized' | 'adjusted' | 'photos' | 'videos' | 'raw' | RatingFilter | `camera:${string}` | `lens:${string}` | `date:${string}` | `ext:${string}`;

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
  theme: 'light' | 'dark';
  showLeftPanel: boolean;
  showRightPanel: boolean;
  sourceKind: SourceKind;
  ftpConfig: FtpConfig;
  ftpStatus: 'idle' | 'probing' | 'mirroring' | 'error';
  ftpMessage: string | null;
  ftpProgress: { done: number; total: number; name: string } | null;
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
      | 'burstGrouping' | 'normalizeExposure' | 'verifyChecksums' | 'ftpDestEnabled'; value: boolean }
  | { type: 'SET_WORKFLOW_STRING'; key:
      | 'protectedFolderName' | 'backupDestRoot' | 'autoImportDestRoot' | 'completeSoundPath'; value: string }
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
  | { type: 'SET_NORMALIZE_TO_ANCHOR'; filePaths: string[]; value: boolean }
  | { type: 'SET_EXPOSURE_ADJUSTMENT'; filePaths: string[]; stops: number }
  | { type: 'NUDGE_EXPOSURE_ADJUSTMENT'; filePaths: string[]; delta: number }
  | { type: 'NORMALIZE_SELECTION_TO_FOCUSED'; filePaths: string[]; anchorPath: string }
  | { type: 'PICK_BURST_KEEPERS' }
  | { type: 'SET_SHARPNESS_BATCH'; scores: Record<string, number> }
  | { type: 'SET_REVIEW_SCORES'; scores: Record<string, Partial<MediaFile>> }
  | { type: 'GROUP_VISUAL_DUPLICATES'; threshold?: number }
  | { type: 'GROUP_FACE_SIMILAR'; threshold?: number }
  | { type: 'PICK_BEST_IN_GROUPS' }
  | { type: 'QUEUE_BEST' }
  | { type: 'AUTO_CULL_SAFE' }
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
  | { type: 'ADVANCE_VOLUME_IMPORT_QUEUE' };

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
    remotePath: '/PhotoImporter',
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
};

function withFileHistory(state: State, files: MediaFile[]): State {
  return {
    ...state,
    files,
    fileHistory: [state.files, ...state.fileHistory].slice(0, 20),
  };
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
      // Bursts can only be reliably grouped once every file has a parsed
      // dateTaken, so we do it here (not per-batch). If the user has toggled
      // grouping off, just drop any stale burst data.
      const grouped = state.burstGrouping
        ? groupBursts(state.files, { windowSec: state.burstWindowSec })
        : state.files.map((f) => {
            if (f.burstId || f.burstIndex || f.burstSize) {
              const { burstId: _b, burstIndex: _i, burstSize: _s, ...rest } = f;
              return rest;
            }
            return f;
          });
      return {
        ...state,
        files: grouped,
        phase: state.phase === 'importing'
          ? 'importing'
          : (state.files.length > 0 ? 'ready' : 'idle'),
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
      return { ...state, phase: 'ready', importResult: null, importProgress: null };
    case 'SET_THUMBNAIL':
      return {
        ...state,
        files: state.files.map((f) =>
          f.path === action.filePath ? { ...f, thumbnail: action.thumbnail } : f,
        ),
      };
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
        ftpMessage: action.message ?? state.ftpMessage,
      };
    case 'SET_FTP_PROGRESS':
      return { ...state, ftpProgress: action.progress };
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
    case 'SET_NORMALIZE_TO_ANCHOR': {
      const pathSet = new Set(action.filePaths);
      return withFileHistory(state, state.files.map((f) =>
        pathSet.has(f.path) ? { ...f, normalizeToAnchor: action.value } : f,
      ));
    }
    case 'SET_EXPOSURE_ADJUSTMENT': {
      const pathSet = new Set(action.filePaths);
      const stops = Math.max(-state.exposureMaxStops, Math.min(state.exposureMaxStops, action.stops));
      return withFileHistory(state, state.files.map((f) =>
        pathSet.has(f.path) ? { ...f, exposureAdjustmentStops: Math.abs(stops) < 0.01 ? undefined : stops } : f,
      ));
    }
    case 'NUDGE_EXPOSURE_ADJUSTMENT': {
      const pathSet = new Set(action.filePaths);
      return withFileHistory(state, state.files.map((f) => {
        if (!pathSet.has(f.path)) return f;
        const next = Math.max(-state.exposureMaxStops, Math.min(state.exposureMaxStops, (f.exposureAdjustmentStops ?? 0) + action.delta));
        return { ...f, exposureAdjustmentStops: Math.abs(next) < 0.01 ? undefined : Math.round(next * 100) / 100 };
      }));
    }
    case 'NORMALIZE_SELECTION_TO_FOCUSED': {
      const anchor = state.files.find((f) => f.path === action.anchorPath && typeof f.exposureValue === 'number');
      if (!anchor) return state;
      const pathSet = new Set(action.filePaths);
      return {
        ...withFileHistory(state, state.files.map((f) =>
          pathSet.has(f.path) ? { ...f, normalizeToAnchor: f.path !== anchor.path } : f,
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
    case 'SET_REVIEW_SCORES':
      return {
        ...state,
        files: state.files.map((f) => {
          const patch = action.scores[f.path];
          if (!patch) return f;
          const merged = { ...f, ...patch };
          const review = scoreReview(merged);
          return {
            ...merged,
            blurRisk: patch.blurRisk ?? review.blurRisk,
            reviewScore: patch.reviewScore ?? review.score,
            reviewReasons: patch.reviewReasons ?? review.reasons,
          };
        }),
      };
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
            faceSignature: undefined,
            faceGroupId: undefined,
            faceGroupSize: undefined,
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
      const groups = groupByFaceSignature(state.files, action.threshold ?? 10);
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
    case 'PICK_BEST_IN_GROUPS': {
      const groups = new Map<string, MediaFile[]>();
      for (const f of state.files) {
        if (f.visualGroupId && f.visualGroupSize && f.visualGroupSize > 1) {
          groups.set(f.visualGroupId, [...(groups.get(f.visualGroupId) ?? []), f]);
        }
        if (f.burstId && f.burstSize && f.burstSize > 1) {
          const id = `burst:${f.burstId}`;
          groups.set(id, [...(groups.get(id) ?? []), f]);
        }
      }
      const keepers = new Set<string>();
      for (const group of groups.values()) {
        const best = bestInGroup(group);
        if (best) keepers.add(best.path);
      }
      return withFileHistory(state, state.files.map((f) => {
        const inGroup = (f.visualGroupId && groups.has(f.visualGroupId)) || (f.burstId && groups.has(`burst:${f.burstId}`));
        return inGroup ? { ...f, pick: keepers.has(f.path) ? 'selected' : 'rejected' } : f;
      }));
    }
    case 'QUEUE_BEST': {
      const candidates = state.files
        .filter((f) => f.type === 'photo' && f.pick !== 'rejected' && !f.duplicate)
        .sort((a, b) =>
          Number(!!b.isProtected) - Number(!!a.isProtected) ||
          (b.rating ?? 0) - (a.rating ?? 0) ||
          keeperScore(b) - keeperScore(a) ||
          faceQuality(b) - faceQuality(a) ||
          (b.reviewScore ?? 0) - (a.reviewScore ?? 0),
        );
      const groupByPath = new Set<string>();
      const groups = new Map<string, MediaFile[]>();
      for (const f of candidates) {
        const groupId =
          f.burstId && f.burstSize && f.burstSize > 1 ? `burst:${f.burstId}` :
          f.visualGroupId && f.visualGroupSize && f.visualGroupSize > 1 ? `visual:${f.visualGroupId}` :
          f.faceGroupId && f.faceGroupSize && f.faceGroupSize > 1 ? `face:${f.faceGroupId}` :
          null;
        if (groupId) {
          groupByPath.add(f.path);
          groups.set(groupId, [...(groups.get(groupId) ?? []), f]);
        }
      }

      const next = new Set<string>();
      for (const f of candidates) {
        if ((f.rating ?? 0) > 0 || f.pick === 'selected') next.add(f.path);
      }
      const autoBestInGroup = (group: MediaFile[]): MediaFile | null => {
        if (group.length === 0) return null;
        return group.slice().sort((a, b) =>
          Number(!!b.isProtected) - Number(!!a.isProtected) ||
          faceQuality(b) - faceQuality(a) ||
          (b.faceCount ?? 0) - (a.faceCount ?? 0) ||
          (b.subjectSharpnessScore ?? 0) - (a.subjectSharpnessScore ?? 0) ||
          Number(a.blurRisk === 'high') - Number(b.blurRisk === 'high') ||
          (b.sharpnessScore ?? 0) - (a.sharpnessScore ?? 0) ||
          (b.reviewScore ?? 0) - (a.reviewScore ?? 0) ||
          keeperScore(b) - keeperScore(a) ||
          (a.burstIndex ?? 0) - (b.burstIndex ?? 0),
        )[0];
      };
      for (const group of groups.values()) {
        const best = autoBestInGroup(group);
        if (!best) continue;
        if (best.pick === 'selected' || best.isProtected || (best.rating ?? 0) > 0 || keeperScore(best) >= 70 || (best.reviewScore ?? 0) >= 62) {
          next.add(best.path);
        }
      }

      const targetCount = Math.min(120, Math.max(8, Math.ceil(candidates.length * 0.08)));
      for (const f of candidates) {
        if (next.has(f.path)) continue;
        if (f.pick === 'selected') {
          next.add(f.path);
          continue;
        }
        if (groupByPath.has(f.path)) continue;
        if ((keeperScore(f) >= 85 || (f.reviewScore ?? 0) >= 70 || (f.rating ?? 0) > 0 || f.isProtected) && next.size < targetCount) {
          next.add(f.path);
        }
      }
      return { ...state, queuedPaths: [...next], filter: next.size > 0 ? 'queue' : state.filter };
    }
    case 'AUTO_CULL_SAFE': {
      const groups = new Map<string, MediaFile[]>();
      for (const f of state.files) {
        if (f.burstId && f.burstSize && f.burstSize > 1) {
          groups.set(`burst:${f.burstId}`, [...(groups.get(`burst:${f.burstId}`) ?? []), f]);
        }
        if (f.visualGroupId && f.visualGroupSize && f.visualGroupSize > 1) {
          groups.set(`visual:${f.visualGroupId}`, [...(groups.get(`visual:${f.visualGroupId}`) ?? []), f]);
        }
      }

      const reject = new Set<string>();
      const keep = new Set<string>();
      for (const group of groups.values()) {
        const best = bestInGroup(group);
        if (!best) continue;
        keep.add(best.path);
        for (const file of group) {
          if (file.path === best.path) continue;
          if (file.isProtected || (file.rating ?? 0) > 0 || file.pick === 'selected') continue;
          const muchWorse =
            (file.blurRisk === 'high' && faceQuality(file) < 45) ||
            (faceQuality(best) - faceQuality(file) >= 45) ||
            ((best.subjectSharpnessScore ?? 0) - (file.subjectSharpnessScore ?? 0) >= 25) ||
            ((best.sharpnessScore ?? 0) - (file.sharpnessScore ?? 0) >= 60) ||
            (keeperScore(best) - keeperScore(file) >= 42) ||
            ((best.reviewScore ?? 0) - (file.reviewScore ?? 0) >= 22);
          if (muchWorse) reject.add(file.path);
        }
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
          return { ...f, normalizeToAnchor: true };
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
    default:
      return state;
  }
}

const StateContext = createContext<State>(initialState);
const DispatchContext = createContext<Dispatch<Action>>(() => {});

export function ImportProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>
        {children}
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
