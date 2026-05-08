import { describe, expect, it } from 'vitest';
import { summarizeReviewFlowNextStep } from '../ThumbnailGrid';

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
