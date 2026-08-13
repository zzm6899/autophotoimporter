import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { AppSession, AppSessionSummary, MediaFile } from '../../shared/types';
import { applySessionDelta, getSessionDeltaDescriptor, hasSessionDeltaField } from '../../shared/session-delta';
import { stripLocalFaceAndSubjectData } from '../../shared/face-data';

type SqliteRunResult = { changes: number; lastInsertRowid: number | bigint };
type SqliteStatement = {
  run: (...params: unknown[]) => SqliteRunResult;
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
};
type SqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
};
type SqliteModule = {
  DatabaseSync: new (filename: string) => SqliteDatabase;
};

export type SessionStorageKind = 'sqlite' | 'json';

export interface SessionStoreOpenOptions {
  preferJson?: boolean;
}

type SessionStats = AppSession['stats'];
type SessionFaceBox = NonNullable<MediaFile['faceEmbeddingBoxes']>[number];
type StoredMediaFile = Omit<MediaFile, 'thumbnail' | 'faceEmbedding' | 'faceEmbeddings' | 'faceEmbeddingBoxes'>;

interface SessionStoreBackend {
  save(session: AppSession): Promise<AppSession>;
  saveWithGeneration(session: AppSession, minimumGeneration: number): Promise<AppSession>;
  readLatest(): Promise<AppSession | null>;
  readLatestSummary(): Promise<AppSessionSummary | null>;
  readRestorePage(sessionId: string, offset: number, limit: number): Promise<SessionRestorePageData | null>;
  verifyCheckpoint(session: AppSession): Promise<boolean>;
  readCheckpointInfo(): Promise<SessionCheckpointInfo | null>;
  purgeFaceData(): Promise<SessionFaceDataPurgeResult>;
  close(): Promise<void>;
}

export interface SessionFaceDataPurgeResult {
  sessionFilesPurged: number;
}

export interface SessionRestorePageData {
  summary: AppSessionSummary;
  offset: number;
  files: MediaFile[];
  selectedPaths: string[];
  queuedPaths: string[];
  complete: boolean;
}

const SESSION_SQLITE_NAME = 'keptra-sessions.sqlite';
const SESSION_JSON_LATEST_NAME = 'latest.json';
const SESSION_JSON_CHECKPOINT_NAME = 'latest.checkpoint.json';
const MAX_IN_MEMORY_SESSION_SIGNATURES = 50_000;
const LEGACY_HEADER_BYTES = 64 * 1024;

const createNodeRequire = createRequire(import.meta.url);

function loadSqliteModule(): SqliteModule | null {
  try {
    return createNodeRequire('node:sqlite') as SqliteModule;
  } catch {
    return null;
  }
}

function sqliteString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function sqliteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0;
}

function compactString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function stripThumbnailFile(file: MediaFile): MediaFile {
  if (file.thumbnail === undefined) return file;
  const { thumbnail: _thumbnail, ...metadata } = file;
  return metadata as MediaFile;
}

function stripThumbnailFiles(files: MediaFile[]): MediaFile[] {
  return files.some((file) => file.thumbnail !== undefined)
    ? files.map(stripThumbnailFile)
    : files;
}

function stripSqliteMediaFile(file: MediaFile): StoredMediaFile {
  const {
    thumbnail: _thumbnail,
    faceEmbedding: _faceEmbedding,
    faceEmbeddings: _faceEmbeddings,
    faceEmbeddingBoxes: _faceEmbeddingBoxes,
    ...metadata
  } = file;
  return metadata;
}

export function stripSessionThumbnails(session: AppSession): AppSession {
  return {
    ...session,
    files: stripThumbnailFiles(session.files),
  };
}

function sessionStats(session: AppSession): SessionStats {
  let picked = 0;
  let rejected = 0;
  let reviewed = 0;
  for (const file of session.files) {
    if (file.pick === 'selected') picked++;
    else if (file.pick === 'rejected') rejected++;
    if (file.pick || typeof file.reviewScore === 'number') reviewed++;
  }
  return {
    totalFiles: session.files.length,
    picked,
    rejected,
    queued: session.queuedPaths.length,
    reviewed,
  };
}

function leanSession(session: AppSession): AppSession {
  return {
    ...session,
    files: stripThumbnailFiles(session.files),
    selectedPaths: [...new Set(session.selectedPaths)],
    queuedPaths: [...new Set(session.queuedPaths)],
    stats: sessionStats(session),
  };
}

function readJsonSession(value: string): AppSession | null {
  try {
    const parsed = JSON.parse(value) as AppSession;
    if (!parsed || typeof parsed.id !== 'string' || !Array.isArray(parsed.files)) return null;
    return parsed;
  } catch {
    return null;
  }
}

interface SessionCheckpointInfo {
  id: string;
  updatedAt: string;
  totalFiles: number;
  generation?: number;
  summary?: AppSessionSummary;
}

class SessionIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionIntegrityError';
  }
}

function jsonStringProperty(prefix: string, key: string): string | null {
  const match = prefix.match(new RegExp(`"${key}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`));
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]) as unknown;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function jsonNullableStringProperty(prefix: string, key: string): string | null {
  const stringValue = jsonStringProperty(prefix, key);
  if (stringValue !== null) return stringValue;
  return new RegExp(`"${key}"\\s*:\\s*null`).test(prefix) ? null : null;
}

function saneDeltaStats(stats: SessionStats, totalFiles: number): boolean {
  const counters = [stats.totalFiles, stats.picked, stats.rejected, stats.queued, stats.reviewed];
  return counters.every((value) => Number.isSafeInteger(value) && value >= 0 && value <= totalFiles)
    && stats.totalFiles === totalFiles
    && stats.picked + stats.rejected <= totalFiles
    && stats.reviewed >= stats.picked + stats.rejected;
}

function isAppSessionSummary(value: unknown): value is AppSessionSummary {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  const stats = candidate.stats as SessionStats | undefined;
  return typeof candidate.id === 'string'
    && typeof candidate.updatedAt === 'string'
    && (candidate.sourcePath === null || typeof candidate.sourcePath === 'string')
    && (candidate.destRoot === null || typeof candidate.destRoot === 'string')
    && typeof candidate.filter === 'string'
    && !!stats
    && saneDeltaStats(stats, stats.totalFiles);
}

function isCheckpointInfo(value: unknown): value is SessionCheckpointInfo {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string'
    && typeof candidate.updatedAt === 'string'
    && Number.isSafeInteger(candidate.totalFiles)
    && Number(candidate.totalFiles) >= 0
    && (candidate.generation == null
      || (Number.isSafeInteger(candidate.generation) && Number(candidate.generation) >= 0));
}

function summaryForSession(session: AppSession): AppSessionSummary {
  return {
    id: session.id,
    updatedAt: session.updatedAt,
    sourcePath: session.sourcePath,
    destRoot: session.destRoot,
    filter: session.filter,
    focusedPath: session.focusedPath,
    importLedgerId: session.importLedgerId,
    stats: session.stats,
  };
}

function faceEmbeddingsFor(file: MediaFile): string[] {
  if (file.faceEmbeddings?.length) return file.faceEmbeddings;
  return file.faceEmbedding ? [file.faceEmbedding] : [];
}

function embeddingBoxAt(file: MediaFile, index: number): SessionFaceBox | undefined {
  return file.faceEmbeddingBoxes?.[index];
}

function bufferToHex(value: unknown): string | undefined {
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  return undefined;
}

function parseBoxJson(value: unknown): SessionFaceBox | undefined {
  const text = sqliteString(value);
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as SessionFaceBox;
    return typeof parsed?.x === 'number' && typeof parsed?.y === 'number'
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

class JsonSessionStore implements SessionStoreBackend {
  public readonly latestPath: string;
  private readonly checkpointPath: string;
  private restoreCache: AppSession | null = null;

  constructor(private readonly sessionDir: string) {
    this.latestPath = path.join(sessionDir, SESSION_JSON_LATEST_NAME);
    this.checkpointPath = path.join(sessionDir, SESSION_JSON_CHECKPOINT_NAME);
  }

  async open(): Promise<void> {
    await mkdir(this.sessionDir, { recursive: true });
  }

  async save(session: AppSession): Promise<AppSession> {
    const checkpoint = await this.readCheckpointInfo();
    return this.saveWithGeneration(session, (checkpoint?.generation ?? 0) + 1);
  }

  async saveWithGeneration(session: AppSession, minimumGeneration: number): Promise<AppSession> {
    if (!/^[A-Za-z0-9._-]{1,256}$/.test(session.id)) {
      throw new Error('Invalid session identifier');
    }
    const descriptor = getSessionDeltaDescriptor(session);
    let source = session;
    if (descriptor) {
      const current = await this.readSessionFile(path.join(this.sessionDir, `${session.id}.json`))
        ?? await this.readSessionFile(this.latestPath);
      const merged = current ? applySessionDelta(current, session) : null;
      if (!merged) throw new Error('Cannot apply session delta without a compatible checkpoint');
      source = merged;
    }
    const next = leanSession(source);
    await mkdir(this.sessionDir, { recursive: true });
    const sessionPath = path.join(this.sessionDir, `${next.id}.json`);
    const content = JSON.stringify(next);
    await this.writeAtomic(sessionPath, content);
    await this.writeAtomic(this.latestPath, content);
    const previous = await this.readCheckpointInfo();
    const generation = Math.max(minimumGeneration, (previous?.generation ?? 0) + 1);
    await this.writeAtomic(this.checkpointPath, JSON.stringify({
      id: next.id,
      updatedAt: next.updatedAt,
      totalFiles: next.files.length,
      generation,
      summary: summaryForSession(next),
    } satisfies SessionCheckpointInfo));
    this.restoreCache = next;
    return next;
  }

  async readLatest(): Promise<AppSession | null> {
    try {
      const raw = await readFile(this.latestPath, 'utf8');
      const session = readJsonSession(raw);
      if (!session) return null;
      const next = leanSession(session);
      this.restoreCache = next;
      if (raw !== JSON.stringify(next)) {
        await this.save(next).catch(() => undefined);
      }
      return next;
    } catch {
      return null;
    }
  }

  async readLatestSummary(): Promise<AppSessionSummary | null> {
    const header = await this.readLatestHeader();
    if (!header) return null;
    const checkpoint = await this.readCheckpointInfo();
    if (checkpoint?.id === header.id
      && checkpoint.updatedAt === header.updatedAt
      && isAppSessionSummary(checkpoint.summary)
      && checkpoint.summary.stats.totalFiles === checkpoint.totalFiles) {
      return checkpoint.summary;
    }

    // Older JSON checkpoints did not carry a summary. Keep startup bounded to
    // the header rather than parsing a potentially multi-gigabyte catalogue;
    // the exact counters/metadata are supplied by the first explicit page.
    let prefix = '';
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(this.latestPath, 'r');
      const buffer = Buffer.allocUnsafe(LEGACY_HEADER_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      prefix = buffer.subarray(0, bytesRead).toString('utf8');
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
    const totalFiles = Math.max(0, checkpoint?.id === header.id ? checkpoint.totalFiles : 0);
    return {
      id: header.id,
      updatedAt: header.updatedAt,
      sourcePath: jsonNullableStringProperty(prefix, 'sourcePath'),
      destRoot: jsonNullableStringProperty(prefix, 'destRoot'),
      filter: 'all',
      stats: { totalFiles, picked: 0, rejected: 0, queued: 0, reviewed: 0 },
    };
  }

  async readRestorePage(sessionId: string, offset: number, limit: number): Promise<SessionRestorePageData | null> {
    let session = this.restoreCache?.id === sessionId ? this.restoreCache : null;
    if (!session) {
      session = await this.readSessionFile(path.join(this.sessionDir, `${sessionId}.json`))
        ?? await this.readSessionFile(this.latestPath);
      if (!session || session.id !== sessionId) return null;
      session = leanSession(session);
      this.restoreCache = session;
    }
    return {
      summary: summaryForSession(session),
      offset,
      files: session.files.slice(offset, offset + limit),
      selectedPaths: session.selectedPaths.slice(offset, offset + limit),
      queuedPaths: session.queuedPaths.slice(offset, offset + limit),
      complete: offset + limit >= session.files.length,
    };
  }

  async readLatestHeader(): Promise<SessionCheckpointInfo | null> {
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(this.latestPath, 'r');
      const buffer = Buffer.allocUnsafe(LEGACY_HEADER_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const prefix = buffer.subarray(0, bytesRead).toString('utf8');
      const id = jsonStringProperty(prefix, 'id');
      const updatedAt = jsonStringProperty(prefix, 'updatedAt');
      if (!id || !updatedAt) return null;
      const checkpoint = await this.readCheckpointInfo();
      return checkpoint?.id === id && checkpoint.updatedAt === updatedAt
        ? checkpoint
        : { id, updatedAt, totalFiles: -1 };
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async verifyCheckpoint(session: AppSession): Promise<boolean> {
    const header = await this.readLatestHeader();
    return header?.id === session.id
      && header.updatedAt === session.updatedAt
      && (header.totalFiles < 0 || header.totalFiles === session.stats.totalFiles);
  }

  async readCheckpointInfo(): Promise<SessionCheckpointInfo | null> {
    try {
      const value = JSON.parse(await readFile(this.checkpointPath, 'utf8')) as unknown;
      return isCheckpointInfo(value) ? value : null;
    } catch {
      return null;
    }
  }

  async archiveCheckpoint(header: SessionCheckpointInfo): Promise<void> {
    const suffix = `.sqlite-migrated-${Date.now().toString(36)}`;
    await rename(this.latestPath, `${this.latestPath}${suffix}`).catch(() => undefined);
    await rename(this.checkpointPath, `${this.checkpointPath}${suffix}`).catch(() => undefined);
    if (/^[A-Za-z0-9._-]{1,256}$/.test(header.id)) {
      const sessionPath = path.join(this.sessionDir, `${header.id}.json`);
      await rename(sessionPath, `${sessionPath}${suffix}`).catch(() => undefined);
    }
  }

  async purgeFaceData(): Promise<SessionFaceDataPurgeResult> {
    await mkdir(this.sessionDir, { recursive: true });
    const names = await readdir(this.sessionDir);
    let sessionFilesPurged = 0;
    let latestPurged: AppSession | null = null;
    const previousCheckpoint = await this.readCheckpointInfo();

    for (const name of names) {
      if (name.endsWith('.tmp')) {
        await unlink(path.join(this.sessionDir, name)).catch(() => undefined);
        continue;
      }
      // Include active JSON sessions and recoverable SQLite-migration archives.
      // Checkpoint summaries contain no media rows and are harmlessly skipped.
      if (!/\.json(?:\.sqlite-migrated-[A-Za-z0-9]+)?$/.test(name)) continue;
      const targetPath = path.join(this.sessionDir, name);
      let raw: string;
      try {
        raw = await readFile(targetPath, 'utf8');
      } catch {
        continue;
      }
      const session = readJsonSession(raw);
      if (!session) {
        if (/"(?:faceCount|faceBoxes|faceDetection|personCount|personBoxes|poses|faceSignature|faceEmbedding|faceEmbeddings|faceEmbeddingBoxes|faceGroupId|faceGroupSize|subjectSharpnessScore|subjectReasons|blurRisk|enduranceSportsAnalysis|reviewScore|reviewReasons|reviewAnalysisStage|reviewAnalysisFeatures|reviewAnalysisUnavailable|reviewAnalysisUnavailableFeatures)"\s*:/.test(raw)) {
          throw new Error(`Cannot safely purge unreadable session data: ${name}`);
        }
        continue;
      }
      let changed = false;
      const files = session.files.map((file) => {
        const purged = stripLocalFaceAndSubjectData(file);
        if (purged !== file) {
          changed = true;
          sessionFilesPurged++;
        }
        return purged;
      });
      if (!changed) continue;
      const purgedSession = leanSession({ ...session, files });
      await this.writeAtomic(targetPath, JSON.stringify(purgedSession));
      if (name === SESSION_JSON_LATEST_NAME) latestPurged = purgedSession;
      if (this.restoreCache?.id === purgedSession.id) this.restoreCache = leanSession(purgedSession);
    }

    if (latestPurged) {
      await this.writeAtomic(this.checkpointPath, JSON.stringify({
        id: latestPurged.id,
        updatedAt: latestPurged.updatedAt,
        totalFiles: latestPurged.files.length,
        ...(previousCheckpoint?.generation != null ? { generation: previousCheckpoint.generation } : {}),
        summary: summaryForSession(latestPurged),
      } satisfies SessionCheckpointInfo));
    }

    if (this.restoreCache) {
      this.restoreCache = {
        ...this.restoreCache,
        files: this.restoreCache.files.map(stripLocalFaceAndSubjectData),
      };
    }
    return { sessionFilesPurged };
  }

  async close(): Promise<void> {}

  private async writeAtomic(targetPath: string, content: string): Promise<void> {
    const tempPath = `${targetPath}.tmp`;
    await writeFile(tempPath, content, { encoding: 'utf8', mode: 0o600 });
    try {
      await rename(tempPath, targetPath);
    } catch (err) {
      // Clean up the orphaned temp file so it doesn't accumulate on disk.
      await unlink(tempPath).catch(() => undefined);
      throw err;
    }
  }

  private async readSessionFile(targetPath: string): Promise<AppSession | null> {
    try {
      return readJsonSession(await readFile(targetPath, 'utf8'));
    } catch {
      return null;
    }
  }
}

class SqliteSessionStore implements SessionStoreBackend {
  private readonly db: SqliteDatabase;
  // Promise-chain mutex: each save() appends to this chain so SQLite
  // BEGIN/COMMIT calls from concurrent async callers never interleave.
  private saveMutex: Promise<unknown> = Promise.resolve();
  private nextGenerationFloor = 0;
  private readonly persistedSessions = new Map<string, {
    files: Map<string, string>;
    selected: string;
    queued: string;
  }>();

  constructor(sqlite: SqliteModule, public readonly sqlitePath: string) {
    this.db = new sqlite.DatabaseSync(sqlitePath);
  }

  async open(): Promise<void> {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        source_path TEXT,
        dest_root TEXT,
        filter TEXT NOT NULL,
        focused_path TEXT,
        import_ledger_id TEXT,
        total_files INTEGER NOT NULL,
        picked INTEGER NOT NULL,
        rejected INTEGER NOT NULL,
        queued INTEGER NOT NULL,
        reviewed INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_updated
        ON sessions (updated_at);

      CREATE TABLE IF NOT EXISTS session_files (
        session_id TEXT NOT NULL,
        path TEXT NOT NULL,
        sort_index INTEGER NOT NULL,
        metadata_json TEXT NOT NULL,
        PRIMARY KEY (session_id, path),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_session_files_order
        ON session_files (session_id, sort_index);

      CREATE TABLE IF NOT EXISTS session_selected (
        session_id TEXT NOT NULL,
        path TEXT NOT NULL,
        sort_index INTEGER NOT NULL,
        PRIMARY KEY (session_id, path),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS session_queued (
        session_id TEXT NOT NULL,
        path TEXT NOT NULL,
        sort_index INTEGER NOT NULL,
        PRIMARY KEY (session_id, path),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS session_face_embeddings (
        session_id TEXT NOT NULL,
        path TEXT NOT NULL,
        face_index INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        box_json TEXT,
        PRIMARY KEY (session_id, path, face_index),
        FOREIGN KEY (session_id, path) REFERENCES session_files(session_id, path) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS session_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  async save(session: AppSession): Promise<AppSession> {
    // Serialize saves through the mutex so concurrent callers don't interleave
    // BEGIN/COMMIT on the synchronous SQLite connection.
    const result = this.saveMutex.then(() => this._saveImpl(session));
    this.saveMutex = result.catch(() => undefined);
    return result;
  }

  async saveWithGeneration(session: AppSession, minimumGeneration: number): Promise<AppSession> {
    this.nextGenerationFloor = Math.max(this.nextGenerationFloor, minimumGeneration);
    return this.save(session);
  }

  private _saveImpl(session: AppSession): AppSession {
    const delta = getSessionDeltaDescriptor(session);
    if (delta) return this._saveDeltaImpl(session, delta);
    const next = leanSession(session);
    const stats = next.stats;
    const upsertSession = this.db.prepare(`
      INSERT INTO sessions (
        id, updated_at, source_path, dest_root, filter, focused_path, import_ledger_id,
        total_files, picked, rejected, queued, reviewed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        updated_at = excluded.updated_at,
        source_path = excluded.source_path,
        dest_root = excluded.dest_root,
        filter = excluded.filter,
        focused_path = excluded.focused_path,
        import_ledger_id = excluded.import_ledger_id,
        total_files = excluded.total_files,
        picked = excluded.picked,
        rejected = excluded.rejected,
        queued = excluded.queued,
        reviewed = excluded.reviewed
    `);
    const deleteFiles = this.db.prepare('DELETE FROM session_files WHERE session_id = ?');
    const deleteSelected = this.db.prepare('DELETE FROM session_selected WHERE session_id = ?');
    const deleteQueued = this.db.prepare('DELETE FROM session_queued WHERE session_id = ?');
    const insertFile = this.db.prepare(`
      INSERT INTO session_files (session_id, path, sort_index, metadata_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, path) DO UPDATE SET
        sort_index = excluded.sort_index,
        metadata_json = excluded.metadata_json
    `);
    const deleteFile = this.db.prepare('DELETE FROM session_files WHERE session_id = ? AND path = ?');
    const deleteFaces = this.db.prepare('DELETE FROM session_face_embeddings WHERE session_id = ? AND path = ?');
    const insertFace = this.db.prepare(`
      INSERT INTO session_face_embeddings (session_id, path, face_index, embedding, box_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertSelected = this.db.prepare(`
      INSERT INTO session_selected (session_id, path, sort_index)
      VALUES (?, ?, ?)
    `);
    const insertQueued = this.db.prepare(`
      INSERT INTO session_queued (session_id, path, sort_index)
      VALUES (?, ?, ?)
    `);
    const upsertMeta = this.db.prepare(`
      INSERT INTO session_meta (key, value)
      VALUES ('latest_session_id', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    const readGeneration = this.db.prepare(
      "SELECT value FROM session_meta WHERE key = 'latest_session_generation'",
    );
    const upsertGeneration = this.db.prepare(`
      INSERT INTO session_meta (key, value)
      VALUES ('latest_session_generation', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    const currentGeneration = sqliteNumber((readGeneration.get() as Record<string, unknown> | undefined)?.value);

    this.db.exec('BEGIN');
    try {
      upsertSession.run(
        next.id,
        next.updatedAt,
        next.sourcePath ?? null,
        next.destRoot ?? null,
        next.filter,
        compactString(next.focusedPath) ?? null,
        compactString(next.importLedgerId) ?? null,
        stats.totalFiles,
        stats.picked,
        stats.rejected,
        stats.queued,
        stats.reviewed,
      );
      const previous = this.persistedSessions.get(next.id);
      const trackSignatures = next.files.length <= MAX_IN_MEMORY_SESSION_SIGNATURES;
      if (!previous || !trackSignatures) deleteFiles.run(next.id);
      const nextFileSignatures = trackSignatures ? new Map<string, string>() : null;

      for (let index = 0; index < next.files.length; index++) {
        const originalFile = session.files[index] ?? next.files[index];
        const file = next.files[index];
        const embeddings = faceEmbeddingsFor(originalFile);
        const metadataJson = JSON.stringify(stripSqliteMediaFile(file));
        const boxesJson = JSON.stringify(originalFile.faceEmbeddingBoxes ?? []);
        const signature = trackSignatures ? `${index}:${metadataJson}:${embeddings.join(',')}:${boxesJson}` : '';
        nextFileSignatures?.set(file.path, signature);
        if (trackSignatures && previous?.files.get(file.path) === signature) continue;
        insertFile.run(next.id, file.path, index, metadataJson);
        deleteFaces.run(next.id, file.path);
        for (let faceIndex = 0; faceIndex < embeddings.length; faceIndex++) {
          const hex = embeddings[faceIndex];
          if (!/^[0-9a-f]+$/i.test(hex) || hex.length < 8 || hex.length % 2 !== 0) continue;
          insertFace.run(
            next.id,
            file.path,
            faceIndex,
            Buffer.from(hex, 'hex'),
            embeddingBoxAt(originalFile, faceIndex) ? JSON.stringify(embeddingBoxAt(originalFile, faceIndex)) : null,
          );
        }
      }

      if (previous && nextFileSignatures) {
        for (const previousPath of previous.files.keys()) {
          if (!nextFileSignatures.has(previousPath)) deleteFile.run(next.id, previousPath);
        }
      }

      const selectedSignature = trackSignatures ? next.selectedPaths.join('\n') : '';
      const queuedSignature = trackSignatures ? next.queuedPaths.join('\n') : '';
      if (!trackSignatures || !previous || previous.selected !== selectedSignature) {
        deleteSelected.run(next.id);
        next.selectedPaths.forEach((filePath, index) => insertSelected.run(next.id, filePath, index));
      }
      if (!trackSignatures || !previous || previous.queued !== queuedSignature) {
        deleteQueued.run(next.id);
        next.queuedPaths.forEach((filePath, index) => insertQueued.run(next.id, filePath, index));
      }
      upsertMeta.run(next.id);
      upsertGeneration.run(Math.max(currentGeneration + 1, this.nextGenerationFloor));
      this.db.exec('COMMIT');
      this.nextGenerationFloor = 0;
      if (nextFileSignatures) {
        this.persistedSessions.set(next.id, {
          files: nextFileSignatures,
          selected: selectedSignature,
          queued: queuedSignature,
        });
      } else {
        this.persistedSessions.delete(next.id);
      }
      while (this.persistedSessions.size > 8) {
        const oldest = this.persistedSessions.keys().next().value as string | undefined;
        if (!oldest) break;
        this.persistedSessions.delete(oldest);
      }
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return next;
  }

  private _saveDeltaImpl(
    session: AppSession,
    delta: NonNullable<ReturnType<typeof getSessionDeltaDescriptor>>,
  ): AppSession {
    // A delta only carries changed file rows, so its aggregate statistics cannot
    // be derived from session.files. The descriptor is the authoritative final
    // catalogue size; the remaining counters were incrementally maintained by
    // the renderer against the full checkpoint.
    const stats: SessionStats = {
      ...session.stats,
      totalFiles: delta.totalFileCount,
    };
    if (!saneDeltaStats(stats, delta.totalFileCount)) {
      throw new SessionIntegrityError('Session delta contains inconsistent aggregate statistics');
    }
    const existing = this.db.prepare(
      'SELECT id, total_files, picked, rejected, queued, reviewed FROM sessions WHERE id = ?',
    )
      .get(session.id) as Record<string, unknown> | undefined;
    if (!existing) throw new SessionIntegrityError('Cannot apply session delta before its checkpoint');
    // Validate against the O(1) aggregate stored on the session row. COUNT(*)
    // over a million-row session_files index would erase the delta benefit.
    if (sqliteNumber(existing.total_files) !== delta.totalFileCount) {
      throw new SessionIntegrityError('Session delta does not match the persisted checkpoint');
    }

    const upsertSession = this.db.prepare(`
      UPDATE sessions SET
        updated_at = ?, source_path = ?, dest_root = ?, filter = ?, focused_path = ?,
        import_ledger_id = ?, total_files = ?, picked = ?, rejected = ?, queued = ?, reviewed = ?
      WHERE id = ?
    `);
    const insertFile = this.db.prepare(`
      INSERT INTO session_files (session_id, path, sort_index, metadata_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, path) DO UPDATE SET
        sort_index = excluded.sort_index,
        metadata_json = excluded.metadata_json
    `);
    const selectFileAtIndex = this.db.prepare(
      'SELECT path, metadata_json FROM session_files WHERE session_id = ? AND sort_index = ?',
    );
    const selectFilePath = this.db.prepare(
      'SELECT 1 AS present FROM session_files WHERE session_id = ? AND path = ?',
    );
    const deleteFaces = this.db.prepare('DELETE FROM session_face_embeddings WHERE session_id = ? AND path = ?');
    const insertFace = this.db.prepare(`
      INSERT INTO session_face_embeddings (session_id, path, face_index, embedding, box_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    const deleteSelected = this.db.prepare('DELETE FROM session_selected WHERE session_id = ?');
    const insertSelected = this.db.prepare('INSERT INTO session_selected (session_id, path, sort_index) VALUES (?, ?, ?)');
    const deleteQueued = this.db.prepare('DELETE FROM session_queued WHERE session_id = ?');
    const insertQueued = this.db.prepare('INSERT INTO session_queued (session_id, path, sort_index) VALUES (?, ?, ?)');
    const upsertMeta = this.db.prepare(`
      INSERT INTO session_meta (key, value) VALUES ('latest_session_id', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    const readGeneration = this.db.prepare(
      "SELECT value FROM session_meta WHERE key = 'latest_session_generation'",
    );
    const upsertGeneration = this.db.prepare(`
      INSERT INTO session_meta (key, value) VALUES ('latest_session_generation', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    const currentGeneration = sqliteNumber((readGeneration.get() as Record<string, unknown> | undefined)?.value);

    let expectedPicked = sqliteNumber(existing.picked);
    let expectedRejected = sqliteNumber(existing.rejected);
    let expectedReviewed = sqliteNumber(existing.reviewed);
    for (let i = 0; i < session.files.length; i++) {
      const incoming = session.files[i];
      const existingAtIndex = selectFileAtIndex.get(session.id, delta.fileIndexes[i]) as Record<string, unknown> | undefined;
      if (sqliteString(existingAtIndex?.path) !== incoming.path) {
        throw new SessionIntegrityError('Session delta path does not match its persisted catalogue index');
      }
      let previous: MediaFile | null = null;
      try {
        previous = JSON.parse(String(existingAtIndex?.metadata_json)) as MediaFile;
      } catch {
        throw new SessionIntegrityError('Persisted session row metadata is invalid');
      }
      const previousPicked = previous.pick === 'selected';
      const previousRejected = previous.pick === 'rejected';
      const previousReviewed = !!previous.pick || typeof previous.reviewScore === 'number';
      const incomingPicked = incoming.pick === 'selected';
      const incomingRejected = incoming.pick === 'rejected';
      const incomingReviewed = !!incoming.pick || typeof incoming.reviewScore === 'number';
      expectedPicked += Number(incomingPicked) - Number(previousPicked);
      expectedRejected += Number(incomingRejected) - Number(previousRejected);
      expectedReviewed += Number(incomingReviewed) - Number(previousReviewed);
    }
    if (stats.picked !== expectedPicked
      || stats.rejected !== expectedRejected
      || stats.reviewed !== expectedReviewed) {
      throw new SessionIntegrityError('Session delta aggregate counters do not match its changed rows');
    }
    const expectedQueued = delta.queuedPathsChanged ? session.queuedPaths.length : sqliteNumber(existing.queued);
    if (stats.queued !== expectedQueued) {
      throw new SessionIntegrityError('Session delta queue count does not match its queue update');
    }
    if (delta.selectedPathsChanged) {
      for (const filePath of session.selectedPaths) {
        if (!selectFilePath.get(session.id, filePath)) throw new SessionIntegrityError('Session selection references an unknown file');
      }
    }
    if (delta.queuedPathsChanged) {
      for (const filePath of session.queuedPaths) {
        if (!selectFilePath.get(session.id, filePath)) throw new SessionIntegrityError('Session queue references an unknown file');
      }
    }
    if (session.focusedPath && !selectFilePath.get(session.id, session.focusedPath)) {
      throw new SessionIntegrityError('Session focus references an unknown file');
    }

    this.db.exec('BEGIN');
    try {
      upsertSession.run(
        session.updatedAt,
        session.sourcePath ?? null,
        session.destRoot ?? null,
        session.filter,
        compactString(session.focusedPath) ?? null,
        compactString(session.importLedgerId) ?? null,
        stats.totalFiles,
        stats.picked,
        stats.rejected,
        stats.queued,
        stats.reviewed,
        session.id,
      );

      for (let i = 0; i < session.files.length; i++) {
        const originalFile = session.files[i];
        const file = stripThumbnailFile(originalFile);
        const embeddings = faceEmbeddingsFor(originalFile);
        insertFile.run(session.id, file.path, delta.fileIndexes[i], JSON.stringify(stripSqliteMediaFile(file)));
        deleteFaces.run(session.id, file.path);
        for (let faceIndex = 0; faceIndex < embeddings.length; faceIndex++) {
          const hex = embeddings[faceIndex];
          if (!/^[0-9a-f]+$/i.test(hex) || hex.length < 8 || hex.length % 2 !== 0) continue;
          insertFace.run(
            session.id,
            file.path,
            faceIndex,
            Buffer.from(hex, 'hex'),
            embeddingBoxAt(originalFile, faceIndex) ? JSON.stringify(embeddingBoxAt(originalFile, faceIndex)) : null,
          );
        }
      }

      if (delta.selectedPathsChanged) {
        deleteSelected.run(session.id);
        session.selectedPaths.forEach((filePath, index) => insertSelected.run(session.id, filePath, index));
      }
      if (delta.queuedPathsChanged) {
        deleteQueued.run(session.id);
        session.queuedPaths.forEach((filePath, index) => insertQueued.run(session.id, filePath, index));
      }
      upsertMeta.run(session.id);
      upsertGeneration.run(Math.max(currentGeneration + 1, this.nextGenerationFloor));
      this.db.exec('COMMIT');
      this.nextGenerationFloor = 0;
      // A delta intentionally bypasses the old full-snapshot signature map.
      // Drop it so a later compatibility checkpoint cannot compare stale rows.
      this.persistedSessions.delete(session.id);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    return session;
  }

  async readLatest(): Promise<AppSession | null> {
    const latestRow = this.db.prepare("SELECT value FROM session_meta WHERE key = 'latest_session_id'")
      .get() as Record<string, unknown> | undefined;
    const latestId = sqliteString(latestRow?.value);
    if (latestId) {
      const session = this.readSession(latestId);
      if (session) return session;
    }
    const fallbackRow = this.db.prepare('SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 1')
      .get() as Record<string, unknown> | undefined;
    const fallbackId = sqliteString(fallbackRow?.id);
    return fallbackId ? this.readSession(fallbackId) : null;
  }

  async readLatestSummary(): Promise<AppSessionSummary | null> {
    const latestRow = this.db.prepare("SELECT value FROM session_meta WHERE key = 'latest_session_id'")
      .get() as Record<string, unknown> | undefined;
    const latestId = sqliteString(latestRow?.value);
    if (latestId) {
      const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?')
        .get(latestId) as Record<string, unknown> | undefined;
      if (row) return this.summaryFromRow(latestId, row);
    }
    const fallback = this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 1')
      .get() as Record<string, unknown> | undefined;
    const fallbackId = sqliteString(fallback?.id);
    return fallback && fallbackId ? this.summaryFromRow(fallbackId, fallback) : null;
  }

  async readRestorePage(sessionId: string, offset: number, limit: number): Promise<SessionRestorePageData | null> {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?')
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const summary = this.summaryFromRow(sessionId, row);
    const fileRows = this.db.prepare(`
      SELECT * FROM session_files
      WHERE session_id = ?
      ORDER BY sort_index ASC
      LIMIT ? OFFSET ?
    `).all(sessionId, limit, offset) as Record<string, unknown>[];
    const faceRows = this.db.prepare(`
      SELECT faces.*
      FROM session_face_embeddings AS faces
      INNER JOIN session_files AS files
        ON files.session_id = faces.session_id AND files.path = faces.path
      WHERE faces.session_id = ? AND files.sort_index >= ? AND files.sort_index < ?
      ORDER BY files.sort_index ASC, faces.face_index ASC
    `).all(sessionId, offset, offset + limit) as Record<string, unknown>[];
    const facesByPath = this.facesByPath(faceRows);
    const files = fileRows
      .map((fileRow) => this.fileFromRow(fileRow, facesByPath.get(String(fileRow.path)) ?? []))
      .filter((file): file is MediaFile => !!file);
    const selectedPaths = this.db.prepare(`
      SELECT path FROM session_selected
      WHERE session_id = ?
      ORDER BY sort_index ASC
      LIMIT ? OFFSET ?
    `).all(sessionId, limit, offset)
      .map((selectedRow) => sqliteString((selectedRow as Record<string, unknown>).path))
      .filter((value): value is string => !!value);
    const queuedPaths = this.db.prepare(`
      SELECT path FROM session_queued
      WHERE session_id = ?
      ORDER BY sort_index ASC
      LIMIT ? OFFSET ?
    `).all(sessionId, limit, offset)
      .map((queuedRow) => sqliteString((queuedRow as Record<string, unknown>).path))
      .filter((value): value is string => !!value);
    return {
      summary,
      offset,
      files,
      selectedPaths,
      queuedPaths,
      complete: offset + limit >= summary.stats.totalFiles,
    };
  }

  async verifyCheckpoint(session: AppSession): Promise<boolean> {
    const info = await this.readCheckpointInfo();
    return info?.id === session.id
      && info.updatedAt === session.updatedAt
      && info.totalFiles === session.stats.totalFiles;
  }

  async readCheckpointInfo(): Promise<SessionCheckpointInfo | null> {
    const latestRow = this.db.prepare("SELECT value FROM session_meta WHERE key = 'latest_session_id'")
      .get() as Record<string, unknown> | undefined;
    const id = sqliteString(latestRow?.value);
    if (!id) return null;
    const row = this.db.prepare('SELECT updated_at, total_files FROM sessions WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const generationRow = this.db.prepare(
      "SELECT value FROM session_meta WHERE key = 'latest_session_generation'",
    ).get() as Record<string, unknown> | undefined;
    const generation = sqliteNumber(generationRow?.value);
    return {
      id,
      updatedAt: sqliteString(row.updated_at) ?? new Date(0).toISOString(),
      totalFiles: sqliteNumber(row.total_files),
      ...(generation > 0 ? { generation } : {}),
    };
  }

  async purgeFaceData(): Promise<SessionFaceDataPurgeResult> {
    const operation = this.saveMutex.then(() => this.purgeFaceDataSync());
    this.saveMutex = operation.catch(() => undefined);
    return operation;
  }

  private purgeFaceDataSync(): SessionFaceDataPurgeResult {
    const rows = this.db.prepare('SELECT session_id, path, metadata_json FROM session_files').all() as Record<string, unknown>[];
    const embeddedPaths = this.db.prepare('SELECT DISTINCT session_id, path FROM session_face_embeddings').all() as Record<string, unknown>[];
    const purgedKeys = new Set(embeddedPaths.map((row) => `${String(row.session_id)}\u0000${String(row.path)}`));
    const updates: Array<{ sessionId: string; filePath: string; metadataJson: string }> = [];
    const reviewedBySession = new Map<string, number>();

    for (const row of rows) {
      let file: MediaFile;
      try {
        file = JSON.parse(String(row.metadata_json)) as MediaFile;
      } catch {
        throw new Error('Cannot safely purge unreadable persisted session metadata');
      }
      const purged = stripLocalFaceAndSubjectData(file);
      const sessionId = String(row.session_id);
      if (purged.pick || typeof purged.reviewScore === 'number') {
        reviewedBySession.set(sessionId, (reviewedBySession.get(sessionId) ?? 0) + 1);
      } else if (!reviewedBySession.has(sessionId)) {
        reviewedBySession.set(sessionId, 0);
      }
      if (purged === file) continue;
      const filePath = String(row.path);
      updates.push({ sessionId, filePath, metadataJson: JSON.stringify(purged) });
      purgedKeys.add(`${sessionId}\u0000${filePath}`);
    }

    const update = this.db.prepare(
      'UPDATE session_files SET metadata_json = ? WHERE session_id = ? AND path = ?',
    );
    const updateReviewed = this.db.prepare('UPDATE sessions SET reviewed = ? WHERE id = ?');
    this.db.exec('PRAGMA secure_delete = ON; BEGIN');
    try {
      this.db.prepare('DELETE FROM session_face_embeddings').run();
      for (const item of updates) update.run(item.metadataJson, item.sessionId, item.filePath);
      for (const [sessionId, reviewed] of reviewedBySession) updateReviewed.run(reviewed, sessionId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.persistedSessions.clear();
    // Truncate old WAL pages and rebuild the database so deleted embedding
    // blobs and superseded metadata JSON are not retained in SQLite free pages.
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
    return { sessionFilesPurged: purgedKeys.size };
  }

  async close(): Promise<void> {
    await this.saveMutex.catch(() => undefined);
    this.db.close();
  }

  private readSession(sessionId: string): AppSession | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?')
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const fileRows = this.db.prepare('SELECT * FROM session_files WHERE session_id = ? ORDER BY sort_index ASC')
      .all(sessionId) as Record<string, unknown>[];
    const faceRows = this.db.prepare('SELECT * FROM session_face_embeddings WHERE session_id = ? ORDER BY path ASC, face_index ASC')
      .all(sessionId) as Record<string, unknown>[];
    const facesByPath = this.facesByPath(faceRows);
    const files = fileRows
      .map((fileRow) => this.fileFromRow(fileRow, facesByPath.get(String(fileRow.path)) ?? []))
      .filter((file): file is MediaFile => !!file);
    const selectedPaths = this.db.prepare('SELECT path FROM session_selected WHERE session_id = ? ORDER BY sort_index ASC')
      .all(sessionId)
      .map((selectedRow) => sqliteString((selectedRow as Record<string, unknown>).path))
      .filter((value): value is string => !!value);
    const queuedPaths = this.db.prepare('SELECT path FROM session_queued WHERE session_id = ? ORDER BY sort_index ASC')
      .all(sessionId)
      .map((queuedRow) => sqliteString((queuedRow as Record<string, unknown>).path))
      .filter((value): value is string => !!value);

    return {
      id: sessionId,
      updatedAt: sqliteString(row.updated_at) ?? new Date(0).toISOString(),
      sourcePath: sqliteString(row.source_path) ?? null,
      destRoot: sqliteString(row.dest_root) ?? null,
      files,
      selectedPaths,
      queuedPaths,
      filter: sqliteString(row.filter) ?? 'all',
      focusedPath: sqliteString(row.focused_path),
      importLedgerId: sqliteString(row.import_ledger_id),
      stats: {
        totalFiles: sqliteNumber(row.total_files),
        picked: sqliteNumber(row.picked),
        rejected: sqliteNumber(row.rejected),
        queued: sqliteNumber(row.queued),
        reviewed: sqliteNumber(row.reviewed),
      },
    };
  }

  private summaryFromRow(sessionId: string, row: Record<string, unknown>): AppSessionSummary {
    return {
      id: sessionId,
      updatedAt: sqliteString(row.updated_at) ?? new Date(0).toISOString(),
      sourcePath: sqliteString(row.source_path) ?? null,
      destRoot: sqliteString(row.dest_root) ?? null,
      filter: sqliteString(row.filter) ?? 'all',
      focusedPath: sqliteString(row.focused_path),
      importLedgerId: sqliteString(row.import_ledger_id),
      stats: {
        totalFiles: sqliteNumber(row.total_files),
        picked: sqliteNumber(row.picked),
        rejected: sqliteNumber(row.rejected),
        queued: sqliteNumber(row.queued),
        reviewed: sqliteNumber(row.reviewed),
      },
    };
  }

  private facesByPath(
    faceRows: Record<string, unknown>[],
  ): Map<string, Array<{ index: number; embedding: string; box?: SessionFaceBox }>> {
    const facesByPath = new Map<string, Array<{ index: number; embedding: string; box?: SessionFaceBox }>>();
    for (const faceRow of faceRows) {
      const filePath = sqliteString(faceRow.path);
      const embedding = bufferToHex(faceRow.embedding);
      if (!filePath || !embedding) continue;
      const list = facesByPath.get(filePath) ?? [];
      list.push({
        index: sqliteNumber(faceRow.face_index),
        embedding,
        box: parseBoxJson(faceRow.box_json),
      });
      facesByPath.set(filePath, list);
    }
    return facesByPath;
  }

  private fileFromRow(
    row: Record<string, unknown>,
    faceRows: Array<{ index: number; embedding: string; box?: SessionFaceBox }>,
  ): MediaFile | null {
    try {
      const file = JSON.parse(String(row.metadata_json)) as MediaFile;
      if (!file || typeof file.path !== 'string') return null;
      const sortedFaces = [...faceRows].sort((a, b) => a.index - b.index);
      if (sortedFaces.length > 0) {
        const embeddings = sortedFaces.map((face) => face.embedding);
        file.faceEmbedding = embeddings[0];
        file.faceEmbeddings = embeddings;
        const boxes = sortedFaces.map((face) => face.box).filter((box): box is SessionFaceBox => !!box);
        if (boxes.length > 0) file.faceEmbeddingBoxes = boxes;
      }
      return file;
    } catch {
      return null;
    }
  }
}

export class SessionStoreService {
  /**
   * Once SQLite rejects a save, subsequent deltas must continue from the JSON
   * recovery checkpoint. Sending them back to the now-stale SQLite database
   * would silently fork the session history.
   */
  private legacyRecoveryActive = false;
  private operationMutex: Promise<unknown> = Promise.resolve();
  private legacyRestoreCache: AppSession | null = null;

  private constructor(
    private readonly backend: SessionStoreBackend,
    private readonly legacyJson: JsonSessionStore,
    public readonly storageKind: SessionStorageKind,
    public readonly storagePath: string,
  ) {}

  static async open(sessionDir: string, options: SessionStoreOpenOptions = {}): Promise<SessionStoreService> {
    await mkdir(sessionDir, { recursive: true });
    const legacyJson = new JsonSessionStore(sessionDir);
    await legacyJson.open();
    const sqlite = options.preferJson ? null : loadSqliteModule();
    if (sqlite) {
      const sqlitePath = path.join(sessionDir, SESSION_SQLITE_NAME);
      try {
        const sqliteStore = new SqliteSessionStore(sqlite, sqlitePath);
        await sqliteStore.open();
        return new SessionStoreService(sqliteStore, legacyJson, 'sqlite', sqlitePath);
      } catch {
        // Keep session recovery available in environments where node:sqlite is
        // present but cannot open the app userData path.
      }
    }
    return new SessionStoreService(legacyJson, legacyJson, 'json', legacyJson.latestPath);
  }

  async save(session: AppSession): Promise<AppSession> {
    const operation = this.operationMutex.then(() => this.saveImpl(session));
    this.operationMutex = operation.catch(() => undefined);
    return operation;
  }

  private async saveImpl(session: AppSession): Promise<AppSession> {
    this.legacyRestoreCache = null;
    const descriptor = getSessionDeltaDescriptor(session);
    if (hasSessionDeltaField(session) && !descriptor) {
      throw new Error('Invalid session delta descriptor');
    }
    if (descriptor && !saneDeltaStats(session.stats, descriptor.totalFileCount)) {
      throw new Error('Session delta contains inconsistent aggregate statistics');
    }
    if (this.legacyRecoveryActive && this.storageKind === 'sqlite') {
      return this.legacyJson.save(session);
    }
    try {
      return await this.backend.save(session);
    } catch (error) {
      if (this.storageKind === 'json') throw error;
      if (error instanceof SessionIntegrityError) throw error;
      const current = await this.backend.readLatest().catch(() => null);
      const recovered = current ? applySessionDelta(current, session) : null;
      if (getSessionDeltaDescriptor(session) && !recovered) throw error;
      const currentInfo = await this.backend.readCheckpointInfo().catch(() => null);
      const saved = await this.legacyJson.saveWithGeneration(
        recovered ?? session,
        (currentInfo?.generation ?? 0) + 1,
      );
      this.legacyRecoveryActive = true;
      return saved;
    }
  }

  async readLatest(): Promise<AppSession | null> {
    if (this.storageKind === 'json') return this.backend.readLatest();

    // Read SQLite first. A million-row legacy JSON file must not be parsed on
    // every normal startup merely because it was left behind by migration.
    const current = await this.backend.readLatest();
    const currentInfo = await this.backend.readCheckpointInfo();
    const legacyHeader = await this.legacyJson.readLatestHeader();
    if (!legacyHeader) return current;

    const currentUpdatedAt = current ? Date.parse(current.updatedAt) : Number.NEGATIVE_INFINITY;
    const legacyUpdatedAt = Date.parse(legacyHeader.updatedAt);
    const generationsComparable = currentInfo?.generation != null && legacyHeader.generation != null;
    const legacyIsNewer = this.legacyRecoveryActive
      || !current
      || (generationsComparable
        ? legacyHeader.generation! > currentInfo!.generation!
        : Number.isFinite(legacyUpdatedAt)
          && (!Number.isFinite(currentUpdatedAt) || legacyUpdatedAt > currentUpdatedAt));

    if (!legacyIsNewer) {
      // SQLite already contains the same/newer durable checkpoint. Archive the
      // fallback by rename (recoverable, no large copy) so later startups do
      // not repeatedly inspect it.
      const equalGenerationAndIdentity = generationsComparable
        && legacyHeader.generation === currentInfo!.generation
        && legacyHeader.id === currentInfo!.id
        && legacyHeader.updatedAt === currentInfo!.updatedAt
        && legacyHeader.totalFiles === currentInfo!.totalFiles;
      const currentStrictlyNewer = generationsComparable
        ? currentInfo!.generation! > legacyHeader.generation!
        : Number.isFinite(currentUpdatedAt)
          && Number.isFinite(legacyUpdatedAt)
          && currentUpdatedAt > legacyUpdatedAt;
      if (current
        && (currentStrictlyNewer || equalGenerationAndIdentity)
        && await this.backend.verifyCheckpoint(current)) {
        await this.legacyJson.archiveCheckpoint(legacyHeader);
      }
      return current;
    }

    // Only now pay the cost of parsing legacy JSON: it is the sole/newer
    // recovery source. Heal SQLite transactionally and retire the fallback
    // only after an O(1) verification of id, timestamp, and catalogue count.
    const legacy = await this.legacyJson.readLatest();
    if (!legacy) return current;
    try {
      const healed = await this.backend.saveWithGeneration(
        legacy,
        legacyHeader.generation ?? 0,
      );
      if (!await this.backend.verifyCheckpoint(healed)) {
        throw new Error('SQLite session recovery verification failed');
      }
      this.legacyRecoveryActive = false;
      await this.legacyJson.archiveCheckpoint(legacyHeader);
      return healed;
    } catch {
      this.legacyRecoveryActive = true;
      return legacy;
    }
  }

  async readLatestSummary(): Promise<AppSessionSummary | null> {
    if (this.storageKind === 'json') return this.backend.readLatestSummary();

    const current = await this.backend.readLatestSummary();
    const currentInfo = await this.backend.readCheckpointInfo();
    const legacyHeader = await this.legacyJson.readLatestHeader();
    if (!legacyHeader) return current;
    const legacy = await this.legacyJson.readLatestSummary();
    if (!legacy) return current;

    const currentUpdatedAt = current ? Date.parse(current.updatedAt) : Number.NEGATIVE_INFINITY;
    const legacyUpdatedAt = Date.parse(legacy.updatedAt);
    const generationsComparable = currentInfo?.generation != null && legacyHeader.generation != null;
    const legacyIsNewer = this.legacyRecoveryActive
      || !current
      || (generationsComparable
        ? legacyHeader.generation! > currentInfo!.generation!
        : Number.isFinite(legacyUpdatedAt)
          && (!Number.isFinite(currentUpdatedAt) || legacyUpdatedAt > currentUpdatedAt));
    return legacyIsNewer ? legacy : current;
  }

  async readRestorePage(sessionId: string, offset: number, limit: number): Promise<SessionRestorePageData | null> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) return null;
    const latest = await this.readLatestSummary();
    if (!latest || latest.id !== sessionId) return null;

    if (this.storageKind === 'json') {
      return this.backend.readRestorePage(sessionId, offset, limit);
    }
    const current = await this.backend.readLatestSummary();
    if (current?.id === latest.id && current.updatedAt === latest.updatedAt && !this.legacyRecoveryActive) {
      return this.backend.readRestorePage(sessionId, offset, limit);
    }

    // A newer JSON recovery checkpoint is exceptional. Parse it only after the
    // user explicitly restores, then retain that one main-owned object while
    // its bounded pages are transferred and SQLite is healed by readLatest().
    let session = this.legacyRestoreCache?.id === sessionId ? this.legacyRestoreCache : null;
    if (!session) {
      session = await this.readLatest();
      if (!session || session.id !== sessionId) return null;
      this.legacyRestoreCache = session;
    }
    return {
      summary: summaryForSession(session),
      offset,
      files: session.files.slice(offset, offset + limit),
      selectedPaths: session.selectedPaths.slice(offset, offset + limit),
      queuedPaths: session.queuedPaths.slice(offset, offset + limit),
      complete: offset + limit >= session.files.length,
    };
  }

  async purgeFaceData(): Promise<SessionFaceDataPurgeResult> {
    const operation = this.operationMutex.then(async () => {
      this.legacyRestoreCache = null;
      const primary = await this.backend.purgeFaceData();
      if (this.storageKind === 'json') return primary;
      const legacy = await this.legacyJson.purgeFaceData();
      return { sessionFilesPurged: primary.sessionFilesPurged + legacy.sessionFilesPurged };
    });
    this.operationMutex = operation.catch(() => undefined);
    return operation;
  }

  async close(): Promise<void> {
    await this.operationMutex.catch(() => undefined);
    await this.backend.close();
  }
}

export async function openSessionStore(sessionDir: string, options: SessionStoreOpenOptions = {}): Promise<SessionStoreService> {
  return SessionStoreService.open(sessionDir, options);
}
