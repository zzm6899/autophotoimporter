import { useEffect, useRef } from 'react';
import { useAppState, useAppDispatch } from '../context/ImportContext';

export function useScanListeners() {
  const {
    destination,
    files,
    phase,
    separateProtected,
    protectedFolderName,
  } = useAppState();
  const dispatch = useAppDispatch();

  // Track whether we're in an active scan at the listener layer.
  // This ref stays in sync with the phase state and lets the onScanComplete
  // callback discard stale IPC events that arrive after the phase left 'scanning'.
  const isActiveRef = useRef(false);
  useEffect(() => {
    isActiveRef.current = phase === 'scanning';
  }, [phase]);

  useEffect(() => {
    const unsubBatch = window.electronAPI.onScanBatch((files) => {
      dispatch({ type: 'SCAN_BATCH', files });
    });

    const unsubComplete = window.electronAPI.onScanComplete(() => {
      // Discard SCAN_COMPLETE that arrives after the scan was cancelled /
      // superseded. The reducer also guards on phase === 'scanning', so this
      // is belt-and-suspenders — but it avoids a spurious dispatch entirely.
      if (!isActiveRef.current) return;
      dispatch({ type: 'SCAN_COMPLETE' });
    });

    const unsubThumb = window.electronAPI.onScanThumbnail((filePath, thumbnail) => {
      dispatch({ type: 'SET_THUMBNAIL', filePath, thumbnail });
    });

    const unsubDuplicate = window.electronAPI.onScanDuplicate((filePath) => {
      dispatch({ type: 'SET_DUPLICATE', filePath });
    });

    return () => {
      unsubBatch();
      unsubComplete();
      unsubThumb();
      unsubDuplicate();
    };
  }, [dispatch]);

  useEffect(() => {
    if (!destination || files.length === 0 || phase !== 'ready') return;
    // Re-run when the protected-subfolder settings change too — otherwise
    // toggling "separate protected" after a scan leaves duplicates pointing
    // at the wrong path and protected files stay stuck as "ready to import"
    // even when they've already been imported into _Protected/.
    dispatch({ type: 'CLEAR_DUPLICATES' });
    window.electronAPI.checkDuplicates(destination);
  }, [destination, files.length, phase, separateProtected, protectedFolderName, dispatch]);
}
