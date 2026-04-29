import { describe, expect, it } from 'vitest';
import { summarizeImportLedger } from '../ImportResumeView';
import type { ImportLedger } from '../../../shared/types';

const baseLedger: ImportLedger = {
  id: '2026-04-30T01-00-00',
  createdAt: '2026-04-30T01:00:00.000Z',
  sourcePath: 'E:\\DCIM',
  destRoot: 'D:\\Photos',
  saveFormat: 'original',
  totalFiles: 4,
  imported: 1,
  skipped: 1,
  failed: 1,
  pending: 1,
  verified: 0,
  totalBytes: 300,
  durationMs: 1200,
  items: [
    { sourcePath: 'E:\\DCIM\\ok.jpg', name: 'ok.jpg', size: 100, status: 'imported' },
    { sourcePath: 'E:\\DCIM\\skip.jpg', name: 'skip.jpg', size: 50, status: 'skipped' },
    { sourcePath: 'E:\\DCIM\\later.jpg', name: 'later.jpg', size: 75, status: 'pending' },
    { sourcePath: 'E:\\DCIM\\bad.jpg', name: 'bad.jpg', size: 75, status: 'failed', error: 'Disk full' },
  ],
};

describe('summarizeImportLedger', () => {
  it('counts failed and pending items as actionable', () => {
    expect(summarizeImportLedger(baseLedger).actionableCount).toBe(2);
  });

  it('orders failed and pending files first for recovery', () => {
    const names = summarizeImportLedger(baseLedger).orderedItems.map((item) => item.name);
    expect(names.slice(0, 2)).toEqual(['bad.jpg', 'later.jpg']);
  });

  it('explains pending files as retryable recovery work', () => {
    const summary = summarizeImportLedger(baseLedger);

    expect(summary.failedCount).toBe(1);
    expect(summary.pendingCount).toBe(1);
    expect(summary.statusMessage).toBe('2 of 4 files are accounted for.');
    expect(summary.recoveryMessage).toBe('Retry resumes pending files and re-attempts failed copies from this ledger.');
  });

  it('reports a clean ledger without recovery work', () => {
    const cleanLedger: ImportLedger = {
      ...baseLedger,
      totalFiles: 2,
      imported: 2,
      skipped: 0,
      failed: 0,
      pending: 0,
      verified: 2,
      items: [
        { sourcePath: 'E:\\DCIM\\ok-1.jpg', name: 'ok-1.jpg', size: 100, status: 'verified' },
        { sourcePath: 'E:\\DCIM\\ok-2.jpg', name: 'ok-2.jpg', size: 100, status: 'verified' },
      ],
    };

    const summary = summarizeImportLedger(cleanLedger);

    expect(summary.actionableCount).toBe(0);
    expect(summary.completionPercent).toBe(100);
    expect(summary.recoveryMessage).toBe('No failed or pending files need attention.');
  });
});
