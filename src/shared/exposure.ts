/**
 * Photographic Exposure Value (EV).
 *
 *   EV100 = log2( (N^2 / t) ) - log2( S / 100 )
 *
 * Where:
 *   N = f-number (aperture)
 *   t = shutter speed in seconds
 *   S = ISO
 *
 * Higher EV → more light captured. A two-stop brighter shot has EV higher
 * by 2. We use EV100 (ISO-100-equivalent) so two shots at different ISOs can
 * be compared directly.
 *
 * Returns undefined if any input is missing or non-positive — EV of 0 is a
 * valid value (it means "pretty dim"), so don't use 0 as a sentinel.
 */
export function computeEV100(
  aperture: number | undefined,
  shutterSpeed: number | undefined,
  iso: number | undefined,
): number | undefined {
  if (!aperture || !shutterSpeed || !iso) return undefined;
  if (aperture <= 0 || shutterSpeed <= 0 || iso <= 0) return undefined;
  const baseEV = Math.log2((aperture * aperture) / shutterSpeed);
  const isoAdj = Math.log2(iso / 100);
  // Return two-decimal precision — anything finer is noise from f-stop rounding.
  return Math.round((baseEV - isoAdj) * 100) / 100;
}

/**
 * Human-friendly EV string, e.g. "+0.33 EV" or "-1.67 EV".
 */
export function formatEVDelta(delta: number): string {
  const sign = delta >= 0 ? '+' : '';
  return `${sign}${delta.toFixed(2)} EV`;
}

export function roundExposureStops(stops: number): number {
  if (!Number.isFinite(stops)) return 0;
  return Math.round(stops * 100) / 100;
}

export function normalizeExposureStops(stops: number, zeroSnap = 0.025): number {
  const rounded = roundExposureStops(stops);
  return Math.abs(rounded) < zeroSnap ? 0 : rounded;
}

export function getNormalizedExposureStops(
  fileExposureValue: number | undefined,
  anchorExposureValue: number | undefined,
  maxStops: number,
): number {
  if (typeof fileExposureValue !== 'number' || typeof anchorExposureValue !== 'number') {
    return 0;
  }
  return normalizeExposureStops(clampStops(anchorExposureValue - fileExposureValue, maxStops), 0.01);
}

export function getEffectiveExposureStops(
  manualStops: number | undefined,
  fileExposureValue: number | undefined,
  anchorExposureValue: number | undefined,
  normalizeToAnchor: boolean | undefined,
  maxStops: number,
): number {
  const normalizedStops = normalizeToAnchor
    ? getNormalizedExposureStops(fileExposureValue, anchorExposureValue, maxStops)
    : 0;
  return normalizeExposureStops(
    clampStops(normalizedStops + (manualStops ?? 0), maxStops),
    0.01,
  );
}

/**
 * Convert a delta in stops to a linear brightness multiplier.
 *   +1 stop  = 2x brighter
 *   -1 stop  = 0.5x
 */
export function stopsToMultiplier(stops: number): number {
  return Math.pow(2, stops);
}

/**
 * Display/import-safe exposure multiplier for already-rendered JPEG-like RGB.
 *
 * A literal +1EV = 2x multiply is correct in linear raw data, but too harsh
 * for gamma-encoded thumbnails/JPEGs and clips highlights quickly. This keeps
 * the direction photographic while compressing the adjustment so preview/import
 * changes remain usable on rendered files.
 */
export function stopsToSafeMultiplier(stops: number): number {
  if (!Number.isFinite(stops) || Math.abs(stops) < 0.001) return 1;
  const direction = stops >= 0 ? 1 : -1;
  const magnitude = Math.abs(stops);
  const compressedStops = direction > 0
    ? magnitude / (1 + magnitude * 1.65)
    : magnitude / (1 + magnitude * 0.7);
  const multiplier = Math.pow(2, compressedStops * direction);
  return Math.max(0.56, Math.min(1.48, multiplier));
}

export function getRenderedExposureProfile(stops: number): {
  brightness: number;
  contrast: number;
  saturation: number;
  gamma: number;
} {
  if (!Number.isFinite(stops) || Math.abs(stops) < 0.001) {
    return { brightness: 1, contrast: 1, saturation: 1, gamma: 1 };
  }
  const magnitude = Math.min(Math.abs(stops), 4);
  const brightness = stopsToSafeMultiplier(stops);
  if (stops > 0) {
    return {
      brightness,
      contrast: 1 + Math.min(0.16, magnitude * 0.042),
      saturation: 1 + Math.min(0.07, magnitude * 0.018),
      gamma: Math.max(0.88, 1 - magnitude * 0.032),
    };
  }
  return {
    brightness,
    contrast: 1 + Math.min(0.12, magnitude * 0.03),
    saturation: 1 + Math.min(0.06, magnitude * 0.016),
    gamma: Math.min(1.12, 1 + magnitude * 0.028),
  };
}

/**
 * Build a CSS preview filter that keeps EV changes looking photographic
 * instead of flat and washed-out. Brightening gets a little contrast/saturation
 * back so rendered previews stay natural.
 */
export function buildPreviewExposureFilter(stops: number): string | undefined {
  const normalized = normalizeExposureStops(stops, 0.01);
  if (normalized === 0) return undefined;
  const { brightness, contrast, saturation, gamma } = getRenderedExposureProfile(normalized);
  return `brightness(${brightness.toFixed(3)}) contrast(${contrast.toFixed(3)}) saturate(${saturation.toFixed(3)})`;
}

export function buildPreviewWhiteBalanceFilter(
  adjustment?: { temperature?: number; tint?: number } | null,
): string | undefined {
  const normalized = normalizeWhiteBalanceAdjustment(adjustment);
  if (!normalized) return undefined;

  const temperature = normalized.temperature / 100;
  const tint = normalized.tint / 100;
  const hue = temperature * 7 + tint * 5;
  const sepia = Math.min(0.16, Math.abs(temperature) * 0.12 + Math.max(0, tint) * 0.04);
  const saturate = 1 + Math.min(0.12, Math.abs(temperature) * 0.05 + Math.abs(tint) * 0.08);
  const brightness = 1 + Math.max(-0.04, Math.min(0.04, temperature * 0.025 - Math.abs(tint) * 0.012));

  const filters: string[] = [];
  if (sepia > 0.005) filters.push(`sepia(${sepia.toFixed(3)})`);
  if (Math.abs(hue) >= 0.1) filters.push(`hue-rotate(${hue.toFixed(2)}deg)`);
  if (Math.abs(saturate - 1) >= 0.005) filters.push(`saturate(${saturate.toFixed(3)})`);
  if (Math.abs(brightness - 1) >= 0.005) filters.push(`brightness(${brightness.toFixed(3)})`);
  return filters.length > 0 ? filters.join(' ') : undefined;
}

/**
 * Rough clipping estimate for an already-rendered RGB preview after applying
 * a display-safe brightness multiplier. This is intentionally lightweight so
 * the renderer can update it while culling.
 */
export function estimateClippingPercent(
  data: Uint8ClampedArray,
  brightness = 1,
): { highlights: number; shadows: number } {
  let highlights = 0;
  let shadows = 0;
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] * brightness;
    const g = data[i + 1] * brightness;
    const b = data[i + 2] * brightness;
    const luma = r * 0.299 + g * 0.587 + b * 0.114;
    if (Math.max(r, g, b) >= 250 || luma >= 245) highlights++;
    if (Math.min(r, g, b) <= 5 || luma <= 8) shadows++;
    total++;
  }
  return {
    highlights: total ? Math.round((highlights / total) * 1000) / 10 : 0,
    shadows: total ? Math.round((shadows / total) * 1000) / 10 : 0,
  };
}

/**
 * Clamp an exposure delta to keep the user from accidentally asking for
 * something absurd (e.g. anchor is a blown-out sky and the shot is a
 * shadow). Default bound is ±2 stops.
 */
export function clampStops(stops: number, maxStops: number): number {
  if (!Number.isFinite(stops)) return 0;
  return Math.max(-maxStops, Math.min(maxStops, stops));
}

export interface ChannelMultipliers {
  red: number;
  green: number;
  blue: number;
}

export function clampWhiteBalanceValue(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-100, Math.min(100, value));
}

export const WHITE_BALANCE_NEUTRAL_KELVIN = 5500;
export const WHITE_BALANCE_MIN_KELVIN = 2500;
export const WHITE_BALANCE_MAX_KELVIN = 10000;

export function whiteBalanceTemperatureToKelvin(value: number): number {
  const clamped = clampWhiteBalanceValue(value);
  const kelvin = clamped >= 0
    ? WHITE_BALANCE_NEUTRAL_KELVIN + (clamped / 100) * (WHITE_BALANCE_MAX_KELVIN - WHITE_BALANCE_NEUTRAL_KELVIN)
    : WHITE_BALANCE_NEUTRAL_KELVIN + (clamped / 100) * (WHITE_BALANCE_NEUTRAL_KELVIN - WHITE_BALANCE_MIN_KELVIN);
  return Math.round(kelvin / 50) * 50;
}

export function kelvinToWhiteBalanceTemperature(kelvin: number): number {
  if (!Number.isFinite(kelvin)) return 0;
  const clamped = Math.max(WHITE_BALANCE_MIN_KELVIN, Math.min(WHITE_BALANCE_MAX_KELVIN, kelvin));
  const value = clamped >= WHITE_BALANCE_NEUTRAL_KELVIN
    ? ((clamped - WHITE_BALANCE_NEUTRAL_KELVIN) / (WHITE_BALANCE_MAX_KELVIN - WHITE_BALANCE_NEUTRAL_KELVIN)) * 100
    : ((clamped - WHITE_BALANCE_NEUTRAL_KELVIN) / (WHITE_BALANCE_NEUTRAL_KELVIN - WHITE_BALANCE_MIN_KELVIN)) * 100;
  return clampWhiteBalanceValue(Math.round(value));
}

export function formatWhiteBalanceKelvin(value: number): string {
  return `${whiteBalanceTemperatureToKelvin(value)}K`;
}

export function normalizeWhiteBalanceAdjustment(
  adjustment?: { temperature?: number; tint?: number } | null,
): { temperature: number; tint: number } | undefined {
  const temperature = clampWhiteBalanceValue(adjustment?.temperature ?? 0);
  const tint = clampWhiteBalanceValue(adjustment?.tint ?? 0);
  if (Math.abs(temperature) < 0.5 && Math.abs(tint) < 0.5) return undefined;
  return { temperature, tint };
}

export function whiteBalanceMultipliers(
  adjustment?: { temperature?: number; tint?: number } | null,
): ChannelMultipliers {
  const normalized = normalizeWhiteBalanceAdjustment(adjustment);
  if (!normalized) return { red: 1, green: 1, blue: 1 };

  const temperature = normalized.temperature / 100;
  const tint = normalized.tint / 100;
  const red = 1 + temperature * 0.18 + Math.max(0, tint) * 0.08;
  const blue = 1 - temperature * 0.18 + Math.max(0, tint) * 0.08;
  const green = 1 - tint * 0.14;
  return {
    red: Math.max(0.72, Math.min(1.32, red)),
    green: Math.max(0.72, Math.min(1.32, green)),
    blue: Math.max(0.72, Math.min(1.32, blue)),
  };
}

export function hasWhiteBalanceAdjustment(adjustment?: { temperature?: number; tint?: number } | null): boolean {
  return !!normalizeWhiteBalanceAdjustment(adjustment);
}
