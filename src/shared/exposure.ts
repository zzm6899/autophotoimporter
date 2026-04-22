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
  const strength = stops > 0 ? 0.68 : 0.82;
  const multiplier = Math.pow(2, stops * strength);
  return Math.max(0.38, Math.min(2.35, multiplier));
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
