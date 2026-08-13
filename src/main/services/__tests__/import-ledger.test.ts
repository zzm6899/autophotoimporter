import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ImportConfig, ImportResult } from '../../../shared/types';
import {
  ImportLedgerWriter,
  createImportLedgerIdentity,
  isImportLedger,
  readLatestImportLedger,
} from '../import-ledger';

const tempDirectories: string[] = [];

async function makeTempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'keptra-import-ledger-'));
  tempDirectories.push(directory);
  return directory;
}

function config(): ImportConfig {
  return {
    sourcePath: 'E:\\DCIM',
    destRoot: 'D:\\Photos',
    skipDuplicates: true,
    saveFormat: 'original',
    jpegQuality: 90,
  };
}

function result(status: 'pending' | 'failed' | 'imported' = 'pending'): ImportResult {
  return {
    imported: status === 'imported' ? 1 : 0,
    skipped: 0,
    verified: status === 'imported' ? 1 : 0,
    errors: status === 'failed' ? [{ file: 'IMG_0001.CR3', error: 'Disk full' }] : [],
    totalBytes: status === 'imported' ? 5_000 : 0,
    durationMs: 25,
    ledgerItems: [{
      sourcePath: 'E:\\DCIM\\IMG_0001.CR3',
      name: 'IMG_0001.CR3',
      size: 5_000,
      destRelPath: '2026\\IMG_0001.CR3',
      destFullPath: 'D:\\Photos\\2026\\IMG_0001.CR3',
      status,
      error: status === 'failed' ? 'Disk full' : undefined,
    }],
  };
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('ImportLedgerWriter', () => {
  it('atomically writes a private archive and latest recovery document', async () => {
    const directory = await makeTempDirectory();
    const identity = createImportLedgerIdentity(new Date('2026-08-13T01:02:03.000Z'));
    const writer = new ImportLedgerWriter(directory, config(), identity);
    const importResult = result('failed');

    const ledger = await writer.finalize(importResult);
    const archive = JSON.parse(await readFile(path.join(directory, `${identity.id}.json`), 'utf8'));
    const latest = JSON.parse(await readFile(path.join(directory, 'latest.json'), 'utf8'));
    const names = await readdir(directory);

    expect(archive).toEqual(ledger);
    expect(latest).toEqual(ledger);
    expect(names.some((name) => name.endsWith('.tmp'))).toBe(false);
    expect(importResult.ledgerId).toBe(identity.id);
    expect(importResult.recoveryCount).toBe(1);
  });

  it('serializes concurrent snapshots so an older state cannot win', async () => {
    const directory = await makeTempDirectory();
    const identity = createImportLedgerIdentity(new Date('2026-08-13T01:02:03.000Z'));
    const writer = new ImportLedgerWriter(directory, config(), identity);

    await Promise.all([
      writer.checkpoint(result('pending')),
      writer.checkpoint(result('imported')),
    ]);

    const latest = await readLatestImportLedger(directory);
    expect(latest?.items[0].status).toBe('imported');
    expect(latest?.imported).toBe(1);
    expect(latest?.pending).toBe(0);
  });
});

describe('readLatestImportLedger', () => {
  it('falls back to the durable archive when latest.json is truncated', async () => {
    const directory = await makeTempDirectory();
    const writer = new ImportLedgerWriter(directory, config());
    const expected = await writer.finalize(result('failed'));
    await writeFile(path.join(directory, 'latest.json'), '{"id":', 'utf8');

    await expect(readLatestImportLedger(directory)).resolves.toEqual(expected);
  });

  it('uses a newer archive if the process stopped before replacing latest.json', async () => {
    const directory = await makeTempDirectory();
    const identity = createImportLedgerIdentity(new Date('2026-08-13T01:02:03.000Z'));
    const writer = new ImportLedgerWriter(directory, config(), identity);
    await writer.finalize(result('pending'));
    const staleLatest = await readFile(path.join(directory, 'latest.json'), 'utf8');
    await writer.finalize(result('imported'));

    const latestPath = path.join(directory, 'latest.json');
    await writeFile(latestPath, staleLatest, 'utf8');
    await utimes(latestPath, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));

    const recovered = await readLatestImportLedger(directory);
    expect(recovered?.items[0].status).toBe('imported');
    expect(recovered?.imported).toBe(1);
  });

  it('rejects structurally invalid JSON instead of exposing it as recovery state', () => {
    expect(isImportLedger({ id: 'bad', items: [] })).toBe(false);
    expect(isImportLedger({
      id: 'bad',
      createdAt: new Date().toISOString(),
      sourcePath: '/src',
      destRoot: '/dest',
      saveFormat: 'original',
      totalFiles: 1,
      imported: 0,
      skipped: 0,
      failed: 0,
      pending: 1,
      totalBytes: 0,
      durationMs: 0,
      items: [{ sourcePath: '/src/a.jpg', name: 'a.jpg', size: 1, status: 'unknown' }],
    })).toBe(false);
  });
});
