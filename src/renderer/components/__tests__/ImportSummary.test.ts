import { describe, expect, it } from 'vitest';
import { summarizeImportResult, summarizeReviewImportVisibility, summarizeSkippedImportReasons } from '../ImportSummary';
import type { ImportResult, MediaFile } from '../../../shared/types';

const baseResult: ImportResult = {
  imported: 3,
  skipped: 1,
  verified: 3,
  checksumVerified: 2,
  errors: [],
  totalBytes: 1200,
  durationMs: 2400,
};

describe('summarizeImportResult', () => {
  it('describes a clean verified handoff', () => {
    const summary = summarizeImportResult(baseResult);

    expect(summary.outcomeTitle).toBe('Import Complete');
    expect(summary.verificationLabel).toBe('2 checksum matches confirmed');
    expect(summary.outcomeMessage).toBe('All selected files are accounted for.');
    expect(summary.recoveryMessage).toBe('No recovery action is needed.');
  });

  it('includes failed and pending files in the recovery summary', () => {
    const summary = summarizeImportResult({
      ...baseResult,
      errors: [{ file: 'bad.jpg', error: 'Disk full' }],
      ledgerItems: [
        { sourcePath: 'E:\\DCIM\\bad.jpg', name: 'bad.jpg', size: 100, status: 'failed', error: 'Disk full' },
        { sourcePath: 'E:\\DCIM\\later.jpg', name: 'later.jpg', size: 100, status: 'pending' },
      ],
    });

    expect(summary.outcomeTitle).toBe('Import Finished With Follow-Up');
    expect(summary.issueCount).toBe(2);
    expect(summary.pendingCount).toBe(1);
    expect(summary.recoveryMessage).toBe('Retry will pick up failed and pending files from the saved import ledger.');
  });

  it('treats non-ledger copy and verification errors as follow-up issues', () => {
    const summary = summarizeImportResult({
      ...baseResult,
      errors: [{ file: 'good.jpg (backup checksum)', error: 'Backup copy checksum mismatch' }],
      ledgerItems: [
        { sourcePath: 'E:\\DCIM\\good.jpg', name: 'good.jpg', size: 100, status: 'verified' },
      ],
    });

    expect(summary.outcomeTitle).toBe('Import Finished With Follow-Up');
    expect(summary.issueCount).toBe(1);
    expect(summary.failedCount).toBe(1);
    expect(summary.nonLedgerErrorCount).toBe(1);
    expect(summary.recoveryMessage).toBe('Review the listed copy or verification errors before handing this set off.');
    expect(summary.displayedIssues).toEqual([
      { file: 'good.jpg (backup checksum)', error: 'Backup copy checksum mismatch' },
    ]);
  });
});

describe('summarizeSkippedImportReasons', () => {
  it('breaks skipped files down by duplicate, conflict, and other ledger reasons', () => {
    const summary = summarizeSkippedImportReasons({
      ...baseResult,
      skipped: 4,
      ledgerItems: [
        { sourcePath: 'E:\\DCIM\\dupe.jpg', name: 'dupe.jpg', size: 100, status: 'skipped', error: 'Duplicate at destination' },
        { sourcePath: 'E:\\DCIM\\conflict.jpg', name: 'conflict.jpg', size: 100, status: 'skipped', error: 'Destination file already exists' },
        { sourcePath: 'E:\\DCIM\\deferred.jpg', name: 'deferred.jpg', size: 100, status: 'skipped', error: 'Skipped by policy' },
        { sourcePath: 'E:\\DCIM\\ok.jpg', name: 'ok.jpg', size: 100, status: 'imported' },
      ],
    });

    expect(summary.duplicateCount).toBe(1);
    expect(summary.conflictCount).toBe(1);
    expect(summary.otherCount).toBe(2);
    expect(summary.detail).toBe('1 duplicate, 1 destination conflict, 2 other skipped files');
    expect(summary.reportLabel).toBe('4 skipped (1 duplicate, 1 destination conflict, 2 other skipped files)');
  });

  it('keeps legacy skipped results understandable when no ledger items exist', () => {
    const summary = summarizeSkippedImportReasons({
      ...baseResult,
      skipped: 2,
      ledgerItems: undefined,
    });

    expect(summary.duplicateCount).toBe(2);
    expect(summary.detail).toBe('2 presumed duplicates');
    expect(summary.reportLabel).toBe('2 skipped (2 presumed duplicates)');
  });
});

describe('summarizeReviewImportVisibility', () => {
  const files: MediaFile[] = [
    { path: 'E:\\DCIM\\pick.jpg', name: 'pick.jpg', size: 100, type: 'photo', extension: '.jpg', destPath: 'D:\\Photos\\pick.jpg', pick: 'selected' },
    { path: 'E:\\DCIM\\reject.jpg', name: 'reject.jpg', size: 100, type: 'photo', extension: '.jpg', destPath: 'D:\\Photos\\reject.jpg', pick: 'rejected' },
  ];

  it('shows manual grid selections as the import source when present', () => {
    const summary = summarizeReviewImportVisibility(baseResult, files, 2, 0);

    expect(summary.sourceLabel).toBe('Manual selection');
    expect(summary.sourceMessage).toBe('2 grid selections were sent to import. 4 files are accounted for.');
  });

  it('falls back to picked photos and explains rejected files were left out', () => {
    const summary = summarizeReviewImportVisibility(baseResult, files);

    expect(summary.sourceLabel).toBe('Picked photos');
    expect(summary.sourceMessage).toBe('1 picked photo was sent to import. 1 rejected photo was left out.');
  });

  it('surfaces retry as the next step when recovery work remains', () => {
    const summary = summarizeReviewImportVisibility({
      ...baseResult,
      errors: [{ file: 'bad.jpg', error: 'Disk full' }],
    }, files);

    expect(summary.nextStep).toBe('Retry failed or pending files before handing this set off.');
  });
});
