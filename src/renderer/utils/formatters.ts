import type { MediaFile } from '../../shared/types';

/** Format bytes as GB/MB (e.g. "2.50 GB", "500 MB") */
export function formatSize(bytes: number): string {
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(bytes / 1e6).toFixed(0)} MB`;
}

/** Format milliseconds as duration (e.g. "45s", "2m 5s") */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}

/** Format bytes as KB/MB for thumbnails (e.g. "500 KB", "5.5 MB") */
export function formatFileSize(bytes: number): string {
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(0)} KB`;
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

export function fmtAperture(v: number): string {
  return v % 1 === 0 ? `f/${v}` : `f/${v.toFixed(1)}`;
}

export function fmtShutter(v: number): string {
  return v < 1 ? `1/${Math.round(1 / v)}s` : `${v}s`;
}

export function fmtFocal(v: number): string {
  return `${Math.round(v)}mm`;
}

/** Full exposure string with focal length and ISO prefix (for SingleView) */
export function buildExposure(file: MediaFile): string | null {
  const parts: string[] = [];
  if (file.aperture != null) parts.push(fmtAperture(file.aperture));
  if (file.shutterSpeed != null) parts.push(fmtShutter(file.shutterSpeed));
  if (file.iso != null) parts.push(`ISO ${file.iso}`);
  if (file.focalLength != null) parts.push(fmtFocal(file.focalLength));
  return parts.length > 0 ? parts.join(' \u00b7 ') : null;
}

/** Compact exposure string without focal length, no ISO prefix (for ThumbnailCard) */
export function formatExposure(file: MediaFile): string | null {
  const parts: string[] = [];
  if (file.aperture != null) parts.push(fmtAperture(file.aperture));
  if (file.shutterSpeed != null) {
    // Omit trailing 's' for fast speeds to keep it compact (e.g. "1/250" not "1/250s")
    const s = fmtShutter(file.shutterSpeed);
    parts.push(file.shutterSpeed < 1 ? s.replace(/s$/, '') : s);
  }
  if (file.iso != null) parts.push(String(file.iso));
  return parts.length > 0 ? parts.join(' ') : null;
}

export function isPortrait(orientation?: number): boolean {
  return orientation !== undefined && orientation >= 5 && orientation <= 8;
}

/** Format bytes/sec as a human-readable transfer speed (e.g. "42.3 MB/s", "850 KB/s") */
export function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec >= 1e9) return `${(bytesPerSec / 1e9).toFixed(1)} GB/s`;
  if (bytesPerSec >= 1e6) return `${(bytesPerSec / 1e6).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1e3) return `${(bytesPerSec / 1e3).toFixed(0)} KB/s`;
  return `${bytesPerSec} B/s`;
}

/** Format seconds as a short ETA string (e.g. "< 1s", "45s", "2m 5s") */
export function formatEta(seconds: number): string {
  if (seconds < 1) return '< 1s';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}
