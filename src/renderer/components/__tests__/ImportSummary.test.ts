import { describe, expect, it } from 'vitest';
import { summarizeImportResult } from '../ImportSummary';
import type { ImportResult } from '../../../shared/types';

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
