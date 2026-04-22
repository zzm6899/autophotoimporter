const previewCache = new Map<string, string | undefined>();
const previewInflight = new Map<string, Promise<string | undefined>>();

export function getCachedPreview(filePath: string): Promise<string | undefined> {
  if (previewCache.has(filePath)) {
    return Promise.resolve(previewCache.get(filePath));
  }
  const existing = previewInflight.get(filePath);
  if (existing) return existing;
  const promise = window.electronAPI.getPreview(filePath)
    .then((preview) => {
      previewCache.set(filePath, preview);
      return preview;
    })
    .finally(() => {
      previewInflight.delete(filePath);
    });
  previewInflight.set(filePath, promise);
  return promise;
}

export async function decodeImage(src: string): Promise<void> {
  const img = new Image();
  img.src = src;
  if (typeof img.decode === 'function') {
    await img.decode();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Image decode failed'));
  });
}
