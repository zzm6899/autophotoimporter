import { describe, expect, it } from 'vitest';
import { getImportHealthHeadline, getImportHealthIssueCount } from '../ImportHealthDashboard';
import type { ImportHealthSummary } from '../../../shared/types';

type SummaryOverrides = Partial<Omit<ImportHealthSummary, 'lastImport' | 'checksum' | 'backup' | 'ftp' | 'watchFolders'>> & {
  lastImport?: Partial<ImportHealthSummary['lastImport']>;
  checksum?: Partial<ImportHealthSummary['checksum']>;
  backup?: Partial<ImportHealthSummary['backup']>;
  ftp?: Partial<ImportHealthSummary['ftp']>;
  watchFolders?: Partial<ImportHealthSummary['watchFolders']>;
};

function makeSummary(overrides: SummaryOverrides = {}): ImportHealthSummary {
  const base: ImportHealthSummary = {
    generatedAt: '2026-05-02T00:00:00.000Z',
    latestLedger: null,
    lastImport: {
      state: 'healthy',
      createdAt: '2026-05-02T00:00:00.000Z',
      sourcePath: '/src',
      destRoot: '/dest',
      totalFiles: 3,
      imported: 3,
      skipped: 0,
      failed: 0,
      pending: 0,
      totalBytes: 300,
      durationMs: 1000,
    },
    retryableItems: [],
    checksum: {
      enabled: true,
      status: 'verified',
      verified: 3,
      expected: 3,
    },
    backup: {
      enabled: true,
      status: 'ok',
      targetRoot: '/backup',
      copied: 3,
      failed: 0,
      totalTargets: 3,
    },
    ftp: {
      enabled: false,
      status: 'disabled',
      message: 'FTP workflow is disabled.',
    },
    catalog: null,
    watchFolders: {
      total: 0,
      enabled: 0,
      active: 0,
      autoScan: 0,
      autoImport: 0,
      missing: 0,
      needsDestination: 0,
      folders: [],
    },
  };

  return {
    ...base,
    ...overrides,
    lastImport: { ...base.lastImport, ...overrides.lastImport },
    checksum: { ...base.checksum, ...overrides.checksum },
    backup: { ...base.backup, ...overrides.backup },
    ftp: { ...base.ftp, ...overrides.ftp },
    watchFolders: { ...base.watchFolders, ...overrides.watchFolders },
  };
}

describe('ImportHealthDashboard helpers', () => {
  it('describes a healthy latest import', () => {
    const summary = makeSummary();

    expect(getImportHealthIssueCount(summary)).toBe(0);
    expect(getImportHealthHeadline(summary)).toBe('Last import is healthy');
  });

  it('counts retryable and infrastructure issues', () => {
    const summary = makeSummary({
      lastImport: { state: 'attention', failed: 1, pending: 1 },
      retryableItems: [
        { sourcePath: '/src/a.jpg', name: 'a.jpg', size: 100, status: 'failed', error: 'Disk full' },
        { sourcePath: '/src/b.jpg', name: 'b.jpg', size: 100, status: 'pending' },
      ],
      checksum: { status: 'partial', verified: 1, expected: 3 },
      backup: { status: 'attention', failed: 1 },
      ftp: { enabled: true, status: 'error', message: 'FTP failed.' },
      watchFolders: { missing: 1, needsDestination: 1 },
    });

    expect(getImportHealthIssueCount(summary)).toBe(7);
    expect(getImportHealthHeadline(summary)).toBe('Last import needs follow-up');
  });

  it('handles empty import history', () => {
    const summary = makeSummary({
      lastImport: {
        state: 'none',
        createdAt: undefined,
        sourcePath: undefined,
        destRoot: undefined,
        totalFiles: 0,
        imported: 0,
        skipped: 0,
        totalBytes: 0,
        durationMs: 0,
      },
      checksum: { status: 'unavailable', verified: 0, expected: 0 },
      backup: { status: 'unavailable', copied: 0, failed: 0, totalTargets: 0 },
    });

    expect(getImportHealthHeadline(summary)).toBe('No import ledger yet');
  });
});
