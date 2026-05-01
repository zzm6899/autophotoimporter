import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type {
  CatalogBackupResult,
  CatalogBrowserQuery,
  CatalogBrowserRecord,
  CatalogBrowserResult,
  CatalogImportedFilter,
  CatalogMaintenanceResult,
  CatalogMissingPath,
  CatalogPruneResult,
  CatalogStats,
  ImportConfig,
  ImportLedgerItem,
  ImportResult,
  MediaFile,
} from '../../shared/types';

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

export type CatalogStorageKind = 'sqlite' | 'json';

export interface CatalogOpenOptions {
  preferJson?: boolean;
  now?: () => string;
}

export interface CatalogUpsertResult {
  upserted: number;
  duplicateCandidates: CatalogDuplicateCandidate[];
}

export interface CatalogRecordImportOptions {
  sessionId?: string;
  importedAt?: string;
}

export interface CatalogRecordImportResult {
  recorded: number;
}

export interface CatalogDuplicateCandidate {
  sourcePath: string;
  name: string;
  size: number;
  visualHash?: string;
  matchedPaths: string[];
  matchedSessionIds: string[];
  matchCount: number;
  importedCount: number;
  lastSeenAt?: string;
  lastImportedAt?: string;
  reason: 'identity' | 'visual-hash';
}

export interface CatalogDuplicateMemoryMatch {
  path: string;
  kind: 'previous-import' | 'previous-reject' | 'same-visual';
  matchedPath: string;
  importedAt?: string;
  rejectedAt?: string;
}

interface CatalogMediaRecord {
  sourcePath: string;
  name: string;
  normalizedName: string;
  size: number;
  type: MediaFile['type'];
  extension: string;
  dateTaken?: string;
  visualHash?: string;
  sessionId?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  metadata: Omit<MediaFile, 'thumbnail'>;
}

interface CatalogImportOutcomeRecord {
  id: number;
  ledgerId: string;
  sessionId?: string;
  sourcePath: string;
  name: string;
  normalizedName: string;
  size: number;
  destRelPath?: string;
  destFullPath?: string;
  backupFullPath?: string;
  status: ImportLedgerItem['status'];
  error?: string;
  createdAt: string;
}

interface JsonCatalogState {
  version: 1;
  mediaFiles: Record<string, CatalogMediaRecord>;
  importOutcomes: CatalogImportOutcomeRecord[];
  nextImportOutcomeId: number;
}

export interface DuplicateLookupOptions {
  currentSessionId?: string;
}

const CATALOG_SQLITE_NAME = 'keptra-catalog.sqlite';
const CATALOG_JSON_NAME = 'keptra-catalog.json';

const createNodeRequire = createRequire(import.meta.url);

function loadSqliteModule(): SqliteModule | null {
  try {
    return createNodeRequire('node:sqlite') as SqliteModule;
  } catch {
    return null;
  }
}

function emptyJsonState(): JsonCatalogState {
  return {
    version: 1,
    mediaFiles: {},
    importOutcomes: [],
    nextImportOutcomeId: 1,
  };
}

function normalizeName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

function compactString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function stripThumbnail(file: MediaFile): Omit<MediaFile, 'thumbnail'> {
  const { thumbnail: _thumbnail, ...metadata } = file;
  return metadata;
}

function mediaRecordFromFile(file: MediaFile, now: string, sessionId?: string, previous?: CatalogMediaRecord): CatalogMediaRecord {
  return {
    sourcePath: file.path,
    name: file.name,
    normalizedName: normalizeName(file.name),
    size: file.size,
    type: file.type,
    extension: file.extension,
    dateTaken: compactString(file.dateTaken),
    visualHash: compactString(file.visualHash),
    sessionId: compactString(sessionId),
    firstSeenAt: previous?.firstSeenAt ?? now,
    lastSeenAt: now,
    metadata: stripThumbnail(file),
  };
}

function importRecordFromItem(
  ledgerId: string,
  item: ImportLedgerItem,
  id: number,
  createdAt: string,
  sessionId?: string,
): CatalogImportOutcomeRecord {
  return {
    id,
    ledgerId,
    sessionId: compactString(sessionId),
    sourcePath: item.sourcePath,
    name: item.name,
    normalizedName: normalizeName(item.name),
    size: item.size,
    destRelPath: compactString(item.destRelPath),
    destFullPath: compactString(item.destFullPath),
    backupFullPath: compactString(item.backupFullPath),
    status: item.status,
    error: compactString(item.error),
    createdAt,
  };
}

function isImportSuccess(status: ImportLedgerItem['status']): boolean {
  return status === 'imported' || status === 'verified';
}

function toStringArray(values: Set<string>): string[] {
  return Array.from(values).filter(Boolean).sort();
}

function buildDuplicateCandidate(
  file: Pick<MediaFile, 'path' | 'name' | 'size' | 'visualHash'>,
  mediaMatches: CatalogMediaRecord[],
  importMatches: CatalogImportOutcomeRecord[],
): CatalogDuplicateCandidate | null {
  const matchedPaths = new Set<string>();
  const matchedSessionIds = new Set<string>();
  let lastSeenAt: string | undefined;
  let lastImportedAt: string | undefined;
  let hasVisualMatch = false;

  for (const match of mediaMatches) {
    if (match.sourcePath === file.path) continue;
    matchedPaths.add(match.sourcePath);
    if (match.sessionId) matchedSessionIds.add(match.sessionId);
    if (!lastSeenAt || match.lastSeenAt > lastSeenAt) lastSeenAt = match.lastSeenAt;
    if (file.visualHash && match.visualHash === file.visualHash) hasVisualMatch = true;
  }

  let importedCount = 0;
  for (const match of importMatches) {
    if (match.sourcePath === file.path) continue;
    matchedPaths.add(match.sourcePath);
    if (match.sessionId) matchedSessionIds.add(match.sessionId);
    if (isImportSuccess(match.status)) {
      importedCount++;
      if (!lastImportedAt || match.createdAt > lastImportedAt) lastImportedAt = match.createdAt;
    }
    if (file.visualHash && match.normalizedName === normalizeName(file.name)) hasVisualMatch = true;
  }

  const paths = toStringArray(matchedPaths);
  if (paths.length === 0 && importedCount === 0) return null;

  return {
    sourcePath: file.path,
    name: file.name,
    size: file.size,
    visualHash: compactString(file.visualHash),
    matchedPaths: paths,
    matchedSessionIds: toStringArray(matchedSessionIds),
    matchCount: paths.length,
    importedCount,
    lastSeenAt,
    lastImportedAt,
    reason: hasVisualMatch ? 'visual-hash' : 'identity',
  };
}

function sqliteString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function sqliteNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function mediaRecordFromSql(row: Record<string, unknown>): CatalogMediaRecord {
  return {
    sourcePath: String(row.source_path),
    name: String(row.name),
    normalizedName: String(row.normalized_name),
    size: sqliteNumber(row.size),
    type: row.type === 'video' ? 'video' : 'photo',
    extension: String(row.extension ?? ''),
    dateTaken: sqliteString(row.date_taken),
    visualHash: sqliteString(row.visual_hash),
    sessionId: sqliteString(row.session_id),
    firstSeenAt: String(row.first_seen_at),
    lastSeenAt: String(row.last_seen_at),
    metadata: JSON.parse(String(row.metadata_json ?? '{}')) as Omit<MediaFile, 'thumbnail'>,
  };
}

function importRecordFromSql(row: Record<string, unknown>): CatalogImportOutcomeRecord {
  return {
    id: sqliteNumber(row.id),
    ledgerId: String(row.ledger_id),
    sessionId: sqliteString(row.session_id),
    sourcePath: String(row.source_path),
    name: String(row.name),
    normalizedName: String(row.normalized_name),
    size: sqliteNumber(row.size),
    destRelPath: sqliteString(row.dest_rel_path),
    destFullPath: sqliteString(row.dest_full_path),
    backupFullPath: sqliteString(row.backup_full_path),
    status: String(row.status) as ImportLedgerItem['status'],
    error: sqliteString(row.error),
    createdAt: String(row.created_at),
  };
}

function acceptsMatch(
  file: Pick<MediaFile, 'path' | 'name' | 'size' | 'visualHash'>,
  record: { sourcePath: string; visualHash?: string; sessionId?: string },
  options: DuplicateLookupOptions = {},
): boolean {
  if (record.sourcePath === file.path) return false;
  if (options.currentSessionId && record.sessionId === options.currentSessionId) return false;
  if (file.visualHash && record.visualHash) return record.visualHash === file.visualHash;
  return true;
}

function metadataString(record: CatalogMediaRecord | undefined, key: 'cameraMake' | 'cameraModel' | 'lensModel'): string | undefined {
  const value = record?.metadata[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function latestImportOutcome(records: CatalogImportOutcomeRecord[]): CatalogImportOutcomeRecord | undefined {
  return records.reduce<CatalogImportOutcomeRecord | undefined>((latest, record) => {
    if (!latest) return record;
    return record.createdAt >= latest.createdAt ? record : latest;
  }, undefined);
}

function buildBrowserRecords(
  mediaRecords: CatalogMediaRecord[],
  importRecords: CatalogImportOutcomeRecord[],
): CatalogBrowserRecord[] {
  const importsBySource = new Map<string, CatalogImportOutcomeRecord[]>();
  for (const record of importRecords) {
    const records = importsBySource.get(record.sourcePath) ?? [];
    records.push(record);
    importsBySource.set(record.sourcePath, records);
  }

  const records = new Map<string, CatalogBrowserRecord>();
  for (const media of mediaRecords) {
    const imports = importsBySource.get(media.sourcePath) ?? [];
    const latestImport = latestImportOutcome(imports);
    const successfulImports = imports.filter((record) => isImportSuccess(record.status));
    const latestSuccessfulImport = latestImportOutcome(successfulImports);
    records.set(media.sourcePath, {
      id: media.sourcePath,
      sourcePath: media.sourcePath,
      name: media.name,
      size: media.size,
      type: media.type,
      extension: media.extension,
      dateTaken: media.dateTaken,
      cameraMake: metadataString(media, 'cameraMake'),
      cameraModel: metadataString(media, 'cameraModel'),
      lensModel: metadataString(media, 'lensModel'),
      visualHash: media.visualHash,
      sessionId: media.sessionId,
      firstSeenAt: media.firstSeenAt,
      lastSeenAt: media.lastSeenAt,
      imported: successfulImports.length > 0,
      importStatus: latestImport?.status,
      destRelPath: latestSuccessfulImport?.destRelPath ?? latestImport?.destRelPath,
      destFullPath: latestSuccessfulImport?.destFullPath ?? latestImport?.destFullPath,
      backupFullPath: latestSuccessfulImport?.backupFullPath ?? latestImport?.backupFullPath,
      lastImportedAt: latestSuccessfulImport?.createdAt,
      error: latestImport?.error,
    });
  }

  for (const [sourcePath, imports] of importsBySource) {
    if (records.has(sourcePath)) continue;
    const latestImport = latestImportOutcome(imports);
    if (!latestImport) continue;
    const successfulImports = imports.filter((record) => isImportSuccess(record.status));
    const latestSuccessfulImport = latestImportOutcome(successfulImports);
    records.set(sourcePath, {
      id: sourcePath,
      sourcePath,
      name: latestImport.name,
      size: latestImport.size,
      imported: successfulImports.length > 0,
      importStatus: latestImport.status,
      destRelPath: latestSuccessfulImport?.destRelPath ?? latestImport.destRelPath,
      destFullPath: latestSuccessfulImport?.destFullPath ?? latestImport.destFullPath,
      backupFullPath: latestSuccessfulImport?.backupFullPath ?? latestImport.backupFullPath,
      lastImportedAt: latestSuccessfulImport?.createdAt,
      error: latestImport.error,
      sessionId: latestImport.sessionId,
    });
  }

  return Array.from(records.values());
}

function includesFolded(value: string | undefined, query: string): boolean {
  return value?.toLocaleLowerCase().includes(query) ?? false;
}

function matchesImportedFilter(imported: boolean, filter: CatalogImportedFilter | undefined): boolean {
  if (!filter || filter === 'any') return true;
  return filter === 'imported' ? imported : !imported;
}

function filterBrowserRecord(record: CatalogBrowserRecord, query: CatalogBrowserQuery): boolean {
  const search = query.search?.trim().toLocaleLowerCase();
  if (search) {
    const fields = [
      record.name,
      record.sourcePath,
      record.destRelPath,
      record.destFullPath,
      record.backupFullPath,
      record.cameraMake,
      record.cameraModel,
      record.lensModel,
      record.visualHash,
    ];
    if (!fields.some((value) => includesFolded(value, search))) return false;
  }

  if (query.sourcePath?.trim() && !includesFolded(record.sourcePath, query.sourcePath.trim().toLocaleLowerCase())) return false;
  const destination = query.destinationPath?.trim().toLocaleLowerCase();
  if (destination && ![
    record.destRelPath,
    record.destFullPath,
    record.backupFullPath,
  ].some((value) => includesFolded(value, destination))) return false;
  const camera = query.camera?.trim().toLocaleLowerCase();
  if (camera && ![record.cameraMake, record.cameraModel].some((value) => includesFolded(value, camera))) return false;
  const lens = query.lens?.trim().toLocaleLowerCase();
  if (lens && !includesFolded(record.lensModel, lens)) return false;
  const visualHash = query.visualHash?.trim().toLocaleLowerCase();
  if (visualHash && !includesFolded(record.visualHash, visualHash)) return false;
  return matchesImportedFilter(record.imported, query.imported);
}

function compareBrowserRecords(a: CatalogBrowserRecord, b: CatalogBrowserRecord, query: CatalogBrowserQuery): number {
  const direction = query.sortDirection === 'asc' ? 1 : -1;
  const sortBy = query.sortBy ?? 'lastSeenAt';
  const valueA = sortBy === 'size' ? a.size : String(a[sortBy] ?? '');
  const valueB = sortBy === 'size' ? b.size : String(b[sortBy] ?? '');
  if (valueA < valueB) return -1 * direction;
  if (valueA > valueB) return 1 * direction;
  return a.name.localeCompare(b.name);
}

function browseCatalogRecords(
  mediaRecords: CatalogMediaRecord[],
  importRecords: CatalogImportOutcomeRecord[],
  query: CatalogBrowserQuery = {},
): CatalogBrowserResult {
  const limit = Math.max(1, Math.min(500, Math.round(query.limit ?? 50)));
  const offset = Math.max(0, Math.round(query.offset ?? 0));
  const filtered = buildBrowserRecords(mediaRecords, importRecords)
    .filter((record) => filterBrowserRecord(record, query))
    .sort((a, b) => compareBrowserRecords(a, b, query));

  return {
    records: filtered.slice(offset, offset + limit),
    total: filtered.length,
    limit,
    offset,
  };
}

async function pathExists(filePath: string | undefined): Promise<boolean> {
  if (!filePath) return false;
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function verifyCatalogPaths(
  mediaRecords: CatalogMediaRecord[],
  importRecords: CatalogImportOutcomeRecord[],
): Promise<CatalogMaintenanceResult> {
  const rows = buildBrowserRecords(mediaRecords, importRecords);
  const missingPaths: CatalogMissingPath[] = [];

  for (const row of rows) {
    const pushMissing = (kind: CatalogMissingPath['kind'], filePath: string) => {
      missingPaths.push({
        kind,
        sourcePath: row.sourcePath,
        path: filePath,
        name: row.name,
        imported: row.imported,
        lastSeenAt: row.lastSeenAt,
        lastImportedAt: row.lastImportedAt,
      });
    };

    if (row.sourcePath && !(await pathExists(row.sourcePath))) pushMissing('source', row.sourcePath);
    if (row.destFullPath && !(await pathExists(row.destFullPath))) pushMissing('destination', row.destFullPath);
    if (row.backupFullPath && !(await pathExists(row.backupFullPath))) pushMissing('backup', row.backupFullPath);
  }

  return {
    checked: rows.length,
    missingSources: missingPaths.filter((item) => item.kind === 'source').length,
    missingDestinations: missingPaths.filter((item) => item.kind === 'destination').length,
    missingBackups: missingPaths.filter((item) => item.kind === 'backup').length,
    missingPaths,
  };
}

async function shouldPruneImportRecord(record: CatalogImportOutcomeRecord): Promise<boolean> {
  const paths = [record.sourcePath, record.destFullPath, record.backupFullPath].filter(Boolean) as string[];
  if (paths.length === 0) return true;
  const exists = await Promise.all(paths.map((filePath) => pathExists(filePath)));
  return exists.every((item) => !item);
}

function serializeCatalogBackup(
  storageKind: CatalogStorageKind,
  catalogPath: string,
  mediaRecords: CatalogMediaRecord[],
  importRecords: CatalogImportOutcomeRecord[],
): string {
  return JSON.stringify({
    version: 1,
    exportedAt: new Date().toISOString(),
    storageKind,
    catalogPath,
    mediaFiles: mediaRecords,
    importOutcomes: importRecords,
  }, null, 2);
}

class JsonCatalogStore {
  private state: JsonCatalogState = emptyJsonState();

  constructor(private readonly catalogPath: string) {}

  async open(): Promise<void> {
    try {
      const raw = await readFile(this.catalogPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<JsonCatalogState>;
      this.state = {
        version: 1,
        mediaFiles: parsed.mediaFiles ?? {},
        importOutcomes: parsed.importOutcomes ?? [],
        nextImportOutcomeId: parsed.nextImportOutcomeId ?? 1,
      };
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== 'ENOENT') throw err;
      this.state = emptyJsonState();
    }
  }

  async upsertMediaFiles(files: MediaFile[], now: string, sessionId?: string): Promise<number> {
    const count = this.upsertMediaFilesSync(files, now, sessionId, false);
    await this.persist();
    return count;
  }

  upsertMediaFilesSync(files: MediaFile[], now: string, sessionId?: string, persist = true): number {
    for (const file of files) {
      const previous = this.state.mediaFiles[file.path];
      this.state.mediaFiles[file.path] = mediaRecordFromFile(file, now, sessionId, previous);
    }
    if (persist) void this.persist();
    return files.length;
  }

  async recordImportLedgerItems(
    ledgerId: string,
    items: ImportLedgerItem[],
    createdAt: string,
    sessionId?: string,
  ): Promise<number> {
    const count = this.recordImportLedgerItemsSync(ledgerId, items, createdAt, sessionId, false);
    await this.persist();
    return count;
  }

  recordImportLedgerItemsSync(
    ledgerId: string,
    items: ImportLedgerItem[],
    createdAt: string,
    sessionId?: string,
    persist = true,
  ): number {
    for (const item of items) {
      this.state.importOutcomes.push(importRecordFromItem(
        ledgerId,
        item,
        this.state.nextImportOutcomeId++,
        createdAt,
        sessionId,
      ));
    }
    if (persist) void this.persist();
    return items.length;
  }

  async findDuplicateCandidates(files: MediaFile[], options: DuplicateLookupOptions): Promise<CatalogDuplicateCandidate[]> {
    return this.findDuplicateCandidatesSync(files, options);
  }

  findDuplicateCandidatesSync(files: MediaFile[], options: DuplicateLookupOptions): CatalogDuplicateCandidate[] {
    const records = Object.values(this.state.mediaFiles);
    return files
      .map((file) => {
        const normalizedName = normalizeName(file.name);
        const mediaMatches = records.filter((record) =>
          record.normalizedName === normalizedName &&
          record.size === file.size &&
          acceptsMatch(file, record, options),
        );
        const importMatches = this.state.importOutcomes.filter((record) =>
          record.normalizedName === normalizedName &&
          record.size === file.size &&
          acceptsMatch(file, record, options),
        );
        return buildDuplicateCandidate(file, mediaMatches, importMatches);
      })
      .filter((candidate): candidate is CatalogDuplicateCandidate => candidate !== null);
  }

  async getStats(storageKind: CatalogStorageKind): Promise<CatalogStats> {
    const media = Object.values(this.state.mediaFiles);
    const imported = this.state.importOutcomes.filter((record) => isImportSuccess(record.status));
    const identityCounts = new Map<string, number>();
    for (const record of media) {
      const key = `${record.normalizedName}:${record.size}:${record.visualHash ?? ''}`;
      identityCounts.set(key, (identityCounts.get(key) ?? 0) + 1);
    }

    return {
      storageKind,
      catalogPath: this.catalogPath,
      totalFiles: media.length,
      totalBytes: media.reduce((sum, file) => sum + file.size, 0),
      importedFiles: new Set(imported.map((record) => record.sourcePath)).size,
      duplicateIdentities: Array.from(identityCounts.values()).filter((count) => count > 1).length,
      importOutcomes: this.state.importOutcomes.length,
      lastSeenAt: media.map((record) => record.lastSeenAt).sort().at(-1),
      lastImportedAt: imported.map((record) => record.createdAt).sort().at(-1),
    };
  }

  async browse(query: CatalogBrowserQuery): Promise<CatalogBrowserResult> {
    return browseCatalogRecords(Object.values(this.state.mediaFiles), this.state.importOutcomes, query);
  }

  async verifyMissingPaths(): Promise<CatalogMaintenanceResult> {
    return verifyCatalogPaths(Object.values(this.state.mediaFiles), this.state.importOutcomes);
  }

  async pruneMissingEntries(): Promise<CatalogPruneResult> {
    const verification = await this.verifyMissingPaths();
    const missingSources = new Set(
      verification.missingPaths
        .filter((item) => item.kind === 'source')
        .map((item) => item.sourcePath),
    );

    const beforeMedia = Object.keys(this.state.mediaFiles).length;
    for (const sourcePath of missingSources) {
      delete this.state.mediaFiles[sourcePath];
    }

    const beforeImports = this.state.importOutcomes.length;
    const retainedImports: CatalogImportOutcomeRecord[] = [];
    for (const record of this.state.importOutcomes) {
      if (!(await shouldPruneImportRecord(record))) retainedImports.push(record);
    }
    this.state.importOutcomes = retainedImports;
    await this.persist();

    return {
      ...verification,
      removedMediaFiles: beforeMedia - Object.keys(this.state.mediaFiles).length,
      removedImportOutcomes: beforeImports - this.state.importOutcomes.length,
    };
  }

  async exportBackup(outputPath: string, storageKind: CatalogStorageKind): Promise<CatalogBackupResult> {
    await mkdir(path.dirname(outputPath), { recursive: true });
    const content = serializeCatalogBackup(
      storageKind,
      this.catalogPath,
      Object.values(this.state.mediaFiles),
      this.state.importOutcomes,
    );
    await writeFile(outputPath, content, 'utf8');
    return {
      path: outputPath,
      bytes: Buffer.byteLength(content, 'utf8'),
      mediaFiles: Object.keys(this.state.mediaFiles).length,
      importOutcomes: this.state.importOutcomes.length,
    };
  }

  async close(): Promise<void> {
    await this.persist();
  }

  private async persist(): Promise<void> {
    const tempPath = `${this.catalogPath}.tmp`;
    await writeFile(tempPath, JSON.stringify(this.state, null, 2), 'utf8');
    await rename(tempPath, this.catalogPath);
  }
}

class SqliteCatalogStore {
  private readonly db: SqliteDatabase;

  constructor(sqlite: SqliteModule, private readonly catalogPath: string) {
    this.db = new sqlite.DatabaseSync(catalogPath);
  }

  async open(): Promise<void> {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS media_files (
        source_path TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        size INTEGER NOT NULL,
        type TEXT NOT NULL,
        extension TEXT NOT NULL,
        date_taken TEXT,
        visual_hash TEXT,
        session_id TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_media_identity
        ON media_files (normalized_name, size, visual_hash);
      CREATE INDEX IF NOT EXISTS idx_media_last_seen
        ON media_files (last_seen_at);

      CREATE TABLE IF NOT EXISTS import_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ledger_id TEXT NOT NULL,
        session_id TEXT,
        source_path TEXT NOT NULL,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        size INTEGER NOT NULL,
        dest_rel_path TEXT,
        dest_full_path TEXT,
        backup_full_path TEXT,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_import_identity
        ON import_outcomes (normalized_name, size);
      CREATE INDEX IF NOT EXISTS idx_import_source
        ON import_outcomes (source_path);
      CREATE INDEX IF NOT EXISTS idx_import_created
        ON import_outcomes (created_at);
    `);
  }

  async upsertMediaFiles(files: MediaFile[], now: string, sessionId?: string): Promise<number> {
    return this.upsertMediaFilesSync(files, now, sessionId);
  }

  upsertMediaFilesSync(files: MediaFile[], now: string, sessionId?: string): number {
    const select = this.db.prepare('SELECT * FROM media_files WHERE source_path = ?');
    const upsert = this.db.prepare(`
      INSERT INTO media_files (
        source_path, name, normalized_name, size, type, extension, date_taken,
        visual_hash, session_id, first_seen_at, last_seen_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_path) DO UPDATE SET
        name = excluded.name,
        normalized_name = excluded.normalized_name,
        size = excluded.size,
        type = excluded.type,
        extension = excluded.extension,
        date_taken = excluded.date_taken,
        visual_hash = excluded.visual_hash,
        session_id = excluded.session_id,
        last_seen_at = excluded.last_seen_at,
        metadata_json = excluded.metadata_json
    `);

    this.db.exec('BEGIN');
    try {
      for (const file of files) {
        const previousRow = select.get(file.path) as Record<string, unknown> | undefined;
        const previous = previousRow ? mediaRecordFromSql(previousRow) : undefined;
        const record = mediaRecordFromFile(file, now, sessionId, previous);
        upsert.run(
          record.sourcePath,
          record.name,
          record.normalizedName,
          record.size,
          record.type,
          record.extension,
          record.dateTaken ?? null,
          record.visualHash ?? null,
          record.sessionId ?? null,
          record.firstSeenAt,
          record.lastSeenAt,
          JSON.stringify(record.metadata),
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return files.length;
  }

  async recordImportLedgerItems(
    ledgerId: string,
    items: ImportLedgerItem[],
    createdAt: string,
    sessionId?: string,
  ): Promise<number> {
    return this.recordImportLedgerItemsSync(ledgerId, items, createdAt, sessionId);
  }

  recordImportLedgerItemsSync(
    ledgerId: string,
    items: ImportLedgerItem[],
    createdAt: string,
    sessionId?: string,
  ): number {
    const insert = this.db.prepare(`
      INSERT INTO import_outcomes (
        ledger_id, session_id, source_path, name, normalized_name, size,
        dest_rel_path, dest_full_path, backup_full_path, status, error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.db.exec('BEGIN');
    try {
      for (const item of items) {
        const record = importRecordFromItem(ledgerId, item, 0, createdAt, sessionId);
        insert.run(
          record.ledgerId,
          record.sessionId ?? null,
          record.sourcePath,
          record.name,
          record.normalizedName,
          record.size,
          record.destRelPath ?? null,
          record.destFullPath ?? null,
          record.backupFullPath ?? null,
          record.status,
          record.error ?? null,
          record.createdAt,
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return items.length;
  }

  async findDuplicateCandidates(files: MediaFile[], options: DuplicateLookupOptions): Promise<CatalogDuplicateCandidate[]> {
    return this.findDuplicateCandidatesSync(files, options);
  }

  findDuplicateCandidatesSync(files: MediaFile[], options: DuplicateLookupOptions): CatalogDuplicateCandidate[] {
    const findMedia = this.db.prepare(`
      SELECT * FROM media_files
      WHERE normalized_name = ? AND size = ?
    `);
    const findImports = this.db.prepare(`
      SELECT * FROM import_outcomes
      WHERE normalized_name = ? AND size = ?
    `);

    const candidates: CatalogDuplicateCandidate[] = [];
    for (const file of files) {
      const normalizedName = normalizeName(file.name);
      const mediaMatches = findMedia
        .all(normalizedName, file.size)
        .map((row) => mediaRecordFromSql(row as Record<string, unknown>))
        .filter((record) => acceptsMatch(file, record, options));
      const importMatches = findImports
        .all(normalizedName, file.size)
        .map((row) => importRecordFromSql(row as Record<string, unknown>))
        .filter((record) => acceptsMatch(file, record, options));
      const candidate = buildDuplicateCandidate(file, mediaMatches, importMatches);
      if (candidate) candidates.push(candidate);
    }
    return candidates;
  }

  async getStats(storageKind: CatalogStorageKind): Promise<CatalogStats> {
    const mediaStats = this.db.prepare(`
      SELECT
        COUNT(*) AS total_files,
        COALESCE(SUM(size), 0) AS total_bytes,
        MAX(last_seen_at) AS last_seen_at
      FROM media_files
    `).get() as Record<string, unknown>;
    const importedStats = this.db.prepare(`
      SELECT
        COUNT(*) AS import_outcomes,
        COUNT(DISTINCT CASE WHEN status IN ('imported', 'verified') THEN source_path END) AS imported_files,
        MAX(CASE WHEN status IN ('imported', 'verified') THEN created_at END) AS last_imported_at
      FROM import_outcomes
    `).get() as Record<string, unknown>;
    const duplicateStats = this.db.prepare(`
      SELECT COUNT(*) AS duplicate_identities FROM (
        SELECT normalized_name, size, COALESCE(visual_hash, '') AS visual_hash, COUNT(*) AS count
        FROM media_files
        GROUP BY normalized_name, size, COALESCE(visual_hash, '')
        HAVING COUNT(*) > 1
      )
    `).get() as Record<string, unknown>;

    return {
      storageKind,
      catalogPath: this.catalogPath,
      totalFiles: sqliteNumber(mediaStats.total_files),
      totalBytes: sqliteNumber(mediaStats.total_bytes),
      importedFiles: sqliteNumber(importedStats.imported_files),
      duplicateIdentities: sqliteNumber(duplicateStats.duplicate_identities),
      importOutcomes: sqliteNumber(importedStats.import_outcomes),
      lastSeenAt: sqliteString(mediaStats.last_seen_at),
      lastImportedAt: sqliteString(importedStats.last_imported_at),
    };
  }

  async browse(query: CatalogBrowserQuery): Promise<CatalogBrowserResult> {
    return browseCatalogRecords(this.getAllMediaRecords(), this.getAllImportRecords(), query);
  }

  async verifyMissingPaths(): Promise<CatalogMaintenanceResult> {
    return verifyCatalogPaths(this.getAllMediaRecords(), this.getAllImportRecords());
  }

  async pruneMissingEntries(): Promise<CatalogPruneResult> {
    const verification = await this.verifyMissingPaths();
    const missingSources = new Set(
      verification.missingPaths
        .filter((item) => item.kind === 'source')
        .map((item) => item.sourcePath),
    );
    const deleteMedia = this.db.prepare('DELETE FROM media_files WHERE source_path = ?');
    let removedMediaFiles = 0;
    this.db.exec('BEGIN');
    try {
      for (const sourcePath of missingSources) {
        removedMediaFiles += deleteMedia.run(sourcePath).changes;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    const deleteImport = this.db.prepare('DELETE FROM import_outcomes WHERE id = ?');
    let removedImportOutcomes = 0;
    const imports = this.getAllImportRecords();
    this.db.exec('BEGIN');
    try {
      for (const record of imports) {
        if (await shouldPruneImportRecord(record)) {
          removedImportOutcomes += deleteImport.run(record.id).changes;
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return {
      ...verification,
      removedMediaFiles,
      removedImportOutcomes,
    };
  }

  async exportBackup(outputPath: string, storageKind: CatalogStorageKind): Promise<CatalogBackupResult> {
    await mkdir(path.dirname(outputPath), { recursive: true });
    const mediaRecords = this.getAllMediaRecords();
    const importRecords = this.getAllImportRecords();
    const content = serializeCatalogBackup(storageKind, this.catalogPath, mediaRecords, importRecords);
    await writeFile(outputPath, content, 'utf8');
    return {
      path: outputPath,
      bytes: Buffer.byteLength(content, 'utf8'),
      mediaFiles: mediaRecords.length,
      importOutcomes: importRecords.length,
    };
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private getAllMediaRecords(): CatalogMediaRecord[] {
    return this.db.prepare('SELECT * FROM media_files')
      .all()
      .map((row) => mediaRecordFromSql(row as Record<string, unknown>));
  }

  private getAllImportRecords(): CatalogImportOutcomeRecord[] {
    return this.db.prepare('SELECT * FROM import_outcomes')
      .all()
      .map((row) => importRecordFromSql(row as Record<string, unknown>));
  }
}

type CatalogStore = JsonCatalogStore | SqliteCatalogStore;

function memoryMatchFromCandidate(candidate: CatalogDuplicateCandidate): CatalogDuplicateMemoryMatch | null {
  const matchedPath = candidate.matchedPaths[0];
  if (!matchedPath) return null;
  if (candidate.importedCount > 0) {
    return {
      path: candidate.sourcePath,
      kind: 'previous-import',
      matchedPath,
      importedAt: candidate.lastImportedAt,
    };
  }
  return {
    path: candidate.sourcePath,
    kind: candidate.reason === 'visual-hash' ? 'same-visual' : 'previous-import',
    matchedPath,
    importedAt: candidate.lastImportedAt,
  };
}

export class CatalogService {
  private constructor(
    private readonly store: CatalogStore,
    public readonly storageKind: CatalogStorageKind,
    public readonly catalogPath: string,
    private readonly now: () => string,
  ) {}

  static async open(userDataPath: string, options: CatalogOpenOptions = {}): Promise<CatalogService> {
    await mkdir(userDataPath, { recursive: true });
    const sqlite = options.preferJson ? null : loadSqliteModule();
    const now = options.now ?? (() => new Date().toISOString());
    if (sqlite) {
      const sqlitePath = path.join(userDataPath, CATALOG_SQLITE_NAME);
      try {
        const sqliteStore = new SqliteCatalogStore(sqlite, sqlitePath);
        await sqliteStore.open();
        return new CatalogService(sqliteStore, 'sqlite', sqlitePath, now);
      } catch {
        // Some test and recovery environments expose node:sqlite but provide a
        // userData path SQLite cannot open. Keep catalog memory available.
      }
    }

    const jsonPath = path.join(userDataPath, CATALOG_JSON_NAME);
    const jsonStore = new JsonCatalogStore(jsonPath);
    await jsonStore.open();
    return new CatalogService(jsonStore, 'json', jsonPath, now);
  }

  async upsertMediaFiles(files: MediaFile[], sessionId?: string): Promise<CatalogUpsertResult> {
    const duplicateCandidates = await this.findDuplicateCandidates(files, { currentSessionId: sessionId });
    const upserted = await this.store.upsertMediaFiles(files, this.now(), sessionId);
    return { upserted, duplicateCandidates };
  }

  upsertScannedFiles(sourcePath: string, files: MediaFile[]): CatalogUpsertResult {
    const duplicateCandidates = this.findDuplicateCandidatesSync(files, { currentSessionId: sourcePath });
    const upserted = this.store.upsertMediaFilesSync(files, this.now(), sourcePath);
    return { upserted, duplicateCandidates };
  }

  async recordImportLedgerItems(
    ledgerId: string,
    items: ImportLedgerItem[],
    options: CatalogRecordImportOptions = {},
  ): Promise<CatalogRecordImportResult> {
    const recorded = await this.store.recordImportLedgerItems(
      ledgerId,
      items,
      options.importedAt ?? this.now(),
      options.sessionId,
    );
    return { recorded };
  }

  recordImportResult(config: ImportConfig, result: ImportResult): CatalogRecordImportResult {
    const items = result.ledgerItems ?? [];
    if (items.length === 0) return { recorded: 0 };
    const recorded = this.store.recordImportLedgerItemsSync(
      result.ledgerId ?? `import-${Date.now().toString(36)}`,
      items,
      this.now(),
      config.sourcePath,
    );
    return { recorded };
  }

  async findDuplicateCandidates(
    files: MediaFile[],
    options: DuplicateLookupOptions = {},
  ): Promise<CatalogDuplicateCandidate[]> {
    return this.store.findDuplicateCandidates(files, options);
  }

  findDuplicateCandidatesSync(
    files: MediaFile[],
    options: DuplicateLookupOptions = {},
  ): CatalogDuplicateCandidate[] {
    return this.store.findDuplicateCandidatesSync(files, options);
  }

  findDuplicateMemory(files: MediaFile[]): CatalogDuplicateMemoryMatch[] {
    return this.findDuplicateCandidatesSync(files)
      .map(memoryMatchFromCandidate)
      .filter((match): match is CatalogDuplicateMemoryMatch => match !== null);
  }

  async markDuplicateCandidates<T extends MediaFile>(
    files: T[],
    options: DuplicateLookupOptions = {},
  ): Promise<Array<T & { catalogDuplicate?: CatalogDuplicateCandidate }>> {
    const candidates = await this.findDuplicateCandidates(files, options);
    const byPath = new Map(candidates.map((candidate) => [candidate.sourcePath, candidate]));
    return files.map((file) => {
      const catalogDuplicate = byPath.get(file.path);
      return catalogDuplicate
        ? { ...file, duplicate: true, catalogDuplicate }
        : { ...file };
    });
  }

  async getStats(): Promise<CatalogStats> {
    return this.store.getStats(this.storageKind);
  }

  async browse(query: CatalogBrowserQuery = {}): Promise<CatalogBrowserResult> {
    return this.store.browse(query);
  }

  async verifyMissingPaths(): Promise<CatalogMaintenanceResult> {
    return this.store.verifyMissingPaths();
  }

  async pruneMissingEntries(): Promise<CatalogPruneResult> {
    return this.store.pruneMissingEntries();
  }

  async exportBackup(outputPath: string): Promise<CatalogBackupResult> {
    return this.store.exportBackup(outputPath, this.storageKind);
  }

  async close(): Promise<void> {
    await this.store.close();
  }
}

export async function openCatalog(userDataPath: string, options: CatalogOpenOptions = {}): Promise<CatalogService> {
  return CatalogService.open(userDataPath, options);
}

let catalogSingleton: { userDataPath: string; catalog: CatalogService } | null = null;

export async function getCatalog(userDataPath: string): Promise<CatalogService> {
  if (catalogSingleton?.userDataPath === userDataPath) return catalogSingleton.catalog;
  const catalog = await openCatalog(userDataPath);
  catalogSingleton = { userDataPath, catalog };
  return catalog;
}
