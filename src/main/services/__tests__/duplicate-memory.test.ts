import { describe, expect, it, vi } from 'vitest';

import type { ImportLedger, MediaFile } from '../../../shared/types';
import {
  annotateWithDuplicateMemory,
  applyDuplicateMemoryAnnotations,
  findDuplicateMemory,
  recordsFromImportLedgers,
  type DuplicateMemoryCatalogAdapter,
  type DuplicateMemoryRecord,
} from '../duplicate-memory';

function file(overrides: Partial<MediaFile> = {}): MediaFile {
  return {
    path: 'E:/DCIM/IMG_0001.JPG',
    name: 'IMG_0001.JPG',
    size: 1000,
    type: 'photo',
    extension: '.jpg',
    ...overrides,
  };
}

describe('duplicate-memory', () => {
  it('annotates a previously imported file by visual hash and size', () => {
    const files = [file({ visualHash: 'ABCDEF0000000001' })];
    const records: DuplicateMemoryRecord[] = [{
      decision: 'imported',
      name: 'IMG_0001.JPG',
      size: 1000,
      visualHash: 'abcdef0000000001',
      destPath: 'D:/Photos/IMG_0001.JPG',
      recordedAt: '2026-05-01T10:00:00.000Z',
    }];

    const [annotation] = findDuplicateMemory(files, records);

    expect(annotation).toMatchObject({
      filePath: 'E:/DCIM/IMG_0001.JPG',
      decision: 'imported',
      duplicate: true,
      matchKind: 'visual-hash-size',
      confidence: 0.92,
    });
    expect(annotation.reason).toContain('Previously imported on 2026-05-01');
  });

  it('annotates a previously rejected file without treating it as an imported duplicate', () => {
    const files = [file({ name: 'IMG_0042.CR3', size: 2200, dateTaken: '2026-04-30T22:14:00.000Z' })];
    const records: DuplicateMemoryRecord[] = [{
      decision: 'rejected',
      name: 'img_0042.cr3',
      size: 2200,
      dateTaken: '2026-04-30',
      recordedAt: '2026-05-01T00:00:00.000Z',
    }];

    const [annotation] = findDuplicateMemory(files, records);

    expect(annotation).toMatchObject({
      decision: 'rejected',
      duplicate: false,
      matchKind: 'name-size-date',
      confidence: 0.8,
    });
    expect(annotation.reason).toContain('Previously rejected');
  });

  it('prefers exact content hash over weaker imported history matches', () => {
    const files = [file({ size: 3000, visualHash: '0000000000000000', fileHash: 'fff' } as Partial<MediaFile>)];
    const records: DuplicateMemoryRecord[] = [
      { decision: 'imported', size: 3000, visualHash: '0000000000000000' },
      { decision: 'rejected', size: 9999, contentHash: 'FFF' },
    ];

    const [annotation] = findDuplicateMemory(files, records);

    expect(annotation).toMatchObject({
      decision: 'rejected',
      matchKind: 'content-hash',
      confidence: 1,
    });
  });

  it('can prefer rejected history when the caller wants culling memory to win ties', () => {
    const files = [file({ contentHash: 'same-hash' } as Partial<MediaFile>)];
    const records: DuplicateMemoryRecord[] = [
      { decision: 'imported', contentHash: 'same-hash', recordedAt: '2026-05-01' },
      { decision: 'rejected', contentHash: 'same-hash', recordedAt: '2026-05-02' },
    ];

    const [annotation] = findDuplicateMemory(files, records, { preferRejected: true });

    expect(annotation.decision).toBe('rejected');
    expect(annotation.reason).toContain('Previously rejected');
  });

  it('applies imported annotations as duplicate flags and rejected annotations as reject picks', () => {
    const imported = file({ path: 'E:/DCIM/imported.jpg', visualHash: '1' });
    const rejected = file({ path: 'E:/DCIM/rejected.jpg', visualHash: '2', reviewReasons: ['soft focus'] });
    const alreadyPicked = file({ path: 'E:/DCIM/picked.jpg', visualHash: '3', pick: 'selected' });
    const annotations = findDuplicateMemory(
      [imported, rejected, alreadyPicked],
      [
        { decision: 'imported', size: imported.size, visualHash: '1' },
        { decision: 'rejected', size: rejected.size, visualHash: '2' },
        { decision: 'rejected', size: alreadyPicked.size, visualHash: '3' },
      ],
    );

    const result = applyDuplicateMemoryAnnotations([imported, rejected, alreadyPicked], annotations);

    const importedResult = result.find((entry) => entry.path === imported.path);
    expect(importedResult).toMatchObject({ duplicate: true });
    expect(importedResult).not.toHaveProperty('pick');
    expect(result.find((entry) => entry.path === rejected.path)).toMatchObject({
      pick: 'rejected',
      reviewReasons: ['soft focus', expect.stringContaining('Previously rejected')],
    });
    expect(result.find((entry) => entry.path === alreadyPicked.path)).toMatchObject({
      pick: 'selected',
      reviewReasons: [expect.stringContaining('Previously rejected')],
    });
  });

  it('builds imported memory records from successful import ledger items only', () => {
    const ledger: ImportLedger = {
      id: 'ledger-1',
      createdAt: '2026-05-01T09:00:00.000Z',
      sourcePath: 'E:/DCIM',
      destRoot: 'D:/Photos',
      saveFormat: 'original',
      totalFiles: 3,
      imported: 1,
      skipped: 1,
      failed: 1,
      pending: 0,
      totalBytes: 300,
      durationMs: 50,
      items: [
        { sourcePath: 'E:/DCIM/imported.jpg', name: 'imported.jpg', size: 100, status: 'imported', destFullPath: 'D:/Photos/imported.jpg' },
        { sourcePath: 'E:/DCIM/verified.jpg', name: 'verified.jpg', size: 200, status: 'verified', destFullPath: 'D:/Photos/verified.jpg' },
        { sourcePath: 'E:/DCIM/skipped.jpg', name: 'skipped.jpg', size: 300, status: 'skipped' },
      ],
    };

    const records = recordsFromImportLedgers([ledger]);

    expect(records).toHaveLength(2);
    expect(records).toEqual([
      expect.objectContaining({ decision: 'imported', sourcePath: 'E:/DCIM/imported.jpg', ledgerId: 'ledger-1' }),
      expect.objectContaining({ decision: 'imported', sourcePath: 'E:/DCIM/verified.jpg', ledgerId: 'ledger-1' }),
    ]);
  });

  it('supports a small async catalog adapter boundary for later SQLite integration', async () => {
    const files = [file({ visualHash: 'abc' })];
    const adapter: DuplicateMemoryCatalogAdapter = {
      findDuplicateMemoryCandidates: vi.fn(async (): Promise<DuplicateMemoryRecord[]> => [
        { decision: 'imported', size: 1000, visualHash: 'abc' },
      ]),
    };

    const annotations = await annotateWithDuplicateMemory(files, adapter);

    expect(adapter.findDuplicateMemoryCandidates).toHaveBeenCalledWith(files);
    expect(annotations).toHaveLength(1);
    expect(annotations[0].decision).toBe('imported');
  });
});
