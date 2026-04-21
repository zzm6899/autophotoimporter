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
 * Clamp an exposure delta to keep the user from accidentally asking for
 * something absurd (e.g. anchor is a blown-out sky and the shot is a
 * shadow). Default bound is ±2 stops.
 */
export function clampStops(stops: number, maxStops: number): number {
  if (!Number.isFinite(stops)) return 0;
  return Math.max(-maxStops, Math.min(maxStops, stops));
}
