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
  duplicateMemory?: {
    kind: 'previous-import' | 'previous-reject' | 'same-visual';
    matchedPath: string;
    importedAt?: string;
    rejectedAt?: string;
  };
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
  /** GPS metadata from EXIF, when the camera/phone provided it. */
  gps?: { latitude: number; longitude: number; altitude?: number };
  /** Local, privacy-aware location label derived from GPS. */
  locationName?: string;
  /** Smart review bucket used for scene/event filters and Lightroom keywords. */
  sceneBucket?: string;
  sceneBucketId?: string;
  /**
   * When true, this file's exposure will be normalized to the anchor's EV on
   * import regardless of the global `normalizeExposure` toggle. Set via the
   * "Normalize to anchor" button in the grid toolbar or detail view.
   */
  normalizeToAnchor?: boolean;
  /** Manual exposure offset in stops, applied on import when transcoding. */
  exposureAdjustmentStops?: number;
  /** Manual white-balance correction, applied on import when transcoding. */
  whiteBalanceAdjustment?: WhiteBalanceAdjustment;
  /** Renderer-computed focus metric used to pick burst keepers. Higher = sharper. */
  sharpnessScore?: number;
  /** Face/subject-aware focus metric. Higher = sharper subject area. */
  subjectSharpnessScore?: number;
  /** Number of faces found by local browser face detection, when available. */
  faceCount?: number;
  /** Normalized face boxes from local browser face detection. eyeScore=2 means both eyes detected (open). */
  faceBoxes?: Array<{ x: number; y: number; width: number; height: number; eyeScore?: number; smileScore?: number; expressionScore?: number; score?: number }>;
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
   * (via onnxruntime-node). This is the primary/best face and is kept for
   * backwards compatibility with older sessions.
   */
  faceEmbedding?: string;
  /** All usable face embeddings found in the photo, ordered by matching quality. */
  faceEmbeddings?: string[];
  /** Face boxes that correspond to faceEmbeddings, when returned by the native face engine. */
  faceEmbeddingBoxes?: Array<{ x: number; y: number; width: number; height: number; score?: number }>;
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
  /** True after the operator has explicitly approved this file in second-pass review. */
  reviewApproved?: boolean;
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

export interface FtpSyncSettings {
  enabled: boolean;
  runOnLaunch: boolean;
  intervalMinutes: number;
  localDestRoot: string;
  reuploadToFtpDest: boolean;
}

export interface FtpSyncStatus {
  state: 'idle' | 'running' | 'success' | 'error';
  trigger?: 'manual' | 'launch' | 'interval';
  stage?: 'idle' | 'probing' | 'mirroring' | 'scanning' | 'importing' | 'complete';
  message: string;
  startedAt?: string;
  lastRunAt?: string;
  lastSuccessAt?: string;
  currentFile?: string;
  done?: number;
  total?: number;
  imported?: number;
  skipped?: number;
  errors?: number;
}

export type SaveFormat = 'original' | 'jpeg' | 'tiff' | 'heic';
export type RatingFilter = 'rating-1' | 'rating-2' | 'rating-3' | 'rating-4' | 'rating-5';
export type CullConfidence = 'conservative' | 'balanced' | 'aggressive';
export type KeeperQuota = 'best-1' | 'top-2' | 'all-rated' | 'smile-and-sharp';
export type EventMode =
  | 'general'
  | 'stage'
  | 'candids'
  | 'cosplay'
  | 'cars-itasha'
  | 'vendor-booth'
  | 'crowd'
  | 'panels'
  | 'meetups';

export interface EventModePreset {
  label: string;
  description: string;
  keywords: string[];
  help: string;
}

export const EVENT_MODE_PRESETS: Record<EventMode, EventModePreset> = {
  general: {
    label: 'General event',
    description: 'Balanced event ingest with broad selects and clean metadata.',
    keywords: ['event', 'selects'],
    help: 'Use this when the shoot mixes people, details, and general coverage.',
  },
  stage: {
    label: 'Stage / performance',
    description: 'Performance, spotlight, motion, and peak action coverage.',
    keywords: ['stage', 'performance', 'spotlight', 'action', 'performer'],
    help: 'Keeps performance context in sidecars so Lightroom collections can separate stage work from candids.',
  },
  candids: {
    label: 'Candids',
    description: 'Natural expressions, interactions, laughter, and story moments.',
    keywords: ['candids', 'people', 'story', 'interaction', 'natural expression'],
    help: 'Best for roaming event coverage where expressions and interactions matter more than posed perfection.',
  },
  cosplay: {
    label: 'Cosplay / costumes',
    description: 'Full costume, props, makeup, character details, and group cosplay.',
    keywords: ['cosplay', 'costume', 'full costume', 'prop', 'makeup', 'character', 'detail'],
    help: 'Use for convention shoots; full-body/person boxes and detail shots stay meaningful even when faces are small.',
  },
  'cars-itasha': {
    label: 'Cars / itasha',
    description: 'Full car, livery, artwork, interior, and detail coverage.',
    keywords: ['cars', 'itasha', 'livery', 'vehicle', 'car detail', 'interior', 'artwork'],
    help: 'Treats car coverage as its own story lane instead of duplicate-looking detail frames.',
  },
  'vendor-booth': {
    label: 'Vendor / booth',
    description: 'Booth overview, signage, products, and seller/customer moments.',
    keywords: ['vendor', 'booth', 'signage', 'merch', 'product table'],
    help: 'Good for convention and expo coverage where signs, tables, and products are deliverables.',
  },
  crowd: {
    label: 'Crowd / atmosphere',
    description: 'Venue scale, crowd energy, decorations, queues, and atmosphere.',
    keywords: ['crowd', 'atmosphere', 'venue', 'wide shot', 'ambience'],
    help: 'Use when you need variety and story-setting images, not only tight subject keepers.',
  },
  panels: {
    label: 'Panels / talks',
    description: 'Speakers, audience reaction, slides, and room coverage.',
    keywords: ['panel', 'talk', 'speaker', 'audience', 'presentation'],
    help: 'Useful for talks where both speaker and slide/audience context should survive into Lightroom.',
  },
  meetups: {
    label: 'Meetups / groups',
    description: 'Group coverage with everyone visible and duplicate stacks collapsed.',
    keywords: ['meetup', 'group photo', 'group coverage', 'people'],
    help: 'Pairs well with the group-photo culling logic that prefers more usable faces and people present.',
  },
};

export function eventModeKeywords(mode: EventMode | undefined): string[] {
  return EVENT_MODE_PRESETS[mode ?? 'general']?.keywords ?? EVENT_MODE_PRESETS.general.keywords;
}

export interface SelectionSet {
  name: string;
  paths: string[];
  createdAt: string;
}

export type WatermarkPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | 'center';
export type WatermarkMode = 'text' | 'image';

export interface BatchMetadata {
  keywords?: string[];
  title?: string;
  caption?: string;
  creator?: string;
  copyright?: string;
}

export interface WatermarkConfig {
  enabled: boolean;
  mode: WatermarkMode;
  text?: string;
  imagePath?: string;
  opacity: number;
  positionLandscape: WatermarkPosition;
  positionPortrait: WatermarkPosition;
  scale: number;
}

export interface WhiteBalanceAdjustment {
  /** Warm/cool correction, -100 = cooler, +100 = warmer. */
  temperature: number;
  /** Green/magenta correction, -100 = greener, +100 = more magenta. */
  tint: number;
}

export interface LicenseEntitlement {
  product: string;
  name: string;
  email?: string;
  issuedAt: string;
  activatedAt?: string;
  activationExpiresAt?: string;
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
  activatedAt?: string;
  expiresAt?: string;
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
  /**
   * How to handle a destination path that already exists but is not a duplicate.
   * Defaults to 'skip' for backwards-compatible COPYFILE_EXCL behavior.
   */
  conflictPolicy?: ImportConflictPolicy;
  /** Subfolder name used when conflictPolicy is 'conflicts-folder'. Default: "_Conflicts". */
  conflictFolderName?: string;
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
  /** Batch white-balance correction for converted outputs only. */
  whiteBalance?: WhiteBalanceAdjustment;
  /** Per-file white-balance corrections, keyed by source path. */
  whiteBalanceAdjustments?: Record<string, WhiteBalanceAdjustment>;
  /** Optional batch metadata written as XMP sidecars next to imported files. */
  metadata?: BatchMetadata;
  /**
   * Controls which metadata fields are written into the XMP sidecar on import.
   * When omitted, defaults apply (all enabled except stripGps).
   */
  metadataExportFlags?: Partial<MetadataExportFlags>;
  /** Optional text watermark overlay for transcoded outputs. */
  watermark?: WatermarkConfig;
  /**
   * When true, converted outputs are auto-oriented upright from EXIF
   * orientation metadata. Originals are copied untouched.
   */
  autoStraighten?: boolean;
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
  ledgerId?: string;
  recoveryCount?: number;
  ledgerItems?: ImportLedgerItem[];
  lightroomHandoff?: LightroomHandoffResult;
}

export interface ImportError {
  file: string;
  error: string;
}

export type UpdateInstallMode = 'native' | 'installer' | 'manual-dmg';

export type ImportConflictPolicy = 'skip' | 'rename' | 'overwrite' | 'conflicts-folder';
export type SourceProfile = 'auto' | 'ssd' | 'usb' | 'nas';

export type ImportPlanStatus = 'will-import' | 'duplicate' | 'conflict' | 'invalid';

export interface ImportPlanItem {
  sourcePath: string;
  name: string;
  size: number;
  destRelPath?: string;
  destFullPath?: string;
  backupFullPath?: string;
  status: ImportPlanStatus;
  reason?: string;
  warnings?: string[];
}

export interface ImportPreflight {
  totalFiles: number;
  totalBytes: number;
  willImport: number;
  duplicates: number;
  conflicts: number;
  invalid: number;
  lowConfidence: number;
  conflictPolicy: ImportConflictPolicy;
  conflictFolderName?: string;
  sessionWarnings: string[];
  recoveryAvailable: boolean;
  backupEnabled: boolean;
  ftpEnabled: boolean;
  checksumEnabled: boolean;
  metadataEnabled: boolean;
  watermarkEnabled: boolean;
  dryRun: boolean;
  items: ImportPlanItem[];
}

export type ImportLedgerStatus = 'planned' | 'imported' | 'skipped' | 'failed' | 'verified' | 'pending';

export interface ImportLedgerItem {
  sourcePath: string;
  name: string;
  size: number;
  destRelPath?: string;
  destFullPath?: string;
  backupFullPath?: string;
  status: ImportLedgerStatus;
  error?: string;
}

export interface ImportLedger {
  id: string;
  createdAt: string;
  sourcePath: string;
  destRoot: string;
  saveFormat: SaveFormat;
  totalFiles: number;
  imported: number;
  skipped: number;
  failed: number;
  pending: number;
  verified?: number;
  checksumVerified?: number;
  totalBytes: number;
  durationMs: number;
  items: ImportLedgerItem[];
}

export type LightroomCollectionKey =
  | 'selected'
  | 'rejected'
  | 'protected'
  | 'second-pass-approved'
  | 'catalog-duplicate';

export interface LightroomCollectionArtifact {
  key: LightroomCollectionKey;
  label: string;
  count: number;
  pathListPath: string;
  csvPath: string;
  xmpSidecarDir: string;
}

export interface LightroomHandoffResult {
  createdAt: string;
  source: 'post-import' | 'current-session';
  outputDir: string;
  manifestPath: string;
  csvPath: string;
  readmePath: string;
  totalFiles: number;
  totalMemberships: number;
  collections: LightroomCollectionArtifact[];
}

export interface AppSession {
  id: string;
  updatedAt: string;
  sourcePath: string | null;
  destRoot: string | null;
  files: MediaFile[];
  selectedPaths: string[];
  queuedPaths: string[];
  filter: string;
  focusedPath?: string;
  importLedgerId?: string;
  stats: {
    totalFiles: number;
    picked: number;
    rejected: number;
    queued: number;
    reviewed: number;
  };
}

export interface WatchFolder {
  id: string;
  label?: string;
  path: string;
  enabled: boolean;
  destination?: string;
  destRoot?: string;
  sourceProfile?: SourceProfile;
  autoScan: boolean;
  autoImport: boolean;
  createdAt?: string;
  updatedAt?: string;
  lastTriggeredAt?: string;
  lastImportedAt?: string;
}

export type CatalogImportedFilter = 'any' | 'imported' | 'not-imported';

export interface CatalogBrowserQuery {
  search?: string;
  sourcePath?: string;
  destinationPath?: string;
  camera?: string;
  lens?: string;
  visualHash?: string;
  imported?: CatalogImportedFilter;
  limit?: number;
  offset?: number;
  sortBy?: 'lastSeenAt' | 'lastImportedAt' | 'name' | 'size';
  sortDirection?: 'asc' | 'desc';
}

export interface CatalogBrowserRecord {
  id: string;
  sourcePath: string;
  name: string;
  size: number;
  type?: MediaFile['type'];
  extension?: string;
  dateTaken?: string;
  cameraMake?: string;
  cameraModel?: string;
  lensModel?: string;
  visualHash?: string;
  sessionId?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  imported: boolean;
  importStatus?: ImportLedgerStatus;
  destRelPath?: string;
  destFullPath?: string;
  backupFullPath?: string;
  lastImportedAt?: string;
  error?: string;
}

export interface CatalogBrowserResult {
  records: CatalogBrowserRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface CatalogMissingPath {
  kind: 'source' | 'destination' | 'backup';
  sourcePath: string;
  path: string;
  name: string;
  imported: boolean;
  lastSeenAt?: string;
  lastImportedAt?: string;
}

export interface CatalogMaintenanceResult {
  checked: number;
  missingSources: number;
  missingDestinations: number;
  missingBackups: number;
  missingPaths: CatalogMissingPath[];
}

export interface CatalogPruneResult extends CatalogMaintenanceResult {
  removedMediaFiles: number;
  removedImportOutcomes: number;
}

export interface CatalogBackupResult {
  path: string;
  bytes: number;
  mediaFiles: number;
  importOutcomes: number;
}

export interface CatalogStats {
  storageKind: 'sqlite' | 'json';
  catalogPath: string;
  totalFiles: number;
  totalBytes: number;
  importedFiles: number;
  duplicateIdentities: number;
  importOutcomes: number;
  lastSeenAt?: string;
  lastImportedAt?: string;
}

export interface ImportHealthSummary {
  generatedAt: string;
  latestLedger: ImportLedger | null;
  lastImport: {
    state: 'none' | 'healthy' | 'attention' | 'failed';
    createdAt?: string;
    sourcePath?: string;
    destRoot?: string;
    totalFiles: number;
    imported: number;
    skipped: number;
    failed: number;
    pending: number;
    totalBytes: number;
    durationMs: number;
  };
  retryableItems: ImportLedgerItem[];
  checksum: {
    enabled: boolean;
    status: 'unavailable' | 'disabled' | 'verified' | 'partial' | 'missing';
    verified: number;
    expected: number;
  };
  backup: {
    enabled: boolean;
    status: 'unavailable' | 'disabled' | 'ok' | 'partial' | 'attention';
    targetRoot?: string;
    copied: number;
    failed: number;
    totalTargets: number;
  };
  ftp: {
    enabled: boolean;
    status: FtpSyncStatus['state'] | 'disabled';
    stage?: FtpSyncStatus['stage'];
    message: string;
    lastRunAt?: string;
    lastSuccessAt?: string;
    imported?: number;
    skipped?: number;
    errors?: number;
  };
  catalog: CatalogStats | null;
  watchFolders: {
    total: number;
    enabled: number;
    active: number;
    autoScan: number;
    autoImport: number;
    missing: number;
    needsDestination: number;
    lastTriggeredAt?: string;
    folders: Array<{
      id: string;
      label?: string;
      path: string;
      enabled: boolean;
      autoScan: boolean;
      autoImport: boolean;
      exists: boolean;
      status: 'ready' | 'disabled' | 'missing' | 'needs-destination';
      lastTriggeredAt?: string;
      lastImportedAt?: string;
    }>;
  };
}

export interface MacFirstRunDoctor {
  platform: NodeJS.Platform;
  arch: string;
  supported: boolean;
  appVersion: string;
  updateMode: UpdateInstallMode;
  resources: {
    resourcesPath: string;
    onnxRuntimeNode: boolean;
    models: Array<{ name: string; exists: boolean; bytes?: number }>;
  };
  checks: Array<{
    id: string;
    label: string;
    ok: boolean;
    detail: string;
  }>;
}

/**
 * Which culling actions the user can remap. Each value is a KeyboardEvent.key string.
 * Defaults are the original hardcoded keys.
 */
export interface KeybindMap {
  pick: string;           // default: 'p'
  reject: string;         // default: 'x'
  unflag: string;         // default: 'u'
  nextPhoto: string;      // default: 'ArrowRight'
  prevPhoto: string;      // default: 'ArrowLeft'
  rateOne: string;        // default: '1'
  rateTwo: string;        // default: '2'
  rateThree: string;      // default: '3'
  rateFour: string;       // default: '4'
  rateFive: string;       // default: '5'
  clearRating: string;    // default: '0'
  compareMode: string;    // default: 'c'
  burstSelect: string;    // default: 'b'
  burstCollapse: string;  // default: 'g'
  queuePhoto: string;     // default: 'q'
  jumpUnreviewed: string; // default: 'Tab'
  batchRejectBurst: string; // default: 'r' (when in single/split view)
}

export const DEFAULT_KEYBINDS: KeybindMap = {
  pick: 'p',
  reject: 'x',
  unflag: 'u',
  nextPhoto: 'ArrowRight',
  prevPhoto: 'ArrowLeft',
  rateOne: '1',
  rateTwo: '2',
  rateThree: '3',
  rateFour: '4',
  rateFive: '5',
  clearRating: '0',
  compareMode: 'c',
  burstSelect: 'b',
  burstCollapse: 'g',
  queuePhoto: 'q',
  jumpUnreviewed: 'Tab',
  batchRejectBurst: 'r',
};

/**
 * Controls which metadata fields get written into files on import.
 */
export interface MetadataExportFlags {
  keywords: boolean;
  title: boolean;
  caption: boolean;
  creator: boolean;
  copyright: boolean;
  rating: boolean;       // embed star rating as XMP Rating
  pickLabel: boolean;    // embed pick/reject as XMP Label / ColorClass
  stripGps: boolean;     // remove GPS data on export
}

export const DEFAULT_METADATA_EXPORT: MetadataExportFlags = {
  keywords: true,
  title: true,
  caption: true,
  creator: true,
  copyright: true,
  rating: true,
  pickLabel: true,
  stripGps: false,
};

export interface ViewOverlayPreferences {
  photoStats: boolean;
  histogram: boolean;
  faceBoxes: boolean;
  peopleBoxes: boolean;
  aiReasons: boolean;
}

export const DEFAULT_VIEW_OVERLAY_PREFERENCES: ViewOverlayPreferences = {
  photoStats: true,
  histogram: true,
  faceBoxes: false,
  peopleBoxes: false,
  aiReasons: false,
};

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
  ftpConfig: FtpConfig;
  ftpDestEnabled: boolean;
  ftpDestConfig: FtpConfig;
  ftpSync: FtpSyncSettings;
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
  exposureAdjustmentStep?: number;
  whiteBalanceTemperature?: number;
  whiteBalanceTint?: number;
  eventMode?: EventMode;
  /** How strongly auto-cull rejects weaker burst/group alternates. */
  cullConfidence?: CullConfidence;
  /** Group-photo mode prefers frames where every detected face/person is usable. */
  groupPhotoEveryoneGood?: boolean;
  /** How many alternates to keep in burst and near-duplicate stacks. */
  keeperQuota?: KeeperQuota;
  // Batch metadata + output transforms
  metadataKeywords?: string;
  metadataTitle?: string;
  metadataCaption?: string;
  metadataCreator?: string;
  metadataCopyright?: string;
  watermarkEnabled?: boolean;
  watermarkMode?: WatermarkMode;
  watermarkText?: string;
  watermarkImagePath?: string;
  watermarkOpacity?: number;
  watermarkPositionLandscape?: WatermarkPosition;
  watermarkPositionPortrait?: WatermarkPosition;
  watermarkScale?: number;
  autoStraighten?: boolean;
  // Performance optimizations
  gpuFaceAcceleration?: boolean;  // Enable GPU for face detection (default: true if available)
  rawPreviewCache?: boolean;       // Cache RAW preview extractions (default: true)
  cpuOptimization?: boolean;       // Use lighter models/settings for older CPUs (default: false)
  rawPreviewQuality?: number;      // 0-100 for RAW preview JPEG quality (default: 70)
  /** DirectML adapter index. Undefined/-1 = system default GPU. */
  gpuDeviceId?: number;
  /** Number of parallel detector/embedder streams used by the diagnostic GPU load test. */
  gpuStressStreams?: number;
  /** Device performance tier — 'auto' detects from CPU/RAM, or user override */
  perfTier?: 'auto' | 'low' | 'balanced' | 'high';
  /** Source/storage profile used to tune UI-side preview and AI concurrency. */
  sourceProfile?: SourceProfile;
  /** Last review/import session snapshot id. */
  lastSessionId?: string;
  /** Default destination conflict behavior for imports. */
  defaultConflictPolicy?: ImportConflictPolicy;
  /** Subfolder used when conflicts are routed aside. */
  conflictFolderName?: string;
  /** Saved folders that can be monitored for staged scans/imports. */
  watchFolders?: WatchFolder[];
  /** Last app version where the performance/setup prompt was shown or dismissed. */
  performancePromptSeenVersion?: string;
  /** Fast Keeper Mode: score using sharpness/exposure/ratings only, skip ONNX */
  fastKeeperMode?: boolean;
  /** Renderer concurrency hint from device-tier (runtime only, not persisted) */
  previewConcurrency?: number;
  faceConcurrency?: number;
  jobPresets: JobPreset[];
  selectionSets: SelectionSet[];
  // Keybind customization
  keybinds?: Partial<KeybindMap>;
  // Metadata export control
  metadataExport?: Partial<MetadataExportFlags>;
  // Single-photo review overlay visibility
  viewOverlayPreferences?: Partial<ViewOverlayPreferences>;
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
  eventMode?: EventMode;
  cullConfidence?: CullConfidence;
  groupPhotoEveryoneGood?: boolean;
  keeperQuota?: KeeperQuota;
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
  installMode?: UpdateInstallMode;
  lastCheckedAt?: string;
  message?: string;
  history?: UpdateReleaseSummary[];
}

export interface AppDiagnosticsSnapshot {
  appVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  packaged: boolean;
  userDataPath: string;
  settingsPath: string;
  legacySettingsPath: string;
  updateMetadataPath: string;
  updatesCachePath: string;
  license: {
    valid: boolean;
    status?: string;
    message?: string;
    hasStoredKey: boolean;
    hasActivationCode: boolean;
    activationCode?: string;
  };
  update: {
    status: UpdateStatus | 'unknown';
    currentVersion: string;
    latestVersion?: string;
    lastCheckedAt?: string;
    message?: string;
    releaseUrl?: string;
    downloadUrl?: string;
    feedUrl?: string;
    cachedLatestVersion?: string;
    cachedAt?: string;
  };
  endpoints: Array<{ url: string; role: 'primary' | 'fallback' | 'legacy' }>;
}

export interface UpdateRepairResult {
  ok: boolean;
  cleared: string[];
  updateState: UpdateState;
  diagnostics: AppDiagnosticsSnapshot;
  message: string;
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
  IMPORT_PREFLIGHT: 'import:preflight',
  IMPORT_RETRY_FAILED: 'import:retry-failed',
  IMPORT_LEDGER_LATEST: 'import:ledger-latest',
  IMPORT_HEALTH_SUMMARY: 'import:health-summary',
  SESSION_SAVE: 'session:save',
  SESSION_LATEST: 'session:latest',
  CATALOG_STATS: 'catalog:stats',
  CATALOG_BROWSE: 'catalog:browse',
  CATALOG_VERIFY_MISSING: 'catalog:verify-missing',
  CATALOG_PRUNE_MISSING: 'catalog:prune-missing',
  CATALOG_EXPORT_BACKUP: 'catalog:export-backup',
  IMPORT_PROGRESS: 'import:progress',
  IMPORT_COMPLETE: 'import:complete',
  IMPORT_CANCEL: 'import:cancel',

  // Dialogs
  DIALOG_SELECT_FOLDER: 'dialog:select-folder',
  DIALOG_SELECT_FILE: 'dialog:select-file',
  DIALOG_OPEN_PATH: 'dialog:open-path',
  DIAGNOSTICS_EXPORT: 'diagnostics:export',
  BENCHMARK_SMOKE_RUN: 'benchmark:smoke-run',
  BENCHMARK_OPEN_OUTPUT: 'benchmark:open-output',
  MAC_FIRST_RUN_DOCTOR: 'diagnostics:mac-first-run-doctor',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  WATCH_FOLDERS_GET: 'watch-folders:get',
  WATCH_FOLDERS_SET: 'watch-folders:set',
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
  UPDATE_REPAIR: 'update:repair',
  DIAGNOSTICS_SNAPSHOT: 'diagnostics:snapshot',

  // FTP source
  FTP_PROBE: 'ftp:probe',
  FTP_MIRROR_START: 'ftp:mirror-start',
  FTP_MIRROR_PROGRESS: 'ftp:mirror-progress',
  FTP_MIRROR_CANCEL: 'ftp:mirror-cancel',
  FTP_SYNC_RUN: 'ftp:sync-run',
  FTP_SYNC_STATUS: 'ftp:sync-status',

  // Workflow — manifest export
  EXPORT_MANIFEST: 'export:manifest',
  EXPORT_LIGHTROOM_HANDOFF: 'export:lightroom-handoff',
  EXPORT_CONTACT_SHEET: 'export:contact-sheet',

  // Face analysis (onnxruntime-node)
  FACE_ANALYZE: 'face:analyze',
  FACE_MODELS_AVAILABLE: 'face:models-available',
  FACE_GPU_AVAILABLE: 'face:gpu-available',
  FACE_EXECUTION_PROVIDER: 'face:execution-provider',
  FACE_CANCEL_QUEUE: 'face:cancel-queue',
  FACE_GPU_STRESS_TEST: 'face:gpu-stress-test',
  GPU_LIST: 'gpu:list',
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
  WATCH_FOLDER_TRIGGERED: 'watch-folder:triggered',

  // Shell
  OPEN_EXTERNAL: 'shell:open-external',
} as const;
