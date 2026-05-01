import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ImportLedgerItem, MediaFile } from '../../../shared/types';
import { openCatalog } from '../catalog';

const tempDirs: string[] = [];

async function tempCatalogDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'keptra-catalog-'));
  tempDirs.push(dir);
  return dir;
}

function makeFile(overrides: Partial<MediaFile> = {}): MediaFile {
  return {
    path: '/card-a/DCIM/IMG_0001.JPG',
    name: 'IMG_0001.JPG',
    size: 4_096,
    type: 'photo',
    extension: '.jpg',
    dateTaken: '2026-05-01T10:00:00.000Z',
    cameraMake: 'Canon',
    cameraModel: 'R5',
    visualHash: 'aa00bb11cc22dd33',
    thumbnail: 'data:image/jpeg;base64,huge-preview-data',
    ...overrides,
  };
}

function makeLedgerItem(overrides: Partial<ImportLedgerItem> = {}): ImportLedgerItem {
  return {
    sourcePath: '/card-a/DCIM/IMG_0001.JPG',
    name: 'IMG_0001.JPG',
    size: 4_096,
    destRelPath: '2026-05-01/IMG_0001.JPG',
    destFullPath: '/imports/2026-05-01/IMG_0001.JPG',
    status: 'imported',
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('CatalogService JSON fallback', () => {
  it('opens at the app userData path and upserts scanned media metadata without thumbnails', async () => {
    const userDataPath = await tempCatalogDir();
    const catalog = await openCatalog(userDataPath, {
      preferJson: true,
      now: () => '2026-05-02T00:00:00.000Z',
    });

    const result = await catalog.upsertMediaFiles([makeFile()], 'session-a');
    const stats = await catalog.getStats();

    expect(catalog.storageKind).toBe('json');
    expect(catalog.catalogPath).toBe(path.join(userDataPath, 'keptra-catalog.json'));
    expect(result.upserted).toBe(1);
    expect(result.duplicateCandidates).toEqual([]);
    expect(stats).toEqual(expect.objectContaining({
      storageKind: 'json',
      totalFiles: 1,
      totalBytes: 4_096,
      importedFiles: 0,
      lastSeenAt: '2026-05-02T00:00:00.000Z',
    }));

    const raw = await readFile(catalog.catalogPath, 'utf8');
    expect(raw).toContain('"cameraModel": "R5"');
    expect(raw).not.toContain('huge-preview-data');
    await catalog.close();
  });

  it('records import ledger outcomes and finds cross-session duplicate candidates', async () => {
    const userDataPath = await tempCatalogDir();
    const catalog = await openCatalog(userDataPath, {
      preferJson: true,
      now: () => '2026-05-02T00:00:00.000Z',
    });
    await catalog.upsertMediaFiles([makeFile()], 'session-a');
    await catalog.recordImportLedgerItems('ledger-a', [makeLedgerItem()], {
      sessionId: 'session-a',
      importedAt: '2026-05-02T00:10:00.000Z',
    });

    const candidates = await catalog.findDuplicateCandidates([
      makeFile({ path: '/card-b/DCIM/IMG_0001.JPG' }),
    ], { currentSessionId: 'session-b' });

    expect(candidates).toEqual([
      expect.objectContaining({
        sourcePath: '/card-b/DCIM/IMG_0001.JPG',
        matchedPaths: ['/card-a/DCIM/IMG_0001.JPG'],
        matchedSessionIds: ['session-a'],
        importedCount: 1,
        reason: 'visual-hash',
        lastImportedAt: '2026-05-02T00:10:00.000Z',
      }),
    ]);
    await catalog.close();
  });

  it('falls back to name and size when visual hashes are not available', async () => {
    const userDataPath = await tempCatalogDir();
    const catalog = await openCatalog(userDataPath, { preferJson: true });
    await catalog.upsertMediaFiles([
      makeFile({ path: '/old-card/IMG_0099.CR3', name: 'IMG_0099.CR3', size: 9_999, visualHash: undefined }),
    ], 'old-session');

    const candidates = await catalog.findDuplicateCandidates([
      makeFile({ path: '/new-card/IMG_0099.CR3', name: 'img_0099.cr3', size: 9_999, visualHash: undefined }),
    ], { currentSessionId: 'new-session' });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual(expect.objectContaining({
      reason: 'identity',
      matchCount: 1,
      matchedPaths: ['/old-card/IMG_0099.CR3'],
    }));
    await catalog.close();
  });

  it('ignores same-session matches when marking duplicate candidates', async () => {
    const userDataPath = await tempCatalogDir();
    const catalog = await openCatalog(userDataPath, { preferJson: true });
    await catalog.upsertMediaFiles([
      makeFile({ path: '/same-session/a.jpg', name: 'a.jpg', size: 1 }),
    ], 'session-a');

    const marked = await catalog.markDuplicateCandidates([
      makeFile({ path: '/same-session/copy-of-a.jpg', name: 'a.jpg', size: 1 }),
    ], { currentSessionId: 'session-a' });

    expect(marked[0].duplicate).toBeUndefined();
    expect(marked[0].catalogDuplicate).toBeUndefined();
    await catalog.close();
  });

  it('persists media and import stats across reopen', async () => {
    const userDataPath = await tempCatalogDir();
    const first = await openCatalog(userDataPath, { preferJson: true });
    await first.upsertMediaFiles([makeFile()]);
    await first.recordImportLedgerItems('ledger-a', [makeLedgerItem({ status: 'verified' })]);
    await first.close();

    const second = await openCatalog(userDataPath, { preferJson: true });
    const stats = await second.getStats();

    expect(stats).toEqual(expect.objectContaining({
      totalFiles: 1,
      importedFiles: 1,
      importOutcomes: 1,
    }));
    await second.close();
  });

  it('browses catalog records by camera, lens, hash, destination, and imported state', async () => {
    const userDataPath = await tempCatalogDir();
    const catalog = await openCatalog(userDataPath, { preferJson: true });
    await catalog.upsertMediaFiles([
      makeFile({
        path: '/card-a/DCIM/IMG_0001.JPG',
        cameraMake: 'Canon',
        cameraModel: 'R5',
        lensModel: 'RF 24-70',
        visualHash: 'hash-canon',
      }),
      makeFile({
        path: '/card-b/DCIM/DSC_0002.ARW',
        name: 'DSC_0002.ARW',
        size: 8_192,
        extension: '.arw',
        cameraMake: 'Sony',
        cameraModel: 'A7 IV',
        lensModel: 'GM 35',
        visualHash: 'hash-sony',
      }),
    ], 'session-a');
    await catalog.recordImportLedgerItems('ledger-a', [
      makeLedgerItem({
        sourcePath: '/card-a/DCIM/IMG_0001.JPG',
        destFullPath: '/imports/wedding/IMG_0001.JPG',
      }),
    ]);

    await expect(catalog.browse({ camera: 'canon', imported: 'imported' })).resolves.toEqual(expect.objectContaining({
      total: 1,
      records: [expect.objectContaining({ name: 'IMG_0001.JPG', imported: true, cameraModel: 'R5' })],
    }));
    await expect(catalog.browse({ lens: 'gm 35', imported: 'not-imported' })).resolves.toEqual(expect.objectContaining({
      total: 1,
      records: [expect.objectContaining({ name: 'DSC_0002.ARW', imported: false, lensModel: 'GM 35' })],
    }));
    await expect(catalog.browse({ destinationPath: 'wedding', visualHash: 'hash-canon' })).resolves.toEqual(expect.objectContaining({
      total: 1,
    }));
    await catalog.close();
  });

  it('verifies missing paths, prunes missing entries, and exports a JSON backup', async () => {
    const userDataPath = await tempCatalogDir();
    const sourcePath = path.join(userDataPath, 'source.jpg');
    const destPath = path.join(userDataPath, 'imports', 'source.jpg');
    const backupPath = path.join(userDataPath, 'catalog-backup.json');
    await writeFile(sourcePath, 'source-bytes', 'utf8');
    await mkdir(path.dirname(destPath), { recursive: true });
    await writeFile(destPath, 'dest-bytes', 'utf8');

    const catalog = await openCatalog(userDataPath, { preferJson: true });
    await catalog.upsertMediaFiles([
      makeFile({ path: sourcePath, name: 'source.jpg' }),
      makeFile({ path: path.join(userDataPath, 'missing-source.jpg'), name: 'missing-source.jpg', size: 100 }),
    ]);
    await catalog.recordImportLedgerItems('ledger-a', [
      makeLedgerItem({ sourcePath, name: 'source.jpg', destFullPath: destPath, backupFullPath: path.join(userDataPath, 'missing-backup.jpg') }),
      makeLedgerItem({ sourcePath: path.join(userDataPath, 'missing-import.jpg'), name: 'missing-import.jpg', size: 100, destFullPath: path.join(userDataPath, 'missing-dest.jpg') }),
    ]);

    const verification = await catalog.verifyMissingPaths();
    expect(verification.missingSources).toBeGreaterThanOrEqual(2);
    expect(verification.missingDestinations).toBe(1);
    expect(verification.missingBackups).toBe(1);

    const backup = await catalog.exportBackup(backupPath);
    expect(backup.mediaFiles).toBe(2);
    expect(backup.importOutcomes).toBe(2);
    await expect(readFile(backupPath, 'utf8')).resolves.toContain('"importOutcomes"');

    const prune = await catalog.pruneMissingEntries();
    expect(prune.removedMediaFiles).toBe(1);
    expect(prune.removedImportOutcomes).toBe(1);
    await expect(catalog.browse({ imported: 'any' })).resolves.toEqual(expect.objectContaining({
      total: 1,
      records: [expect.objectContaining({ sourcePath, destFullPath: destPath })],
    }));
    await catalog.close();
  });
});

describe('CatalogService default storage', () => {
  it('opens with sqlite when available and otherwise uses the JSON fallback', async () => {
    const userDataPath = await tempCatalogDir();
    const catalog = await openCatalog(userDataPath);

    await catalog.upsertMediaFiles([makeFile({ path: '/default-store/file.jpg' })]);
    const stats = await catalog.getStats();

    expect(['sqlite', 'json']).toContain(catalog.storageKind);
    expect(stats.totalFiles).toBe(1);
    expect(stats.catalogPath).toBe(catalog.catalogPath);
    await catalog.close();
  });
});
