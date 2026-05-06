import { useEffect, useRef } from 'react';
import { useAppState, useAppDispatch } from '../context/ImportContext';

type NormalizedJobState = 'queued' | 'running' | 'paused' | 'cancelled' | 'completed' | 'failed';
const THUMBNAIL_FLUSH_MS = 120;
const THUMBNAIL_FLUSH_MAX_PENDING = 96;

function thumbnailFlushDelay(fileCount: number): number {
  if (fileCount >= 2500) return 400;
  if (fileCount >= 800) return 250;
  return THUMBNAIL_FLUSH_MS;
}

export function useScanListeners() {
  const {
    destination,
    files,
    phase,
    separateProtected,
    protectedFolderName,
  } = useAppState();
  const dispatch = useAppDispatch();
  const thumbnailBufferRef = useRef<Record<string, string>>({});
  const thumbnailBufferCountRef = useRef(0);
  const thumbnailFlushTimerRef = useRef<number | null>(null);
  const fileCountRef = useRef(0);

  // Track whether we're in an active scan at the listener layer.
  // This ref stays in sync with the phase state and lets the onScanComplete
  // callback discard stale IPC events that arrive after the phase left 'scanning'.
  const isActiveRef = useRef(false);
  const scanStateRef = useRef<NormalizedJobState>('queued');
  useEffect(() => {
    isActiveRef.current = phase === 'scanning';
    scanStateRef.current = phase === 'scanning' ? 'running' : scanStateRef.current;
    fileCountRef.current = files.length;
  }, [phase]);

  useEffect(() => {
    fileCountRef.current = files.length;
  }, [files.length]);

  useEffect(() => {
    const flushThumbnails = () => {
      thumbnailFlushTimerRef.current = null;
      const thumbnails = thumbnailBufferRef.current;
      thumbnailBufferRef.current = {};
      thumbnailBufferCountRef.current = 0;
      if (Object.keys(thumbnails).length > 0) {
        dispatch({ type: 'SET_THUMBNAILS', thumbnails });
      }
    };

    const scheduleThumbnailFlush = () => {
      if (thumbnailFlushTimerRef.current !== null) return;
      thumbnailFlushTimerRef.current = window.setTimeout(flushThumbnails, thumbnailFlushDelay(fileCountRef.current));
    };

    const unsubBatch = window.electronAPI.onScanBatch((files) => {
      dispatch({ type: 'SCAN_BATCH', files });
    });

    const unsubComplete = window.electronAPI.onScanComplete(() => {
      // Discard SCAN_COMPLETE that arrives after the scan was cancelled /
      // superseded. The reducer also guards on phase === 'scanning', so this
      // is belt-and-suspenders — but it avoids a spurious dispatch entirely.
      if (!isActiveRef.current) return;
      scanStateRef.current = 'completed';
      dispatch({ type: 'SCAN_COMPLETE' });
    });

    const unsubThumb = window.electronAPI.onScanThumbnail((filePath, thumbnail) => {
      if (thumbnailBufferRef.current[filePath] === undefined) {
        thumbnailBufferCountRef.current++;
      }
      thumbnailBufferRef.current[filePath] = thumbnail;
      if (thumbnailBufferCountRef.current >= THUMBNAIL_FLUSH_MAX_PENDING) {
        if (thumbnailFlushTimerRef.current !== null) {
          window.clearTimeout(thumbnailFlushTimerRef.current);
          thumbnailFlushTimerRef.current = null;
        }
        flushThumbnails();
        return;
      }
      scheduleThumbnailFlush();
    });

    const unsubDuplicate = window.electronAPI.onScanDuplicate((filePath) => {
      dispatch({ type: 'SET_DUPLICATE', filePath });
    });

    return () => {
      unsubBatch();
      unsubComplete();
      unsubThumb();
      unsubDuplicate();
      if (thumbnailFlushTimerRef.current !== null) {
        window.clearTimeout(thumbnailFlushTimerRef.current);
        thumbnailFlushTimerRef.current = null;
      }
      flushThumbnails();
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
