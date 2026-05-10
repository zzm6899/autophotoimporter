import type { MediaFile } from './types';

/**
 * Burst grouping heuristic.
 *
 * We consider two shots part of the same burst when they are:
 *   1) taken by the same known camera model (Make + Model when available), AND
 *   2) within `windowSec` of the previous shot from that camera.
 *
 * Camera streams are clustered independently so interleaved photos from a
 * second body do not split a real burst from the first body.
 *
 * Videos are never in a burst. Photos without a parseable `dateTaken` are
 * never in a burst (we'd just be grouping random files).
 *
 * A single isolated shot gets NO burst ID — only groups of >=2 qualify.
 *
 * The ID itself is deterministic from the first file's path so the same scan
 * always produces the same IDs. That matters for stable React keys and for
 * tests.
 */
export interface BurstOptions {
  windowSec: number;
  /** Minimum shots before a cluster becomes a "burst". Default 2. */
  minSize?: number;
}

/**
 * Annotate files in-place-ish (returns a new array, doesn't mutate input).
 * Caller should replace state.files with the result.
 */
export function groupBursts(files: MediaFile[], opts: BurstOptions): MediaFile[] {
  const { windowSec } = opts;
  const minSize = opts.minSize ?? 2;
  const windowMs = windowSec * 1000;

  // Only photos with a timestamp are candidates.
  // Cache timestamps to avoid redundant Date.parse calls during sort + loop.
  const tsCache = new Map<string, number>();
  const getTs = (dateTaken: string): number => {
    let t = tsCache.get(dateTaken);
    if (t === undefined) {
      t = Date.parse(dateTaken);
      tsCache.set(dateTaken, t);
    }
    return t;
  };

  const cameraKey = (f: MediaFile): string | null => {
    const make = f.cameraMake?.trim().toLowerCase() ?? '';
    const model = f.cameraModel?.trim().toLowerCase() ?? '';
    // Require a model identifier. Make-only is not specific enough — different
    // camera bodies from the same manufacturer share the make field and would
    // be incorrectly merged into the same burst group.
    if (!model) return null;
    return `${make}|${model}`;
  };

  type Candidate = { file: MediaFile; idx: number; ts: number };
  const candidatesByCamera = new Map<string, Candidate[]>();
  files.forEach((file, idx) => {
    if (file.type !== 'photo' || !file.dateTaken) return;
    const ts = getTs(file.dateTaken);
    if (!Number.isFinite(ts)) return;
    const key = cameraKey(file);
    if (!key) return;
    const candidate = { file, idx, ts };
    const cameraCandidates = candidatesByCamera.get(key);
    if (cameraCandidates) cameraCandidates.push(candidate);
    else candidatesByCamera.set(key, [candidate]);
  });

  // Map from original index → { burstId, burstIndex, burstSize }.
  const annotations = new Map<number, { burstId: string; burstIndex: number; burstSize: number }>();

  let cluster: Candidate[] = [];
  const flush = () => {
    if (cluster.length >= minSize) {
      const first = cluster[0];
      // Stable ID: capture timestamp + short hash-ish of the first path.
      const burstId = `burst_${first.ts}_${hash32(first.file.path)}`;
      const size = cluster.length;
      cluster.forEach((entry, i) => {
        annotations.set(entry.idx, {
          burstId,
          burstIndex: i + 1,
          burstSize: size,
        });
      });
    }
    cluster = [];
  };

  for (const candidates of candidatesByCamera.values()) {
    candidates.sort((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts;
      // Tiebreak by path so the order is deterministic.
      return a.file.path.localeCompare(b.file.path);
    });

    cluster = [];
    for (const c of candidates) {
      if (cluster.length === 0) {
        cluster.push(c);
        continue;
      }
      const prev = cluster[cluster.length - 1];
      const inWindow = c.ts - prev.ts <= windowMs;
      if (inWindow) {
        cluster.push(c);
      } else {
        flush();
        cluster.push(c);
      }
    }
    flush();
  }

  if (annotations.size === 0) {
    // Either no bursts detected or we need to still strip prior burst data.
    return files.map((f) => {
      if (f.burstId !== undefined || f.burstIndex !== undefined || f.burstSize !== undefined) {
        const { burstId: _b, burstIndex: _i, burstSize: _s, ...rest } = f;
        return rest;
      }
      return f;
    });
  }

  return files.map((f, i) => {
    const ann = annotations.get(i);
    if (ann) return { ...f, ...ann };
    // Strip stale burst data if the file is no longer in a cluster.
    if (f.burstId !== undefined || f.burstIndex !== undefined || f.burstSize !== undefined) {
      const { burstId: _b, burstIndex: _i, burstSize: _s, ...rest } = f;
      return rest;
    }
    return f;
  });
}

// Tiny 32-bit hash — enough to disambiguate burst IDs within a scan.
function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
