import type { CullConfidence, EventMode, KeeperQuota, MediaFile, PoseKeypoint, PoseKeypoints } from './types';
import { COCO_KP, isSportsEventMode } from './types';

// ---------------------------------------------------------------------------
// Active review profile
//
// Scoring is parameterised by the session's EventMode without threading the
// mode through every bestShotScore()/keeperScore() call site (there are many,
// across renderer + main). This mirrors the module-level config pattern already
// used by the face engine (configureFaceThroughput etc.). Default 'general'
// preserves the original scoring exactly, so existing callers/tests are
// unaffected until they opt in via configureReviewProfile().
// ---------------------------------------------------------------------------

let activeEventMode: EventMode = 'general';

export function configureReviewProfile(mode: EventMode | undefined): void {
  activeEventMode = mode ?? 'general';
}

export function getReviewProfile(): EventMode {
  return activeEventMode;
}

function sportsModeActive(): boolean {
  return isSportsEventMode(activeEventMode);
}

export interface ReviewScoreInput {
  sharpnessScore?: number;
  subjectSharpnessScore?: number;
  faceCount?: number;
  faceBoxes?: MediaFile['faceBoxes'];
  faceDetection?: MediaFile['faceDetection'];
  personCount?: number;
  personBoxes?: MediaFile['personBoxes'];
  rating?: number;
  isProtected?: boolean;
  exposureValue?: number;
  visualGroupSize?: number;
}

export interface ReviewScore {
  score: number;
  blurRisk: 'low' | 'medium' | 'high';
  reasons: string[];
}

function clamp01(value: number | undefined, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function boxCenterScore(box: { x: number; y: number; width: number; height: number }): number {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dx = Math.abs(cx - 0.5);
  const dy = Math.abs(cy - 0.43);
  return clamp01(1 - (dx * 1.45 + dy * 1.05));
}

// ---------------------------------------------------------------------------
// Sports / taekwondo action scoring
//
// We have no pose model, so "contact" and "action" are proxies built from the
// signals we DO have: person boxes (athlete bodies), face expression (emotion /
// kiap), and subject vs whole-frame sharpness (frozen motion). These are strong
// heuristics for peak-moment selection, not measured limb geometry.
// ---------------------------------------------------------------------------

type Box = { x: number; y: number; width: number; height: number; score?: number };

function boxIoU(a: Box, b: Box): number {
  const ix1 = Math.max(a.x, b.x);
  const iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(a.x + a.width, b.x + b.width);
  const iy2 = Math.min(a.y + a.height, b.y + b.height);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 1e-6 ? inter / union : 0;
}

/**
 * Strongest athlete-to-athlete contact signal in the frame, 0..1.
 * Two overlapping/adjacent person boxes with vertical overlap approximate a
 * sparring exchange or kick-to-body contact. A single isolated athlete (poomsae
 * / form) scores 0 here and is rewarded by the action term instead.
 */
export function athleteContactSignal(file: Pick<MediaFile, 'personBoxes' | 'personCount'>): number {
  const boxes = (file.personBoxes ?? []).filter((b) => b.width > 0 && b.height > 0);
  if (boxes.length < 2) return 0;
  let best = 0;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const iou = boxIoU(a, b);
      // Edge proximity: athletes can make contact (a kick) while bodies barely
      // overlap. Reward small horizontal gaps when there is vertical overlap.
      const vOverlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      const hGap = Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width);
      const proximity = vOverlap > 0 && hGap < 0.06 ? clamp01(1 - hGap / 0.06) * 0.6 : 0;
      // Size similarity — two same-scale athletes engaging beats one foreground
      // body overlapping a tiny background spectator.
      const sizeRatio = Math.min(a.width * a.height, b.width * b.height) /
        Math.max(a.width * a.height, b.width * b.height, 1e-6);
      const engagement = Math.max(clamp01(iou / 0.25), proximity) * (0.55 + 0.45 * sizeRatio);
      best = Math.max(best, engagement);
    }
  }
  return clamp01(best);
}

/**
 * Frozen-action signal, 0..1. Peak sports frames are tack-sharp on the subject
 * even when the background streaks from a pan. A sharp subject paired with a
 * softer whole frame is a strong "caught the moment" cue.
 */
export function frozenActionSignal(
  file: Pick<MediaFile, 'sharpnessScore' | 'subjectSharpnessScore' | 'blurRisk'>,
): number {
  if (file.blurRisk === 'high') return 0;
  const subject = file.subjectSharpnessScore ?? file.sharpnessScore ?? 0;
  const whole = file.sharpnessScore ?? subject;
  // Laplacian-variance sharpness spans 0..several-thousand on a well-lit sports
  // shoot, so a linear threshold saturates instantly. Compress with sqrt and a
  // high knee, and lean on subject-vs-frame isolation (panned/frozen action)
  // as the real discriminator since everything is "sharp" in good light.
  const subjectSignal = clamp01((Math.sqrt(subject) - 14) / 46);
  const isolation = whole > 0 ? clamp01((subject - whole) / Math.max(whole, 400)) : 0;
  return clamp01(subjectSignal * 0.6 + isolation * 0.55);
}

// ---------------------------------------------------------------------------
// Pose-keypoint geometry (used when the optional pose model has run)
//
// Pure, unit-testable math over COCO-17 keypoints. When poses are present these
// give MEASURED kick straightness and real foot-to-torso contact; when absent
// the sports scorer falls back to the person-box proxies above.
// ---------------------------------------------------------------------------

const POSE_KP_MIN_SCORE = 0.3;

function kp(pose: PoseKeypoints, index: number): PoseKeypoint | null {
  const point = pose.keypoints[index];
  if (!point || point.score < POSE_KP_MIN_SCORE) return null;
  return point;
}

/** Interior angle at vertex b formed by a-b-c, in degrees (0..180). */
function jointAngle(a: PoseKeypoint, b: PoseKeypoint, c: PoseKeypoint): number {
  const v1x = a.x - b.x, v1y = a.y - b.y;
  const v2x = c.x - b.x, v2y = c.y - b.y;
  const dot = v1x * v2x + v1y * v2y;
  const m1 = Math.hypot(v1x, v1y);
  const m2 = Math.hypot(v2x, v2y);
  if (m1 < 1e-6 || m2 < 1e-6) return 0;
  const cos = Math.max(-1, Math.min(1, dot / (m1 * m2)));
  return (Math.acos(cos) * 180) / Math.PI;
}

function torsoHeight(pose: PoseKeypoints): number {
  const ls = kp(pose, COCO_KP.leftShoulder);
  const rs = kp(pose, COCO_KP.rightShoulder);
  const lh = kp(pose, COCO_KP.leftHip);
  const rh = kp(pose, COCO_KP.rightHip);
  const shoulderY = ls && rs ? (ls.y + rs.y) / 2 : (ls?.y ?? rs?.y);
  const hipY = lh && rh ? (lh.y + rh.y) / 2 : (lh?.y ?? rh?.y);
  if (shoulderY === undefined || hipY === undefined) return 0;
  return Math.abs(hipY - shoulderY);
}

/**
 * Straightness of the best-extended kicking leg for one athlete, 0..1.
 * 1 = a fully-locked leg (hip-knee-ankle ≈ 180°) that is also raised — i.e. a
 * committed kick or a clean poomsae extension, not a bent standing leg.
 */
export function kickStraightness(pose: PoseKeypoints): number {
  const legs: Array<[number, number, number]> = [
    [COCO_KP.leftHip, COCO_KP.leftKnee, COCO_KP.leftAnkle],
    [COCO_KP.rightHip, COCO_KP.rightKnee, COCO_KP.rightAnkle],
  ];
  const tHeight = torsoHeight(pose) || 0.2;
  let best = 0;
  for (const [hipIdx, kneeIdx, ankleIdx] of legs) {
    const hip = kp(pose, hipIdx);
    const knee = kp(pose, kneeIdx);
    const ankle = kp(pose, ankleIdx);
    if (!hip || !knee || !ankle) continue;
    const angle = jointAngle(hip, knee, ankle);
    const straightness = clamp01((angle - 150) / 30); // 150°→0, 180°→1
    // Elevation: ankle raised toward/above hip level => an actual kick, not a
    // planted leg. Measured in torso-heights so it's scale-invariant. A leg
    // planted straight down stays low; a raised straight leg scores near 1.
    const elevation = clamp01((hip.y - ankle.y) / tHeight + 0.25);
    best = Math.max(best, straightness * (0.2 + 0.8 * elevation));
  }
  return clamp01(best);
}

/** Best kick straightness across all athletes in the frame, 0..1. */
export function frameKickStraightness(file: Pick<MediaFile, 'poses'>): number {
  const poses = file.poses ?? [];
  let best = 0;
  for (const pose of poses) best = Math.max(best, kickStraightness(pose));
  return best;
}

function torsoCenter(pose: PoseKeypoints): { x: number; y: number } | null {
  const pts = [
    kp(pose, COCO_KP.leftShoulder), kp(pose, COCO_KP.rightShoulder),
    kp(pose, COCO_KP.leftHip), kp(pose, COCO_KP.rightHip),
  ].filter((p): p is PoseKeypoint => p !== null);
  if (pts.length < 2) return null;
  return {
    x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
    y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
  };
}

/**
 * Measured kick-to-body contact across athlete pairs, 0..1. Looks for one
 * athlete's foot/ankle landing near another athlete's torso centre, scaled by
 * the target's torso size so it is distance-invariant. 1 = foot on the body.
 */
export function poseContactSignal(file: Pick<MediaFile, 'poses'>): number {
  const poses = file.poses ?? [];
  if (poses.length < 2) return 0;
  let best = 0;
  for (let i = 0; i < poses.length; i++) {
    for (let j = 0; j < poses.length; j++) {
      if (i === j) continue;
      const target = torsoCenter(poses[j]);
      if (!target) continue;
      const reach = torsoHeight(poses[j]) || 0.2;
      for (const ankleIdx of [COCO_KP.leftAnkle, COCO_KP.rightAnkle]) {
        const foot = kp(poses[i], ankleIdx);
        if (!foot) continue;
        const dist = Math.hypot(foot.x - target.x, foot.y - target.y);
        // Within ~one torso height of the chest/core => scoring-range contact.
        best = Math.max(best, clamp01(1 - dist / reach));
      }
    }
  }
  return best;
}

/** Emotion / intensity proxy from face expression (kiap shout, focus), 0..1. */
export function emotionSignal(file: Pick<MediaFile, 'faceBoxes'>): number {
  const boxes = file.faceBoxes ?? [];
  if (boxes.length === 0) return 0;
  return boxes.reduce(
    (best, box) => Math.max(best, clamp01(box.smileScore ?? box.expressionScore, 0.5)),
    0,
  );
}

/**
 * Composite sports-action bonus added to bestShotScore/keeperScore when a sports
 * EventMode is active. Tuned so peak-contact, frozen, emotive, well-focused
 * frames rise to the top and flat/soft frames fall away — which is what makes a
 * 25k batch cull down hard.
 */
export function sportsActionQuality(file: MediaFile): number {
  const hasPeople = (file.personCount ?? file.personBoxes?.length ?? 0) > 0;
  const hasFaces = (file.faceCount ?? file.faceBoxes?.length ?? 0) > 0;
  const hasPoses = (file.poses?.length ?? 0) > 0;
  // Prefer MEASURED pose geometry when the pose model has run; otherwise fall
  // back to the person-box proxies so scoring degrades gracefully.
  const boxContact = athleteContactSignal(file);
  const contact = hasPoses ? Math.max(boxContact, poseContactSignal(file)) : boxContact;
  const kickForm = hasPoses ? frameKickStraightness(file) : 0;
  const action = Math.max(frozenActionSignal(file), kickForm);
  const emotion = emotionSignal(file);
  const focus = focusQuality(file);
  const group = groupCoverageQuality(file); // already 0..~34
  const faceCount = file.faceCount ?? file.faceBoxes?.length ?? 0;
  const personCount = file.personCount ?? file.personBoxes?.length ?? 0;
  const isGroup = faceCount >= 2 || personCount >= 2;

  // Pure scenery / no subject: heavily deprioritised in sports mode so the cull
  // budget spends itself on athletes, not empty mats or crowd filler.
  if (!hasPeople && !hasFaces) {
    return isDetailStoryKeeper(file) ? 8 : -40;
  }

  // Clean-exchange awareness: a 1-v-1 / small-group sparring duel is the money
  // shot. In a packed mat, overlapping bodies inflate "contact" without being a
  // real kick, so weight contact UP for a clean duel and DOWN for a crowd.
  const duelFactor = personCount <= 1 ? 0.65
    : personCount <= 4 ? 1.18
    : personCount <= 6 ? 0.98
    : 0.78;

  let bonus =
    contact * 104 * duelFactor + // kick-to-body / sparring exchange (measured if poses)
    action * 48 +                // frozen peak motion / committed extension
    emotion * 34 +               // intensity at the moment
    focus * 30 +                 // clarity gate
    kickForm * 48;               // measured straight-kick / poomsae form (poses only)

  // Combined peak: a clean exchange that is ALSO frozen-sharp is the shot to
  // keep — reward the conjunction so it clears the crowd-coverage frames.
  bonus += contact * action * duelFactor * 46;

  // Group / team frames: clarity + coverage is the priority (your "group photos
  // priority clarity and focus"). Reward sharp, everyone-visible team shots,
  // but not so much that a static clump outranks live action.
  if (isGroup) {
    bonus += group * 0.7 + focus * 22;
  }

  // A lone, razor-sharp athlete mid-form (poomsae) with no contact still earns
  // its keep through the action term; nudge it so forms aren't all culled.
  if (!isGroup && contact === 0 && action >= 0.5) {
    bonus += 22;
  }

  // Crowd damping: a big static clump shouldn't auto-win the keeper budget over
  // a clean kick. Gentle penalty past a handful of bodies.
  const crowd = Math.max(0, personCount - 6) + Math.max(0, faceCount - 7);
  bonus -= crowd * 9;

  // Soft / missed-moment athlete frames lose ground fast.
  if (file.blurRisk === 'medium') bonus -= 26;
  if (action < 0.2 && contact < 0.15) bonus -= 30;

  return Math.round(bonus);
}

export function faceSignalConfidence(
  file: Pick<MediaFile, 'faceCount' | 'faceBoxes' | 'faceDetection' | 'subjectSharpnessScore'>,
): number {
  const boxes = file.faceBoxes ?? [];
  const faceCount = file.faceCount ?? boxes.length;
  if (faceCount <= 0) return 0;

  const avgDetection = boxes.length > 0
    ? boxes.reduce((sum, box) => sum + clamp01(box.score, file.faceDetection === 'estimated' ? 0.45 : 0.78), 0) / boxes.length
    : (file.faceDetection === 'estimated' ? 0.38 : 0.58);
  const largestFaceArea = boxes.reduce((best, box) => Math.max(best, box.width * box.height), 0);
  const areaSignal = boxes.length > 0 ? clamp01(largestFaceArea / 0.035) : 0.35;
  const sharpSignal = typeof file.subjectSharpnessScore === 'number'
    ? clamp01(file.subjectSharpnessScore / 135)
    : 0.5;
  const nativeSignal = file.faceDetection === 'native' ? 0.12 : file.faceDetection === 'estimated' ? -0.16 : 0;
  const groupSignal = faceCount >= 2 ? 0.06 : 0;

  return clamp01(
    avgDetection * 0.46 +
    areaSignal * 0.22 +
    sharpSignal * 0.18 +
    0.08 +
    nativeSignal +
    groupSignal,
  );
}

export function humanMomentQuality(
  file: Pick<MediaFile, 'faceCount' | 'faceBoxes' | 'personCount' | 'personBoxes' | 'subjectSharpnessScore'>,
): number {
  const faceBoxes = file.faceBoxes ?? [];
  const personBoxes = file.personBoxes ?? [];
  const faceCount = file.faceCount ?? faceBoxes.length;
  const personCount = file.personCount ?? personBoxes.length;
  const sharp = Math.min(24, (file.subjectSharpnessScore ?? 0) / 6);

  if (faceBoxes.length > 0) {
    const eyeScores = faceBoxes.map((box) => clamp01((box.eyeScore ?? 0) / 2));
    const smileScores = faceBoxes.map((box) => clamp01(box.smileScore ?? box.expressionScore, 0.5));
    const avgEye = eyeScores.reduce((sum, score) => sum + score, 0) / eyeScores.length;
    const minEye = Math.min(...eyeScores);
    const avgSmile = smileScores.reduce((sum, score) => sum + score, 0) / smileScores.length;
    const faceArea = faceBoxes.reduce((sum, box) => sum + box.width * box.height, 0);
    const centered = faceBoxes.reduce((best, box) => Math.max(best, boxCenterScore(box)), 0);
    const groupCoverage = faceCount >= 2 ? Math.min(18, faceCount * 4 + minEye * 14) : 0;

    return Math.round(
      avgEye * 34 +
      minEye * (faceCount >= 2 ? 28 : 14) +
      avgSmile * 12 +
      centered * 12 +
      Math.min(18, faceArea * 90) +
      groupCoverage +
      sharp,
    );
  }

  if (personBoxes.length > 0) {
    const personArea = personBoxes.reduce((sum, box) => sum + box.width * box.height, 0);
    const centered = personBoxes.reduce((best, box) => Math.max(best, boxCenterScore(box)), 0);
    return Math.round(
      Math.min(personCount, 4) * 8 +
      Math.min(24, personArea * 70) +
      centered * 14 +
      sharp,
    );
  }

  return Math.round(sharp);
}

export function faceQuality(file: Pick<MediaFile, 'faceCount' | 'faceBoxes' | 'faceDetection' | 'subjectSharpnessScore'>): number {
  const boxes = file.faceBoxes ?? [];
  const bestEye = boxes.reduce((best, box) => Math.max(best, box.eyeScore ?? 0), 0);
  const eyeSum = boxes.reduce((sum, box) => sum + (box.eyeScore ?? 0), 0);
  const expression = boxes.reduce((sum, box) => sum + clamp01(box.smileScore ?? box.expressionScore, 0.5), 0);
  const faceCount = file.faceCount ?? boxes.length;
  const faceArea = boxes.reduce((sum, box) => sum + box.width * box.height, 0);
  const largestFaceArea = boxes.reduce((best, box) => Math.max(best, box.width * box.height), 0);
  const sharp = Math.min(60, (file.subjectSharpnessScore ?? 0) / 3);
  const faceConfidence = faceSignalConfidence(file);
  return Math.round(
    (Math.min(faceCount, 4) * 18 +
    bestEye * 18 +
    eyeSum * 7 +
    Math.min(14, expression * 5) +
    Math.min(20, largestFaceArea * 180) +
    Math.min(14, faceArea * 80)) * Math.max(0.35, faceConfidence) +
    sharp,
  );
}

export function subjectPresenceQuality(
  file: Pick<MediaFile, 'faceCount' | 'faceBoxes' | 'faceDetection' | 'personCount' | 'personBoxes' | 'subjectSharpnessScore'>,
): number {
  const face = faceQuality(file);
  const personBoxes = file.personBoxes ?? [];
  const personCount = file.personCount ?? personBoxes.length;
  const personArea = personBoxes.reduce((sum, box) => sum + box.width * box.height, 0);
  const personScore = Math.round(
    Math.min(personCount, 3) * 12 +
    Math.min(26, personArea * 90) +
    Math.min(20, (file.subjectSharpnessScore ?? 0) / 5),
  );
  return Math.max(face, personScore);
}

export function focusQuality(
  file: Pick<MediaFile, 'sharpnessScore' | 'subjectSharpnessScore' | 'blurRisk' | 'faceCount' | 'faceBoxes' | 'personCount' | 'personBoxes'>,
): number {
  const wholeSharp = file.sharpnessScore ?? 0;
  const subjectSharp = file.subjectSharpnessScore;
  const hasSubjects =
    (file.faceCount ?? file.faceBoxes?.length ?? 0) > 0 ||
    (file.personCount ?? file.personBoxes?.length ?? 0) > 0;
  const wholeSignal = clamp01((wholeSharp - 45) / 135);
  const subjectSignal = typeof subjectSharp === 'number'
    ? clamp01((subjectSharp - (hasSubjects ? 38 : 48)) / (hasSubjects ? 82 : 92))
    : wholeSignal;
  const combined = hasSubjects
    ? subjectSignal * 0.72 + wholeSignal * 0.28
    : Math.max(subjectSignal, wholeSignal * 0.92);

  if (file.blurRisk === 'high') return Math.min(combined, 0.32);
  if (file.blurRisk === 'medium') return Math.min(combined, 0.68);
  return combined;
}

export function isUsablyFocused(
  file: Pick<MediaFile, 'sharpnessScore' | 'subjectSharpnessScore' | 'blurRisk' | 'faceCount' | 'faceBoxes' | 'personCount' | 'personBoxes'>,
): boolean {
  const hasSubjects =
    (file.faceCount ?? file.faceBoxes?.length ?? 0) > 0 ||
    (file.personCount ?? file.personBoxes?.length ?? 0) > 0;
  if (file.blurRisk === 'high') return false;
  if (hasSubjects && typeof file.subjectSharpnessScore === 'number' && file.subjectSharpnessScore < 45) return false;
  return focusQuality(file) >= (hasSubjects ? 0.34 : 0.4);
}

export function keeperScore(file: MediaFile): number {
  return (
    (file.isProtected ? 120 : 0) +
    (file.rating ?? 0) * 30 +
    subjectPresenceQuality(file) +
    Math.min(70, (file.subjectSharpnessScore ?? 0) / 2.4) +
    Math.min(45, (file.sharpnessScore ?? 0) / 6) +
    Math.min(55, file.reviewScore ?? 0) -
    (file.blurRisk === 'high' ? 90 : file.blurRisk === 'medium' ? 30 : 0) +
    (sportsModeActive() ? sportsActionQuality(file) : 0)
  );
}

export function bestShotScore(file: MediaFile): number {
  const face = faceQuality(file);
  const subject = subjectPresenceQuality(file);
  const subjectSharp = file.subjectSharpnessScore ?? 0;
  const wholeSharp = file.sharpnessScore ?? 0;
  const review = file.reviewScore ?? 0;
  const hasFaces = (file.faceCount ?? file.faceBoxes?.length ?? 0) > 0;
  const hasPeople = (file.personCount ?? file.personBoxes?.length ?? 0) > 0;
  const humanMoment = humanMomentQuality(file);
  const faceReliability = file.faceDetection === 'estimated' ? 0.82 : 1;
  const subjectFocus = boundedScore(subjectSharp, hasFaces || hasPeople ? 7.8 : 6.3, 112);
  const wholeFrameFocus = boundedScore(wholeSharp, hasFaces || hasPeople ? 3.7 : 4.7, 62);
  const groupCoverage = groupCoverageQuality(file);
  const detailStory = detailStoryQuality(file);
  const weakFace = weakFacePenalty(file);

  let score =
    (file.isProtected ? 220 : 0) +
    (file.rating ?? 0) * 55 +
    subject * (hasFaces || hasPeople ? 1.08 : 0.45) +
    face * (hasFaces ? 1.18 * faceReliability : 0.18) +
    humanMoment * (hasFaces ? 1.62 : hasPeople ? 1.2 : 0.25) +
    groupCoverage * 1.35 +
    subjectFocus +
    wholeFrameFocus +
    detailStory +
    Math.min(74, review * (hasFaces || hasPeople ? 0.92 : 0.82));

  if (file.pick === 'rejected') score -= 140;
  if (typeof file.exposureValue === 'number') score += 8;
  if (file.blurRisk === 'high') score -= hasFaces ? 150 : 115;
  if (file.blurRisk === 'medium') score -= 44;
  score -= weakFace;
  if (hasFaces && subjectSharp > 0 && subjectSharp < 38) score -= 55;
  if (!hasFaces && subjectSharp > 0 && subjectSharp < 28) score -= 25;
  if (sportsModeActive()) score += sportsActionQuality(file);
  return Math.round(score);
}

function manualPickRank(file: MediaFile): number {
  if (file.pick === 'rejected') return 0;
  return 1;
}

function isAutoBestCandidate(file: MediaFile): boolean {
  if (file.pick === 'rejected') return false;
  if (file.pick === 'selected' || file.isProtected || (file.rating ?? 0) > 0) return true;
  return isUsablyFocused(file);
}

export function isDetailStoryKeeper(file: MediaFile): boolean {
  const hasFaces = (file.faceCount ?? file.faceBoxes?.length ?? 0) > 0;
  const hasPeople = (file.personCount ?? file.personBoxes?.length ?? 0) > 0;
  const sharp = Math.max(file.sharpnessScore ?? 0, file.subjectSharpnessScore ?? 0);
  const review = file.reviewScore ?? 0;
  return !hasFaces && !hasPeople && file.type === 'photo' && file.blurRisk !== 'high' && (sharp >= 120 || review >= 68);
}

export function inferSceneBucket(file: MediaFile, eventMode: EventMode = 'general'): string {
  if (file.type === 'video') return 'Video';
  if (isSportsEventMode(eventMode)) {
    const faces = file.faceCount ?? file.faceBoxes?.length ?? 0;
    const persons = file.personCount ?? file.personBoxes?.length ?? 0;
    if (faces === 0 && persons === 0) return isDetailStoryKeeper(file) ? 'Details' : 'Scene';
    if (athleteContactSignal(file) >= 0.45) return 'Sparring / contact';
    if (faces >= 3 || persons >= 3) return 'Team / group';
    if (frozenActionSignal(file) >= 0.55) return 'Kicks / action';
    if (persons === 1 && faces <= 1) return 'Poomsae / form';
    return 'Athletes';
  }
  if ((file.faceCount ?? file.faceBoxes?.length ?? 0) >= 3 || (file.personCount ?? file.personBoxes?.length ?? 0) >= 3) {
    return 'Groups';
  }
  if ((file.faceCount ?? file.faceBoxes?.length ?? 0) > 0) {
    if (eventMode === 'stage') return 'Stage faces';
    if (eventMode === 'candids') return 'Candids';
    if (eventMode === 'cosplay') return 'Cosplay portraits';
    return 'People';
  }
  if ((file.personCount ?? file.personBoxes?.length ?? 0) > 0) {
    if (eventMode === 'cosplay') return 'Full costume';
    if (eventMode === 'stage') return 'Stage action';
    return 'People';
  }
  if (isDetailStoryKeeper(file)) {
    if (eventMode === 'cars-itasha') return 'Car details';
    if (eventMode === 'cosplay') return 'Costume details';
    return 'Details';
  }
  if (file.gps || file.locationName) return 'Location';
  return 'Scene';
}

export function assignSceneBuckets(files: MediaFile[], eventMode: EventMode = 'general'): MediaFile[] {
  const counts = new Map<string, number>();
  return files.map((file) => {
    const bucket = inferSceneBucket(file, eventMode);
    const nextCount = (counts.get(bucket) ?? 0) + 1;
    counts.set(bucket, nextCount);
    const sceneBucketId = `${bucket.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'scene'}-${nextCount}`;
    return { ...file, sceneBucket: bucket, sceneBucketId };
  });
}

type RankKey = {
  file: MediaFile;
  manualPick: number;
  protected: number;
  rating: number;
  bestShot: number;
  subjectPresence: number;
  face: number;
  subjectSharpness: number;
  highBlur: number;
  sharpness: number;
  review: number;
  burstIndex: number;
};

export function rankBestShots(files: MediaFile[]): MediaFile[] {
  // Pre-compute all scoring functions once per file (Schwartzian transform) so
  // the sort comparator does O(1) field comparisons instead of calling scoring
  // functions on every pivot — important for bursts with hundreds of candidates.
  const keyed: RankKey[] = files.map((file) => ({
    file,
    manualPick: manualPickRank(file),
    protected: Number(!!file.isProtected),
    rating: file.rating ?? 0,
    bestShot: bestShotScore(file),
    subjectPresence: subjectPresenceQuality(file),
    face: faceQuality(file),
    subjectSharpness: file.subjectSharpnessScore ?? 0,
    highBlur: Number(file.blurRisk === 'high'),
    sharpness: file.sharpnessScore ?? 0,
    review: file.reviewScore ?? 0,
    burstIndex: file.burstIndex ?? 0,
  }));

  keyed.sort((a, b) =>
    b.manualPick - a.manualPick ||
    b.protected - a.protected ||
    b.rating - a.rating ||
    b.bestShot - a.bestShot ||
    b.subjectPresence - a.subjectPresence ||
    b.face - a.face ||
    b.subjectSharpness - a.subjectSharpness ||
    a.highBlur - b.highBlur ||
    b.sharpness - a.sharpness ||
    b.review - a.review ||
    a.burstIndex - b.burstIndex ||
    a.file.name.localeCompare(b.file.name),
  );

  return keyed.map((k) => k.file);
}

export interface AutoCullDecision {
  best: MediaFile | null;
  keep: string[];
  reject: string[];
  confidence: 'low' | 'medium' | 'high';
  reasons: Record<string, string[]>;
  bestExplanation?: BestShotExplanation;
}

export function scoreGapConfidence(gap: number): AutoCullDecision['confidence'] {
  return gap >= 72 ? 'high' : gap >= 28 ? 'medium' : 'low';
}

export interface BestShotExplanation {
  bestPath: string;
  bestName: string;
  runnerUpPath?: string;
  runnerUpName?: string;
  bestScore: number;
  runnerUpScore?: number;
  scoreGap: number;
  confidence: AutoCullDecision['confidence'];
  summary: string;
  wins: string[];
  cautions: string[];
}

function displayName(file: MediaFile): string {
  return file.name || file.path.split(/[/\\]/).pop() || 'top candidate';
}

function blurRank(file: MediaFile): number {
  return file.blurRisk === 'high' ? 2 : file.blurRisk === 'medium' ? 1 : 0;
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function boundedScore(value: number | undefined, scale: number, cap: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(cap, Math.sqrt(value) * scale);
}

function expressionSignal(box: NonNullable<MediaFile['faceBoxes']>[number]): number {
  return clamp01(box.smileScore ?? box.expressionScore, 0.5);
}

function faceUsabilityScore(file: Pick<MediaFile, 'faceCount' | 'faceBoxes' | 'faceDetection' | 'subjectSharpnessScore'>): number {
  const boxes = file.faceBoxes ?? [];
  const faceCount = file.faceCount ?? boxes.length;
  if (faceCount <= 0) return 0;
  if (boxes.length === 0) return file.faceDetection === 'estimated' ? 0.42 : 0.58;

  const usable = boxes.reduce((sum, box) => {
    const eye = clamp01((box.eyeScore ?? 0) / 2);
    const detection = clamp01(box.score, file.faceDetection === 'estimated' ? 0.45 : 0.78);
    const expression = expressionSignal(box);
    const size = clamp01((box.width * box.height) / 0.028);
    return sum + eye * 0.45 + detection * 0.3 + expression * 0.12 + size * 0.13;
  }, 0) / boxes.length;
  return clamp01(usable, file.faceDetection === 'estimated' ? 0.42 : 0.55);
}

function groupCoverageQuality(file: Pick<MediaFile, 'faceCount' | 'faceBoxes' | 'faceDetection' | 'personCount' | 'personBoxes' | 'subjectSharpnessScore'>): number {
  const faceBoxes = file.faceBoxes ?? [];
  const personBoxes = file.personBoxes ?? [];
  const faceCount = file.faceCount ?? faceBoxes.length;
  const personCount = file.personCount ?? personBoxes.length;
  if (faceCount < 2 && personCount < 2) return 0;

  const usableFaces = faceBoxes.filter((box) =>
    clamp01((box.eyeScore ?? 0) / 2) >= 0.5 &&
    clamp01(box.score, file.faceDetection === 'estimated' ? 0.45 : 0.78) >= 0.68,
  ).length;
  const usableRatio = faceCount > 0
    ? clamp01(usableFaces / faceCount, faceBoxes.length > 0 ? 0.45 : 0.62)
    : 0;
  const coverageRatio = personCount > 0
    ? clamp01(faceCount / personCount, faceCount > 0 ? 0.55 : 0)
    : clamp01(faceCount / 3);
  const countSignal = Math.min(34, Math.max(faceCount, personCount) * 7 + Math.min(faceCount, personCount) * 3);

  return Math.round(countSignal * (0.36 + coverageRatio * 0.34 + usableRatio * 0.3));
}

function weakFacePenalty(file: Pick<MediaFile, 'faceCount' | 'faceBoxes' | 'faceDetection' | 'subjectSharpnessScore'>): number {
  const boxes = file.faceBoxes ?? [];
  const faceCount = file.faceCount ?? boxes.length;
  if (faceCount <= 0) return 0;
  const weakest = weakestFaceSignal(file);
  const usability = faceUsabilityScore(file);
  let penalty = 0;
  if (weakest < 0.24) penalty += faceCount >= 2 ? 72 : 48;
  else if (weakest < 0.42) penalty += faceCount >= 2 ? 42 : 26;
  if (usability < 0.44) penalty += file.faceDetection === 'estimated' ? 22 : 12;
  if (file.faceDetection === 'estimated' && faceSignalConfidence(file) < 0.5) penalty += 16;
  return penalty;
}

function detailStoryQuality(file: MediaFile): number {
  const hasFaces = (file.faceCount ?? file.faceBoxes?.length ?? 0) > 0;
  const hasPeople = (file.personCount ?? file.personBoxes?.length ?? 0) > 0;
  if (hasFaces || hasPeople || file.type !== 'photo') return 0;
  const sharp = Math.max(file.sharpnessScore ?? 0, file.subjectSharpnessScore ?? 0);
  const review = file.reviewScore ?? 0;
  if (sharp < 70 && review < 50) return 0;
  return Math.round(
    Math.min(42, boundedScore(sharp, 3.2, 34) + Math.min(12, review / 8)) +
    (isDetailStoryKeeper(file) ? 14 : 0),
  );
}

export function explainBestShotSelection(files: MediaFile[]): BestShotExplanation | null {
  const ranked = rankBestShots(files).filter(isAutoBestCandidate);
  const best = ranked[0];
  if (!best) return null;

  const runnerUp = ranked[1];
  const bestScore = bestShotScore(best);
  const runnerUpScore = runnerUp ? bestShotScore(runnerUp) : undefined;
  const scoreGap = runnerUpScore === undefined ? bestScore : bestScore - runnerUpScore;
  const confidence = scoreGapConfidence(scoreGap);
  const wins: string[] = [];
  const cautions: string[] = [];
  const bestName = displayName(best);
  const runnerUpName = runnerUp ? displayName(runnerUp) : undefined;

  if (runnerUp && scoreGap >= 0) {
    pushUnique(wins, `${scoreGap >= 0 ? '+' : ''}${scoreGap} best-shot score vs #2`);
  } else if (runnerUp) {
    pushUnique(wins, 'Priority signals outrank raw score');
  } else {
    pushUnique(wins, 'Only candidate in this set');
  }
  if (runnerUp && scoreGap < 0) pushUnique(cautions, 'Runner-up has a higher raw score');
  if (best.isProtected) pushUnique(wins, 'Protected file');
  if ((best.rating ?? 0) > 0) pushUnique(wins, `${best.rating}-star rating`);

  const bestHuman = humanMomentQuality(best);
  const runnerHuman = runnerUp ? humanMomentQuality(runnerUp) : 0;
  if (runnerUp && bestHuman - runnerHuman >= 12) pushUnique(wins, `Better eyes/smile +${bestHuman - runnerHuman}`);

  const bestSubject = best.subjectSharpnessScore ?? best.sharpnessScore;
  const runnerSubject = runnerUp ? runnerUp.subjectSharpnessScore ?? runnerUp.sharpnessScore : undefined;
  if (typeof bestSubject === 'number' && typeof runnerSubject === 'number') {
    const subjectGap = Math.round(bestSubject - runnerSubject);
    if (subjectGap >= 12) pushUnique(wins, `Sharper subject +${subjectGap}`);
    else if (subjectGap <= -12) pushUnique(cautions, `Runner-up is sharper by ${Math.abs(subjectGap)}`);
  } else if (typeof bestSubject === 'number') {
    pushUnique(wins, `Subject sharpness ${Math.round(bestSubject)}`);
  }

  const bestFaceQuality = faceQuality(best);
  const runnerFaceQuality = runnerUp ? faceQuality(runnerUp) : 0;
  if (runnerUp && bestFaceQuality - runnerFaceQuality >= 16) pushUnique(wins, `Stronger face signal +${bestFaceQuality - runnerFaceQuality}`);

  const bestFaces = best.faceCount ?? best.faceBoxes?.length ?? 0;
  const runnerFaces = runnerUp ? runnerUp.faceCount ?? runnerUp.faceBoxes?.length ?? 0 : 0;
  if (bestFaces > 0) {
    pushUnique(wins, runnerUp && bestFaces !== runnerFaces
      ? `${bestFaces} faces vs ${runnerFaces}`
      : `${bestFaces} face${bestFaces === 1 ? '' : 's'}`);
  }
  const bestCoverage = groupCoverageQuality(best);
  const runnerCoverage = runnerUp ? groupCoverageQuality(runnerUp) : 0;
  if (runnerUp && bestCoverage - runnerCoverage >= 10) pushUnique(wins, `Better group coverage +${bestCoverage - runnerCoverage}`);
  const bestWeakPenalty = weakFacePenalty(best);
  const runnerWeakPenalty = runnerUp ? weakFacePenalty(runnerUp) : 0;
  if (runnerUp && runnerWeakPenalty - bestWeakPenalty >= 18) pushUnique(wins, 'Cleaner face/eye reliability');
  const bestDetail = detailStoryQuality(best);
  if (bestDetail >= 34 && bestFaces === 0) pushUnique(wins, 'Strong detail/story frame');

  if (runnerUp && blurRank(best) < blurRank(runnerUp)) pushUnique(wins, 'Lower blur risk');
  if (best.blurRisk === 'high') pushUnique(cautions, 'Top pick still has high blur risk');
  else if (best.blurRisk === 'medium') pushUnique(cautions, 'Top pick has medium blur risk');
  if (bestWeakPenalty >= 42) pushUnique(cautions, 'Top pick has weak face/eye signal');
  if (runnerUp && confidence === 'low') pushUnique(cautions, 'Close score gap, compare runner-up');

  return {
    bestPath: best.path,
    bestName,
    runnerUpPath: runnerUp?.path,
    runnerUpName,
    bestScore,
    runnerUpScore,
    scoreGap,
    confidence,
    summary: runnerUp
      ? scoreGap >= 0
        ? `Beat ${runnerUpName} by ${scoreGap} ${Math.abs(scoreGap) === 1 ? 'point' : 'points'}`
        : `Ranked ahead of ${runnerUpName} on priority signals despite a ${Math.abs(scoreGap)}-point score gap`
      : 'Only one candidate is available for this comparison',
    wins: wins.slice(0, 4),
    cautions: cautions.slice(0, 2),
  };
}

export interface AutoCullOptions {
  confidence?: CullConfidence;
  groupPhotoEveryoneGood?: boolean;
  keeperQuota?: KeeperQuota;
}

function weakestFaceSignal(file: Pick<MediaFile, 'faceBoxes'>): number {
  const boxes = file.faceBoxes ?? [];
  if (boxes.length === 0) return 1;
  return Math.min(...boxes.map((box) => {
    const eye = clamp01((box.eyeScore ?? 0) / 2);
    const detection = clamp01(box.score, 0.8);
    const expression = clamp01(box.smileScore ?? box.expressionScore, 0.5);
    return eye * 0.55 + detection * 0.3 + expression * 0.15;
  }));
}

function addQuotaKeepers(ranked: MediaFile[], keep: Set<string>, options: AutoCullOptions): void {
  const candidates = ranked.filter(isAutoBestCandidate);
  const quota = options.keeperQuota ?? 'best-1';
  if (quota === 'top-2') {
    for (const file of candidates.slice(0, 2)) keep.add(file.path);
  } else if (quota === 'all-rated') {
    for (const file of candidates) {
      if (file.isProtected || (file.rating ?? 0) > 0 || file.pick === 'selected') keep.add(file.path);
    }
  } else if (quota === 'smile-and-sharp') {
    const expressionScore = (file: MediaFile) => {
      const boxes = file.faceBoxes ?? [];
      if (boxes.length === 0) return 0;
      return boxes.reduce((best, box) => Math.max(best, clamp01(box.smileScore ?? box.expressionScore, 0.5)), 0);
    };
    const smileBest = candidates.slice().sort((a, b) =>
      expressionScore(b) - expressionScore(a) ||
      humanMomentQuality(b) - humanMomentQuality(a),
    )[0];
    const sharpBest = candidates.slice().sort((a, b) =>
      (b.subjectSharpnessScore ?? b.sharpnessScore ?? 0) - (a.subjectSharpnessScore ?? a.sharpnessScore ?? 0),
    )[0];
    if (smileBest) keep.add(smileBest.path);
    if (sharpBest) keep.add(sharpBest.path);
  }
}

export function autoCullGroup(files: MediaFile[], options: AutoCullOptions = {}): AutoCullDecision {
  const ranked = rankBestShots(files);
  const best = ranked.find(isAutoBestCandidate) ?? null;
  const keep = new Set<string>();
  const reject = new Set<string>();
  const reasons: Record<string, string[]> = {};
  if (!best) return { best: null, keep: [], reject: [], confidence: 'low', reasons };

  keep.add(best.path);
  addQuotaKeepers(ranked, keep, options);
  for (const path of keep) reasons[path] = path === best.path ? ['best shot'] : ['quota keeper'];
  const bestScore = bestShotScore(best);
  const second = ranked.find((file) => file.path !== best.path && isAutoBestCandidate(file));
  // When there is no eligible runner-up the gap is meaningless — treat as 0
  // so scoreGapConfidence returns 'low' rather than inflating against a score of 0.
  const secondScore = second ? bestShotScore(second) : bestScore;
  const gap = second ? bestScore - secondScore : 0;
  const confidence = options.confidence ?? 'balanced';
  const requiredReasons = confidence === 'conservative' ? 4 : confidence === 'aggressive' ? 1 : 2;
  const scoreGapThreshold = confidence === 'conservative' ? 92 : confidence === 'aggressive' ? 48 : 72;
  const blurGapThreshold = confidence === 'conservative' ? 58 : confidence === 'aggressive' ? 24 : 38;
  const groupMode = options.groupPhotoEveryoneGood;
  const bestFaceCount = best.faceCount ?? best.faceBoxes?.length ?? 0;
  const bestPersonCount = best.personCount ?? best.personBoxes?.length ?? 0;
  const bestWeakestFace = weakestFaceSignal(best);

  for (const file of files) {
    if (file.path === best.path) continue;
    if (file.pick === 'rejected') {
      reject.add(file.path);
      reasons[file.path] = ['manual reject'];
      continue;
    }
    if (file.isProtected || (file.rating ?? 0) > 0 || file.pick === 'selected') {
      keep.add(file.path);
      reasons[file.path] = ['manual keeper'];
      continue;
    }
    if (confidence !== 'aggressive' && isDetailStoryKeeper(file)) {
      keep.add(file.path);
      reasons[file.path] = ['detail/story keeper'];
      continue;
    }
    if (keep.has(file.path)) continue;
    const fileScore = bestShotScore(file);
    const fileReasons: string[] = [];
    const bestHumanMoment = humanMomentQuality(best);
    const fileHumanMoment = humanMomentQuality(file);
    const fileFaceCount = file.faceCount ?? file.faceBoxes?.length ?? 0;
    const filePersonCount = file.personCount ?? file.personBoxes?.length ?? 0;
    const weakFace = weakestFaceSignal(file);
    if (file.blurRisk === 'high') fileReasons.push('high blur risk');
    if (faceQuality(best) - faceQuality(file) >= 42) fileReasons.push('weaker face/eye detail');
    if (bestHumanMoment - fileHumanMoment >= 28) fileReasons.push('weaker eyes/smile moment');
    if (bestFaceCount >= 2 && bestFaceCount - fileFaceCount >= 1) fileReasons.push('missing group faces');
    if (bestPersonCount >= 2 && bestPersonCount - filePersonCount >= 1) fileReasons.push('fewer people detected');
    if (groupMode && bestFaceCount >= 2 && weakFace < 0.58 && bestWeakestFace - weakFace >= 0.12) fileReasons.push('blink/weak face risk');
    if (groupMode && (bestFaceCount >= 2 || bestPersonCount >= 2) && (fileFaceCount < bestFaceCount || filePersonCount < bestPersonCount)) fileReasons.push('everyone-good miss');
    if ((best.subjectSharpnessScore ?? 0) - (file.subjectSharpnessScore ?? 0) >= 28) fileReasons.push('softer subject');
    if ((best.reviewScore ?? 0) - (file.reviewScore ?? 0) >= 22) fileReasons.push('lower review score');
    if (bestScore - fileScore >= scoreGapThreshold) fileReasons.push('lower best-shot score');
    const enoughReasons = fileReasons.length >= requiredReasons &&
      (confidence !== 'conservative' || bestScore - fileScore >= 60);
    if (enoughReasons || (file.blurRisk === 'high' && bestScore - fileScore >= blurGapThreshold)) {
      reject.add(file.path);
      reasons[file.path] = fileReasons;
    }
  }

  return {
    best,
    keep: [...keep],
    reject: [...reject],
    confidence: scoreGapConfidence(gap),
    reasons,
    bestExplanation: explainBestShotSelection(files) ?? undefined,
  };
}

export function hammingDistanceHex(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  let distance = Math.abs(a.length - b.length) * 4;
  for (let i = 0; i < len; i++) {
    const av = parseInt(a[i], 16);
    const bv = parseInt(b[i], 16);
    if (Number.isNaN(av) || Number.isNaN(bv)) {
      distance += 4;
    } else {
      let x = av ^ bv;
      while (x) {
        distance += x & 1;
        x >>= 1;
      }
    }
  }
  return distance;
}

export function scoreReview(input: ReviewScoreInput): ReviewScore {
  const sharpness = input.sharpnessScore ?? 0;
  const subjectSharpness = input.subjectSharpnessScore ?? 0;
  const rating = input.rating ?? 0;
  const faceBoxes = input.faceBoxes ?? [];
  const personBoxes = input.personBoxes ?? [];
  const faceCount = input.faceCount ?? faceBoxes.length;
  const personCount = input.personCount ?? personBoxes.length;
  let score = Math.min(55, Math.log10(Math.max(1, sharpness) + 1) * 18);
  const reasons: string[] = [];

  if (input.isProtected) {
    score += 25;
    reasons.push('protected');
  }
  if (rating > 0) {
    score += rating * 8;
    reasons.push(`${rating} star`);
  }
  if (faceCount > 0) {
    const confidence = faceSignalConfidence(input);
    score += 16 + Math.min(18, faceQuality(input) / 5);
    reasons.push(`${faceCount} face${faceCount === 1 ? '' : 's'}`);
    if (confidence >= 0.78) reasons.push('strong face signal');
    else if (confidence < 0.52) reasons.push('check face confidence');
    const eyeScore = faceBoxes.reduce((best, box) => Math.max(best, box.eyeScore ?? 0), 0);
    if (eyeScore >= 2) reasons.push('eyes sharp');
    else if (eyeScore === 1) reasons.push('face present');
  } else if (personCount > 0) {
    score += 12 + Math.min(14, subjectPresenceQuality(input) / 6);
    reasons.push(`${personCount} person${personCount === 1 ? '' : 's'}`);
  }
  if (subjectSharpness >= 120) {
    score += 22;
    reasons.push('subject sharp');
  } else if (subjectSharpness > 0 && subjectSharpness < 35) {
    score -= 18;
    reasons.push('subject soft');
  }
  if (sharpness >= 180) reasons.push('sharp');
  if (sharpness < 35) reasons.push('soft');
  if (input.visualGroupSize && input.visualGroupSize > 1) reasons.push('similar');
  if (typeof input.exposureValue === 'number') score += 5;

  const blurRisk: ReviewScore['blurRisk'] =
    Math.max(sharpness, subjectSharpness) < 25 ? 'high'
    : Math.max(sharpness, subjectSharpness) < 70 ? 'medium'
    : 'low';
  if (blurRisk === 'high') score -= 25;
  if (blurRisk === 'medium') score -= 8;
  if (blurRisk !== 'low' && !reasons.includes('soft')) reasons.push('soft');

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    blurRisk,
    reasons,
  };
}

export function groupByVisualHash(files: MediaFile[], threshold = 8): Record<string, string[]> {
  return groupByHexSimilarity(
    files.filter((f) => f.visualHash),
    (file) => file.visualHash,
    threshold,
    'visual',
  );
}

export function groupByFaceSignature(files: MediaFile[], threshold = 10): Record<string, string[]> {
  return groupByHexSimilarity(
    files.filter((f) => f.faceSignature && (f.faceCount ?? 0) > 0),
    (file) => file.faceSignature,
    threshold,
    'face',
  );
}

// O(n²) pairwise comparison — skip when the hashed set is too large to avoid
// blocking the renderer thread. At 2 000 entries this is ~2 M comparisons;
// beyond that the grouping cost outweighs the benefit.
const VISUAL_SIMILARITY_MAX_FILES = 2000;

function groupByHexSimilarity(
  files: MediaFile[],
  hashFor: (file: MediaFile) => string | undefined,
  threshold: number,
  prefix: string,
): Record<string, string[]> {
  const hashed = files
    .map((file, order) => ({ file, hash: hashFor(file), order }))
    .filter((entry): entry is { file: MediaFile; hash: string; order: number } => !!entry.hash);

  if (hashed.length > VISUAL_SIMILARITY_MAX_FILES) return {};

  const parent = new Map<string, string>();

  const find = (path: string): string => {
    const current = parent.get(path) ?? path;
    if (current === path) return path;
    const root = find(current);
    parent.set(path, root);
    return root;
  };

  const union = (a: string, b: string): void => {
    const aRoot = find(a);
    const bRoot = find(b);
    if (aRoot !== bRoot) parent.set(bRoot, aRoot);
  };

  for (const entry of hashed) parent.set(entry.file.path, entry.file.path);
  for (let i = 0; i < hashed.length; i++) {
    for (let j = i + 1; j < hashed.length; j++) {
      if (hammingDistanceHex(hashed[i].hash, hashed[j].hash) <= threshold) {
        union(hashed[i].file.path, hashed[j].file.path);
      }
    }
  }

  const connected = new Map<string, typeof hashed>();
  for (const entry of hashed) {
    const root = find(entry.file.path);
    const group = connected.get(root);
    if (group) group.push(entry);
    else connected.set(root, [entry]);
  }

  const groups: Record<string, string[]> = {};
  let groupIndex = 1;
  const sortedGroups = [...connected.values()]
    .map((group) => group.sort((a, b) => a.order - b.order))
    .filter((group) => group.length > 1)
    .sort((a, b) => a[0].order - b[0].order);

  for (const group of sortedGroups) {
    groups[`${prefix}-${groupIndex++}`] = group.map((entry) => entry.file.path);
  }

  return groups;
}

// Embedding deserialization is called in render-path comparisons for every
// face in the gallery on each render pass. Cache by hex string to avoid
// allocating a new Float32Array on every call for the same embedding.
// A typical session has <500 unique face embeddings so the Map stays small.
const embeddingCache = new Map<string, Float32Array | null>();

export function deserializeEmbedding(hex: string): Float32Array | null {
  if (!hex || hex.length % 2 !== 0) return null;
  const cached = embeddingCache.get(hex);
  if (cached !== undefined) return cached;
  try {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      const value = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      if (Number.isNaN(value)) { embeddingCache.set(hex, null); return null; }
      bytes[i] = value;
    }
    const result = new Float32Array(bytes.buffer);
    embeddingCache.set(hex, result);
    return result;
  } catch {
    embeddingCache.set(hex, null);
    return null;
  }
}

export function clearEmbeddingCache(): void {
  embeddingCache.clear();
}

function normalizeEmbedding(embedding: Float32Array | null): Float32Array | null {
  if (!embedding || embedding.length < 4) return null;
  let norm = 0;
  for (let i = 0; i < embedding.length; i++) norm += embedding[i] * embedding[i];
  if (norm <= 1e-10 || !Number.isFinite(norm)) return null;
  const scale = 1 / Math.sqrt(norm);
  const normalized = new Float32Array(embedding.length);
  for (let i = 0; i < embedding.length; i++) normalized[i] = embedding[i] * scale;
  return normalized;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aNorm += a[i] * a[i];
    bNorm += b[i] * b[i];
  }
  const denom = Math.sqrt(aNorm) * Math.sqrt(bNorm);
  if (denom <= 1e-10) return 0;
  return Math.max(0, Math.min(1, dot / denom));
}

function normalizedCosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return Math.max(0, Math.min(1, dot));
}

type FaceEmbeddingEntry = {
  path: string;
  embedding: Float32Array;
  embeddingIndex: number;
  confidence: number;
  order: number;
};

const FACE_CLUSTER_REPRESENTATIVE_LIMIT = 8;
const FACE_CLUSTER_SECOND_PASS_LIMIT = 512;

type FaceCluster = {
  pathSet: Set<string>;
  centroid: Float32Array;
  weight: number;
  confidence: number;
  embeddingCount: number;
  sampleEntry: FaceEmbeddingEntry;
  representatives: FaceEmbeddingEntry[];
  entries: FaceEmbeddingEntry[];
};

export interface FaceIdentityGroup {
  id: string;
  paths: string[];
  size: number;
  embeddingCount: number;
  samplePath: string;
  sampleEmbeddingIndex: number;
  confidence: number;
}

function getSerializedFaceEmbeddings(file: MediaFile): string[] {
  if (file.faceEmbeddings?.length) return file.faceEmbeddings;
  return file.faceEmbedding ? [file.faceEmbedding] : [];
}

function getFaceEmbeddingEntries(files: MediaFile[]): FaceEmbeddingEntry[] {
  const order = new Map(files.map((file, index) => [file.path, index]));
  const entries: FaceEmbeddingEntry[] = [];
  for (const file of files) {
    const faceCount = file.faceCount ?? file.faceBoxes?.length ?? 0;
    if (faceCount <= 0) continue;
    const serialized = getSerializedFaceEmbeddings(file);
    if (serialized.length === 0) continue;
    const baseConfidence = faceSignalConfidence(file);
    serialized.forEach((hex, embeddingIndex) => {
      const embedding = normalizeEmbedding(deserializeEmbedding(hex));
      if (!embedding) return;
      const box = file.faceEmbeddingBoxes?.[embeddingIndex] ?? file.faceBoxes?.[embeddingIndex];
      const boxConfidence = typeof box?.score === 'number' && Number.isFinite(box.score)
        ? Math.max(0, Math.min(1, box.score))
        : 0;
      const boxSignal = file.faceDetection === 'native' || boxConfidence >= 0.72 ? boxConfidence * 0.92 : 0;
      const confidence = Math.max(baseConfidence, boxSignal);
      if (confidence < 0.34) return;
      entries.push({
        path: file.path,
        embedding,
        embeddingIndex,
        confidence,
        order: order.get(file.path) ?? 0,
      });
    });
  }
  return entries.sort((a, b) => b.confidence - a.confidence || a.order - b.order || a.embeddingIndex - b.embeddingIndex);
}

function faceClusterThreshold(baseThreshold: number, aConfidence: number, bConfidence: number): number {
  return baseThreshold + Math.max(0, 0.74 - Math.min(aConfidence, bConfidence)) * 0.08;
}

function maxSimilarityToRepresentatives(
  entry: FaceEmbeddingEntry,
  representatives: FaceEmbeddingEntry[],
  ignoreIndex = -1,
): number {
  let best = 0;
  for (let i = 0; i < representatives.length; i++) {
    if (i === ignoreIndex) continue;
    best = Math.max(best, normalizedCosineSimilarity(entry.embedding, representatives[i].embedding));
  }
  return best;
}

function addFaceRepresentative(cluster: Pick<FaceCluster, 'representatives'>, entry: FaceEmbeddingEntry): void {
  if (cluster.representatives.length < FACE_CLUSTER_REPRESENTATIVE_LIMIT) {
    cluster.representatives.push(entry);
    return;
  }

  const candidateNovelty = 1 - maxSimilarityToRepresentatives(entry, cluster.representatives);
  const candidateScore = entry.confidence * 0.7 + candidateNovelty * 0.3;
  let weakestIndex = 0;
  let weakestScore = Number.POSITIVE_INFINITY;
  for (let i = 0; i < cluster.representatives.length; i++) {
    const representative = cluster.representatives[i];
    const novelty = 1 - maxSimilarityToRepresentatives(representative, cluster.representatives, i);
    const score = representative.confidence * 0.7 + novelty * 0.3;
    if (score < weakestScore) {
      weakestScore = score;
      weakestIndex = i;
    }
  }

  if (
    candidateScore > weakestScore + 0.015 ||
    (candidateNovelty > 0.16 && entry.confidence > 0.44)
  ) {
    cluster.representatives[weakestIndex] = entry;
  }
}

function createFaceCluster(entry: FaceEmbeddingEntry): FaceCluster {
  return {
    pathSet: new Set([entry.path]),
    centroid: entry.embedding,
    weight: Math.max(0.35, entry.confidence),
    confidence: entry.confidence,
    embeddingCount: 1,
    sampleEntry: entry,
    representatives: [entry],
    entries: [entry],
  };
}

function faceClusterCandidates(cluster: FaceCluster): FaceEmbeddingEntry[] {
  return cluster.entries.length <= FACE_CLUSTER_REPRESENTATIVE_LIMIT
    ? cluster.entries
    : cluster.representatives;
}

function faceClusterPairSimilarity(a: FaceCluster, b: FaceCluster): { best: number; centroid: number } {
  const centroid = normalizedCosineSimilarity(a.centroid, b.centroid);
  let best = centroid;
  const aCandidates = faceClusterCandidates(a);
  const bCandidates = faceClusterCandidates(b);
  for (const left of aCandidates) {
    for (const right of bCandidates) {
      best = Math.max(best, normalizedCosineSimilarity(left.embedding, right.embedding));
    }
  }
  return { best, centroid };
}

function shouldMergeFaceClusters(a: FaceCluster, b: FaceCluster, baseThreshold: number): boolean {
  if (Math.min(a.confidence, b.confidence) < 0.42) return false;
  const centroidGate = Math.max(0.25, baseThreshold - 0.32);
  const centroidSimilarity = normalizedCosineSimilarity(a.centroid, b.centroid);
  if (centroidSimilarity < centroidGate) return false;

  const similarity = faceClusterPairSimilarity(a, b);
  const adaptiveThreshold = faceClusterThreshold(baseThreshold, a.confidence, b.confidence);
  const bothEstablished = a.embeddingCount >= 2 && b.embeddingCount >= 2;
  const hasEstablished = a.embeddingCount >= 2 || b.embeddingCount >= 2;
  if (
    baseThreshold <= 0.56 &&
    !bothEstablished &&
    similarity.centroid < adaptiveThreshold - 0.05
  ) {
    return false;
  }
  const requiredSimilarity = Math.max(
    0.42,
    adaptiveThreshold - (bothEstablished ? 0.045 : hasEstablished ? 0.035 : 0.015),
  );
  if (similarity.best < requiredSimilarity) return false;

  const centroidFloor = Math.max(
    0.3,
    baseThreshold - (bothEstablished ? 0.18 : hasEstablished ? 0.22 : 0.1),
  );
  return similarity.centroid >= centroidFloor ||
    similarity.best >= requiredSimilarity + (hasEstablished ? 0.015 : 0.04);
}

function mergeFaceClusterInto(target: FaceCluster, source: FaceCluster): void {
  for (const path of source.pathSet) target.pathSet.add(path);
  target.entries.push(...source.entries);
  target.embeddingCount += source.embeddingCount;

  const totalWeight = target.weight + source.weight;
  const nextCentroid = new Float32Array(target.centroid.length);
  for (let i = 0; i < nextCentroid.length; i++) {
    nextCentroid[i] = (target.centroid[i] * target.weight + source.centroid[i] * source.weight) / totalWeight;
  }
  target.centroid = normalizeEmbedding(nextCentroid) ?? target.centroid;
  target.weight = totalWeight;
  target.confidence = Math.max(target.confidence, source.confidence);
  if (
    source.sampleEntry.confidence > target.sampleEntry.confidence ||
    (source.sampleEntry.confidence === target.sampleEntry.confidence && source.sampleEntry.order < target.sampleEntry.order)
  ) {
    target.sampleEntry = source.sampleEntry;
  }

  const candidates = [...target.representatives, ...source.representatives]
    .sort((a, b) => b.confidence - a.confidence || a.order - b.order || a.embeddingIndex - b.embeddingIndex);
  target.representatives = [];
  for (const candidate of candidates) addFaceRepresentative(target, candidate);
}

function addFaceEntryToCluster(cluster: FaceCluster, entry: FaceEmbeddingEntry): void {
  cluster.pathSet.add(entry.path);
  cluster.entries.push(entry);
  cluster.embeddingCount += 1;
  if (
    entry.confidence > cluster.sampleEntry.confidence ||
    (entry.confidence === cluster.sampleEntry.confidence && entry.order < cluster.sampleEntry.order)
  ) {
    cluster.sampleEntry = entry;
  }
  const nextWeight = Math.max(0.35, entry.confidence);
  const totalWeight = cluster.weight + nextWeight;
  const nextCentroid = new Float32Array(cluster.centroid.length);
  for (let i = 0; i < nextCentroid.length; i++) {
    nextCentroid[i] = (cluster.centroid[i] * cluster.weight + entry.embedding[i] * nextWeight) / totalWeight;
  }
  cluster.centroid = normalizeEmbedding(nextCentroid) ?? cluster.centroid;
  cluster.weight = totalWeight;
  cluster.confidence = Math.max(cluster.confidence, entry.confidence);
  addFaceRepresentative(cluster, entry);
}

function mergeFaceIdentityClusters(clusters: FaceCluster[], threshold: number): FaceCluster[] {
  if (clusters.length > FACE_CLUSTER_SECOND_PASS_LIMIT) return clusters;

  let changed = true;
  while (changed) {
    changed = false;
    outer:
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        if (!shouldMergeFaceClusters(clusters[i], clusters[j], threshold)) continue;
        mergeFaceClusterInto(clusters[i], clusters[j]);
        clusters.splice(j, 1);
        changed = true;
        break outer;
      }
    }
  }
  return clusters;
}

export function buildFaceIdentityGroups(files: MediaFile[], threshold = 0.67, includeSingletons = false): FaceIdentityGroup[] {
  const order = new Map(files.map((file, index) => [file.path, index]));
  const faceEntries = getFaceEmbeddingEntries(files);

  const clusters: FaceCluster[] = [];
  for (const entry of faceEntries) {
    let bestCluster: FaceCluster | null = null;
    let bestSimilarity = 0;
    const matchingClusters: FaceCluster[] = [];
    for (const cluster of clusters) {
      const adaptiveThreshold = faceClusterThreshold(threshold, entry.confidence, cluster.confidence);
      const representativeThreshold = adaptiveThreshold + (Math.min(entry.confidence, cluster.confidence) >= 0.56 ? 0.04 : 0.065);
      const representativeCentroidFloor = adaptiveThreshold - (threshold <= 0.56 ? 0.07 : 0.1);
      const centroidSimilarity = normalizedCosineSimilarity(entry.embedding, cluster.centroid);
      if (centroidSimilarity < representativeCentroidFloor) continue;
      let representativeSimilarity = centroidSimilarity;
      if (centroidSimilarity < adaptiveThreshold) {
        for (const representative of cluster.representatives) {
          representativeSimilarity = Math.max(
            representativeSimilarity,
            normalizedCosineSimilarity(entry.embedding, representative.embedding),
          );
        }
      }
      const representativeMatch =
        representativeSimilarity >= representativeThreshold &&
        centroidSimilarity >= representativeCentroidFloor;
      const similarity = Math.max(
        centroidSimilarity,
        representativeMatch ? representativeSimilarity - 0.025 : 0,
      );
      if (
        centroidSimilarity >= adaptiveThreshold || representativeMatch
      ) {
        matchingClusters.push(cluster);
        if (similarity > bestSimilarity) {
          bestCluster = cluster;
          bestSimilarity = similarity;
        }
      }
    }

    if (!bestCluster) {
      clusters.push(createFaceCluster(entry));
      continue;
    }

    if (matchingClusters.length > 1) {
      const mergedClusters = new Set(matchingClusters.filter((cluster) => cluster !== bestCluster));
      for (const cluster of matchingClusters) {
        if (cluster !== bestCluster) mergeFaceClusterInto(bestCluster, cluster);
      }
      for (let i = clusters.length - 1; i >= 0; i--) {
        if (mergedClusters.has(clusters[i])) clusters.splice(i, 1);
      }
    }
    addFaceEntryToCluster(bestCluster, entry);
  }

  return mergeFaceIdentityClusters(clusters, threshold)
    .map((cluster) => ({
      cluster,
      paths: [...cluster.pathSet].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)),
    }))
    .filter((entry) => includeSingletons ? entry.cluster.embeddingCount > 0 : entry.paths.length > 1)
    .sort((a, b) =>
      b.paths.length - a.paths.length ||
      b.cluster.embeddingCount - a.cluster.embeddingCount ||
      a.cluster.sampleEntry.order - b.cluster.sampleEntry.order,
    )
    .map((entry, index) => ({
      id: `face-${index + 1}`,
      paths: entry.paths,
      size: entry.paths.length,
      embeddingCount: entry.cluster.embeddingCount,
      samplePath: entry.cluster.sampleEntry.path,
      sampleEmbeddingIndex: entry.cluster.sampleEntry.embeddingIndex,
      confidence: entry.cluster.confidence,
    }));
}

export function groupByFaceEmbedding(files: MediaFile[], threshold = 0.67): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const group of buildFaceIdentityGroups(files, threshold)) {
    groups[group.id] = group.paths;
  }
  return groups;
}

// Default app-level identity grouping should prefer splitting uncertain faces
// over merging different people. The UI exposes a lower Event threshold for
// difficult shoots with small, blurred, or profile faces.
export const FACE_GROUP_EMBEDDING_THRESHOLD = 0.6;

export function groupByFaceSimilarity(files: MediaFile[], embeddingThreshold = 0.67, signatureThreshold = 10): Record<string, string[]> {
  const combined: Record<string, string[]> = {};
  const groupedPaths = new Set<string>();
  let groupIndex = 1;

  const embeddingGroups = groupByFaceEmbedding(files, embeddingThreshold);
  for (const paths of Object.values(embeddingGroups)) {
    if (paths.length <= 1) continue;
    combined[`face-${groupIndex++}`] = paths;
    for (const path of paths) groupedPaths.add(path);
  }

  const signatureGroups = groupByFaceSignature(
    files.filter((file) => !groupedPaths.has(file.path)),
    signatureThreshold,
  );
  for (const paths of Object.values(signatureGroups)) {
    const remaining = paths.filter((path) => !groupedPaths.has(path));
    if (remaining.length <= 1) continue;
    combined[`face-${groupIndex++}`] = remaining;
    for (const path of remaining) groupedPaths.add(path);
  }

  return combined;
}

export function bestInGroup(files: MediaFile[]): MediaFile | null {
  if (files.length === 0) return null;
  return rankBestShots(files).find(isAutoBestCandidate) ?? null;
}

// ---------------------------------------------------------------------------
// Cull-to-target keeper selection
//
// Reduce a huge batch (e.g. 25k) down to a hard keeper budget (e.g. ~1000),
// keeping the strongest frame per near-duplicate group first so you get variety
// instead of 40 frames of one exchange. O(n log n) — uses the burst/visual/face
// group ids already computed on each file, so it scales past the O(n²) visual-
// hash grouping cap.
// ---------------------------------------------------------------------------

export interface KeeperTargetOptions {
  /** Hard cap on how many files to keep. */
  target: number;
  /** Retune scoring for a sports/event mode while selecting. */
  eventMode?: EventMode;
  /** Max keepers per near-duplicate group before the budget is spread wider. Default 1. */
  perGroupCap?: number;
  /**
   * Max perceptual-hash Hamming distance (out of 64 bits) for two frames to be
   * treated as visual near-duplicates. Catches consecutive identical frames and
   * RAW+JPEG pairs even when burst detection missed them (e.g. RAW files with no
   * parseable timestamp). 0 disables hash dedup. Default 8.
   */
  dedupeHashDistance?: number;
}

export interface KeeperTargetResult {
  keep: string[];
  reject: string[];
  target: number;
  kept: number;
  /** Always-kept files (protected / rated / manually selected). */
  mandatory: number;
  /** Distinct near-duplicate groups represented in the kept set. */
  groups: number;
  /** Frames dropped specifically because they were visual near-duplicates of a keeper. */
  dedupedNearDuplicates: number;
}

function diversityKey(file: MediaFile): string {
  return file.burstId
    ?? file.visualGroupId
    ?? file.faceGroupId
    ?? `solo:${file.path}`;
}

function isMandatoryKeeper(file: MediaFile): boolean {
  return !!file.isProtected || (file.rating ?? 0) > 0 || file.pick === 'selected';
}

function popcount32(value: number): number {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (v * 0x01010101) >>> 24;
}

/** Parse a 16-hex (64-bit) visualHash into two 32-bit halves for fast Hamming. */
function parseVisualHash(hash: string | undefined): { hi: number; lo: number } | null {
  if (!hash || hash.length < 16) return null;
  const hi = parseInt(hash.slice(0, 8), 16);
  const lo = parseInt(hash.slice(8, 16), 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return { hi: hi >>> 0, lo: lo >>> 0 };
}

/**
 * Tracks the perceptual hashes of frames already kept so visual near-duplicates
 * can be suppressed regardless of burst/group metadata. Buckets by the top 8
 * hash bits to keep the common case near-O(1); near-dups that cross a bucket
 * boundary are still caught by also scanning neighbouring buckets.
 */
class NearDuplicateIndex {
  private readonly buckets = new Map<number, Array<{ hi: number; lo: number }>>();
  constructor(private readonly threshold: number) {}

  private bucketKey(h: { hi: number }): number {
    return h.hi >>> 24; // top 8 bits
  }

  isNearDuplicate(h: { hi: number; lo: number }): boolean {
    if (this.threshold <= 0) return false;
    const base = this.bucketKey(h);
    // Scan a small neighbourhood of bucket keys so a flipped top bit can't hide
    // a near-duplicate. The threshold is small, so this stays cheap.
    for (let k = base - 1; k <= base + 1; k++) {
      const bucket = this.buckets.get(k & 0xff);
      if (!bucket) continue;
      for (const kept of bucket) {
        const dist = popcount32(h.hi ^ kept.hi) + popcount32(h.lo ^ kept.lo);
        if (dist <= this.threshold) return true;
      }
    }
    return false;
  }

  add(h: { hi: number; lo: number }): void {
    const key = this.bucketKey(h);
    const bucket = this.buckets.get(key);
    if (bucket) bucket.push(h);
    else this.buckets.set(key, [h]);
  }
}

export function selectKeepersToTarget(files: MediaFile[], options: KeeperTargetOptions): KeeperTargetResult {
  const target = Math.max(0, Math.floor(options.target));
  const perGroupCap = Math.max(1, Math.floor(options.perGroupCap ?? 1));
  const hashThreshold = Math.max(0, Math.floor(options.dedupeHashDistance ?? 8));
  const prevProfile = getReviewProfile();
  if (options.eventMode) configureReviewProfile(options.eventMode);

  try {
    const keep = new Set<string>();
    const groupCount = new Map<string, number>();
    const hashIndex = new NearDuplicateIndex(hashThreshold);
    let mandatoryCount = 0;
    let dedupedNearDuplicates = 0;

    const recordHash = (file: MediaFile): void => {
      const h = parseVisualHash(file.visualHash);
      if (h) hashIndex.add(h);
    };

    // 1. Always keep protected / rated / manually selected — even past target.
    for (const file of files) {
      if (file.pick === 'rejected') continue;
      if (isMandatoryKeeper(file)) {
        keep.add(file.path);
        const key = diversityKey(file);
        groupCount.set(key, (groupCount.get(key) ?? 0) + 1);
        recordHash(file);
        mandatoryCount++;
      }
    }

    // 2. Rank the remaining candidates by keeper score (sports-aware if set).
    const candidates = files
      .filter((file) => file.pick !== 'rejected' && !keep.has(file.path))
      .map((file) => ({ file, score: keeperScore(file), key: diversityKey(file), hash: parseVisualHash(file.visualHash) }))
      .sort((a, b) => b.score - a.score || a.file.name.localeCompare(b.file.name));

    const take = (cand: typeof candidates[number]): void => {
      keep.add(cand.file.path);
      groupCount.set(cand.key, (groupCount.get(cand.key) ?? 0) + 1);
      if (cand.hash) hashIndex.add(cand.hash);
    };

    // 3. First pass — one (perGroupCap) best frame per group AND not a visual
    //    near-duplicate of an already-kept frame. This is what stops 7 nearly
    //    identical RAW frames (or RAW+JPEG pairs) all surviving the cull.
    for (const cand of candidates) {
      if (keep.size >= target) break;
      if ((groupCount.get(cand.key) ?? 0) >= perGroupCap) continue;
      if (cand.hash && hashIndex.isNearDuplicate(cand.hash)) { dedupedNearDuplicates++; continue; }
      take(cand);
    }

    // 4. Second pass — if the budget isn't met, relax the per-group cap but keep
    //    suppressing visual near-duplicates so we add genuinely different frames.
    if (keep.size < target) {
      for (const cand of candidates) {
        if (keep.size >= target) break;
        if (keep.has(cand.file.path)) continue;
        if (cand.hash && hashIndex.isNearDuplicate(cand.hash)) continue;
        take(cand);
      }
    }

    // 5. Final pass — only if STILL short of budget, fill with the next best
    //    frames regardless of similarity so the requested count is honoured.
    if (keep.size < target) {
      for (const cand of candidates) {
        if (keep.size >= target) break;
        if (keep.has(cand.file.path)) continue;
        take(cand);
      }
    }

    const reject = files.filter((file) => !keep.has(file.path)).map((file) => file.path);
    return {
      keep: [...keep],
      reject,
      target,
      kept: keep.size,
      mandatory: mandatoryCount,
      groups: groupCount.size,
      dedupedNearDuplicates,
    };
  } finally {
    configureReviewProfile(prevProfile);
  }
}
