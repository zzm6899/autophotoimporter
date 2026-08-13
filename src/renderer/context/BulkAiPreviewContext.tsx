import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useAppState, useReviewScoresVersion } from './ImportContext';

export type BulkAiDecisionOutcome = 'keep' | 'reject' | 'queue';

export interface BulkAiDecisionItem {
  path: string;
  outcome: BulkAiDecisionOutcome;
  reasons: string[];
  score?: number;
  confidence?: 'high' | 'medium' | 'low' | 'manual';
  groupLabel?: string;
}

export interface BulkAiDecisionPlan {
  /** Stable for one preview. Opening a new plan resets filters and exclusions. */
  id: string;
  title: string;
  summary: string;
  items: BulkAiDecisionItem[];
  unchangedCount?: number;
  warnings?: string[];
  applyLabel?: string;
  onApply: (items: BulkAiDecisionItem[]) => void;
  /** Source/scan identity captured by the provider when this proposal opens. */
  openedSourcePath?: string | null;
  openedScanId?: string | null;
  openedReviewVersion?: number;
  openedFileCount?: number;
}

export function selectedBulkAiDecisionItems(
  items: readonly BulkAiDecisionItem[],
  excludedPaths: ReadonlySet<string>,
): BulkAiDecisionItem[] {
  return items.filter((item) => !excludedPaths.has(item.path));
}

export function bulkAiDecisionPage(
  items: readonly BulkAiDecisionItem[],
  page: number,
  pageSize: number,
): BulkAiDecisionItem[] {
  const safeSize = Math.max(1, Math.floor(pageSize));
  const safePage = Math.max(0, Math.floor(page));
  return items.slice(safePage * safeSize, (safePage + 1) * safeSize);
}

export function bulkAiDecisionPlanStaleReason(
  plan: BulkAiDecisionPlan,
  currentSourcePath: string | null,
  currentScanId: string | null,
  currentReviewVersion: number,
  availablePaths: ReadonlySet<string>,
): string | null {
  if (plan.openedSourcePath !== currentSourcePath || plan.openedScanId !== currentScanId) {
    return 'The source or scan changed after this preview was created. Close it and generate a fresh preview.';
  }
  if (plan.openedReviewVersion !== currentReviewVersion) {
    return 'AI analysis changed after this preview was created. Close it and generate a fresh preview before applying decisions.';
  }
  const unavailableCount = plan.items.reduce(
    (count, item) => count + (availablePaths.has(item.path) ? 0 : 1),
    0,
  );
  if (unavailableCount > 0) {
    return `${unavailableCount} proposed photo${unavailableCount === 1 ? ' is' : 's are'} no longer in this shoot. Close this preview and generate it again.`;
  }
  if (plan.openedFileCount !== availablePaths.size) {
    return 'The photos in this shoot changed after this preview was created. Close it and generate a fresh preview.';
  }
  return null;
}

interface BulkAiPreviewContextValue {
  plan: BulkAiDecisionPlan | null;
  openBulkAiPreview: (plan: BulkAiDecisionPlan) => void;
  closeBulkAiPreview: () => void;
}

const BulkAiPreviewContext = createContext<BulkAiPreviewContextValue | null>(null);

export function BulkAiPreviewProvider({ children }: { children: ReactNode }) {
  const { selectedSource, activeScanId, files } = useAppState();
  const reviewVersion = useReviewScoresVersion();
  const [plan, setPlan] = useState<BulkAiDecisionPlan | null>(null);
  const openBulkAiPreview = useCallback((nextPlan: BulkAiDecisionPlan) => {
    // React treats functions passed directly to setState as updater functions;
    // the plan itself contains onApply, so always wrap it.
    setPlan(() => ({
      ...nextPlan,
      openedSourcePath: selectedSource,
      openedScanId: activeScanId,
      openedReviewVersion: reviewVersion,
      openedFileCount: files.length,
    }));
  }, [activeScanId, files.length, reviewVersion, selectedSource]);
  const closeBulkAiPreview = useCallback(() => setPlan(null), []);
  const value = useMemo(() => ({ plan, openBulkAiPreview, closeBulkAiPreview }), [
    closeBulkAiPreview,
    openBulkAiPreview,
    plan,
  ]);

  return <BulkAiPreviewContext.Provider value={value}>{children}</BulkAiPreviewContext.Provider>;
}

export function useBulkAiPreview(): BulkAiPreviewContextValue {
  const value = useContext(BulkAiPreviewContext);
  if (!value) throw new Error('useBulkAiPreview must be used inside BulkAiPreviewProvider');
  return value;
}
