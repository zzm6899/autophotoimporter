import { useEffect, useCallback } from 'react';
import { useAppState, useAppDispatch } from '../context/ImportContext';

export function useImport() {
  const {
    selectedSource, destination, skipDuplicates, saveFormat, jpegQuality, phase,
    files, selectedPaths, queuedPaths,
    separateProtected, protectedFolderName, backupDestRoot,
    autoEject, playSoundOnComplete, completeSoundPath, openFolderOnComplete,
    verifyChecksums,
    normalizeExposure, exposureAnchorPath, exposureMaxStops,
  } = useAppState();
  const dispatch = useAppDispatch();

  useEffect(() => {
    const unsub = window.electronAPI.onImportProgress((progress) => {
      dispatch({ type: 'IMPORT_PROGRESS', progress });
    });
    return () => { unsub(); };
  }, [dispatch]);

  const startImport = useCallback(async () => {
    if (!selectedSource || !destination) return;

    if (phase === 'scanning') {
      await window.electronAPI.cancelScan();
    }

    // Selection priority:
    //   1. Click-selected files (selectedPaths) — what the user has highlighted
    //      in the grid. If present, import ONLY these.
    //   2. Pick/reject flags — if the user has picked any file, import the picks.
    //   3. Everything that isn't rejected and (when enabled) isn't a duplicate.
    let pathsToImport: string[] | undefined;
    if (queuedPaths.length > 0) {
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
      ? files.filter((f) => f.normalizeToAnchor).map((f) => f.path)
      : [];
    const exposureAdjustments = saveFormat !== 'original'
      ? Object.fromEntries(files
          .filter((f) => typeof f.exposureAdjustmentStops === 'number' && Math.abs(f.exposureAdjustmentStops) >= 0.01)
          .map((f) => [f.path, f.exposureAdjustmentStops as number]))
      : {};

    dispatch({ type: 'IMPORT_START' });
    try {
      const result = await window.electronAPI.startImport({
        sourcePath: selectedSource,
        destRoot: destination,
        skipDuplicates,
        saveFormat,
        jpegQuality,
        selectedPaths: pathsToImport,
        separateProtected,
        protectedFolderName,
        backupDestRoot: backupDestRoot || undefined,
        autoEject,
        verifyChecksums,
        normalizeExposure: normalizeExposure && saveFormat !== 'original' && typeof exposureAnchorEV === 'number',
        exposureAnchorEV,
        exposureMaxStops,
        normalizeAnchorPaths: normalizeAnchorPaths.length > 0 ? normalizeAnchorPaths : undefined,
        exposureAdjustments: Object.keys(exposureAdjustments).length > 0 ? exposureAdjustments : undefined,
      });
      dispatch({ type: 'IMPORT_COMPLETE', result });

      // Optional post-import actions, renderer-side
      if (result.errors.length === 0 || result.imported > 0) {
        if (playSoundOnComplete) {
          try {
            const soundSrc = completeSoundPath
              ? `file:///${completeSoundPath.replace(/\\/g, '/').replace(/^\/+/, '')}`
              : 'data:audio/wav;base64,UklGRjIAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQ4AAACAhIuQlJmbm5qYlJCMiA==';
            const a = new Audio(encodeURI(soundSrc));
            void a.play().catch(() => undefined);
          } catch { /* ignore */ }
        }
        if (openFolderOnComplete && destination) {
          void window.electronAPI.openPath(destination).catch(() => undefined);
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Import failed unexpectedly';
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
    autoEject, playSoundOnComplete, completeSoundPath, openFolderOnComplete, verifyChecksums,
    normalizeExposure, exposureAnchorPath, exposureMaxStops,
  ]);

  const cancelImport = useCallback(async () => {
    await window.electronAPI.cancelImport();
  }, []);

  return { startImport, cancelImport };
}
