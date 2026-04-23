const previewCache = new Map<string, string | undefined>();
const previewInflight = new Map<string, Promise<string | undefined>>();
const decodedCache = new Set<string>();
const MAX_PREVIEWS = 16;
const MAX_DECODED = 24;
const MAX_ACTIVE_REQUESTS = 2;
const MAX_QUEUED_REQUESTS = 24;
let activeRequests = 0;
let backgroundPaused = false;
const queuedRequests: Array<() => void> = [];

function rememberPreview(filePath: string, preview: string | undefined): void {
  if (previewCache.has(filePath)) previewCache.delete(filePath);
  previewCache.set(filePath, preview);
  while (previewCache.size > MAX_PREVIEWS) {
    const oldest = previewCache.keys().next().value as string | undefined;
    if (!oldest) break;
    previewCache.delete(oldest);
  }
}

function schedule<T>(task: () => Promise<T>, priority: 'high' | 'normal' | 'low'): Promise<T> {
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
          queuedRequests.shift()?.();
        });
    };
    if (activeRequests < MAX_ACTIVE_REQUESTS) {
      run();
    } else if (priority === 'high') {
      queuedRequests.unshift(run);
    } else {
      queuedRequests.push(run);
    }
  });
}

export function getCachedPreview(
  filePath: string,
  priority: 'high' | 'normal' | 'low' = 'normal',
): Promise<string | undefined> {
  if (previewCache.has(filePath)) {
    return Promise.resolve(previewCache.get(filePath));
  }
  const existing = previewInflight.get(filePath);
  if (existing) return existing;
  const promise = schedule(() => window.electronAPI.getPreview(filePath), priority)
    .then((preview) => {
      rememberPreview(filePath, preview);
      return preview;
    })
    .finally(() => {
      previewInflight.delete(filePath);
    });
  previewInflight.set(filePath, promise);
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
  if (previewCache.has(filePath) || previewInflight.has(filePath)) return;
  void getCachedPreview(filePath, priority)
    .then((src) => src ? decodeImage(src) : undefined)
    .catch(() => undefined);
}

export function setBackgroundPreviewPaused(paused: boolean): void {
  backgroundPaused = paused;
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
