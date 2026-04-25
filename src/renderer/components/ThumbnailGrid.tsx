import { useMemo, useEffect, useCallback, useRef, useState } from 'react';
// Main grid / single / split view orchestrator.
import { useAppState, useAppDispatch, useMergedFiles } from '../context/ImportContext';
import { useFileScanner } from '../hooks/useFileScanner';
import { useImport } from '../hooks/useImport';
import type { MediaFile } from '../../shared/types';
import { ThumbnailCard } from './ThumbnailCard';
import { SingleView } from './SingleView';
import { CompareView } from './CompareView';
import { EmptyState } from './EmptyState';
import { SettingsPage } from './SettingsPage';
import { ShortcutsOverlay } from './ShortcutsOverlay';
import { BestOfSelectionPanel, rankBestOfSelection } from './BestOfSelectionPanel';
import { getPreviewCacheStats, setBackgroundPreviewPaused, warmPreview } from '../utils/previewCache';
import { clampStops } from '../../shared/exposure';

// ── Laplacian sharpness-based subject detector ────────────────────────────
// Uses focus sharpness (Laplacian variance) instead of colour/skin tone so it
// works for helmeted fighters, animals, objects — anything that is in-focus.
// Gaussian center-weighting suppresses sharp background elements (windows,
// text banners) that are near the frame edges.

interface SubjectBox { x: number; y: number; w: number; h: number; score: number }

/**
 * Detect subject regions by finding the sharpest (in-focus) areas of the image.
 * Algorithm:
 *  1. Divide image into CELLxCELL blocks; compute Laplacian variance per block.
 *  2. Weight each block by a Gaussian centred on the image (σ = 0.38) so that
 *     edge/corner blocks (background windows, signs) are suppressed.
 *  3. Threshold the weighted sharpness map; BFS flood-fill into connected blobs.
 *  4. Filter blobs smaller than minFraction of the image area.
 *  5. Sort by total weighted sharpness; NMS; return top 3 boxes.
 */
function detectSubjectBoxes(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  minFraction = 0.008,
): SubjectBox[] {
  const CELL = 16; // pixel block size — coarse enough to be fast, fine enough to localise
  const cols = Math.ceil(width  / CELL);
  const rows = Math.ceil(height / CELL);
  const minCellArea = (width * height * minFraction) / (CELL * CELL);
  const SIGMA = 0.38; // Gaussian half-width in normalised coords (0-1)
  const twoSigSq = 2 * SIGMA * SIGMA;

  // ── Step 1: per-cell Laplacian variance ─────────────────────────────────
  const lapMap = new Float32Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x0 = cx * CELL, y0 = cy * CELL;
      const x1 = Math.min(x0 + CELL, width  - 1);
      const y1 = Math.min(y0 + CELL, height - 1);
      let sum = 0, sumSq = 0, n = 0;
      for (let py = Math.max(1, y0); py < y1; py++) {
        for (let px = Math.max(1, x0); px < x1; px++) {
          const i = (py * width + px) * 4;
          const g = (v: number) => data[v] * 0.299 + data[v + 1] * 0.587 + data[v + 2] * 0.114;
          const lap = Math.abs(
            g(i - width * 4) + g(i + width * 4) + g(i - 4) + g(i + 4) - 4 * g(i),
          );
          sum += lap; sumSq += lap * lap; n++;
        }
      }
      const mean = n > 0 ? sum / n : 0;
      lapMap[cy * cols + cx] = n > 0 ? (sumSq / n - mean * mean) : 0;
    }
  }

  // ── Step 2: Gaussian center-weight ──────────────────────────────────────
  const weightedMap = new Float32Array(cols * rows);
  let globalMax = 0;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const nx = (cx + 0.5) / cols - 0.5; // normalised, centred at 0
      const ny = (cy + 0.5) / rows - 0.5;
      const gauss = Math.exp(-(nx * nx + ny * ny) / twoSigSq);
      const w = lapMap[cy * cols + cx] * gauss;
      weightedMap[cy * cols + cx] = w;
      if (w > globalMax) globalMax = w;
    }
  }

  if (globalMax === 0) return [];

  // Threshold: cells must be at least 18 % of the peak weighted sharpness
  const THRESH = globalMax * 0.18;

  // ── Step 3: BFS flood-fill into connected blobs ──────────────────────────
  const visited = new Uint8Array(cols * rows);
  const boxes: SubjectBox[] = [];

  for (let startY = 0; startY < rows; startY++) {
    for (let startX = 0; startX < cols; startX++) {
      const idx = startY * cols + startX;
      if (visited[idx] || weightedMap[idx] < THRESH) continue;

      const queue: number[] = [idx];
      visited[idx] = 1;
      let minX = startX, maxX = startX, minY = startY, maxY = startY;
      let cellCount = 0, totalSharp = 0;

      while (queue.length > 0) {
        const cur = queue.pop()!;
        const cy = Math.floor(cur / cols);
        const cx = cur % cols;
        cellCount++;
        totalSharp += weightedMap[cur];
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        for (const n of [cur - 1, cur + 1, cur - cols, cur + cols]) {
          if (n < 0 || n >= cols * rows) continue;
          const nx2 = n % cols;
          const cx2 = cur % cols;
          if (Math.abs(nx2 - cx2) > 1) continue; // prevent row-wrap
          if (visited[n] || weightedMap[n] < THRESH) continue;
          visited[n] = 1;
          queue.push(n);
        }
      }

      // ── Step 4: filter small blobs ───────────────────────────────────────
      if (cellCount < minCellArea) continue;

      const bx = minX * CELL, by = minY * CELL;
      const bw = (maxX - minX + 1) * CELL, bh = (maxY - minY + 1) * CELL;

      // Loose aspect ratio guard (very wide/tall strips are probably artefacts)
      const aspect = bw / bh;
      if (aspect < 0.15 || aspect > 6.0) continue;

      boxes.push({ x: bx, y: by, w: bw, h: bh, score: totalSharp * cellCount });
    }
  }

  // ── Step 5: sort, NMS, return top 3 ─────────────────────────────────────
  boxes.sort((a, b) => b.score - a.score);

  const kept: SubjectBox[] = [];
  for (const box of boxes.slice(0, 8)) {
    let dominated = false;
    for (const k of kept) {
      const ix = Math.max(box.x, k.x);
      const iy = Math.max(box.y, k.y);
      const iw = Math.min(box.x + box.w, k.x + k.w) - ix;
      const ih = Math.min(box.y + box.h, k.y + k.h) - iy;
      if (iw <= 0 || ih <= 0) continue;
      const inter = iw * ih;
      const uni = box.w * box.h + k.w * k.h - inter;
      if (inter / uni > 0.45) { dominated = true; break; }
    }
    if (!dominated) kept.push(box);
    if (kept.length >= 3) break;
  }
  return kept;
}

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

function regionSharpness(data: Uint8ClampedArray, width: number, height: number, region?: { x: number; y: number; w: number; h: number }): number {
  const left = Math.max(1, Math.floor(region?.x ?? 1));
  const top = Math.max(1, Math.floor(region?.y ?? 1));
  const right = Math.min(width - 1, Math.ceil((region?.x ?? 0) + (region?.w ?? width - 2)));
  const bottom = Math.min(height - 1, Math.ceil((region?.y ?? 0) + (region?.h ?? height - 2)));
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  const gray = (idx: number) => data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const i = (y * width + x) * 4;
      const lap = Math.abs(gray(i - width * 4) + gray(i + width * 4) + gray(i - 4) + gray(i + 4) - 4 * gray(i));
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }
  const mean = sum / Math.max(1, count);
  return Math.round(Math.max(0, sumSq / Math.max(1, count) - mean * mean));
}

function faceCropSignature(
  ctx: CanvasRenderingContext2D,
  sourceWidth: number,
  sourceHeight: number,
  face: { x: number; y: number; w: number; h: number },
): string {
  const size = 8;
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = size;
  cropCanvas.height = size;
  const cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true });
  if (!cropCtx) return '0000000000000000';
  const padX = face.w * 0.18;
  const padY = face.h * 0.12;
  const sx = Math.max(0, face.x - padX);
  const sy = Math.max(0, face.y - padY);
  const sw = Math.min(sourceWidth - sx, face.w + padX * 2);
  const sh = Math.min(sourceHeight - sy, face.h + padY * 2);
  cropCtx.drawImage(ctx.canvas, sx, sy, sw, sh, 0, 0, size, size);
  const data = cropCtx.getImageData(0, 0, size, size).data;
  const luma: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    luma.push(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
  }
  const avg = luma.reduce((sum, v) => sum + v, 0) / Math.max(1, luma.length);
  let bits = '';
  for (const v of luma) bits += v >= avg ? '1' : '0';
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex.padStart(16, '0');
}

function looksLikeSkin(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  const rgbRule = r > 45 && g > 30 && b > 20 && max - min > 12 && r > b && r >= g * 0.78;
  const ycbcrRule = y > 38 && cb >= 72 && cb <= 150 && cr >= 125 && cr <= 190;
  return rgbRule && ycbcrRule;
}

function detectFaceLikeRegions(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): Array<{ x: number; y: number; w: number; h: number; confidence: number }> {
  const CELL = 4;
  const cols = Math.ceil(width / CELL);
  const rows = Math.ceil(height / CELL);
  const mask = new Uint8Array(cols * rows);

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let skin = 0;
      let total = 0;
      const x0 = cx * CELL;
      const y0 = cy * CELL;
      const x1 = Math.min(width, x0 + CELL);
      const y1 = Math.min(height, y0 + CELL);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          if (looksLikeSkin(data[i], data[i + 1], data[i + 2])) skin++;
          total++;
        }
      }
      if (skin / Math.max(1, total) >= 0.30) mask[cy * cols + cx] = 1;
    }
  }

  const visited = new Uint8Array(mask.length);
  const regions: Array<{ x: number; y: number; w: number; h: number; confidence: number }> = [];
  const imageArea = width * height;
  const isWideFrame = width > height * 1.12;

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    const queue = [start];
    visited[start] = 1;
    let minX = start % cols;
    let maxX = minX;
    let minY = Math.floor(start / cols);
    let maxY = minY;
    let cells = 0;

    while (queue.length) {
      const cur = queue.pop()!;
      const x = cur % cols;
      const y = Math.floor(cur / cols);
      cells++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const neighbors = [cur - 1, cur + 1, cur - cols, cur + cols];
      for (const n of neighbors) {
        if (n < 0 || n >= mask.length || visited[n] || !mask[n]) continue;
        const nx = n % cols;
        if (Math.abs(nx - x) > 1) continue;
        visited[n] = 1;
        queue.push(n);
      }
    }

    const x = minX * CELL;
    const y = minY * CELL;
    const w = Math.min(width - x, (maxX - minX + 1) * CELL);
    const h = Math.min(height - y, (maxY - minY + 1) * CELL);
    const area = w * h;
    const areaRatio = area / imageArea;
    const aspect = w / Math.max(1, h);
    if (w < 14 || h < 14) continue;
    if (areaRatio < 0.0012 || areaRatio > (isWideFrame ? 0.055 : 0.085)) continue;
    if (aspect < 0.45 || aspect > 1.45) continue;

    const fill = cells / Math.max(1, (w * h) / (CELL * CELL));
    const sharp = regionSharpness(data, width, height, { x, y, w, h });
    const confidence = fill * 60 + Math.min(45, sharp / 4) + Math.min(20, areaRatio * 600);
    if (confidence < 40) continue;

    const padX = w * 0.18;
    const padTop = h * 0.28;
    const padBottom = h * 0.18;
    regions.push({
      x: Math.max(0, x - padX),
      y: Math.max(0, y - padTop),
      w: Math.min(width - Math.max(0, x - padX), w + padX * 2),
      h: Math.min(height - Math.max(0, y - padTop), h + padTop + padBottom),
      confidence,
    });
  }

  regions.sort((a, b) => b.confidence - a.confidence);
  const kept: typeof regions = [];
  for (const box of regions) {
    let overlaps = false;
    for (const existing of kept) {
      const ix = Math.max(box.x, existing.x);
      const iy = Math.max(box.y, existing.y);
      const iw = Math.min(box.x + box.w, existing.x + existing.w) - ix;
      const ih = Math.min(box.y + box.h, existing.y + existing.h) - iy;
      if (iw <= 0 || ih <= 0) continue;
      const inter = iw * ih;
      const uni = box.w * box.h + existing.w * existing.h - inter;
      if (inter / uni > 0.35) { overlaps = true; break; }
    }
    if (!overlaps) kept.push(box);
    if (kept.length >= 4) break;
  }
  return kept;
}

function regionSkinRatio(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  region: { x: number; y: number; w: number; h: number },
): number {
  const left = Math.max(0, Math.floor(region.x));
  const top = Math.max(0, Math.floor(region.y));
  const right = Math.min(width, Math.ceil(region.x + region.w));
  const bottom = Math.min(height, Math.ceil(region.y + region.h));
  let skin = 0;
  let total = 0;
  for (let y = top; y < bottom; y += 2) {
    for (let x = left; x < right; x += 2) {
      const i = (y * width + x) * 4;
      if (looksLikeSkin(data[i], data[i + 1], data[i + 2])) skin++;
      total++;
    }
  }
  return skin / Math.max(1, total);
}

function estimateHeadRegionsFromSubjects(
  subjects: Array<SubjectBox & { sharpness: number }>,
  data: Uint8ClampedArray,
  width: number,
  height: number,
): Array<{ x: number; y: number; w: number; h: number; confidence: number }> {
  const regions: Array<{ x: number; y: number; w: number; h: number; confidence: number }> = [];
  for (const subject of subjects.slice(0, 5)) {
    const headW = Math.max(16, Math.min(70, subject.w * 0.32));
    const headH = Math.max(16, Math.min(78, subject.h * 0.22));
    const candidates = [
      { x: subject.x + subject.w * 0.5 - headW * 0.5, y: subject.y + subject.h * 0.04, w: headW, h: headH },
      { x: subject.x + subject.w * 0.35 - headW * 0.5, y: subject.y + subject.h * 0.08, w: headW, h: headH },
      { x: subject.x + subject.w * 0.65 - headW * 0.5, y: subject.y + subject.h * 0.08, w: headW, h: headH },
    ];
    for (const candidate of candidates) {
      const box = {
        x: Math.max(0, Math.min(width - headW, candidate.x)),
        y: Math.max(0, Math.min(height - headH, candidate.y)),
        w: Math.min(headW, width - Math.max(0, candidate.x)),
        h: Math.min(headH, height - Math.max(0, candidate.y)),
      };
      if (box.w < 14 || box.h < 14) continue;
      const skinRatio = regionSkinRatio(data, width, height, box);
      if (skinRatio < 0.08) continue;
      const sharpness = regionSharpness(data, width, height, box);
      const confidence = skinRatio * 90 + Math.min(55, sharpness / 3) + Math.min(24, subject.sharpness / 8);
      if (confidence < 45) continue;
      regions.push({ ...box, confidence });
    }
  }
  regions.sort((a, b) => b.confidence - a.confidence);
  const kept: typeof regions = [];
  for (const box of regions) {
    let overlaps = false;
    for (const existing of kept) {
      const ix = Math.max(box.x, existing.x);
      const iy = Math.max(box.y, existing.y);
      const iw = Math.min(box.x + box.w, existing.x + existing.w) - ix;
      const ih = Math.min(box.y + box.h, existing.y + existing.h) - iy;
      if (iw <= 0 || ih <= 0) continue;
      const inter = iw * ih;
      const uni = box.w * box.h + existing.w * existing.h - inter;
      if (inter / uni > 0.25) { overlaps = true; break; }
    }
    if (!overlaps) kept.push(box);
    if (kept.length >= 4) break;
  }
  return kept;
}

async function analyzeSubject(src: string): Promise<{
  subjectSharpnessScore: number;
  faceCount: number;
  faceBoxes: Array<{ x: number; y: number; width: number; height: number; eyeScore?: number }>;
  faceDetection?: 'native' | 'estimated';
  faceSignature?: string;
  subjectReasons: string[];
}> {
  const img = new Image();
  img.decoding = 'async';
  const loaded = new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('image load failed'));
  });
  img.src = src;
  await loaded;
  // Use the full thumbnail resolution (up to 480px wide) for better face detection accuracy.
  const canvas = document.createElement('canvas');
  const width = Math.min(img.naturalWidth, 480);
  const height = Math.round(width * img.naturalHeight / img.naturalWidth);
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return { subjectSharpnessScore: 0, faceCount: 0, faceBoxes: [], subjectReasons: [] };
  ctx.drawImage(img, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;

  // Broad center-region sharpness as baseline (works even with helmets/masks)
  const center = regionSharpness(data, width, height, {
    x: width * 0.2, y: height * 0.1, w: width * 0.6, h: height * 0.8,
  });

  // Detect main subjects — use a looser minFraction so partially-visible
  // or helmeted subjects are found, while very distant background people
  // (who occupy <0.8% of the frame) are filtered.
  const subjects = detectSubjectBoxes(data, width, height, 0.008);

  // Score each detected subject by sharpness inside its bounding box.
  const scored = subjects.map((box) => {
    const sharp = regionSharpness(data, width, height, { x: box.x, y: box.y, w: box.w, h: box.h });
    return { ...box, sharpness: sharp };
  });

  const bestSharp = Math.max(center, ...scored.map((s) => s.sharpness));

  return {
    subjectSharpnessScore: bestSharp,
    faceCount: 0,
    faceBoxes: [],
    faceDetection: undefined,
    faceSignature: undefined,
    subjectReasons: [
      scored.length > 0
        ? (scored.length > 1 ? `${scored.length} subject zones` : 'subject focus')
        : 'center subject',
    ],
  };
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
  const { phase, selectedSource, scanError, focusedIndex, viewMode, showLeftPanel, showRightPanel, filter, cullMode, collapsedBursts, exposureAnchorPath, exposureMaxStops, saveFormat, burstGrouping, normalizeExposure, selectedPaths, queuedPaths, selectionSets, scanPaused } = useAppState();
  // useMergedFiles() overlays face/review scores without re-running the full
  // reducer map — O(n) only when scores.size > 0, otherwise returns the same array.
  const files = useMergedFiles();
  const { startScan, pauseScan, resumeScan } = useFileScanner();
  const { startImport } = useImport();
  const dispatch = useAppDispatch();
  const gridRef = useRef<HTMLDivElement>(null);
  const splitGridRef = useRef<HTMLDivElement>(null);
  const [searchText, setSearchText] = useState('');
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showBestOfSelection, setShowBestOfSelection] = useState(false);
  const [bestScope, setBestScope] = useState<{ paths: string[]; title: string; subtitle?: string } | null>(null);
  const [batchOffset, setBatchOffset] = useState(0); // for Best of Batch page navigation
  const [reviewPaused, setReviewPaused] = useState(false);
  const [backgroundLoadingPaused, setBackgroundLoadingPaused] = useState(false);
  const [exposureClipboard, setExposureClipboard] = useState<number | null>(null);
  const [groupByFolder, setGroupByFolder] = useState(false);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [showAdvancedTools, setShowAdvancedTools] = useState(false);
  const [cacheStats, setCacheStats] = useState(getPreviewCacheStats());
  const [toolbarPos, setToolbarPos] = useState<{ x: number; y: number } | null>(null);
  const [reviewLoopTick, setReviewLoopTick] = useState(0);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const toolbarDragState = useRef<{ startMouseX: number; startMouseY: number; startLeft: number; startTop: number } | null>(null);
  const lastClickedRef = useRef<number>(-1);
  const sharpnessInFlightRef = useRef(false);
  const reviewBatchCounterRef = useRef(0);
  const collapsedSet = useMemo(() => new Set(collapsedBursts), [collapsedBursts]);
  const queuedSet = useMemo(() => new Set(queuedPaths), [queuedPaths]);
  const totalPhotoCount = useMemo(() => files.filter((f) => f.type === 'photo').length, [files]);
  const readyThumbnailCount = useMemo(
    () => files.filter((f) => f.type === 'photo' && !!f.thumbnail).length,
    [files],
  );
  const reviewWaitingForThumbnails =
    phase === 'scanning' || (totalPhotoCount > 0 && readyThumbnailCount < totalPhotoCount);

  const setsEqual = useCallback((a: Set<number>, b: Set<number>) => {
    if (a.size !== b.size) return false;
    for (const value of a) {
      if (!b.has(value)) return false;
    }
    return true;
  }, []);

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
        case 'faces': return (f.faceCount ?? 0) > 0;
        case 'face-groups': return !!f.faceGroupId;
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

  useEffect(() => {
    dispatch({ type: 'SET_SELECTED_PATHS', paths: [] });
  }, [dispatch, selectedSource]);

  const selectedIndices = useMemo(() => {
    if (selectedPaths.length === 0) return new Set<number>();
    const pathSet = new Set(selectedPaths);
    const next = new Set<number>();
    sortedFiles.forEach((file, index) => {
      if (pathSet.has(file.path)) next.add(index);
    });
    return next;
  }, [selectedPaths, sortedFiles]);

  const setSelectedIndices = useCallback((next: Set<number>) => {
    const paths = Array.from(next)
      .filter((i) => i >= 0 && i < sortedFiles.length)
      .map((i) => sortedFiles[i].path);
    if (paths.length === selectedPaths.length && paths.every((pathValue, index) => pathValue === selectedPaths[index])) {
      return;
    }
    dispatch({ type: 'SET_SELECTED_PATHS', paths });
  }, [dispatch, selectedPaths, sortedFiles]);

  useEffect(() => {
    if (sharpnessInFlightRef.current) return;
    if (reviewPaused) return;
    if (reviewWaitingForThumbnails) return;
    // Allow analysis in all view modes — use a smaller batch in single/split
    // so face detection doesn't compete with the detail preview load.
    // Always process one at a time — ONNX inference blocks the main process
    // for 1-4s per image. Larger batches cause the UI to freeze completely.
    const batchSize = 1;
    // Keep batch small so scoring doesn't freeze the UI on slow machines.
    const focusedPath = focusedIndex >= 0 && focusedIndex < sortedFiles.length ? sortedFiles[focusedIndex].path : null;
    const visibleRank = new Map<string, number>();
    sortedFiles.slice(0, 240).forEach((f, index) => visibleRank.set(f.path, index));
    const candidates = files
      .filter((f) => f.type === 'photo' && f.thumbnail && (
        typeof f.sharpnessScore !== 'number' ||
        !f.visualHash ||
        typeof f.subjectSharpnessScore !== 'number' ||
        (f.faceDetection === 'native' && (f.faceCount ?? 0) > 0 && !f.faceSignature) ||
        f.faceBoxes === undefined  // re-run face detection if it hasn't been stored yet
      ))
      .sort((a, b) => {
        const af = focusedPath && a.path === focusedPath ? -1000 : 0;
        const bf = focusedPath && b.path === focusedPath ? -1000 : 0;
        const aMissingFace = a.faceBoxes === undefined ? -200 : 0;
        const bMissingFace = b.faceBoxes === undefined ? -200 : 0;
        const aVisible = visibleRank.get(a.path) ?? 9999;
        const bVisible = visibleRank.get(b.path) ?? 9999;
        return (af + aMissingFace + aVisible) - (bf + bMissingFace + bVisible);
      })
      .slice(0, batchSize);
    if (candidates.length === 0) return;
    sharpnessInFlightRef.current = true;
    const run = () => void (async () => {
      const onnxResults = await window.electronAPI.analyzeFaces(candidates.map((f) => f.path)).catch(() => []);
      const onnxByPath = new Map(onnxResults.map((result) => [result.path, result]));

      return Promise.all(candidates.map(async (f) => {
        try {
          const thumbnail = f.thumbnail as string;
        const onnx = onnxByPath.get(f.path);
        const [sharpnessScore, hash, subject] = await Promise.all([
          typeof f.sharpnessScore === 'number' ? Promise.resolve(f.sharpnessScore) : scoreSharpness(thumbnail),
          f.visualHash ? Promise.resolve(f.visualHash) : visualHash(thumbnail),
          // Re-run analyzeSubject if faceBoxes is undefined (never analyzed, or
          // analyzed before FaceDetector was enabled and data was cleared).
          // Even if subjectSharpnessScore is already set we still re-analyze so
          // that face boxes get populated now that FaceDetector is available.
          (typeof f.subjectSharpnessScore === 'number' && f.faceBoxes !== undefined)
            ? Promise.resolve({
                subjectSharpnessScore: f.subjectSharpnessScore,
                faceCount: f.faceCount ?? 0,
                faceBoxes: f.faceBoxes,
                faceDetection: f.faceDetection,
                faceSignature: f.faceSignature,
                subjectReasons: f.subjectReasons ?? [],
              })
            : analyzeSubject(thumbnail),
        ]);

        const onnxFaceBoxes = (onnx?.boxes ?? [])
          .filter((box) => box.width > 0 && box.height > 0)
          .map((box) => ({ x: box.x, y: box.y, width: box.width, height: box.height, score: box.score }));
        const onnxPersonBoxes = (onnx?.personBoxes ?? [])
          .filter((box) => box.width > 0 && box.height > 0)
          .map((box) => ({ x: box.x, y: box.y, width: box.width, height: box.height, score: box.score }));
        const mergedReasons = [
          ...(subject.subjectReasons ?? []),
          ...(onnxFaceBoxes.length > 0 ? ['onnx faces'] : []),
          ...(onnxPersonBoxes.length > 0 ? ['person detected'] : []),
        ];

        // Always set faceBoxes to an array (even empty) so the filter condition
        // `f.faceBoxes === undefined` correctly marks this file as "analyzed".
        // Never leave it undefined — that would keep the file in the candidate
        // queue and cause it to be re-analyzed on every subsequent batch.
        const resolvedFaceBoxes = onnxFaceBoxes.length > 0
          ? onnxFaceBoxes
          : (subject.faceBoxes ?? []);  // empty array = analyzed, no faces found

          return [f.path, {
          sharpnessScore,
          visualHash: hash,
          ...subject,
          faceCount: resolvedFaceBoxes.length > 0 ? resolvedFaceBoxes.length : (subject.faceCount ?? 0),
          faceBoxes: resolvedFaceBoxes,
          faceDetection: onnxFaceBoxes.length > 0 ? 'native' : subject.faceDetection,
          faceEmbedding: onnx?.embeddings?.[0] || f.faceEmbedding,
          personCount: onnxPersonBoxes.length,
          personBoxes: onnxPersonBoxes,
          subjectReasons: [...new Set(mergedReasons)],
          }] as [string, Partial<MediaFile>];
        } catch {
          const failureTag = `analysis-failed:${f.path}`;
          return [f.path, {
            sharpnessScore: f.sharpnessScore ?? 0,
            subjectSharpnessScore: f.subjectSharpnessScore ?? 0,
            visualHash: f.visualHash ?? failureTag,
            faceCount: f.faceCount ?? 0,
            faceBoxes: f.faceBoxes ?? [],
            faceDetection: f.faceDetection,
            faceSignature: f.faceSignature ?? ((f.faceCount ?? 0) > 0 ? failureTag : undefined),
            personCount: f.personCount ?? 0,
            personBoxes: f.personBoxes ?? [],
            subjectReasons: [...new Set([...(f.subjectReasons ?? []), 'analysis failed'])],
          }] as [string, Partial<MediaFile>];
        }
      }));
    })()
      .then((entries) => {
        dispatch({ type: 'SET_REVIEW_SCORES', scores: Object.fromEntries(entries) });
        reviewBatchCounterRef.current += 1;
        if (reviewBatchCounterRef.current % 5 === 0 || entries.length < batchSize) {
          dispatch({ type: 'GROUP_FACE_SIMILAR', threshold: 10 });
          dispatch({ type: 'GROUP_VISUAL_DUPLICATES', threshold: 8 });
        }
      })
      .catch(() => undefined)
      .finally(() => {
        sharpnessInFlightRef.current = false;
        setReviewLoopTick((value) => value + 1);
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
  }, [files, dispatch, reviewPaused, reviewWaitingForThumbnails, viewMode, focusedIndex, sortedFiles, reviewLoopTick]);

  useEffect(() => {
    setBackgroundPreviewPaused(backgroundLoadingPaused);
  }, [backgroundLoadingPaused]);

  useEffect(() => {
    const id = window.setInterval(() => setCacheStats(getPreviewCacheStats()), 750);
    return () => window.clearInterval(id);
  }, []);

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

  const queuePaths = useCallback((paths: string[]) => {
    dispatch({ type: 'QUEUE_ADD_PATHS', paths });
  }, [dispatch]);

  // Keep a ref so handleCardClick/handleGridDoubleClick/handleBurstToggle stay
  // Sync during render so event handlers never observe a stale Set.
  // Required for React.memo on ThumbnailCard to bail out across renders.
  const selectedIndicesRef = useRef(selectedIndices);
  useEffect(() => {
    selectedIndicesRef.current = selectedIndices;
  }, [selectedIndices]);

  const handleCardClick = useCallback((index: number, e: React.MouseEvent) => {
    const sel = selectedIndicesRef.current;
    const metaKey = e.metaKey || e.ctrlKey;

    if (e.shiftKey && lastClickedRef.current >= 0) {
      const start = Math.min(lastClickedRef.current, index);
      const end = Math.max(lastClickedRef.current, index);
      const next = new Set(metaKey ? sel : new Set<number>());
      for (let i = start; i <= end; i++) next.add(i);
      setSelectedIndices(next);
      setFocused(index);
    } else if (metaKey) {
      const next = new Set(sel);
      if (next.has(index)) { next.delete(index); } else { next.add(index); }
      setSelectedIndices(next);
      setFocused(index);
      lastClickedRef.current = index;
    } else {
      setSelectedIndices(new Set());
      setFocused(index);
      lastClickedRef.current = index;
    }
  }, [setFocused]); // stable — reads selectedIndices via ref

  const handleGridDoubleClick = useCallback((index: number) => {
    setFocused(index);
    dispatch({ type: 'SET_VIEW_MODE', mode: 'single' });
  }, [setFocused, dispatch]);

  const handleBurstToggle = useCallback((burstId: string) => {
    dispatch({ type: 'TOGGLE_BURST_COLLAPSE', burstId });
  }, [dispatch]);

  // Trigger ONNX face scan for any unscanned photos about to appear in a panel.
  const scanUnscannedPanelFiles = useCallback((paths: string[]) => {
    const unscanned = files
      .filter((f) => paths.includes(f.path) && f.type === 'photo' && f.faceBoxes === undefined);
    if (unscanned.length === 0) return;
    void (async () => {
      for (const f of unscanned) {
        try {
          const results = await window.electronAPI.analyzeFaces(f.path);
          const result = results[0];
          if (!result) continue;
          dispatch({
            type: 'SET_REVIEW_SCORES',
            scores: {
              [f.path]: {
                faceCount: result.boxes.length,
                faceBoxes: result.boxes.map((b) => ({ x: b.x, y: b.y, width: b.width, height: b.height, score: b.score })),
                faceDetection: result.boxes.length > 0 ? 'native' : undefined,
                faceEmbedding: result.embeddings?.[0] || f.faceEmbedding,
                personCount: result.personBoxes.length,
                personBoxes: result.personBoxes.map((b) => ({ x: b.x, y: b.y, width: b.width, height: b.height, score: b.score })),
              },
            },
          });
        } catch { /* ignore */ }
      }
    })();
  }, [files, dispatch]);

  const openBestOfSelection = useCallback(() => {
    const focused = focusedIndex >= 0 && focusedIndex < sortedFiles.length ? sortedFiles[focusedIndex] : null;
    let panelPaths: string[] = [];
    if (focused?.burstId) {
      const burstFiles = files
        .filter((f) => f.burstId === focused.burstId)
        .sort((a, b) => (a.burstIndex ?? 0) - (b.burstIndex ?? 0));
      panelPaths = burstFiles.map((f) => f.path);
      const burstPaths = new Set(panelPaths);
      const visibleIndices = new Set<number>();
      sortedFiles.forEach((f, i) => { if (burstPaths.has(f.path)) visibleIndices.add(i); });
      setSelectedIndices(visibleIndices);
      setBestScope({
        paths: panelPaths,
        title: 'Best of Burst',
        subtitle: `Burst ${focused.burstIndex ?? 1}/${focused.burstSize ?? burstFiles.length}`,
      });
    } else if (focused?.faceGroupId && focused.faceGroupSize && focused.faceGroupSize > 1) {
      const faceFiles = files
        .filter((f) => f.faceGroupId === focused.faceGroupId)
        .sort((a, b) => (a.dateTaken ? Date.parse(a.dateTaken) : 0) - (b.dateTaken ? Date.parse(b.dateTaken) : 0));
      panelPaths = faceFiles.map((f) => f.path);
      const facePaths = new Set(panelPaths);
      const visibleIndices = new Set<number>();
      sortedFiles.forEach((f, i) => { if (facePaths.has(f.path)) visibleIndices.add(i); });
      setSelectedIndices(visibleIndices);
      setBestScope({ paths: panelPaths, title: 'Best Face Group', subtitle: `${faceFiles.length} similar face shots` });
    } else if (selectedIndices.size >= 2) {
      panelPaths = Array.from(selectedIndices)
        .filter((i) => i >= 0 && i < sortedFiles.length)
        .map((i) => sortedFiles[i].path);
      setBestScope({ paths: panelPaths, title: 'Best of Selection' });
    } else if (sortedFiles.length > 0) {
      const start = Math.max(0, focusedIndex);
      const windowFiles = sortedFiles.slice(start, Math.min(sortedFiles.length, start + 8));
      panelPaths = windowFiles.map((f) => f.path);
      setSelectedIndices(new Set(windowFiles.map((_, offset) => start + offset)));
      setBestScope({ paths: panelPaths, title: 'Best Nearby', subtitle: 'No burst found' });
    }
    if (panelPaths.length > 0) scanUnscannedPanelFiles(panelPaths);
    setShowBestOfSelection(true);
  }, [files, focusedIndex, selectedIndices, sortedFiles, scanUnscannedPanelFiles]);

  const BATCH_PAGE_SIZE = 120;

  const openBestOfBatch = useCallback((offset = 0) => {
    const eligible = sortedFiles.filter((f) => f.type === 'photo' && f.pick !== 'rejected');
    if (eligible.length === 0) return;
    const clampedOffset = Math.max(0, Math.min(offset, eligible.length - 1));
    const candidates = eligible.slice(clampedOffset, clampedOffset + BATCH_PAGE_SIZE);
    if (candidates.length === 0) return;
    const paths = candidates.map((f) => f.path);
    const pathSet = new Set(paths);
    const visibleIndices = new Set<number>();
    sortedFiles.forEach((f, i) => {
      if (pathSet.has(f.path)) visibleIndices.add(i);
    });
    setSelectedIndices(visibleIndices);
    setBatchOffset(clampedOffset);
    const totalPages = Math.ceil(eligible.length / BATCH_PAGE_SIZE);
    const currentPage = Math.floor(clampedOffset / BATCH_PAGE_SIZE) + 1;
    setBestScope({
      paths,
      title: 'Best of Batch',
      subtitle: totalPages > 1
        ? `Page ${currentPage}/${totalPages} · ${candidates.length} photos`
        : `${candidates.length} visible photos ranked together`,
    });
    scanUnscannedPanelFiles(paths);
    setShowBestOfSelection(true);
  }, [sortedFiles, scanUnscannedPanelFiles]);

  const openAdjacentBatch = useCallback((direction: 1 | -1) => {
    const eligible = sortedFiles.filter((f) => f.type === 'photo' && f.pick !== 'rejected');
    const newOffset = batchOffset + direction * BATCH_PAGE_SIZE;
    const clamped = Math.max(0, Math.min(newOffset, eligible.length - 1));
    openBestOfBatch(clamped);
  }, [batchOffset, openBestOfBatch, sortedFiles]);

  const openAdjacentBurst = useCallback((direction: 1 | -1) => {
    if (files.length === 0) return;
    const burstIdsInOrder: string[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      if (file.burstId && !seen.has(file.burstId)) {
        seen.add(file.burstId);
        burstIdsInOrder.push(file.burstId);
      }
    }
    if (burstIdsInOrder.length === 0) return;
    const current = bestScope?.paths
      .map((p) => files.find((f) => f.path === p)?.burstId)
      .find(Boolean)
      ?? (focusedIndex >= 0 ? sortedFiles[focusedIndex]?.burstId : undefined);
    const currentIndex = current ? burstIdsInOrder.indexOf(current) : -1;
    const nextIndex = currentIndex >= 0
      ? (currentIndex + direction + burstIdsInOrder.length) % burstIdsInOrder.length
      : direction > 0 ? 0 : burstIdsInOrder.length - 1;
    const burstId = burstIdsInOrder[nextIndex];
    const burstFiles = files
      .filter((f) => f.burstId === burstId)
      .sort((a, b) => (a.burstIndex ?? 0) - (b.burstIndex ?? 0));
    const firstVisibleIndex = sortedFiles.findIndex((f) => f.burstId === burstId);
    if (firstVisibleIndex >= 0) setFocused(firstVisibleIndex);
    const burstPaths = new Set(burstFiles.map((f) => f.path));
    const visibleIndices = new Set<number>();
    sortedFiles.forEach((f, i) => {
      if (burstPaths.has(f.path)) visibleIndices.add(i);
    });
    setSelectedIndices(visibleIndices);
    const burstPathList = burstFiles.map((f) => f.path);
    setBestScope({
      paths: burstPathList,
      title: 'Best of Burst',
      subtitle: `Burst ${nextIndex + 1}/${burstIdsInOrder.length}`,
    });
    scanUnscannedPanelFiles(burstPathList);
    setShowBestOfSelection(true);
  }, [bestScope?.paths, files, focusedIndex, setFocused, sortedFiles, scanUnscannedPanelFiles]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const target = e.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && (target.isContentEditable || target.closest('[contenteditable="true"]')))
      ) return;
      if (showShortcuts) {
        if (e.key === 'Escape' || e.key === '?') {
          e.preventDefault();
          setShowShortcuts(false);
        }
        return;
      }
      if (showBestOfSelection) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setShowBestOfSelection(false);
        }
        return;
      }
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

      // Ctrl+C: copy EV adjustment from focused file
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
        const source = focusedFile ?? selectedFiles[0];
        if (source) {
          e.preventDefault();
          setExposureClipboard(source.exposureAdjustmentStops ?? 0);
          return;
        }
      }

      // Ctrl+V: paste EV adjustment to selected/focused
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') {
        if (exposureClipboard !== null) {
          e.preventDefault();
          const targets = selectedIndices.size > 0
            ? Array.from(selectedIndices).filter((i) => i >= 0 && i < sortedFiles.length).map((i) => sortedFiles[i].path)
            : focusedIndex >= 0 ? [sortedFiles[focusedIndex].path] : [];
          if (targets.length > 0) {
            dispatch({ type: 'SET_EXPOSURE_ADJUSTMENT', filePaths: targets, stops: exposureClipboard });
            return;
          }
        }
      }

      switch (e.key) {
        case 'ArrowRight':
          e.preventDefault();
          if (e.shiftKey && (e.metaKey || e.ctrlKey)) {
            // Ctrl/Cmd+Shift+→: next batch page (when batch panel is open)
            if (showBestOfSelection) openAdjacentBatch(1);
          } else if (e.shiftKey) {
            openAdjacentBurst(1);
          } else {
            setSelectedIndices(new Set());
            setFocused(Math.min(focusedIndex + 1, sortedFiles.length - 1));
          }
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (e.shiftKey && (e.metaKey || e.ctrlKey)) {
            // Ctrl/Cmd+Shift+←: prev batch page (when batch panel is open)
            if (showBestOfSelection) openAdjacentBatch(-1);
          } else if (e.shiftKey) {
            openAdjacentBurst(-1);
          } else {
            setSelectedIndices(new Set());
            setFocused(Math.max(focusedIndex - 1, 0));
          }
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
        case 'q':
        case 'Q': {
          if (e.metaKey || e.ctrlKey) break;
          e.preventDefault();
          const targets = selectedIndices.size > 0
            ? Array.from(selectedIndices)
                .filter((i) => i >= 0 && i < sortedFiles.length)
                .map((i) => sortedFiles[i].path)
            : focusedIndex >= 0 && focusedIndex < sortedFiles.length
              ? [sortedFiles[focusedIndex].path]
              : [];
          if (targets.length > 0) queuePaths(targets);
          break;
        }
        case 'Enter':
          if (focusedIndex >= 0 && focusedIndex < sortedFiles.length && viewMode === 'grid') {
            e.preventDefault();
            dispatch({ type: 'SET_VIEW_MODE', mode: 'single' });
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
          // Shift+A: select all photos in the focused file's burst/visual group
          if (e.shiftKey) {
            if (focusedIndex >= 0 && focusedIndex < sortedFiles.length) {
              const focused = sortedFiles[focusedIndex];
              const next = new Set<number>();
              if (focused.burstId) {
                sortedFiles.forEach((f, i) => { if (f.burstId === focused.burstId) next.add(i); });
              } else if (focused.visualGroupId) {
                sortedFiles.forEach((f, i) => { if (f.visualGroupId === focused.visualGroupId) next.add(i); });
              } else if (focused.faceGroupId) {
                sortedFiles.forEach((f, i) => { if (f.faceGroupId === focused.faceGroupId) next.add(i); });
              } else {
                next.add(focusedIndex);
              }
              setSelectedIndices(next);
            }
            break;
          }
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
  }, [focusedIndex, sortedFiles, viewMode, getColumnsCount, setFocused, pickFile, dispatch, selectedIndices, cullMode, files, openBestOfSelection, openAdjacentBatch, openAdjacentBurst, queuePaths, showBestOfSelection, showShortcuts]);

  useEffect(() => {
    const open = () => setShowShortcuts(true);
    window.addEventListener('photo-importer:shortcuts', open);
    return () => window.removeEventListener('photo-importer:shortcuts', open);
  }, []);

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
    const focusedFile = sortedFiles[focusedIndex];
    const isRawFocused = !!focusedFile && /\.(nef|nrw|cr2|cr3|arw|raf|rw2|orf|dng|pef|srw)$/i.test(focusedFile.name || focusedFile.extension);
    const neighbors = isRawFocused
      ? [focusedIndex + 1]
      : [
          focusedIndex + 1, focusedIndex + 2, focusedIndex + 3,
          focusedIndex - 1,
        ];
    const id = setTimeout(() => {
      for (const i of neighbors) {
        if (i >= 0 && i < sortedFiles.length) {
          const candidate = sortedFiles[i];
          const isRawCandidate = /\.(nef|nrw|cr2|cr3|arw|raf|rw2|orf|dng|pef|srw)$/i.test(candidate.name || candidate.extension);
          if (isRawFocused || isRawCandidate) {
            if (i === focusedIndex + 1) warmPreview(candidate.path, 'normal');
          } else {
            warmPreview(candidate.path, i === focusedIndex + 1 ? 'normal' : 'low');
          }
        }
      }
    }, isRawFocused ? 180 : 50);
    return () => clearTimeout(id);
  }, [focusedIndex, viewMode, sortedFiles]);

  // Expose-normalize button state (computed before early returns so the
  // handleNormalizeToggle useCallback is always called unconditionally).
  const focusedFile = focusedIndex >= 0 && focusedIndex < sortedFiles.length ? sortedFiles[focusedIndex] : null;
  const hasBatchSelection = selectedIndices.size > 0;
  const anchorFile = exposureAnchorPath ? files.find((f) => f.path === exposureAnchorPath) : null;
  const anchorHasEV = typeof anchorFile?.exposureValue === 'number';
  const canNormalize = anchorHasEV && saveFormat !== 'original';
  const getThumbnailExposureStops = useCallback((file: typeof files[number]): number => {
    if (!file.normalizeToAnchor || !anchorHasEV || typeof anchorFile?.exposureValue !== 'number' || typeof file.exposureValue !== 'number') {
      return 0;
    }
    return clampStops(file.exposureValue - anchorFile.exposureValue, exposureMaxStops);
  }, [anchorFile?.exposureValue, anchorHasEV, exposureMaxStops]);
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
  const bestPanelFiles = useMemo(() => {
    if (!bestScope) return selectedFiles;
    const byPath = new Map(files.map((f) => [f.path, f]));
    return bestScope.paths.map((p) => byPath.get(p)).filter((f): f is NonNullable<typeof f> => !!f);
  }, [bestScope, files, selectedFiles]);
  const bestOfSelection = bestPanelFiles.length > 0 ? rankBestOfSelection(bestPanelFiles)[0] : null;
  const forceVisibleThumbnails = useCallback((index: number, filePath: string) => {
    if (selectedIndices.has(index) || queuedSet.has(filePath) || index === focusedIndex) return true;
    if (sortedFiles.length <= 72) return true;
    if (viewMode === 'split') return focusedIndex < 0 ? index < 56 : Math.abs(index - focusedIndex) <= 28;
    if (viewMode === 'single' || viewMode === 'compare') return focusedIndex < 0 ? index < 24 : Math.abs(index - focusedIndex) <= 12;
    if (filter !== 'all' || searchText.trim()) return index < 96;
    return index < 40 || (focusedIndex >= 0 && Math.abs(index - focusedIndex) <= 24);
  }, [filter, focusedIndex, queuedSet, searchText, selectedIndices, sortedFiles.length, viewMode]);

  // Map path → index in sortedFiles so the folder-group render doesn't
  // have to call indexOf() for every card.
  const pathToSortedIndex = useMemo(() => {
    const m = new Map<string, number>();
    sortedFiles.forEach((f, i) => m.set(f.path, i));
    return m;
  }, [sortedFiles]);

  // Folder groups — only computed when the folder-view toggle is on.
  // Within each folder files are already pulled from sortedFiles (which sorts
  // by rating desc, date asc) so the order is correct; we just re-sort
  // to make sure star ranking is primary within the group.
  const folderGroups = useMemo(() => {
    if (!groupByFolder || !selectedSource) return null;
    const groups = new Map<string, typeof sortedFiles>();
    for (const file of sortedFiles) {
      let rel = file.path;
      if (rel.startsWith(selectedSource)) rel = rel.slice(selectedSource.length);
      // strip leading separator (works for both / and \)
      if (rel.startsWith('/') || rel.startsWith('\\')) rel = rel.slice(1);
      const lastSep = Math.max(rel.lastIndexOf('/'), rel.lastIndexOf('\\'));
      const folder = lastSep < 0 ? '(root)' : rel.slice(0, lastSep).replace(/\\/g, '/');
      if (!groups.has(folder)) groups.set(folder, []);
      groups.get(folder)!.push(file);
    }
    // Sort files within each group: highest rating first, then by date
    for (const arr of groups.values()) {
      arr.sort((a, b) => {
        const ra = a.rating ?? 0;
        const rb = b.rating ?? 0;
        if (ra !== rb) return rb - ra;
        const ta = a.dateTaken ? Date.parse(a.dateTaken) : 0;
        const tb = b.dateTaken ? Date.parse(b.dateTaken) : 0;
        return ta - tb;
      });
    }
    // Sort folder names alphabetically
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [groupByFolder, selectedSource, sortedFiles]);

  useEffect(() => {
    setCollapsedFolders(new Set());
  }, [selectedSource, groupByFolder]);

  const reviewStats = useMemo(() => {
    const photoFiles = files.filter((f) => f.type === 'photo');
    const analyzed = photoFiles.filter((f) =>
      typeof f.sharpnessScore === 'number' ||
      typeof f.subjectSharpnessScore === 'number' ||
      typeof f.reviewScore === 'number'
    ).length;
    const faces = photoFiles.filter((f) => (f.faceCount ?? 0) > 0).length;
    const blur = photoFiles.filter((f) => f.blurRisk === 'high' || f.blurRisk === 'medium').length;
    return { total: photoFiles.length, analyzed, faces, blur };
  }, [files]);
  const visibleThumbStats = useMemo(() => {
    const total = sortedFiles.length;
    const ready = sortedFiles.filter((f) => !!f.thumbnail).length;
    return { total, ready };
  }, [sortedFiles]);
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

  const copyExposureAdjustment = useCallback(() => {
    const source = focusedFile ?? selectedFiles[0];
    if (!source) return;
    setExposureClipboard(source.exposureAdjustmentStops ?? 0);
  }, [focusedFile, selectedFiles]);

  const pasteExposureAdjustment = useCallback(() => {
    if (exposureClipboard === null || normalizeTargetPaths.length === 0) return;
    dispatch({ type: 'SET_EXPOSURE_ADJUSTMENT', filePaths: normalizeTargetPaths, stops: exposureClipboard });
  }, [dispatch, exposureClipboard, normalizeTargetPaths]);

  const handleToolbarDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const el = toolbarRef.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const elRect = el.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    toolbarDragState.current = {
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startLeft: elRect.left - parentRect.left,
      startTop: elRect.top - parentRect.top,
    };
    const onMove = (ev: MouseEvent) => {
      const s = toolbarDragState.current;
      if (!s) return;
      setToolbarPos({
        x: s.startLeft + (ev.clientX - s.startMouseX),
        y: s.startTop + (ev.clientY - s.startMouseY),
      });
    };
    const onUp = () => {
      toolbarDragState.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

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

  if (viewMode === 'settings') {
    return (
      <div className="h-full flex flex-col relative">
        {showShortcuts && <ShortcutsOverlay onClose={() => setShowShortcuts(false)} />}
        <SettingsPage
          inline
          onClose={() => dispatch({ type: 'SET_VIEW_MODE', mode: 'grid' })}
        />
      </div>
    );
  }

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
    <div
      ref={toolbarRef}
      className="flex items-center gap-px bg-surface-alt/95 backdrop-blur-sm border border-border rounded-lg shadow-lg z-20"
      style={toolbarPos
        ? { position: 'absolute', left: toolbarPos.x, top: toolbarPos.y }
        : { position: 'absolute', bottom: '0.75rem', left: '50%', transform: 'translateX(-50%)' }
      }
    >
      <div
        className="px-1.5 py-1.5 text-text-faint hover:text-text-secondary cursor-grab active:cursor-grabbing select-none"
        onMouseDown={handleToolbarDragStart}
        title="Drag to move toolbar"
      >
        <svg className="w-2.5 h-3" viewBox="0 0 8 12" fill="currentColor">
          <circle cx="2" cy="2" r="1.1"/><circle cx="6" cy="2" r="1.1"/>
          <circle cx="2" cy="6" r="1.1"/><circle cx="6" cy="6" r="1.1"/>
          <circle cx="2" cy="10" r="1.1"/><circle cx="6" cy="10" r="1.1"/>
        </svg>
      </div>
      <div className="w-px h-4 bg-border" />
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
          <button
            onClick={copyExposureAdjustment}
            className="px-2 py-1.5 text-[11px] text-text-muted hover:text-sky-300 hover:bg-sky-500/10 transition-colors"
            title="Copy the focused file's manual EV offset"
          >
            Copy EV
          </button>
          <button
            onClick={pasteExposureAdjustment}
            disabled={exposureClipboard === null}
            className="px-2 py-1.5 text-[11px] text-text-muted hover:text-sky-300 hover:bg-sky-500/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            title={exposureClipboard === null ? 'Copy an EV offset first' : `Paste ${exposureClipboard >= 0 ? '+' : ''}${exposureClipboard.toFixed(2)} EV to current target`}
          >
            Paste
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

      {/* ── Step 1: Review ── */}
      <button
        onClick={() => {
          dispatch({ type: 'SET_FILTER', filter: 'unmarked' });
          dispatch({ type: 'SET_VIEW_MODE', mode: 'single' });
          if (focusedIndex < 0 && sortedFiles.length > 0) setFocused(0);
        }}
        className="px-2.5 py-1 text-[10px] font-medium rounded-md bg-surface-raised text-text-secondary hover:text-text hover:bg-border transition-colors shrink-0"
        title="Open single-photo view filtered to unmarked files. Use P to pick, X to reject, ← → to navigate."
      >
        1. Review
      </button>

      {/* ── Step 2: Queue keepers (all non-rejected, non-blur photos) ── */}
      <button
        onClick={() => {
          // Queue everything that's not rejected and not high-blur-risk
          const keeperPaths = sortedFiles
            .filter((f) => f.pick !== 'rejected' && f.blurRisk !== 'high' && !f.duplicate)
            .map((f) => f.path);
          dispatch({ type: 'QUEUE_ADD_PATHS', paths: keeperPaths });
          if (keeperPaths.length > 0) dispatch({ type: 'SET_FILTER', filter: 'queue' });
        }}
        className="px-2.5 py-1 text-[10px] font-medium rounded-md bg-surface-raised text-text-secondary hover:text-yellow-300 hover:bg-yellow-500/10 transition-colors shrink-0"
        title="Queue all non-rejected, non-blur-risk photos for import. Keeps most images. Excludes only rejected and high-blur shots."
      >
        2. Queue Keepers
      </button>
      {/* ── Optional: Queue only the single best per burst ── */}
      <button
        onClick={() => dispatch({ type: 'QUEUE_BEST' })}
        className="px-2 py-1 text-[10px] rounded-md bg-surface-raised text-text-muted hover:text-yellow-300 transition-colors shrink-0"
        title={`Queue only the top-ranked shot from each burst/group. Strict cull — keeps ~8% of photos. AI done: ${reviewStats.analyzed}/${reviewStats.total}.`}
      >
        Queue Best Only
      </button>

      {/* ── Step 3: Import or queue all ── */}
      {queuedPaths.length > 0 ? (
        <button
          onClick={startImport}
          className="px-2.5 py-1 text-[10px] font-medium rounded-md bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 transition-colors shrink-0"
          title="Import all queued files to the destination folder set in the right panel."
        >
          3. Import ({queuedPaths.length})
        </button>
      ) : (
        <button
          onClick={() => queuePaths(sortedFiles.map((f) => f.path))}
          className="px-2.5 py-1 text-[10px] font-medium rounded-md bg-surface-raised text-text-secondary hover:text-emerald-300 hover:bg-emerald-500/10 transition-colors shrink-0"
          title={`Queue every visible file for import. Thumbnails ready: ${visibleThumbStats.ready}/${visibleThumbStats.total}.`}
        >
          3. Queue All
        </button>
      )}

      <div className="w-px h-4 bg-border shrink-0 mx-0.5" />

      {/* ── Best of Burst / Batch ── always visible ── */}
      <button
        onClick={openBestOfSelection}
        className="px-2 py-1 text-[10px] rounded-md bg-yellow-500/10 text-yellow-300 hover:bg-yellow-500/20 transition-colors shrink-0"
        title="Compare shots in the focused burst side-by-side and pick the best one. Shortcut: Shift+B."
      >
        Best of Burst
      </button>
      <button
        onClick={() => openBestOfBatch(0)}
        className="px-2 py-1 text-[10px] rounded-md bg-surface-raised text-text-muted hover:text-yellow-300 transition-colors shrink-0"
        title={`Rank all visible photos together and show the top candidates. AI: ${reviewStats.analyzed}/${reviewStats.total}, faces: ${reviewStats.faces}.`}
      >
        Best of Batch
      </button>

      <div className="w-px h-4 bg-border shrink-0 mx-0.5" />

      {/* ── AI scan controls ── */}
      {/* Pause/Resume AI review + preview loading — combined into one toggle */}
      <button
        onClick={() => {
          if (reviewWaitingForThumbnails) return;
          const pausing = !reviewPaused;
          setReviewPaused(pausing);
          setBackgroundLoadingPaused(pausing);
        }}
        className={`px-2 py-1 text-[10px] rounded-md transition-colors shrink-0 ${
          reviewWaitingForThumbnails
            ? 'bg-blue-500/10 text-blue-300'
            : reviewPaused
              ? 'bg-yellow-500/15 text-yellow-300 hover:bg-yellow-500/25'
              : 'bg-surface-raised text-text-muted hover:text-text'
        }`}
        title={reviewWaitingForThumbnails
          ? `AI review starts after thumbnails finish loading. Ready: ${readyThumbnailCount}/${totalPhotoCount}.`
          : reviewPaused
            ? `Resume AI analysis and preview loading. Done ${reviewStats.analyzed}/${reviewStats.total}.`
            : `Pause AI analysis and preview loading. Done ${reviewStats.analyzed}/${reviewStats.total}.`}
      >
        {reviewWaitingForThumbnails
          ? `Loading ${readyThumbnailCount}/${totalPhotoCount}`
          : reviewPaused
            ? `▶ Resume AI ${reviewStats.analyzed}/${reviewStats.total}`
            : `⏸ Pause AI ${reviewStats.analyzed}/${reviewStats.total}`}
      </button>

      {/* Re-scan AI: clears face data + resumes analysis. Shows blur count when done. */}
      <button
        onClick={() => {
          dispatch({ type: 'CLEAR_FACE_DATA' });
          setReviewPaused(false);
          setBackgroundLoadingPaused(false);
        }}
        className={`px-2 py-1 text-[10px] rounded-md transition-colors shrink-0 ${
          reviewStats.faces > 0
            ? 'bg-violet-500/10 text-violet-300 hover:bg-violet-500/20'
            : 'bg-surface-raised text-text-muted hover:text-violet-300'
        }`}
        title={`Clear all AI face/blur/sharpness data and re-run analysis from scratch. Faces found: ${reviewStats.faces}, blur risk: ${reviewStats.blur}.`}
      >
        Re-scan AI {reviewStats.faces > 0 ? `· ${reviewStats.faces} faces` : ''}{reviewStats.blur > 0 ? ` · ${reviewStats.blur} blur` : ''}
      </button>

      <div className="w-px h-4 bg-border shrink-0 mx-0.5" />

      <button
        onClick={() => setShowAdvancedTools((v) => !v)}
        className={`px-2 py-1 text-[10px] rounded-md transition-colors shrink-0 ${
          showAdvancedTools ? 'bg-blue-500/15 text-blue-300' : 'bg-surface-raised text-text-muted hover:text-text'
        }`}
        title="Show extra tools: blur filter, auto-cull, duplicates, safe cull, cache stats."
      >
        {showAdvancedTools ? '− Less' : '+ More'}
      </button>

      {queuedPaths.length > 0 && (
        <button
          onClick={() => dispatch({ type: 'QUEUE_CLEAR' })}
          className="px-2 py-1 text-[10px] rounded-md text-text-faint hover:text-red-300 transition-colors shrink-0"
          title={`Remove all ${queuedPaths.length} queued files from the queue. Does not clear pick/reject flags.`}
        >
          Clear Queue
        </button>
      )}

      {showAdvancedTools && (
        <>
          <div className="w-px h-4 bg-border shrink-0 mx-0.5" />
          {/* Blur filter */}
          <button
            onClick={() => dispatch({ type: 'SET_FILTER', filter: 'blur-risk' })}
            className="px-2 py-1 text-[10px] rounded-md bg-surface-raised text-text-muted hover:text-red-300 transition-colors shrink-0"
            title={`Filter to photos with medium/high blur risk. ${reviewStats.blur} found.`}
          >
            Blur {reviewStats.blur > 0 ? reviewStats.blur : ''}
          </button>
          {files.some((f) => f.blurRisk === 'high') && (
            <button
              onClick={() => dispatch({
                type: 'SET_PICK_BATCH',
                filePaths: files.filter((f) => f.blurRisk === 'high' && f.pick !== 'selected').map((f) => f.path),
                pick: 'rejected',
              })}
              className="px-2 py-1 text-[10px] rounded-md bg-red-500/10 text-red-300 hover:bg-red-500/20 transition-colors shrink-0"
              title={`Reject all high blur-risk photos that aren't already picked. ${reviewStats.blur} at risk.`}
            >
              Reject Blur
            </button>
          )}
          {files.some((f) => (f.burstId && f.burstSize && f.burstSize > 1) || (f.visualGroupId && f.visualGroupSize && f.visualGroupSize > 1)) && (
            <button
              onClick={() => dispatch({ type: 'AUTO_CULL_SAFE' })}
              className="px-2 py-1 text-[10px] rounded-md bg-surface-raised text-text-muted hover:text-red-300 transition-colors shrink-0"
              title="Auto-reject clearly worse shots in bursts/similar groups when a strong keeper exists. Never touches protected, starred, or already-picked files. Undo: Ctrl+Z."
            >
              Safe Cull
            </button>
          )}
          {burstGrouping && burstIds.size > 0 && (
            <button
              onClick={() => dispatch({ type: 'PICK_BEST_IN_GROUPS' })}
              className="px-2 py-1 text-[10px] rounded-md bg-surface-raised text-text-muted hover:text-yellow-300 transition-colors shrink-0"
              title="Pick the top-scored shot in each burst/group and reject the rest."
            >
              Pick Burst Best
            </button>
          )}
          {duplicateCount > 0 && (
            <button
              onClick={() => {
                dispatch({ type: 'SET_FILTER', filter: 'near-duplicates' });
                dispatch({ type: 'SET_VIEW_MODE', mode: 'compare' });
              }}
              className="px-2 py-1 text-[10px] rounded-md bg-surface-raised text-text-muted hover:text-blue-300 transition-colors shrink-0"
              title="Compare near-duplicate photos side-by-side to keep one and reject the rest."
            >
              Dupes ({duplicateCount})
            </button>
          )}
          <span
            className="px-2 py-1 text-[10px] rounded-md bg-surface-raised text-text-faint shrink-0 cursor-default"
            title={`Preview cache: ${cacheStats.cached} cached, ${cacheStats.decoded} decoded, ${cacheStats.inflight} in-flight, ${cacheStats.queued} queued.`}
          >
            Cache {cacheStats.cached}
          </span>
        </>
      )}
    </div>
  ) : null;

  return (
    <div className="h-full flex flex-col relative">
      {showShortcuts && <ShortcutsOverlay onClose={() => setShowShortcuts(false)} />}
      {showBestOfSelection && bestPanelFiles.length > 0 && (
        <BestOfSelectionPanel
          files={bestPanelFiles}
          title={bestScope?.title}
          subtitle={bestScope?.subtitle}
          isBurst={bestScope?.title === 'Best of Burst'}
          onPrevBurst={() => openAdjacentBurst(-1)}
          onNextBurst={() => openAdjacentBurst(1)}
          isBatch={bestScope?.title === 'Best of Batch'}
          onPrevBatch={() => openAdjacentBatch(-1)}
          onNextBatch={() => openAdjacentBatch(1)}
          onClose={() => {
            setShowBestOfSelection(false);
            setBestScope(null);
          }}
          onPickFile={(file, pick) => dispatch({ type: 'SET_PICK', filePath: file.path, pick })}
          onPickBest={(file) => {
            dispatch({ type: 'SET_PICK', filePath: file.path, pick: 'selected' });
            setFocused(sortedFiles.findIndex((f) => f.path === file.path));
          }}
          onQueueBest={(file) => dispatch({ type: 'QUEUE_ADD_PATHS', paths: [file.path] })}
          onRejectRest={(best) => {
            dispatch({
              type: 'SET_PICK_BATCH',
              filePaths: bestPanelFiles.filter((f) => f.path !== best.path).map((f) => f.path),
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
                <button onClick={openBestOfSelection} title="If the focused photo is in a burst, rank that whole burst. Otherwise rank the selected candidates. Shortcut: Shift+B." className="px-2 py-0.5 text-[11px] text-text-secondary hover:text-yellow-300 hover:bg-yellow-500/10 rounded transition-colors">Best</button>
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
                  onClick={() => {
                    dispatch({ type: 'CLEAR_PICKS' });
                    if (filter === 'picked' || filter === 'rejected') dispatch({ type: 'SET_FILTER', filter: 'all' });
                  }}
                  title="Clear all pick/reject flags from every visible file"
                  className="px-2 py-0.5 text-[11px] text-text-secondary hover:text-red-300 hover:bg-red-500/10 rounded transition-colors"
                >Clear All</button>
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
              value={['all', 'picked', 'rejected', 'queue'].includes(filter) ? '' : filter}
              onChange={(e) => {
                if (!e.target.value) return;
                dispatch({ type: 'SET_FILTER', filter: e.target.value as typeof filter });
              }}
              className="px-1 py-0.5 text-[10px] bg-surface border border-border rounded text-text-muted hover:text-text focus:outline-none focus:border-text cursor-pointer"
              title={filter === 'all' ? 'More filters' : `Active filter: ${filter}`}
            >
              <option value="">Filter ▾</option>
              <optgroup label="Status">
                <option value="unmarked">Unmarked</option>
                <option value="protected">Protected</option>
                <option value="unrated">Unrated</option>
                <option value="duplicates">Duplicates</option>
                <option value="best">Best shots</option>
                <option value="faces">Faces detected</option>
                <option value="face-groups">Face groups</option>
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
          <button
            onClick={() => {
              setGroupByFolder((v) => !v);
              // Switch back to grid view if we're not already there
              if (viewMode !== 'grid') dispatch({ type: 'SET_VIEW_MODE', mode: 'grid' });
            }}
            className={`p-0.5 rounded transition-colors ${groupByFolder ? 'text-text bg-surface-raised' : 'text-text-muted hover:text-text'}`}
            title="Folder view — group files by directory, ranked by ★ rating"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M2 6a2 2 0 012-2h4l2 2h4a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" clipRule="evenodd" />
            </svg>
          </button>
        </div>

        <div className="w-px h-3 bg-border mx-1 shrink-0" />

        {/* Settings */}
        <button
          onClick={() => dispatch({ type: 'SET_VIEW_MODE', mode: 'settings' })}
          className="p-0.5 rounded transition-colors shrink-0 text-text-muted hover:text-text"
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
        {viewMode === 'compare' ? (
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
                    index={i}
                    file={file}
                    focused={i === focusedIndex}
                    selected={selectedIndices.has(i)}
                    queued={queuedSet.has(file.path)}
                    forceLoad={forceVisibleThumbnails(i, file.path)}
                    exposurePreviewStops={getThumbnailExposureStops(file)}
                    isBurstBest={false}
                    compact
                    frameNumber={i + 1}
                    burstCollapsed={!!file.burstId && collapsedSet.has(file.burstId)}
                    onBurstToggle={handleBurstToggle}
                    onClickCard={handleCardClick}
                    onDoubleClickCard={setFocused}
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
              {folderGroups ? (
                /* ── Folder view: one section per sub-directory, ranked by ★ ── */
                <div className="flex flex-col gap-8">
                  {folderGroups.length > 1 && (
                    <div className="sticky top-0 z-20 -mb-4 flex items-center gap-2 border-b border-border bg-surface/95 py-2">
                      <span className="text-[11px] text-text-secondary">{folderGroups.length} folders</span>
                      <button
                        onClick={() => setCollapsedFolders(new Set(folderGroups.map(([folder]) => folder)))}
                        className="rounded bg-surface-raised px-2 py-1 text-[10px] text-text-muted hover:text-text"
                      >
                        Collapse all
                      </button>
                      <button
                        onClick={() => setCollapsedFolders(new Set())}
                        className="rounded bg-surface-raised px-2 py-1 text-[10px] text-text-muted hover:text-text"
                      >
                        Expand all
                      </button>
                    </div>
                  )}
                  {folderGroups.map(([folder, folderFiles]) => {
                    const collapsed = collapsedFolders.has(folder);
                    const ratedFiles = folderFiles.filter((f) => (f.rating ?? 0) > 0);
                    const avgRating = ratedFiles.length > 0
                      ? ratedFiles.reduce((s, f) => s + (f.rating ?? 0), 0) / ratedFiles.length
                      : 0;
                    const maxRating = ratedFiles.length > 0
                      ? Math.max(...ratedFiles.map((f) => f.rating ?? 0))
                      : 0;
                    return (
                      <div key={folder}>
                        {/* Folder header */}
                        <button
                          type="button"
                          onClick={() => {
                            setCollapsedFolders((prev) => {
                              const next = new Set(prev);
                              if (next.has(folder)) next.delete(folder);
                              else next.add(folder);
                              return next;
                            });
                          }}
                          className="flex w-full items-center gap-2 mb-2 pb-1 border-b border-border sticky top-0 bg-surface z-10 pt-1 text-left hover:bg-surface-alt/40"
                          title={collapsed ? 'Expand folder' : 'Collapse folder'}
                        >
                          <svg className={`w-3 h-3 text-text-muted shrink-0 transition-transform ${collapsed ? '-rotate-90' : ''}`} viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
                          </svg>
                          <svg className="w-3.5 h-3.5 text-text-muted shrink-0" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M2 6a2 2 0 012-2h4l2 2h4a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" clipRule="evenodd" />
                          </svg>
                          <span className="text-xs font-medium text-text-secondary font-mono truncate" title={folder}>
                            {folder || '(root)'}
                          </span>
                          <span className="text-[10px] text-text-muted shrink-0">
                            {folderFiles.length} file{folderFiles.length !== 1 ? 's' : ''}
                          </span>
                          {ratedFiles.length > 0 && (
                            <span
                              className="text-[10px] text-yellow-400 shrink-0"
                              title={`${ratedFiles.length} rated · avg ${avgRating.toFixed(1)}★ · best ${maxRating}★`}
                            >
                              {'★'.repeat(maxRating)}{'☆'.repeat(5 - maxRating)} best · avg {avgRating.toFixed(1)}★
                            </span>
                          )}
                        </button>
                        {/* Thumbnail grid for this folder */}
                        {!collapsed && (
                        <div className="thumbnail-grid grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
                          {folderFiles.map((file) => {
                            const i = pathToSortedIndex.get(file.path) ?? -1;
                            return (
                              <ThumbnailCard
                                key={file.path}
                                index={i}
                                file={file}
                                focused={i === focusedIndex}
                                selected={selectedIndices.has(i)}
                                queued={queuedSet.has(file.path)}
                                forceLoad={forceVisibleThumbnails(i, file.path)}
                                exposurePreviewStops={getThumbnailExposureStops(file)}
                                isBurstBest={false}
                                burstCollapsed={!!file.burstId && collapsedSet.has(file.burstId)}
                                onBurstToggle={handleBurstToggle}
                                onClickCard={handleCardClick}
                                onDoubleClickCard={handleGridDoubleClick}
                              />
                            );
                          })}
                        </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                /* ── Normal flat grid ── */
                <div
                  ref={gridRef}
                  className="thumbnail-grid grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3"
                >
                  {sortedFiles.map((file, i) => (
                    <ThumbnailCard
                      key={file.path}
                      index={i}
                      file={file}
                      focused={i === focusedIndex}
                      selected={selectedIndices.has(i)}
                      queued={queuedSet.has(file.path)}
                      forceLoad={forceVisibleThumbnails(i, file.path)}
                      exposurePreviewStops={getThumbnailExposureStops(file)}
                      isBurstBest={false}
                      burstCollapsed={!!file.burstId && collapsedSet.has(file.burstId)}
                      onBurstToggle={handleBurstToggle}
                      onClickCard={handleCardClick}
                      onDoubleClickCard={handleGridDoubleClick}
                    />
                  ))}
                </div>
              )}
            </div>
            {floatingToolbar}
          </div>
        )}
      </div>
    </div>
  );
}
