import { describe, expect, it, vi } from 'vitest';

const poseMocks = vi.hoisted(() => ({
  dispose: vi.fn(async () => undefined),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp',
  },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true }),
    createFromBuffer: () => ({ isEmpty: () => true }),
    createFromBitmap: () => ({ isEmpty: () => false }),
  },
}));

vi.mock('../pose-engine', async (importOriginal) => {
  const original = await importOriginal<typeof import('../pose-engine')>();
  return {
    ...original,
    disposePoseEngine: poseMocks.dispose,
  };
});

vi.mock('exifr', () => ({
  default: {
    parse: vi.fn().mockResolvedValue(null),
    thumbnail: vi.fn().mockResolvedValue(null),
  },
}));

import { disposeFaceEngine } from '../face-engine';

describe('face/pose session lifecycle', () => {
  it('releases the pose session whenever the owning face engine is disposed', async () => {
    const shutdown = disposeFaceEngine();
    // The pose generation must be captured before disposal reaches any await;
    // otherwise a concurrently reloaded pose session could be released by the
    // previous generation's delayed cleanup.
    expect(poseMocks.dispose).toHaveBeenCalledOnce();
    await shutdown;
  });
});
