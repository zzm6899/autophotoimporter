import { afterEach, describe, expect, it } from 'vitest';
import {
  assessSubjectPresence,
  autoCullGroup,
  buildAutoCullProposal,
  configureReviewProfile,
  enduranceActionBreakdown,
  enduranceActionQuality,
  frameEnduranceExtension,
  inferSceneBucket,
  isAutoCullBulkDecisionEligible,
  isUsablePose,
  scoreReview,
  sportsActionQuality,
} from '../review';
import {
  COCO_KP,
  EVENT_MODE_PRESETS,
  isSportsEventMode,
  suggestEventModeFromCues,
  type MediaFile,
  type PoseKeypoint,
  type PoseKeypoints,
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

function pose(overrides: Partial<Record<number, [number, number, number?]>> = {}): PoseKeypoints {
  const keypoints: PoseKeypoint[] = Array.from({ length: 17 }, () => ({ x: 0.5, y: 0.5, score: 0.9 }));
  for (const [index, value] of Object.entries(overrides)) {
    if (!value) continue;
    keypoints[Number(index)] = { x: value[0], y: value[1], score: value[2] ?? 0.9 };
  }
  return { keypoints };
}

const runningPose = pose({
  [COCO_KP.leftShoulder]: [0.46, 0.25],
  [COCO_KP.rightShoulder]: [0.54, 0.25],
  [COCO_KP.leftHip]: [0.47, 0.5],
  [COCO_KP.rightHip]: [0.53, 0.5],
  [COCO_KP.leftKnee]: [0.38, 0.66],
  [COCO_KP.leftAnkle]: [0.26, 0.79],
  [COCO_KP.rightKnee]: [0.58, 0.61],
  [COCO_KP.rightAnkle]: [0.7, 0.7],
  [COCO_KP.leftWrist]: [0.65, 0.34],
  [COCO_KP.rightWrist]: [0.34, 0.38],
});

afterEach(() => configureReviewProfile('general'));

describe('HYROX review profile discovery', () => {
  it('exposes a dedicated endurance preset and sports mode', () => {
    expect(EVENT_MODE_PRESETS['hyrox-endurance'].label).toContain('HYROX');
    expect(EVENT_MODE_PRESETS['hyrox-endurance'].description).not.toMatch(/peak kicks|sparring contact|poomsae/i);
    expect(isSportsEventMode('hyrox-endurance')).toBe(true);
  });

  it('suggests HYROX from distinctive folder/event cues without auto-applying generic running', () => {
    expect(suggestEventModeFromCues('D:/Photos/HYROX Demo Event')).toMatchObject({
      mode: 'hyrox-endurance',
      genre: 'sports',
      confidence: 'high',
    });
    expect(suggestEventModeFromCues(['Saturday', 'sled push', 'wall ball'])).toMatchObject({
      mode: 'hyrox-endurance',
      confidence: 'high',
    });
    expect(suggestEventModeFromCues('Sunday running portraits')).toBeNull();
  });
});

describe('HYROX athlete/action quality', () => {
  const clearAthlete = file('/station-clear.jpg', {
    sharpnessScore: 145,
    subjectSharpnessScore: 150,
    blurRisk: 'low',
    personCount: 1,
    personBoxes: [{ x: 0.31, y: 0.08, width: 0.34, height: 0.86, score: 0.95 }],
    faceCount: 1,
    faceDetection: 'native',
    faceBoxes: [{ x: 0.43, y: 0.12, width: 0.1, height: 0.12, score: 0.96, eyeScore: 2, expressionScore: 0.82 }],
    poses: [runningPose],
    enduranceSportsAnalysis: {
      station: 'sled-push',
      confidence: 0.92,
      equipmentInteraction: 0.9,
      actionPhase: 0.86,
      subjectIsolation: 0.9,
      occlusion: 0.06,
    },
  });

  it('derives pose usability from valid keypoints when aggregate score is zero', () => {
    expect(isUsablePose({ ...runningPose, score: 0 })).toBe(true);
    expect(isUsablePose({ keypoints: [], score: 0 })).toBe(false);
  });

  it('rewards sharp primary athletes, readable faces, equipment interaction and action phase', () => {
    const flat = file('/station-flat.jpg', {
      sharpnessScore: 82,
      subjectSharpnessScore: 58,
      blurRisk: 'medium',
      personCount: 1,
      personBoxes: [{ x: 0.31, y: 0.08, width: 0.34, height: 0.86, score: 0.9 }],
      enduranceSportsAnalysis: {
        station: 'sled-push',
        confidence: 0.8,
        equipmentInteraction: 0.2,
        actionPhase: 0.18,
        subjectIsolation: 0.7,
        occlusion: 0.2,
      },
    });

    const breakdown = enduranceActionBreakdown(clearAthlete);
    expect(breakdown.torsoFocus).toBeGreaterThan(0.65);
    expect(breakdown.faceVisibility).toBeGreaterThan(0.55);
    expect(breakdown.reasons).toContain('clear station/equipment interaction');
    expect(enduranceActionQuality(clearAthlete)).toBeGreaterThan(enduranceActionQuality(flat));
  });

  it('does not use combat-contact overlap as a HYROX reward', () => {
    const common: Partial<MediaFile> = {
      sharpnessScore: 120,
      subjectSharpnessScore: 120,
      blurRisk: 'low',
      enduranceSportsAnalysis: {
        confidence: 0.85,
        primarySubjectConfidence: 0.8,
        subjectIsolation: 0.7,
        occlusion: 0.15,
        equipmentInteraction: 0.5,
        strideExtension: 0.5,
        actionPhase: 0.5,
      },
    };
    const overlapping = file('/overlap.jpg', {
      ...common,
      personCount: 2,
      personBoxes: [
        { x: 0.3, y: 0.12, width: 0.28, height: 0.78, score: 0.94 },
        { x: 0.42, y: 0.14, width: 0.28, height: 0.76, score: 0.93 },
      ],
    });
    const apart = file('/apart.jpg', {
      ...common,
      personCount: 2,
      personBoxes: [
        { x: 0.08, y: 0.12, width: 0.28, height: 0.78, score: 0.94 },
        { x: 0.65, y: 0.14, width: 0.28, height: 0.76, score: 0.93 },
      ],
    });

    configureReviewProfile('hyrox-endurance');
    expect(sportsActionQuality(overlapping)).toBe(sportsActionQuality(apart));
  });

  it('penalises crowd occlusion while retaining a clear primary athlete', () => {
    const crowded = file('/crowded.jpg', {
      ...clearAthlete,
      path: '/crowded.jpg',
      name: 'crowded.jpg',
      enduranceSportsAnalysis: undefined,
      personCount: 7,
      personBoxes: Array.from({ length: 7 }, (_, index) => ({
        x: 0.25 + index * 0.025,
        y: 0.09,
        width: 0.3,
        height: 0.82,
        score: 0.92 - index * 0.01,
      })),
    });
    const clear = enduranceActionBreakdown({ ...clearAthlete, enduranceSportsAnalysis: undefined });
    const crowd = enduranceActionBreakdown(crowded);
    expect(clear.isolation).toBeGreaterThan(crowd.isolation);
    expect(clear.occlusion).toBeLessThan(crowd.occlusion);
    expect(clear.score).toBeGreaterThan(crowd.score);
  });

  it('does not borrow a secondary athlete pose when the primary pose is unavailable', () => {
    const frame = {
      ...clearAthlete,
      personBoxes: [
        { x: 0.3, y: 0.08, width: 0.36, height: 0.86, score: 0.99 },
        { x: 0.72, y: 0.18, width: 0.16, height: 0.62, score: 0.78 },
      ],
      poses: [{ keypoints: [], score: 0 }, runningPose],
    };
    expect(frameEnduranceExtension(frame, 0)).toBe(0);
  });

  it('uses station-specific scene buckets', () => {
    expect(inferSceneBucket(clearAthlete, 'hyrox-endurance')).toBe('Sled push');
  });

  it('is orientation-agnostic for already-normalized portrait records', () => {
    const base = { ...clearAthlete, orientation: 1 };
    const rotatedSix = { ...clearAthlete, orientation: 6 };
    const rotatedEight = { ...clearAthlete, orientation: 8 };
    expect(enduranceActionQuality(rotatedSix)).toBe(enduranceActionQuality(base));
    expect(enduranceActionQuality(rotatedEight)).toBe(enduranceActionQuality(base));
  });
});

describe('face/body detector disagreement safety', () => {
  it('keeps a face-only person miss people-present and marks its torso ROI inferred', () => {
    const faceOnly = file('/face-only.jpg', {
      faceCount: 1,
      faceDetection: 'native',
      faceBoxes: [{ x: 0.4, y: 0.12, width: 0.12, height: 0.14, score: 0.96, eyeScore: 2 }],
      personCount: 0,
      personBoxes: [],
    });
    const presence = assessSubjectPresence(faceOnly);
    expect(presence).toMatchObject({
      hasPeople: true,
      confidence: 'probable',
      bodySource: 'face-inferred',
    });
    expect(presence.inferredBodyRoi?.inferred).toBe(true);
    expect(inferSceneBucket(faceOnly, 'hyrox-endurance')).toBe('Athlete · body detection review');
  });

  it('does not auto-reject a credible face-only frame merely because its body was missed', () => {
    const best = file('/body.jpg', {
      sharpnessScore: 130,
      subjectSharpnessScore: 125,
      blurRisk: 'low',
      personCount: 1,
      personBoxes: [{ x: 0.3, y: 0.08, width: 0.35, height: 0.86, score: 0.95 }],
      faceCount: 1,
      faceBoxes: [{ x: 0.42, y: 0.12, width: 0.12, height: 0.14, score: 0.96, eyeScore: 2 }],
    });
    const bodyMiss = file('/body-miss.jpg', {
      sharpnessScore: 128,
      subjectSharpnessScore: 124,
      blurRisk: 'low',
      personCount: 0,
      personBoxes: [],
      faceCount: 1,
      faceBoxes: [{ x: 0.42, y: 0.12, width: 0.12, height: 0.14, score: 0.95, eyeScore: 2 }],
    });
    const decision = autoCullGroup([best, bodyMiss], {
      eventMode: 'hyrox-endurance',
      confidence: 'aggressive',
    });
    expect(decision.reject).not.toContain(bodyMiss.path);
  });

  it('holds a weak tiny face for review and never turns its eyeScore into a blink rejection', () => {
    const weak = file('/weak-face.jpg', {
      burstId: 'burst-1', burstSize: 2,
      reviewAnalysisStage: 'subjects',
      reviewScore: 58,
      sharpnessScore: 105,
      faceCount: 1,
      faceDetection: 'estimated',
      faceBoxes: [{ x: 0.07, y: 0.08, width: 0.035, height: 0.04, score: 0.38, eyeScore: 0 }],
      personCount: 0,
      personBoxes: [],
      sceneAnalysis: {
        kind: 'people', confidence: 0.58,
        subjectSharpnessScore: 80, subjectFocusConfidence: 0.75,
      },
    });
    const strong = file('/strong-athlete.jpg', {
      burstId: 'burst-1', burstSize: 2,
      reviewAnalysisStage: 'subjects',
      reviewScore: 88,
      sharpnessScore: 155,
      personCount: 1,
      personBoxes: [{ x: 0.3, y: 0.08, width: 0.34, height: 0.86, score: 0.96 }],
      sceneAnalysis: {
        kind: 'people', confidence: 0.9,
        subjectSharpnessScore: 145, subjectFocusConfidence: 0.9,
      },
    });

    const review = scoreReview(weak);
    expect(review.reasons).not.toContain('strong eye detail');
    expect(review.reasons).not.toContain('usable eye detail');
    const proposal = buildAutoCullProposal([strong, weak], {
      eventMode: 'hyrox-endurance',
      confidence: 'aggressive',
    });
    expect(proposal.reject).not.toContain(weak.path);
    expect(proposal.uncertain).toContain(weak.path);
    expect(proposal.reasons[weak.path]).toContain('weak/tiny face evidence cannot support an automatic decision');
  });

  it('keeps a complete sports detector miss manual against a detected burst peer', () => {
    const detected = file('/detected-athlete.jpg', {
      burstId: 'sports-miss', burstSize: 2,
      reviewAnalysisStage: 'subjects',
      reviewAnalysisFeatures: {
        faceDetection: true, personDetection: true, faceMatching: false,
        poseAnalysis: false, sportsSafeguards: true,
      },
      reviewScore: 92,
      sharpnessScore: 160,
      subjectSharpnessScore: 150,
      personCount: 1,
      personBoxes: [{ x: 0.3, y: 0.07, width: 0.36, height: 0.88, score: 0.96 }],
      sceneAnalysis: {
        kind: 'people', confidence: 0.9,
        subjectSharpnessScore: 150, subjectFocusConfidence: 0.92,
      },
    });
    const completeMiss = file('/detector-zero.jpg', {
      burstId: 'sports-miss', burstSize: 2,
      reviewAnalysisStage: 'subjects',
      reviewAnalysisFeatures: {
        faceDetection: true, personDetection: true, faceMatching: false,
        poseAnalysis: false, sportsSafeguards: true,
      },
      reviewScore: 35,
      sharpnessScore: 82,
      faceCount: 0,
      faceBoxes: [],
      personCount: 0,
      personBoxes: [],
    });

    const proposal = buildAutoCullProposal([detected, completeMiss], {
      eventMode: 'hyrox-endurance',
      confidence: 'aggressive',
    });
    expect(proposal.reject).not.toContain(completeMiss.path);
    expect(proposal.uncertain).toContain(completeMiss.path);
    expect(proposal.uncertain).toContain(detected.path);
    expect(proposal.reasons[detected.path]).toContain('comparison group is still being analysed');

    const directDecision = autoCullGroup([detected, completeMiss], {
      eventMode: 'hyrox-endurance',
      confidence: 'aggressive',
    });
    expect(directDecision.reject).not.toContain(completeMiss.path);
  });

  it('keeps safeguarded detector-zero frames out of Cull-to-N and group-best decision eligibility', () => {
    const detectorZero = file('/manual-detector-zero.jpg', {
      burstId: 'bulk-safety', burstSize: 2,
      reviewAnalysisStage: 'subjects',
      reviewAnalysisFeatures: {
        faceDetection: true, personDetection: true, faceMatching: false,
        poseAnalysis: false, sportsSafeguards: true,
      },
      reviewScore: 28,
      sharpnessScore: 72,
      faceCount: 0,
      faceBoxes: [],
      personCount: 0,
      personBoxes: [],
      poses: [],
    });
    const detected = file('/decision-ready-athlete.jpg', {
      burstId: 'bulk-safety', burstSize: 2,
      reviewAnalysisStage: 'subjects',
      reviewScore: 90,
      personCount: 1,
      personBoxes: [{ x: 0.25, y: 0.05, width: 0.4, height: 0.9, score: 0.96 }],
      sceneAnalysis: {
        kind: 'people', confidence: 0.9,
        subjectSharpnessScore: 145, subjectFocusConfidence: 0.9,
      },
    });

    expect(isAutoCullBulkDecisionEligible(detectorZero, 'hyrox-endurance')).toBe(false);
    expect(isAutoCullBulkDecisionEligible(detected, 'hyrox-endurance')).toBe(true);
    // The same detector-zero record may be ranked in a non-subject-critical
    // batch; the manual hold is deliberately tied to sports event context.
    expect(isAutoCullBulkDecisionEligible(detectorZero, 'general')).toBe(true);

    const decisionReady = [detected, detectorZero]
      .filter((candidate) => isAutoCullBulkDecisionEligible(candidate, 'hyrox-endurance'));
    expect(decisionReady.map((candidate) => candidate.path)).toEqual([detected.path]);
  });
});
