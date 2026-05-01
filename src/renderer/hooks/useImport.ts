import { useCallback, useRef } from 'react';

type NormalizedJobState = 'queued' | 'running' | 'paused' | 'cancelled' | 'completed' | 'failed';
import { useAppState, useAppDispatch } from '../context/ImportContext';
import { playCompletionSound } from '../utils/completionSound';
import { eventModeKeywords } from '../../shared/types';

let latestImportRunId = 0;

type StartImportOptions = {
  retryFailed?: boolean;
  dryRun?: boolean;
  selectedPathsOverride?: string[];
};

export function useImport() {
  const {
    selectedSource, destination, skipDuplicates, saveFormat, jpegQuality, phase,
    files, selectedPaths, queuedPaths,
    separateProtected, protectedFolderName, backupDestRoot, ftpDestEnabled, ftpDestConfig,
    autoEject, playSoundOnComplete, completeSoundPath, openFolderOnComplete,
    verifyChecksums,
    normalizeExposure, exposureAnchorPath, exposureMaxStops, whiteBalanceTemperature, whiteBalanceTint,
    eventMode,
    metadataKeywords, metadataTitle, metadataCaption, metadataCreator, metadataCopyright,
    metadataExport,
    watermarkEnabled, watermarkMode, watermarkText, watermarkImagePath, watermarkOpacity, watermarkPositionLandscape, watermarkPositionPortrait, watermarkScale, autoStraighten,
    licenseStatus,
  } = useAppState();
  const dispatch = useAppDispatch();
  const importStateRef = useRef<NormalizedJobState>('queued');

  const startImport = useCallback(async (options?: StartImportOptions) => {
    if (!selectedSource || !destination) return;
    if (!licenseStatus?.valid) {
      importStateRef.current = 'failed';
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
    //   1. Click-selected files (selectedPaths) — what the user has highlighted
    //      in the grid. If present, import ONLY these.
    //   2. Pick/reject flags — if the user has picked any file, import the picks.
    //   3. Everything that isn't rejected and (when enabled) isn't a duplicate.
    let pathsToImport: string[] | undefined;
    if (options?.selectedPathsOverride?.length) {
      pathsToImport = options.selectedPathsOverride;
    } else if (queuedPaths.length > 0) {
      pathsToImport = queuedPaths;
    } else if (selectedPaths.length > 0) {
      pathsToImport = selectedPaths;
    } else {
      const picked = files.filter((f) => f.pick === 'selected').map((f) => f.path);
      if (picked.length > 0) {
        pathsToImport = picked;
      }
      // else: leave undefined so the main process applies default filtering
      //       (skip rejects + skip duplicates if enabled).
    }

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
      : files.filter((f) => f.pick !== 'rejected' && (!skipDuplicates || !f.duplicate));
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

    const runId = ++latestImportRunId;
    importStateRef.current = 'running';
    dispatch({ type: 'IMPORT_START' });
    try {
      const config = {
        sourcePath: selectedSource,
        destRoot: destination,
        skipDuplicates,
        saveFormat,
        jpegQuality,
        selectedPaths: pathsToImport,
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
      const result = options?.retryFailed
        ? await window.electronAPI.retryFailedImport(config)
        : await window.electronAPI.startImport(config);
      if (runId !== latestImportRunId) return;
      importStateRef.current = result.errors.length > 0 ? 'failed' : 'completed';
      dispatch({ type: 'IMPORT_COMPLETE', result });

      // Optional post-import actions, renderer-side
      if (result.errors.length === 0 || result.imported > 0) {
        if (playSoundOnComplete) {
          playCompletionSound(completeSoundPath);
        }
        if (openFolderOnComplete && destination) {
          void window.electronAPI.openPath(destination).catch(() => undefined);
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
    }
  }, [
    selectedSource, destination, skipDuplicates, saveFormat, jpegQuality, phase, dispatch,
    files, selectedPaths, queuedPaths,
    separateProtected, protectedFolderName, backupDestRoot,
    ftpDestEnabled, ftpDestConfig,
    autoEject, playSoundOnComplete, completeSoundPath, openFolderOnComplete, verifyChecksums,
    normalizeExposure, exposureAnchorPath, exposureMaxStops, whiteBalanceTemperature, whiteBalanceTint, eventMode,
    metadataKeywords, metadataTitle, metadataCaption, metadataCreator, metadataCopyright, metadataExport,
    watermarkEnabled, watermarkMode, watermarkText, watermarkImagePath, watermarkOpacity, watermarkPositionLandscape, watermarkPositionPortrait, watermarkScale, autoStraighten,
    licenseStatus,
  ]);

  const cancelImport = useCallback(async () => {
    importStateRef.current = 'cancelled';
    await window.electronAPI.cancelImport();
  }, []);

  return { startImport, cancelImport };
}
