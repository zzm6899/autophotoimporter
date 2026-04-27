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
  /**
   * When true, this file's exposure will be normalized to the anchor's EV on
   * import regardless of the global `normalizeExposure` toggle. Set via the
   * "Normalize to anchor" button in the grid toolbar or detail view.
   */
  normalizeToAnchor?: boolean;
  /** Manual exposure offset in stops, applied on import when transcoding. */
  exposureAdjustmentStops?: number;
  /** Renderer-computed focus metric used to pick burst keepers. Higher = sharper. */
  sharpnessScore?: number;
  /** Face/subject-aware focus metric. Higher = sharper subject area. */
  subjectSharpnessScore?: number;
  /** Number of faces found by local browser face detection, when available. */
  faceCount?: number;
  /** Normalized face boxes from local browser face detection. eyeScore=2 means both eyes detected (open). */
  faceBoxes?: Array<{ x: number; y: number; width: number; height: number; eyeScore?: number; score?: number }>;
  /** Whether faces came from Chromium's detector or the conservative thumbnail fallback. */
  faceDetection?: 'native' | 'estimated';
  /** Number of person/body detections from the ONNX review pipeline. */
  personCount?: number;
  /** Normalized person/body boxes from the ONNX review pipeline. */
  personBoxes?: Array<{ x: number; y: number; width: number; height: number; score?: number }>;
  /** Compact perceptual hash of the primary detected face crop. Used only for local same-face clustering. */
  faceSignature?: string;
  /**
   * Hex-serialised L2-normalised face embedding from MobileFaceNet
   * (via onnxruntime-node). Use deserializeEmbedding() to
   * recover the Float32Array, then cosineSimilarity() to compare.
   * Only populated when the ONNX face models are present on disk.
   */
  faceEmbedding?: string;
  /** Local cluster id for similar detected faces. This is not biometric identity; it is a culling aid. */
  faceGroupId?: string;
  faceGroupSize?: number;
  /** Local review notes for subject/face focus. */
  subjectReasons?: string[];
  /** Heuristic blur risk derived from thumbnail/previews. */
  blurRisk?: 'low' | 'medium' | 'high';
  /** 64-bit perceptual hash encoded as 16 hex chars. */
  visualHash?: string;
  /** Group id for visually similar shots. */
  visualGroupId?: string;
  visualGroupSize?: number;
  /** 0-100 local smart-review score. Higher = stronger keeper candidate. */
  reviewScore?: number;
  reviewReasons?: string[];
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
export type RatingFilter = 'rating-1' | 'rating-2' | 'rating-3' | 'rating-4' | 'rating-5';

export interface SelectionSet {
  name: string;
  paths: string[];
  createdAt: string;
}

export interface LicenseEntitlement {
  product: string;
  name: string;
  email?: string;
  issuedAt: string;
  expiresAt?: string;
  tier?: string;
  notes?: string;
  maxDevices?: number;
}

export interface LicenseValidation {
  valid: boolean;
  key?: string;
  message: string;
  entitlement?: LicenseEntitlement;
  activationCode?: string;
  status?: 'active' | 'revoked' | 'expired' | 'disabled' | 'unknown';
  deviceId?: string;
  deviceName?: string;
  deviceSlotsUsed?: number;
  deviceSlotsTotal?: number;
  currentDeviceRegistered?: boolean;
}

// Folder naming presets for organizing imported files
// Tokens: {YYYY}, {MM}, {DD}, {filename}, {name}, {ext}, {rating}
export const FOLDER_PRESETS: Record<string, { label: string; pattern: string }> = {
  'date-flat':      { label: 'YYYY-MM-DD',               pattern: '{YYYY}-{MM}-{DD}/{filename}' },
  'date-nested':    { label: 'YYYY / MM / DD',           pattern: '{YYYY}/{MM}/{DD}/{filename}' },
  'year-month':     { label: 'YYYY / MM',                pattern: '{YYYY}/{MM}/{filename}' },
  'year':           { label: 'YYYY',                      pattern: '{YYYY}/{filename}' },
  'star':           { label: '★ Rating (1-star … 5-star)', pattern: '{rating}/{filename}' },
  'date-star':      { label: 'YYYY-MM-DD / ★ Rating',    pattern: '{YYYY}-{MM}-{DD}/{rating}/{filename}' },
  'star-date':      { label: '★ Rating / YYYY-MM-DD',    pattern: '{rating}/{YYYY}-{MM}-{DD}/{filename}' },
  'flat':           { label: 'No folders',                pattern: '{filename}' },
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
  /** Optional FTP/FTPS mirror destination. Uploaded after the primary copy succeeds. */
  ftpDestEnabled?: boolean;
  ftpDestConfig?: FtpConfig;
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
  /**
   * Explicit per-file list of source paths that should have exposure
   * normalization applied, regardless of the global `normalizeExposure` flag.
   * Populated from files the user marked "Normalize to anchor" in the grid.
   * Requires `exposureAnchorEV` and a transcoding `saveFormat` to take effect.
   */
  normalizeAnchorPaths?: string[];
  /** Manual exposure offsets in stops, keyed by source path. */
  exposureAdjustments?: Record<string, number>;
  /** When true and copying originals, compare SHA-256 source/destination bytes after copy. */
  verifyChecksums?: boolean;
}

export interface ImportProgress {
  currentFile: string;
  currentIndex: number;
  totalFiles: number;
  bytesTransferred: number;
  totalBytes: number;
  skipped: number;
  errors: number;
  /** Bytes per second (rolling 3 s window). Undefined until enough data. */
  bytesPerSec?: number;
  /** Estimated seconds remaining. Undefined until bytesPerSec is available. */
  etaSec?: number;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  verified?: number;
  checksumVerified?: number;
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
  ftpDestEnabled: boolean;
  ftpDestConfig: FtpConfig;
  autoEject: boolean;
  playSoundOnComplete: boolean;
  completeSoundPath: string;
  openFolderOnComplete: boolean;
  verifyChecksums: boolean;
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
  // Performance optimizations
  gpuFaceAcceleration?: boolean;  // Enable GPU for face detection (default: true if available)
  rawPreviewCache?: boolean;       // Cache RAW preview extractions (default: true)
  cpuOptimization?: boolean;       // Use lighter models/settings for older CPUs (default: false)
  rawPreviewQuality?: number;      // 0-100 for RAW preview JPEG quality (default: 70)
  /** Device performance tier — 'auto' detects from CPU/RAM, or user override */
  perfTier?: 'auto' | 'low' | 'balanced' | 'high';
  /** Fast Keeper Mode: score using sharpness/exposure/ratings only, skip ONNX */
  fastKeeperMode?: boolean;
  /** Renderer concurrency hint from device-tier (runtime only, not persisted) */
  previewConcurrency?: number;
  faceConcurrency?: number;
  jobPresets: JobPreset[];
  selectionSets: SelectionSet[];
  licenseKey?: string;
  licenseActivationCode?: string;
  licenseStatus?: LicenseValidation;
}

export interface JobPreset {
  name: string;
  destRoot: string;
  backupDestRoot: string;
  saveFormat: SaveFormat;
  jpegQuality: number;
  folderPreset: string;
  customPattern: string;
  skipDuplicates: boolean;
  separateProtected: boolean;
  protectedFolderName: string;
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  releaseName: string;
}

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'
  | 'up-to-date'
  | 'denied';

export interface UpdateReleaseSummary {
  version: string;
  releaseName: string;
  notes?: string;
  publishedAt?: string;
  channel?: string;
}

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  latestVersion?: string;
  releaseName?: string;
  releaseNotes?: string;
  releaseDate?: string;
  releaseUrl?: string;
  downloadUrl?: string;
  feedUrl?: string;
  lastCheckedAt?: string;
  message?: string;
  history?: UpdateReleaseSummary[];
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

export function resolvePattern(pattern: string, date: Date, fileName: string, ext: string, rating?: number): string {
  const y = date.getFullYear().toString();
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const d = date.getDate().toString().padStart(2, '0');
  const baseName = fileName.replace(new RegExp(`\\${ext}$`, 'i'), '');
  // {rating} → "5-stars", "1-star", "unrated" — safe as a folder name on all OSes
  const ratingStr = (rating ?? 0) > 0
    ? `${rating}-star${rating !== 1 ? 's' : ''}`
    : 'unrated';
  return pattern
    .replace(/\{YYYY\}/g, y)
    .replace(/\{MM\}/g, m)
    .replace(/\{DD\}/g, d)
    .replace(/\{filename\}/g, fileName)
    .replace(/\{name\}/g, baseName)
    .replace(/\{ext\}/g, ext.replace('.', ''))
    .replace(/\{rating\}/g, ratingStr);
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
  SCAN_PAUSE: 'scan:pause',
  SCAN_RESUME: 'scan:resume',
  SCAN_PREVIEW: 'scan:preview',

  // Import
  IMPORT_START: 'import:start',
  IMPORT_PROGRESS: 'import:progress',
  IMPORT_COMPLETE: 'import:complete',
  IMPORT_CANCEL: 'import:cancel',

  // Dialogs
  DIALOG_SELECT_FOLDER: 'dialog:select-folder',
  DIALOG_SELECT_FILE: 'dialog:select-file',
  DIALOG_OPEN_PATH: 'dialog:open-path',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  LICENSE_ACTIVATE: 'license:activate',
  LICENSE_CLEAR: 'license:clear',

  // Updates
  UPDATE_AVAILABLE: 'update:available',
  UPDATE_OPEN_RELEASE: 'update:open-release',
  UPDATE_STATUS: 'update:status',
  UPDATE_CHECK_NOW: 'update:check-now',
  UPDATE_DOWNLOAD: 'update:download',
  UPDATE_INSTALL: 'update:install',
  UPDATE_FETCH_HISTORY: 'update:fetch-history',

  // FTP source
  FTP_PROBE: 'ftp:probe',
  FTP_MIRROR_START: 'ftp:mirror-start',
  FTP_MIRROR_PROGRESS: 'ftp:mirror-progress',
  FTP_MIRROR_CANCEL: 'ftp:mirror-cancel',

  // Workflow — manifest export
  EXPORT_MANIFEST: 'export:manifest',
  EXPORT_CONTACT_SHEET: 'export:contact-sheet',

  // Face analysis (onnxruntime-node)
  FACE_ANALYZE: 'face:analyze',
  FACE_MODELS_AVAILABLE: 'face:models-available',
  FACE_GPU_AVAILABLE: 'face:gpu-available',
  FACE_EXECUTION_PROVIDER: 'face:execution-provider',
  FACE_MODEL_DOWNLOAD_PROGRESS: 'face:model-download-progress',

  // Cache management
  CACHE_CLEAR: 'cache:clear',
  FACE_CACHE_CLEAR: 'face-cache:clear',

  // Device performance tier
  DEVICE_TIER_GET: 'device-tier:get',

  // Auto-import + device events
  DEVICE_INSERTED: 'device:inserted',
  AUTO_IMPORT_STARTED: 'auto-import:started',
  AUTO_IMPORT_COMPLETE: 'auto-import:complete',
  EJECT_VOLUME: 'volume:eject',
  DISK_FREE_SPACE: 'disk:free-space',

  // Shell
  OPEN_EXTERNAL: 'shell:open-external',
} as const;
