import { beforeEach, describe, expect, it, vi } from 'vitest';

type PreviewCacheModule = typeof import('../previewCache');

async function loadPreviewCache(): Promise<PreviewCacheModule> {
  vi.resetModules();
  return import('../previewCache');
}

function installPreviewMock(
  implementation: (filePath: string, variant: 'preview' | 'detail') => Promise<string | undefined>,
): void {
  vi.stubGlobal('window', {
    electronAPI: {
      getPreview: vi.fn(implementation),
    },
  });
}

describe('previewCache scheduler', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('settles queued low-priority preview requests when background loading is paused', async () => {
    installPreviewMock(() => new Promise<string | undefined>(() => undefined));
    const { getCachedPreview, setBackgroundPreviewPaused } = await loadPreviewCache();

    for (let i = 0; i < 6; i++) {
      void getCachedPreview(`active-${i}.jpg`, 'preview', 'normal');
    }

    const queuedLowPriority = getCachedPreview('queued-low.jpg', 'preview', 'low');
    setBackgroundPreviewPaused(true);

    await expect(queuedLowPriority).resolves.toBeUndefined();
  });

  it('starts queued high-priority preview requests before normal and low work', async () => {
    const activeResolvers: Array<(value: string | undefined) => void> = [];
    const requestedPaths: string[] = [];
    installPreviewMock((filePath) => {
      requestedPaths.push(filePath);
      return new Promise<string | undefined>((resolve) => {
        activeResolvers.push(resolve);
      });
    });
    const { getCachedPreview } = await loadPreviewCache();

    for (let i = 0; i < 6; i++) {
      void getCachedPreview(`active-${i}.jpg`, 'preview', 'normal');
    }
    void getCachedPreview('queued-low.jpg', 'preview', 'low');
    void getCachedPreview('queued-normal.jpg', 'preview', 'normal');
    const highPriority = getCachedPreview('queued-high.jpg', 'preview', 'high');

    activeResolvers[0]('done');
    await Promise.resolve();
    await Promise.resolve();

    expect(requestedPaths).toContain('queued-high.jpg');
    expect(requestedPaths).not.toContain('queued-normal.jpg');
    expect(requestedPaths).not.toContain('queued-low.jpg');

    activeResolvers[6]('high-done');
    await expect(highPriority).resolves.toBe('high-done');
  });

  it('does not reuse a queued low-priority warmup for a later high-priority request', async () => {
    const activeResolvers: Array<(value: string | undefined) => void> = [];
    const requestedPaths: string[] = [];
    installPreviewMock((filePath) => {
      requestedPaths.push(filePath);
      return new Promise<string | undefined>((resolve) => {
        activeResolvers.push(resolve);
      });
    });
    const { getCachedPreview } = await loadPreviewCache();

    for (let i = 0; i < 6; i++) {
      void getCachedPreview(`active-${i}.jpg`, 'preview', 'normal');
    }

    const lowPriority = getCachedPreview('same-file.jpg', 'preview', 'low');
    const highPriority = getCachedPreview('same-file.jpg', 'preview', 'high');

    activeResolvers[0]('done');
    await Promise.resolve();
    await Promise.resolve();

    expect(requestedPaths).toContain('same-file.jpg');
    expect(requestedPaths[6]).toBe('same-file.jpg');

    activeResolvers[6]('focused-preview');
    await expect(highPriority).resolves.toBe('focused-preview');
    expect(lowPriority).not.toBe(highPriority);
  });

  it('uses configured preview concurrency to drain queued requests', async () => {
    const activeResolvers: Array<(value: string | undefined) => void> = [];
    const requestedPaths: string[] = [];
    installPreviewMock((filePath) => {
      requestedPaths.push(filePath);
      return new Promise<string | undefined>((resolve) => {
        activeResolvers.push(resolve);
      });
    });
    const { getCachedPreview, setPreviewConcurrency, getPreviewCacheStats } = await loadPreviewCache();

    setPreviewConcurrency(2);
    void getCachedPreview('active-a.jpg', 'preview', 'normal');
    void getCachedPreview('active-b.jpg', 'preview', 'normal');
    void getCachedPreview('queued-a.jpg', 'preview', 'normal');
    void getCachedPreview('queued-b.jpg', 'preview', 'normal');

    expect(getPreviewCacheStats().active).toBe(2);
    expect(requestedPaths).toEqual(['active-a.jpg', 'active-b.jpg']);

    setPreviewConcurrency(4);
    await Promise.resolve();

    expect(getPreviewCacheStats().active).toBe(4);
    expect(requestedPaths).toEqual(['active-a.jpg', 'active-b.jpg', 'queued-a.jpg', 'queued-b.jpg']);

    activeResolvers.forEach((resolve, index) => resolve(`done-${index}`));
  });
});
