import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp',
  },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true }),
    createFromBuffer: () => ({ isEmpty: () => true }),
  },
}));

vi.mock('exifr', () => ({
  default: {
    thumbnail: vi.fn().mockResolvedValue(null),
  },
}));

import { choosePreferredProvider } from '../face-engine';

describe('face-engine provider planning', () => {
  it('uses DirectML on Windows when benchmarked faster', () => {
    expect(choosePreferredProvider({
      model: 'detector',
      gpuEnabled: true,
      platform: 'win32',
      cpuAvgMs: 18,
      dmlAvgMs: 2,
    })).toEqual({ provider: 'dml' });
  });

  it('falls back to CPU when DirectML is slower', () => {
    const choice = choosePreferredProvider({
      model: 'embedder',
      gpuEnabled: true,
      platform: 'win32',
      cpuAvgMs: 4,
      dmlAvgMs: 5,
    });
    expect(choice.provider).toBe('cpu');
    expect(choice.fallbackReason).toContain('not faster');
  });

  it('keeps person detection on CPU', () => {
    const choice = choosePreferredProvider({
      model: 'person',
      gpuEnabled: true,
      platform: 'win32',
      cpuAvgMs: 16,
      dmlAvgMs: 2,
    });
    expect(choice.provider).toBe('cpu');
    expect(choice.fallbackReason).toContain('person detector');
  });

  it('falls back to CPU when DirectML fails', () => {
    const choice = choosePreferredProvider({
      model: 'detector',
      gpuEnabled: true,
      platform: 'win32',
      cpuAvgMs: 12,
      dmlError: 'DML provider unavailable',
    });
    expect(choice).toEqual({ provider: 'cpu', fallbackReason: 'DML provider unavailable' });
  });
});
