export interface Volume {
  name: string;
  path: string;
  isRemovable: boolean;
  isExternal: boolean;
  totalSize?: number;
  freeSpace?: number;
  /** True when the volume root contains a `DCIM` folder (camera card). */
  hasDcim?: boolean;
}

export interface MediaFile {
  path: string;
  name: string;
  size: number;
  type: 'photo' | 'video';
  extension: string;
  dateTaken?: string;
  destPath?: string;
  thumbnail?: string; // base64 data URI
  duplicate?: boolean;
  pick?: 'selected' | 'rejected';
  orientation?: number; // EXIF orientation (1-8), 6/8 = portrait
  iso?: number;
  aperture?: number;
  shutterSpeed?: number;
  focalLength?: number;
  cameraMake?: string;
  cameraModel?: string;
  lensModel?: string;
  /** 0-5 star rating from EXIF xmp:Rating / MakerNote */
  rating?: number;
  /**
   * True when the file is read-only (filesystem attribute) or flagged as
   * "Protect" in the camera's in-body protect workflow. The UI sorts
   * protected files to the top so you can pull keepers fast.
   */
  isProtected?: boolean;
  /**
   * Burst-shot grouping. Computed after scan completes by clustering photos
   * taken within ~2s of each other on the same camera body. Single shots have
   * no burstId. The UI uses this to render a visual group marker and to let
   * the user pick/reject a whole burst with one keystroke.
   */
  burstId?: string;
  /** Position within the burst (1-based) — UI badge shows "2/7". */
  burstIndex?: number;
  /** Total shots in this file's burst. */
  burstSize?: number;
  /**
   * Photographic Exposure Value, computed from ISO/aperture/shutter. This is
   * the EV at ISO 100 equivalent — higher = more light captured. Used for the
   * "match exposure to anchor" workflow and for a quick "is this batch
   * consistent?" signal in the detail view.
   */
  exposureValue?: number;
}

export type SourceKind = 'volume' | 'ftp';

export interface FtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  secure: boolean; // explicit FTPS
  remotePath: string; // e.g. /DCIM
}

export type SaveFormat = 'original' | 'jpeg' | 'tiff' | 'heic';

// Folder naming presets for organizing imported files
// Tokens: {YYYY}, {MM}, {DD}, {filename}, {ext}
export const FOLDER_PRESETS: Record<string, { label: string; pattern: string }> = {
  'date-flat':   { label: 'YYYY-MM-DD',           pattern: '{YYYY}-{MM}-{DD}/{filename}' },
  'date-nested': { label: 'YYYY / MM / DD',       pattern: '{YYYY}/{MM}/{DD}/{filename}' },
  'year-month':  { label: 'YYYY / MM',            pattern: '{YYYY}/{MM}/{filename}' },
  'year':        { label: 'YYYY',                  pattern: '{YYYY}/{filename}' },
  'flat':        { label: 'No folders',            pattern: '{filename}' },
};

export interface ImportConfig {
  sourcePath: string;
  destRoot: string;
  skipDuplicates: boolean;
  saveFormat: SaveFormat;
  jpegQuality: number; // 1-100, only used when saveFormat is 'jpeg'
  /**
   * Absolute source paths of files to import. When provided and non-empty, ONLY
   * these files will be imported. This is how the UI's click-selection (Cmd/Ctrl+Click,
   * Shift+Click) communicates "import just these" to the main process. If omitted or
   * empty, falls back to the renderer's pick/reject model.
   */
  selectedPaths?: string[];
  /**
   * When true, files flagged as protected (filesystem read-only or in-camera
   * Protect) are written under {destRoot}/{protectedFolderName}/{pattern} instead
   * of sharing the same date folders as the unprotected shots.
   */
  separateProtected?: boolean;
  /** Subfolder name for protected files. Default: "_Protected". */
  protectedFolderName?: string;
  /**
   * Optional second destination. When set, every successful import is also
   * copied here (same pattern, same skip-duplicates rules). Use to back up to
   * two drives in one pass.
   */
  backupDestRoot?: string;
  /** After a successful import, attempt to eject the source volume. */
  autoEject?: boolean;
  /**
   * Dry run: compute all destination paths and surface them in the result
   * without actually copying anything.
   */
  dryRun?: boolean;
  /**
   * Exposure normalization. When enabled and `exposureAnchorEV` is set, the
   * import pipeline adjusts brightness (in stops) so every output matches the
   * anchor's EV. Only takes effect when `saveFormat` transcodes (jpeg/tiff/heic);
   * with `original` we can't rewrite pixels so the setting is ignored.
   */
  normalizeExposure?: boolean;
  exposureAnchorEV?: number;
  /**
   * Hard clamp on how much brightness the normalizer is allowed to shift, in
   * stops. Default ±2 — anything past that usually means the anchor is wrong
   * or the source is underexposed past recovery.
   */
  exposureMaxStops?: number;
}

export interface ImportProgress {
  currentFile: string;
  currentIndex: number;
  totalFiles: number;
  bytesTransferred: number;
  totalBytes: number;
  skipped: number;
  errors: number;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: ImportError[];
  totalBytes: number;
  durationMs: number;
}

export interface ImportError {
  file: string;
  error: string;
}

export interface AppSettings {
  lastDestination: string;
  skipDuplicates: boolean;
  saveFormat: SaveFormat;
  jpegQuality: number;
  folderPreset: string;      // key from FOLDER_PRESETS or 'custom'
  customPattern: string;     // user-defined pattern when folderPreset is 'custom'
  theme: 'light' | 'dark';
  // Workflow
  separateProtected: boolean;
  protectedFolderName: string;
  backupDestRoot: string;        // empty string = disabled
  autoEject: boolean;
  playSoundOnComplete: boolean;
  openFolderOnComplete: boolean;
  // Auto-import on device insert
  autoImport: boolean;
  autoImportDestRoot: string;
  /** Set to true after the first-run prompt has been shown. */
  autoImportPromptSeen: boolean;
  // Burst grouping
  burstGrouping: boolean;
  /** Max gap between consecutive shots (seconds) to count as one burst. */
  burstWindowSec: number;
  // Exposure normalization
  normalizeExposure: boolean;
  exposureMaxStops: number;
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  releaseName: string;
}

export const PHOTO_EXTENSIONS = new Set([
  // Common
  '.jpg', '.jpeg', '.png', '.tif', '.tiff', '.heic', '.heif', '.webp', '.avif',
  // Canon
  '.cr2', '.cr3', '.crw',
  // Nikon
  '.nef', '.nrw',
  // Sony
  '.arw', '.srf', '.sr2',
  // Fujifilm
  '.raf',
  // Olympus / OM System
  '.orf',
  // Panasonic
  '.rw2',
  // Pentax
  '.pef',
  // Samsung
  '.srw',
  // Leica
  '.rwl',
  // Sigma
  '.x3f',
  // Hasselblad
  '.3fr', '.fff',
  // Phase One
  '.iiq',
  // Adobe / Generic
  '.dng',
  // GoPro
  '.gpr',
  // Minolta (legacy)
  '.mrw',
  // Epson
  '.erf',
]);

export const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mov', '.avi', '.mts', '.m2ts', '.mkv',
]);

export const ALL_MEDIA_EXTENSIONS = new Set([
  ...PHOTO_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
]);

export function resolvePattern(pattern: string, date: Date, fileName: string, ext: string): string {
  const y = date.getFullYear().toString();
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const d = date.getDate().toString().padStart(2, '0');
  const baseName = fileName.replace(new RegExp(`\\${ext}$`, 'i'), '');
  return pattern
    .replace(/\{YYYY\}/g, y)
    .replace(/\{MM\}/g, m)
    .replace(/\{DD\}/g, d)
    .replace(/\{filename\}/g, fileName)
    .replace(/\{name\}/g, baseName)
    .replace(/\{ext\}/g, ext.replace('.', ''));
}

export const IPC = {
  // Volumes
  VOLUMES_LIST: 'volumes:list',
  VOLUMES_CHANGED: 'volumes:changed',

  // Scanning
  SCAN_START: 'scan:start',
  SCAN_BATCH: 'scan:batch',
  SCAN_COMPLETE: 'scan:complete',
  SCAN_THUMBNAIL: 'scan:thumbnail',
  SCAN_CHECK_DUPLICATES: 'scan:check-duplicates',
  SCAN_DUPLICATE: 'scan:duplicate',
  SCAN_CANCEL: 'scan:cancel',
  SCAN_PREVIEW: 'scan:preview',

  // Import
  IMPORT_START: 'import:start',
  IMPORT_PROGRESS: 'import:progress',
  IMPORT_COMPLETE: 'import:complete',
  IMPORT_CANCEL: 'import:cancel',

  // Dialogs
  DIALOG_SELECT_FOLDER: 'dialog:select-folder',
  DIALOG_OPEN_PATH: 'dialog:open-path',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',

  // Updates
  UPDATE_AVAILABLE: 'update:available',
  UPDATE_OPEN_RELEASE: 'update:open-release',

  // FTP source
  FTP_PROBE: 'ftp:probe',
  FTP_MIRROR_START: 'ftp:mirror-start',
  FTP_MIRROR_PROGRESS: 'ftp:mirror-progress',
  FTP_MIRROR_CANCEL: 'ftp:mirror-cancel',

  // Workflow — manifest export
  EXPORT_MANIFEST: 'export:manifest',

  // Auto-import + device events
  DEVICE_INSERTED: 'device:inserted',
  AUTO_IMPORT_STARTED: 'auto-import:started',
  EJECT_VOLUME: 'volume:eject',
  DISK_FREE_SPACE: 'disk:free-space',
} as const;
