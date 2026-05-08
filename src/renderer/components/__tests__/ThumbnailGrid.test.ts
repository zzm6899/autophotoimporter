import { describe, expect, it } from 'vitest';
import { alignBestOfBatchOffset, shouldOpenBestOfSelectionPanel, shouldQueueVisibleImportablePaths, sliceBestOfBatchPathPage, summarizeBestOfBatchPage, summarizeReviewFlowHealth, summarizeReviewFlowNextStep } from '../ThumbnailGrid';

describe('summarizeReviewFlowNextStep', () => {
  it('shows the importable count when some queued files are blocked', () => {
    const summary = summarizeReviewFlowNextStep({
      queuedCount: 12,
      queuedImportableCount: 9,
      hasDestination: true,
      pendingCount: 4,
    });

    expect(summary.nextStep).toBe('Import 9/12 queued');
    expect(summary.nextStepTitle).toContain('3 queued files will not import');
  });

  it('asks the user to fix the queue when nothing queued is importable', () => {
    const summary = summarizeReviewFlowNextStep({
      queuedCount: 12,
      queuedImportableCount: 0,
      hasDestination: true,
      pendingCount: 4,
    });

    expect(summary.nextStep).toBe('Fix 12 queued');
    expect(summary.nextStepTitle).toContain('12 queued files will not import');
  });

  it('prioritizes destination setup before queue importability', () => {
    const summary = summarizeReviewFlowNextStep({
      queuedCount: 12,
      queuedImportableCount: 9,
      hasDestination: false,
      pendingCount: 4,
    });

    expect(summary.nextStep).toBe('Choose destination for 12 queued');
    expect(summary.nextStepTitle).toBe('Choose a destination folder before importing queued files.');
  });

  it('keeps the existing pending review label when nothing is queued', () => {
    expect(summarizeReviewFlowNextStep({
      queuedCount: 0,
      queuedImportableCount: 0,
      hasDestination: true,
      pendingCount: 5,
    })).toEqual({ nextStep: '5 left to decide' });
  });

  it('clamps transient importable counts to the queued total', () => {
    expect(summarizeReviewFlowNextStep({
      queuedCount: 3,
      queuedImportableCount: 5,
      hasDestination: true,
      pendingCount: 0,
    })).toEqual({ nextStep: 'Import 3 queued' });
  });
});

describe('summarizeReviewFlowHealth', () => {
  it('renders clean scans as passive health instead of a filter target', () => {
    expect(summarizeReviewFlowHealth({
      blurCount: 0,
      catalogMatchCount: 0,
      groupPhotosCount: 0,
      faceGroupsCount: 0,
    })).toEqual({
      label: 'No review issues',
      title: 'No blur risk, catalog matches, group photos, or face groups need attention.',
      targetFilter: null,
    });
  });

  it('prioritizes blur risk before other health filters', () => {
    expect(summarizeReviewFlowHealth({
      blurCount: 3,
      catalogMatchCount: 2,
      groupPhotosCount: 4,
      faceGroupsCount: 5,
    })).toEqual({
      label: '3 blur risk',
      title: 'Show blur-risk photos.',
      targetFilter: 'blur-risk',
    });
  });

  it('maps remaining health states to their filter targets', () => {
    expect(summarizeReviewFlowHealth({
      blurCount: 0,
      catalogMatchCount: 2,
      groupPhotosCount: 0,
      faceGroupsCount: 0,
    }).targetFilter).toBe('catalog-duplicates');
    expect(summarizeReviewFlowHealth({
      blurCount: 0,
      catalogMatchCount: 0,
      groupPhotosCount: 4,
      faceGroupsCount: 0,
    }).targetFilter).toBe('group-photos');
    expect(summarizeReviewFlowHealth({
      blurCount: 0,
      catalogMatchCount: 0,
      groupPhotosCount: 0,
      faceGroupsCount: 5,
    }).targetFilter).toBe('face-gallery');
  });
});

describe('alignBestOfBatchOffset', () => {
  it('keeps adjacent navigation on page starts instead of one-photo tail offsets', () => {
    expect(alignBestOfBatchOffset(239, 240, 120)).toBe(120);
    expect(alignBestOfBatchOffset(240, 240, 120)).toBe(120);
  });

  it('allows a real partial final page when the batch has remaining photos', () => {
    expect(alignBestOfBatchOffset(240, 241, 120)).toBe(240);
  });

  it('clamps negative and empty inputs safely', () => {
    expect(alignBestOfBatchOffset(-20, 240, 120)).toBe(0);
    expect(alignBestOfBatchOffset(120, 0, 120)).toBe(0);
  });
});

describe('summarizeBestOfBatchPage', () => {
  it('describes the first page range and leaves previous navigation disabled', () => {
    expect(summarizeBestOfBatchPage(0, 241, 120)).toEqual({
      pageStart: 0,
      pageEnd: 120,
      currentPage: 1,
      totalPages: 3,
      canPrev: false,
      canNext: true,
      subtitle: 'Page 1/3 · photos 1-120 of 241',
    });
  });

  it('describes the final partial page and disables next navigation', () => {
    expect(summarizeBestOfBatchPage(240, 241, 120)).toEqual({
      pageStart: 240,
      pageEnd: 241,
      currentPage: 3,
      totalPages: 3,
      canPrev: true,
      canNext: false,
      subtitle: 'Page 3/3 · photos 241-241 of 241',
    });
  });

  it('keeps single-page batches simple and disables both directions', () => {
    expect(summarizeBestOfBatchPage(0, 80, 120)).toEqual({
      pageStart: 0,
      pageEnd: 80,
      currentPage: 1,
      totalPages: 1,
      canPrev: false,
      canNext: false,
      subtitle: '80 visible photos ranked together',
    });
  });
});

describe('sliceBestOfBatchPathPage', () => {
  it('uses the original batch path snapshot for page slices', () => {
    const original = Array.from({ length: 241 }, (_, index) => `/photos/${index}.jpg`);
    const firstPage = sliceBestOfBatchPathPage(original, 0, 120);
    const afterRejectingFirstPage = original.filter((path) => !firstPage.paths.includes(path));

    expect(sliceBestOfBatchPathPage(original, 120, 120).paths).toEqual(original.slice(120, 240));
    expect(sliceBestOfBatchPathPage(afterRejectingFirstPage, 120, 120).paths).not.toEqual(original.slice(120, 240));
  });
});

describe('shouldQueueVisibleImportablePaths', () => {
  it('blocks queue-visible commands that have no importable visible files', () => {
    expect(shouldQueueVisibleImportablePaths([])).toBe(false);
    expect(shouldQueueVisibleImportablePaths(['/photos/keeper.jpg'])).toBe(true);
  });
});

describe('shouldOpenBestOfSelectionPanel', () => {
  it('blocks hidden best-of state when there are no candidate paths', () => {
    expect(shouldOpenBestOfSelectionPanel([])).toBe(false);
    expect(shouldOpenBestOfSelectionPanel(['/photos/visible.jpg'])).toBe(true);
  });
});
