import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import type { ImportLedger, MediaFile } from '../../../shared/types';
import { writeLightroomHandoff } from '../lightroom-handoff';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'keptra-lightroom-handoff-'));
  tempDirs.push(dir);
  return dir;
}

function file(overrides: Partial<MediaFile> = {}): MediaFile {
  const name = overrides.name ?? 'IMG_0001.CR3';
  return {
    path: path.join('E:', 'DCIM', 'IMG_0001.CR3'),
    name,
    size: 1000,
    type: 'photo',
    extension: '.cr3',
    destPath: path.join('2026-05-02', name),
    ...overrides,
  };
}

function ledger(files: MediaFile[]): ImportLedger {
  return {
    id: 'ledger-1',
    createdAt: '2026-05-02T00:00:00.000Z',
    sourcePath: path.join('E:', 'DCIM'),
    destRoot: path.join('D:', 'Photos'),
    saveFormat: 'original',
    totalFiles: files.length,
    imported: files.length,
    skipped: 0,
    failed: 0,
    pending: 0,
    totalBytes: files.reduce((sum, entry) => sum + entry.size, 0),
    durationMs: 100,
    items: files.map((entry) => ({
      sourcePath: entry.path,
      name: entry.name,
      size: entry.size,
      destRelPath: entry.destPath,
      destFullPath: path.join('D:', 'Photos', entry.destPath ?? entry.name),
      status: 'imported',
    })),
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('writeLightroomHandoff', () => {
  it('writes collection helper artifacts for all Lightroom handoff buckets', async () => {
    const outputRoot = await tempDir();
    const files = [
      file({ path: path.join('E:', 'DCIM', 'selected.CR3'), name: 'selected.CR3', pick: 'selected', rating: 5 }),
      file({ path: path.join('E:', 'DCIM', 'rejected.CR3'), name: 'rejected.CR3', pick: 'rejected' }),
      file({ path: path.join('E:', 'DCIM', 'protected.CR3'), name: 'protected.CR3', isProtected: true }),
      file({ path: path.join('E:', 'DCIM', 'approved.CR3'), name: 'approved.CR3', reviewApproved: true, pick: 'selected' }),
      file({
        path: path.join('E:', 'DCIM', 'catalog-match.CR3'),
        name: 'catalog-match.CR3',
        duplicate: true,
        duplicateMemory: {
          kind: 'previous-import',
          matchedPath: path.join('D:', 'Photos', 'old.CR3'),
          importedAt: '2026-05-01T10:00:00.000Z',
        },
      }),
    ];

    const result = await writeLightroomHandoff(files, {
      ledger: ledger(files),
      outputRoot,
      source: 'post-import',
    });

    expect(result.totalFiles).toBe(5);
    expect(result.collections.map((collection) => [collection.key, collection.count])).toEqual([
      ['selected', 2],
      ['rejected', 1],
      ['protected', 1],
      ['second-pass-approved', 1],
      ['catalog-duplicate', 1],
    ]);
    await expect(stat(result.manifestPath)).resolves.toBeTruthy();
    await expect(stat(result.csvPath)).resolves.toBeTruthy();
    await expect(stat(result.readmePath)).resolves.toBeTruthy();

    const selected = result.collections.find((collection) => collection.key === 'selected')!;
    const selectedPaths = await readFile(selected.pathListPath, 'utf8');
    expect(selectedPaths).toContain(path.join('D:', 'Photos', '2026-05-02', 'selected.CR3'));

    const catalog = result.collections.find((collection) => collection.key === 'catalog-duplicate')!;
    const catalogCsv = await readFile(catalog.csvPath, 'utf8');
    expect(catalogCsv).toContain('Keptra Catalog Duplicate');
    expect(catalogCsv).toContain('old.CR3');

    const sidecar = path.join(selected.xmpSidecarDir, '0001-selected.xmp');
    const sidecarXml = await readFile(sidecar, 'utf8');
    expect(sidecarXml).toContain('Keptra Collection: Selected');
    expect(sidecarXml).toContain('<xmp:Rating>5</xmp:Rating>');
  });

  it('writes empty per-collection files so the manifest shape is stable', async () => {
    const outputRoot = await tempDir();

    const result = await writeLightroomHandoff([], {
      outputRoot,
      source: 'current-session',
    });

    expect(result.totalFiles).toBe(0);
    expect(result.totalMemberships).toBe(0);
    expect(result.collections).toHaveLength(5);
    const rejected = result.collections.find((collection) => collection.key === 'rejected')!;
    await expect(readFile(rejected.pathListPath, 'utf8')).resolves.toBe('');
    await expect(readFile(rejected.csvPath, 'utf8')).resolves.toContain('collection,collectionLabel');
  });
});
