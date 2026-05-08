import { describe, expect, it } from 'vitest';
import { summarizeBestOfActions } from '../BestOfSelectionPanel';
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
    expect(summary?.pickLabel).toBe('Pick Best marks keeper.jpg as picked; 2 other candidates stay unchanged.');
    expect(summary?.rejectRestLabel).toBe('Reject Rest marks keeper.jpg picked and rejects 2 other candidates in this panel.');
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
});
