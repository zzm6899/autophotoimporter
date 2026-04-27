type PreviewVariant = 'preview' | 'detail';

const previewCache = new Map<string, string | undefined>();
const previewInflight = new Map<string, Promise<string | undefined>>();
const decodedCache = new Set<string>();
// Keep enough thumbnails so the review loop always has candidates with f.thumbnail set.
// At 24 the cache evicted photos before analysis could reach them → "stuck at 24".
const MAX_PREVIEWS = 500;
const MAX_DECODED = 600;
// Allow more concurrent preview loads so thumbnails arrive faster and the
// review loop has a steady supply of candidates. Was 2 → limited to ~2 thumbnails/s.
const MAX_ACTIVE_REQUESTS = 6;
const MAX_QUEUED_REQUESTS = 500;
let activeRequests = 0;
let backgroundPaused = false;
const queuedRequests: Array<{ priority: 'high' | 'normal' | 'low'; run: () => void }> = [];

function takeNextQueuedRequest(): (() => void) | undefined {
  for (let i = 0; i < queuedRequests.length; i++) {
    const next = queuedRequests[i];
    if (backgroundPaused && next.priority === 'low') {
      queuedRequests.splice(i, 1);
      i--;
      continue;
    }
    queuedRequests.splice(i, 1);
    return next.run;
  }
  return undefined;
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

function schedule<T>(task: () => Promise<T>, priority: 'high' | 'normal' | 'low'): Promise<T> {
  if (priority === 'low' && backgroundPaused) {
    return Promise.resolve(undefined as T);
  }
  if (priority === 'low' && activeRequests >= MAX_ACTIVE_REQUESTS && queuedRequests.length >= MAX_QUEUED_REQUESTS) {
    return Promise.resolve(undefined as T);
  }
  return new Promise((resolve, reject) => {
    const run = () => {
      activeRequests++;
      task()
        .then(resolve, reject)
        .finally(() => {
          activeRequests--;
          takeNextQueuedRequest()?.();
        });
    };
    if (activeRequests < MAX_ACTIVE_REQUESTS) {
      run();
    } else if (priority === 'high') {
      queuedRequests.unshift({ priority, run });
    } else {
      queuedRequests.push({ priority, run });
    }
  });
}

export function getCachedPreview(
  filePath: string,
  variant: PreviewVariant = 'preview',
  priority: 'high' | 'normal' | 'low' = 'normal',
): Promise<string | undefined> {
  const key = previewKey(filePath, variant);
  if (previewCache.has(key)) {
    return Promise.resolve(previewCache.get(key));
  }
  const existing = previewInflight.get(key);
  if (existing) return existing;
  const promise = schedule(() => window.electronAPI.getPreview(filePath, variant), priority)
    .then((preview) => {
      if (preview !== undefined) {
        rememberPreview(filePath, variant, preview);
      }
      return preview;
    })
    .finally(() => {
      previewInflight.delete(key);
    });
  previewInflight.set(key, promise);
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
    for (let i = queuedRequests.length - 1; i >= 0; i--) {
      if (queuedRequests[i].priority === 'low') queuedRequests.splice(i, 1);
    }
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
  paused: boolean;
} {
  return {
    cached: previewCache.size,
    decoded: decodedCache.size,
    inflight: previewInflight.size,
    active: activeRequests,
    queued: queuedRequests.length,
    paused: backgroundPaused,
  };
}
