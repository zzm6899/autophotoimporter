/**
 * face-cache.ts
 *
 * Persistent on-disk cache for face analysis results. Solves the "switch
 * source → 3000 ms per image again" regression: when the user revisits a
 * folder (or rescans the same SD card) the ONNX inference results are
 * restored from disk in microseconds instead of being recomputed.
 *
 * Cache key: md5(absPath + mtimeMs + size). Same shape as exif-parser's
 * thumbnail cache so a file rename or a content edit invalidates the entry.
 *
 * Layout on disk:
 *   <userData>/face-cache/<keyPrefix>/<key>.json
 *
 * Each entry stores the FaceAnalysisResult, the schema version, and the
 * cache key inputs so we can detect collisions / stale schema.
 *
 * The cache is bounded (LRU-ish) by total entry count — old entries are
 * pruned when the count exceeds MAX_ENTRIES on a write.
 */

import path from 'node:path';
import { stat, readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { app } from 'electron';
import crypto from 'node:crypto';
import type { FaceAnalysisResult, FaceBox } from './face-engine';

const SCHEMA_VERSION = 1;
const MAX_ENTRIES = 50_000;       // ~50k photos worth of cached face data
const PRUNE_BATCH = 5_000;        // remove this many oldest entries when over the cap

interface CachedEntry {
  v: number;             // schema version
  key: string;           // hash key (also the filename minus .json)
  path: string;          // for debug/audit
  size: number;          // input file size at cache time
  mtimeMs: number;       // input file mtime at cache time
  cachedAt: number;      // Date.now() when written, for LRU pruning
  boxes: FaceBox[];
  personBoxes: FaceBox[];
  embeddings: string[];  // hex-serialised, matches the IPC wire format
}

let cacheDirPromise: Promise<string> | null = null;
let inMemoryHits = new Map<string, CachedEntry>(); // process-lifetime fast path
const MAX_MEMORY_ENTRIES = 4_000;

async function getCacheDir(): Promise<string> {
  if (!cacheDirPromise) {
    cacheDirPromise = (async () => {
      const dir = path.join(app.getPath('userData'), 'face-cache');
      await mkdir(dir, { recursive: true });
      return dir;
    })();
  }
  return cacheDirPromise;
}

function shardFor(key: string): string {
  // 256-way fan-out so a single directory never holds more than ~200 files
  return key.slice(0, 2);
}

async function fileFor(key: string): Promise<string> {
  const dir = await getCacheDir();
  const shardDir = path.join(dir, shardFor(key));
  await mkdir(shardDir, { recursive: true }).catch(() => undefined);
  return path.join(shardDir, `${key}.json`);
}

export async function cacheKeyFor(filePath: string): Promise<string | null> {
  try {
    const s = await stat(filePath);
    return crypto
      .createHash('md5')
      .update(`${filePath}|${s.mtimeMs}|${s.size}`)
      .digest('hex');
  } catch {
    return null;
  }
}

function rememberInMemory(key: string, entry: CachedEntry): void {
  // Trim by oldest insertion (Map preserves insertion order)
  if (inMemoryHits.has(key)) inMemoryHits.delete(key);
  inMemoryHits.set(key, entry);
  if (inMemoryHits.size > MAX_MEMORY_ENTRIES) {
    const oldest = inMemoryHits.keys().next().value as string | undefined;
    if (oldest) inMemoryHits.delete(oldest);
  }
}

/**
 * Look up a cached face analysis result by file content key.
 * Returns null on miss or if the entry is stale (schema bump, missing file).
 */
export async function getCachedFaceResult(filePath: string): Promise<{
  result: FaceAnalysisResult;
  hexEmbeddings: string[];
} | null> {
  const key = await cacheKeyFor(filePath);
  if (!key) return null;

  const memHit = inMemoryHits.get(key);
  if (memHit) {
    // Refresh LRU order
    inMemoryHits.delete(key);
    inMemoryHits.set(key, memHit);
    return rehydrate(memHit);
  }

  try {
    const file = await fileFor(key);
    const raw = await readFile(file, 'utf-8');
    const entry = JSON.parse(raw) as CachedEntry;
    if (entry.v !== SCHEMA_VERSION) return null;
    rememberInMemory(key, entry);
    return rehydrate(entry);
  } catch {
    return null;
  }
}

function rehydrate(entry: CachedEntry): { result: FaceAnalysisResult; hexEmbeddings: string[] } {
  const embeddings = entry.embeddings.map((hex) => {
    const buf = Buffer.from(hex, 'hex');
    return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  });
  return {
    result: {
      boxes: entry.boxes,
      personBoxes: entry.personBoxes,
      embeddings,
    },
    hexEmbeddings: entry.embeddings,
  };
}

/**
 * Store a face analysis result keyed by file content. Cheap on a hit, ~1 ms
 * fsync on a miss. Caller passes hex-serialised embeddings to avoid
 * round-tripping the Float32Array through Buffer twice.
 */
export async function setCachedFaceResult(
  filePath: string,
  result: FaceAnalysisResult,
  hexEmbeddings: string[],
): Promise<void> {
  const key = await cacheKeyFor(filePath);
  if (!key) return;
  let s: { mtimeMs: number; size: number };
  try {
    s = await stat(filePath);
  } catch {
    return;
  }
  const entry: CachedEntry = {
    v: SCHEMA_VERSION,
    key,
    path: filePath,
    size: s.size,
    mtimeMs: s.mtimeMs,
    cachedAt: Date.now(),
    boxes: result.boxes,
    personBoxes: result.personBoxes,
    embeddings: hexEmbeddings,
  };
  rememberInMemory(key, entry);
  try {
    const file = await fileFor(key);
    await writeFile(file, JSON.stringify(entry));
  } catch {
    // best-effort cache; ignore write failures
  }
  // Prune occasionally — once every ~500 writes
  if (Math.random() < 0.002) {
    void pruneIfTooLarge().catch(() => undefined);
  }
}

async function pruneIfTooLarge(): Promise<void> {
  const dir = await getCacheDir();
  let total = 0;
  type FileInfo = { full: string; key: string; cachedAt: number };
  const files: FileInfo[] = [];
  try {
    const shards = await readdir(dir);
    for (const shard of shards) {
      const shardDir = path.join(dir, shard);
      let entries: string[];
      try { entries = await readdir(shardDir); } catch { continue; }
      for (const name of entries) {
        if (!name.endsWith('.json')) continue;
        total++;
        if (total > MAX_ENTRIES + PRUNE_BATCH * 4) {
          // Sample-only LRU: read mtime as a proxy for cachedAt to avoid reading every file
          const full = path.join(shardDir, name);
          try {
            const st = await stat(full);
            files.push({ full, key: name.replace(/\.json$/, ''), cachedAt: st.mtimeMs });
          } catch { /* ignore */ }
        }
      }
    }
  } catch {
    return;
  }
  if (total <= MAX_ENTRIES) return;

  files.sort((a, b) => a.cachedAt - b.cachedAt);
  const toRemove = files.slice(0, Math.min(PRUNE_BATCH, files.length));
  for (const f of toRemove) {
    await unlink(f.full).catch(() => undefined);
    inMemoryHits.delete(f.key);
  }
}

/**
 * Wipe the entire face cache (settings UI exposes this).
 */
export async function clearFaceCache(): Promise<void> {
  inMemoryHits = new Map();
  try {
    const dir = await getCacheDir();
    const shards = await readdir(dir);
    for (const shard of shards) {
      const shardDir = path.join(dir, shard);
      let entries: string[];
      try { entries = await readdir(shardDir); } catch { continue; }
      for (const name of entries) {
        await unlink(path.join(shardDir, name)).catch(() => undefined);
      }
    }
  } catch {
    // ignore
  }
}
