import { PREVIEW_PROTOCOL_SCHEME } from '../../shared/types';

type PreviewVariant = 'preview' | 'detail';

// Marks an image element safe for canvas readback when its source is served
// by the preview protocol (which responds with Access-Control-Allow-Origin).
// Without this, drawing a protocol-served image taints the canvas and
// getImageData/toBlob throw.
export function applyCanvasSafeCrossOrigin(img: HTMLImageElement, src: string): void {
  if (src.startsWith(`${PREVIEW_PROTOCOL_SCHEME}:`)) img.crossOrigin = 'anonymous';
}
type PreviewPriority = 'high' | 'normal' | 'low';

const previewCache = new Map<string, string | undefined>();
const previewInflight = new Map<string, {
  id: number;
  priority: PreviewPriority;
  canceled: boolean;
  promise: Promise<string | undefined>;
}>();
const decodedCache = new Set<string>();
// Keep enough thumbnails so the review loop always has candidates with f.thumbnail set.
// At 24 the cache evicted photos before analysis could reach them → "stuck at 24".
const MAX_PREVIEWS = 500;
const MAX_DECODED = 600;
// Runtime-tuned from the Preview Workers setting.
let maxActiveRequests = 6;
const MAX_QUEUED_REQUESTS = 500;
let activeRequests = 0;
let backgroundPaused = false;
let inflightSeq = 0;
const queuedRequests: Array<{
  key?: string;
  priority: PreviewPriority;
  run: () => void;
  cancel: () => void;
}> = [];

const priorityRank: Record<PreviewPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
};

function dropOldestQueuedRequest(maxPriority: PreviewPriority): boolean {
  const maxRank = priorityRank[maxPriority];
  for (let i = 0; i < queuedRequests.length; i++) {
    const next = queuedRequests[i];
    if (priorityRank[next.priority] > maxRank) continue;
    queuedRequests.splice(i, 1);
    next.cancel();
    return true;
  }
  return false;
}

function enqueueQueuedRequest(request: {
  key?: string;
  priority: PreviewPriority;
  run: () => void;
  cancel: () => void;
}): void {
  if (queuedRequests.length >= MAX_QUEUED_REQUESTS) {
    if (request.priority === 'low') {
      request.cancel();
      return;
    }
    const dropped = dropOldestQueuedRequest(request.priority === 'high' ? 'normal' : 'normal');
    if (!dropped && request.priority !== 'high') {
      request.cancel();
      return;
    }
  }

  if (request.priority === 'high') {
    queuedRequests.unshift(request);
  } else {
    queuedRequests.push(request);
  }
}

function takeNextQueuedRequest(): (() => void) | undefined {
  const priorityOrder: Array<'high' | 'normal' | 'low'> = ['high', 'normal', 'low'];
  for (const priority of priorityOrder) {
    if (activeRequests >= activeLimitFor(priority)) continue;
    for (let i = 0; i < queuedRequests.length; i++) {
      const next = queuedRequests[i];
      if (next.priority !== priority) continue;
      if (backgroundPaused && next.priority === 'low') {
        queuedRequests.splice(i, 1);
        next.cancel();
        i--;
        continue;
      }
      queuedRequests.splice(i, 1);
      return next.run;
    }
  }
  return undefined;
}

// High-priority (focused image) requests may borrow one slot beyond the
// configured worker count so culling navigation never waits behind a full
// lane of background warms.
function activeLimitFor(priority: PreviewPriority): number {
  return priority === 'high' ? maxActiveRequests + 1 : maxActiveRequests;
}

function drainQueue(): void {
  for (;;) {
    const run = takeNextQueuedRequest();
    if (!run) return;
    run();
  }
}

function cancelQueuedLowPriorityRequests(): void {
  for (let i = queuedRequests.length - 1; i >= 0; i--) {
    const next = queuedRequests[i];
    if (next.priority === 'low') {
      queuedRequests.splice(i, 1);
      next.cancel();
    }
  }
}

function promoteQueuedRequest(key: string, priority: PreviewPriority): void {
  for (const request of queuedRequests) {
    if (request.key !== key) continue;
    if (priorityRank[priority] > priorityRank[request.priority]) {
      request.priority = priority;
    }
    return;
  }
}

function previewKey(filePath: string, variant: PreviewVariant): string {
  return `${filePath}|${variant}`;
}

function rememberPreview(filePath: string, variant: PreviewVariant, preview: string | undefined): void {
  const key = previewKey(filePath, variant);
  if (previewCache.has(key)) previewCache.delete(key);
  previewCache.set(key, preview);
  while (previewCache.size > MAX_PREVIEWS) {
    const oldest = previewCache.keys().next().value as string | undefined;
    if (!oldest) break;
    previewCache.delete(oldest);
  }
}

function schedule<T>(
  task: () => Promise<T>,
  priority: PreviewPriority,
  key?: string,
  onCanceled?: () => void,
): Promise<T> {
  if (priority === 'low' && backgroundPaused) {
    onCanceled?.();
    return Promise.resolve(undefined as T);
  }
  if (priority === 'low' && activeRequests >= maxActiveRequests && queuedRequests.length >= MAX_QUEUED_REQUESTS) {
    onCanceled?.();
    return Promise.resolve(undefined as T);
  }
  return new Promise((resolve, reject) => {
    const run = () => {
      activeRequests++;
      task()
        .then(resolve, reject)
        .finally(() => {
          activeRequests--;
          drainQueue();
        });
    };
    const cancel = () => {
      onCanceled?.();
      resolve(undefined as T);
    };
    const request = { key, priority, run, cancel };
    if (activeRequests < activeLimitFor(priority)) {
      run();
    } else {
      enqueueQueuedRequest(request);
    }
  });
}

export function setPreviewConcurrency(concurrency: number): void {
  const next = Number.isFinite(concurrency) ? Math.round(concurrency) : 6;
  maxActiveRequests = Math.max(1, Math.min(12, next));
  drainQueue();
}

// Synchronous cache probe — lets views skip debounce delays when the source
// is already resolved (e.g. flipping back to an image just viewed).
export function hasCachedPreview(filePath: string, variant: PreviewVariant = 'preview'): boolean {
  return previewCache.has(previewKey(filePath, variant));
}

export function getCachedPreview(
  filePath: string,
  variant: PreviewVariant = 'preview',
  priority: PreviewPriority = 'normal',
): Promise<string | undefined> {
  const key = previewKey(filePath, variant);
  if (previewCache.has(key)) {
    return Promise.resolve(previewCache.get(key));
  }
  const existing = previewInflight.get(key);
  if (existing) {
    if (existing.canceled && priorityRank[priority] > priorityRank[existing.priority]) {
      previewInflight.delete(key);
    } else {
      if (priorityRank[priority] > priorityRank[existing.priority]) {
        existing.priority = priority;
        promoteQueuedRequest(key, priority);
      }
      return existing.promise;
    }
  }
  const id = ++inflightSeq;
  const entry = {
    id,
    priority,
    canceled: false,
    promise: Promise.resolve(undefined as string | undefined),
  };
  const promise = schedule(
    () => window.electronAPI.getPreview(filePath, variant, priority),
    priority,
    key,
    () => { entry.canceled = true; },
  )
    .then((response) => {
      // Main returns { src } (protocol URL, or data URI when the RAW preview
      // cache is disabled). Plain strings are tolerated for older callers.
      const src = typeof response === 'string' ? response : response?.src;
      if (src !== undefined) {
        rememberPreview(filePath, variant, src);
      }
      return src;
    })
    .finally(() => {
      if (previewInflight.get(key)?.id === id) {
        previewInflight.delete(key);
      }
    });
  entry.promise = promise;
  previewInflight.set(key, entry);
  return promise;
}

export async function decodeImage(src: string): Promise<void> {
  const cacheKey = src.length > 512 ? `${src.slice(0, 64)}:${src.length}` : src;
  if (decodedCache.has(cacheKey)) return;
  const img = new Image();
  applyCanvasSafeCrossOrigin(img, src);
  img.decoding = 'async';
  img.src = src;
  if (typeof img.decode === 'function') {
    await img.decode();
  } else {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Image decode failed'));
    });
  }
  decodedCache.add(cacheKey);
  while (decodedCache.size > MAX_DECODED) {
    const oldest = decodedCache.values().next().value as string | undefined;
    if (!oldest) break;
    decodedCache.delete(oldest);
  }
}

export function warmPreview(filePath: string, priority: 'normal' | 'low' = 'low'): void {
  if (backgroundPaused) return;
  const key = previewKey(filePath, 'preview');
  if (previewCache.has(key) || previewInflight.has(key)) return;
  void getCachedPreview(filePath, 'preview', priority)
    .then((src) => src ? decodeImage(src) : undefined)
    .catch(() => undefined);
}

export function warmPreviews(
  filePaths: string[],
  priority: 'normal' | 'low' = 'low',
  limit = 12,
): void {
  if (backgroundPaused || limit <= 0) return;
  let scheduled = 0;
  const seen = new Set<string>();
  for (const filePath of filePaths) {
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    const key = previewKey(filePath, 'preview');
    if (previewCache.has(key) || previewInflight.has(key)) continue;
    if (priority === 'low' && queuedRequests.length > MAX_QUEUED_REQUESTS * 0.75) break;
    warmPreview(filePath, scheduled === 0 && priority === 'normal' ? 'normal' : priority);
    scheduled++;
    if (scheduled >= limit) break;
  }
}

export function setBackgroundPreviewPaused(paused: boolean): void {
  backgroundPaused = paused;
  if (paused) {
    cancelQueuedLowPriorityRequests();
  }
}

export function isBackgroundPreviewPaused(): boolean {
  return backgroundPaused;
}

export function getPreviewCacheStats(): {
  cached: number;
  decoded: number;
  inflight: number;
  active: number;
  queued: number;
  concurrency: number;
  paused: boolean;
} {
  return {
    cached: previewCache.size,
    decoded: decodedCache.size,
    inflight: previewInflight.size,
    active: activeRequests,
    queued: queuedRequests.length,
    concurrency: maxActiveRequests,
    paused: backgroundPaused,
  };
}
