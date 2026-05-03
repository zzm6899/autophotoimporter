type PreviewVariant = 'preview' | 'detail';
type PreviewPriority = 'high' | 'normal' | 'low';

const previewCache = new Map<string, string | undefined>();
const previewInflight = new Map<string, {
  id: number;
  priority: PreviewPriority;
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
  priority: PreviewPriority;
  run: () => void;
  cancel: () => void;
}> = [];

const priorityRank: Record<PreviewPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
};

function takeNextQueuedRequest(): (() => void) | undefined {
  const priorityOrder: Array<'high' | 'normal' | 'low'> = ['high', 'normal', 'low'];
  for (const priority of priorityOrder) {
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

function drainQueue(): void {
  while (activeRequests < maxActiveRequests) {
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

function schedule<T>(task: () => Promise<T>, priority: PreviewPriority): Promise<T> {
  if (priority === 'low' && backgroundPaused) {
    return Promise.resolve(undefined as T);
  }
  if (priority === 'low' && activeRequests >= maxActiveRequests && queuedRequests.length >= MAX_QUEUED_REQUESTS) {
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
    const cancel = () => resolve(undefined as T);
    if (activeRequests < maxActiveRequests) {
      run();
    } else if (priority === 'high') {
      queuedRequests.unshift({ priority, run, cancel });
    } else {
      queuedRequests.push({ priority, run, cancel });
    }
  });
}

export function setPreviewConcurrency(concurrency: number): void {
  const next = Number.isFinite(concurrency) ? Math.round(concurrency) : 6;
  maxActiveRequests = Math.max(1, Math.min(12, next));
  drainQueue();
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
  if (existing && priorityRank[existing.priority] >= priorityRank[priority]) {
    return existing.promise;
  }
  const id = ++inflightSeq;
  const promise = schedule(() => window.electronAPI.getPreview(filePath, variant), priority)
    .then((preview) => {
      if (preview !== undefined) {
        rememberPreview(filePath, variant, preview);
      }
      return preview;
    })
    .finally(() => {
      if (previewInflight.get(key)?.id === id) {
        previewInflight.delete(key);
      }
    });
  previewInflight.set(key, { id, priority, promise });
  return promise;
}

export async function decodeImage(src: string): Promise<void> {
  const cacheKey = src.length > 512 ? `${src.slice(0, 64)}:${src.length}` : src;
  if (decodedCache.has(cacheKey)) return;
  const img = new Image();
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
