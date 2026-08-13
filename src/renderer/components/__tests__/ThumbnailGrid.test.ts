import { describe, expect, it } from 'vitest';
import { alignBestOfBatchOffset, bestOfAutomaticDecision, formatFaceProviderSummary, getReviewStartTarget, getSelectedReviewStartTarget, hasPendingVisualHashInput, isJpegFamilyPhoto, isRawFilterPhoto, nextOptionalReviewFeatureFailure, planTerminalReviewGrouping, reconcileOptionalReviewFeatureAvailability, shouldFinalizeFaceAnalysisFailure, shouldOpenBestOfSelectionPanel, shouldQueueVisibleImportablePaths, shouldRunOnnxForReview, sliceBestOfBatchPathPage, summarizeBestOfBatchPage, summarizeReviewFlowHealth, summarizeReviewFlowNextStep } from '../ThumbnailGrid';
import type { MediaFile } from '../../../shared/types';

describe('face provider status', () => {
  it('names the promoted detectors, their providers, and observed SSD fallback rate', () => {
    expect(formatFaceProviderSummary([], 'mixed', {
      state: 'active',
      active: true,
      faceProvider: 'dml',
      personProvider: 'dml',
      personRuns: 40,
      ssdFallbackRate: 0.125,
    })).toBe('YuNet DML · NanoDet DML · SSD fallback 13%');
  });

  it('does not invent a fallback percentage before NanoDet has processed a photo', () => {
    expect(formatFaceProviderSummary([], 'dml', {
      state: 'active',
      active: true,
      faceProvider: 'dml',
      personProvider: 'cpu',
      personRuns: 0,
      ssdFallbackRate: null,
    })).toBe('YuNet DML · NanoDet CPU · SSD fallback not measured');
  });

  it('shows the verified legacy route when the promoted pair is unavailable', () => {
    expect(formatFaceProviderSummary([
      { model: 'detector', provider: 'dml' },
      { model: 'person', provider: 'cpu' },
    ], 'mixed', {
      state: 'legacy-fallback',
      active: false,
      personRuns: 0,
      ssdFallbackRate: null,
    })).toBe('UltraFace DML · SSD CPU · YuNet/NanoDet unavailable');
  });
});

describe('terminal review grouping', () => {
  const photo = (path: string, overrides: Partial<MediaFile> = {}): MediaFile => ({
    path,
    name: path.slice(1),
    size: 1,
    type: 'photo',
    extension: '.jpg',
    ...overrides,
  });

  it('does not wait forever for a hash that cannot be produced', () => {
    expect(hasPendingVisualHashInput([
      photo('/no-thumbnail.jpg'),
      photo('/unavailable.jpg', { thumbnail: 'keptra-preview://unavailable', reviewAnalysisUnavailable: true }),
      { ...photo('/video.mp4', { thumbnail: 'keptra-preview://video' }), type: 'video', extension: '.mp4' },
    ], true)).toBe(false);

    expect(hasPendingVisualHashInput([
      photo('/ready.jpg', { thumbnail: 'keptra-preview://ready' }),
    ], true)).toBe(true);
    expect(hasPendingVisualHashInput([
      photo('/ready.jpg', { thumbnail: 'keptra-preview://ready' }),
    ], false)).toBe(false);
  });

  it('finalizes once, permits one evidence-producing cascade, then ignores navigation ticks', () => {
    const initialEvidence = {
      reviewGeneration: 4,
      evidenceRevision: 20,
      faceMatching: true,
      visualDuplicates: true,
      faceEmbeddingThreshold: 0.6,
      faceSignatureThreshold: 10,
      visualThreshold: 8,
    };
    const first = planTerminalReviewGrouping('', initialEvidence);
    expect(first.shouldFinalize).toBe(true);

    // Focus/navigation changed, but review evidence did not.
    expect(planTerminalReviewGrouping(first.key, initialEvidence).shouldFinalize).toBe(false);

    // Native comparison analysis after grouping produced new evidence.
    const cascade = planTerminalReviewGrouping(first.key, {
      ...initialEvidence,
      evidenceRevision: initialEvidence.evidenceRevision + 1,
    });
    expect(cascade.shouldFinalize).toBe(true);

    // The terminal pass after that cascade is stable; later navigation is a no-op.
    expect(planTerminalReviewGrouping(cascade.key, {
      ...initialEvidence,
      evidenceRevision: initialEvidence.evidenceRevision + 1,
    }).shouldFinalize).toBe(false);
  });
});

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

describe('getReviewStartTarget', () => {
  it('opens the focused unmarked photo when review candidates exist', () => {
    expect(getReviewStartTarget([
      { path: '/photos/a.jpg', pick: 'selected' },
      { path: '/photos/b.jpg' },
      { path: '/photos/c.jpg' },
    ], '/photos/c.jpg')).toEqual({
      filter: 'unmarked',
      path: '/photos/c.jpg',
      index: 1,
    });
  });

  it('falls back to all visible files when everything is already marked', () => {
    expect(getReviewStartTarget([
      { path: '/photos/a.jpg', pick: 'selected' },
      { path: '/photos/b.jpg', pick: 'rejected' },
    ], '/photos/b.jpg')).toEqual({
      filter: 'all',
      path: '/photos/b.jpg',
      index: 1,
    });
  });
});

describe('getSelectedReviewStartTarget', () => {
  it('opens the focused selected photo for individual review', () => {
    expect(getSelectedReviewStartTarget([
      { path: '/photos/a.jpg' },
      { path: '/photos/b.jpg' },
      { path: '/photos/c.jpg' },
    ], ['/photos/a.jpg', '/photos/c.jpg'], '/photos/c.jpg')).toEqual({
      path: '/photos/c.jpg',
      index: 2,
    });
  });

  it('falls back to the first selected visible photo', () => {
    expect(getSelectedReviewStartTarget([
      { path: '/photos/a.jpg' },
      { path: '/photos/b.jpg' },
      { path: '/photos/c.jpg' },
    ], ['/photos/c.jpg', '/photos/a.jpg'], '/photos/missing.jpg')).toEqual({
      path: '/photos/a.jpg',
      index: 0,
    });
  });
});

describe('photo format filter helpers', () => {
  it('treats Lumix HIF stills as JPEG-family photos, not RAW', () => {
    const hif = { type: 'photo' as const, extension: '.hif' };

    expect(isJpegFamilyPhoto(hif)).toBe(true);
    expect(isRawFilterPhoto(hif)).toBe(false);
  });
});

describe('shouldRunOnnxForReview', () => {
  const photo = (overrides: Partial<MediaFile> = {}): MediaFile => ({
    path: '/photos/ready.jpg',
    name: 'ready.jpg',
    size: 1,
    type: 'photo',
    extension: '.jpg',
    ...overrides,
  });
  const fullOptions = {
    reviewFaceAnalysis: true,
    reviewFaceMatching: true,
    reviewPersonDetection: true,
  };

  it('skips ONNX when only renderer-side sharpness or hash work is missing', () => {
    expect(shouldRunOnnxForReview(photo({
      faceBoxes: [],
      personBoxes: [],
      subjectSharpnessScore: 80,
    }), fullOptions)).toBe(false);
  });

  it('runs ONNX when face boxes have not been populated yet', () => {
    expect(shouldRunOnnxForReview(photo(), fullOptions)).toBe(true);
  });

  it('runs ONNX when native face boxes need embeddings for face matching', () => {
    expect(shouldRunOnnxForReview(photo({
      faceDetection: 'native',
      faceCount: 1,
      faceBoxes: [{ x: 0.2, y: 0.2, width: 0.2, height: 0.2 }],
      personBoxes: [],
    }), fullOptions)).toBe(true);
  });

  it('retries native eye detail until the optional feature is completed or unavailable', () => {
    const analysed = photo({
      faceDetection: 'native',
      faceCount: 1,
      faceBoxes: [{ x: 0.2, y: 0.2, width: 0.2, height: 0.2 }],
      personBoxes: [],
      reviewAnalysisFeatures: {
        faceDetection: true,
        personDetection: true,
        faceMatching: false,
        poseAnalysis: false,
        eyeDetail: false,
      },
    });

    expect(shouldRunOnnxForReview(analysed, {
      ...fullOptions,
      reviewFaceMatching: false,
    })).toBe(true);
    expect(shouldRunOnnxForReview({
      ...analysed,
      reviewAnalysisFeatures: { ...analysed.reviewAnalysisFeatures!, eyeDetail: true },
    }, {
      ...fullOptions,
      reviewFaceMatching: false,
    })).toBe(false);
    expect(shouldRunOnnxForReview({
      ...analysed,
      reviewAnalysisUnavailableFeatures: { eyeDetail: true },
    }, {
      ...fullOptions,
      reviewFaceMatching: false,
    })).toBe(false);
    expect(shouldRunOnnxForReview({
      ...analysed,
      reviewAnalysisUnavailable: true,
    }, {
      ...fullOptions,
      reviewFaceMatching: false,
    })).toBe(false);
  });

  it('respects disabled face analysis', () => {
    expect(shouldRunOnnxForReview(photo(), {
      ...fullOptions,
      reviewFaceAnalysis: false,
    })).toBe(false);
  });

  it('does not retry sports safeguards when person detection is disabled', () => {
    expect(shouldRunOnnxForReview(photo({
      faceBoxes: [],
      personBoxes: [],
      reviewAnalysisFeatures: {
        faceDetection: true,
        personDetection: false,
        faceMatching: false,
        poseAnalysis: false,
        eyeDetail: true,
        sportsSafeguards: false,
      },
    }), {
      reviewFaceAnalysis: true,
      reviewFaceMatching: false,
      reviewPersonDetection: false,
      reviewSportsSafeguards: true,
    })).toBe(false);
  });

  it('stops matching retries after the feature completes or becomes unavailable', () => {
    const analysed = photo({
      faceDetection: 'native',
      faceCount: 1,
      faceBoxes: [{ x: 0.2, y: 0.2, width: 0.2, height: 0.2 }],
      personBoxes: [],
      reviewAnalysisFeatures: {
        faceDetection: true,
        personDetection: true,
        faceMatching: false,
        poseAnalysis: false,
        eyeDetail: true,
      },
    });

    expect(shouldRunOnnxForReview(analysed, fullOptions)).toBe(true);
    expect(shouldRunOnnxForReview({
      ...analysed,
      reviewAnalysisFeatures: { ...analysed.reviewAnalysisFeatures!, faceMatching: true },
    }, fullOptions)).toBe(false);
    expect(shouldRunOnnxForReview({
      ...analysed,
      reviewAnalysisUnavailableFeatures: { faceMatching: true },
    }, fullOptions)).toBe(false);
  });
});

describe('shouldFinalizeFaceAnalysisFailure', () => {
  it('allows transient errors to retry but completes repeatedly unavailable files', () => {
    expect(shouldFinalizeFaceAnalysisFailure(1)).toBe(false);
    expect(shouldFinalizeFaceAnalysisFailure(2)).toBe(false);
    expect(shouldFinalizeFaceAnalysisFailure(3)).toBe(true);
  });

  it('clears an unavailable marker when a later optional-stage retry succeeds', () => {
    expect(reconcileOptionalReviewFeatureAvailability(
      { eyeDetail: true, poseAnalysis: true },
      { eyeDetail: true },
      {},
    )).toEqual({ poseAnalysis: true });
  });

  it('marks an incomplete optional eye stage unavailable on the third attempt and resets after success', () => {
    const first = nextOptionalReviewFeatureFailure(0, true);
    const second = nextOptionalReviewFeatureFailure(first.attempts, true);
    const third = nextOptionalReviewFeatureFailure(second.attempts, true);

    expect(first).toEqual({ attempts: 1, unavailable: false });
    expect(second).toEqual({ attempts: 2, unavailable: false });
    expect(third).toEqual({ attempts: 3, unavailable: true });
    expect(nextOptionalReviewFeatureFailure(third.attempts, false)).toEqual({
      attempts: 0,
      unavailable: false,
    });
  });
});

describe('bestOfAutomaticDecision', () => {
  it('does not let a higher coarse-score HYROX detector miss reject an analysed athlete', () => {
    const unsafe: MediaFile = {
      path: '/unsafe.jpg', name: 'unsafe.jpg', size: 1, type: 'photo', extension: '.jpg',
      reviewScore: 99, sharpnessScore: 200, reviewAnalysisStage: 'subjects',
      faceBoxes: [], personBoxes: [],
    };
    const eligible: MediaFile = {
      path: '/athlete.jpg', name: 'athlete.jpg', size: 1, type: 'photo', extension: '.jpg',
      reviewScore: 80, sharpnessScore: 160,
      faceDetection: 'native',
      faceBoxes: [{ x: 0.4, y: 0.15, width: 0.12, height: 0.16, score: 0.92 }],
      personBoxes: [{ x: 0.25, y: 0.08, width: 0.45, height: 0.84, score: 0.95 }],
      sceneAnalysis: { kind: 'people', confidence: 0.9, subjectFocusConfidence: 0.8 },
      reviewAnalysisStage: 'subjects',
    };
    expect(bestOfAutomaticDecision([unsafe, eligible], 'hyrox-endurance')?.path).toBe('/athlete.jpg');
  });
});
