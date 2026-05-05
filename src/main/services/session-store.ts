import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { AppSession, MediaFile } from '../../shared/types';

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
  readLatest(): Promise<AppSession | null>;
  close(): Promise<void>;
}

const SESSION_SQLITE_NAME = 'keptra-sessions.sqlite';
const SESSION_JSON_LATEST_NAME = 'latest.json';

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
  const { thumbnail: _thumbnail, ...metadata } = file;
  return metadata as MediaFile;
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
    files: session.files.map(stripThumbnailFile),
  };
}

function sessionStats(session: AppSession): SessionStats {
  const stats = session.stats;
  if (stats && Number.isFinite(stats.totalFiles)) return stats;
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
    files: session.files.map(stripThumbnailFile),
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

  constructor(private readonly sessionDir: string) {
    this.latestPath = path.join(sessionDir, SESSION_JSON_LATEST_NAME);
  }

  async open(): Promise<void> {
    await mkdir(this.sessionDir, { recursive: true });
  }

  async save(session: AppSession): Promise<AppSession> {
    const next = leanSession(session);
    await mkdir(this.sessionDir, { recursive: true });
    const sessionPath = path.join(this.sessionDir, `${next.id}.json`);
    const content = JSON.stringify(next);
    await this.writeAtomic(sessionPath, content);
    await this.writeAtomic(this.latestPath, content);
    return next;
  }

  async readLatest(): Promise<AppSession | null> {
    try {
      const raw = await readFile(this.latestPath, 'utf8');
      const session = readJsonSession(raw);
      if (!session) return null;
      const next = leanSession(session);
      if (raw !== JSON.stringify(next)) {
        await this.save(next).catch(() => undefined);
      }
      return next;
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {}

  private async writeAtomic(targetPath: string, content: string): Promise<void> {
    const tempPath = `${targetPath}.tmp`;
    await writeFile(tempPath, content, { encoding: 'utf8', mode: 0o600 });
    await rename(tempPath, targetPath);
  }
}

class SqliteSessionStore implements SessionStoreBackend {
  private readonly db: SqliteDatabase;

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
    const next = leanSession(session);
    const stats = sessionStats(next);
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
    `);
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
      deleteFiles.run(next.id);
      deleteSelected.run(next.id);
      deleteQueued.run(next.id);

      for (let index = 0; index < next.files.length; index++) {
        const originalFile = session.files[index] ?? next.files[index];
        const file = next.files[index];
        insertFile.run(next.id, file.path, index, JSON.stringify(stripSqliteMediaFile(file)));
        const embeddings = faceEmbeddingsFor(originalFile);
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

      next.selectedPaths.forEach((filePath, index) => insertSelected.run(next.id, filePath, index));
      next.queuedPaths.forEach((filePath, index) => insertQueued.run(next.id, filePath, index));
      upsertMeta.run(next.id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return next;
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

  async close(): Promise<void> {
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
    try {
      return await this.backend.save(session);
    } catch (error) {
      if (this.storageKind === 'json') throw error;
      return this.legacyJson.save(session);
    }
  }

  async readLatest(): Promise<AppSession | null> {
    const current = await this.backend.readLatest();
    if (current) return current;
    const legacy = await this.legacyJson.readLatest();
    if (!legacy) return null;
    if (this.storageKind === 'sqlite') {
      await this.backend.save(legacy).catch(() => undefined);
    }
    return legacy;
  }

  async close(): Promise<void> {
    await this.backend.close();
  }
}

export async function openSessionStore(sessionDir: string, options: SessionStoreOpenOptions = {}): Promise<SessionStoreService> {
  return SessionStoreService.open(sessionDir, options);
}
