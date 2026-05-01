import path from 'node:path';

import type { ImportLedger, ImportLedgerItem, MediaFile } from '../../shared/types';

export type DuplicateMemoryDecision = 'imported' | 'rejected';

export type DuplicateMemoryMatchKind =
  | 'content-hash'
  | 'visual-hash-size'
  | 'name-size-date'
  | 'path-size';

export interface DuplicateMemoryRecord {
  id?: string;
  decision: DuplicateMemoryDecision;
  sourcePath?: string;
  destPath?: string;
  name?: string;
  size?: number;
  dateTaken?: string;
  contentHash?: string;
  sha256?: string;
  fileHash?: string;
  checksum?: string;
  visualHash?: string;
  recordedAt?: string;
  ledgerId?: string;
}

export interface DuplicateMemoryAnnotation {
  filePath: string;
  decision: DuplicateMemoryDecision;
  duplicate: boolean;
  reason: string;
  matchKind: DuplicateMemoryMatchKind;
  confidence: number;
  record: DuplicateMemoryRecord;
}

export interface DuplicateMemoryCatalogAdapter {
  findDuplicateMemoryCandidates(files: MediaFile[]): Promise<DuplicateMemoryRecord[]>;
}

export interface DuplicateMemoryOptions {
  preferRejected?: boolean;
}

type IndexedRecord = DuplicateMemoryRecord & {
  contentKeys: string[];
  visualHashKey?: string;
  nameSizeDateKey?: string;
  pathSizeKeys: string[];
};

const CONTENT_HASH_FIELDS = ['contentHash', 'sha256', 'fileHash', 'checksum'] as const;

export async function annotateWithDuplicateMemory(
  files: MediaFile[],
  catalog: DuplicateMemoryCatalogAdapter,
  options: DuplicateMemoryOptions = {},
): Promise<DuplicateMemoryAnnotation[]> {
  const records = await catalog.findDuplicateMemoryCandidates(files);
  return findDuplicateMemory(files, records, options);
}

export function findDuplicateMemory(
  files: MediaFile[],
  records: DuplicateMemoryRecord[],
  options: DuplicateMemoryOptions = {},
): DuplicateMemoryAnnotation[] {
  if (files.length === 0 || records.length === 0) return [];

  const index = buildRecordIndex(records);
  return files
    .map((file) => annotateFile(file, index, options))
    .filter((annotation): annotation is DuplicateMemoryAnnotation => annotation !== null);
}

export function applyDuplicateMemoryAnnotations(
  files: MediaFile[],
  annotations: DuplicateMemoryAnnotation[],
): MediaFile[] {
  if (annotations.length === 0) return files;

  const byPath = new Map(annotations.map((annotation) => [annotation.filePath, annotation]));
  return files.map((file) => {
    const annotation = byPath.get(file.path);
    if (!annotation) return file;

    const reviewReasons = appendReason(file.reviewReasons, annotation.reason);
    const patch: Partial<MediaFile> = { reviewReasons };

    if (annotation.decision === 'imported') {
      patch.duplicate = true;
    } else if (file.pick == null) {
      patch.pick = 'rejected';
    }

    return { ...file, ...patch };
  });
}

export function recordsFromImportLedgers(ledgers: ImportLedger[]): DuplicateMemoryRecord[] {
  return ledgers.flatMap((ledger) =>
    ledger.items
      .filter((item) => item.status === 'imported' || item.status === 'verified')
      .map((item) => recordFromLedgerItem(ledger, item)),
  );
}

function recordFromLedgerItem(ledger: ImportLedger, item: ImportLedgerItem): DuplicateMemoryRecord {
  return {
    id: `${ledger.id}:${item.sourcePath}`,
    decision: 'imported',
    sourcePath: item.sourcePath,
    destPath: item.destFullPath,
    name: item.name,
    size: item.size,
    recordedAt: ledger.createdAt,
    ledgerId: ledger.id,
  };
}

function buildRecordIndex(records: DuplicateMemoryRecord[]) {
  const indexed = records.map(indexRecord).filter((record): record is IndexedRecord => record !== null);
  const byContentHash = new Map<string, IndexedRecord[]>();
  const byVisualHashSize = new Map<string, IndexedRecord[]>();
  const byNameSizeDate = new Map<string, IndexedRecord[]>();
  const byPathSize = new Map<string, IndexedRecord[]>();

  for (const record of indexed) {
    for (const key of record.contentKeys) pushIndex(byContentHash, key, record);
    if (record.visualHashKey) pushIndex(byVisualHashSize, record.visualHashKey, record);
    if (record.nameSizeDateKey) pushIndex(byNameSizeDate, record.nameSizeDateKey, record);
    for (const key of record.pathSizeKeys) pushIndex(byPathSize, key, record);
  }

  return { byContentHash, byVisualHashSize, byNameSizeDate, byPathSize };
}

function indexRecord(record: DuplicateMemoryRecord): IndexedRecord | null {
  if (record.decision !== 'imported' && record.decision !== 'rejected') return null;

  const contentKeys = contentHashValues(record).map(normalizeHash);
  const visualHash = normalizeHash(record.visualHash);
  const visualHashKey = visualHash && record.size != null ? `${visualHash}:${record.size}` : undefined;
  const name = normalizeName(record.name ?? path.basename(record.sourcePath ?? record.destPath ?? ''));
  const date = normalizeDate(record.dateTaken);
  const nameSizeDateKey = name && record.size != null && date ? `${name}:${record.size}:${date}` : undefined;
  const pathSizeKeys = [record.sourcePath, record.destPath]
    .map((value) => normalizePath(value))
    .filter((value): value is string => !!value && record.size != null)
    .map((value) => `${value}:${record.size}`);

  if (contentKeys.length === 0 && !visualHashKey && !nameSizeDateKey && pathSizeKeys.length === 0) {
    return null;
  }

  return {
    ...record,
    contentKeys,
    visualHashKey,
    nameSizeDateKey,
    pathSizeKeys,
  };
}

function annotateFile(
  file: MediaFile,
  index: ReturnType<typeof buildRecordIndex>,
  options: DuplicateMemoryOptions,
): DuplicateMemoryAnnotation | null {
  const candidates: DuplicateMemoryAnnotation[] = [];

  for (const hash of contentHashValues(file)) {
    for (const record of index.byContentHash.get(normalizeHash(hash)) ?? []) {
      candidates.push(buildAnnotation(file, record, 'content-hash', 1));
    }
  }

  const visualHash = normalizeHash(file.visualHash);
  if (visualHash) {
    for (const record of index.byVisualHashSize.get(`${visualHash}:${file.size}`) ?? []) {
      candidates.push(buildAnnotation(file, record, 'visual-hash-size', 0.92));
    }
  }

  const name = normalizeName(file.name);
  const date = normalizeDate(file.dateTaken);
  if (name && date) {
    for (const record of index.byNameSizeDate.get(`${name}:${file.size}:${date}`) ?? []) {
      candidates.push(buildAnnotation(file, record, 'name-size-date', 0.8));
    }
  }

  const pathKey = normalizePath(file.path);
  if (pathKey) {
    for (const record of index.byPathSize.get(`${pathKey}:${file.size}`) ?? []) {
      candidates.push(buildAnnotation(file, record, 'path-size', 0.7));
    }
  }

  return bestCandidate(candidates, options);
}

function buildAnnotation(
  file: MediaFile,
  record: DuplicateMemoryRecord,
  matchKind: DuplicateMemoryMatchKind,
  confidence: number,
): DuplicateMemoryAnnotation {
  const reason = record.decision === 'imported'
    ? reasonForImported(matchKind, record)
    : reasonForRejected(matchKind, record);

  return {
    filePath: file.path,
    decision: record.decision,
    duplicate: record.decision === 'imported',
    reason,
    matchKind,
    confidence,
    record,
  };
}

function bestCandidate(
  candidates: DuplicateMemoryAnnotation[],
  options: DuplicateMemoryOptions,
): DuplicateMemoryAnnotation | null {
  if (candidates.length === 0) return null;

  return candidates.sort((a, b) => {
    if (options.preferRejected && a.decision !== b.decision) {
      return a.decision === 'rejected' ? -1 : 1;
    }
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    if (a.decision !== b.decision) return a.decision === 'imported' ? -1 : 1;
    return 0;
  })[0];
}

function reasonForImported(matchKind: DuplicateMemoryMatchKind, record: DuplicateMemoryRecord): string {
  const suffix = record.recordedAt ? ` on ${record.recordedAt.slice(0, 10)}` : '';
  switch (matchKind) {
    case 'content-hash':
      return `Previously imported${suffix} with the same content hash`;
    case 'visual-hash-size':
      return `Previously imported${suffix} with the same visual fingerprint and file size`;
    case 'name-size-date':
      return `Previously imported${suffix} with the same filename, size, and capture date`;
    case 'path-size':
      return `Previously imported${suffix} from the same path and file size`;
  }
}

function reasonForRejected(matchKind: DuplicateMemoryMatchKind, record: DuplicateMemoryRecord): string {
  const suffix = record.recordedAt ? ` on ${record.recordedAt.slice(0, 10)}` : '';
  switch (matchKind) {
    case 'content-hash':
      return `Previously rejected${suffix} with the same content hash`;
    case 'visual-hash-size':
      return `Previously rejected${suffix} with the same visual fingerprint and file size`;
    case 'name-size-date':
      return `Previously rejected${suffix} with the same filename, size, and capture date`;
    case 'path-size':
      return `Previously rejected${suffix} from the same path and file size`;
  }
}

function contentHashValues(value: Partial<MediaFile> | DuplicateMemoryRecord): string[] {
  return CONTENT_HASH_FIELDS
    .map((field) => unknownString((value as Record<string, unknown>)[field]))
    .filter((hash): hash is string => !!hash);
}

function appendReason(existing: string[] | undefined, reason: string): string[] {
  if (!existing || existing.length === 0) return [reason];
  if (existing.includes(reason)) return existing;
  return [...existing, reason];
}

function pushIndex(map: Map<string, IndexedRecord[]>, key: string, record: IndexedRecord): void {
  const records = map.get(key);
  if (records) {
    records.push(record);
  } else {
    map.set(key, [record]);
  }
}

function normalizeHash(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function normalizeName(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function normalizeDate(value: string | undefined): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const isoDate = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoDate) return isoDate[1];
  return trimmed.toLowerCase();
}

function normalizePath(value: string | undefined): string {
  if (!value) return '';
  return value.replace(/\\/g, '/').replace(/\/+/g, '/').trim().toLowerCase();
}

function unknownString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
