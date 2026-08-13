import { describe, expect, it } from 'vitest';
import { scanCommitTarget, thumbnailCommitTarget } from '../scanBatching';

function countScanCommits(total: number, ipcBatch = 50): number {
  let dispatched = 0;
  let pending = 0;
  let commits = 0;
  while (dispatched + pending < total) {
    pending += Math.min(ipcBatch, total - dispatched - pending);
    if (pending >= scanCommitTarget(dispatched + pending)) {
      dispatched += pending;
      pending = 0;
      commits++;
    }
  }
  if (pending > 0) commits++;
  return commits;
}

describe('adaptive scan batching', () => {
  it('bounds immutable catalogue appends for one million scanner rows', () => {
    // The scanner emits 20,000 small IPC batches, but React commits only a
    // logarithmic/bounded number of catalogue arrays.
    expect(countScanCommits(1_000_000)).toBeLessThan(40);
  });

  it('bounds thumbnail catalogue copies to a small fraction of the old 96-row policy', () => {
    const target = thumbnailCommitTarget(1_000_000);
    expect(target).toBeGreaterThanOrEqual(16_384);
    expect(Math.ceil(1_000_000 / target)).toBeLessThanOrEqual(64);
    expect(Math.ceil(1_000_000 / target)).toBeLessThan(Math.ceil(1_000_000 / 96) / 100);
  });
});
