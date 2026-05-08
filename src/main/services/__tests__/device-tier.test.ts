import { afterEach, describe, expect, it, vi } from 'vitest';

const mockOs = vi.hoisted(() => ({
  cpus: vi.fn(),
  totalmem: vi.fn(),
}));

vi.mock('node:os', () => ({
  default: mockOs,
  cpus: mockOs.cpus,
  totalmem: mockOs.totalmem,
}));

import { applyDeviceTier, detectDeviceTier } from '../device-tier';

function setHardware(cpuCores: number, totalMemGB: number) {
  mockOs.cpus.mockReturnValue(Array.from({ length: cpuCores }, () => ({})));
  mockOs.totalmem.mockReturnValue(totalMemGB * 1024 * 1024 * 1024);
}

describe('detectDeviceTier', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('keeps low-end PCs conservative', () => {
    setHardware(2, 8);

    const profile = detectDeviceTier();

    expect(profile).toEqual({
      tier: 'low',
      cpuCores: 2,
      totalMemGB: 8,
      previewConcurrency: 1,
      faceConcurrency: 1,
      cpuOptimization: true,
      rawPreviewQuality: 55,
    });
  });

  it('keeps memory-starved multi-core PCs conservative', () => {
    setHardware(8, 3.5);

    const profile = detectDeviceTier();

    expect(profile).toEqual({
      tier: 'low',
      cpuCores: 8,
      totalMemGB: 3.5,
      previewConcurrency: 1,
      faceConcurrency: 1,
      cpuOptimization: true,
      rawPreviewQuality: 55,
    });
  });

  it('uses high-end concurrency without exceeding the built-in caps', () => {
    setHardware(24, 32);

    const profile = detectDeviceTier();

    expect(profile.tier).toBe('high');
    expect(profile.previewConcurrency).toBe(6);
    expect(profile.faceConcurrency).toBe(6);
    expect(profile.cpuOptimization).toBe(false);
    expect(profile.rawPreviewQuality).toBe(80);
  });

  it('uses balanced defaults between low and high hardware', () => {
    setHardware(6, 8);

    const profile = detectDeviceTier();

    expect(profile.tier).toBe('balanced');
    expect(profile.previewConcurrency).toBe(2);
    expect(profile.faceConcurrency).toBe(2);
    expect(profile.rawPreviewQuality).toBe(70);
  });

  it('applies manual profile overrides without losing explicit runtime settings', () => {
    const hooks = {
      setCpuOptimization: vi.fn(),
      setRawPreviewQuality: vi.fn(),
    };

    const applied = applyDeviceTier(
      {
        tier: 'low',
        cpuCores: 2,
        totalMemGB: 8,
        previewConcurrency: 1,
        faceConcurrency: 1,
        cpuOptimization: true,
        rawPreviewQuality: 55,
      },
      hooks,
      { cpuOptimization: false, rawPreviewQuality: 70 },
    );

    expect(hooks.setCpuOptimization).toHaveBeenCalledWith(false);
    expect(hooks.setRawPreviewQuality).toHaveBeenCalledWith(70);
    expect(applied.cpuOptimization).toBe(false);
    expect(applied.rawPreviewQuality).toBe(70);
  });
});
