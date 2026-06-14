import { afterEach, describe, expect, it } from 'vitest';
import {
  athleteContactSignal,
  bestShotScore,
  configureReviewProfile,
  emotionSignal,
  frameKickStraightness,
  frozenActionSignal,
  getReviewProfile,
  inferSceneBucket,
  kickStraightness,
  poseContactSignal,
  selectKeepersToTarget,
  sportsActionQuality,
} from '../review';
import type { MediaFile, PoseKeypoint, PoseKeypoints } from '../types';
import { COCO_KP, isSportsEventMode } from '../types';

// Build a full 17-keypoint pose with all points confident at origin, then let
// callers override specific joints. Keeps tests focused on the geometry.
function pose(overrides: Partial<Record<number, [number, number, number?]>> = {}): PoseKeypoints {
  const keypoints: PoseKeypoint[] = Array.from({ length: 17 }, () => ({ x: 0.5, y: 0.5, score: 0.9 }));
  for (const [idx, val] of Object.entries(overrides)) {
    if (!val) continue;
    const [x, y, s] = val;
    keypoints[Number(idx)] = { x, y, score: s ?? 0.9 };
  }
  return { keypoints };
}

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

// Always restore the default profile so other suites are unaffected by the
// module-level scoring profile.
afterEach(() => configureReviewProfile('general'));

describe('sports event mode flag', () => {
  it('identifies sports modes', () => {
    expect(isSportsEventMode('taekwondo')).toBe(true);
    expect(isSportsEventMode('sports-combat')).toBe(true);
    expect(isSportsEventMode('general')).toBe(false);
    expect(isSportsEventMode(undefined)).toBe(false);
  });
});

describe('athleteContactSignal', () => {
  it('is zero with fewer than two athletes', () => {
    expect(athleteContactSignal({ personBoxes: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.5 }] })).toBe(0);
    expect(athleteContactSignal({ personBoxes: [] })).toBe(0);
  });

  it('rewards two overlapping same-scale athletes (contact)', () => {
    const contact = athleteContactSignal({
      personBoxes: [
        { x: 0.30, y: 0.20, width: 0.22, height: 0.55 },
        { x: 0.44, y: 0.22, width: 0.22, height: 0.55 },
      ],
    });
    expect(contact).toBeGreaterThan(0.3);
  });

  it('scores two far-apart athletes lower than engaged ones', () => {
    const apart = athleteContactSignal({
      personBoxes: [
        { x: 0.02, y: 0.2, width: 0.18, height: 0.5 },
        { x: 0.80, y: 0.2, width: 0.18, height: 0.5 },
      ],
    });
    const engaged = athleteContactSignal({
      personBoxes: [
        { x: 0.30, y: 0.20, width: 0.22, height: 0.55 },
        { x: 0.45, y: 0.22, width: 0.22, height: 0.55 },
      ],
    });
    expect(engaged).toBeGreaterThan(apart);
  });
});

describe('frozenActionSignal', () => {
  it('rewards a sharp subject against a softer frame', () => {
    const frozen = frozenActionSignal({ subjectSharpnessScore: 180, sharpnessScore: 70, blurRisk: 'low' });
    const flat = frozenActionSignal({ subjectSharpnessScore: 40, sharpnessScore: 40, blurRisk: 'low' });
    expect(frozen).toBeGreaterThan(flat);
  });

  it('is zero for high blur risk', () => {
    expect(frozenActionSignal({ subjectSharpnessScore: 200, sharpnessScore: 50, blurRisk: 'high' })).toBe(0);
  });
});

describe('emotionSignal', () => {
  it('returns the strongest expression among faces', () => {
    const value = emotionSignal({
      faceBoxes: [
        { x: 0, y: 0, width: 0.1, height: 0.1, expressionScore: 0.3 },
        { x: 0.2, y: 0, width: 0.1, height: 0.1, smileScore: 0.9 },
      ],
    });
    expect(value).toBeCloseTo(0.9, 5);
  });
});

describe('sportsActionQuality', () => {
  it('penalises empty scenery frames', () => {
    expect(sportsActionQuality(file('/empty.jpg'))).toBeLessThan(0);
  });

  it('ranks a contact+frozen+emotive athlete frame above a flat one', () => {
    const peak = file('/kick.jpg', {
      subjectSharpnessScore: 190,
      sharpnessScore: 80,
      blurRisk: 'low',
      personCount: 2,
      personBoxes: [
        { x: 0.30, y: 0.18, width: 0.22, height: 0.6 },
        { x: 0.45, y: 0.20, width: 0.22, height: 0.6 },
      ],
      faceCount: 2,
      faceBoxes: [
        { x: 0.33, y: 0.20, width: 0.06, height: 0.08, eyeScore: 2, expressionScore: 0.85, score: 0.9 },
        { x: 0.50, y: 0.22, width: 0.06, height: 0.08, eyeScore: 2, expressionScore: 0.7, score: 0.9 },
      ],
    });
    const flat = file('/standing.jpg', {
      subjectSharpnessScore: 55,
      sharpnessScore: 55,
      blurRisk: 'low',
      personCount: 2,
      personBoxes: [
        { x: 0.05, y: 0.2, width: 0.18, height: 0.55 },
        { x: 0.78, y: 0.2, width: 0.18, height: 0.55 },
      ],
      faceCount: 2,
      faceBoxes: [
        { x: 0.08, y: 0.22, width: 0.05, height: 0.07, eyeScore: 1, expressionScore: 0.4, score: 0.8 },
        { x: 0.80, y: 0.22, width: 0.05, height: 0.07, eyeScore: 1, expressionScore: 0.4, score: 0.8 },
      ],
    });
    expect(sportsActionQuality(peak)).toBeGreaterThan(sportsActionQuality(flat));
  });
});

describe('pose geometry', () => {
  // Torso: shoulders at y=0.2, hips at y=0.5 → torsoHeight 0.3.
  const torso = {
    [COCO_KP.leftShoulder]: [0.5, 0.2] as [number, number],
    [COCO_KP.rightShoulder]: [0.5, 0.2] as [number, number],
    [COCO_KP.leftHip]: [0.5, 0.5] as [number, number],
    [COCO_KP.rightHip]: [0.5, 0.5] as [number, number],
  };

  it('scores a straight, raised kick near 1 and a bent planted leg low', () => {
    const straightKick = kickStraightness(pose({
      ...torso,
      // Left leg locked straight and raised: hip→knee→ankle collinear, ankle above hip.
      [COCO_KP.leftKnee]: [0.55, 0.35],
      [COCO_KP.leftAnkle]: [0.6, 0.2],
    }));
    const bentPlanted = kickStraightness(pose({
      ...torso,
      // Right leg bent and planted below the hip.
      [COCO_KP.rightKnee]: [0.5, 0.72],
      [COCO_KP.rightAnkle]: [0.42, 0.62],
      // Neutralise the left leg so it doesn't dominate.
      [COCO_KP.leftKnee]: [0.5, 0.72],
      [COCO_KP.leftAnkle]: [0.5, 0.92],
    }));
    expect(straightKick).toBeGreaterThan(0.8);
    expect(bentPlanted).toBeLessThan(0.4);
    expect(straightKick).toBeGreaterThan(bentPlanted);
  });

  it('frameKickStraightness takes the best athlete', () => {
    const weak = pose({ ...torso, [COCO_KP.leftKnee]: [0.5, 0.72], [COCO_KP.leftAnkle]: [0.45, 0.62] });
    const strong = pose({ ...torso, [COCO_KP.leftKnee]: [0.55, 0.35], [COCO_KP.leftAnkle]: [0.6, 0.2] });
    expect(frameKickStraightness({ poses: [weak, strong] })).toBeGreaterThan(0.8);
  });

  it('poseContactSignal is high when a foot lands on an opponent torso', () => {
    const kicker = pose({
      [COCO_KP.leftShoulder]: [0.1, 0.2], [COCO_KP.rightShoulder]: [0.1, 0.2],
      [COCO_KP.leftHip]: [0.1, 0.5], [COCO_KP.rightHip]: [0.1, 0.5],
      // Foot reaching across to the opponent's chest at x≈0.6, y≈0.35.
      [COCO_KP.rightAnkle]: [0.6, 0.35],
    });
    const target = pose({
      [COCO_KP.leftShoulder]: [0.6, 0.3], [COCO_KP.rightShoulder]: [0.6, 0.3],
      [COCO_KP.leftHip]: [0.6, 0.5], [COCO_KP.rightHip]: [0.6, 0.5],
    });
    const contact = poseContactSignal({ poses: [kicker, target] });
    expect(contact).toBeGreaterThan(0.6);
  });

  it('poseContactSignal is low when athletes are far apart', () => {
    const a = pose({
      [COCO_KP.leftShoulder]: [0.05, 0.2], [COCO_KP.rightShoulder]: [0.05, 0.2],
      [COCO_KP.leftHip]: [0.05, 0.5], [COCO_KP.rightHip]: [0.05, 0.5],
      [COCO_KP.rightAnkle]: [0.08, 0.8],
    });
    const b = pose({
      [COCO_KP.leftShoulder]: [0.95, 0.2], [COCO_KP.rightShoulder]: [0.95, 0.2],
      [COCO_KP.leftHip]: [0.95, 0.5], [COCO_KP.rightHip]: [0.95, 0.5],
    });
    expect(poseContactSignal({ poses: [a, b] })).toBeLessThan(0.3);
  });

  it('sportsActionQuality rewards a measured pose contact over boxes alone', () => {
    const base: Partial<MediaFile> = {
      subjectSharpnessScore: 120, sharpnessScore: 90, blurRisk: 'low',
      personCount: 2,
      personBoxes: [
        { x: 0.05, y: 0.2, width: 0.18, height: 0.5 },
        { x: 0.78, y: 0.2, width: 0.18, height: 0.5 },
      ],
    };
    const withoutPose = sportsActionQuality(file('/np.jpg', base));
    const withPose = sportsActionQuality(file('/wp.jpg', {
      ...base,
      poses: [
        pose({
          [COCO_KP.leftShoulder]: [0.1, 0.2], [COCO_KP.rightShoulder]: [0.1, 0.2],
          [COCO_KP.leftHip]: [0.1, 0.5], [COCO_KP.rightHip]: [0.1, 0.5],
          [COCO_KP.rightAnkle]: [0.6, 0.35],
        }),
        pose({
          [COCO_KP.leftShoulder]: [0.6, 0.3], [COCO_KP.rightShoulder]: [0.6, 0.3],
          [COCO_KP.leftHip]: [0.6, 0.5], [COCO_KP.rightHip]: [0.6, 0.5],
        }),
      ],
    }));
    expect(withPose).toBeGreaterThan(withoutPose);
  });
});

describe('configureReviewProfile gating', () => {
  it('only changes bestShotScore when a sports profile is active', () => {
    const f = file('/kick.jpg', {
      subjectSharpnessScore: 190,
      sharpnessScore: 80,
      blurRisk: 'low',
      personCount: 2,
      personBoxes: [
        { x: 0.30, y: 0.18, width: 0.22, height: 0.6 },
        { x: 0.45, y: 0.20, width: 0.22, height: 0.6 },
      ],
    });

    configureReviewProfile('general');
    const general = bestShotScore(f);
    configureReviewProfile('taekwondo');
    const sports = bestShotScore(f);
    expect(getReviewProfile()).toBe('taekwondo');
    expect(sports).not.toBe(general);
  });
});

describe('inferSceneBucket sports buckets', () => {
  it('buckets a sparring exchange as contact', () => {
    const bucket = inferSceneBucket(
      file('/spar.jpg', {
        personCount: 2,
        personBoxes: [
          { x: 0.30, y: 0.18, width: 0.22, height: 0.6 },
          { x: 0.45, y: 0.20, width: 0.22, height: 0.6 },
        ],
      }),
      'taekwondo',
    );
    expect(bucket).toBe('Sparring / contact');
  });

  it('buckets a lone athlete as poomsae/form', () => {
    const bucket = inferSceneBucket(
      file('/form.jpg', { personCount: 1, personBoxes: [{ x: 0.4, y: 0.2, width: 0.2, height: 0.6 }] }),
      'taekwondo',
    );
    expect(bucket).toBe('Poomsae / form');
  });
});

describe('selectKeepersToTarget', () => {
  function athlete(path: string, score: number, group?: string): MediaFile {
    return file(path, {
      subjectSharpnessScore: score,
      sharpnessScore: score,
      blurRisk: 'low',
      personCount: 1,
      personBoxes: [{ x: 0.4, y: 0.2, width: 0.2, height: 0.6 }],
      burstId: group,
    });
  }

  it('culls down to the target budget', () => {
    const files = Array.from({ length: 50 }, (_, i) => athlete(`/a${i}.jpg`, 50 + i));
    const result = selectKeepersToTarget(files, { target: 10 });
    expect(result.kept).toBe(10);
    expect(result.reject).toHaveLength(40);
    expect(result.keep).toHaveLength(10);
  });

  it('suppresses visual near-duplicates that lack a burst id (RAW frames / RAW+JPEG)', () => {
    // 6 near-identical frames (same perceptual hash) with NO burstId — simulates
    // consecutive .RAF frames the burst detector missed. Plus 4 distinct frames.
    const dupHash = 'ffffffffffffffff';
    const near = 'fffffffffffffffe'; // 1 bit off → within threshold
    const dups = [
      file('/raf1.jpg', { visualHash: dupHash, sharpnessScore: 100, blurRisk: 'low' }),
      file('/raf2.jpg', { visualHash: near, sharpnessScore: 99, blurRisk: 'low' }),
      file('/raf3.jpg', { visualHash: dupHash, sharpnessScore: 98, blurRisk: 'low' }),
      file('/raf4.jpg', { visualHash: near, sharpnessScore: 97, blurRisk: 'low' }),
      file('/raf5.jpg', { visualHash: dupHash, sharpnessScore: 96, blurRisk: 'low' }),
      file('/raf6.jpg', { visualHash: near, sharpnessScore: 95, blurRisk: 'low' }),
    ];
    const distinct = [
      file('/d1.jpg', { visualHash: '0000000000000000', sharpnessScore: 90, blurRisk: 'low' }),
      file('/d2.jpg', { visualHash: '00000000ffffffff', sharpnessScore: 89, blurRisk: 'low' }),
      file('/d3.jpg', { visualHash: 'ffffffff00000000', sharpnessScore: 88, blurRisk: 'low' }),
      file('/d4.jpg', { visualHash: '0f0f0f0f0f0f0f0f', sharpnessScore: 87, blurRisk: 'low' }),
    ];
    // Target = the 5 visually-distinct frames (1 dup-rep + 4 distinct), so the
    // budget is met without a last-resort fill that would re-add near-dups.
    const result = selectKeepersToTarget([...dups, ...distinct], { target: 5, dedupeHashDistance: 8 });
    // Only ONE of the 6 near-identical frames should survive.
    const keptDups = result.keep.filter((p) => p.startsWith('/raf'));
    expect(keptDups).toHaveLength(1);
    expect(result.dedupedNearDuplicates).toBeGreaterThanOrEqual(5);
    // All 4 distinct frames kept.
    for (const d of distinct) expect(result.keep).toContain(d.path);
  });

  it('still meets the budget by filling with near-duplicates only as a last resort', () => {
    const dupHash = 'ffffffffffffffff';
    const dups = Array.from({ length: 10 }, (_, i) =>
      file(`/dup${i}.jpg`, { visualHash: dupHash, sharpnessScore: 100 - i, blurRisk: 'low' }));
    // Target 4 but only 1 visually-distinct frame exists → fall back to fill budget.
    const result = selectKeepersToTarget(dups, { target: 4, dedupeHashDistance: 8 });
    expect(result.kept).toBe(4);
  });

  it('keeps the strongest frame per burst group first for variety', () => {
    // Two bursts of 5; with target 2 and perGroupCap 1, expect one from each burst.
    const burstA = Array.from({ length: 5 }, (_, i) => athlete(`/A${i}.jpg`, 100 + i, 'burst-A'));
    const burstB = Array.from({ length: 5 }, (_, i) => athlete(`/B${i}.jpg`, 60 + i, 'burst-B'));
    const result = selectKeepersToTarget([...burstA, ...burstB], { target: 2, perGroupCap: 1 });
    expect(result.kept).toBe(2);
    expect(result.groups).toBe(2);
    // Best of each burst is the highest-scored member.
    expect(result.keep).toContain('/A4.jpg');
    expect(result.keep).toContain('/B4.jpg');
  });

  it('always keeps protected and rated files even past target', () => {
    const files = [
      file('/keep-protected.jpg', { isProtected: true, sharpnessScore: 1, blurRisk: 'high' }),
      file('/keep-rated.jpg', { rating: 5, sharpnessScore: 1, blurRisk: 'high' }),
      ...Array.from({ length: 20 }, (_, i) => file(`/x${i}.jpg`, { sharpnessScore: 100, blurRisk: 'low' })),
    ];
    const result = selectKeepersToTarget(files, { target: 1 });
    expect(result.keep).toContain('/keep-protected.jpg');
    expect(result.keep).toContain('/keep-rated.jpg');
    expect(result.mandatory).toBe(2);
  });

  it('never culls below mandatory keepers', () => {
    const files = [
      file('/p1.jpg', { isProtected: true }),
      file('/p2.jpg', { isProtected: true }),
      file('/p3.jpg', { isProtected: true }),
    ];
    const result = selectKeepersToTarget(files, { target: 1 });
    expect(result.kept).toBe(3);
    expect(result.reject).toHaveLength(0);
  });

  it('restores the previous review profile after running', () => {
    configureReviewProfile('general');
    selectKeepersToTarget([file('/a.jpg')], { target: 1, eventMode: 'taekwondo' });
    expect(getReviewProfile()).toBe('general');
  });
});
