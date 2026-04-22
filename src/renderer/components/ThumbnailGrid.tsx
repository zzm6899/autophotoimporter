import { useMemo, useEffect, useCallback, useRef, useState } from 'react';
// Main grid / single / split view orchestrator.
import { useAppState, useAppDispatch } from '../context/ImportContext';
import { useFileScanner } from '../hooks/useFileScanner';
import { useImport } from '../hooks/useImport';
import { ThumbnailCard } from './ThumbnailCard';
import { SingleView } from './SingleView';
import { CompareView } from './CompareView';
import { EmptyState } from './EmptyState';
import { SettingsPage } from './SettingsPage';
import { ShortcutsOverlay } from './ShortcutsOverlay';
import { BestOfSelectionPanel, rankBestOfSelection } from './BestOfSelectionPanel';
import { warmPreview } from '../utils/previewCache';

async function scoreSharpness(src: string): Promise<number> {
  const img = new Image();
  img.decoding = 'async';
  const loaded = new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('image load failed'));
  });
  img.src = src;
  await loaded;
  const canvas = document.createElement('canvas');
  const size = 96;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 0;
  ctx.drawImage(img, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  const gray = (idx: number) => data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const i = (y * size + x) * 4;
      const lap = Math.abs(
        gray(i - size * 4) + gray(i + size * 4) + gray(i - 4) + gray(i + 4) - 4 * gray(i),
      );
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }
  const mean = sum / Math.max(1, count);
  return Math.round(Math.max(0, sumSq / Math.max(1, count) - mean * mean));
}

async function visualHash(src: string): Promise<string> {
  const img = new Image();
  img.decoding = 'async';
  const loaded = new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('image load failed'));
  });
  img.src = src;
  await loaded;
  const canvas = document.createElement('canvas');
  const size = 8;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return '0000000000000000';
  ctx.drawImage(img, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;
  const luma: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    luma.push(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
  }
  const sorted = luma.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  let bits = '';
  for (const v of luma) bits += v >= median ? '1' : '0';
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex.padStart(16, '0');
}

export function ThumbnailGrid() {
  const { files, phase, selectedSource, scanError, focusedIndex, viewMode, showLeftPanel, showRightPanel, filter, cullMode, collapsedBursts, exposureAnchorPath, saveFormat, burstGrouping, normalizeExposure, queuedPaths, selectionSets, scanPaused } = useAppState();
  const { startScan, pauseScan, resumeScan } = useFileScanner();
  const { startImport } = useImport();
  const dispatch = useAppDispatch();
  const gridRef = useRef<HTMLDivElement>(null);
  const splitGridRef = useRef<HTMLDivElement>(null);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [searchText, setSearchText] = useState('');
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showBestOfSelection, setShowBestOfSelection] = useState(false);
  const lastClickedRef = useRef<number>(-1);
  const sharpnessInFlightRef = useRef(false);
  const collapsedSet = useMemo(() => new Set(collapsedBursts), [collapsedBursts]);
  const queuedSet = useMemo(() => new Set(queuedPaths), [queuedPaths]);

  // Sort order (top → bottom):
  //   1. Protected / in-camera-locked / read-only files (fast-import priority)
  //   2. Highest rating first (5★ before 1★)
  //   3. Not-duplicates before duplicates
  //   4. Stable by dateTaken (oldest first) so bursts stay grouped
  const sortedFiles = useMemo(() => {
    if (files.length === 0) return [];
    const query = searchText.trim().toLowerCase();
    const filtered = files.filter((f) => {
      if (query) {
        const haystack = [
          f.name, f.path, f.extension, f.cameraMake, f.cameraModel, f.lensModel,
          f.dateTaken?.slice(0, 10),
        ].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      if (filter.startsWith('camera:')) return (f.cameraModel || 'Unknown camera') === decodeURIComponent(filter.slice(7));
      if (filter.startsWith('lens:')) return (f.lensModel || 'Unknown lens') === decodeURIComponent(filter.slice(5));
      if (filter.startsWith('date:')) return (f.dateTaken ? f.dateTaken.slice(0, 10) : 'Undated') === decodeURIComponent(filter.slice(5));
      if (filter.startsWith('ext:')) return f.extension.toLowerCase() === decodeURIComponent(filter.slice(4));
      switch (filter) {
        case 'protected': return f.isProtected;
        case 'picked': return f.pick === 'selected';
        case 'rejected': return f.pick === 'rejected';
        case 'unrated': return !f.rating || f.rating === 0;
        case 'duplicates': return f.duplicate;
        case 'queue': return queuedSet.has(f.path);
        case 'unmarked': return !f.pick;
        case 'best': return (f.reviewScore ?? 0) >= 70;
        case 'blur-risk': return f.blurRisk === 'high' || f.blurRisk === 'medium';
        case 'near-duplicates': return !!f.visualGroupId;
        case 'review-needed': return !f.reviewScore || f.blurRisk === 'high' || !!f.visualGroupId || !f.pick;
        case 'needs-exposure': return typeof f.exposureValue === 'number' && !!exposureAnchorPath && !f.normalizeToAnchor;
        case 'normalized': return !!f.normalizeToAnchor;
        case 'adjusted': return typeof f.exposureAdjustmentStops === 'number' && Math.abs(f.exposureAdjustmentStops) >= 0.01;
        case 'photos': return f.type === 'photo';
        case 'videos': return f.type === 'video';
        case 'raw': return !['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.avif'].includes(f.extension.toLowerCase()) && f.type === 'photo';
        case 'rating-1':
        case 'rating-2':
        case 'rating-3':
        case 'rating-4':
        case 'rating-5':
          return (f.rating ?? 0) >= Number(filter.slice(-1));
        case 'all':
        default: return true;
      }
    });
    const sorted = [...filtered].sort((a, b) => {
      const pa = a.isProtected ? 1 : 0;
      const pb = b.isProtected ? 1 : 0;
      if (pa !== pb) return pb - pa;
      const ra = a.rating ?? 0;
      const rb = b.rating ?? 0;
      if (ra !== rb) return rb - ra;
      const da = a.duplicate ? 1 : 0;
      const db = b.duplicate ? 1 : 0;
      if (da !== db) return da - db;
      const ta = a.dateTaken ? Date.parse(a.dateTaken) : 0;
      const tb = b.dateTaken ? Date.parse(b.dateTaken) : 0;
      if (ta !== tb) return ta - tb;
      // Within the same second, bursts go by their index so shots stay in order.
      return (a.burstIndex ?? 0) - (b.burstIndex ?? 0);
    });
    // Apply collapse: when a burst is collapsed we only show its "leader"
    // (highest-rated shot, or the first by burstIndex). The leader surfaces
    // the total count so the user can expand it.
    if (collapsedSet.size === 0) return sorted;
    const seenCollapsedLeader = new Set<string>();
    return sorted.filter((f) => {
      if (!f.burstId || !collapsedSet.has(f.burstId)) return true;
      if (seenCollapsedLeader.has(f.burstId)) return false;
      seenCollapsedLeader.add(f.burstId);
      return true;
    });
  }, [files, filter, collapsedSet, exposureAnchorPath, searchText, queuedSet]);

  const metadataFilters = useMemo(() => {
    const cameras = new Set<string>();
    const lenses = new Set<string>();
    const dates = new Set<string>();
    const exts = new Set<string>();
    for (const f of files) {
      cameras.add(f.cameraModel || 'Unknown camera');
      if (f.type === 'photo') lenses.add(f.lensModel || 'Unknown lens');
      dates.add(f.dateTaken ? f.dateTaken.slice(0, 10) : 'Undated');
      exts.add(f.extension.toLowerCase());
    }
    return {
      cameras: [...cameras].sort(),
      lenses: [...lenses].sort(),
      dates: [...dates].sort().reverse(),
      exts: [...exts].sort(),
    };
  }, [files]);

  // Clear selection when source changes or view mode changes to single
  useEffect(() => {
    setSelectedIndices(new Set());
  }, [selectedSource, viewMode === 'single']);

  // Mirror the grid's click-selection into the store so other components
  // (DestinationPanel's "Import X Files" button, useImport) can respect
  // it. Without this, clicking 40 of 10k photos has no effect on import.
  useEffect(() => {
    const paths = Array.from(selectedIndices)
      .filter((i) => i >= 0 && i < sortedFiles.length)
      .map((i) => sortedFiles[i].path);
    dispatch({ type: 'SET_SELECTED_PATHS', paths });
  }, [selectedIndices, sortedFiles, dispatch]);

  useEffect(() => {
    if (sharpnessInFlightRef.current) return;
    if (viewMode === 'single' || viewMode === 'split') return;
    // Keep batch small so scoring doesn't freeze the UI on slow machines.
    const candidates = files
      .filter((f) => f.type === 'photo' && f.thumbnail && (typeof f.sharpnessScore !== 'number' || !f.visualHash))
      .slice(0, 4);
    if (candidates.length === 0) return;
    sharpnessInFlightRef.current = true;
    const run = () => void Promise.all(candidates.map(async (f) => {
      const thumbnail = f.thumbnail as string;
      const [sharpnessScore, hash] = await Promise.all([
        typeof f.sharpnessScore === 'number' ? Promise.resolve(f.sharpnessScore) : scoreSharpness(thumbnail),
        f.visualHash ? Promise.resolve(f.visualHash) : visualHash(thumbnail),
      ]);
      return [f.path, { sharpnessScore, visualHash: hash }] as const;
    }))
      .then((entries) => {
        dispatch({ type: 'SET_REVIEW_SCORES', scores: Object.fromEntries(entries) });
        dispatch({ type: 'GROUP_VISUAL_DUPLICATES', threshold: 8 });
      })
      .catch(() => undefined)
      .finally(() => {
        sharpnessInFlightRef.current = false;
      });
    const hasIdle = typeof window.requestIdleCallback === 'function';
    const idle: number = hasIdle
      ? window.requestIdleCallback(run, { timeout: 1200 })
      : window.setTimeout(run, 250);
    return () => {
      if (hasIdle) {
        window.cancelIdleCallback(idle);
      } else {
        clearTimeout(idle as number);
      }
      sharpnessInFlightRef.current = false;
    };
  }, [files, dispatch, viewMode]);

  const getColumnsCount = useCallback(() => {
    const grid = gridRef.current;
    if (!grid) return 1;
    return getComputedStyle(grid).gridTemplateColumns.split(' ').length;
  }, []);

  const setFocused = useCallback((index: number) => {
    dispatch({ type: 'SET_FOCUSED', index });
  }, [dispatch]);

  const cyclePick = useCallback((index: number) => {
    if (index < 0 || index >= sortedFiles.length) return;
    const file = sortedFiles[index];
    const next = file.pick === undefined ? 'selected'
      : file.pick === 'selected' ? 'rejected'
      : undefined;
    dispatch({ type: 'SET_PICK', filePath: file.path, pick: next });
  }, [sortedFiles, dispatch]);

  const pickFile = useCallback((pick: 'selected' | 'rejected' | undefined, advance: boolean) => {
    // Batch mode: apply to all selected files
    if (selectedIndices.size > 0) {
      const paths = Array.from(selectedIndices)
        .filter((i) => i >= 0 && i < sortedFiles.length)
        .map((i) => sortedFiles[i].path);
      dispatch({ type: 'SET_PICK_BATCH', filePaths: paths, pick });
      return;
    }
    // Single mode
    if (focusedIndex < 0 || focusedIndex >= sortedFiles.length) return;
    const file = sortedFiles[focusedIndex];
    const newPick = file.pick === pick ? undefined : pick;
    dispatch({ type: 'SET_PICK', filePath: file.path, pick: newPick });
    if (advance && newPick !== undefined && focusedIndex < sortedFiles.length - 1) {
      setFocused(focusedIndex + 1);
    }
  }, [focusedIndex, sortedFiles, dispatch, setFocused, selectedIndices]);

  const handleCardClick = useCallback((index: number, e: React.MouseEvent) => {
    const metaKey = e.metaKey || e.ctrlKey;

    if (e.shiftKey && lastClickedRef.current >= 0) {
      // Shift+Click: range select
      const start = Math.min(lastClickedRef.current, index);
      const end = Math.max(lastClickedRef.current, index);
      const next = new Set(metaKey ? selectedIndices : new Set<number>());
      for (let i = start; i <= end; i++) next.add(i);
      setSelectedIndices(next);
      setFocused(index);
    } else if (metaKey) {
      // Cmd/Ctrl+Click: toggle individual
      const next = new Set(selectedIndices);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      setSelectedIndices(next);
      setFocused(index);
      lastClickedRef.current = index;
    } else {
      // Plain click: clear selection, focus
      setSelectedIndices(new Set());
      setFocused(index);
      lastClickedRef.current = index;
    }
  }, [selectedIndices, setFocused]);

  const openBestOfSelection = useCallback(() => {
    if (selectedIndices.size < 2 && sortedFiles.length > 0) {
      const start = Math.max(0, focusedIndex);
      const windowFiles = sortedFiles.slice(start, Math.min(sortedFiles.length, start + 8));
      setSelectedIndices(new Set(windowFiles.map((_, offset) => start + offset)));
    }
    setShowBestOfSelection(true);
  }, [focusedIndex, selectedIndices.size, sortedFiles]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        dispatch({ type: 'UNDO_FILE_EDIT' });
        return;
      }
      if (sortedFiles.length === 0) return;

      const cols = viewMode === 'single' || viewMode === 'split' || viewMode === 'compare' ? 1 : getColumnsCount();

      // Cmd/Ctrl+A: select all
      if ((e.metaKey || e.ctrlKey) && e.key === 'a' && viewMode !== 'single') {
        e.preventDefault();
        const all = new Set<number>();
        for (let i = 0; i < sortedFiles.length; i++) all.add(i);
        setSelectedIndices(all);
        return;
      }

      switch (e.key) {
        case 'ArrowRight':
          e.preventDefault();
          setSelectedIndices(new Set());
          setFocused(Math.min(focusedIndex + 1, sortedFiles.length - 1));
          break;
        case 'ArrowLeft':
          e.preventDefault();
          setSelectedIndices(new Set());
          setFocused(Math.max(focusedIndex - 1, 0));
          break;
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndices(new Set());
          if (viewMode === 'single' || viewMode === 'split') {
            setFocused(Math.min(focusedIndex + 1, sortedFiles.length - 1));
          } else {
            setFocused(Math.min(focusedIndex + cols, sortedFiles.length - 1));
          }
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndices(new Set());
          if (viewMode === 'single' || viewMode === 'split') {
            setFocused(Math.max(focusedIndex - 1, 0));
          } else {
            setFocused(Math.max(focusedIndex - cols, 0));
          }
          break;
        case 'p':
        case 'P':
          e.preventDefault();
          if (e.shiftKey && focusedIndex >= 0 && lastClickedRef.current >= 0) {
            const start = Math.min(focusedIndex, lastClickedRef.current);
            const end = Math.max(focusedIndex, lastClickedRef.current);
            const paths = sortedFiles.slice(start, end + 1).map((f) => f.path);
            dispatch({ type: 'SET_PICK_BATCH', filePaths: paths, pick: 'selected' });
            setSelectedIndices(new Set(paths.map((_, offset) => start + offset)));
            break;
          }
          pickFile('selected', true);
          break;
        case 'x':
        case 'X':
          e.preventDefault();
          if (e.shiftKey && focusedIndex >= 0 && lastClickedRef.current >= 0) {
            const start = Math.min(focusedIndex, lastClickedRef.current);
            const end = Math.max(focusedIndex, lastClickedRef.current);
            const paths = sortedFiles.slice(start, end + 1).map((f) => f.path);
            dispatch({ type: 'SET_PICK_BATCH', filePaths: paths, pick: 'rejected' });
            setSelectedIndices(new Set(paths.map((_, offset) => start + offset)));
            break;
          }
          pickFile('rejected', true);
          break;
        case 'u':
        case 'U':
          e.preventDefault();
          pickFile(undefined, false);
          break;
        case '0':
        case '1':
        case '2':
        case '3':
        case '4':
        case '5': {
          e.preventDefault();
          const rating = parseInt(e.key, 10);
          if (selectedIndices.size > 0) {
            Array.from(selectedIndices).forEach((i) => {
              if (i >= 0 && i < sortedFiles.length) {
                dispatch({ type: 'SET_RATING', filePath: sortedFiles[i].path, rating });
              }
            });
          } else if (focusedIndex >= 0 && focusedIndex < sortedFiles.length) {
            dispatch({ type: 'SET_RATING', filePath: sortedFiles[focusedIndex].path, rating });
            if (cullMode && focusedIndex < sortedFiles.length - 1) {
              setFocused(focusedIndex + 1);
            }
          }
          break;
        }
        case 'c':
        case 'C':
          if (!(e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            dispatch({ type: 'TOGGLE_CULL_MODE' });
          }
          break;
        case 'b':
        case 'B': {
          if (e.shiftKey) {
            e.preventDefault();
            openBestOfSelection();
            break;
          }
          // Select every shot in the focused file's burst. Great for batch
          // picking or rejecting a whole burst with Shift+P / Shift+X.
          if (e.metaKey || e.ctrlKey) break;
          e.preventDefault();
          if (focusedIndex < 0 || focusedIndex >= sortedFiles.length) break;
          const focused = sortedFiles[focusedIndex];
          if (!focused.burstId) break;
          const next = new Set<number>();
          sortedFiles.forEach((f, i) => {
            if (f.burstId === focused.burstId) next.add(i);
          });
          setSelectedIndices(next);
          break;
        }
        case 'g':
        case 'G': {
          // Toggle burst collapse on the focused file's burst.
          if (e.metaKey || e.ctrlKey) break;
          e.preventDefault();
          if (focusedIndex < 0 || focusedIndex >= sortedFiles.length) break;
          const focused = sortedFiles[focusedIndex];
          if (!focused.burstId) break;
          dispatch({ type: 'TOGGLE_BURST_COLLAPSE', burstId: focused.burstId });
          break;
        }
        case 'a':
        case 'A': {
          if (e.metaKey || e.ctrlKey) break;
          e.preventDefault();
          const targets = selectedIndices.size > 0
            ? Array.from(selectedIndices)
                .filter((i) => i >= 0 && i < sortedFiles.length)
                .map((i) => sortedFiles[i].path)
            : focusedIndex >= 0 && focusedIndex < sortedFiles.length
              ? [sortedFiles[focusedIndex].path]
              : [];
          if (targets.length === 0) break;
          if (focusedIndex >= 0 && focusedIndex < sortedFiles.length) {
            dispatch({ type: 'NORMALIZE_SELECTION_TO_FOCUSED', filePaths: targets, anchorPath: sortedFiles[focusedIndex].path });
          }
          break;
        }
        case '[':
        case ']':
          e.preventDefault();
          {
            const targets = selectedIndices.size > 0
              ? Array.from(selectedIndices).filter((i) => i >= 0 && i < sortedFiles.length).map((i) => sortedFiles[i].path)
              : focusedIndex >= 0 && focusedIndex < sortedFiles.length ? [sortedFiles[focusedIndex].path] : [];
            dispatch({ type: 'NUDGE_EXPOSURE_ADJUSTMENT', filePaths: targets, delta: e.key === '[' ? -0.33 : 0.33 });
          }
          break;
        case '\\':
          e.preventDefault();
          {
            const targets = selectedIndices.size > 0
              ? Array.from(selectedIndices).filter((i) => i >= 0 && i < sortedFiles.length).map((i) => sortedFiles[i].path)
              : focusedIndex >= 0 && focusedIndex < sortedFiles.length ? [sortedFiles[focusedIndex].path] : [];
            dispatch({ type: 'SET_EXPOSURE_ADJUSTMENT', filePaths: targets, stops: 0 });
          }
          break;
        case 'Escape':
          if (selectedIndices.size > 0) {
            e.preventDefault();
            setSelectedIndices(new Set());
          } else if (viewMode === 'settings') {
            e.preventDefault();
            dispatch({ type: 'SET_VIEW_MODE', mode: 'grid' });
          } else if (viewMode === 'single' || viewMode === 'split' || viewMode === 'compare') {
            e.preventDefault();
            dispatch({ type: 'SET_VIEW_MODE', mode: 'grid' });
          }
          break;
        case '?':
          e.preventDefault();
          setShowShortcuts(true);
          break;
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [focusedIndex, sortedFiles, viewMode, getColumnsCount, setFocused, pickFile, dispatch, selectedIndices, cullMode, files, openBestOfSelection]);

  useEffect(() => {
    if (focusedIndex < 0) return;
    if (viewMode === 'grid' && gridRef.current) {
      const card = gridRef.current.children[focusedIndex] as HTMLElement | undefined;
      card?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    } else if (viewMode === 'split' && splitGridRef.current) {
      const card = splitGridRef.current.children[focusedIndex] as HTMLElement | undefined;
      card?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }
  }, [focusedIndex, viewMode]);

  // Preload adjacent photos so SingleView navigation feels instant.
  // Fire-and-forget: generatePreview deduplicates in-flight requests.
  // Uses setTimeout to defer requests so they don't block the current render.
  useEffect(() => {
    if (viewMode !== 'single' && viewMode !== 'split') return;
    if (focusedIndex < 0 || sortedFiles.length === 0) return;
    const neighbors = [
      focusedIndex + 1, focusedIndex + 2, focusedIndex + 3, focusedIndex + 4,
      focusedIndex - 1, focusedIndex - 2,
    ];
    const id = setTimeout(() => {
      for (const i of neighbors) {
        if (i >= 0 && i < sortedFiles.length) {
          warmPreview(sortedFiles[i].path, i === focusedIndex + 1 ? 'normal' : 'low');
        }
      }
    }, 40);
    return () => clearTimeout(id);
  }, [focusedIndex, viewMode, sortedFiles]);

  // Expose-normalize button state (computed before early returns so the
  // handleNormalizeToggle useCallback is always called unconditionally).
  const focusedFile = focusedIndex >= 0 && focusedIndex < sortedFiles.length ? sortedFiles[focusedIndex] : null;
  const hasBatchSelection = selectedIndices.size > 0;
  const anchorFile = exposureAnchorPath ? files.find((f) => f.path === exposureAnchorPath) : null;
  const anchorHasEV = typeof anchorFile?.exposureValue === 'number';
  const canNormalize = anchorHasEV && saveFormat !== 'original';
  const normalizeTargetPaths = hasBatchSelection
    ? Array.from(selectedIndices).filter((i) => i >= 0 && i < sortedFiles.length).map((i) => sortedFiles[i].path)
    : focusedFile ? [focusedFile.path] : [];
  const compareFiles = (hasBatchSelection
    ? Array.from(selectedIndices).filter((i) => i >= 0 && i < sortedFiles.length).map((i) => sortedFiles[i])
    : focusedFile ? [focusedFile] : []
  ).slice(0, 4);
  const selectedFiles = useMemo(() => (
    hasBatchSelection
      ? Array.from(selectedIndices)
          .filter((i) => i >= 0 && i < sortedFiles.length)
          .map((i) => sortedFiles[i])
      : focusedFile ? [focusedFile] : []
  ), [focusedFile, hasBatchSelection, selectedIndices, sortedFiles]);
  const bestOfSelection = selectedFiles.length > 0 ? rankBestOfSelection(selectedFiles)[0] : null;
  const allTargetsNormalized = normalizeTargetPaths.length > 0 &&
    normalizeTargetPaths.every((p) => files.find((f) => f.path === p)?.normalizeToAnchor);
  const duplicateCount = files.filter((f) => f.duplicate).length;
  const avgManualStops = normalizeTargetPaths.length > 0
    ? normalizeTargetPaths.reduce((sum, p) => sum + (files.find((f) => f.path === p)?.exposureAdjustmentStops ?? 0), 0) / normalizeTargetPaths.length
    : 0;

  // Burst collapse/expand state (useMemo must be before early returns to
  // satisfy the Rules of Hooks).
  const burstIds = useMemo(() => {
    const ids = new Set<string>();
    for (const f of files) if (f.burstId && f.burstSize && f.burstSize > 1) ids.add(f.burstId);
    return ids;
  }, [files]);

  const handleNormalizeToggle = useCallback(() => {
    if (normalizeTargetPaths.length === 0) return;
    if (focusedFile && hasBatchSelection) {
      dispatch({ type: 'NORMALIZE_SELECTION_TO_FOCUSED', filePaths: normalizeTargetPaths, anchorPath: focusedFile.path });
    } else {
      dispatch({ type: 'SET_NORMALIZE_TO_ANCHOR', filePaths: normalizeTargetPaths, value: !allTargetsNormalized });
    }
  }, [dispatch, normalizeTargetPaths, allTargetsNormalized, focusedFile, hasBatchSelection]);

  // "Match" picks the median-exposure shot in the selection as the anchor and
  // flags the rest for normalization. Median (not mean) because the goal is
  // the smallest total adjustment — picking either extreme would force every
  // other shot to move farther. Needs 2+ files with EV to be meaningful.
  const handleMatchToMedian = useCallback(() => {
    if (normalizeTargetPaths.length < 2) return;
    dispatch({ type: 'NORMALIZE_SELECTION_TO_MEDIAN', filePaths: normalizeTargetPaths });
  }, [dispatch, normalizeTargetPaths]);

  const queuePaths = useCallback((paths: string[]) => {
    dispatch({ type: 'QUEUE_ADD_PATHS', paths });
  }, [dispatch]);


  const saveSelectionSet = useCallback(() => {
    const paths = normalizeTargetPaths;
    if (paths.length === 0) return;
    const name = window.prompt('Selection set name');
    if (!name?.trim()) return;
    const next = [
      ...selectionSets.filter((s) => s.name !== name.trim()),
      { name: name.trim(), paths, createdAt: new Date().toISOString() },
    ];
    dispatch({ type: 'SET_SELECTION_SETS', sets: next });
    void window.electronAPI.setSettings({ selectionSets: next });
  }, [dispatch, normalizeTargetPaths, selectionSets]);

  const applySelectionSet = useCallback((name: string) => {
    const set = selectionSets.find((s) => s.name === name);
    if (!set) return;
    const pathSet = new Set(set.paths);
    const next = new Set<number>();
    sortedFiles.forEach((f, i) => {
      if (pathSet.has(f.path)) next.add(i);
    });
    setSelectedIndices(next);
    dispatch({ type: 'SELECTION_SET_APPLY', name });
  }, [dispatch, selectionSets, sortedFiles]);

  const deleteSelectionSet = useCallback((name: string) => {
    const next = selectionSets.filter((s) => s.name !== name);
    dispatch({ type: 'SET_SELECTION_SETS', sets: next });
    void window.electronAPI.setSettings({ selectionSets: next });
  }, [dispatch, selectionSets]);

  // Batch EV stats — spread across the current selection, used to decide
  // whether normalization would actually help. Under ~1/3 stop is already
  // within one-bin quantization for most renderers so we color-code the
  // chip to hint at "this batch is fine" vs "this batch will benefit".
  const batchEVStats = useMemo(() => {
    if (normalizeTargetPaths.length < 2) return null;
    const targetSet = new Set(normalizeTargetPaths);
    const evs: number[] = [];
    for (const f of files) {
      if (targetSet.has(f.path) && typeof f.exposureValue === 'number') {
        evs.push(f.exposureValue);
      }
    }
    if (evs.length < 2) return null;
    let min = evs[0];
    let max = evs[0];
    for (const v of evs) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return { count: evs.length, min, max, range: max - min };
  }, [files, normalizeTargetPaths]);

  if (!selectedSource) {
    return <EmptyState />;
  }

  if (phase === 'scanning' && files.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3">
        <div className={`w-8 h-8 border-2 border-text-muted border-t-text rounded-full ${scanPaused ? '' : 'animate-spin'}`} />
        <p className="text-sm text-text-secondary">{scanPaused ? 'Scan paused' : 'Scanning files...'}</p>
        <button
          onClick={() => scanPaused ? resumeScan() : pauseScan()}
          className="px-3 py-1 text-xs bg-surface-raised hover:bg-border rounded text-text-secondary transition-colors"
        >
          {scanPaused ? 'Resume Scan' : 'Pause Scan'}
        </button>
      </div>
    );
  }

  if (files.length === 0 && phase !== 'scanning') {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2">
        {scanError ? (
          <p className="text-sm text-red-400">{scanError}</p>
        ) : (
          <>
            <p className="text-sm text-text-secondary">No supported files found</p>
            <p className="text-xs text-text-muted">Supports JPG, RAW, HEIC, MOV, MP4</p>
          </>
        )}
        <button
          onClick={() => startScan()}
          className="mt-2 px-3 py-1 text-xs bg-surface-raised hover:bg-border rounded text-text-secondary transition-colors"
        >
          Rescan
        </button>
      </div>
    );
  }

  const thumbCount = files.filter((f) => f.thumbnail).length;
  const thumbsLoading = phase === 'scanning' && files.length > 0 && thumbCount < files.length;
  const isSingle = (viewMode === 'single' || viewMode === 'split') && focusedFile;
  const allBurstsCollapsed = burstIds.size > 0 && burstIds.size === collapsedBursts.length;

  const floatingToolbar = (focusedFile || hasBatchSelection) ? (
    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-px bg-surface-alt/95 backdrop-blur-sm border border-border rounded-lg shadow-lg overflow-hidden z-20">
      {!hasBatchSelection && (
        <>
          <button
            onClick={() => setFocused(Math.max(focusedIndex - 1, 0))}
            disabled={focusedIndex <= 0}
            className="px-2 py-1.5 text-text-secondary hover:text-text hover:bg-surface-raised transition-colors disabled:opacity-25"
            title="Previous"
          >
            <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M12.79 5.23a.75.75 0 01-.02 1.06L8.832 10l3.938 3.71a.75.75 0 11-1.04 1.08l-4.5-4.25a.75.75 0 010-1.08l4.5-4.25a.75.75 0 011.06.02z" clipRule="evenodd" />
            </svg>
          </button>
          <div className="w-px h-4 bg-border" />
        </>
      )}
      {hasBatchSelection && (
        <>
          <span className="px-2.5 py-1.5 text-[11px] text-blue-400 font-medium">{selectedIndices.size}</span>
          <div className="w-px h-4 bg-border" />
        </>
      )}
      <button
        onClick={() => pickFile('selected', false)}
        className={`px-3 py-1.5 text-[11px] transition-colors ${
          !hasBatchSelection && focusedFile?.pick === 'selected'
            ? 'bg-yellow-400/20 text-yellow-400'
            : 'text-text-secondary hover:text-text hover:bg-surface-raised'
        }`}
        title="Select (P)"
      >
        Select
      </button>
      <div className="w-px h-4 bg-border" />
      <button
        onClick={() => pickFile('rejected', false)}
        className={`px-3 py-1.5 text-[11px] transition-colors ${
          !hasBatchSelection && focusedFile?.pick === 'rejected'
            ? 'bg-red-500/20 text-red-400'
            : 'text-text-secondary hover:text-text hover:bg-surface-raised'
        }`}
        title="Reject (X)"
      >
        Reject
      </button>
      <div className="w-px h-4 bg-border" />
      <button
        onClick={() => pickFile(undefined, false)}
        className={`px-3 py-1.5 text-[11px] transition-colors ${
          !hasBatchSelection && focusedFile?.pick === undefined
            ? 'text-text-muted'
            : 'text-text-secondary hover:text-text hover:bg-surface-raised'
        }`}
        title="Clear (U)"
      >
        Clear
      </button>
      {canNormalize && normalizeTargetPaths.length > 0 && (
        <>
          <div className="w-px h-4 bg-border" />
          <button
            onClick={handleNormalizeToggle}
            className={`px-3 py-1.5 text-[11px] transition-colors ${
              allTargetsNormalized
                ? 'bg-orange-500/20 text-orange-400 hover:bg-orange-500/30'
                : 'text-text-secondary hover:text-orange-400 hover:bg-orange-500/10'
            }`}
            title={allTargetsNormalized
              ? 'Remove exposure normalization from these files'
              : `Normalize exposure to anchor (${anchorFile?.name}) on import`}
          >
            {allTargetsNormalized ? '⊖ Anchor' : '⊕ Anchor'}
          </button>
        </>
      )}
      {!canNormalize && normalizeTargetPaths.length > 0 && anchorHasEV && saveFormat === 'original' && (
        <>
          <div className="w-px h-4 bg-border" />
          <button
            disabled
            className="px-3 py-1.5 text-[11px] text-text-faint opacity-40 cursor-not-allowed"
            title="Exposure normalization requires a non-original save format (JPEG / TIFF / HEIC)"
          >
            ⊕ Anchor
          </button>
        </>
      )}
      {normalizeTargetPaths.length > 0 && saveFormat !== 'original' && (
        <>
          <div className="w-px h-4 bg-border" />
          <button
            onClick={() => dispatch({ type: 'NUDGE_EXPOSURE_ADJUSTMENT', filePaths: normalizeTargetPaths, delta: -0.33 })}
            className="px-2 py-1.5 text-[11px] text-text-secondary hover:text-sky-300 hover:bg-sky-500/10 transition-colors"
            title="Darken selection by 0.33 EV ([)"
          >
            -
          </button>
          <span className="px-2 py-1.5 text-[10px] font-mono text-sky-300" title="Average manual exposure offset">
            {avgManualStops >= 0 ? '+' : ''}{avgManualStops.toFixed(2)}
          </span>
          <button
            onClick={() => dispatch({ type: 'NUDGE_EXPOSURE_ADJUSTMENT', filePaths: normalizeTargetPaths, delta: 0.33 })}
            className="px-2 py-1.5 text-[11px] text-text-secondary hover:text-sky-300 hover:bg-sky-500/10 transition-colors"
            title="Brighten selection by 0.33 EV (])"
          >
            +
          </button>
          <button
            onClick={() => dispatch({ type: 'SET_EXPOSURE_ADJUSTMENT', filePaths: normalizeTargetPaths, stops: 0 })}
            className="px-2 py-1.5 text-[11px] text-text-muted hover:text-text hover:bg-surface-raised transition-colors"
            title="Reset manual exposure offset (\\)"
          >
            0
          </button>
        </>
      )}
      {hasBatchSelection && saveFormat !== 'original' && batchEVStats && (
        <>
          <div className="w-px h-4 bg-border" />
          <span
            className={`px-2 py-1.5 text-[10px] font-mono ${
              batchEVStats.range < 0.34
                ? 'text-emerald-400'
                : batchEVStats.range < 1
                  ? 'text-yellow-400'
                  : 'text-red-400'
            }`}
            title={`${batchEVStats.count} files with EV · spread ${batchEVStats.range.toFixed(2)} stops (EV ${batchEVStats.min.toFixed(2)} → ${batchEVStats.max.toFixed(2)})`}
          >
            Δ{batchEVStats.range.toFixed(1)}
          </span>
          {normalizeTargetPaths.length >= 2 && (
            <button
              onClick={handleMatchToMedian}
              className="px-3 py-1.5 text-[11px] text-text-secondary hover:text-orange-400 hover:bg-orange-500/10 transition-colors"
              title="Pick the median-exposure shot as the anchor and flag the rest for normalization"
            >
              Match
            </button>
          )}
        </>
      )}
      {hasBatchSelection && batchEVStats && normalizeTargetPaths.length >= 2 && saveFormat === 'original' && (
        <>
          <div className="w-px h-4 bg-border" />
          <button
            disabled
            className="px-3 py-1.5 text-[11px] text-text-faint opacity-40 cursor-not-allowed"
            title="Auto-normalize batch requires a non-original save format (JPEG / TIFF / HEIC)"
          >
            Auto-norm
          </button>
        </>
      )}
      {!hasBatchSelection && (
        <>
          <div className="w-px h-4 bg-border" />
          <button
            onClick={() => setFocused(Math.min(focusedIndex + 1, sortedFiles.length - 1))}
            disabled={focusedIndex >= sortedFiles.length - 1}
            className="px-2 py-1.5 text-text-secondary hover:text-text hover:bg-surface-raised transition-colors disabled:opacity-25"
            title="Next"
          >
            <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
            </svg>
          </button>
        </>
      )}
    </div>
  ) : null;

  const nextActionToolbar = files.length > 0 ? (
    <div className="shrink-0 px-3 py-1.5 flex items-center gap-1.5 border-b border-border bg-surface-alt/60 overflow-x-auto">
      {/* Workflow steps — guide beginners left to right */}
      <span className="text-[9px] font-medium text-text-faint uppercase tracking-wider shrink-0 pr-1">Steps:</span>

      <button
        onClick={() => {
          dispatch({ type: 'SET_FILTER', filter: 'unmarked' });
          dispatch({ type: 'SET_VIEW_MODE', mode: 'single' });
          if (focusedIndex < 0 && sortedFiles.length > 0) setFocused(0);
        }}
        className="px-2.5 py-1 text-[10px] font-medium rounded-md bg-surface-raised text-text-secondary hover:text-text hover:bg-border transition-colors shrink-0"
        title="Open each unmarked photo to pick or reject it"
      >
        1. Review
      </button>

      <button
        onClick={() => dispatch({ type: 'QUEUE_BEST' })}
        className="px-2.5 py-1 text-[10px] font-medium rounded-md bg-surface-raised text-text-secondary hover:text-yellow-300 hover:bg-yellow-500/10 transition-colors shrink-0"
        title="Automatically add high-scoring photos to the import queue"
      >
        2. Queue Best
      </button>

      {queuedPaths.length > 0 ? (
        <button
          onClick={startImport}
          className="px-2.5 py-1 text-[10px] font-medium rounded-md bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 transition-colors shrink-0"
          title="Import all queued files now"
        >
          3. Import ({queuedPaths.length})
        </button>
      ) : (
        <button
          onClick={() => queuePaths(sortedFiles.map((f) => f.path))}
          className="px-2.5 py-1 text-[10px] font-medium rounded-md bg-surface-raised text-text-secondary hover:text-emerald-300 hover:bg-emerald-500/10 transition-colors shrink-0"
          title="Add all visible photos to the import queue"
        >
          3. Queue All
        </button>
      )}

      <div className="w-px h-4 bg-border shrink-0 mx-1" />

      {/* Secondary tools */}
      <button
        onClick={() => dispatch({ type: 'SET_FILTER', filter: 'best' })}
        className="px-2 py-1 text-[10px] rounded-md bg-surface-raised text-text-muted hover:text-yellow-300 transition-colors shrink-0"
        title="Filter to show only high-scored keeper candidates"
      >
        Find Best
      </button>
      <button
        onClick={openBestOfSelection}
        className="px-2 py-1 text-[10px] rounded-md bg-yellow-500/10 text-yellow-300 hover:bg-yellow-500/20 transition-colors shrink-0"
        title="Rank the current selection and show the sharpest/top candidates (Shift+B)"
      >
        Best of Selection
      </button>
      <button
        onClick={() => dispatch({ type: 'SET_FILTER', filter: 'blur-risk' })}
        className="px-2 py-1 text-[10px] rounded-md bg-surface-raised text-text-muted hover:text-red-300 transition-colors shrink-0"
        title="Show potentially soft or blurry photos"
      >
        Blur Check
      </button>
      {duplicateCount > 0 && (
        <button
          onClick={() => {
            dispatch({ type: 'SET_FILTER', filter: 'near-duplicates' });
            dispatch({ type: 'SET_VIEW_MODE', mode: 'compare' });
          }}
          className="px-2 py-1 text-[10px] rounded-md bg-surface-raised text-text-muted hover:text-blue-300 transition-colors shrink-0"
          title="Compare visually similar or duplicate photos side-by-side"
        >
          Dupes
        </button>
      )}
      {burstGrouping && burstIds.size > 0 && (
        <button
          onClick={() => dispatch({ type: 'PICK_BEST_IN_GROUPS' })}
          className="px-2 py-1 text-[10px] rounded-md bg-surface-raised text-text-muted hover:text-yellow-300 transition-colors shrink-0"
          title="Automatically pick the sharpest shot in each burst group"
        >
          Pick Best
        </button>
      )}
      <button
        onClick={() => window.electronAPI.exportContactSheet(files.filter((f) => f.pick !== 'rejected'))}
        className="px-2 py-1 text-[10px] rounded-md bg-surface-raised text-text-muted hover:text-text transition-colors shrink-0"
        title="Export a contact sheet PDF of non-rejected photos"
      >
        Contact Sheet
      </button>
      {queuedPaths.length > 0 && (
        <button
          onClick={() => dispatch({ type: 'QUEUE_CLEAR' })}
          className="px-2 py-1 text-[10px] rounded-md text-text-faint hover:text-red-300 transition-colors shrink-0"
          title="Remove all files from the import queue"
        >
          Clear Queue
        </button>
      )}
    </div>
  ) : null;

  return (
    <div className="h-full flex flex-col relative">
      {showShortcuts && <ShortcutsOverlay onClose={() => setShowShortcuts(false)} />}
      {showBestOfSelection && selectedFiles.length > 0 && (
        <BestOfSelectionPanel
          files={selectedFiles}
          onClose={() => setShowBestOfSelection(false)}
          onPickBest={(file) => {
            dispatch({ type: 'SET_PICK', filePath: file.path, pick: 'selected' });
            setFocused(sortedFiles.findIndex((f) => f.path === file.path));
          }}
          onQueueBest={(file) => dispatch({ type: 'QUEUE_ADD_PATHS', paths: [file.path] })}
          onRejectRest={(best) => {
            dispatch({
              type: 'SET_PICK_BATCH',
              filePaths: selectedFiles.filter((f) => f.path !== best.path).map((f) => f.path),
              pick: 'rejected',
            });
            dispatch({ type: 'SET_PICK', filePath: best.path, pick: 'selected' });
          }}
        />
      )}
      {/* Unified header */}
      <div className="shrink-0 px-2 py-1 flex items-center gap-1 border-b border-border">
        {/* Left panel toggle */}
        <button
          onClick={() => dispatch({ type: 'TOGGLE_LEFT_PANEL' })}
          className="p-0.5 rounded hover:bg-surface-raised shrink-0"
          title={showLeftPanel ? 'Hide source panel' : 'Show source panel'}
        >
          <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none">
            <rect x="0.5" y="0.5" width="15" height="15" rx="1.5" stroke="var(--color-text-muted)" strokeWidth="1" />
            <rect x="2" y="2" width="3.5" height="12" rx="0.75" fill={showLeftPanel ? 'var(--color-text-secondary)' : 'var(--color-text-faint)'} />
          </svg>
        </button>

        <div className="w-px h-3 bg-border mx-1 shrink-0" />

        {/* File count / selection label */}
        <div className="flex items-center gap-1.5 min-w-0 shrink-0">
          {hasBatchSelection ? (
            <span className="text-xs text-blue-400 font-medium">{selectedIndices.size} selected</span>
          ) : isSingle ? (
            <>
              <span className="text-xs font-mono text-text truncate max-w-[120px]">{focusedFile.name}</span>
              <span className="text-[10px] text-text-muted font-mono shrink-0">{focusedIndex + 1}/{sortedFiles.length}</span>
            </>
          ) : (
            <>
              <span className="text-xs text-text-secondary">{files.length} photo{files.length !== 1 ? 's' : ''}</span>
              {thumbsLoading && (
                <div className="flex items-center gap-1">
                  <div className="w-2.5 h-2.5 border border-text-muted border-t-text rounded-full animate-spin" />
                  <span className="text-[9px] text-text-faint">{thumbCount}/{files.length}</span>
                </div>
              )}
            </>
          )}
        </div>

        {/* Pick actions — batch vs single */}
        {sortedFiles.length > 0 && phase !== 'scanning' && (
          <div className="flex items-center gap-px ml-2 shrink-0">
            {hasBatchSelection ? (
              <>
                <button onClick={() => pickFile('selected', false)} title="Pick selected (P)" className="px-2 py-0.5 text-[11px] text-text-secondary hover:text-yellow-400 hover:bg-yellow-400/10 rounded transition-colors">Pick</button>
                <button onClick={() => pickFile('rejected', false)} title="Reject selected (X)" className="px-2 py-0.5 text-[11px] text-text-secondary hover:text-red-400 hover:bg-red-500/10 rounded transition-colors">Reject</button>
                <button onClick={() => pickFile(undefined, false)} title="Clear flags (U)" className="px-2 py-0.5 text-[11px] text-text-secondary hover:text-text hover:bg-surface-raised rounded transition-colors">Unflag</button>
                <button onClick={() => queuePaths(normalizeTargetPaths)} title="Add selected to import queue" className="px-2 py-0.5 text-[11px] text-text-secondary hover:text-emerald-400 hover:bg-emerald-500/10 rounded transition-colors">Queue</button>
                <button onClick={openBestOfSelection} title="Show the best/sharpest selected candidates (Shift+B)" className="px-2 py-0.5 text-[11px] text-text-secondary hover:text-yellow-300 hover:bg-yellow-500/10 rounded transition-colors">Best</button>
                <div className="w-px h-3 bg-border mx-1" />
                <button onClick={() => setSelectedIndices(new Set())} title="Deselect all (Esc)" className="px-2 py-0.5 text-[11px] text-text-muted hover:text-text hover:bg-surface-raised rounded transition-colors">Deselect</button>
              </>
            ) : (
              <>
                <button
                  onClick={() => { const paths = sortedFiles.map((f) => f.path); dispatch({ type: 'SET_PICK_BATCH', filePaths: paths, pick: 'selected' }); }}
                  title="Pick all visible files for import"
                  className="px-2 py-0.5 text-[11px] text-text-secondary hover:text-yellow-400 hover:bg-yellow-400/10 rounded transition-colors"
                >Pick All</button>
                <button
                  onClick={() => dispatch({ type: 'CLEAR_PICKS' })}
                  title="Clear all pick/reject flags"
                  className="px-2 py-0.5 text-[11px] text-text-secondary hover:text-text hover:bg-surface-raised rounded transition-colors"
                >Clear</button>
              </>
            )}
          </div>
        )}

        {/* Spacer pushes filters to the right */}
        <div className="flex-1 min-w-0" />

        {/* Search + filter pills + consolidated filter dropdown */}
        {(sortedFiles.length > 0 || filter !== 'all') && (
          <div className="flex items-center gap-0.5 shrink-0">
            <input
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Search…"
              className="w-24 px-1.5 py-0.5 text-[10px] bg-surface border border-border rounded text-text placeholder-text-muted focus:outline-none focus:border-text-secondary"
              title="Search by filename, camera, lens, date or file type"
            />

            {/* Core filter pills */}
            {(['all', 'picked', 'rejected'] as const).map((f) => (
              <button
                key={f}
                onClick={() => dispatch({ type: 'SET_FILTER', filter: f })}
                className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${filter === f ? 'bg-surface-raised text-text' : 'text-text-muted hover:text-text'}`}
              >
                {f === 'all' ? 'All' : f[0].toUpperCase() + f.slice(1)}
              </button>
            ))}
            <button
              onClick={() => dispatch({ type: 'SET_FILTER', filter: 'queue' })}
              className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${filter === 'queue' ? 'bg-surface-raised text-text' : 'text-text-muted hover:text-text'}`}
            >
              Queue{queuedPaths.length > 0 ? ` ${queuedPaths.length}` : ''}
            </button>

            {/* Single consolidated filter dropdown — replaces 6 individual ones */}
            <select
              value=""
              onChange={(e) => {
                if (!e.target.value) return;
                dispatch({ type: 'SET_FILTER', filter: e.target.value as typeof filter });
                e.currentTarget.value = '';
              }}
              className="px-1 py-0.5 text-[10px] bg-surface border border-border rounded text-text-muted hover:text-text focus:outline-none focus:border-text cursor-pointer"
              title="More filters"
            >
              <option value="">Filter ▾</option>
              <optgroup label="Status">
                <option value="unmarked">Unmarked</option>
                <option value="protected">Protected</option>
                <option value="unrated">Unrated</option>
                <option value="duplicates">Duplicates</option>
                <option value="best">Best shots</option>
                <option value="blur-risk">Blur risk</option>
                <option value="near-duplicates">Similar photos</option>
              </optgroup>
              <optgroup label="Type">
                <option value="photos">Photos only</option>
                <option value="videos">Videos only</option>
                <option value="raw">RAW files</option>
              </optgroup>
              <optgroup label="Stars">
                <option value="rating-5">★★★★★ only</option>
                <option value="rating-4">★★★★ and up</option>
                <option value="rating-3">★★★ and up</option>
                <option value="rating-2">★★ and up</option>
                <option value="rating-1">★ and up</option>
              </optgroup>
              {metadataFilters.cameras.length > 1 && (
                <optgroup label="Camera">
                  {metadataFilters.cameras.map((v) => <option key={v} value={`camera:${encodeURIComponent(v)}`}>{v}</option>)}
                </optgroup>
              )}
              {metadataFilters.lenses.length > 1 && (
                <optgroup label="Lens">
                  {metadataFilters.lenses.map((v) => <option key={v} value={`lens:${encodeURIComponent(v)}`}>{v}</option>)}
                </optgroup>
              )}
              {metadataFilters.dates.length > 0 && (
                <optgroup label="Date">
                  {metadataFilters.dates.map((v) => <option key={v} value={`date:${encodeURIComponent(v)}`}>{v}</option>)}
                </optgroup>
              )}
              {metadataFilters.exts.length > 1 && (
                <optgroup label="File type">
                  {metadataFilters.exts.map((v) => <option key={v} value={`ext:${encodeURIComponent(v)}`}>{v}</option>)}
                </optgroup>
              )}
            </select>

            {/* Clear active filter */}
            {(filter !== 'all' || searchText.trim()) && (
              <button
                onClick={() => { setSearchText(''); dispatch({ type: 'SET_FILTER', filter: 'all' }); }}
                className="px-1 py-0.5 text-[10px] text-text-faint hover:text-text rounded transition-colors"
                title="Clear filter"
              >✕</button>
            )}
          </div>
        )}

        <div className="w-px h-3 bg-border mx-1 shrink-0" />

        {/* View mode toggles */}
        <div className="flex items-center gap-0.5 shrink-0">
          <button onClick={() => dispatch({ type: 'SET_VIEW_MODE', mode: 'grid' })} className={`p-0.5 rounded transition-colors ${viewMode === 'grid' ? 'text-text bg-surface-raised' : 'text-text-muted hover:text-text'}`} title="Grid view">
            <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M4.25 2A2.25 2.25 0 002 4.25v2.5A2.25 2.25 0 004.25 9h2.5A2.25 2.25 0 009 6.75v-2.5A2.25 2.25 0 006.75 2h-2.5zm0 9A2.25 2.25 0 002 13.25v2.5A2.25 2.25 0 004.25 18h2.5A2.25 2.25 0 009 15.75v-2.5A2.25 2.25 0 006.75 11h-2.5zm9-9A2.25 2.25 0 0011 4.25v2.5A2.25 2.25 0 0013.25 9h2.5A2.25 2.25 0 0018 6.75v-2.5A2.25 2.25 0 0015.75 2h-2.5zm0 9A2.25 2.25 0 0011 13.25v2.5A2.25 2.25 0 0013.25 18h2.5A2.25 2.25 0 0018 15.75v-2.5A2.25 2.25 0 0015.75 11h-2.5z" clipRule="evenodd" /></svg>
          </button>
          <button onClick={() => { dispatch({ type: 'SET_VIEW_MODE', mode: 'split' }); if (focusedIndex < 0 && sortedFiles.length > 0) setFocused(0); }} className={`p-0.5 rounded transition-colors ${viewMode === 'split' ? 'text-text bg-surface-raised' : 'text-text-muted hover:text-text'}`} title="Split view (filmstrip + detail)">
            <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M2 4.75C2 3.784 2.784 3 3.75 3h4.836c.464 0 .914.184 1.244.513l.17.169V16.318l-.17-.169a1.76 1.76 0 00-1.244-.513H3.75A1.75 1.75 0 012 13.886V4.75zm1.5 0a.25.25 0 01.25-.25h4.836a.25.25 0 01.177.073L9 4.81v10.38l-.237-.237a.25.25 0 00-.177-.073H3.75a.25.25 0 01-.25-.25V4.75z" clipRule="evenodd" /><path fillRule="evenodd" d="M18 4.75c0-.966-.784-1.75-1.75-1.75h-4.836a1.76 1.76 0 00-1.244.513L10 3.682V15.68l.17-.169a1.76 1.76 0 011.244-.513h4.836A1.75 1.75 0 0018 13.25V4.75zm-1.5 0a.25.25 0 00-.25-.25h-4.836a.25.25 0 00-.177.073L11 4.81v10.38l.237-.237a.25.25 0 01.177-.073h4.836a.25.25 0 00.25-.25V4.75z" clipRule="evenodd" /></svg>
          </button>
          <button onClick={() => { dispatch({ type: 'SET_VIEW_MODE', mode: 'single' }); if (focusedIndex < 0 && sortedFiles.length > 0) setFocused(0); }} className={`p-0.5 rounded transition-colors ${viewMode === 'single' ? 'text-text bg-surface-raised' : 'text-text-muted hover:text-text'}`} title="Detail view (double-click a photo)">
            <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M1 4.75C1 3.784 1.784 3 2.75 3h14.5c.966 0 1.75.784 1.75 1.75v10.515a1.75 1.75 0 01-1.75 1.75H2.75A1.75 1.75 0 011 15.265V4.75zm1.5 0a.25.25 0 01.25-.25h14.5a.25.25 0 01.25.25v10.515a.25.25 0 01-.25.25H2.75a.25.25 0 01-.25-.25V4.75z" clipRule="evenodd" /></svg>
          </button>
          <button onClick={() => { dispatch({ type: 'SET_VIEW_MODE', mode: 'compare' }); if (focusedIndex < 0 && sortedFiles.length > 0) setFocused(0); }} className={`p-0.5 rounded transition-colors ${viewMode === 'compare' ? 'text-text bg-surface-raised' : 'text-text-muted hover:text-text'}`} title="Compare view (select 2–4 photos)">
            <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M2 4.5A2.5 2.5 0 014.5 2h4A2.5 2.5 0 0111 4.5v11A2.5 2.5 0 018.5 18h-4A2.5 2.5 0 012 15.5v-11zM12 4.5A2.5 2.5 0 0114.5 2h1A2.5 2.5 0 0118 4.5v11a2.5 2.5 0 01-2.5 2.5h-1a2.5 2.5 0 01-2.5-2.5v-11z" /></svg>
          </button>
        </div>

        <div className="w-px h-3 bg-border mx-1 shrink-0" />

        {/* Settings */}
        <button
          onClick={() => dispatch({ type: 'SET_VIEW_MODE', mode: viewMode === 'settings' ? 'grid' : 'settings' })}
          className={`p-0.5 rounded transition-colors shrink-0 ${viewMode === 'settings' ? 'text-text bg-surface-raised' : 'text-text-muted hover:text-text'}`}
          title="Settings"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M7.84 1.804A1 1 0 018.82 1h2.36a1 1 0 01.98.804l.331 1.652a6.993 6.993 0 011.929 1.115l1.598-.54a1 1 0 011.186.447l1.18 2.044a1 1 0 01-.205 1.251l-1.267 1.113a7.047 7.047 0 010 2.228l1.267 1.113a1 1 0 01.206 1.25l-1.18 2.045a1 1 0 01-1.187.447l-1.598-.54a6.993 6.993 0 01-1.929 1.115l-.33 1.652a1 1 0 01-.98.804H8.82a1 1 0 01-.98-.804l-.331-1.652a6.993 6.993 0 01-1.929-1.115l-1.598.54a1 1 0 01-1.186-.447l-1.18-2.044a1 1 0 01.205-1.251l1.267-1.114a7.05 7.05 0 010-2.227L1.821 7.773a1 1 0 01-.206-1.25l1.18-2.045a1 1 0 011.187-.447l1.598.54A6.993 6.993 0 017.51 3.456l.33-1.652zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" /></svg>
        </button>

        <div className="w-px h-3 bg-border mx-1 shrink-0" />

        {/* Right panel toggle */}
        <button
          onClick={() => dispatch({ type: 'TOGGLE_RIGHT_PANEL' })}
          className="p-0.5 rounded hover:bg-surface-raised shrink-0"
          title={showRightPanel ? 'Hide output panel' : 'Show output panel'}
        >
          <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none">
            <rect x="0.5" y="0.5" width="15" height="15" rx="1.5" stroke="var(--color-text-muted)" strokeWidth="1" />
            <rect x="10.5" y="2" width="3.5" height="12" rx="0.75" fill={showRightPanel ? 'var(--color-text-secondary)' : 'var(--color-text-faint)'} />
          </svg>
        </button>
      </div>
      {nextActionToolbar}

      {/* Content */}
      <div className="flex-1 min-h-0">
        {viewMode === 'settings' ? (
          <SettingsPage
            inline
            onClose={() => dispatch({ type: 'SET_VIEW_MODE', mode: 'grid' })}
          />
        ) : viewMode === 'compare' ? (
          <div className="h-full relative">
            <CompareView files={compareFiles.length >= 2 ? compareFiles : sortedFiles.slice(Math.max(0, focusedIndex), Math.max(0, focusedIndex) + 2)} />
            {floatingToolbar}
          </div>
        ) : viewMode === 'single' && focusedFile ? (
          <div className="h-full relative">
            <SingleView
              file={focusedFile}
              index={focusedIndex}
              total={sortedFiles.length}
            />
            {floatingToolbar}
          </div>
        ) : viewMode === 'split' ? (
          <div className="h-full flex">
            <div className="w-[200px] shrink-0 border-r border-border overflow-y-auto px-2 pt-1 pb-16">
              <div
                ref={splitGridRef}
                className="flex flex-col gap-1"
              >
                {sortedFiles.map((file, i) => (
                  <ThumbnailCard
                    key={file.path}
                    file={file}
                    focused={i === focusedIndex}
                    selected={selectedIndices.has(i)}
                    queued={queuedSet.has(file.path)}
                    compact
                    frameNumber={i + 1}
                    burstCollapsed={!!file.burstId && collapsedSet.has(file.burstId)}
                    onBurstToggle={(id) => dispatch({ type: 'TOGGLE_BURST_COLLAPSE', burstId: id })}
                    onClick={(e) => handleCardClick(i, e)}
                    onDoubleClick={() => setFocused(i)}
                  />
                ))}
              </div>
            </div>
            <div className="flex-1 min-w-0 relative">
              {focusedFile ? (
                <SingleView
                  file={focusedFile}
                  index={focusedIndex}
                  total={sortedFiles.length}
                />
              ) : (
                <div className="h-full flex items-center justify-center">
                  <p className="text-sm text-text-muted">Select a photo to preview</p>
                </div>
              )}
              {floatingToolbar}
            </div>
          </div>
        ) : (
          <div className="h-full relative">
            <div className="h-full overflow-y-auto px-4 pt-3 pb-16">
              <div
                ref={gridRef}
                className="thumbnail-grid grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3"
              >
                {sortedFiles.map((file, i) => (
                  <ThumbnailCard
                    key={file.path}
                    file={file}
                    focused={i === focusedIndex}
                  selected={selectedIndices.has(i)}
                  queued={queuedSet.has(file.path)}
                    burstCollapsed={!!file.burstId && collapsedSet.has(file.burstId)}
                    onBurstToggle={(id) => dispatch({ type: 'TOGGLE_BURST_COLLAPSE', burstId: id })}
                    onClick={(e) => handleCardClick(i, e)}
                    onDoubleClick={() => {
                      setFocused(i);
                      dispatch({ type: 'SET_VIEW_MODE', mode: 'single' });
                    }}
                  />
                ))}
              </div>
            </div>
            {floatingToolbar}
          </div>
        )}
      </div>
    </div>
  );
}
