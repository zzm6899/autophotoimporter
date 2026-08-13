/**
 * Persistent cache for face-analysis results.
 *
 * The primary store is a single WAL-mode SQLite database. This avoids creating
 * and scanning hundreds of thousands of tiny JSON files, batches concurrent
 * writes into transactions, and retains enough results for million-photo
 * libraries. Existing sharded JSON records are migrated lazily on first use.
 *
 * Cache identity deliberately remains compatible with the previous store:
 * md5(absPath + mtimeMs + size + pipeline fingerprint). A rename, content
 * change, or model/preprocessing revision therefore invalidates the result.
 */

import crypto from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { app } from 'electron';
import type { PoseKeypoints } from '../../shared/types';
import type { FaceAnalysisProfile, FaceAnalysisResult, FaceBox } from './face-engine';
import { FACE_PIPELINE_FINGERPRINT } from './face-model-manifest';

// v4 records exact model/preprocessing provenance and orientation-normalized
// inference, so previous schema versions must not be reused.
const SCHEMA_VERSION = 4;
const DATABASE_SCHEMA_VERSION = 2;
const DATABASE_NAME = 'face-analysis.sqlite';

// This keeps at least one complete million-photo library while placing a hard
// bound on runaway cache growth. Maintenance trims to the lower target so it
// is infrequent rather than running for every new photo at the boundary.
const MAX_DATABASE_ENTRIES = 1_250_000;
const TARGET_DATABASE_ENTRIES = 1_150_000;
const MAX_DATABASE_PAYLOAD_BYTES = 16 * 1024 * 1024 * 1024;
const TARGET_DATABASE_PAYLOAD_BYTES = 14 * 1024 * 1024 * 1024;
const MAINTENANCE_WRITE_INTERVAL = 4_096;
const MAX_PRUNE_BATCH = 50_000;

const MAX_MEMORY_ENTRIES = 4_000;
const SQLITE_WRITE_BATCH = 128;
const LEGACY_MAX_ENTRIES = 50_000;
const LEGACY_PRUNE_BATCH = 5_000;
const MAX_CACHE_ENTRY_BYTES = 16 * 1024 * 1024;
const ACCESS_TOUCH_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const EMBEDDING_BLOB_MAGIC = 0x31454346; // "FCE1" as little-endian bytes

interface CachedEntry {
  v: number;
  pipelineFingerprint: string;
  key: string;
  path: string;
  size: number;
  mtimeMs: number;
  cachedAt: number;
  /** Monotonic inference depth; absent legacy entries are conservatively full. */
  analysisDepth?: FaceAnalysisProfile;
  boxes: FaceBox[];
  personBoxes: FaceBox[];
  embeddings: string[];
  embeddingBoxes?: FaceBox[];
  poses?: PoseKeypoints[];
  features: {
    faceMatching: boolean;
    personDetection: boolean;
    poseAnalysis: boolean;
    embeddingLimit: number;
  };
}

type StoredEntryMetadata = Omit<CachedEntry, 'embeddings'>;

type RequiredFeatures = {
  faceMatching?: boolean;
  personDetection?: boolean;
  poseAnalysis?: boolean;
  embeddingLimit?: number;
  /** Required cascade depth. A shallower result must never satisfy this read. */
  analysisDepth?: FaceAnalysisProfile;
};

type SqliteRunResult = { changes: number; lastInsertRowid: number | bigint };
type SqliteStatement = {
  run: (...params: unknown[]) => SqliteRunResult;
  get: (...params: unknown[]) => Record<string, unknown> | undefined;
  all: (...params: unknown[]) => Array<Record<string, unknown>>;
};
type SqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
};
type SqliteModule = {
  DatabaseSync: new (filename: string) => SqliteDatabase;
};

interface DatabaseStats {
  entryCount: number;
  payloadBytes: number;
}

export interface FaceCacheDiagnostics extends DatabaseStats {
  storageKind: 'sqlite' | 'json';
  databasePath?: string;
  pendingWrites: number;
  maxEntries: number;
  maxPayloadBytes: number;
}

export interface FaceCacheMaintenanceOptions {
  maxEntries?: number;
  targetEntries?: number;
  maxPayloadBytes?: number;
  targetPayloadBytes?: number;
}

interface PendingWrite {
  entry: CachedEntry;
  waiters: Array<() => void>;
}

interface SqliteWriteResult {
  prunedKeys: string[];
  /** Equal-depth writes rejected because they would discard completed evidence. */
  rejectedKeys: string[];
}

const createNodeRequire = createRequire(import.meta.url);

let cacheDirPromise: Promise<string> | null = null;
let sqliteStorePromise: Promise<SqliteFaceCache | null> | null = null;
let inMemoryHits = new Map<string, CachedEntry>();
let pendingWrites = new Map<string, PendingWrite>();
let flushScheduled = false;
let flushInFlight: Promise<void> | null = null;
let clearInFlight: Promise<void> | null = null;
let cacheGeneration = 0;
let legacyWritesSincePrune = 0;

function configuredPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function databaseEntryLimits(): {
  maxEntries: number;
  targetEntries: number;
  maxPayloadBytes: number;
  targetPayloadBytes: number;
} {
  const maxEntries = configuredPositiveInteger('KEPTRA_FACE_CACHE_MAX_ENTRIES', MAX_DATABASE_ENTRIES);
  const maxPayloadBytes = configuredPositiveInteger(
    'KEPTRA_FACE_CACHE_MAX_BYTES',
    MAX_DATABASE_PAYLOAD_BYTES,
  );
  return {
    maxEntries,
    targetEntries: Math.min(
      maxEntries,
      configuredPositiveInteger('KEPTRA_FACE_CACHE_TARGET_ENTRIES', TARGET_DATABASE_ENTRIES),
    ),
    maxPayloadBytes,
    targetPayloadBytes: Math.min(
      maxPayloadBytes,
      configuredPositiveInteger('KEPTRA_FACE_CACHE_TARGET_BYTES', TARGET_DATABASE_PAYLOAD_BYTES),
    ),
  };
}

function loadSqliteModule(): SqliteModule | null {
  try {
    return createNodeRequire('node:sqlite') as SqliteModule;
  } catch {
    return null;
  }
}

async function getCacheDir(): Promise<string> {
  if (!cacheDirPromise) {
    cacheDirPromise = (async () => {
      const directory = path.join(app.getPath('userData'), 'face-cache');
      await mkdir(directory, { recursive: true });
      return directory;
    })();
  }
  return cacheDirPromise;
}

function databasePathFor(cacheDirectory: string): string {
  return path.join(cacheDirectory, DATABASE_NAME);
}

function shardFor(key: string): string {
  return key.slice(0, 2);
}

async function legacyFileFor(key: string, createShard = false): Promise<string> {
  const directory = path.join(await getCacheDir(), shardFor(key));
  if (createShard) await mkdir(directory, { recursive: true });
  return path.join(directory, `${key}.json`);
}

async function cacheIdentityFor(filePath: string): Promise<{
  key: string;
  size: number;
  mtimeMs: number;
} | null> {
  try {
    const fileStat = await stat(filePath);
    return {
      key: crypto
        .createHash('md5')
        .update(`${filePath}|${fileStat.mtimeMs}|${fileStat.size}|${FACE_PIPELINE_FINGERPRINT}`)
        .digest('hex'),
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
    };
  } catch {
    return null;
  }
}

export async function cacheKeyFor(filePath: string): Promise<string | null> {
  return (await cacheIdentityFor(filePath))?.key ?? null;
}

function rememberInMemory(key: string, entry: CachedEntry): CachedEntry {
  const existing = inMemoryHits.get(key);
  const preferred = preferCachedEntry(existing, entry);
  if (existing) inMemoryHits.delete(key);
  inMemoryHits.set(key, preferred);
  if (inMemoryHits.size > MAX_MEMORY_ENTRIES) {
    const oldest = inMemoryHits.keys().next().value as string | undefined;
    if (oldest) inMemoryHits.delete(oldest);
  }
  return preferred;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isFaceBox(value: unknown): value is FaceBox {
  if (!value || typeof value !== 'object') return false;
  const box = value as Record<string, unknown>;
  return isFiniteNumber(box.x)
    && isFiniteNumber(box.y)
    && isFiniteNumber(box.width)
    && isFiniteNumber(box.height)
    && isFiniteNumber(box.score);
}

function isHexEmbedding(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length % 8 === 0
    && /^[0-9a-f]+$/i.test(value);
}

function isAnalysisDepth(value: unknown): value is FaceAnalysisProfile {
  return value === 'detect' || value === 'subjects' || value === 'full';
}

function analysisDepthRank(value: FaceAnalysisProfile): number {
  return value === 'full' ? 3 : value === 'subjects' ? 2 : 1;
}

/**
 * Pick the record that cannot regress already-completed work. Profile depth is
 * the primary monotonic dimension. At equal depth, an incoming record may
 * replace the current one only when it preserves every completed feature, the
 * embedding budget, and every embedding already stored.
 *
 * Feature vectors can be incomparable (for example matching-only versus
 * pose-only after a settings change). Keeping the existing record is safer
 * than trading one completed capability for another; a later request for the
 * missing capability remains an explicit cache miss.
 */
function preferCachedEntry(existing: CachedEntry | undefined, incoming: CachedEntry): CachedEntry {
  if (!existing) return incoming;
  const existingDepth = analysisDepthRank(existing.analysisDepth ?? 'full');
  const incomingDepth = analysisDepthRank(incoming.analysisDepth ?? 'full');
  if (incomingDepth > existingDepth) return incoming;
  if (incomingDepth < existingDepth) return existing;

  const preservesCompletedFeatures =
    (!existing.features.faceMatching || incoming.features.faceMatching)
    && (!existing.features.personDetection || incoming.features.personDetection)
    && (!existing.features.poseAnalysis || incoming.features.poseAnalysis);
  const preservesEmbeddingEvidence =
    incoming.features.embeddingLimit >= existing.features.embeddingLimit
    && incoming.embeddings.length >= existing.embeddings.length;
  return preservesCompletedFeatures && preservesEmbeddingEvidence ? incoming : existing;
}

function isValidEntry(value: unknown, expectedKey: string): value is CachedEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<CachedEntry>;
  const features = entry.features as CachedEntry['features'] | undefined;
  return entry.v === SCHEMA_VERSION
    && entry.pipelineFingerprint === FACE_PIPELINE_FINGERPRINT
    && entry.key === expectedKey
    && typeof entry.path === 'string'
    && isFiniteNumber(entry.size)
    && isFiniteNumber(entry.mtimeMs)
    && isFiniteNumber(entry.cachedAt)
    && (entry.analysisDepth === undefined || isAnalysisDepth(entry.analysisDepth))
    && Array.isArray(entry.boxes)
    && entry.boxes.every(isFaceBox)
    && Array.isArray(entry.personBoxes)
    && entry.personBoxes.every(isFaceBox)
    && Array.isArray(entry.embeddings)
    && entry.embeddings.every(isHexEmbedding)
    && (entry.embeddingBoxes === undefined
      || (Array.isArray(entry.embeddingBoxes) && entry.embeddingBoxes.every(isFaceBox)))
    && !!features
    && typeof features.faceMatching === 'boolean'
    && typeof features.personDetection === 'boolean'
    && typeof features.poseAnalysis === 'boolean'
    && Number.isInteger(features.embeddingLimit)
    && features.embeddingLimit >= 0;
}

function encodeEmbeddings(embeddings: string[]): Buffer {
  const buffers = embeddings.map((embedding) => {
    if (!isHexEmbedding(embedding)) throw new Error('Invalid cached face embedding');
    return Buffer.from(embedding, 'hex');
  });
  const headerBytes = 8 + buffers.length * 4;
  const dataBytes = buffers.reduce((total, buffer) => total + buffer.byteLength, 0);
  if (headerBytes + dataBytes > MAX_CACHE_ENTRY_BYTES) {
    throw new Error('Face cache entry exceeds the safe size limit');
  }
  const packed = Buffer.allocUnsafe(headerBytes + dataBytes);
  packed.writeUInt32LE(EMBEDDING_BLOB_MAGIC, 0);
  packed.writeUInt32LE(buffers.length, 4);
  let dataOffset = headerBytes;
  for (let index = 0; index < buffers.length; index++) {
    packed.writeUInt32LE(buffers[index].byteLength, 8 + index * 4);
    buffers[index].copy(packed, dataOffset);
    dataOffset += buffers[index].byteLength;
  }
  return packed;
}

function decodeEmbeddings(value: unknown): string[] {
  if (!(Buffer.isBuffer(value) || value instanceof Uint8Array)) {
    throw new Error('Invalid face embedding payload');
  }
  const packed = Buffer.from(value);
  if (packed.byteLength < 8 || packed.readUInt32LE(0) !== EMBEDDING_BLOB_MAGIC) {
    throw new Error('Unsupported face embedding payload');
  }
  const count = packed.readUInt32LE(4);
  if (count > 100_000 || 8 + count * 4 > packed.byteLength) {
    throw new Error('Corrupt face embedding header');
  }
  let dataOffset = 8 + count * 4;
  const embeddings: string[] = [];
  for (let index = 0; index < count; index++) {
    const byteLength = packed.readUInt32LE(8 + index * 4);
    if (byteLength === 0 || byteLength % 4 !== 0 || dataOffset + byteLength > packed.byteLength) {
      throw new Error('Corrupt face embedding data');
    }
    embeddings.push(packed.subarray(dataOffset, dataOffset + byteLength).toString('hex'));
    dataOffset += byteLength;
  }
  if (dataOffset !== packed.byteLength) throw new Error('Unexpected face embedding bytes');
  return embeddings;
}

function serializeForDatabase(entry: CachedEntry): {
  metadataJson: string;
  embeddingBlob: Buffer;
  payloadBytes: number;
} {
  const { embeddings, ...metadata } = entry;
  const metadataJson = JSON.stringify(metadata satisfies StoredEntryMetadata);
  const embeddingBlob = encodeEmbeddings(embeddings);
  const payloadBytes = Buffer.byteLength(metadataJson) + embeddingBlob.byteLength;
  if (payloadBytes > MAX_CACHE_ENTRY_BYTES) {
    throw new Error('Face cache entry exceeds the safe size limit');
  }
  return { metadataJson, embeddingBlob, payloadBytes };
}

function parseDatabaseEntry(row: Record<string, unknown>, expectedKey: string): CachedEntry {
  if (typeof row.payload_json !== 'string') throw new Error('Invalid face cache payload');
  const metadata = JSON.parse(row.payload_json) as StoredEntryMetadata;
  const entry = {
    ...metadata,
    embeddings: decodeEmbeddings(row.embeddings),
  };
  if (!isValidEntry(entry, expectedKey)) throw new Error('Stale or corrupt face cache entry');
  return entry;
}

function sqliteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0;
}

function isDatabaseCorruption(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /corrupt|malformed|not a database|file is encrypted/i.test(message);
}

class SqliteFaceCache {
  private readonly db: SqliteDatabase;
  private readonly getStatement: SqliteStatement;
  private readonly upsertStatement: SqliteStatement;
  private readonly touchStatement: SqliteStatement;
  private readonly deleteStatement: SqliteStatement;
  private writesSinceMaintenance = 0;

  constructor(public readonly databasePath: string, sqlite: SqliteModule) {
    this.db = new sqlite.DatabaseSync(databasePath);
    try {
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA temp_store = MEMORY;
        PRAGMA wal_autocheckpoint = 1000;
        PRAGMA auto_vacuum = INCREMENTAL;
        CREATE TABLE IF NOT EXISTS face_analysis_cache (
          key TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL,
          pipeline_fingerprint TEXT NOT NULL,
          source_path TEXT NOT NULL,
          file_size INTEGER NOT NULL,
          mtime_ms REAL NOT NULL,
        cached_at INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL,
        analysis_depth INTEGER NOT NULL DEFAULT 3,
        payload_bytes INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          embeddings BLOB NOT NULL
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS idx_face_cache_accessed
          ON face_analysis_cache (last_accessed_at);
        PRAGMA user_version = ${DATABASE_SCHEMA_VERSION};
      `);
      const cacheColumns = this.db.prepare('PRAGMA table_info(face_analysis_cache)').all();
      if (!cacheColumns.some((column) => column.name === 'analysis_depth')) {
        // Databases created by the initial development build predate cascade
        // profiles; all of those records came from the original full pass.
        this.db.exec('ALTER TABLE face_analysis_cache ADD COLUMN analysis_depth INTEGER NOT NULL DEFAULT 3;');
      }
      this.getStatement = this.db.prepare(`
        SELECT payload_json, embeddings, last_accessed_at
        FROM face_analysis_cache
        WHERE key = ? AND schema_version = ? AND pipeline_fingerprint = ?
      `);
      this.upsertStatement = this.db.prepare(`
        INSERT INTO face_analysis_cache (
          key, schema_version, pipeline_fingerprint, source_path, file_size,
          mtime_ms, cached_at, last_accessed_at, analysis_depth, payload_bytes,
          payload_json, embeddings
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          schema_version = excluded.schema_version,
          pipeline_fingerprint = excluded.pipeline_fingerprint,
          source_path = excluded.source_path,
          file_size = excluded.file_size,
          mtime_ms = excluded.mtime_ms,
          cached_at = excluded.cached_at,
          last_accessed_at = excluded.last_accessed_at,
          analysis_depth = excluded.analysis_depth,
          payload_bytes = excluded.payload_bytes,
          payload_json = excluded.payload_json,
          embeddings = excluded.embeddings
        WHERE excluded.analysis_depth > face_analysis_cache.analysis_depth
          OR (
            excluded.analysis_depth = face_analysis_cache.analysis_depth
            AND COALESCE(CAST(json_extract(excluded.payload_json, '$.features.faceMatching') AS INTEGER), 0)
              >= COALESCE(CAST(json_extract(face_analysis_cache.payload_json, '$.features.faceMatching') AS INTEGER), 0)
            AND COALESCE(CAST(json_extract(excluded.payload_json, '$.features.personDetection') AS INTEGER), 0)
              >= COALESCE(CAST(json_extract(face_analysis_cache.payload_json, '$.features.personDetection') AS INTEGER), 0)
            AND COALESCE(CAST(json_extract(excluded.payload_json, '$.features.poseAnalysis') AS INTEGER), 0)
              >= COALESCE(CAST(json_extract(face_analysis_cache.payload_json, '$.features.poseAnalysis') AS INTEGER), 0)
            AND COALESCE(CAST(json_extract(excluded.payload_json, '$.features.embeddingLimit') AS INTEGER), 0)
              >= COALESCE(CAST(json_extract(face_analysis_cache.payload_json, '$.features.embeddingLimit') AS INTEGER), 0)
            AND length(excluded.embeddings) >= length(face_analysis_cache.embeddings)
          )
      `);
      this.touchStatement = this.db.prepare(
        'UPDATE face_analysis_cache SET last_accessed_at = ? WHERE key = ?',
      );
      this.deleteStatement = this.db.prepare('DELETE FROM face_analysis_cache WHERE key = ?');
    } catch (error) {
      try { this.db.close(); } catch { /* best effort */ }
      throw error;
    }
  }

  get(key: string): CachedEntry | null {
    const row = this.getStatement.get(key, SCHEMA_VERSION, FACE_PIPELINE_FINGERPRINT);
    if (!row) return null;
    try {
      const entry = parseDatabaseEntry(row, key);
      const lastAccessedAt = sqliteNumber(row.last_accessed_at);
      if (Date.now() - lastAccessedAt >= ACCESS_TOUCH_INTERVAL_MS) {
        this.touchStatement.run(Date.now(), key);
      }
      return entry;
    } catch {
      // A malformed row must behave as a miss and must not poison later reads.
      this.deleteStatement.run(key);
      return null;
    }
  }

  putMany(entries: CachedEntry[]): SqliteWriteResult {
    if (entries.length === 0) return { prunedKeys: [], rejectedKeys: [] };
    // Serialize before BEGIN so one pathological/oversized result cannot roll
    // back otherwise healthy records that happened to share its batch.
    const prepared = entries.flatMap((entry) => {
      try {
        return [{ entry, stored: serializeForDatabase(entry) }];
      } catch {
        return [];
      }
    });
    if (prepared.length === 0) return { prunedKeys: [], rejectedKeys: [] };
    const now = Date.now();
    const rejectedKeys: string[] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const { entry, stored } of prepared) {
        const writeResult = this.upsertStatement.run(
          entry.key,
          SCHEMA_VERSION,
          FACE_PIPELINE_FINGERPRINT,
          entry.path,
          entry.size,
          entry.mtimeMs,
          entry.cachedAt,
          now,
          analysisDepthRank(entry.analysisDepth ?? 'full'),
          stored.payloadBytes,
          stored.metadataJson,
          stored.embeddingBlob,
        );
        if (writeResult.changes === 0) rejectedKeys.push(entry.key);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* best effort */ }
      throw error;
    }

    this.writesSinceMaintenance += prepared.length;
    if (this.writesSinceMaintenance < MAINTENANCE_WRITE_INTERVAL) {
      return { prunedKeys: [], rejectedKeys };
    }
    this.writesSinceMaintenance = 0;
    return { prunedKeys: this.prune({}), rejectedKeys };
  }

  stats(): DatabaseStats {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS entry_count, COALESCE(SUM(payload_bytes), 0) AS payload_bytes
      FROM face_analysis_cache
    `).get();
    return {
      entryCount: sqliteNumber(row?.entry_count),
      payloadBytes: sqliteNumber(row?.payload_bytes),
    };
  }

  prune(options: FaceCacheMaintenanceOptions): string[] {
    const configured = databaseEntryLimits();
    const maxEntries = Math.max(0, options.maxEntries ?? configured.maxEntries);
    const targetEntries = Math.min(
      maxEntries,
      Math.max(0, options.targetEntries ?? configured.targetEntries),
    );
    const maxPayloadBytes = Math.max(0, options.maxPayloadBytes ?? configured.maxPayloadBytes);
    const targetPayloadBytes = Math.min(
      maxPayloadBytes,
      Math.max(0, options.targetPayloadBytes ?? configured.targetPayloadBytes),
    );
    const removed: string[] = [];

    for (let pass = 0; pass < 32; pass++) {
      const current = this.stats();
      if (current.entryCount <= maxEntries && current.payloadBytes <= maxPayloadBytes) break;
      const averageBytes = Math.max(1, current.payloadBytes / Math.max(1, current.entryCount));
      const entriesOverTarget = Math.max(0, current.entryCount - targetEntries);
      const bytesOverTarget = Math.max(0, current.payloadBytes - targetPayloadBytes);
      const removeCount = Math.min(
        MAX_PRUNE_BATCH,
        current.entryCount,
        Math.max(1, entriesOverTarget, Math.ceil(bytesOverTarget / averageBytes)),
      );
      const rows = this.db.prepare(`
        SELECT key FROM face_analysis_cache
        ORDER BY last_accessed_at ASC, cached_at ASC
        LIMIT ?
      `).all(removeCount);
      if (rows.length === 0) break;

      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of rows) {
          if (typeof row.key !== 'string') continue;
          this.deleteStatement.run(row.key);
          removed.push(row.key);
        }
        this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { /* best effort */ }
        throw error;
      }
    }

    if (removed.length > 0) {
      try {
        this.db.exec('PRAGMA wal_checkpoint(PASSIVE); PRAGMA incremental_vacuum(4096);');
      } catch {
        // Logical bounds are already enforced; physical compaction is best-effort.
      }
    }
    return removed;
  }

  remove(key: string): void {
    this.deleteStatement.run(key);
  }

  clear(): void {
    this.db.exec('DELETE FROM face_analysis_cache; PRAGMA wal_checkpoint(TRUNCATE);');
  }

  close(): void {
    this.db.close();
  }
}

async function quarantineDatabase(databasePath: string): Promise<void> {
  const suffix = `.corrupt-${Date.now()}`;
  for (const extension of ['', '-wal', '-shm']) {
    const source = `${databasePath}${extension}`;
    await rename(source, `${databasePath}${suffix}${extension}`).catch(() => undefined);
  }
}

async function openSqliteStore(): Promise<SqliteFaceCache | null> {
  const sqlite = loadSqliteModule();
  if (!sqlite) return null;
  const databasePath = databasePathFor(await getCacheDir());
  try {
    return new SqliteFaceCache(databasePath, sqlite);
  } catch (error) {
    if (!isDatabaseCorruption(error)) return null;
    await quarantineDatabase(databasePath);
    try {
      return new SqliteFaceCache(databasePath, sqlite);
    } catch {
      return null;
    }
  }
}

async function getSqliteStore(): Promise<SqliteFaceCache | null> {
  if (!sqliteStorePromise) sqliteStorePromise = openSqliteStore();
  return sqliteStorePromise;
}

async function recoverFromRuntimeCorruption(store: SqliteFaceCache, error: unknown): Promise<void> {
  if (!isDatabaseCorruption(error)) return;
  try { store.close(); } catch { /* best effort */ }
  const databasePath = store.databasePath;
  sqliteStorePromise = null;
  await quarantineDatabase(databasePath);
}

function cacheEntryHasRequiredFeatures(
  entry: CachedEntry,
  requiredFeatures?: RequiredFeatures,
): boolean {
  if (!entry.features) return false;
  // Legacy v4 JSON predates profiles and was always produced by the original
  // full pipeline. Treating an absent marker as full preserves those valid
  // caches, while every newly cascaded result records its explicit depth.
  const storedDepth = entry.analysisDepth ?? 'full';
  const requiredDepth = requiredFeatures?.analysisDepth ?? 'full';
  if (analysisDepthRank(storedDepth) < analysisDepthRank(requiredDepth)) return false;
  if (requiredFeatures?.faceMatching && !entry.features.faceMatching) return false;
  if (requiredFeatures?.personDetection && !entry.features.personDetection) return false;
  if (requiredFeatures?.poseAnalysis && !entry.features.poseAnalysis) return false;
  if (
    requiredFeatures?.faceMatching
    && requiredFeatures.embeddingLimit
    && entry.features.embeddingLimit < requiredFeatures.embeddingLimit
    && entry.embeddings.length < entry.boxes.length
  ) {
    return false;
  }
  return true;
}

function rehydrate(entry: CachedEntry): { result: FaceAnalysisResult; hexEmbeddings: string[] } {
  const embeddings = entry.embeddings.map((hex) => {
    const buffer = Buffer.from(hex, 'hex');
    return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
  });
  return {
    result: {
      boxes: entry.boxes,
      personBoxes: entry.personBoxes,
      embeddings,
      embeddingBoxes: entry.embeddingBoxes ?? [],
      poses: entry.poses,
      features: entry.features,
    },
    hexEmbeddings: entry.embeddings,
  };
}

async function readLegacyEntry(key: string): Promise<CachedEntry | null> {
  try {
    const raw = await readFile(await legacyFileFor(key), 'utf8');
    if (Buffer.byteLength(raw) > MAX_CACHE_ENTRY_BYTES * 2) return null;
    const entry = JSON.parse(raw) as unknown;
    return isValidEntry(entry, key) ? entry : null;
  } catch {
    return null;
  }
}

async function writeLegacyEntry(entry: CachedEntry): Promise<void> {
  const target = await legacyFileFor(entry.key, true);
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(entry), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
  } catch {
    await unlink(temporary).catch(() => undefined);
  }
  legacyWritesSincePrune++;
  if (legacyWritesSincePrune >= 500) {
    legacyWritesSincePrune = 0;
    void pruneLegacyJsonIfTooLarge().catch(() => undefined);
  }
}

function settlePendingWrites(writes: PendingWrite[]): void {
  for (const write of writes) {
    for (const resolve of write.waiters) resolve();
  }
}

async function flushPendingWriteBatch(): Promise<void> {
  if (flushInFlight) {
    await flushInFlight;
    if (pendingWrites.size > 0) await flushPendingWriteBatch();
    return;
  }
  if (pendingWrites.size === 0) return;
  const batchMap = pendingWrites;
  pendingWrites = new Map();
  const batch = Array.from(batchMap.values());
  const work = (async () => {
    const store = await getSqliteStore();
    if (store) {
      try {
        const { prunedKeys, rejectedKeys } = store.putMany(batch.map((item) => item.entry));
        for (const key of prunedKeys) inMemoryHits.delete(key);
        // A disk row can be richer than memory after an app restart. When the
        // SQL guard rejects a regressive equal-depth write, restore the actual
        // persisted record so reads in this process stay monotonic too.
        for (const key of rejectedKeys) {
          const persisted = store.get(key);
          if (persisted) rememberInMemory(key, persisted);
        }
      } catch (error) {
        await recoverFromRuntimeCorruption(store, error);
        // The cache is best-effort. A failed database write is deliberately not
        // replayed into thousands of legacy files on the main process hot path.
      }
    } else {
      await Promise.all(batch.map((item) => writeLegacyEntry(item.entry)));
    }
  })().finally(() => {
    settlePendingWrites(batch);
    flushInFlight = null;
    if (pendingWrites.size > 0) scheduleWriteFlush();
  });
  flushInFlight = work;
  return work;
}

function scheduleWriteFlush(): void {
  if (flushScheduled || flushInFlight) return;
  flushScheduled = true;
  setImmediate(() => {
    flushScheduled = false;
    void flushPendingWriteBatch();
  });
}

function enqueueWrite(entry: CachedEntry): Promise<void> {
  return new Promise((resolve) => {
    const existing = pendingWrites.get(entry.key);
    if (existing) {
      // Coalescing happens before SQLite's monotonic UPSERT guard. Keep the
      // deeper/richer pending result here as well, otherwise a later partial
      // result in the same turn could erase embeddings or completed features.
      existing.entry = preferCachedEntry(existing.entry, entry);
      existing.waiters.push(resolve);
    } else {
      pendingWrites.set(entry.key, { entry, waiters: [resolve] });
    }
    if (pendingWrites.size >= SQLITE_WRITE_BATCH) {
      void flushPendingWriteBatch();
    } else {
      scheduleWriteFlush();
    }
  });
}

async function discardPendingWrites(): Promise<void> {
  if (flushInFlight) await flushInFlight;
  const discarded = Array.from(pendingWrites.values());
  pendingWrites = new Map();
  settlePendingWrites(discarded);
}

export async function getCachedFaceResult(filePath: string): Promise<{
  result: FaceAnalysisResult;
  hexEmbeddings: string[];
} | null>;
export async function getCachedFaceResult(
  filePath: string,
  requiredFeatures: RequiredFeatures,
): Promise<{
  result: FaceAnalysisResult;
  hexEmbeddings: string[];
} | null>;
export async function getCachedFaceResult(
  filePath: string,
  requiredFeatures?: RequiredFeatures,
): Promise<{
  result: FaceAnalysisResult;
  hexEmbeddings: string[];
} | null> {
  if (clearInFlight) await clearInFlight;
  const generation = cacheGeneration;
  const identity = await cacheIdentityFor(filePath);
  if (!identity || generation !== cacheGeneration) return null;

  const memoryHit = inMemoryHits.get(identity.key);
  if (memoryHit) {
    if (!cacheEntryHasRequiredFeatures(memoryHit, requiredFeatures)) return null;
    inMemoryHits.delete(identity.key);
    inMemoryHits.set(identity.key, memoryHit);
    return rehydrate(memoryHit);
  }

  const store = await getSqliteStore();
  if (generation !== cacheGeneration) return null;
  if (store) {
    try {
      const entry = store.get(identity.key);
      if (entry) {
        if (!cacheEntryHasRequiredFeatures(entry, requiredFeatures)) return null;
        rememberInMemory(identity.key, entry);
        return rehydrate(entry);
      }
    } catch (error) {
      await recoverFromRuntimeCorruption(store, error);
    }
  }

  // Legacy migration is intentionally lazy. Revisited photos move into SQLite
  // without a million-file startup scan; untouched legacy records remain valid.
  const legacyEntry = await readLegacyEntry(identity.key);
  if (!legacyEntry || generation !== cacheGeneration) return null;
  if (!cacheEntryHasRequiredFeatures(legacyEntry, requiredFeatures)) return null;
  rememberInMemory(identity.key, legacyEntry);
  if (store) {
    await enqueueWrite(legacyEntry);
    await unlink(await legacyFileFor(identity.key)).catch(() => undefined);
  }
  return rehydrate(legacyEntry);
}

export async function setCachedFaceResult(
  filePath: string,
  result: FaceAnalysisResult,
  hexEmbeddings: string[],
  analysisDepth: FaceAnalysisProfile = 'full',
): Promise<void> {
  if (clearInFlight) await clearInFlight;
  const generation = cacheGeneration;
  const identity = await cacheIdentityFor(filePath);
  if (!identity || generation !== cacheGeneration) return;

  const entry: CachedEntry = {
    v: SCHEMA_VERSION,
    pipelineFingerprint: FACE_PIPELINE_FINGERPRINT,
    key: identity.key,
    path: filePath,
    size: identity.size,
    mtimeMs: identity.mtimeMs,
    cachedAt: Date.now(),
    analysisDepth,
    boxes: result.boxes,
    personBoxes: result.personBoxes,
    embeddings: hexEmbeddings,
    embeddingBoxes: result.embeddingBoxes,
    poses: result.poses,
    features: result.features ?? {
      faceMatching: hexEmbeddings.length > 0 || result.boxes.length === 0,
      personDetection: true,
      poseAnalysis: false,
      embeddingLimit: hexEmbeddings.length,
    },
  };
  if (!isValidEntry(entry, identity.key)) return;
  const preferred = rememberInMemory(identity.key, entry);
  await enqueueWrite(preferred);
}

async function pruneLegacyJsonIfTooLarge(): Promise<void> {
  const directory = await getCacheDir();
  const cacheFiles: Array<{ full: string; key: string }> = [];
  try {
    const shards = await readdir(directory);
    for (const shard of shards) {
      if (!/^[0-9a-f]{2}$/i.test(shard)) continue;
      const shardDirectory = path.join(directory, shard);
      let entries: string[];
      try { entries = await readdir(shardDirectory); } catch { continue; }
      for (const name of entries) {
        if (!name.endsWith('.json')) continue;
        cacheFiles.push({
          full: path.join(shardDirectory, name),
          key: name.replace(/\.json$/, ''),
        });
      }
    }
  } catch {
    return;
  }
  if (cacheFiles.length <= LEGACY_MAX_ENTRIES) return;

  const files: Array<{ full: string; key: string; cachedAt: number }> = [];
  for (let start = 0; start < cacheFiles.length; start += 128) {
    const details = await Promise.all(cacheFiles.slice(start, start + 128).map(async (file) => {
      try {
        return { ...file, cachedAt: (await stat(file.full)).mtimeMs };
      } catch {
        return null;
      }
    }));
    for (const detail of details) if (detail) files.push(detail);
  }
  files.sort((left, right) => left.cachedAt - right.cachedAt);
  const removeCount = Math.min(
    files.length,
    Math.max(LEGACY_PRUNE_BATCH, cacheFiles.length - LEGACY_MAX_ENTRIES),
  );
  for (const file of files.slice(0, removeCount)) {
    await unlink(file.full).catch(() => undefined);
    inMemoryHits.delete(file.key);
  }
}

export async function maintainFaceCache(
  options: FaceCacheMaintenanceOptions = {},
): Promise<DatabaseStats> {
  if (clearInFlight) await clearInFlight;
  await flushPendingWriteBatch();
  const store = await getSqliteStore();
  if (!store) {
    await pruneLegacyJsonIfTooLarge();
    return { entryCount: 0, payloadBytes: 0 };
  }
  try {
    const removed = store.prune(options);
    for (const key of removed) inMemoryHits.delete(key);
    return store.stats();
  } catch (error) {
    await recoverFromRuntimeCorruption(store, error);
    return { entryCount: 0, payloadBytes: 0 };
  }
}

export async function getFaceCacheDiagnostics(): Promise<FaceCacheDiagnostics> {
  await flushPendingWriteBatch();
  const store = await getSqliteStore();
  if (!store) {
    return {
      storageKind: 'json',
      entryCount: 0,
      payloadBytes: 0,
      pendingWrites: pendingWrites.size,
      maxEntries: LEGACY_MAX_ENTRIES,
      maxPayloadBytes: 0,
    };
  }
  try {
    const limits = databaseEntryLimits();
    return {
      storageKind: 'sqlite',
      databasePath: store.databasePath,
      ...store.stats(),
      pendingWrites: pendingWrites.size,
      maxEntries: limits.maxEntries,
      maxPayloadBytes: limits.maxPayloadBytes,
    };
  } catch (error) {
    await recoverFromRuntimeCorruption(store, error);
    return {
      storageKind: 'json',
      entryCount: 0,
      payloadBytes: 0,
      pendingWrites: pendingWrites.size,
      maxEntries: LEGACY_MAX_ENTRIES,
      maxPayloadBytes: 0,
    };
  }
}

export async function clearFaceCache(): Promise<void> {
  if (clearInFlight) return clearInFlight;
  const work = (async () => {
    cacheGeneration++;
    inMemoryHits = new Map();
    await discardPendingWrites();
    const store = await getSqliteStore();
    if (store) {
      try {
        store.clear();
      } catch (error) {
        await recoverFromRuntimeCorruption(store, error);
      }
    }

    try {
      const directory = await getCacheDir();
      const shards = await readdir(directory);
      for (const shard of shards) {
        if (!/^[0-9a-f]{2}$/i.test(shard)) continue;
        const shardDirectory = path.join(directory, shard);
        let entries: string[];
        try { entries = await readdir(shardDirectory); } catch { continue; }
        for (const name of entries) {
          if (name.endsWith('.json')) {
            await unlink(path.join(shardDirectory, name)).catch(() => undefined);
          }
        }
      }
    } catch {
      // The cache is reconstructible; clear remains best-effort.
    }
  })();
  clearInFlight = work;
  try {
    await work;
  } finally {
    if (clearInFlight === work) clearInFlight = null;
  }
}

/** Close the database during application/test shutdown after pending writes land. */
export async function closeFaceCache(): Promise<void> {
  if (clearInFlight) await clearInFlight;
  await flushPendingWriteBatch();
  const store = sqliteStorePromise ? await sqliteStorePromise : null;
  try { store?.close(); } catch { /* best effort */ }
  sqliteStorePromise = null;
  inMemoryHits = new Map();
}
