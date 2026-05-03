import { describe, it, expect } from 'vitest';
import { reducer, type Action, type AppPhase } from '../ImportContext';
import type { MediaFile, ImportProgress, ImportResult, SaveFormat } from '../../../shared/types';
import { DEFAULT_VIEW_OVERLAY_PREFERENCES, FOLDER_PRESETS } from '../../../shared/types';

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    volumes: [],
    selectedSource: null,
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
    theme: 'dark' as const,
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
    verifyChecksums: false,
    sourceProfile: 'auto' as const,
    conflictPolicy: 'skip' as const,
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
    perfTier: 'auto' as const,
    fastKeeperMode: false,
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

describe('ImportContext reducer', () => {
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
  });

  // --- SCAN_BATCH ---

  describe('SCAN_BATCH', () => {
    it('appends files to existing array', () => {
      const file1 = makeFile({ path: '/a.jpg' });
      const file2 = makeFile({ path: '/b.jpg' });
      const state = makeState({ files: [file1] });
      const next = reducer(state, { type: 'SCAN_BATCH', files: [file2] });
      expect(next.files).toHaveLength(2);
      expect(next.files[1].path).toBe('/b.jpg');
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
  });

  describe('catalog duplicate filter', () => {
    it('stores catalog duplicate filter selection', () => {
      const next = reducer(makeState(), { type: 'SET_FILTER', filter: 'catalog-duplicates' });
      expect(next.filter).toBe('catalog-duplicates');
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

    it('queues every keepable standalone photo', () => {
      const files = [
        makeFile({ path: '/best.jpg', reviewScore: 80 }),
        makeFile({ path: '/weak.jpg', reviewScore: 40 }),
        makeFile({ path: '/reject.jpg', reviewScore: 95, pick: 'rejected' }),
        makeFile({ path: '/duplicate.jpg', reviewScore: 95, duplicate: true }),
      ];
      const next = reducer(makeState({ files }), { type: 'QUEUE_BEST' });
      expect(next.queuedPaths).toEqual(['/best.jpg', '/weak.jpg']);
    });

    it('replaces stale queued paths when queueing keepers', () => {
      const files = [
        makeFile({ path: '/keeper.jpg', reviewScore: 80 }),
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

    it('SET_CUSTOM_PATTERN', () => {
      const next = reducer(makeState(), { type: 'SET_CUSTOM_PATTERN', pattern: '{YYYY}/{name}.{ext}' });
      expect(next.customPattern).toBe('{YYYY}/{name}.{ext}');
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
