import { describe, expect, it } from 'vitest';
import type { MediaFile } from '../../../shared/types';
import { estimateSuperSpeedRouting, needsReviewCanvasAnalysis, selectSuperSpeedProfile } from '../reviewSuperSpeed';

function photo(overrides: Partial<MediaFile> = {}): MediaFile {
  return {
    path: '/photo.jpg',
    name: 'photo.jpg',
    size: 100,
    type: 'photo',
    extension: '.jpg',
    ...overrides,
  };
}

describe('selectSuperSpeedProfile', () => {
  it('leaves unrelated standalone frames on the cheap canvas pass', () => {
    expect(selectSuperSpeedProfile(photo(), {
      eventMode: 'general', faceMatching: true, personDetection: true,
    })).toBeNull();
  });

  it('screens an unseen burst comparison with the cheap detector', () => {
    expect(selectSuperSpeedProfile(photo({ burstId: 'burst-1', burstSize: 3 }), {
      eventMode: 'general', faceMatching: true, personDetection: true,
    })).toBe('detect');
  });

  it('does not spin after bounded native-analysis retries are exhausted', () => {
    expect(selectSuperSpeedProfile(photo({ reviewAnalysisUnavailable: true }), {
      eventMode: 'general', faceMatching: true, personDetection: true,
    })).toBeNull();
  });

  it('skips people models for a screened people-free landscape', () => {
    expect(selectSuperSpeedProfile(photo({
      faceBoxes: [], faceCount: 0, reviewAnalysisStage: 'screened',
    }), {
      eventMode: 'landscape', faceMatching: true, personDetection: true,
    })).toBeNull();
  });

  it('runs one body pass before comparing face-free landscape repeats', () => {
    expect(selectSuperSpeedProfile(photo({
      faceBoxes: [], faceCount: 0, reviewAnalysisStage: 'screened',
      burstId: 'landscape-burst', burstSize: 3,
    }), {
      eventMode: 'landscape', faceMatching: true, personDetection: true,
    })).toBe('subjects');
  });

  it('does not mistake legacy estimated face boxes for a native screening pass', () => {
    expect(selectSuperSpeedProfile(photo({
      faceBoxes: [], faceCount: 0, faceDetection: 'estimated', burstId: 'burst-1', burstSize: 2,
    }), {
      eventMode: 'general', faceMatching: true, personDetection: true,
    })).toBe('detect');
  });

  it('runs subject analysis immediately for subject-critical shoots', () => {
    expect(selectSuperSpeedProfile(photo(), {
      eventMode: 'sports-combat', faceMatching: true, personDetection: true, poseAnalysis: true,
    })).toBe('subjects');
  });

  it('upgrades an old sports cache until the zero-evidence safeguards complete', () => {
    const prior = photo({
      reviewAnalysisStage: 'subjects',
      reviewAnalysisFeatures: {
        faceDetection: true,
        personDetection: true,
        faceMatching: false,
        poseAnalysis: false,
      },
      faceBoxes: [],
      personBoxes: [],
      burstId: 'hyrox-burst',
      burstSize: 4,
    });
    const options = {
      eventMode: 'hyrox-endurance' as const,
      faceMatching: true,
      personDetection: true,
      poseAnalysis: true,
    };
    expect(selectSuperSpeedProfile(prior, options)).toBe('subjects');
    expect(selectSuperSpeedProfile({
      ...prior,
      reviewAnalysisUnavailableFeatures: { sportsSafeguards: true },
    }, options)).toBeNull();
  });

  it('promotes only comparison sports subjects to the full pose/matching pass', () => {
    const analysed = photo({
      reviewAnalysisStage: 'subjects',
      reviewAnalysisFeatures: {
        faceDetection: true,
        personDetection: true,
        faceMatching: false,
        poseAnalysis: false,
        eyeDetail: true,
        sportsSafeguards: true,
      },
      faceBoxes: [{ x: 0.2, y: 0.2, width: 0.2, height: 0.2 }],
      faceCount: 1,
      personBoxes: [{ x: 0.1, y: 0.1, width: 0.4, height: 0.8 }],
      personCount: 1,
    });
    const options = {
      eventMode: 'sports-combat' as const,
      faceMatching: true,
      personDetection: true,
      poseAnalysis: true,
    };

    expect(selectSuperSpeedProfile(analysed, options)).toBeNull();
    expect(selectSuperSpeedProfile({ ...analysed, burstId: 'burst-1', burstSize: 4 }, options)).toBe('full');
  });

  it('preserves full evidence for operator-selected photos', () => {
    expect(selectSuperSpeedProfile(photo({ pick: 'selected' }), {
      eventMode: 'general', faceMatching: true, personDetection: true,
    })).toBe('full');
  });

  it('upgrades detected burst subjects to full matching', () => {
    expect(selectSuperSpeedProfile(photo({
      faceBoxes: [{ x: 0.2, y: 0.2, width: 0.2, height: 0.2 }],
      faceCount: 1,
      personBoxes: [],
      burstId: 'burst-1',
      burstSize: 4,
    }), {
      eventMode: 'general', faceMatching: true, personDetection: true,
    })).toBe('full');
  });

  it('does not spend identity matching on unrelated standalone faces', () => {
    expect(selectSuperSpeedProfile(photo({
      reviewAnalysisStage: 'subjects',
      reviewAnalysisFeatures: {
        faceDetection: true,
        personDetection: true,
        faceMatching: false,
        poseAnalysis: false,
        eyeDetail: true,
      },
      faceBoxes: [{ x: 0.2, y: 0.2, width: 0.2, height: 0.2 }],
      faceCount: 1,
      personBoxes: [],
    }), {
      eventMode: 'general', faceMatching: true, personDetection: true,
    })).toBeNull();
  });

  it('retries incomplete eye detail with subjects enrichment for a standalone native face', () => {
    const analysed = photo({
      reviewAnalysisStage: 'subjects',
      reviewAnalysisFeatures: {
        faceDetection: true,
        personDetection: true,
        faceMatching: false,
        poseAnalysis: false,
        eyeDetail: false,
      },
      faceBoxes: [{ x: 0.2, y: 0.2, width: 0.2, height: 0.2 }],
      faceCount: 1,
      personBoxes: [],
      personCount: 0,
    });
    const options = {
      eventMode: 'general' as const,
      faceMatching: true,
      personDetection: true,
    };

    expect(selectSuperSpeedProfile(analysed, options)).toBe('subjects');
    expect(selectSuperSpeedProfile({
      ...analysed,
      reviewAnalysisUnavailableFeatures: { eyeDetail: true },
    }, options)).toBeNull();
  });

  it('does not send a body-only subject result through a redundant full pass', () => {
    expect(selectSuperSpeedProfile(photo({
      reviewAnalysisStage: 'subjects',
      faceBoxes: [],
      faceCount: 0,
      personBoxes: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.7 }],
      personCount: 1,
      burstId: 'burst-1',
      burstSize: 3,
    }), {
      eventMode: 'general', faceMatching: true, personDetection: true,
    })).toBeNull();
  });

  it('does not request pose repeatedly for a face with no detected body', () => {
    expect(selectSuperSpeedProfile(photo({
      reviewAnalysisStage: 'full',
      reviewAnalysisFeatures: {
        faceDetection: true,
        personDetection: true,
        faceMatching: true,
        poseAnalysis: false,
        eyeDetail: true,
        sportsSafeguards: true,
      },
      faceBoxes: [{ x: 0.2, y: 0.2, width: 0.2, height: 0.2 }],
      faceCount: 1,
      personBoxes: [],
      personCount: 0,
      burstId: 'burst-1',
      burstSize: 3,
    }), {
      eventMode: 'sports-combat', faceMatching: true, personDetection: true, poseAnalysis: true,
    })).toBeNull();
  });

  it('leaves a screened people-unknown repeat pending when person detection is disabled', () => {
    expect(selectSuperSpeedProfile(photo({
      reviewAnalysisStage: 'screened',
      faceBoxes: [],
      faceCount: 0,
      burstId: 'burst-1',
      burstSize: 3,
    }), {
      eventMode: 'general', faceMatching: false, personDetection: false,
    })).toBeNull();
  });

  it('never downgrades an explicitly completed full pass', () => {
    expect(selectSuperSpeedProfile(photo({
      reviewAnalysisStage: 'full',
      faceBoxes: [{ x: 0.2, y: 0.2, width: 0.2, height: 0.2 }],
      faceCount: 1,
      personBoxes: [],
      reviewAnalysisFeatures: {
        faceDetection: true,
        personDetection: true,
        faceMatching: true,
        poseAnalysis: false,
        eyeDetail: true,
      },
      burstId: 'burst-1',
      burstSize: 3,
    }), {
      eventMode: 'general', faceMatching: true, personDetection: true,
    })).toBeNull();
  });

  it('reruns full when a newly enabled feature was absent from the old full pass', () => {
    expect(selectSuperSpeedProfile(photo({
      reviewAnalysisStage: 'full',
      reviewAnalysisFeatures: {
        faceDetection: true,
        personDetection: true,
        faceMatching: false,
        poseAnalysis: false,
        sportsSafeguards: true,
      },
      faceBoxes: [{ x: 0.2, y: 0.2, width: 0.2, height: 0.2 }],
      faceCount: 1,
      personBoxes: [],
      burstId: 'burst-1',
      burstSize: 3,
    }), {
      eventMode: 'general', faceMatching: true, personDetection: true,
    })).toBe('full');
  });

  it('does not spin after an optional full-analysis feature exhausts retries', () => {
    expect(selectSuperSpeedProfile(photo({
      reviewAnalysisStage: 'full',
      reviewAnalysisFeatures: {
        faceDetection: true,
        personDetection: true,
        faceMatching: false,
        poseAnalysis: false,
      },
      reviewAnalysisUnavailableFeatures: {
        faceMatching: true,
        poseAnalysis: true,
        eyeDetail: true,
        sportsSafeguards: true,
      },
      faceBoxes: [{ x: 0.2, y: 0.2, width: 0.2, height: 0.2 }],
      faceCount: 1,
      personBoxes: [{ x: 0.1, y: 0.1, width: 0.4, height: 0.8 }],
      personCount: 1,
      burstId: 'burst-1',
      burstSize: 3,
    }), {
      eventMode: 'sports-combat', faceMatching: true, personDetection: true, poseAnalysis: true,
    })).toBeNull();
  });

  it('estimates the expensive-stage fraction from synthetic routing metadata', () => {
    const synthetic = [
      ...Array.from({ length: 600 }, (_, index) => photo({
        path: `/screened-${index}.jpg`,
        reviewAnalysisStage: 'screened',
        faceBoxes: [],
        faceCount: 0,
      })),
      ...Array.from({ length: 100 }, (_, index) => photo({ path: `/standalone-${index}.jpg` })),
      ...Array.from({ length: 150 }, (_, index) => photo({
        path: `/face-${index}.jpg`,
        reviewAnalysisStage: 'screened',
        faceBoxes: [{ x: 0.2, y: 0.2, width: 0.2, height: 0.2 }],
        faceCount: 1,
      })),
      ...Array.from({ length: 100 }, (_, index) => photo({
        path: `/repeat-empty-${index}.jpg`,
        reviewAnalysisStage: 'screened',
        faceBoxes: [],
        faceCount: 0,
        burstId: `empty-${index}`,
        burstSize: 2,
      })),
      ...Array.from({ length: 50 }, (_, index) => photo({
        path: `/repeat-face-${index}.jpg`,
        reviewAnalysisStage: 'screened',
        faceBoxes: [{ x: 0.2, y: 0.2, width: 0.2, height: 0.2 }],
        faceCount: 1,
        burstId: `face-${index}`,
        burstSize: 2,
      })),
    ];

    expect(estimateSuperSpeedRouting(synthetic, {
      eventMode: 'general', faceMatching: true, personDetection: true,
    })).toEqual({
      photos: 1_000,
      skipped: 700,
      detect: 0,
      subjects: 250,
      full: 50,
      expensiveFraction: 0.3,
      fullFraction: 0.05,
    });
  });
});

describe('needsReviewCanvasAnalysis', () => {
  const options = {
    fastKeeperMode: false,
    faceAnalysis: true,
    visualDuplicates: true,
    superSpeedMode: true,
  };

  it('finishes a screened people-free frame without inventing a subject score', () => {
    expect(needsReviewCanvasAnalysis(photo({
      thumbnail: 'keptra-preview://thumb/scene',
      sharpnessScore: 80,
      visualHash: '0000000000000000',
      sceneAnalysis: { kind: 'landscape', confidence: 0.9 },
      reviewAnalysisStage: 'screened',
      faceBoxes: [],
    }), options)).toBe(false);
  });

  it('finishes a canvas-only standalone frame without requiring a native stage', () => {
    expect(needsReviewCanvasAnalysis(photo({
      thumbnail: 'keptra-preview://thumb/standalone',
      sharpnessScore: 80,
      visualHash: '0000000000000000',
      sceneAnalysis: { kind: 'general', confidence: 0.8 },
    }), options)).toBe(false);
  });

  it('requires scene ROI confidence after detecting a subject', () => {
    expect(needsReviewCanvasAnalysis(photo({
      thumbnail: 'keptra-preview://thumb/person',
      sharpnessScore: 80,
      visualHash: '0000000000000000',
      sceneAnalysis: { kind: 'people', confidence: 0.9 },
      reviewAnalysisStage: 'subjects',
      faceBoxes: [{ x: 0.2, y: 0.2, width: 0.2, height: 0.2 }],
    }), options)).toBe(true);
  });

  it('keeps legacy full review waiting for its subject sharpness score', () => {
    expect(needsReviewCanvasAnalysis(photo({
      thumbnail: 'keptra-preview://thumb/legacy',
      sharpnessScore: 80,
      visualHash: '0000000000000000',
      sceneAnalysis: { kind: 'general', confidence: 0.2 },
      faceBoxes: [],
    }), { ...options, superSpeedMode: false })).toBe(true);
  });

  it('does not hot-loop a frame whose bounded analysis failed', () => {
    expect(needsReviewCanvasAnalysis(photo({
      thumbnail: 'keptra-preview://thumb/failure',
      reviewAnalysisUnavailable: true,
    }), options)).toBe(false);
  });
});
