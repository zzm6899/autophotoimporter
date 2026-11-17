import { describe, expect, it } from 'vitest';
import { canAutoEjectAfterImport } from '../auto-eject';
import type { ImportConfig, ImportResult } from '../../../shared/types';

const config = { autoEject: true, sourcePath: '/card', saveFormat: 'original', verifyChecksums: true } satisfies Partial<ImportConfig>;
const ok: ImportResult = {
  imported: 1, skipped: 0, verified: 1, checksumVerified: 1,
  totalBytes: 50, durationMs: 1000, finishedTransfers: true, errors: [],
  ledgerItems: [{ name: 'frame.raw', sourcePath: '/card/frame.raw', size: 50, status: 'verified' }],
};

describe('automatic source ejection', () => {
  it('allows a fully checked opt-in import, but never a preview', () => {
    expect(canAutoEjectAfterImport(config, ok)).toBe(true);
    expect(canAutoEjectAfterImport({ ...config, dryRun: true }, ok)).toBe(false);
    expect(canAutoEjectAfterImport({ ...config, autoEject: false }, ok)).toBe(false);
    expect(canAutoEjectAfterImport({ ...config, sourcePath: '' }, ok)).toBe(false);
  });
  it('keeps the source mounted for canceled transfers and old reports without completion evidence', () => {
    expect(canAutoEjectAfterImport(config, { ...ok, finishedTransfers: false })).toBe(false);
    expect(canAutoEjectAfterImport(config, { ...ok, finishedTransfers: undefined })).toBe(false);
  });
  it.each(['pending', 'failed', 'planned', 'skipped'] as const)('blocks a %s ledger row', (status) => {
    expect(canAutoEjectAfterImport(config, { ...ok, ledgerItems: [{ ...ok.ledgerItems![0], status }] })).toBe(false);
  });
  it('does not reinterpret skipped, missing or unverified items as safe copies', () => {
    for (const patch of [{ imported: 0 }, { skipped: 1 }, { ledgerItems: undefined }, { ledgerItems: [] },
      { verified: 0 }, { checksumVerified: 0 }]) {
      expect(canAutoEjectAfterImport(config, { ...ok, ...patch })).toBe(false);
    }
  });
  it('blocks errors added after primary verification, including backup and handoff failures', () => {
    for (const file of ['backup', 'ftp-output', 'lightroom-handoff']) {
      expect(canAutoEjectAfterImport(config, { ...ok, errors: [{ file, error: 'Incomplete' }] })).toBe(false);
    }
  });
  it('does not require a checksum when the user did not select checksum verification', () => {
    expect(canAutoEjectAfterImport({ ...config, verifyChecksums: false }, { ...ok, checksumVerified: 0 })).toBe(true);
  });
});
