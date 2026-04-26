/**
 * device-tier.ts
 *
 * Lightweight hardware classifier so the same binary serves both a 4-core
 * laptop and a 24-core workstation without leaving either underused. The
 * tier we pick drives:
 *   - face-engine graphOptimizationLevel ('basic' on low, 'all' otherwise)
 *   - face-engine concurrency hint (renderer reads this and tunes its loop)
 *   - exif-parser RAW preview quality (lower → faster encode)
 *   - renderer thumbnail/preview prefetch concurrency
 *
 * The tier is auto-detected on first launch but the user can override it
 * from Settings → Performance. We persist `perfTier: 'auto' | tier` so the
 * override is sticky.
 */

import os from 'node:os';

export type DeviceTier = 'low' | 'balanced' | 'high';
export type PerfTierSetting = 'auto' | DeviceTier;

export interface DeviceProfile {
  tier: DeviceTier;
  cpuCores: number;
  totalMemGB: number;
  /** Concurrency budget for the renderer's thumbnail / preview prefetch */
  previewConcurrency: number;
  /** Concurrency budget for face analysis batches (always 1 currently — ONNX-node CPU is single-threaded per session) */
  faceConcurrency: number;
  /** Whether to enable cpuOptimizationMode in the face engine */
  cpuOptimization: boolean;
  /** Default RAW preview JPEG quality */
  rawPreviewQuality: number;
}

export function detectDeviceTier(override?: PerfTierSetting): DeviceProfile {
  const cpuCores = Math.max(1, os.cpus()?.length ?? 1);
  const totalMemGB = Math.round((os.totalmem() / 1024 / 1024 / 1024) * 10) / 10;

  let tier: DeviceTier;
  if (override && override !== 'auto') {
    tier = override;
  } else if (cpuCores <= 2 || totalMemGB < 4) {
    tier = 'low';
  } else if (cpuCores >= 8 && totalMemGB >= 12) {
    tier = 'high';
  } else {
    tier = 'balanced';
  }

  const profile: DeviceProfile = (() => {
    switch (tier) {
      case 'low':
        return {
          tier,
          cpuCores,
          totalMemGB,
          previewConcurrency: 1,
          faceConcurrency: 1,
          cpuOptimization: true,
          rawPreviewQuality: 55,
        };
      case 'high':
        return {
          tier,
          cpuCores,
          totalMemGB,
          previewConcurrency: Math.min(6, Math.max(3, Math.floor(cpuCores / 3))),
          faceConcurrency: 1,
          cpuOptimization: false,
          rawPreviewQuality: 80,
        };
      case 'balanced':
      default:
        return {
          tier: 'balanced',
          cpuCores,
          totalMemGB,
          previewConcurrency: Math.min(3, Math.max(2, Math.floor(cpuCores / 4))),
          faceConcurrency: 1,
          cpuOptimization: false,
          rawPreviewQuality: 70,
        };
    }
  })();

  return profile;
}

/**
 * Side-effecting application of the profile. Calls into face-engine and
 * exif-parser to update their runtime configuration. Returns the profile
 * for caller logging / IPC echo.
 *
 * The functions are passed in to avoid a circular import (device-tier
 * doesn't depend on face-engine's heavy onnxruntime require chain).
 */
export function applyDeviceTier(
  profile: DeviceProfile,
  hooks: {
    setCpuOptimization: (enabled: boolean) => void;
    setRawPreviewQuality: (q: number) => void;
  },
  /**
   * If the user has explicitly set their own value for either of these in
   * Settings, pass `manualOverrides` so we don't clobber it.
   */
  manualOverrides?: { cpuOptimization?: boolean; rawPreviewQuality?: number },
): DeviceProfile {
  const cpuOpt = manualOverrides?.cpuOptimization ?? profile.cpuOptimization;
  const rawQ = manualOverrides?.rawPreviewQuality ?? profile.rawPreviewQuality;
  hooks.setCpuOptimization(cpuOpt);
  hooks.setRawPreviewQuality(rawQ);
  return { ...profile, cpuOptimization: cpuOpt, rawPreviewQuality: rawQ };
}
