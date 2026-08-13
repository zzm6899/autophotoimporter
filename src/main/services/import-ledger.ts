import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ImportConfig, ImportLedger, ImportLedgerItem, ImportResult } from '../../shared/types';

const LEDGER_STATUSES = new Set<ImportLedgerItem['status']>([
  'planned',
  'imported',
  'skipped',
  'failed',
  'verified',
  'pending',
]);

export interface ImportLedgerIdentity {
  id: string;
  createdAt: string;
}

interface LedgerCandidate {
  ledger: ImportLedger;
  mtimeMs: number;
}

interface LedgerJournalEntry {
  version: 1;
  ledgerId: string;
  updatedAt: string;
  imported: number;
  skipped: number;
  verified?: number;
  checksumVerified?: number;
  totalBytes: number;
  durationMs: number;
  importLogCsvPath?: string;
  items: ImportLedgerItem[];
}

function cloneResult(result: ImportResult): ImportResult {
  return {
    ...result,
    errors: result.errors.map((error) => ({ ...error })),
    ledgerItems: result.ledgerItems?.map((item) => ({ ...item })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isLedgerItem(value: unknown): value is ImportLedgerItem {
  if (!isRecord(value)) return false;
  return typeof value.sourcePath === 'string'
    && typeof value.name === 'string'
    && isFiniteNumber(value.size)
    && typeof value.status === 'string'
    && LEDGER_STATUSES.has(value.status as ImportLedgerItem['status']);
}

export function isImportLedger(value: unknown): value is ImportLedger {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && value.id.length > 0
    && typeof value.createdAt === 'string'
    && typeof value.sourcePath === 'string'
    && typeof value.destRoot === 'string'
    && ['original', 'jpeg', 'tiff', 'heic'].includes(String(value.saveFormat))
    && isFiniteNumber(value.totalFiles)
    && isFiniteNumber(value.imported)
    && isFiniteNumber(value.skipped)
    && isFiniteNumber(value.failed)
    && isFiniteNumber(value.pending)
    && isFiniteNumber(value.totalBytes)
    && isFiniteNumber(value.durationMs)
    && Array.isArray(value.items)
    && value.items.every(isLedgerItem);
}

function isLedgerJournalEntry(value: unknown): value is LedgerJournalEntry {
  if (!isRecord(value)) return false;
  return value.version === 1
    && typeof value.ledgerId === 'string'
    && typeof value.updatedAt === 'string'
    && isFiniteNumber(value.imported)
    && isFiniteNumber(value.skipped)
    && isFiniteNumber(value.totalBytes)
    && isFiniteNumber(value.durationMs)
    && Array.isArray(value.items)
    && value.items.every(isLedgerItem);
}

export function createImportLedgerIdentity(now = new Date()): ImportLedgerIdentity {
  return {
    id: `${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`,
    createdAt: now.toISOString(),
  };
}

export function buildImportLedger(
  config: ImportConfig,
  result: ImportResult,
  identity: ImportLedgerIdentity,
): ImportLedger {
  const items = result.ledgerItems?.map((item) => ({ ...item })) ?? [];
  return {
    id: identity.id,
    createdAt: identity.createdAt,
    sourcePath: config.sourcePath,
    destRoot: config.destRoot,
    saveFormat: config.saveFormat,
    totalFiles: items.length,
    imported: result.imported,
    skipped: result.skipped,
    failed: items.filter((item) => item.status === 'failed').length,
    pending: items.filter((item) => item.status === 'pending').length,
    verified: result.verified,
    checksumVerified: result.checksumVerified,
    totalBytes: result.totalBytes,
    durationMs: result.durationMs,
    eventMode: config.eventMode,
    importLogCsvPath: result.importLogCsvPath,
    scheduleCsvPath: config.scheduleCsvPath,
    scheduleSheetUrl: config.scheduleSheetUrl,
    items,
  };
}

async function atomicWriteText(targetPath: string, content: string): Promise<void> {
  const directory = path.dirname(targetPath);
  const tempPath = path.join(directory, `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });
  try {
    // flush asks Node to fsync the temporary file before the atomic rename. A
    // crash can therefore leave either the previous complete JSON document or
    // this complete document, never a partially overwritten latest.json.
    await writeFile(tempPath, content, {
      encoding: 'utf8',
      mode: 0o600,
      flush: true,
    });
    await rename(tempPath, targetPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function appendJournalEntry(journalPath: string, entry: LedgerJournalEntry): Promise<void> {
  await mkdir(path.dirname(journalPath), { recursive: true });
  const handle = await open(journalPath, 'a', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(entry)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function persistImportLedger(
  ledgersDir: string,
  config: ImportConfig,
  result: ImportResult,
  identity: ImportLedgerIdentity = createImportLedgerIdentity(),
): Promise<ImportLedger> {
  const ledger = buildImportLedger(config, result, identity);
  const content = JSON.stringify(ledger, null, 2);
  await mkdir(ledgersDir, { recursive: true });

  // Commit the durable, uniquely named record first. If the process exits
  // before latest.json is replaced, readLatestImportLedger can recover this
  // newer archive by its modification time.
  await atomicWriteText(path.join(ledgersDir, `${identity.id}.json`), content);
  await atomicWriteText(path.join(ledgersDir, 'latest.json'), content);

  result.ledgerId = identity.id;
  result.recoveryCount = ledger.failed + ledger.pending;
  return ledger;
}

async function readLedgerCandidate(filePath: string): Promise<LedgerCandidate | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (!isImportLedger(parsed)) return null;
    const info = await stat(filePath).catch(() => null);
    return { ledger: parsed, mtimeMs: info?.mtimeMs ?? 0 };
  } catch {
    return null;
  }
}

async function readNewestArchivedLedger(ledgersDir: string): Promise<LedgerCandidate | null> {
  let names: string[];
  try {
    const entries = await readdir(ledgersDir, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'latest.json')
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return null;
  }

  // Generated ledger IDs begin with an ISO timestamp, so the first valid
  // archive is normally the newest without a stat call for every historic run.
  for (const name of names) {
    const candidate = await readLedgerCandidate(path.join(ledgersDir, name));
    if (candidate) return candidate;
  }
  return null;
}

async function applyNewerJournal(ledgersDir: string, candidate: LedgerCandidate): Promise<ImportLedger> {
  const journalPath = path.join(ledgersDir, `${candidate.ledger.id}.journal.jsonl`);
  try {
    const info = await stat(journalPath);
    // A completed compact ledger is written after its journal. If cleanup was
    // interrupted, ignore that older journal instead of replaying stale counts.
    if (info.mtimeMs <= candidate.mtimeMs) return candidate.ledger;
    const content = await readFile(journalPath, 'utf8');
    const itemsBySource = new Map(candidate.ledger.items.map((item) => [item.sourcePath, { ...item }]));
    let ledger = { ...candidate.ledger, items: [...itemsBySource.values()] };

    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A hard stop can truncate only the final append. Earlier fsynced lines
        // remain valid and are still useful recovery evidence.
        continue;
      }
      if (!isLedgerJournalEntry(parsed) || parsed.ledgerId !== ledger.id) continue;
      for (const item of parsed.items) itemsBySource.set(item.sourcePath, { ...item });
      const items = [...itemsBySource.values()];
      ledger = {
        ...ledger,
        imported: parsed.imported,
        skipped: parsed.skipped,
        verified: parsed.verified,
        checksumVerified: parsed.checksumVerified,
        totalBytes: parsed.totalBytes,
        durationMs: parsed.durationMs,
        importLogCsvPath: parsed.importLogCsvPath ?? ledger.importLogCsvPath,
        totalFiles: items.length,
        failed: items.filter((item) => item.status === 'failed').length,
        pending: items.filter((item) => item.status === 'pending').length,
        items,
      };
    }
    return ledger;
  } catch {
    return candidate.ledger;
  }
}

export async function readLatestImportLedger(ledgersDir: string): Promise<ImportLedger | null> {
  const [latest, archived] = await Promise.all([
    readLedgerCandidate(path.join(ledgersDir, 'latest.json')),
    readNewestArchivedLedger(ledgersDir),
  ]);
  const selected = !latest
    ? archived
    : !archived
      ? latest
      : archived.mtimeMs > latest.mtimeMs
        ? archived
        : latest;
  return selected ? applyNewerJournal(ledgersDir, selected) : null;
}

/**
 * Serializes snapshots from concurrent import workers so an older checkpoint
 * can never replace a newer one. Each queued snapshot is cloned immediately;
 * subsequent counter or item mutations cannot change what reaches disk.
 */
export class ImportLedgerWriter {
  readonly identity: ImportLedgerIdentity;
  private tail: Promise<void> = Promise.resolve();
  private initialized = false;
  private lastItemsBySource = new Map<string, ImportLedgerItem>();

  constructor(
    private readonly ledgersDir: string,
    private readonly config: ImportConfig,
    identity: ImportLedgerIdentity = createImportLedgerIdentity(),
  ) {
    this.identity = identity;
  }

  private journalPath(): string {
    return path.join(this.ledgersDir, `${this.identity.id}.journal.jsonl`);
  }

  private enqueue(
    result: ImportResult,
    operationForSnapshot: (snapshot: ImportResult) => Promise<ImportLedger>,
  ): Promise<ImportLedger> {
    const snapshot = cloneResult(result);
    const operation = this.tail.then(() => operationForSnapshot(snapshot));
    this.tail = operation.then(() => undefined, () => undefined);
    return operation.then((ledger) => {
      result.ledgerId = ledger.id;
      result.recoveryCount = ledger.failed + ledger.pending;
      return ledger;
    });
  }

  checkpoint(result: ImportResult): Promise<ImportLedger> {
    return this.enqueue(result, async (snapshot) => {
      const ledger = buildImportLedger(this.config, snapshot, this.identity);
      if (!this.initialized) {
        const persisted = await persistImportLedger(
          this.ledgersDir,
          this.config,
          snapshot,
          this.identity,
        );
        this.lastItemsBySource = new Map(persisted.items.map((item) => [item.sourcePath, { ...item }]));
        this.initialized = true;
        return persisted;
      }

      const changedItems = ledger.items.filter((item) => {
        const previous = this.lastItemsBySource.get(item.sourcePath);
        return !previous || JSON.stringify(previous) !== JSON.stringify(item);
      });
      const entry: LedgerJournalEntry = {
        version: 1,
        ledgerId: ledger.id,
        updatedAt: new Date().toISOString(),
        imported: ledger.imported,
        skipped: ledger.skipped,
        verified: ledger.verified,
        checksumVerified: ledger.checksumVerified,
        totalBytes: ledger.totalBytes,
        durationMs: ledger.durationMs,
        importLogCsvPath: ledger.importLogCsvPath,
        items: changedItems,
      };
      await appendJournalEntry(this.journalPath(), entry);
      for (const item of changedItems) this.lastItemsBySource.set(item.sourcePath, { ...item });
      return ledger;
    });
  }

  finalize(result: ImportResult): Promise<ImportLedger> {
    return this.enqueue(result, async (snapshot) => {
      const ledger = await persistImportLedger(
        this.ledgersDir,
        this.config,
        snapshot,
        this.identity,
      );
      // The journal is now redundant. If removal fails, readers ignore it
      // because the compact archive/latest files have a newer modification time.
      try {
        await rm(this.journalPath(), { force: true });
      } catch {
        // Best-effort cleanup only; the compact ledger is already durable.
      }
      this.lastItemsBySource = new Map(ledger.items.map((item) => [item.sourcePath, { ...item }]));
      this.initialized = true;
      return ledger;
    });
  }
}
