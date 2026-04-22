import { createContext, useContext, useReducer, type Dispatch, type ReactNode } from 'react';
import type { Volume, MediaFile, ImportProgress, ImportResult, SaveFormat, SourceKind, FtpConfig } from '../../shared/types';
import { FOLDER_PRESETS } from '../../shared/types';
import { groupBursts } from '../../shared/burst';

export type AppPhase = 'idle' | 'scanning' | 'ready' | 'importing' | 'complete';
export type ViewMode = 'grid' | 'single' | 'split';

export type FilterMode = 'all' | 'protected' | 'picked' | 'rejected' | 'unrated' | 'duplicates';

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
  // Workflow options
  separateProtected: boolean;
  protectedFolderName: string;
  backupDestRoot: string;
  autoEject: boolean;
  playSoundOnComplete: boolean;
  openFolderOnComplete: boolean;
  autoImport: boolean;
  autoImportDestRoot: string;
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
  | { type: 'SET_WORKFLOW_OPTION'; key:
      | 'separateProtected' | 'autoEject' | 'playSoundOnComplete'
      | 'openFolderOnComplete' | 'autoImport'
      | 'burstGrouping' | 'normalizeExposure'; value: boolean }
  | { type: 'SET_WORKFLOW_STRING'; key:
      | 'protectedFolderName' | 'backupDestRoot' | 'autoImportDestRoot'; value: string }
  | { type: 'SET_BURST_WINDOW'; seconds: number }
  | { type: 'TOGGLE_BURST_COLLAPSE'; burstId: string }
  | { type: 'COLLAPSE_ALL_BURSTS' }
  | { type: 'CLEAR_COLLAPSED_BURSTS' }
  | { type: 'SET_EXPOSURE_ANCHOR'; path: string | null }
  | { type: 'SET_EXPOSURE_MAX_STOPS'; stops: number }
  | { type: 'SET_NORMALIZE_TO_ANCHOR'; filePaths: string[]; value: boolean }
  /**
   * Pick the median-EV file among the given paths as the exposure anchor,
   * and mark every other path in the set as "normalize-to-anchor". This is
   * the one-shot "make this batch consistent" workflow for bulk selection.
   */
  | { type: 'NORMALIZE_SELECTION_TO_MEDIAN'; filePaths: string[] };

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
  separateProtected: false,
  protectedFolderName: '_Protected',
  backupDestRoot: '',
  autoEject: false,
  playSoundOnComplete: false,
  openFolderOnComplete: false,
  autoImport: false,
  autoImportDestRoot: '',
  burstGrouping: true,
  burstWindowSec: 2,
  collapsedBursts: [],
  normalizeExposure: false,
  exposureAnchorPath: null,
  exposureMaxStops: 2,
};

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'SET_VOLUMES':
      return { ...state, volumes: action.volumes };
    case 'SELECT_SOURCE':
      // Clear exposure anchor — its path belongs to the old source and would
      // resolve to `undefined` in `files.find()` once the new scan lands.
      return { ...state, selectedSource: action.path, files: [], phase: 'idle', exposureAnchorPath: null };
    case 'SCAN_START':
      return { ...state, files: [], phase: 'scanning', scanError: null, focusedIndex: -1, exposureAnchorPath: null };
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
        phase: state.files.length > 0 ? 'ready' : 'idle',
        // Reset collapsed state on every rescan — otherwise old IDs accumulate
        collapsedBursts: [],
      };
    }
    case 'SCAN_ERROR':
      return { ...state, phase: 'idle', scanError: action.message };
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
      return {
        ...state,
        files: state.files.map((f) =>
          f.path === action.filePath ? { ...f, pick: action.pick } : f,
        ),
      };
    case 'SET_PICK_BATCH': {
      const pathSet = new Set(action.filePaths);
      return {
        ...state,
        files: state.files.map((f) =>
          pathSet.has(f.path) ? { ...f, pick: action.pick } : f,
        ),
      };
    }
    case 'CLEAR_PICKS':
      return {
        ...state,
        files: state.files.map((f) => ({ ...f, pick: undefined })),
      };
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
      return { ...state, files: [], phase: 'idle', focusedIndex: -1 };
    case 'SET_RATING':
      return {
        ...state,
        files: state.files.map((f) =>
          f.path === action.filePath ? { ...f, rating: action.rating } : f,
        ),
      };
    case 'SET_SOURCE_KIND':
      return { ...state, sourceKind: action.kind };
    case 'SET_FTP_CONFIG':
      return { ...state, ftpConfig: { ...state.ftpConfig, ...action.config } };
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
    case 'SET_EXPOSURE_MAX_STOPS':
      return { ...state, exposureMaxStops: Math.max(0.33, Math.min(4, action.stops)) };
    case 'SET_NORMALIZE_TO_ANCHOR': {
      const pathSet = new Set(action.filePaths);
      return {
        ...state,
        files: state.files.map((f) =>
          pathSet.has(f.path) ? { ...f, normalizeToAnchor: action.value } : f,
        ),
      };
    }
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
        ...state,
        exposureAnchorPath: anchor.path,
        files: state.files.map((f) => {
          if (!pathSet.has(f.path)) return f;
          if (f.path === anchor.path) {
            // The anchor itself never needs normalizing.
            return { ...f, normalizeToAnchor: false };
          }
          return { ...f, normalizeToAnchor: true };
        }),
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
