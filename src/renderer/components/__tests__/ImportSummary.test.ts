import { describe, expect, it } from 'vitest';
import { summarizeImportResult, summarizeReviewImportVisibility } from '../ImportSummary';
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
