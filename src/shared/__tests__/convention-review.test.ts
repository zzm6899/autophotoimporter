import { afterEach, describe, expect, it } from 'vitest';
import {
  autoCullGroup,
  bestShotScore,
  buildAutoCullProposal,
  configureReviewProfile,
  conventionQualityBreakdown,
  inferSceneBucket,
  isAutoCullBulkDecisionEligible,
  isAutoCullProposalEligible,
} from '../review';
import {
  EVENT_MODE_PRESETS,
  isConventionEventMode,
  isPeopleFirstEventMode,
  suggestEventModeFromCues,
  type MediaFile,
} from '../types';

function file(path: string, overrides: Partial<MediaFile> = {}): MediaFile {
  return {
    path,
    name: path.split('/').pop() ?? path,
    size: 1,
    type: 'photo',
    extension: '.jpg',
    ...overrides,
  };
}

function analysedSubject(overrides: Partial<MediaFile> = {}): MediaFile {
  return file('/cosplayer.jpg', {
    reviewAnalysisStage: 'subjects',
    reviewScore: 82,
    sharpnessScore: 132,
    blurRisk: 'low',
    personCount: 1,
    personBoxes: [{ x: 0.29, y: 0.04, width: 0.4, height: 0.92, score: 0.96 }],
    faceCount: 1,
    faceDetection: 'native',
    faceBoxes: [{
      x: 0.43, y: 0.09, width: 0.13, height: 0.15, score: 0.97,
      eyeScore: 2, eyeSharpness: 0.92, expressionScore: 0.86,
    }],
    sceneAnalysis: {
      kind: 'people', confidence: 0.92,
      subjectSharpnessScore: 150, subjectFocusConfidence: 0.94,
      subjectFocusCoverage: 0.9, subjectArea: 0.37,
    },
    ...overrides,
  });
}

afterEach(() => configureReviewProfile('general'));

describe('anime convention / cosplay profile discovery', () => {
  it('keeps the stable cosplay EventMode and exposes convention semantics', () => {
    expect(isConventionEventMode('cosplay')).toBe(true);
    expect(isPeopleFirstEventMode('stage')).toBe(true);
    expect(isPeopleFirstEventMode('candids')).toBe(true);
    expect(isPeopleFirstEventMode('vendor-booth')).toBe(true);
    expect(isPeopleFirstEventMode('crowd')).toBe(true);
    expect(isPeopleFirstEventMode('panels')).toBe(true);
    expect(isPeopleFirstEventMode('meetups')).toBe(true);
    expect(isConventionEventMode('stage')).toBe(false);
    expect(isConventionEventMode('general')).toBe(false);
    expect(EVENT_MODE_PRESETS.cosplay.label).toContain('Anime convention');
    expect(EVENT_MODE_PRESETS.cosplay.help).toMatch(/Animaga.*SMASH/i);
  });

  it('suggests Animaga and SMASH folders without matching unrelated lowercase smash text', () => {
    expect(suggestEventModeFromCues('D:/Events/Animaga Melbourne 2026')).toMatchObject({
      mode: 'cosplay', genre: 'portrait', confidence: 'high',
    });
    expect(suggestEventModeFromCues('D:/Events/SMASH 2026/Day 1')).toMatchObject({
      mode: 'cosplay', genre: 'portrait', confidence: 'high',
    });
    expect(suggestEventModeFromCues('D:/Events/cosplay convention portraits')).toMatchObject({
      mode: 'cosplay', confidence: 'medium',
    });
    expect(suggestEventModeFromCues('D:/Food/smash burger product photos')).toBeNull();
  });
});

describe('convention keeper quality', () => {
  it('rewards a sharp complete primary cosplayer with clear face, eyes and expression', () => {
    const clear = analysedSubject();
    const crowded = analysedSubject({
      path: '/crowded.jpg', name: 'crowded.jpg',
      sharpnessScore: 90,
      faceBoxes: [{
        x: 0.43, y: 0.09, width: 0.13, height: 0.15, score: 0.9,
        eyeScore: 1, eyeSharpness: 0.4, expressionScore: 0.35,
      }],
      personCount: 8,
      personBoxes: Array.from({ length: 8 }, (_, index) => ({
        x: 0.23 + index * 0.025, y: 0.07, width: 0.4, height: 0.86,
        score: 0.92 - index * 0.01,
      })),
      sceneAnalysis: {
        kind: 'people', confidence: 0.9,
        subjectSharpnessScore: 62, subjectFocusConfidence: 0.9,
      },
    });

    const strong = conventionQualityBreakdown(clear);
    const weak = conventionQualityBreakdown(crowded);
    expect(strong.reasons).toContain('clear primary cosplayer');
    expect(strong.reasons).toContain('clear face and eye detail');
    expect(strong.reasons).toContain('sharp costume and prop detail');
    expect(strong.score).toBeGreaterThan(weak.score);

    configureReviewProfile('cosplay');
    expect(bestShotScore(clear)).toBeGreaterThan(bestShotScore(crowded));
  });

  it('keeps group completeness meaningful and labels convention review lanes', () => {
    const group = analysedSubject({
      faceCount: 3,
      personCount: 3,
      faceBoxes: [
        { x: 0.19, y: 0.12, width: 0.1, height: 0.12, score: 0.95, eyeScore: 2 },
        { x: 0.45, y: 0.1, width: 0.1, height: 0.12, score: 0.96, eyeScore: 2 },
        { x: 0.7, y: 0.12, width: 0.1, height: 0.12, score: 0.94, eyeScore: 2 },
      ],
      personBoxes: [
        { x: 0.1, y: 0.08, width: 0.24, height: 0.86, score: 0.94 },
        { x: 0.37, y: 0.06, width: 0.24, height: 0.88, score: 0.96 },
        { x: 0.63, y: 0.08, width: 0.24, height: 0.86, score: 0.93 },
      ],
    });
    expect(conventionQualityBreakdown(group).groupCompleteness).toBeGreaterThan(0.65);
    expect(inferSceneBucket(group, 'cosplay')).toBe('Cosplay groups');
    expect(inferSceneBucket(analysedSubject(), 'cosplay')).toBe('Cosplay portraits');
  });

  it('treats missing face/pose evidence as neutral rather than known-bad', () => {
    const bodyOnly = analysedSubject({ faceCount: 0, faceBoxes: [], poses: undefined });
    const result = conventionQualityBreakdown(bodyOnly);
    expect(result.faceAndEyes).toBe(0.5);
    expect(result.expressionAndPose).toBe(0.5);
    expect(result.cautions).not.toContain('unclear eye detail');

    const detectorZero = conventionQualityBreakdown(file('/unknown.jpg', { sharpnessScore: 110 }));
    expect(detectorZero.primarySubject).toBe(0.5);
    expect(detectorZero.costumeSharpness).toBe(0.5);
    expect(detectorZero.score).toBe(97);
    expect(detectorZero.cautions).toContain('no reliable cosplayer evidence — manual review');
  });
});

describe('convention bulk decision safety', () => {
  it('never turns detector-zero into an automatic reject', () => {
    const detected = analysedSubject({ burstId: 'cosplay-burst', burstSize: 2 });
    const detectorZero = file('/detector-zero.jpg', {
      burstId: 'cosplay-burst', burstSize: 2,
      reviewAnalysisStage: 'subjects', reviewScore: 24, sharpnessScore: 70,
      faceCount: 0, faceBoxes: [], personCount: 0, personBoxes: [], poses: [],
    });

    expect(isAutoCullBulkDecisionEligible(detectorZero, 'cosplay')).toBe(false);
    expect(isAutoCullProposalEligible(detectorZero, 'cosplay')).toBe(false);
    expect(isAutoCullBulkDecisionEligible(detected, 'cosplay')).toBe(true);
    expect(autoCullGroup([detected, detectorZero], {
      eventMode: 'cosplay', confidence: 'aggressive',
    }).reject).not.toContain(detectorZero.path);

    const proposal = buildAutoCullProposal([detected, detectorZero], {
      eventMode: 'cosplay', confidence: 'aggressive',
    });
    expect(proposal.reject).not.toContain(detectorZero.path);
    expect(proposal.uncertain).toContain(detectorZero.path);
    expect(proposal.uncertain).toContain(detected.path);
  });

  it.each(['stage', 'candids', 'vendor-booth', 'crowd', 'panels', 'meetups'] as const)(
    'keeps detector-zero %s convention coverage manual',
    (eventMode) => {
      const detectorZero = file(`/detector-zero-${eventMode}.jpg`, {
        reviewAnalysisStage: 'subjects', reviewScore: 24, sharpnessScore: 70,
        faceCount: 0, faceBoxes: [], personCount: 0, personBoxes: [], poses: [],
      });
      expect(isAutoCullProposalEligible(detectorZero, eventMode)).toBe(false);
      expect(isAutoCullBulkDecisionEligible(detectorZero, eventMode)).toBe(false);
    },
  );

  it('holds tiny weak person proposals for review instead of trusting a likely prop/background match', () => {
    const weakProposal = file('/weak-person-proposal.jpg', {
      reviewAnalysisStage: 'subjects', reviewScore: 45, sharpnessScore: 95,
      personCount: 1,
      personBoxes: [{ x: 0.03, y: 0.04, width: 0.03, height: 0.08, score: 0.34 }],
      sceneAnalysis: {
        kind: 'people', confidence: 0.48,
        subjectSharpnessScore: 80, subjectFocusConfidence: 0.65,
      },
    });
    expect(isAutoCullProposalEligible(weakProposal, 'cosplay')).toBe(false);
    expect(isAutoCullBulkDecisionEligible(weakProposal, 'cosplay')).toBe(false);
  });

  it('keeps an uncorroborated fast person proposal manual even when its box is large', () => {
    const costumeStand = file('/costume-stand.jpg', {
      reviewAnalysisStage: 'subjects', reviewScore: 88, sharpnessScore: 140,
      personCount: 1,
      personBoxes: [{ x: 0.25, y: 0.05, width: 0.48, height: 0.9, score: 0.91 }],
      reviewAnalysisFeatures: {
        faceDetection: true, personDetection: true, faceMatching: false, poseAnalysis: false,
        fastFaceDetection: true, fastPersonDetection: true,
        personDetectorId: 'nanodet-2022nov-fp32',
      },
      sceneAnalysis: {
        kind: 'people', confidence: 0.82,
        subjectSharpnessScore: 145, subjectFocusConfidence: 0.9,
      },
    });
    expect(isAutoCullProposalEligible(costumeStand, 'cosplay')).toBe(false);
    expect(isAutoCullBulkDecisionEligible(costumeStand, 'cosplay')).toBe(false);
  });

  it('does not treat merely executing an empty SSD fallback as corroboration', () => {
    const fastOnly = analysedSubject({
      faceCount: 0,
      faceBoxes: [],
      reviewAnalysisFeatures: {
        faceDetection: true,
        personDetection: true,
        faceMatching: false,
        poseAnalysis: false,
        fastPersonDetection: true,
        personFallbackExecuted: true,
        personFallbackCorroborated: false,
        // Even a stale suffix cannot override the explicit evidence marker.
        personDetectorId: 'nanodet-2022nov-fp32+ssd-fallback',
      },
    });
    expect(isAutoCullProposalEligible(fastOnly, 'cosplay')).toBe(false);

    const corroborated = {
      ...fastOnly,
      reviewAnalysisFeatures: {
        ...fastOnly.reviewAnalysisFeatures!,
        personFallbackCorroborated: true,
      },
    };
    expect(isAutoCullProposalEligible(corroborated, 'cosplay')).toBe(true);
  });
});
