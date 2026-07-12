import { useCallback, useRef } from 'react';
import { useAppState, useAppDispatch } from '../context/ImportContext';
import { playCompletionSound } from '../utils/completionSound';
import { eventModeKeywords, type ImportConfig, type MediaFile } from '../../shared/types';

let latestImportRunId = 0;

type NormalizedJobState = 'queued' | 'running' | 'paused' | 'cancelled' | 'completed' | 'failed';

type QueuedImportJob = {
  config: ImportConfig;
  retryFailed: boolean;
  destination: string;
  playSoundOnComplete: boolean;
  completeSoundPath: string;
  openFolderOnComplete: boolean;
};

const queuedImportJobs: QueuedImportJob[] = [];
let importRunnerActive = false;

type StartImportOptions = {
  retryFailed?: boolean;
  dryRun?: boolean;
  selectedPathsOverride?: string[];
  includeRejected?: boolean;
};

type ImportPathResolutionInput = {
  files: Pick<MediaFile, 'path' | 'destPath' | 'pick' | 'duplicate'>[];
  selectedPaths: string[];
  queuedPaths: string[];
  skipDuplicates: boolean;
  selectedPathsOverride?: string[];
  includeRejected?: boolean;
};

export function resolveImportPaths({
  files,
  selectedPaths,
  queuedPaths,
  skipDuplicates,
  selectedPathsOverride,
  includeRejected,
}: ImportPathResolutionInput): string[] | undefined {
  const isImportableFile = (file: ImportPathResolutionInput['files'][number]) =>
    !!file.destPath && (includeRejected || file.pick !== 'rejected') && (!skipDuplicates || !file.duplicate);
  const importablePathSet = new Set(files.filter(isImportableFile).map((file) => file.path));
  const filterImportablePaths = (paths: string[]) => paths.filter((path) => importablePathSet.has(path));

  if (Array.isArray(selectedPathsOverride)) {
    return filterImportablePaths(selectedPathsOverride);
  }
  if (selectedPaths.length > 0) {
    return filterImportablePaths(selectedPaths);
  }
  if (queuedPaths.length > 0) {
    return filterImportablePaths(queuedPaths);
  }

  const pickedFiles = files.filter((file) => file.pick === 'selected');
  if (pickedFiles.length > 0) {
    return pickedFiles.filter(isImportableFile).map((file) => file.path);
  }

  return files.filter(isImportableFile).map((file) => file.path);
}

export function useImport() {
  const {
    selectedSource, sourceProfile, destination, skipDuplicates, saveFormat, jpegQuality, phase, importRunning,
    files, selectedPaths, queuedPaths,
    separateProtected, protectedFolderName, backupDestRoot, ftpDestEnabled, ftpDestConfig,
    autoEject, playSoundOnComplete, completeSoundPath, openFolderOnComplete,
    verifyChecksums,
    conflictPolicy, conflictFolderName,
    normalizeExposure, exposureAnchorPath, exposureMaxStops, whiteBalanceTemperature, whiteBalanceTint,
    eventMode, scheduleCsvPath, scheduleSheetUrl,
    metadataKeywords, metadataTitle, metadataCaption, metadataCreator, metadataCopyright,
    metadataExport,
    watermarkEnabled, watermarkMode, watermarkText, watermarkImagePath, watermarkOpacity, watermarkPositionLandscape, watermarkPositionPortrait, watermarkScale, autoStraighten,
    licenseStatus,
  } = useAppState();
  const dispatch = useAppDispatch();
  const importStateRef = useRef<NormalizedJobState>('queued');
  const runImportJobRef = useRef<((job: QueuedImportJob) => Promise<void>) | null>(null);

  const runImportJob = useCallback(async (job: QueuedImportJob) => {
    const runId = ++latestImportRunId;
    importRunnerActive = true;
    importStateRef.current = 'running';
    dispatch({ type: 'IMPORT_START' });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    try {
      const result = job.retryFailed
        ? await window.electronAPI.retryFailedImport(job.config)
        : await window.electronAPI.startImport(job.config);
      if (runId !== latestImportRunId) return;
      importStateRef.current = result.errors.length > 0 ? 'failed' : 'completed';
      dispatch({ type: 'IMPORT_COMPLETE', result });

      if (result.errors.length === 0 || result.imported > 0) {
        if (job.playSoundOnComplete) {
          playCompletionSound(job.completeSoundPath);
        }
        if (job.openFolderOnComplete && job.destination) {
          void window.electronAPI.openPath(job.destination).catch(() => undefined);
        }
      }
    } catch (err: unknown) {
      if (runId !== latestImportRunId) return;
      const message = err instanceof Error ? err.message : 'Import failed unexpectedly';
      importStateRef.current = 'failed';
      dispatch({
        type: 'IMPORT_COMPLETE',
        result: {
          imported: 0,
          skipped: 0,
          errors: [{ file: 'system', error: message }],
          totalBytes: 0,
          durationMs: 0,
        },
      });
    } finally {
      if (runId === latestImportRunId) {
        importRunnerActive = false;
        const nextJob = queuedImportJobs.shift();
        dispatch({ type: 'SET_IMPORT_QUEUE_DEPTH', count: queuedImportJobs.length });
        if (nextJob) {
          void runImportJobRef.current?.(nextJob);
        }
      }
    }
  }, [dispatch]);

  runImportJobRef.current = runImportJob;

  const startImport = useCallback(async (options?: StartImportOptions) => {
    if (!selectedSource || !destination) return;
    if (!licenseStatus?.valid) {
      importStateRef.current = 'failed';
      dispatch({ type: 'IMPORT_START' });
      dispatch({
        type: 'IMPORT_COMPLETE',
        result: {
          imported: 0,
          skipped: 0,
          errors: [{ file: 'license', error: licenseStatus?.message || 'A valid license is required to import.' }],
          totalBytes: 0,
          durationMs: 0,
        },
      });
      return;
    }

    if (phase === 'scanning') {
      await window.electronAPI.cancelScan();
    }

    // Selection priority:
    //   1. Explicit override from a button flow.
    //   2. Click-selected files (selectedPaths).
    //   3. Queue.
    //   4. Pick/reject flags.
    //   5. Everything that isn't rejected and (when enabled) isn't a duplicate.
    const isImportableFile = (file: typeof files[number]) =>
      !!file.destPath && (options?.includeRejected || file.pick !== 'rejected') && (!skipDuplicates || !file.duplicate);
    const pathsToImport = resolveImportPaths({
      files,
      selectedPaths,
      queuedPaths,
      skipDuplicates,
      selectedPathsOverride: options?.selectedPathsOverride,
      includeRejected: options?.includeRejected,
    });

    const importPathSet = pathsToImport ? new Set(pathsToImport) : null;

    // Exposure normalization only makes sense when we're transcoding — with
    // `original` we'd just copy bytes unchanged. The main process also
    // gates on this, but surfacing it here keeps the IPC payload small
    // and avoids hunting for an anchor that won't be used.
    const anchorFile = exposureAnchorPath ? files.find((f) => f.path === exposureAnchorPath) : null;
    const exposureAnchorEV = anchorFile?.exposureValue;

    // Per-file normalization paths: files the user has explicitly marked
    // "Normalize to anchor". These are normalized on import regardless of
    // the global normalizeExposure toggle, as long as the anchor EV is known
    // and the save format is transcoding.
    const normalizeAnchorPaths = typeof exposureAnchorEV === 'number' && saveFormat !== 'original'
      ? files
          .filter((f) => (!importPathSet || importPathSet.has(f.path)) && f.normalizeToAnchor)
          .map((f) => f.path)
      : [];
    const exposureAdjustments = saveFormat !== 'original'
      ? Object.fromEntries(files
          .filter((f) => (!importPathSet || importPathSet.has(f.path)) && typeof f.exposureAdjustmentStops === 'number' && Math.abs(f.exposureAdjustmentStops) >= 0.01)
          .map((f) => [f.path, f.exposureAdjustmentStops as number]))
      : {};
    const wbTemperature = whiteBalanceTemperature ?? 0;
    const wbTint = whiteBalanceTint ?? 0;
    const whiteBalance = saveFormat !== 'original' && (Math.abs(wbTemperature) >= 0.5 || Math.abs(wbTint) >= 0.5)
      ? { temperature: wbTemperature, tint: wbTint }
      : undefined;
    const whiteBalanceAdjustments = saveFormat !== 'original'
      ? Object.fromEntries(files
          .filter((f) => (!importPathSet || importPathSet.has(f.path)) && f.whiteBalanceAdjustment && (
            Math.abs(f.whiteBalanceAdjustment.temperature) >= 0.5 ||
            Math.abs(f.whiteBalanceAdjustment.tint) >= 0.5
          ))
          .map((f) => [f.path, f.whiteBalanceAdjustment!]))
      : {};
    const filesForImport = importPathSet
      ? files.filter((f) => importPathSet.has(f.path))
      : files.filter(isImportableFile);
    const smartKeywords = [
      ...eventModeKeywords(eventMode),
      ...(filesForImport.some((f) => (f.faceCount ?? 0) > 0) ? ['faces'] : []),
      ...(filesForImport.some((f) => (f.personCount ?? 0) > 0) ? ['people'] : []),
      ...(filesForImport.some((f) => f.type === 'video') ? ['video'] : []),
      ...(filesForImport.some((f) => f.isProtected) ? ['protected selects'] : []),
      ...(filesForImport.some((f) => f.visualGroupId || f.burstId) ? ['stacked selects'] : []),
      ...(filesForImport.map((f) => f.sceneBucket).filter(Boolean) as string[]),
      ...(filesForImport.map((f) => f.locationName).filter(Boolean) as string[]),
    ];
    const metadataKeywordList = [
      ...metadataKeywords
      .split(/[\n,;]+/)
      .map((value) => value.trim())
        .filter(Boolean),
      ...smartKeywords,
    ].filter((value, index, all) => value && all.findIndex((other) => other.toLowerCase() === value.toLowerCase()) === index);

    const config: ImportConfig = {
        sourcePath: selectedSource,
        sourceProfile,
        destRoot: destination,
        skipDuplicates,
        saveFormat,
        jpegQuality,
        eventMode,
        scheduleCsvPath: scheduleCsvPath || undefined,
        scheduleSheetUrl: scheduleSheetUrl || undefined,
        conflictPolicy,
        conflictFolderName,
        selectedPaths: pathsToImport,
        includeRejected: !!options?.includeRejected,
        separateProtected,
        protectedFolderName,
        backupDestRoot: backupDestRoot || undefined,
        ftpDestEnabled,
        ftpDestConfig: ftpDestEnabled ? ftpDestConfig : undefined,
        autoEject,
        verifyChecksums,
        normalizeExposure: normalizeExposure && saveFormat !== 'original' && typeof exposureAnchorEV === 'number',
        exposureAnchorEV,
        exposureMaxStops,
        normalizeAnchorPaths: normalizeAnchorPaths.length > 0 ? normalizeAnchorPaths : undefined,
        exposureAdjustments: Object.keys(exposureAdjustments).length > 0 ? exposureAdjustments : undefined,
        whiteBalance,
        whiteBalanceAdjustments: Object.keys(whiteBalanceAdjustments).length > 0 ? whiteBalanceAdjustments : undefined,
        metadataExportFlags: metadataExport,
        metadata: metadataKeywordList.length > 0 || metadataTitle.trim() || metadataCaption.trim() || metadataCreator.trim() || metadataCopyright.trim()
          ? {
              keywords: metadataExport.keywords !== false && metadataKeywordList.length > 0 ? metadataKeywordList : undefined,
              title: metadataExport.title !== false ? (metadataTitle.trim() || undefined) : undefined,
              caption: metadataExport.caption !== false ? (metadataCaption.trim() || undefined) : undefined,
              creator: metadataExport.creator !== false ? (metadataCreator.trim() || undefined) : undefined,
              copyright: metadataExport.copyright !== false ? (metadataCopyright.trim() || undefined) : undefined,
            }
          : undefined,
        watermark: watermarkEnabled && (
          (watermarkMode === 'text' && watermarkText.trim()) ||
          (watermarkMode === 'image' && watermarkImagePath.trim())
        )
          ? {
              enabled: true,
              mode: watermarkMode,
              text: watermarkMode === 'text' ? watermarkText.trim() : undefined,
              imagePath: watermarkMode === 'image' ? (watermarkImagePath.trim() || undefined) : undefined,
              opacity: watermarkOpacity,
              positionLandscape: watermarkPositionLandscape,
              positionPortrait: watermarkPositionPortrait,
              scale: watermarkScale,
        }
          : undefined,
        autoStraighten,
        dryRun: !!options?.dryRun,
      };

    const job: QueuedImportJob = {
      config,
      retryFailed: !!options?.retryFailed,
      destination,
      playSoundOnComplete,
      completeSoundPath,
      openFolderOnComplete,
    };

    if (importRunning || importRunnerActive || importStateRef.current === 'running') {
      queuedImportJobs.push(job);
      dispatch({ type: 'SET_IMPORT_QUEUE_DEPTH', count: queuedImportJobs.length });
      return;
    }

    void runImportJob(job);
  }, [
    selectedSource, sourceProfile, destination, skipDuplicates, saveFormat, jpegQuality, phase, importRunning, dispatch, runImportJob,
    files, selectedPaths, queuedPaths,
    separateProtected, protectedFolderName, backupDestRoot,
    ftpDestEnabled, ftpDestConfig,
    autoEject, playSoundOnComplete, completeSoundPath, openFolderOnComplete, verifyChecksums, conflictPolicy, conflictFolderName,
    normalizeExposure, exposureAnchorPath, exposureMaxStops, whiteBalanceTemperature, whiteBalanceTint, eventMode, scheduleCsvPath, scheduleSheetUrl,
    metadataKeywords, metadataTitle, metadataCaption, metadataCreator, metadataCopyright, metadataExport,
    watermarkEnabled, watermarkMode, watermarkText, watermarkImagePath, watermarkOpacity, watermarkPositionLandscape, watermarkPositionPortrait, watermarkScale, autoStraighten,
    licenseStatus,
  ]);

  const cancelImport = useCallback(async () => {
    importStateRef.current = 'cancelled';
    queuedImportJobs.length = 0;
    dispatch({ type: 'SET_IMPORT_QUEUE_DEPTH', count: 0 });
    await window.electronAPI.cancelImport();
  }, [dispatch]);

  return { startImport, cancelImport };
}
