import type { ImportConfig, ImportResult } from '../../shared/types';

/** Auto-eject is opt-in and requires positive evidence from this run, never a legacy counter. */
export function canAutoEjectAfterImport(
  config: Pick<ImportConfig, 'autoEject' | 'sourcePath' | 'dryRun' | 'saveFormat' | 'verifyChecksums'>,
  result: ImportResult,
): boolean {
  if (config.autoEject !== true || !config.sourcePath || config.dryRun || result.finishedTransfers !== true) return false;
  if (result.errors.length || result.imported <= 0 || result.skipped !== 0 || result.verified !== result.imported) return false;
  if (!result.ledgerItems || result.ledgerItems.length !== result.imported) return false;
  if (config.verifyChecksums && config.saveFormat === 'original' && result.checksumVerified !== result.imported) return false;
  return result.ledgerItems.every((item) => item.status === 'imported' || item.status === 'verified');
}
