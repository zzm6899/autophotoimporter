import { describe, expect, it } from 'vitest';
import { bulkAiDecisionPage, bulkAiDecisionPlanStaleReason, selectedBulkAiDecisionItems, type BulkAiDecisionItem, type BulkAiDecisionPlan } from '../BulkAiPreviewContext';

function decisions(count: number): BulkAiDecisionItem[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `/shoot/frame-${String(index).padStart(3, '0')}.jpg`,
    outcome: index === 0 ? 'keep' : 'reject',
    reasons: [index === 0 ? 'top-ranked candidate' : 'lower-ranked comparable frame'],
  }));
}

describe('bulk AI decision preview ledger', () => {
  it('makes every decision in a 120-photo Best Of page reachable', () => {
    const items = decisions(120);
    const visited = [
      ...bulkAiDecisionPage(items, 0, 80),
      ...bulkAiDecisionPage(items, 1, 80),
    ];

    expect(visited).toHaveLength(120);
    expect(new Set(visited.map((item) => item.path)).size).toBe(120);
  });

  it('applies only decisions the photographer left checked', () => {
    const items = decisions(7);
    const selected = selectedBulkAiDecisionItems(items, new Set([items[2].path, items[6].path]));

    expect(selected.map((item) => item.path)).toEqual(items.filter((_, index) => index !== 2 && index !== 6).map((item) => item.path));
  });

  it('blocks a proposal when its source, scan, or file set is stale', () => {
    const plan: BulkAiDecisionPlan = {
      id: 'proposal-1',
      title: 'Preview',
      summary: 'Review changes',
      items: decisions(2),
      openedSourcePath: '/shoot',
      openedScanId: 'scan-1',
      openedReviewVersion: 4,
      openedFileCount: 2,
      onApply: () => undefined,
    };
    const allPaths = new Set(plan.items.map((item) => item.path));

    expect(bulkAiDecisionPlanStaleReason(plan, '/shoot', 'scan-1', 4, allPaths)).toBeNull();
    expect(bulkAiDecisionPlanStaleReason(plan, '/other', 'scan-1', 4, allPaths)).toContain('source or scan changed');
    expect(bulkAiDecisionPlanStaleReason(plan, '/shoot', 'scan-2', 4, allPaths)).toContain('source or scan changed');
    expect(bulkAiDecisionPlanStaleReason(plan, '/shoot', 'scan-1', 5, allPaths)).toContain('AI analysis changed');
    expect(bulkAiDecisionPlanStaleReason(plan, '/shoot', 'scan-1', 4, new Set([...allPaths, '/shoot/new.jpg']))).toContain('photos in this shoot changed');
    expect(bulkAiDecisionPlanStaleReason(plan, '/shoot', 'scan-1', 4, new Set([plan.items[0].path]))).toContain('1 proposed photo is no longer');
  });
});
