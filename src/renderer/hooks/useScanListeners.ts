import { useEffect, useRef } from 'react';
import type { MediaFile } from '../../shared/types';
import { useAppState, useAppDispatch } from '../context/ImportContext';
import { flattenSegments, scanCommitTarget, scanIdleFlushDelay, thumbnailCommitTarget, thumbnailIdleFlushDelay } from '../utils/scanBatching';

type NormalizedJobState = 'queued' | 'running' | 'paused' | 'cancelled' | 'completed' | 'failed';
export function useScanListeners() {
  const {
    destination,
    activeScanId,
    files,
    phase,
    separateProtected,
    protectedFolderName,
  } = useAppState();
  const dispatch = useAppDispatch();
  const thumbnailBufferRef = useRef<Record<string, string>>({});
  const thumbnailBufferCountRef = useRef(0);
  const thumbnailBufferScanIdRef = useRef<string | null>(null);
  const thumbnailFlushTimerRef = useRef<number | null>(null);
  const thumbnailCommitCountRef = useRef(0);
  const scanBatchSegmentsRef = useRef<MediaFile[][]>([]);
  const scanBatchFileCountRef = useRef(0);
  const scanBatchScanIdRef = useRef<string | null>(null);
  const scanBatchFlushTimerRef = useRef<number | null>(null);
  const duplicateBufferRef = useRef<Record<string, { duplicate?: boolean; duplicateMemory?: MediaFile['duplicateMemory'] }>>({});
  const duplicateBufferCountRef = useRef(0);
  const duplicateBufferScanIdRef = useRef<string | null>(null);
  const duplicateFlushTimerRef = useRef<number | null>(null);
  const duplicateCommitCountRef = useRef(0);
  const duplicateFlushNowRef = useRef<() => void>(() => undefined);
  const fileCountRef = useRef(0);
  const activeScanIdRef = useRef<string | null>(null);
  const previousPhaseRef = useRef(phase);

  // Track whether we're in an active scan at the listener layer.
  // This ref stays in sync with the phase state and lets the onScanComplete
  // callback discard stale IPC events that arrive after the phase left 'scanning'.
  const isActiveRef = useRef(false);
  const scanStateRef = useRef<NormalizedJobState>('queued');
  useEffect(() => {
    isActiveRef.current = phase === 'scanning';
    scanStateRef.current = phase === 'scanning' ? 'running' : scanStateRef.current;
    fileCountRef.current = files.length;
    activeScanIdRef.current = activeScanId;
    if (phase === 'scanning' && previousPhaseRef.current !== 'scanning') {
      thumbnailBufferRef.current = {};
      thumbnailBufferCountRef.current = 0;
      thumbnailBufferScanIdRef.current = null;
      thumbnailCommitCountRef.current = 0;
      scanBatchSegmentsRef.current = [];
      scanBatchFileCountRef.current = 0;
      scanBatchScanIdRef.current = null;
      duplicateBufferRef.current = {};
      duplicateBufferCountRef.current = 0;
      duplicateBufferScanIdRef.current = null;
      duplicateCommitCountRef.current = 0;
      if (thumbnailFlushTimerRef.current !== null) {
        window.clearTimeout(thumbnailFlushTimerRef.current);
        thumbnailFlushTimerRef.current = null;
      }
    } else if (phase !== 'scanning') {
      if (scanBatchFlushTimerRef.current !== null) window.clearTimeout(scanBatchFlushTimerRef.current);
      scanBatchFlushTimerRef.current = null;
      scanBatchSegmentsRef.current = [];
      scanBatchFileCountRef.current = 0;
      scanBatchScanIdRef.current = null;
    }
    previousPhaseRef.current = phase;
  }, [phase, activeScanId, files.length]);

  useEffect(() => {
    fileCountRef.current = files.length;
  }, [files.length]);

  useEffect(() => {
    const flushScanBatches = () => {
      scanBatchFlushTimerRef.current = null;
      const pendingCount = scanBatchFileCountRef.current;
      if (pendingCount === 0) return;
      const files = flattenSegments(scanBatchSegmentsRef.current, pendingCount);
      const scanId = scanBatchScanIdRef.current ?? undefined;
      scanBatchSegmentsRef.current = [];
      scanBatchFileCountRef.current = 0;
      scanBatchScanIdRef.current = null;
      dispatch({ type: 'SCAN_BATCH', files, scanId });
      fileCountRef.current += files.length;
    };

    const scheduleScanBatchFlush = () => {
      if (scanBatchFlushTimerRef.current !== null) return;
      scanBatchFlushTimerRef.current = window.setTimeout(
        flushScanBatches,
        scanIdleFlushDelay(fileCountRef.current + scanBatchFileCountRef.current),
      );
    };

    const flushThumbnails = () => {
      thumbnailFlushTimerRef.current = null;
      const thumbnails = thumbnailBufferRef.current;
      const scanId = thumbnailBufferScanIdRef.current ?? undefined;
      thumbnailBufferRef.current = {};
      thumbnailBufferCountRef.current = 0;
      thumbnailBufferScanIdRef.current = null;
      if (Object.keys(thumbnails).length > 0) {
        dispatch({ type: 'SET_THUMBNAILS', thumbnails, scanId });
        thumbnailCommitCountRef.current++;
      }
    };

    const flushDuplicates = () => {
      duplicateFlushTimerRef.current = null;
      const duplicates = duplicateBufferRef.current;
      const scanId = duplicateBufferScanIdRef.current ?? undefined;
      duplicateBufferRef.current = {};
      duplicateBufferCountRef.current = 0;
      duplicateBufferScanIdRef.current = null;
      if (Object.keys(duplicates).length > 0) {
        dispatch({ type: 'SET_DUPLICATES', duplicates, scanId });
        duplicateCommitCountRef.current++;
      }
    };
    duplicateFlushNowRef.current = flushDuplicates;

    const scheduleDuplicateFlush = () => {
      if (duplicateFlushTimerRef.current !== null) return;
      const delay = duplicateCommitCountRef.current === 0
        ? 250
        : thumbnailIdleFlushDelay(fileCountRef.current);
      duplicateFlushTimerRef.current = window.setTimeout(flushDuplicates, delay);
    };

    const scheduleThumbnailFlush = () => {
      if (thumbnailFlushTimerRef.current !== null) return;
      const delay = thumbnailCommitCountRef.current === 0
        ? 250
        : thumbnailIdleFlushDelay(fileCountRef.current);
      thumbnailFlushTimerRef.current = window.setTimeout(flushThumbnails, delay);
    };

    const unsubBatch = window.electronAPI.onScanBatch((scanId, files) => {
      if (scanBatchScanIdRef.current && scanBatchScanIdRef.current !== scanId) flushScanBatches();
      scanBatchScanIdRef.current = scanId;
      scanBatchSegmentsRef.current.push(files);
      scanBatchFileCountRef.current += files.length;
      const projectedCount = fileCountRef.current + scanBatchFileCountRef.current;
      if (scanBatchFileCountRef.current >= scanCommitTarget(projectedCount)) {
        if (scanBatchFlushTimerRef.current !== null) {
          window.clearTimeout(scanBatchFlushTimerRef.current);
          scanBatchFlushTimerRef.current = null;
        }
        flushScanBatches();
      } else {
        scheduleScanBatchFlush();
      }
    });

    const unsubComplete = window.electronAPI.onScanComplete((scanId) => {
      // Event ordering must be preserved: commit every staged file before the
      // reducer runs burst grouping and transitions out of scanning.
      flushScanBatches();
      flushThumbnails();
      flushDuplicates();
      scanStateRef.current = 'completed';
      dispatch({ type: 'SCAN_COMPLETE', scanId });
    });

    const unsubThumb = window.electronAPI.onScanThumbnail((scanId, filePath, thumbnail) => {
      if (thumbnailBufferScanIdRef.current && thumbnailBufferScanIdRef.current !== scanId) {
        flushThumbnails();
      }
      thumbnailBufferScanIdRef.current = scanId;
      if (thumbnailBufferRef.current[filePath] === undefined) {
        thumbnailBufferCountRef.current++;
      }
      thumbnailBufferRef.current[filePath] = thumbnail;
      if (thumbnailBufferCountRef.current >= thumbnailCommitTarget(fileCountRef.current)) {
        if (thumbnailFlushTimerRef.current !== null) {
          window.clearTimeout(thumbnailFlushTimerRef.current);
          thumbnailFlushTimerRef.current = null;
        }
        flushThumbnails();
        return;
      }
      scheduleThumbnailFlush();
    });

    const unsubDuplicate = window.electronAPI.onScanDuplicate((scanId, filePath, duplicateMemory, duplicate) => {
      if (duplicateBufferScanIdRef.current && duplicateBufferScanIdRef.current !== scanId) flushDuplicates();
      duplicateBufferScanIdRef.current = scanId;
      if (duplicateBufferRef.current[filePath] === undefined) duplicateBufferCountRef.current++;
      duplicateBufferRef.current[filePath] = { duplicate, duplicateMemory };
      if (duplicateBufferCountRef.current >= thumbnailCommitTarget(fileCountRef.current)) {
        if (duplicateFlushTimerRef.current !== null) {
          window.clearTimeout(duplicateFlushTimerRef.current);
          duplicateFlushTimerRef.current = null;
        }
        flushDuplicates();
      } else {
        scheduleDuplicateFlush();
      }
    });

    const unsubDiagnostics = window.electronAPI.onScanDiagnostics((scanId, diagnostics) => {
      dispatch({ type: 'SCAN_DIAGNOSTICS', scanId, diagnostics });
    });

    return () => {
      unsubBatch();
      unsubComplete();
      unsubThumb();
      unsubDuplicate();
      unsubDiagnostics();
      if (thumbnailFlushTimerRef.current !== null) {
        window.clearTimeout(thumbnailFlushTimerRef.current);
        thumbnailFlushTimerRef.current = null;
      }
      if (scanBatchFlushTimerRef.current !== null) {
        window.clearTimeout(scanBatchFlushTimerRef.current);
        scanBatchFlushTimerRef.current = null;
      }
      if (duplicateFlushTimerRef.current !== null) {
        window.clearTimeout(duplicateFlushTimerRef.current);
        duplicateFlushTimerRef.current = null;
      }
      flushScanBatches();
      flushThumbnails();
      flushDuplicates();
      duplicateFlushNowRef.current = () => undefined;
    };
  }, [dispatch]);

  useEffect(() => {
    if (!destination || files.length === 0 || phase !== 'ready') return;
    // Re-run when the protected-subfolder settings change too — otherwise
    // toggling "separate protected" after a scan leaves duplicates pointing
    // at the wrong path and protected files stay stuck as "ready to import"
    // even when they've already been imported into _Protected/.
    duplicateFlushNowRef.current();
    duplicateCommitCountRef.current = 0;
    dispatch({ type: 'CLEAR_DUPLICATES' });
    window.electronAPI.checkDuplicates(destination, activeScanId ?? undefined);
  }, [destination, files.length, phase, separateProtected, protectedFolderName, activeScanId, dispatch]);
}
