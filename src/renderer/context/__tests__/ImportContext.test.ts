import { describe, it, expect } from 'vitest';
import { reducer, type Action, type AppPhase } from '../ImportContext';
import type { MediaFile, ImportProgress, ImportResult, SaveFormat } from '../../../shared/types';
import { DEFAULT_VIEW_OVERLAY_PREFERENCES, FOLDER_PRESETS } from '../../../shared/types';

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    volumes: [],
    selectedSource: null,
    activeScanId: null,
    scanDiagnostics: null,
    files: [] as MediaFile[],
    phase: 'idle' as AppPhase,
    scanError: null as string | null,
    destination: null,
    skipDuplicates: true,
    saveFormat: 'original' as SaveFormat,
    jpegQuality: 90,
    folderPreset: 'date-flat',
    customPattern: FOLDER_PRESETS['date-flat'].pattern,
    importProgress: null as ImportProgress | null,
    importResult: null as ImportResult | null,
    focusedIndex: -1,
    focusedPath: null as string | null,
    viewMode: 'grid' as const,
    previousViewMode: null,
    thumbnailSize: 160,
    theme: 'dark' as const,
    experienceMode: 'simple' as const,
    showLeftPanel: true,
    showRightPanel: true,
    // FTP source defaults
    sourceKind: 'volume' as const,
    ftpConfig: {
      host: '',
      port: 21,
      user: '',
      password: '',
      secure: false,
      remotePath: '/DCIM',
    },
    ftpStatus: 'idle' as const,
    ftpMessage: null as string | null,
    ftpProgress: null as { done: number; total: number; name: string } | null,
    ftpSyncSettings: {
      enabled: false,
      runOnLaunch: true,
      intervalMinutes: 15,
      localDestRoot: '',
      reuploadToFtpDest: false,
    },
    ftpSyncStatus: {
      state: 'idle' as const,
      stage: 'idle' as const,
      message: 'FTP sync is idle.',
    },
    // Workflow filters + selection
    filter: 'all' as const,
    gridSortOrder: 'capture-asc' as const,
    importFailedPaths: [] as string[],
    cullMode: false,
    selectedPaths: [] as string[],
    queuedPaths: [] as string[],
    selectionSets: [],
    scanPaused: false,
    fileHistory: [] as MediaFile[][],
    // Workflow options
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
    sourceProfile: 'auto' as const,
    conflictPolicy: 'rename' as const,
    conflictFolderName: '_Conflicts',
    lastSessionId: '',
    autoImport: false,
    autoImportDestRoot: '',
    volumeImportQueue: [] as string[],
    // Burst grouping
    burstGrouping: true,
    burstWindowSec: 2,
    collapsedBursts: [] as string[],
    // Exposure normalization
    normalizeExposure: false,
    exposureAnchorPath: null as string | null,
    exposureMaxStops: 2,
    exposureAdjustmentStep: 0.33,
    eventMode: 'general' as const,
    scheduleCsvPath: '',
    scheduleSheetUrl: '',
    cullConfidence: 'balanced' as const,
    groupPhotoEveryoneGood: false,
    keeperQuota: 'best-1' as const,
    metadataKeywords: '',
    metadataTitle: '',
    metadataCaption: '',
    metadataCreator: '',
    metadataCopyright: '',
    watermarkEnabled: false,
    watermarkMode: 'text' as const,
    watermarkText: '',
    watermarkImagePath: '',
    watermarkOpacity: 0.3,
    watermarkPositionLandscape: 'bottom-right' as const,
    watermarkPositionPortrait: 'bottom-right' as const,
    watermarkScale: 0.045,
    autoStraighten: true,
    licenseStatus: null,
    licenseHydrated: false,
    licensePromptOpen: false,
    licenseBannerDismissed: false,
    // Performance
    gpuFaceAcceleration: true,
    rawPreviewCache: true,
    cpuOptimization: true,
    rawPreviewQuality: 70,
    reviewFaceAnalysis: true,
    reviewFaceMatching: true,
    reviewPersonDetection: true,
    reviewVisualDuplicates: true,
    autoSpeedMode: false,
    perfTier: 'auto' as const,
    fastKeeperMode: false,
    aiReviewEnabled: true,
    previewConcurrency: 2,
    faceConcurrency: 1,
    keybinds: { pick: 'p', reject: 'x', unflag: 'u', nextPhoto: 'ArrowRight', prevPhoto: 'ArrowLeft', rateOne: '1', rateTwo: '2', rateThree: '3', rateFour: '4', rateFive: '5', clearRating: '0', compareMode: 'c', burstSelect: 'b', burstCollapse: 'g', queuePhoto: 'q', jumpUnreviewed: 'Tab', batchRejectBurst: 'r' },
    metadataExport: { keywords: true, title: true, caption: true, creator: true, copyright: true, rating: true, pickLabel: true, stripGps: false },
    viewOverlayPreferences: { ...DEFAULT_VIEW_OVERLAY_PREFERENCES },
    ...overrides,
  };
}

function makeFile(overrides: Partial<MediaFile> = {}): MediaFile {
  return {
    path: '/photos/IMG_001.jpg',
    name: 'IMG_001.jpg',
    size: 5000,
    type: 'photo',
    extension: '.jpg',
    ...overrides,
  };
}

function embeddingHex(values: number[]): string {
  const array = new Float32Array(values);
  return Buffer.from(array.buffer).toString('hex');
}

describe('ImportContext reducer', () => {
  describe('CULL_TO_TARGET', () => {
    it('culls photos down to the target budget, leaving videos untouched', () => {
      const photos = Array.from({ length: 20 }, (_, i) =>
        makeFile({ path: `/p${i}.jpg`, name: `p${i}.jpg`, sharpnessScore: 50 + i, blurRisk: 'low' }));
      const video = makeFile({ path: '/clip.mov', name: 'clip.mov', type: 'video' });
      const state = makeState({ files: [...photos, video] });
      const next = reducer(state, { type: 'CULL_TO_TARGET', target: 5 });
      const kept = next.files.filter((f) => f.pick === 'selected');
      const rejected = next.files.filter((f) => f.pick === 'rejected');
      expect(kept).toHaveLength(5);
      expect(rejected).toHaveLength(15);
      // Video is never auto-rejected by the cull.
      expect(next.files.find((f) => f.path === '/clip.mov')?.pick).toBeUndefined();
    });

    it('always keeps protected files even below target', () => {
      const state = makeState({
        files: [
          makeFile({ path: '/keep.jpg', isProtected: true, sharpnessScore: 1, blurRisk: 'high' }),
          ...Array.from({ length: 10 }, (_, i) => makeFile({ path: `/x${i}.jpg`, name: `x${i}.jpg`, sharpnessScore: 100, blurRisk: 'low' })),
        ],
      });
      const next = reducer(state, { type: 'CULL_TO_TARGET', target: 1 });
      expect(next.files.find((f) => f.path === '/keep.jpg')?.pick).toBe('selected');
    });
  });

  // --- Phase transitions ---

  describe('phase transitions', () => {
    it('idle → scanning on SCAN_START', () => {
      const state = makeState({
        phase: 'idle',
        files: [makeFile({ path: '/old.jpg' })],
        queuedPaths: ['/old.jpg'],
        selectedPaths: ['/old.jpg'],
        focusedIndex: 0,
        focusedPath: '/old.jpg',
        filter: 'queue',
        collapsedBursts: ['burst-1'],
      });
      const next = reducer(state, { type: 'SCAN_START' });
      expect(next.phase).toBe('scanning');
      expect(next.files).toEqual([]);
      expect(next.focusedIndex).toBe(-1);
      expect(next.focusedPath).toBeNull();
      expect(next.queuedPaths).toEqual([]);
      expect(next.selectedPaths).toEqual([]);
      expect(next.filter).toBe('all');
      expect(next.collapsedBursts).toEqual([]);
    });

    it('scanning → ready on SCAN_COMPLETE when files present', () => {
      const state = makeState({ phase: 'scanning', files: [makeFile()] });
      const next = reducer(state, { type: 'SCAN_COMPLETE' });
      expect(next.phase).toBe('ready');
    });

    it('scanning → idle on SCAN_COMPLETE with 0 files', () => {
      const state = makeState({ phase: 'scanning', files: [] });
      const next = reducer(state, { type: 'SCAN_COMPLETE' });
      expect(next.phase).toBe('idle');
    });

    it('ready → importing on IMPORT_START', () => {
      const state = makeState({ phase: 'ready' });
      const next = reducer(state, { type: 'IMPORT_START' });
      expect(next.phase).toBe('importing');
      expect(next.importProgress).toBeNull();
      expect(next.importResult).toBeNull();
    });

    it('returns to grid view when import starts from detail view', () => {
      const state = makeState({ phase: 'ready', viewMode: 'single', previousViewMode: 'split' });
      const next = reducer(state, { type: 'IMPORT_START' });
      expect(next.phase).toBe('importing');
      expect(next.viewMode).toBe('grid');
      expect(next.previousViewMode).toBeNull();
    });

    it('leaves expensive face filters when import starts', () => {
      const state = makeState({ phase: 'ready', filter: 'face-gallery' });
      const next = reducer(state, { type: 'IMPORT_START' });
      expect(next.phase).toBe('importing');
      expect(next.filter).toBe('all');
    });

    it('importing → complete on IMPORT_COMPLETE', () => {
      const result: ImportResult = { imported: 5, skipped: 0, errors: [], totalBytes: 1000, durationMs: 500 };
      const state = makeState({ phase: 'importing' });
      const next = reducer(state, { type: 'IMPORT_COMPLETE', result });
      expect(next.phase).toBe('complete');
      expect(next.importResult).toBe(result);
    });

    it('complete → ready on DISMISS_SUMMARY when files exist', () => {
      const state = makeState({ phase: 'complete', importResult: {} as ImportResult, files: [makeFile({ path: '/a.jpg' })] });
      const next = reducer(state, { type: 'DISMISS_SUMMARY' });
      expect(next.phase).toBe('ready');
      expect(next.importResult).toBeNull();
      expect(next.importProgress).toBeNull();
    });

    it('complete → idle on DISMISS_SUMMARY when no files (e.g. after auto-import)', () => {
      const state = makeState({ phase: 'complete', importResult: {} as ImportResult, files: [] });
      const next = reducer(state, { type: 'DISMISS_SUMMARY' });
      expect(next.phase).toBe('idle');
      expect(next.importResult).toBeNull();
      expect(next.importProgress).toBeNull();
    });
  });

  describe('session and source profile', () => {
    it('restores a persisted review session', () => {
      const file = makeFile({ path: '/photos/IMG_002.jpg', pick: 'selected' });
      const next = reducer(makeState(), {
        type: 'RESTORE_SESSION',
        session: {
          id: 'session-1',
          updatedAt: '2026-05-02T00:00:00.000Z',
          sourcePath: '/photos',
          destRoot: '/dest',
          files: [file],
          selectedPaths: [file.path],
          queuedPaths: [file.path],
          filter: 'queue',
          focusedPath: file.path,
          importLedgerId: 'ledger-1',
          stats: { totalFiles: 1, picked: 1, rejected: 0, queued: 1, reviewed: 1 },
        },
      });

      expect(next.selectedSource).toBe('/photos');
      expect(next.destination).toBe('/dest');
      expect(next.phase).toBe('ready');
      expect(next.filter).toBe('queue');
      expect(next.focusedIndex).toBe(0);
      expect(next.lastSessionId).toBe('session-1');
    });

    it('drops stale selection, queue, and focus paths when restoring a session', () => {
      const file = makeFile({ path: '/photos/IMG_002.jpg', pick: 'selected' });
      const next = reducer(makeState(), {
        type: 'RESTORE_SESSION',
        session: {
          id: 'session-1',
          updatedAt: '2026-05-02T00:00:00.000Z',
          sourcePath: '/photos',
          destRoot: '/dest',
          files: [file],
          selectedPaths: [file.path, '/missing.jpg', file.path],
          queuedPaths: ['/missing.jpg'],
          filter: 'queue',
          focusedPath: '/missing.jpg',
          importLedgerId: 'ledger-1',
          stats: { totalFiles: 1, picked: 1, rejected: 0, queued: 1, reviewed: 1 },
        },
      });

      expect(next.selectedPaths).toEqual([file.path]);
      expect(next.queuedPaths).toEqual([]);
      expect(next.filter).toBe('all');
      expect(next.focusedIndex).toBe(-1);
      expect(next.focusedPath).toBeNull();
    });

    it('applies conservative concurrency for NAS sources', () => {
      const next = reducer(makeState({ previewConcurrency: 4, faceConcurrency: 3, rawPreviewQuality: 80 }), {
        type: 'SET_SOURCE_PROFILE',
        profile: 'nas',
      });

      expect(next.sourceProfile).toBe('nas');
      expect(next.previewConcurrency).toBe(1);
      expect(next.faceConcurrency).toBe(1);
      expect(next.rawPreviewCache).toBe(true);
      expect(next.rawPreviewQuality).toBeLessThanOrEqual(68);
    });

    it('turns off expensive review stages in low performance tier', () => {
      const next = reducer(makeState({ reviewFaceAnalysis: true, reviewFaceMatching: true, reviewPersonDetection: true, reviewVisualDuplicates: true }), {
        type: 'SET_PERF_TIER',
        tier: 'low',
      });

      expect(next.fastKeeperMode).toBe(true);
      expect(next.previewConcurrency).toBe(1);
      expect(next.faceConcurrency).toBe(1);
      expect(next.reviewFaceAnalysis).toBe(false);
      expect(next.reviewFaceMatching).toBe(false);
      expect(next.reviewPersonDetection).toBe(false);
      expect(next.reviewVisualDuplicates).toBe(false);
    });

    it('restores full review stages and higher concurrency in high performance tier', () => {
      const next = reducer(makeState({
        fastKeeperMode: true,
        previewConcurrency: 1,
        faceConcurrency: 1,
        rawPreviewQuality: 55,
        reviewFaceAnalysis: false,
        reviewFaceMatching: false,
        reviewPersonDetection: false,
        reviewVisualDuplicates: false,
      }), {
        type: 'SET_PERF_TIER',
        tier: 'high',
      });

      expect(next.fastKeeperMode).toBe(false);
      expect(next.previewConcurrency).toBeGreaterThanOrEqual(3);
      expect(next.faceConcurrency).toBeGreaterThanOrEqual(4);
      expect(next.rawPreviewQuality).toBeGreaterThanOrEqual(82);
      expect(next.reviewFaceAnalysis).toBe(true);
      expect(next.reviewFaceMatching).toBe(true);
      expect(next.reviewPersonDetection).toBe(true);
      expect(next.reviewVisualDuplicates).toBe(true);
    });

    it('stores auto speed fallback mode and clears it when low tier is applied', () => {
      const enabled = reducer(makeState({ autoSpeedMode: false }), { type: 'SET_AUTO_SPEED_MODE', enabled: true });
      expect(enabled.autoSpeedMode).toBe(true);

      const low = reducer(enabled, { type: 'SET_PERF_TIER', tier: 'low' });
      expect(low.autoSpeedMode).toBe(false);
    });
  });

  // --- SCAN_BATCH ---

  describe('SCAN_BATCH', () => {
    it('appends files to existing array', () => {
      const file1 = makeFile({ path: '/a.jpg' });
      const file2 = makeFile({ path: '/b.jpg' });
      const state = makeState({ files: [file1], phase: 'scanning' });
      const next = reducer(state, { type: 'SCAN_BATCH', files: [file2] });
      expect(next.files).toHaveLength(2);
      expect(next.files[1].path).toBe('/b.jpg');
    });

    it('ignores stale scan batches from a previous source', () => {
      const file1 = makeFile({ path: '/current.jpg' });
      const file2 = makeFile({ path: '/old.jpg' });
      const state = makeState({ files: [file1], phase: 'scanning', activeScanId: 'current-scan' });
      const next = reducer(state, { type: 'SCAN_BATCH', files: [file2], scanId: 'old-scan' });
      expect(next.files).toEqual([file1]);
      expect(next.scanDiagnostics?.staleEventsIgnored).toBe(1);
    });
  });

  // --- SET_THUMBNAIL ---

  describe('SET_THUMBNAIL', () => {
    it('sets thumbnail for matching file', () => {
      const file = makeFile({ path: '/photo.jpg' });
      const state = makeState({ files: [file] });
      const next = reducer(state, { type: 'SET_THUMBNAIL', filePath: '/photo.jpg', thumbnail: 'data:image/jpeg;base64,abc' });
      expect(next.files[0].thumbnail).toBe('data:image/jpeg;base64,abc');
    });

    it('does not modify files with non-matching path', () => {
      const file = makeFile({ path: '/photo.jpg' });
      const state = makeState({ files: [file] });
      const next = reducer(state, { type: 'SET_THUMBNAIL', filePath: '/other.jpg', thumbnail: 'data:xxx' });
      expect(next.files[0].thumbnail).toBeUndefined();
    });
  });

  // --- SET_DUPLICATE ---

  describe('SET_DUPLICATE', () => {
    it('marks file as duplicate', () => {
      const file = makeFile({ path: '/photo.jpg' });
      const state = makeState({ files: [file] });
      const next = reducer(state, { type: 'SET_DUPLICATE', filePath: '/photo.jpg' });
      expect(next.files[0].duplicate).toBe(true);
    });

    it('clears destination duplicate flags while keeping catalog duplicate memory', () => {
      const file = makeFile({
        path: '/photo.jpg',
        duplicate: true,
        duplicateMemory: {
          kind: 'previous-import',
          matchedPath: '/archive/photo.jpg',
          importedAt: '2026-05-01T00:00:00.000Z',
        },
      });
      const state = makeState({ files: [file] });

      const next = reducer(state, { type: 'SET_DUPLICATE', filePath: '/photo.jpg', duplicate: false });

      expect(next.files[0].duplicate).toBe(true);
      expect(next.files[0].duplicateMemory).toEqual(file.duplicateMemory);
    });

    it('clears destination-only duplicate flags', () => {
      const file = makeFile({ path: '/photo.jpg', duplicate: true });
      const state = makeState({ files: [file] });

      const next = reducer(state, { type: 'SET_DUPLICATE', filePath: '/photo.jpg', duplicate: false });

      expect(next.files[0].duplicate).toBe(false);
    });

    it('stores catalog duplicate memory from scan events', () => {
      const file = makeFile({ path: '/photo.jpg' });
      const state = makeState({ files: [file] });
      const duplicateMemory = {
        kind: 'previous-import' as const,
        matchedPath: '/archive/photo.jpg',
        importedAt: '2026-05-01T00:00:00.000Z',
      };
      const next = reducer(state, { type: 'SET_DUPLICATE', filePath: '/photo.jpg', duplicateMemory });
      expect(next.files[0].duplicate).toBe(true);
      expect(next.files[0].duplicateMemory).toEqual(duplicateMemory);
    });

    it('does not mark previous rejects as duplicates', () => {
      const file = makeFile({ path: '/photo.jpg' });
      const state = makeState({ files: [file] });
      const duplicateMemory = {
        kind: 'previous-reject' as const,
        matchedPath: '/archive/photo.jpg',
        rejectedAt: '2026-05-01T00:00:00.000Z',
      };

      const next = reducer(state, { type: 'SET_DUPLICATE', filePath: '/photo.jpg', duplicateMemory });

      expect(next.files[0].duplicate).toBe(false);
      expect(next.files[0].duplicateMemory).toEqual(duplicateMemory);
    });
  });

  describe('catalog duplicate filter', () => {
    it('stores catalog duplicate filter selection', () => {
      const next = reducer(makeState(), { type: 'SET_FILTER', filter: 'catalog-duplicates' });
      expect(next.filter).toBe('catalog-duplicates');
    });
  });

  describe('CLEAR_CATALOG_MEMORY_FOR_SOURCE', () => {
    it('clears catalog duplicate memory only for files inside the current source', () => {
      const inside = makeFile({
        path: '/card/DCIM/a.jpg',
        duplicate: true,
        duplicateMemory: { kind: 'previous-import', matchedPath: '/archive/a.jpg' },
      });
      const outside = makeFile({
        path: '/old/DCIM/b.jpg',
        duplicate: true,
        duplicateMemory: { kind: 'previous-import', matchedPath: '/archive/b.jpg' },
      });

      const next = reducer(makeState({ files: [inside, outside] }), {
        type: 'CLEAR_CATALOG_MEMORY_FOR_SOURCE',
        sourcePath: '/card',
      });

      expect(next.files[0].duplicate).toBe(false);
      expect(next.files[0].duplicateMemory).toBeUndefined();
      expect(next.files[1].duplicate).toBe(true);
      expect(next.files[1].duplicateMemory).toEqual(outside.duplicateMemory);
    });
  });

  // --- CLEAR_DUPLICATES ---

  describe('CLEAR_DUPLICATES', () => {
    it('clears all duplicate flags', () => {
      const files = [makeFile({ path: '/a.jpg', duplicate: true }), makeFile({ path: '/b.jpg', duplicate: true })];
      const state = makeState({ files });
      const next = reducer(state, { type: 'CLEAR_DUPLICATES' });
      expect(next.files.every((f) => f.duplicate === false)).toBe(true);
    });

    it('keeps catalog duplicate flags so previous imports still skip', () => {
      const files = [
        makeFile({
          path: '/a.jpg',
          duplicate: true,
          duplicateMemory: { kind: 'previous-import', matchedPath: '/archive/a.jpg' },
        }),
        makeFile({ path: '/b.jpg', duplicate: true }),
      ];
      const next = reducer(makeState({ files }), { type: 'CLEAR_DUPLICATES' });

      expect(next.files[0].duplicate).toBe(true);
      expect(next.files[0].duplicateMemory).toEqual({ kind: 'previous-import', matchedPath: '/archive/a.jpg' });
      expect(next.files[1].duplicate).toBe(false);
    });

    it('keeps visual-match duplicates but clears previous rejects', () => {
      const files = [
        makeFile({
          path: '/same.jpg',
          duplicate: true,
          duplicateMemory: { kind: 'same-visual', matchedPath: '/archive/same.jpg' },
        }),
        makeFile({
          path: '/reject.jpg',
          duplicate: true,
          duplicateMemory: { kind: 'previous-reject', matchedPath: '/archive/reject.jpg', rejectedAt: '2026-05-01T00:00:00.000Z' },
        }),
      ];

      const next = reducer(makeState({ files }), { type: 'CLEAR_DUPLICATES' });

      expect(next.files[0].duplicate).toBe(true);
      expect(next.files[1].duplicate).toBe(false);
    });
  });

  // --- SET_PICK ---

  describe('SET_PICK', () => {
    it('sets pick for matching file', () => {
      const file = makeFile({ path: '/photo.jpg' });
      const state = makeState({ files: [file] });
      const next = reducer(state, { type: 'SET_PICK', filePath: '/photo.jpg', pick: 'selected' });
      expect(next.files[0].pick).toBe('selected');
    });

    it('sets rejected pick', () => {
      const file = makeFile({ path: '/photo.jpg' });
      const state = makeState({ files: [file] });
      const next = reducer(state, { type: 'SET_PICK', filePath: '/photo.jpg', pick: 'rejected' });
      expect(next.files[0].pick).toBe('rejected');
    });

    it('clears pick with undefined', () => {
      const file = makeFile({ path: '/photo.jpg', pick: 'selected' });
      const state = makeState({ files: [file] });
      const next = reducer(state, { type: 'SET_PICK', filePath: '/photo.jpg', pick: undefined });
      expect(next.files[0].pick).toBeUndefined();
    });
  });

  // --- SET_PICK_BATCH ---

  describe('SET_PICK_BATCH', () => {
    it('sets pick for multiple files', () => {
      const files = [makeFile({ path: '/a.jpg' }), makeFile({ path: '/b.jpg' }), makeFile({ path: '/c.jpg' })];
      const state = makeState({ files });
      const next = reducer(state, { type: 'SET_PICK_BATCH', filePaths: ['/a.jpg', '/c.jpg'], pick: 'selected' });
      expect(next.files[0].pick).toBe('selected');
      expect(next.files[1].pick).toBeUndefined();
      expect(next.files[2].pick).toBe('selected');
    });
  });

  describe('import queue', () => {
    it('adds only known paths to the queue without duplicates', () => {
      const files = [makeFile({ path: '/a.jpg' }), makeFile({ path: '/b.jpg' })];
      const state = makeState({ files, queuedPaths: ['/a.jpg'] });
      const next = reducer(state, { type: 'QUEUE_ADD_PATHS', paths: ['/a.jpg', '/b.jpg', '/missing.jpg'] });
      expect(next.queuedPaths).toEqual(['/a.jpg', '/b.jpg']);
    });

    it('can queue paths without changing the active filter', () => {
      const files = [makeFile({ path: '/a.jpg' }), makeFile({ path: '/b.jpg' })];
      const state = makeState({ files, filter: 'review-needed' });
      const next = reducer(state, { type: 'QUEUE_ADD_PATHS', paths: ['/a.jpg', '/b.jpg'], preserveFilter: true });

      expect(next.queuedPaths).toEqual(['/a.jpg', '/b.jpg']);
      expect(next.filter).toBe('review-needed');
    });

    it('removes paths from the queue', () => {
      const state = makeState({ queuedPaths: ['/a.jpg', '/b.jpg'] });
      const next = reducer(state, { type: 'QUEUE_REMOVE_PATHS', paths: ['/a.jpg'] });
      expect(next.queuedPaths).toEqual(['/b.jpg']);
    });

    it('clears queue and exits queue filter', () => {
      const state = makeState({ queuedPaths: ['/a.jpg'], filter: 'queue' });
      const next = reducer(state, { type: 'QUEUE_CLEAR' });
      expect(next.queuedPaths).toEqual([]);
      expect(next.filter).toBe('all');
    });
  });

  describe('selection sets', () => {
    it('normalizes direct batch selections to known unique file paths', () => {
      const files = [makeFile({ path: '/a.jpg' }), makeFile({ path: '/b.jpg' })];
      const next = reducer(makeState({ files }), {
        type: 'SET_SELECTED_PATHS',
        paths: ['/a.jpg', '/missing.jpg', '/a.jpg', '/b.jpg'],
      });

      expect(next.selectedPaths).toEqual(['/a.jpg', '/b.jpg']);
    });

    it('saves a named selection set with valid paths only', () => {
      const files = [makeFile({ path: '/a.jpg' }), makeFile({ path: '/b.jpg' })];
      const state = makeState({ files });
      const next = reducer(state, {
        type: 'SELECTION_SET_SAVE',
        name: 'Client',
        paths: ['/a.jpg', '/missing.jpg'],
        createdAt: '2026-04-22T00:00:00.000Z',
      });
      expect(next.selectionSets).toEqual([{ name: 'Client', paths: ['/a.jpg'], createdAt: '2026-04-22T00:00:00.000Z' }]);
    });

    it('applies a selection set by writing selectedPaths for valid files', () => {
      const files = [makeFile({ path: '/a.jpg' }), makeFile({ path: '/b.jpg' })];
      const state = makeState({
        files,
        selectionSets: [{ name: 'Client', paths: ['/a.jpg', '/missing.jpg'], createdAt: '2026-04-22T00:00:00.000Z' }],
      });
      const next = reducer(state, { type: 'SELECTION_SET_APPLY', name: 'Client' });
      expect(next.selectedPaths).toEqual(['/a.jpg']);
    });

    it('deletes a selection set', () => {
      const state = makeState({
        selectionSets: [{ name: 'Client', paths: ['/a.jpg'], createdAt: '2026-04-22T00:00:00.000Z' }],
      });
      const next = reducer(state, { type: 'SELECTION_SET_DELETE', name: 'Client' });
      expect(next.selectionSets).toEqual([]);
    });
  });

  describe('scan pause state', () => {
    it('sets and clears scanPaused', () => {
      const paused = reducer(makeState({ phase: 'scanning' }), { type: 'SCAN_PAUSE' });
      expect(paused.scanPaused).toBe(true);
      const resumed = reducer(paused, { type: 'SCAN_RESUME' });
      expect(resumed.scanPaused).toBe(false);
    });
  });

  describe('smart review actions', () => {
    it('applies review scores and derives blur risk', () => {
      const state = makeState({ files: [makeFile({ path: '/soft.jpg' })] });
      const next = reducer(state, {
        type: 'SET_REVIEW_SCORES',
        scores: { '/soft.jpg': { sharpnessScore: 10, visualHash: '0000000000000000' } },
      });
      expect(next.files[0].visualHash).toBe('0000000000000000');
      expect(next.files[0].blurRisk).toBe('high');
      expect(typeof next.files[0].reviewScore).toBe('number');
    });

    it('resolves second-pass files with an approved pick decision', () => {
      const files = [makeFile({ path: '/keeper.jpg' }), makeFile({ path: '/later.jpg' })];
      const next = reducer(makeState({ files }), {
        type: 'RESOLVE_SECOND_PASS',
        filePaths: ['/keeper.jpg'],
        pick: 'selected',
      });

      expect(next.files.find((file) => file.path === '/keeper.jpg')?.pick).toBe('selected');
      expect(next.files.find((file) => file.path === '/keeper.jpg')?.reviewApproved).toBe(true);
      expect(next.files.find((file) => file.path === '/later.jpg')?.reviewApproved).toBeUndefined();
      expect(next.fileHistory).toHaveLength(1);
    });

    it('groups visual duplicates by hash distance', () => {
      const files = [
        makeFile({ path: '/a.jpg', visualHash: '0000000000000000' }),
        makeFile({ path: '/b.jpg', visualHash: '0000000000000001' }),
        makeFile({ path: '/c.jpg', visualHash: 'ffffffffffffffff' }),
      ];
      const next = reducer(makeState({ files }), { type: 'GROUP_VISUAL_DUPLICATES', threshold: 2 });
      expect(next.files[0].visualGroupId).toBeTruthy();
      expect(next.files[1].visualGroupId).toBe(next.files[0].visualGroupId);
      expect(next.files[2].visualGroupId).toBeUndefined();
    });

    it('groups visual duplicates from supplied merged review files', () => {
      const files = [
        makeFile({ path: '/a.jpg' }),
        makeFile({ path: '/b.jpg' }),
        makeFile({ path: '/c.jpg' }),
      ];
      const mergedFiles = [
        { ...files[0], visualHash: '0000000000000000' },
        { ...files[1], visualHash: '0000000000000001' },
        { ...files[2], visualHash: 'ffffffffffffffff' },
      ];
      const next = reducer(makeState({ files }), { type: 'GROUP_VISUAL_DUPLICATES', threshold: 2, files: mergedFiles });
      expect(next.files[0].visualGroupId).toBeTruthy();
      expect(next.files[1].visualGroupId).toBe(next.files[0].visualGroupId);
      expect(next.files[2].visualGroupId).toBeUndefined();
    });

    it('groups similar faces from supplied merged review files', () => {
      const files = [
        makeFile({ path: '/a.jpg' }),
        makeFile({ path: '/b.jpg' }),
        makeFile({ path: '/c.jpg' }),
      ];
      const mergedFiles = [
        { ...files[0], faceCount: 1, faceEmbedding: embeddingHex([1, 0, 0, 0]) },
        { ...files[1], faceCount: 1, faceEmbedding: embeddingHex([0.99, 0.01, 0, 0]) },
        { ...files[2], faceCount: 1, faceEmbedding: embeddingHex([0, 1, 0, 0]) },
      ];
      const next = reducer(makeState({ files }), { type: 'GROUP_FACE_SIMILAR', threshold: 10, files: mergedFiles });
      expect(next.files[0].faceGroupId).toBeTruthy();
      expect(next.files[1].faceGroupId).toBe(next.files[0].faceGroupId);
      expect(next.files[0].faceGroupSize).toBe(2);
      expect(next.files[2].faceGroupId).toBeUndefined();
    });

    it('keeps lower-confidence face candidates split with the default app threshold', () => {
      const files = [
        makeFile({ path: '/a.jpg' }),
        makeFile({ path: '/b.jpg' }),
        makeFile({ path: '/c.jpg' }),
      ];
      const mergedFiles = [
        { ...files[0], faceCount: 1, faceEmbedding: embeddingHex([1, 0, 0, 0]) },
        { ...files[1], faceCount: 1, faceEmbedding: embeddingHex([0.58, 0.815, 0, 0]) },
        { ...files[2], faceCount: 1, faceEmbedding: embeddingHex([0, 0, 1, 0]) },
      ];
      const next = reducer(makeState({ files }), { type: 'GROUP_FACE_SIMILAR', threshold: 10, files: mergedFiles });
      expect(next.files[0].faceGroupId).toBeUndefined();
      expect(next.files[1].faceGroupId).toBeUndefined();
      expect(next.files[2].faceGroupId).toBeUndefined();
    });

    it('can still group lower-confidence event face candidates when explicitly loosened', () => {
      const files = [
        makeFile({ path: '/a.jpg' }),
        makeFile({ path: '/b.jpg' }),
        makeFile({ path: '/c.jpg' }),
      ];
      const mergedFiles = [
        { ...files[0], faceCount: 1, faceEmbedding: embeddingHex([1, 0, 0, 0]) },
        { ...files[1], faceCount: 1, faceEmbedding: embeddingHex([0.6, 0.8, 0, 0]) },
        { ...files[2], faceCount: 1, faceEmbedding: embeddingHex([0, 0, 1, 0]) },
      ];
      const next = reducer(makeState({ files }), {
        type: 'GROUP_FACE_SIMILAR',
        threshold: 10,
        embeddingThreshold: 0.52,
        files: mergedFiles,
      });
      expect(next.files[1].faceGroupId).toBe(next.files[0].faceGroupId);
      expect(next.files[0].faceGroupSize).toBe(2);
      expect(next.files[2].faceGroupId).toBeUndefined();
    });

    it('groups faces when the match is a secondary face in a group photo', () => {
      const files = [
        makeFile({ path: '/group.jpg' }),
        makeFile({ path: '/solo.jpg' }),
      ];
      const mergedFiles = [
        {
          ...files[0],
          faceCount: 2,
          faceEmbeddings: [embeddingHex([0, 1, 0, 0]), embeddingHex([1, 0, 0, 0])],
        },
        { ...files[1], faceCount: 1, faceEmbedding: embeddingHex([0.99, 0.01, 0, 0]) },
      ];
      const next = reducer(makeState({ files }), { type: 'GROUP_FACE_SIMILAR', threshold: 10, files: mergedFiles });
      expect(next.files[0].faceGroupId).toBeTruthy();
      expect(next.files[1].faceGroupId).toBe(next.files[0].faceGroupId);
      expect(next.files[0].faceGroupSize).toBe(2);
    });

    it('picks best in visual groups and records undo history', () => {
      const files = [
        makeFile({ path: '/a.jpg', visualGroupId: 'g1', visualGroupSize: 2, reviewScore: 20, sharpnessScore: 20 }),
        makeFile({ path: '/b.jpg', visualGroupId: 'g1', visualGroupSize: 2, rating: 5, reviewScore: 80, sharpnessScore: 80 }),
      ];
      const next = reducer(makeState({ files }), { type: 'PICK_BEST_IN_GROUPS' });
      expect(next.files.find((f) => f.path === '/b.jpg')?.pick).toBe('selected');
      expect(next.files.find((f) => f.path === '/a.jpg')?.pick).toBe('rejected');
      expect(next.fileHistory).toHaveLength(1);
    });

    it('does not promote a manually rejected rated file when picking best in groups', () => {
      const files = [
        makeFile({ path: '/rejected-star.jpg', visualGroupId: 'g1', visualGroupSize: 2, pick: 'rejected', rating: 5, reviewScore: 96, sharpnessScore: 220, subjectSharpnessScore: 180 }),
        makeFile({ path: '/usable.jpg', visualGroupId: 'g1', visualGroupSize: 2, reviewScore: 70, sharpnessScore: 130, subjectSharpnessScore: 110 }),
      ];
      const next = reducer(makeState({ files }), { type: 'PICK_BEST_IN_GROUPS' });

      expect(next.files.find((f) => f.path === '/usable.jpg')?.pick).toBe('selected');
      expect(next.files.find((f) => f.path === '/rejected-star.jpg')?.pick).toBe('rejected');
    });

    it('keeps manual picks from overriding a stronger group best', () => {
      const files = [
        makeFile({ path: '/manual-pick.jpg', visualGroupId: 'g1', visualGroupSize: 2, pick: 'selected', reviewScore: 50, sharpnessScore: 70, subjectSharpnessScore: 70 }),
        makeFile({ path: '/quality-best.jpg', visualGroupId: 'g1', visualGroupSize: 2, reviewScore: 70, sharpnessScore: 95, subjectSharpnessScore: 95 }),
      ];
      const next = reducer(makeState({ files }), { type: 'PICK_BEST_IN_GROUPS' });

      expect(next.files.find((f) => f.path === '/quality-best.jpg')?.pick).toBe('selected');
      expect(next.files.find((f) => f.path === '/manual-pick.jpg')?.pick).toBe('rejected');
    });

    it('picks best in groups from supplied merged review files', () => {
      const files = [
        makeFile({ path: '/stale-best.jpg', visualGroupId: 'g1', visualGroupSize: 2, reviewScore: 90, sharpnessScore: 180 }),
        makeFile({ path: '/fresh-best.jpg', visualGroupId: 'g1', visualGroupSize: 2, reviewScore: 20, sharpnessScore: 20 }),
      ];
      const mergedFiles = [
        { ...files[0], reviewScore: 24, sharpnessScore: 35, subjectSharpnessScore: 20, blurRisk: 'high' as const },
        { ...files[1], reviewScore: 94, sharpnessScore: 220, subjectSharpnessScore: 180, blurRisk: 'low' as const },
      ];
      const next = reducer(makeState({ files }), { type: 'PICK_BEST_IN_GROUPS', files: mergedFiles });
      expect(next.files.find((f) => f.path === '/fresh-best.jpg')?.pick).toBe('selected');
      expect(next.files.find((f) => f.path === '/stale-best.jpg')?.pick).toBe('rejected');
    });

    it('auto-culls groups from supplied merged review files', () => {
      const files = [
        makeFile({ path: '/stale-best.jpg', visualGroupId: 'g1', visualGroupSize: 2, reviewScore: 90, sharpnessScore: 180 }),
        makeFile({ path: '/fresh-best.jpg', visualGroupId: 'g1', visualGroupSize: 2, reviewScore: 20, sharpnessScore: 20 }),
      ];
      const mergedFiles = [
        { ...files[0], reviewScore: 18, sharpnessScore: 20, subjectSharpnessScore: 12, blurRisk: 'high' as const },
        { ...files[1], reviewScore: 95, sharpnessScore: 220, subjectSharpnessScore: 180, blurRisk: 'low' as const },
      ];
      const next = reducer(makeState({ files }), { type: 'AUTO_CULL_SAFE', files: mergedFiles });
      expect(next.files.find((f) => f.path === '/fresh-best.jpg')?.pick).toBe('selected');
      expect(next.files.find((f) => f.path === '/stale-best.jpg')?.pick).toBe('rejected');
    });

    it('queues focused keepable standalone photos', () => {
      const files = [
        makeFile({ path: '/best.jpg', reviewScore: 80, sharpnessScore: 150, subjectSharpnessScore: 120, blurRisk: 'low' }),
        makeFile({ path: '/weak.jpg', reviewScore: 40, sharpnessScore: 118, subjectSharpnessScore: 96, blurRisk: 'low' }),
        makeFile({ path: '/soft.jpg', reviewScore: 84, sharpnessScore: 112, subjectSharpnessScore: 34, blurRisk: 'medium', faceCount: 4 }),
        makeFile({ path: '/reject.jpg', reviewScore: 95, pick: 'rejected' }),
        makeFile({ path: '/duplicate.jpg', reviewScore: 95, duplicate: true }),
      ];
      const next = reducer(makeState({ files }), { type: 'QUEUE_BEST' });
      expect(next.queuedPaths).toEqual(['/best.jpg', '/weak.jpg']);
    });

    it('replaces stale queued paths when queueing keepers', () => {
      const files = [
        makeFile({ path: '/keeper.jpg', reviewScore: 80, sharpnessScore: 145, subjectSharpnessScore: 110, blurRisk: 'low' }),
        makeFile({ path: '/reject.jpg', reviewScore: 95, pick: 'rejected' }),
      ];
      const next = reducer(makeState({ files, queuedPaths: ['/stale.jpg'], filter: 'queue' }), { type: 'QUEUE_BEST' });
      expect(next.queuedPaths).toEqual(['/keeper.jpg']);
      expect(next.filter).toBe('queue');
    });

    it('leaves queue view when queueing keepers finds nothing importable', () => {
      const files = [
        makeFile({ path: '/reject.jpg', reviewScore: 95, pick: 'rejected' }),
        makeFile({ path: '/duplicate.jpg', reviewScore: 95, duplicate: true }),
      ];
      const next = reducer(makeState({ files, queuedPaths: ['/stale.jpg'], filter: 'queue' }), { type: 'QUEUE_BEST' });
      expect(next.queuedPaths).toEqual([]);
      expect(next.filter).toBe('all');
    });

    it('queues one best keeper per burst group', () => {
      const files = [
        makeFile({ path: '/burst-soft.jpg', burstId: 'b1', burstSize: 2, burstIndex: 1, reviewScore: 92, sharpnessScore: 20 }),
        makeFile({ path: '/burst-sharp.jpg', burstId: 'b1', burstSize: 2, burstIndex: 2, reviewScore: 82, sharpnessScore: 220 }),
      ];
      const next = reducer(makeState({ files }), { type: 'QUEUE_BEST' });
      expect(next.queuedPaths).toEqual(['/burst-sharp.jpg']);
      expect(next.filter).toBe('queue');
    });

    it('prefers a manually starred file as the burst keeper', () => {
      const files = [
        makeFile({ path: '/starred.jpg', burstId: 'b1', burstSize: 2, burstIndex: 1, rating: 1, reviewScore: 20, sharpnessScore: 20 }),
        makeFile({ path: '/algorithm-best.jpg', burstId: 'b1', burstSize: 2, burstIndex: 2, reviewScore: 85, sharpnessScore: 220 }),
      ];
      const next = reducer(makeState({ files }), { type: 'QUEUE_BEST' });
      expect(next.queuedPaths).toEqual(['/starred.jpg']);
    });

    it('queues duplicate keepers when duplicate skipping is disabled', () => {
      const files = [
        makeFile({ path: '/duplicate-keeper.jpg', duplicate: true, reviewScore: 92, sharpnessScore: 220 }),
      ];
      const next = reducer(makeState({ files, skipDuplicates: false }), { type: 'QUEUE_BEST' });
      expect(next.queuedPaths).toEqual(['/duplicate-keeper.jpg']);
      expect(next.filter).toBe('queue');
    });

    it('queues the configured top keeper quota for grouped photos', () => {
      const files = [
        makeFile({ path: '/burst-best.jpg', burstId: 'b1', burstSize: 3, burstIndex: 1, reviewScore: 94, sharpnessScore: 180, subjectSharpnessScore: 150 }),
        makeFile({ path: '/burst-alt.jpg', burstId: 'b1', burstSize: 3, burstIndex: 2, reviewScore: 82, sharpnessScore: 160, subjectSharpnessScore: 132 }),
        makeFile({ path: '/burst-soft.jpg', burstId: 'b1', burstSize: 3, burstIndex: 3, reviewScore: 28, sharpnessScore: 35, subjectSharpnessScore: 20, blurRisk: 'high' }),
      ];
      const next = reducer(makeState({ files, keeperQuota: 'top-2' }), { type: 'QUEUE_BEST' });
      expect(next.queuedPaths).toEqual(['/burst-best.jpg', '/burst-alt.jpg']);
    });

    it('queues smile and sharpness alternates for grouped portraits', () => {
      const files = [
        makeFile({
          path: '/overall.jpg',
          burstId: 'b1',
          burstSize: 3,
          burstIndex: 1,
          faceCount: 1,
          faceBoxes: [{ x: 0.3, y: 0.2, width: 0.2, height: 0.22, eyeScore: 2, smileScore: 0.45, score: 0.94 }],
          subjectSharpnessScore: 132,
          sharpnessScore: 150,
          reviewScore: 82,
        }),
        makeFile({
          path: '/smile.jpg',
          burstId: 'b1',
          burstSize: 3,
          burstIndex: 2,
          faceCount: 1,
          faceBoxes: [{ x: 0.3, y: 0.2, width: 0.2, height: 0.22, eyeScore: 2, smileScore: 1, score: 0.9 }],
          subjectSharpnessScore: 92,
          sharpnessScore: 110,
          reviewScore: 72,
        }),
        makeFile({
          path: '/sharp.jpg',
          burstId: 'b1',
          burstSize: 3,
          burstIndex: 3,
          faceCount: 1,
          faceBoxes: [{ x: 0.3, y: 0.2, width: 0.2, height: 0.22, eyeScore: 1, smileScore: 0.3, score: 0.86 }],
          subjectSharpnessScore: 175,
          sharpnessScore: 190,
          reviewScore: 68,
        }),
      ];
      const next = reducer(makeState({ files, keeperQuota: 'smile-and-sharp' }), { type: 'QUEUE_BEST' });
      expect(next.queuedPaths).toEqual(['/overall.jpg', '/smile.jpg', '/sharp.jpg']);
    });

    it('keeps safe detail alternates when queueing keepers in conservative mode', () => {
      const files = [
        makeFile({
          path: '/portrait.jpg',
          visualGroupId: 'g1',
          visualGroupSize: 2,
          faceCount: 1,
          faceBoxes: [{ x: 0.3, y: 0.2, width: 0.2, height: 0.22, eyeScore: 2, score: 0.96 }],
          subjectSharpnessScore: 155,
          sharpnessScore: 190,
          reviewScore: 88,
        }),
        makeFile({
          path: '/detail.jpg',
          visualGroupId: 'g1',
          visualGroupSize: 2,
          sharpnessScore: 175,
          reviewScore: 72,
          blurRisk: 'low',
        }),
      ];
      const next = reducer(makeState({ files, cullConfidence: 'conservative' }), { type: 'QUEUE_BEST' });
      expect(next.queuedPaths).toEqual(['/portrait.jpg', '/detail.jpg']);
    });

    it('does not sync edits across the generic scene bucket', () => {
      const files = [
        makeFile({ path: '/focused.jpg', sceneBucket: 'Scene', exposureAdjustmentStops: 0.5, whiteBalanceAdjustment: { temperature: 10, tint: 5 } }),
        makeFile({ path: '/other.jpg', sceneBucket: 'Scene' }),
      ];
      const next = reducer(makeState({ files, focusedIndex: 0 }), { type: 'SYNC_EDITS_FROM_FOCUSED' });
      expect(next.files.find((file) => file.path === '/other.jpg')?.exposureAdjustmentStops).toBeUndefined();
      expect(next.files.find((file) => file.path === '/other.jpg')?.whiteBalanceAdjustment).toBeUndefined();
    });

    it('syncs edits across a named scene bucket', () => {
      const files = [
        makeFile({ path: '/focused.jpg', sceneBucket: 'ceremony', exposureAdjustmentStops: 0.5, whiteBalanceAdjustment: { temperature: 10, tint: 5 } }),
        makeFile({ path: '/other.jpg', sceneBucket: 'ceremony' }),
      ];
      const next = reducer(makeState({ files, focusedIndex: 0 }), { type: 'SYNC_EDITS_FROM_FOCUSED' });
      expect(next.files.find((file) => file.path === '/other.jpg')?.exposureAdjustmentStops).toBe(0.5);
      expect(next.files.find((file) => file.path === '/other.jpg')?.whiteBalanceAdjustment).toEqual({ temperature: 10, tint: 5 });
    });

    it('does not record file history for no-op exposure and white balance edits', () => {
      const file = makeFile({ path: '/edit.jpg', exposureValue: 10 });
      const state = makeState({ files: [file] });

      const exposureNoop = reducer(state, {
        type: 'SET_EXPOSURE_ADJUSTMENT',
        filePaths: [file.path],
        stops: 0,
      });
      expect(exposureNoop).toBe(state);
      expect(exposureNoop.fileHistory).toHaveLength(0);

      const whiteBalanceNoop = reducer(state, {
        type: 'SET_WHITE_BALANCE_ADJUSTMENT',
        filePaths: [file.path],
        temperature: 0,
        tint: 0,
      });
      expect(whiteBalanceNoop).toBe(state);
      expect(whiteBalanceNoop.fileHistory).toHaveLength(0);
    });

    it('records file history when exposure edits actually change a file', () => {
      const file = makeFile({ path: '/edit.jpg', exposureValue: 10 });
      const next = reducer(makeState({ files: [file] }), {
        type: 'SET_EXPOSURE_ADJUSTMENT',
        filePaths: [file.path],
        stops: 0.5,
      });

      expect(next.files[0].exposureAdjustmentStops).toBe(0.5);
      expect(next.fileHistory).toHaveLength(1);
    });
  });

  // --- CLEAR_PICKS ---

  describe('CLEAR_PICKS', () => {
    it('clears all picks', () => {
      const files = [makeFile({ path: '/a.jpg', pick: 'selected' }), makeFile({ path: '/b.jpg', pick: 'rejected' })];
      const state = makeState({ files });
      const next = reducer(state, { type: 'CLEAR_PICKS' });
      expect(next.files.every((f) => f.pick === undefined)).toBe(true);
    });
  });

  // --- Settings actions ---

  describe('settings actions', () => {
    it('SET_VOLUMES', () => {
      const volumes = [{ name: 'SD', path: '/Volumes/SD', isRemovable: true, isExternal: true }];
      const next = reducer(makeState(), { type: 'SET_VOLUMES', volumes });
      expect(next.volumes).toBe(volumes);
    });

    it('SELECT_SOURCE resets files and phase', () => {
      const state = makeState({ files: [makeFile()], phase: 'ready' });
      const next = reducer(state, { type: 'SELECT_SOURCE', path: '/new' });
      expect(next.selectedSource).toBe('/new');
      expect(next.files).toEqual([]);
      expect(next.phase).toBe('idle');
    });

    it('SET_DESTINATION', () => {
      const next = reducer(makeState(), { type: 'SET_DESTINATION', path: '/dest' });
      expect(next.destination).toBe('/dest');
    });

    it('SET_SKIP_DUPLICATES', () => {
      const next = reducer(makeState(), { type: 'SET_SKIP_DUPLICATES', value: false });
      expect(next.skipDuplicates).toBe(false);
    });

    it('SET_SAVE_FORMAT', () => {
      const next = reducer(makeState(), { type: 'SET_SAVE_FORMAT', format: 'jpeg' });
      expect(next.saveFormat).toBe('jpeg');
    });

    it('SET_JPEG_QUALITY', () => {
      const next = reducer(makeState(), { type: 'SET_JPEG_QUALITY', quality: 75 });
      expect(next.jpegQuality).toBe(75);
    });

    it('SET_FOLDER_PRESET', () => {
      const next = reducer(makeState(), { type: 'SET_FOLDER_PRESET', preset: 'year-month' });
      expect(next.folderPreset).toBe('year-month');
    });

    it('SET_FILTER supports JPEG-only imports', () => {
      const next = reducer(makeState(), { type: 'SET_FILTER', filter: 'jpeg' });
      expect(next.filter).toBe('jpeg');
    });

    it('SET_CUSTOM_PATTERN', () => {
      const next = reducer(makeState(), { type: 'SET_CUSTOM_PATTERN', pattern: '{YYYY}/{name}.{ext}' });
      expect(next.customPattern).toBe('{YYYY}/{name}.{ext}');
    });

    it('SET_WORKFLOW_OPTION supports automatic Lightroom handoff', () => {
      const next = reducer(makeState(), { type: 'SET_WORKFLOW_OPTION', key: 'autoLightroomHandoff', value: true });
      expect(next.autoLightroomHandoff).toBe(true);
    });

    it('SET_LICENSE_STATUS', () => {
      const next = reducer(makeState(), { type: 'SET_LICENSE_STATUS', status: { valid: true, message: 'ok' } });
      expect(next.licenseStatus).toEqual({ valid: true, message: 'ok' });
      expect(next.licensePromptOpen).toBe(false);
      expect(next.licenseBannerDismissed).toBe(false);
    });
  });

  describe('license UI state', () => {
    it('keeps the license prompt closed on hydration when license is missing', () => {
      const next = reducer(makeState(), { type: 'HYDRATE_LICENSE_STATUS', status: null });
      expect(next.licenseHydrated).toBe(true);
      expect(next.licensePromptOpen).toBe(false);
      expect(next.licenseBannerDismissed).toBe(false);
    });

    it('closing the prompt leaves the app in browse mode with the banner available', () => {
      const state = makeState({ licenseHydrated: true, licensePromptOpen: true });
      const next = reducer(state, { type: 'CLOSE_LICENSE_PROMPT' });
      expect(next.licensePromptOpen).toBe(false);
      expect(next.licenseBannerDismissed).toBe(false);
    });

    it('dismissing the banner hides it for the current session', () => {
      const state = makeState({ licenseHydrated: true, licensePromptOpen: false, licenseBannerDismissed: false });
      const next = reducer(state, { type: 'DISMISS_LICENSE_BANNER' });
      expect(next.licenseBannerDismissed).toBe(true);
    });

    it('reopens the prompt from browse mode and clears the dismissed banner state', () => {
      const state = makeState({ licenseHydrated: true, licensePromptOpen: false, licenseBannerDismissed: true });
      const next = reducer(state, { type: 'OPEN_LICENSE_PROMPT' });
      expect(next.licensePromptOpen).toBe(true);
      expect(next.licenseBannerDismissed).toBe(false);
    });

    it('activating a valid license closes the prompt and clears the banner dismissal', () => {
      const state = makeState({ licenseHydrated: true, licensePromptOpen: true, licenseBannerDismissed: true });
      const next = reducer(state, { type: 'SET_LICENSE_STATUS', status: { valid: true, message: 'ok' } });
      expect(next.licensePromptOpen).toBe(false);
      expect(next.licenseBannerDismissed).toBe(false);
    });
  });

  // --- IMPORT_PROGRESS ---

  describe('IMPORT_PROGRESS', () => {
    it('updates importProgress', () => {
      const progress: ImportProgress = {
        currentFile: 'test.jpg', currentIndex: 3, totalFiles: 10,
        bytesTransferred: 1000, totalBytes: 5000, skipped: 1, errors: 0,
      };
      const next = reducer(makeState({ phase: 'importing' }), { type: 'IMPORT_PROGRESS', progress });
      expect(next.importProgress).toBe(progress);
    });
  });

  // --- View / UI actions ---

  describe('view and UI actions', () => {
    it('SET_FOCUSED', () => {
      const next = reducer(makeState({ files: [makeFile({ path: '/a.jpg' })] }), { type: 'SET_FOCUSED', index: 0, path: '/sorted/a.jpg' });
      expect(next.focusedIndex).toBe(0);
      expect(next.focusedPath).toBe('/sorted/a.jpg');
    });

    it('SET_FOCUSED falls back to the raw file path when no sorted path is provided', () => {
      const next = reducer(makeState({ files: [makeFile({ path: '/a.jpg' })] }), { type: 'SET_FOCUSED', index: 0 });
      expect(next.focusedIndex).toBe(0);
      expect(next.focusedPath).toBe('/a.jpg');
    });

    it('SET_FOCUSED clears the focused path for no focused item', () => {
      const next = reducer(makeState({ focusedIndex: 0, focusedPath: '/a.jpg' }), { type: 'SET_FOCUSED', index: -1 });
      expect(next.focusedIndex).toBe(-1);
      expect(next.focusedPath).toBeNull();
    });

    it('SET_VIEW_MODE', () => {
      const next = reducer(makeState(), { type: 'SET_VIEW_MODE', mode: 'single' });
      expect(next.viewMode).toBe('single');
    });

    it('returns from settings to the previous view mode', () => {
      const inSettings = reducer(makeState({ viewMode: 'single' }), { type: 'SET_VIEW_MODE', mode: 'settings' });
      expect(inSettings.viewMode).toBe('settings');
      expect(inSettings.previousViewMode).toBe('single');

      const back = reducer(inSettings, { type: 'SET_VIEW_MODE', mode: 'grid' });
      expect(back.viewMode).toBe('single');
      expect(back.previousViewMode).toBe(null);
    });

    it('merges view overlay preferences without resetting other toggles', () => {
      const next = reducer(makeState(), {
        type: 'SET_VIEW_OVERLAY_PREFERENCES',
        preferences: { faceBoxes: true },
      });
      expect(next.viewOverlayPreferences).toEqual({
        ...DEFAULT_VIEW_OVERLAY_PREFERENCES,
        faceBoxes: true,
      });
    });

    it('SET_THEME', () => {
      const next = reducer(makeState(), { type: 'SET_THEME', theme: 'light' });
      expect(next.theme).toBe('light');
    });

    it('TOGGLE_LEFT_PANEL', () => {
      const next = reducer(makeState({ showLeftPanel: true }), { type: 'TOGGLE_LEFT_PANEL' });
      expect(next.showLeftPanel).toBe(false);
    });

    it('TOGGLE_RIGHT_PANEL', () => {
      const next = reducer(makeState({ showRightPanel: true }), { type: 'TOGGLE_RIGHT_PANEL' });
      expect(next.showRightPanel).toBe(false);
    });

    it('RESET_FILES', () => {
      const state = makeState({ files: [makeFile()], phase: 'ready', focusedIndex: 3 });
      const next = reducer(state, { type: 'RESET_FILES' });
      expect(next.files).toEqual([]);
      expect(next.phase).toBe('idle');
      expect(next.focusedIndex).toBe(-1);
    });
  });

  // --- Edge cases ---

  describe('edge cases', () => {
    it('unknown action returns state unchanged', () => {
      const state = makeState();
      const next = reducer(state, { type: 'UNKNOWN_ACTION' } as any);
      expect(next).toBe(state);
    });
  });
});
