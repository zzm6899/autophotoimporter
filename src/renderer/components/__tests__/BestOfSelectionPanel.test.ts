import { describe, expect, it } from 'vitest';
import { actionableBestOfCandidates, bestOfShortcutAction, rankBestOfSelection, summarizeBestOfActions } from '../BestOfSelectionPanel';
import type { MediaFile } from '../../../shared/types';

function photo(name: string, pick?: MediaFile['pick']): MediaFile {
  return {
    path: `E:\\DCIM\\${name}`,
    name,
    size: 100,
    type: 'photo',
    extension: '.jpg',
    pick,
  };
}

describe('summarizeBestOfActions', () => {
  it('explains that batch actions are scoped to the current page', () => {
    const best = photo('keeper.jpg');
    const summary = summarizeBestOfActions(
      [best, photo('near-miss.jpg'), photo('soft.jpg')],
      best,
      [],
      'batch',
    );

    expect(summary?.scopeLabel).toContain('Current batch page: 3 candidates.');
    expect(summary?.scopeLabel).toContain('Next/Prev page changes which candidates these actions affect.');
    expect(summary?.pickButtonLabel).toBe('Pick Page Best');
    expect(summary?.queueButtonLabel).toBe('Queue Page Best');
    expect(summary?.queueAndNextButtonLabel).toBe('Queue + Next');
    expect(summary?.queueAndNextLabel).toBe('Queue + Next adds keeper.jpg to the import queue and opens the following batch page.');
    expect(summary?.rejectRestButtonLabel).toBe('Reject Page Rest');
    expect(summary?.acceptAndNextButtonLabel).toBe('Accept + Next');
    expect(summary?.acceptAndNextLabel).toBe('Accept + Next marks keeper.jpg picked, rejects 2 other candidates in this page, and opens the following batch page.');
    expect(summary?.pickLabel).toBe('Pick Best marks keeper.jpg as picked; 2 other candidates stay unchanged.');
    expect(summary?.rejectRestLabel).toBe('Reject Rest marks keeper.jpg picked and rejects 2 other candidates in this panel.');
  });

  it('keeps page-and-next shortcuts scoped to batch summaries', () => {
    const best = photo('keeper.jpg');
    const summary = summarizeBestOfActions([best, photo('other.jpg')], best);

    expect(summary?.queueButtonLabel).toBe('Queue Best');
    expect(summary?.queueAndNextButtonLabel).toBeUndefined();
    expect(summary?.queueAndNextLabel).toBeUndefined();
    expect(summary?.acceptAndNextButtonLabel).toBeUndefined();
    expect(summary?.acceptAndNextLabel).toBeUndefined();
  });

  it('surfaces an already queued top candidate without changing flags', () => {
    const best = photo('queued.jpg', 'selected');
    const summary = summarizeBestOfActions([best, photo('other.jpg')], best, [best.path]);

    expect(summary?.queueState).toBe('queued');
    expect(summary?.pickLabel).toBe('queued.jpg is already picked; 1 other candidate stays unchanged.');
    expect(summary?.queueLabel).toBe('queued.jpg is already in the import queue; pick/reject flags stay unchanged.');
  });

  it('handles a single candidate without implying other files will change', () => {
    const best = photo('solo.jpg', 'rejected');
    const summary = summarizeBestOfActions([best], best);

    expect(summary?.pickLabel).toBe('Pick Best changes solo.jpg from rejected to picked.');
    expect(summary?.rejectRestLabel).toBe('Reject Rest keeps solo.jpg picked because it is the only candidate.');
  });

  it('ranks the quality-best photo above a weaker manual pick', () => {
    const ranked = rankBestOfSelection([
      {
        ...photo('manual-pick.jpg', 'selected'),
        subjectSharpnessScore: 70,
        sharpnessScore: 70,
        reviewScore: 50,
      },
      {
        ...photo('quality-best.jpg'),
        subjectSharpnessScore: 95,
        sharpnessScore: 95,
        reviewScore: 70,
      },
    ]);

    expect(ranked[0].name).toBe('quality-best.jpg');
  });

  it('uses non-rejected candidates for best-of actions before rejected high-score frames', () => {
    const viable = {
      ...photo('viable.jpg'),
      subjectSharpnessScore: 45,
      sharpnessScore: 50,
      reviewScore: 30,
    };
    const rejected = {
      ...photo('rejected-strong.jpg', 'rejected'),
      subjectSharpnessScore: 220,
      sharpnessScore: 240,
      reviewScore: 99,
    };
    const candidates = actionableBestOfCandidates(rankBestOfSelection([rejected, viable]));

    expect(candidates[0].name).toBe('viable.jpg');
    expect(candidates.some((file) => file.pick === 'rejected')).toBe(false);
  });
});

describe('bestOfShortcutAction', () => {
  it('queues and advances from batch pages with a next page', () => {
    expect(bestOfShortcutAction({
      key: 'q',
      hasBest: true,
      isBatch: true,
      canNextBatch: true,
      canQueueBestAndNext: true,
      canAcceptRestAndNext: true,
      readinessTone: 'manual',
    })).toBe('queue-next');
  });

  it('queues without advancing on the final page', () => {
    expect(bestOfShortcutAction({
      key: 'q',
      hasBest: true,
      isBatch: true,
      canNextBatch: false,
      canQueueBestAndNext: true,
      canAcceptRestAndNext: true,
      readinessTone: 'safe',
    })).toBe('queue');
  });

  it('accepts and advances only when the best candidate is safe', () => {
    expect(bestOfShortcutAction({
      key: 'Enter',
      hasBest: true,
      isBatch: true,
      canNextBatch: true,
      canQueueBestAndNext: true,
      canAcceptRestAndNext: true,
      readinessTone: 'safe',
    })).toBe('accept-next');

    expect(bestOfShortcutAction({
      key: 'Enter',
      hasBest: true,
      isBatch: true,
      canNextBatch: true,
      canQueueBestAndNext: true,
      canAcceptRestAndNext: true,
      readinessTone: 'review',
    })).toBe('none');
  });

  it('accepts without advancing on the final page only when safe', () => {
    expect(bestOfShortcutAction({
      key: 'Enter',
      hasBest: true,
      isBatch: true,
      canNextBatch: false,
      canQueueBestAndNext: true,
      canAcceptRestAndNext: true,
      readinessTone: 'safe',
    })).toBe('accept');
  });

  it('ignores modified keys, missing best candidates, and open lightboxes', () => {
    const base = {
      key: 'q',
      hasBest: true,
      isBatch: true,
      canNextBatch: true,
      canQueueBestAndNext: true,
      canAcceptRestAndNext: true,
      readinessTone: 'safe' as const,
    };

    expect(bestOfShortcutAction({ ...base, hasModifier: true })).toBe('none');
    expect(bestOfShortcutAction({ ...base, hasBest: false })).toBe('none');
    expect(bestOfShortcutAction({ ...base, lightboxOpen: true })).toBe('none');
  });
});
