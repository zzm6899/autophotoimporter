import { describe, expect, it } from 'vitest';
import { clampFaceConcurrencyForSettings, recommendFaceConcurrencyTarget } from '../SettingsPage';

describe('recommendFaceConcurrencyTarget', () => {
  it('clamps very fast DirectML recommendations to the runtime cap', () => {
    expect(recommendFaceConcurrencyTarget({
      dmlActive: true,
      avgDmlMs: 4,
      cpuCores: 24,
      tier: 'high',
    })).toBe(8);
  });

  it('keeps older or unstable DirectML devices below the cap', () => {
    expect(recommendFaceConcurrencyTarget({
      dmlActive: true,
      avgDmlMs: 55,
      cpuCores: 8,
      tier: 'high',
    })).toBe(4);
  });

  it('uses conservative targets for balanced and low CPU-only devices', () => {
    expect(recommendFaceConcurrencyTarget({
      dmlActive: false,
      cpuCores: 6,
      tier: 'balanced',
    })).toBe(2);
    expect(recommendFaceConcurrencyTarget({
      dmlActive: false,
      cpuCores: 2,
      tier: 'low',
    })).toBe(1);
  });
});

describe('clampFaceConcurrencyForSettings', () => {
  it('rounds and clamps user-facing face scan settings to the supported range', () => {
    expect(clampFaceConcurrencyForSettings(0)).toBe(1);
    expect(clampFaceConcurrencyForSettings(2.6)).toBe(3);
    expect(clampFaceConcurrencyForSettings(24)).toBe(8);
  });
});
