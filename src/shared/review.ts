import type { CullingGenre, CullConfidence, EventMode, KeeperQuota, MediaFile, PoseKeypoint, PoseKeypoints } from './types';
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
let activeCullingGenre: CullingGenre = 'auto';

export function configureReviewProfile(mode: EventMode | undefined): void {
  activeEventMode = mode ?? 'general';
}

export function getReviewProfile(): EventMode {
  return activeEventMode;
}

export function configureCullingGenre(genre: CullingGenre | undefined): void {
  activeCullingGenre = genre ?? 'auto';
}

export function getCullingGenre(): CullingGenre {
  return activeCullingGenre;
}

function sportsModeActive(): boolean {
  return isSportsEventMode(activeEventMode);
}

function activeGenre(): CullingGenre {
  if (activeCullingGenre !== 'auto') return activeCullingGenre;
  if (sportsModeActive()) return 'sports';
  if (activeEventMode === 'landscape' || activeEventMode === 'architecture' || activeEventMode === 'interior') {
    return activeEventMode;
  }
  return 'auto';
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
  sceneAnalysis?: MediaFile['sceneAnalysis'];
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

type SubjectSharpnessInput = Pick<MediaFile, 'subjectSharpnessScore' | 'sceneAnalysis'> &
  Partial<Pick<MediaFile, 'faceCount' | 'faceBoxes' | 'personCount' | 'personBoxes'>>;

function hasDetectedSubject(file: SubjectSharpnessInput): boolean {
  return (file.faceCount ?? file.faceBoxes?.length ?? 0) > 0 ||
    (file.personCount ?? file.personBoxes?.length ?? 0) > 0;
}

function subjectFocusConfidence(file: SubjectSharpnessInput): number | undefined {
  const confidence = file.sceneAnalysis?.subjectFocusConfidence;
  return typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : undefined;
}

function resolvedSubjectSharpness(file: SubjectSharpnessInput): number | undefined {
  const scene = file.sceneAnalysis;
  if (hasDetectedSubject(file) && scene) {
    if (
      typeof scene?.subjectSharpnessScore === 'number' &&
      Number.isFinite(scene.subjectSharpnessScore) &&
      (subjectFocusConfidence(file) ?? 0) >= 0.2
    ) {
      return scene.subjectSharpnessScore;
    }
    // A centre-weighted legacy score frequently measures a crisp background.
    // Once scene analysis has begun for a detected subject it is not valid
    // fallback evidence: wait for a reliable ROI measurement instead.
    return undefined;
  }
  // Backwards compatibility for sessions that predate scene ROI analysis. Bulk
  // proposal readiness still treats detected boxes without ROI confidence as
  // unanalysed, so this legacy value cannot drive a new automatic decision.
  return file.subjectSharpnessScore;
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
  file: Pick<MediaFile, 'sharpnessScore' | 'subjectSharpnessScore' | 'sceneAnalysis' | 'blurRisk'> &
    Partial<Pick<MediaFile, 'faceCount' | 'faceBoxes' | 'personCount' | 'personBoxes'>>,
): number {
  if (file.blurRisk === 'high') return 0;
  const resolved = resolvedSubjectSharpness(file);
  if (hasDetectedSubject(file) && resolved === undefined) return 0;
  const subject = resolved ?? file.sharpnessScore ?? 0;
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
  file: Pick<MediaFile, 'faceCount' | 'faceBoxes' | 'faceDetection' | 'subjectSharpnessScore' | 'sceneAnalysis'>,
): number {
  const boxes = file.faceBoxes ?? [];
  const faceCount = file.faceCount ?? boxes.length;
  if (faceCount <= 0) return 0;

  const avgDetection = boxes.length > 0
    ? boxes.reduce((sum, box) => sum + clamp01(box.score, file.faceDetection === 'estimated' ? 0.45 : 0.78), 0) / boxes.length
    : (file.faceDetection === 'estimated' ? 0.38 : 0.58);
  const largestFaceArea = boxes.reduce((best, box) => Math.max(best, box.width * box.height), 0);
  const areaSignal = boxes.length > 0 ? clamp01(largestFaceArea / 0.035) : 0.35;
  const subjectSharpness = resolvedSubjectSharpness(file);
  const sharpSignal = typeof subjectSharpness === 'number'
    ? clamp01(subjectSharpness / 135)
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

type FaceBoxSignal = NonNullable<MediaFile['faceBoxes']>[number];

/**
 * Normalized eye-region detail. Missing analysis is deliberately neutral: an
 * older cache entry or a face that was not large enough to inspect must not be
 * scored as though the eyes were known to be soft/closed.
 */
function eyeDetailSignal(box: FaceBoxSignal, fallback = 0.5): number {
  if (typeof box.eyeSharpness === 'number' && Number.isFinite(box.eyeSharpness)) {
    return clamp01(box.eyeSharpness);
  }
  if (typeof box.eyeScore === 'number' && Number.isFinite(box.eyeScore)) {
    return clamp01(box.eyeScore / 2);
  }
  return fallback;
}

function hasEyeDetailSignal(box: FaceBoxSignal): boolean {
  return (typeof box.eyeSharpness === 'number' && Number.isFinite(box.eyeSharpness)) ||
    (typeof box.eyeScore === 'number' && Number.isFinite(box.eyeScore));
}

export function humanMomentQuality(
  file: Pick<MediaFile, 'faceCount' | 'faceBoxes' | 'personCount' | 'personBoxes' | 'subjectSharpnessScore' | 'sceneAnalysis'>,
): number {
  const faceBoxes = file.faceBoxes ?? [];
  const personBoxes = file.personBoxes ?? [];
  const faceCount = file.faceCount ?? faceBoxes.length;
  const personCount = file.personCount ?? personBoxes.length;
  const sharp = Math.min(24, (resolvedSubjectSharpness(file) ?? 0) / 6);

  if (faceBoxes.length > 0) {
    const eyeScores = faceBoxes.map((box) => eyeDetailSignal(box));
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

export function faceQuality(file: Pick<MediaFile, 'faceCount' | 'faceBoxes' | 'faceDetection' | 'subjectSharpnessScore' | 'sceneAnalysis'>): number {
  const boxes = file.faceBoxes ?? [];
  // Keep the historical 0..2 weighting while treating an unmeasured eye region
  // as the midpoint rather than the worst possible result.
  const eyeDetails = boxes.map((box) => eyeDetailSignal(box) * 2);
  const bestEye = eyeDetails.reduce((best, detail) => Math.max(best, detail), 0);
  const eyeSum = eyeDetails.reduce((sum, detail) => sum + detail, 0);
  const expression = boxes.reduce((sum, box) => sum + clamp01(box.smileScore ?? box.expressionScore, 0.5), 0);
  const faceCount = file.faceCount ?? boxes.length;
  const faceArea = boxes.reduce((sum, box) => sum + box.width * box.height, 0);
  const largestFaceArea = boxes.reduce((best, box) => Math.max(best, box.width * box.height), 0);
  const sharp = Math.min(60, (resolvedSubjectSharpness(file) ?? 0) / 3);
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
  file: Pick<MediaFile, 'faceCount' | 'faceBoxes' | 'faceDetection' | 'personCount' | 'personBoxes' | 'subjectSharpnessScore' | 'sceneAnalysis'>,
): number {
  const face = faceQuality(file);
  const personBoxes = file.personBoxes ?? [];
  const personCount = file.personCount ?? personBoxes.length;
  const personArea = personBoxes.reduce((sum, box) => sum + box.width * box.height, 0);
  const personScore = Math.round(
    Math.min(personCount, 3) * 12 +
    Math.min(26, personArea * 90) +
    Math.min(20, (resolvedSubjectSharpness(file) ?? 0) / 5),
  );
  return Math.max(face, personScore);
}

export function focusQuality(
  file: Pick<MediaFile, 'sharpnessScore' | 'subjectSharpnessScore' | 'sceneAnalysis' | 'blurRisk' | 'faceCount' | 'faceBoxes' | 'personCount' | 'personBoxes'>,
): number {
  const wholeSharp = file.sharpnessScore ?? 0;
  const subjectSharp = resolvedSubjectSharpness(file);
  const hasSubjects =
    (file.faceCount ?? file.faceBoxes?.length ?? 0) > 0 ||
    (file.personCount ?? file.personBoxes?.length ?? 0) > 0;
  const wholeSignal = clamp01((wholeSharp - 45) / 135);
  const subjectSignal = typeof subjectSharp === 'number'
    ? clamp01((subjectSharp - (hasSubjects ? 38 : 48)) / (hasSubjects ? 82 : 92))
    : hasSubjects ? 0.5 : wholeSignal;
  const combined = hasSubjects
    ? subjectSignal * 0.72 + wholeSignal * 0.28
    : Math.max(subjectSignal, wholeSignal * 0.92);

  if (file.blurRisk === 'high') return Math.min(combined, 0.32);
  if (file.blurRisk === 'medium') return Math.min(combined, 0.68);
  return combined;
}

// ---------------------------------------------------------------------------
// Genre-aware scene scoring
// ---------------------------------------------------------------------------

export interface GenreScoreBreakdown {
  genre: Exclude<CullingGenre, 'auto'>;
  score: number;
  confidence: number;
  reasons: string[];
  cautions: string[];
}

function hasPeople(file: MediaFile): boolean {
  return (file.faceCount ?? file.faceBoxes?.length ?? 0) > 0 ||
    (file.personCount ?? file.personBoxes?.length ?? 0) > 0;
}

function inferredGenre(file: MediaFile, requested: CullingGenre = 'auto'): Exclude<CullingGenre, 'auto'> {
  if (requested !== 'auto') return requested;
  if (sportsModeActive()) return 'sports';
  if (activeEventMode === 'landscape' || activeEventMode === 'architecture' || activeEventMode === 'interior') {
    return activeEventMode;
  }
  const faces = file.faceCount ?? file.faceBoxes?.length ?? 0;
  const persons = file.personCount ?? file.personBoxes?.length ?? 0;
  if (faces >= 3 || persons >= 3) return 'group';
  if (faces > 0 || persons > 0) return 'portrait';
  const scene = file.sceneAnalysis;
  if (scene && clamp01(scene.confidence) >= 0.52 && scene.kind !== 'people') return scene.kind;
  if (isDetailStoryKeeper(file)) return 'detail';
  return 'general';
}

function measured(values: Array<number | undefined>): number {
  let count = 0;
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) count++;
  }
  return count;
}

function sceneMetricConfidence(file: MediaFile, genre: Exclude<CullingGenre, 'auto'>): number {
  if (genre === 'portrait' || genre === 'group') return faceSignalConfidence(file);
  if (genre === 'sports') {
    const people = hasPeople(file) ? 0.35 : 0;
    const pose = (file.poses?.length ?? 0) > 0 ? 0.35 : (file.personBoxes?.length ?? 0) > 0 ? 0.18 : 0;
    const focus = typeof resolvedSubjectSharpness(file) === 'number' || typeof file.sharpnessScore === 'number' ? 0.2 : 0;
    return clamp01(people + pose + focus + 0.1);
  }
  const scene = file.sceneAnalysis;
  if (!scene) return 0.2;
  const geometryCount = measured([
    scene.focusCoverage, scene.focusUniformity, scene.edgeSharpness, scene.centerSharpness,
    scene.cornerSharpness, scene.highlightClipping, scene.shadowClipping, scene.dynamicRange,
    scene.compositionBalance, scene.lineStrength,
  ]);
  const tiltCount = measured([scene.horizonTiltDeg, scene.verticalTiltDeg]);
  return clamp01(clamp01(scene.confidence) * 0.55 + Math.min(0.35, geometryCount * 0.045) + Math.min(0.1, tiltCount * 0.05));
}

function normalizedSharpness(value: number | undefined, floor = 35, span = 125): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.5;
  return clamp01((Math.sqrt(Math.max(0, value)) - Math.sqrt(floor)) /
    Math.max(1e-6, Math.sqrt(floor + span) - Math.sqrt(floor)));
}

function clippingQuality(value: number | undefined, gentleLimit: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.5;
  return clamp01(1 - clamp01(value) / gentleLimit);
}

function tiltQuality(value: number | undefined, toleranceDeg: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.5;
  return clamp01(1 - Math.abs(value) / toleranceDeg);
}

/** Pure deterministic score details used by ranking, proposal previews and tests. */
export function scoreGenre(file: MediaFile, requestedGenre: CullingGenre = 'auto'): GenreScoreBreakdown {
  const genre = inferredGenre(file, requestedGenre);
  const scene = file.sceneAnalysis;
  const reasons: string[] = [];
  const cautions: string[] = [];
  const confidence = sceneMetricConfidence(file, genre);
  let quality = 0;

  if (genre === 'portrait') {
    const face = clamp01(faceQuality(file) / 150);
    const moment = clamp01(humanMomentQuality(file) / 125);
    const focus = focusQuality(file);
    quality = face * 0.38 + moment * 0.35 + focus * 0.27;
    if (moment >= 0.7) reasons.push('strong eye/expression moment');
    if (focus >= 0.7) reasons.push('sharp subject');
    if (weakFacePenalty(file) >= 42) cautions.push('uncertain eye/face detail');
  } else if (genre === 'group') {
    const coverage = clamp01(groupCoverageQuality(file) / 34);
    const weakest = weakestFaceSignal(file);
    const focus = focusQuality(file);
    quality = coverage * 0.42 + weakest * 0.32 + focus * 0.26;
    if (coverage >= 0.7) reasons.push('strong group coverage');
    if (weakest >= 0.62) reasons.push('consistent face detail');
    if (weakest < 0.48) cautions.push('one or more faces need review');
  } else if (genre === 'sports') {
    const action = clamp01((sportsActionQuality(file) + 40) / 250);
    const focus = focusQuality(file);
    const contact = Math.max(athleteContactSignal(file), poseContactSignal(file));
    quality = action * 0.5 + focus * 0.3 + contact * 0.2;
    if (contact >= 0.5) reasons.push('peak athlete contact');
    if (frozenActionSignal(file) >= 0.55) reasons.push('frozen action');
    if (file.blurRisk === 'high') cautions.push('high motion blur risk');
  } else {
    const wholeFocus = focusQuality(file);
    const coverage = clamp01(scene?.focusCoverage, 0.5);
    const uniformity = clamp01(scene?.focusUniformity, 0.5);
    const edge = normalizedSharpness(scene?.edgeSharpness ?? file.sharpnessScore);
    const center = normalizedSharpness(scene?.centerSharpness ?? file.subjectSharpnessScore ?? file.sharpnessScore);
    const corner = normalizedSharpness(scene?.cornerSharpness);
    const highlights = clippingQuality(scene?.highlightClipping, genre === 'interior' ? 0.2 : 0.14);
    const shadows = clippingQuality(scene?.shadowClipping, genre === 'interior' ? 0.28 : 0.2);
    const dynamicRange = clamp01(scene?.dynamicRange, 0.5);
    const composition = clamp01(scene?.compositionBalance, 0.5);
    const lineStrength = clamp01(scene?.lineStrength, 0.5);
    const horizon = tiltQuality(scene?.horizonTiltDeg, 5);
    const vertical = tiltQuality(scene?.verticalTiltDeg, 6);

    if (genre === 'landscape') {
      quality = coverage * 0.18 + uniformity * 0.14 + edge * 0.1 + corner * 0.08 +
        highlights * 0.12 + shadows * 0.07 + dynamicRange * 0.1 + composition * 0.12 + horizon * 0.09;
      if (coverage >= 0.72 && uniformity >= 0.65) reasons.push('broad edge-to-edge focus');
      if (horizon >= 0.8) reasons.push('level horizon');
      if (scene?.highlightClipping !== undefined && highlights < 0.35) cautions.push('highlight clipping risk');
    } else if (genre === 'architecture') {
      quality = edge * 0.18 + corner * 0.12 + coverage * 0.12 + uniformity * 0.1 +
        lineStrength * 0.14 + vertical * 0.14 + composition * 0.1 + highlights * 0.06 + shadows * 0.04;
      if (lineStrength >= 0.7 && edge >= 0.65) reasons.push('crisp structural lines');
      if (vertical >= 0.8) reasons.push('controlled verticals');
      if (scene?.verticalTiltDeg !== undefined && vertical < 0.35) cautions.push('vertical perspective needs review');
    } else if (genre === 'interior') {
      quality = coverage * 0.15 + uniformity * 0.14 + corner * 0.12 + center * 0.08 +
        highlights * 0.14 + shadows * 0.1 + dynamicRange * 0.08 + composition * 0.09 + vertical * 0.1;
      if (coverage >= 0.7 && corner >= 0.6) reasons.push('room detail holds into corners');
      if (highlights >= 0.7 && shadows >= 0.65) reasons.push('balanced interior exposure');
      if (scene?.highlightClipping !== undefined && highlights < 0.35) cautions.push('window/highlight clipping risk');
    } else if (genre === 'detail') {
      quality = center * 0.35 + wholeFocus * 0.25 + composition * 0.2 + highlights * 0.12 + shadows * 0.08;
      if (center >= 0.7) reasons.push('crisp focal detail');
    } else {
      quality = wholeFocus * 0.32 + coverage * 0.12 + uniformity * 0.1 + highlights * 0.11 +
        shadows * 0.08 + dynamicRange * 0.08 + composition * 0.12 + center * 0.07;
      if (wholeFocus >= 0.7) reasons.push('strong overall sharpness');
    }

    if (file.blurRisk === 'high') cautions.push('high blur risk');
    if (scene && scene.kind !== 'general' && scene.kind !== genre && clamp01(scene.confidence) >= 0.7) {
      cautions.push(`scene analysis suggests ${scene.kind}`);
    }
  }

  if (confidence < 0.5) cautions.push('limited analysis confidence');
  return {
    genre,
    score: Math.round(clamp01(quality) * 100),
    confidence: Math.round(confidence * 100) / 100,
    reasons: reasons.slice(0, 3),
    cautions: cautions.slice(0, 3),
  };
}

function genreScoreBonus(file: MediaFile): number {
  const requested = activeGenre();
  // Preserve historical general-mode ranking unless a specialised scene metric
  // or explicit profile is available.
  if (requested === 'auto' && !file.sceneAnalysis) return 0;
  const result = scoreGenre(file, requested);
  const confidenceWeight = 0.35 + result.confidence * 0.65;
  return Math.round((result.score - 50) * 1.35 * confidenceWeight);
}

export function isUsablyFocused(
  file: Pick<MediaFile, 'sharpnessScore' | 'subjectSharpnessScore' | 'sceneAnalysis' | 'blurRisk' | 'faceCount' | 'faceBoxes' | 'personCount' | 'personBoxes'>,
): boolean {
  const hasSubjects =
    (file.faceCount ?? file.faceBoxes?.length ?? 0) > 0 ||
    (file.personCount ?? file.personBoxes?.length ?? 0) > 0;
  if (file.blurRisk === 'high') return false;
  const subjectSharpness = resolvedSubjectSharpness(file);
  if (hasSubjects && subjectSharpness === undefined) return false;
  if (hasSubjects && typeof subjectSharpness === 'number' && subjectSharpness < 45) return false;
  return focusQuality(file) >= (hasSubjects ? 0.34 : 0.4);
}

export function keeperScore(file: MediaFile): number {
  return (
    (file.isProtected ? 120 : 0) +
    (file.rating ?? 0) * 30 +
    subjectPresenceQuality(file) +
    Math.min(70, (resolvedSubjectSharpness(file) ?? 0) / 2.4) +
    Math.min(45, (file.sharpnessScore ?? 0) / 6) +
    Math.min(55, file.reviewScore ?? 0) -
    (file.blurRisk === 'high' ? 90 : file.blurRisk === 'medium' ? 30 : 0) +
    (sportsModeActive() ? sportsActionQuality(file) : 0) +
    genreScoreBonus(file)
  );
}

export function bestShotScore(file: MediaFile): number {
  const face = faceQuality(file);
  const subject = subjectPresenceQuality(file);
  const subjectSharp = resolvedSubjectSharpness(file) ?? 0;
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
  score += genreScoreBonus(file);
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
  const people = (file.faceCount ?? file.faceBoxes?.length ?? 0) > 0 ||
    (file.personCount ?? file.personBoxes?.length ?? 0) > 0;
  if (!people) {
    if (eventMode === 'landscape') return 'Landscape';
    if (eventMode === 'architecture') return 'Architecture / exterior';
    if (eventMode === 'interior') return 'Interior / rooms';
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
    subjectSharpness: resolvedSubjectSharpness(file) ?? 0,
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

function proposalComparisonConfidence(
  best: MediaFile | null,
  runnerUp: MediaFile | undefined,
  genre: CullingGenre,
): AutoCullDecision['confidence'] {
  if (!best || !runnerUp) return 'low';
  if (
    (hasDetectedSubject(best) && (subjectFocusConfidence(best) ?? 0) < 0.2) ||
    (hasDetectedSubject(runnerUp) && (subjectFocusConfidence(runnerUp) ?? 0) < 0.2)
  ) return 'low';
  const bestAnalysis = scoreGenre(best, genre);
  const runnerAnalysis = scoreGenre(runnerUp, genre);
  const evidence = Math.min(bestAnalysis.confidence, runnerAnalysis.confidence);
  if (evidence < 0.5) return 'low';
  const scoreGap = Math.max(0, bestShotScore(best) - bestShotScore(runnerUp));
  const genreGap = Math.max(0, bestAnalysis.score - runnerAnalysis.score);
  if (scoreGap >= 72 && (genreGap >= 16 || evidence >= 0.82)) return 'high';
  if (scoreGap >= 28 || genreGap >= 18) return 'medium';
  return 'low';
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
    const eye = eyeDetailSignal(box);
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
    eyeDetailSignal(box) >= 0.5 &&
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
  if (runnerUp && bestHuman - runnerHuman >= 12) pushUnique(wins, `Better eye/expression detail +${bestHuman - runnerHuman}`);

  const bestSubject = resolvedSubjectSharpness(best) ?? best.sharpnessScore;
  const runnerSubject = runnerUp ? resolvedSubjectSharpness(runnerUp) ?? runnerUp.sharpnessScore : undefined;
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

  const requestedGenre = activeGenre();
  if (runnerUp && (requestedGenre !== 'auto' || best.sceneAnalysis || runnerUp.sceneAnalysis)) {
    const bestGenre = scoreGenre(best, requestedGenre);
    const runnerGenre = scoreGenre(runnerUp, requestedGenre);
    const genreGap = bestGenre.score - runnerGenre.score;
    if (bestGenre.confidence >= 0.5 && runnerGenre.confidence >= 0.5 && genreGap >= 12) {
      pushUnique(wins, `Stronger ${bestGenre.genre} quality +${genreGap}`);
      if (bestGenre.reasons[0]) pushUnique(wins, bestGenre.reasons[0]);
    }
    for (const caution of bestGenre.cautions) pushUnique(cautions, caution);
  }

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
  /** Optional explicit profile; omitted preserves the configured legacy profile. */
  eventMode?: EventMode;
  /** Optional genre override; omitted preserves automatic inference. */
  genre?: CullingGenre;
}

function genreComparisonReasons(best: MediaFile, candidate: MediaFile): string[] {
  const genre = activeGenre();
  const bestGenre = scoreGenre(best, genre);
  const candidateGenre = scoreGenre(candidate, genre);
  // Low-confidence scene inference must not become extra rejection evidence.
  if (bestGenre.confidence < 0.5 || candidateGenre.confidence < 0.5) return [];

  const reasons: string[] = [];
  if (bestGenre.score - candidateGenre.score >= 18) {
    reasons.push(`weaker ${bestGenre.genre} quality`);
  }
  if (bestGenre.genre === 'sports' && sportsActionQuality(best) - sportsActionQuality(candidate) >= 48) {
    reasons.push('weaker action moment');
  }
  if (bestGenre.genre === 'group' && groupCoverageQuality(best) - groupCoverageQuality(candidate) >= 10) {
    reasons.push('weaker group coverage');
  }

  const bestScene = best.sceneAnalysis;
  const candidateScene = candidate.sceneAnalysis;
  if (bestScene && candidateScene) {
    const bestClipping = clamp01(bestScene.highlightClipping) + clamp01(bestScene.shadowClipping);
    const candidateClipping = clamp01(candidateScene.highlightClipping) + clamp01(candidateScene.shadowClipping);
    if (candidateClipping - bestClipping >= 0.18) reasons.push('more highlight/shadow clipping');
    if (clamp01(bestScene.focusCoverage) - clamp01(candidateScene.focusCoverage) >= 0.2) reasons.push('less focus coverage');
    if (clamp01(bestScene.focusUniformity) - clamp01(candidateScene.focusUniformity) >= 0.2) reasons.push('less even scene focus');
    if ((bestGenre.genre === 'architecture' || bestGenre.genre === 'interior') &&
      typeof bestScene.verticalTiltDeg === 'number' && typeof candidateScene.verticalTiltDeg === 'number' &&
      Math.abs(candidateScene.verticalTiltDeg) - Math.abs(bestScene.verticalTiltDeg) >= 2.5) {
      reasons.push('weaker vertical alignment');
    }
    if (bestGenre.genre === 'landscape' &&
      typeof bestScene.horizonTiltDeg === 'number' && typeof candidateScene.horizonTiltDeg === 'number' &&
      Math.abs(candidateScene.horizonTiltDeg) - Math.abs(bestScene.horizonTiltDeg) >= 2.5) {
      reasons.push('less level horizon');
    }
  }
  return reasons;
}

function weakestFaceSignal(file: Pick<MediaFile, 'faceBoxes'>): number {
  const boxes = file.faceBoxes ?? [];
  if (boxes.length === 0) return 1;
  return Math.min(...boxes.map((box) => {
    const eye = eyeDetailSignal(box);
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
      (resolvedSubjectSharpness(b) ?? b.sharpnessScore ?? 0) - (resolvedSubjectSharpness(a) ?? a.sharpnessScore ?? 0),
    )[0];
    if (smileBest) keep.add(smileBest.path);
    if (sharpBest) keep.add(sharpBest.path);
  }
}

function autoCullGroupWithActiveProfile(files: MediaFile[], options: AutoCullOptions): AutoCullDecision {
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
    if (bestHumanMoment - fileHumanMoment >= 28) fileReasons.push('weaker eye/expression detail');
    if (bestFaceCount >= 2 && bestFaceCount - fileFaceCount >= 1) fileReasons.push('missing group faces');
    if (bestPersonCount >= 2 && bestPersonCount - filePersonCount >= 1) fileReasons.push('fewer people detected');
    if (groupMode && bestFaceCount >= 2 && weakFace < 0.58 && bestWeakestFace - weakFace >= 0.12) fileReasons.push('unclear eye/face detail');
    if (groupMode && (bestFaceCount >= 2 || bestPersonCount >= 2) && (fileFaceCount < bestFaceCount || filePersonCount < bestPersonCount)) fileReasons.push('everyone-good miss');
    if ((resolvedSubjectSharpness(best) ?? 0) - (resolvedSubjectSharpness(file) ?? 0) >= 28) fileReasons.push('softer subject');
    if ((best.reviewScore ?? 0) - (file.reviewScore ?? 0) >= 22) fileReasons.push('lower review score');
    for (const reason of genreComparisonReasons(best, file)) pushUnique(fileReasons, reason);
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

export function autoCullGroup(files: MediaFile[], options: AutoCullOptions = {}): AutoCullDecision {
  const previousMode = getReviewProfile();
  const previousGenre = getCullingGenre();
  if (options.eventMode) configureReviewProfile(options.eventMode);
  if (options.genre) configureCullingGenre(options.genre);
  try {
    return autoCullGroupWithActiveProfile(files, options);
  } finally {
    configureReviewProfile(previousMode);
    configureCullingGenre(previousGenre);
  }
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

interface MetricSearchNode<TKey, TValue> {
  key: TKey;
  value: TValue;
  children: Map<number, MetricSearchNode<TKey, TValue>>;
}

/**
 * Exact metric search using a BK-tree. Only one representative is stored for
 * identical keys, which avoids quadratic work for shoots containing many
 * copies of the same perceptual hash.
 */
class MetricSearchIndex<TKey, TValue> {
  private root: MetricSearchNode<TKey, TValue> | null = null;

  constructor(private readonly distance: (a: TKey, b: TKey) => number) {}

  add(key: TKey, value: TValue): void {
    if (!this.root) {
      this.root = { key, value, children: new Map() };
      return;
    }

    let node = this.root;
    while (true) {
      const edge = this.distance(key, node.key);
      if (edge === 0) return;
      const child = node.children.get(edge);
      if (child) node = child;
      else {
        node.children.set(edge, { key, value, children: new Map() });
        return;
      }
    }
  }

  findWithin(key: TKey, threshold: number): TValue[] {
    if (!this.root || threshold < 0) return [];
    const matches: TValue[] = [];
    const pending = [this.root];

    while (pending.length > 0) {
      const node = pending.pop()!;
      const distance = this.distance(key, node.key);
      if (distance <= threshold) matches.push(node.value);
      const minimumEdge = Math.max(0, distance - threshold);
      const maximumEdge = distance + threshold;
      for (const [edge, child] of node.children) {
        if (edge >= minimumEdge && edge <= maximumEdge) pending.push(child);
      }
    }

    return matches;
  }
}

export function scoreReview(input: ReviewScoreInput): ReviewScore {
  const sharpness = input.sharpnessScore ?? 0;
  const measuredSubjectSharpness = resolvedSubjectSharpness(input);
  const subjectSharpness = measuredSubjectSharpness ?? 0;
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
    const measuredEyes = faceBoxes.filter(hasEyeDetailSignal);
    if (measuredEyes.length > 0) {
      const eyeDetail = measuredEyes.reduce((best, box) => Math.max(best, eyeDetailSignal(box)), 0);
      if (eyeDetail >= 0.75) reasons.push('strong eye detail');
      else if (eyeDetail >= 0.45) reasons.push('usable eye detail');
    }
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

  // When a person is detected, focus on the subject region. A crisp background
  // must not turn a visibly soft face/body into a low-blur keeper.
  const hasDetectedSubject = faceCount > 0 || personCount > 0;
  const subjectFocusPending = hasDetectedSubject && measuredSubjectSharpness === undefined;
  const blurSharpness = subjectFocusPending ? undefined : measuredSubjectSharpness ?? sharpness;
  const blurRisk: ReviewScore['blurRisk'] = subjectFocusPending
    ? 'medium'
    : (blurSharpness ?? 0) < 25 ? 'high'
      : (blurSharpness ?? 0) < 70 ? 'medium'
        : 'low';
  if (subjectFocusPending) {
    // `medium` is the existing review-needed state. Do not label the subject
    // soft, because a low-confidence ROI is unknown rather than known-bad.
    reasons.push('subject focus needs review');
  } else {
    if (blurRisk === 'high') score -= 25;
    if (blurRisk === 'medium') score -= 8;
    if (blurRisk !== 'low' && !reasons.includes('soft')) reasons.push('soft');
  }

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

function groupByHexSimilarity(
  files: MediaFile[],
  hashFor: (file: MediaFile) => string | undefined,
  threshold: number,
  prefix: string,
): Record<string, string[]> {
  const hashed = files
    .map((file, order) => ({ file, hash: hashFor(file), order }))
    .filter((entry): entry is { file: MediaFile; hash: string; order: number } => !!entry.hash);

  const parent = new Map<string, string>();
  const searchThreshold = Math.max(0, Math.floor(threshold));
  const hashIndex = new MetricSearchIndex<string, typeof hashed[number]>(hammingDistanceHex);

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
  for (const entry of hashed) {
    for (const match of hashIndex.findWithin(entry.hash, searchThreshold)) {
      union(entry.file.path, match.file.path);
    }
    hashIndex.add(entry.hash, entry);
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
  /** Override automatic genre inference while selecting. */
  genre?: CullingGenre;
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
 * can be suppressed regardless of burst/group metadata. Metric search checks
 * every Hamming-neighbourhood exactly, including hashes whose first differing
 * bit puts them in a numerically distant top-byte bucket.
 */
class NearDuplicateIndex {
  private readonly index = new MetricSearchIndex<{ hi: number; lo: number }, true>(
    (a, b) => popcount32(a.hi ^ b.hi) + popcount32(a.lo ^ b.lo),
  );

  constructor(private readonly threshold: number) {}

  isNearDuplicate(h: { hi: number; lo: number }): boolean {
    if (this.threshold <= 0) return false;
    return this.index.findWithin(h, this.threshold).length > 0;
  }

  add(h: { hi: number; lo: number }): void {
    this.index.add(h, true);
  }
}

export function selectKeepersToTarget(files: MediaFile[], options: KeeperTargetOptions): KeeperTargetResult {
  const target = Math.max(0, Math.floor(options.target));
  const perGroupCap = Math.max(1, Math.floor(options.perGroupCap ?? 1));
  const hashThreshold = Math.max(0, Math.floor(options.dedupeHashDistance ?? 8));
  const prevProfile = getReviewProfile();
  const prevGenre = getCullingGenre();
  if (options.eventMode) configureReviewProfile(options.eventMode);
  if (options.genre) configureCullingGenre(options.genre);

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
    configureCullingGenre(prevGenre);
  }
}

// ---------------------------------------------------------------------------
// Non-destructive automated culling proposals
// ---------------------------------------------------------------------------

export interface AutoCullProposalOptions extends AutoCullOptions {
  /** Visual-hash distance used to form deterministic comparison groups. */
  visualHashDistance?: number;
  /** When true, already camera/import-marked duplicates are omitted. */
  skipDuplicates?: boolean;
}

export type AutoCullProposalDisposition = 'keep' | 'reject' | 'uncertain' | 'unanalysed';

export interface AutoCullProposalItem {
  path: string;
  disposition: AutoCullProposalDisposition;
  score: number;
  genre: Exclude<CullingGenre, 'auto'>;
  analysisConfidence: number;
  reasons: string[];
}

export interface AutoCullProposalGroup {
  id: string;
  kind: 'burst' | 'visual' | 'standalone';
  paths: string[];
  bestPath?: string;
  confidence: AutoCullDecision['confidence'];
  items: AutoCullProposalItem[];
}

export interface AutoCullProposal {
  eventMode: EventMode;
  genre: CullingGenre;
  keep: string[];
  reject: string[];
  uncertain: string[];
  unanalysed: string[];
  groups: AutoCullProposalGroup[];
  reasons: Record<string, string[]>;
  /** Always false: the API is advisory and never mutates MediaFile.pick. */
  automaticDeletion: false;
}

export function hasCullingAnalysis(file: MediaFile): boolean {
  if (file.reviewAnalysisUnavailable) return false;
  if (file.reviewAnalysisStage === 'screened') {
    // A face-only pass cannot rule out a turned-away person. Treat every
    // screened record as provisional: grouping can be derived later from its
    // visual hash, before burst/visualGroup metadata has reached the file.
    // The subjects/body pass promotes it to a cullable analysis depth.
    return false;
  }
  const hasSubjectBoxes = (file.faceBoxes?.length ?? 0) > 0 || (file.personBoxes?.length ?? 0) > 0;
  // ONNX boxes arrive before the renderer's follow-up ROI pass. Treat that
  // interval as genuinely unanalysed so a bulk proposal cannot race ahead of
  // subject focus. A finite low confidence means the pass completed, but its
  // disposition is handled conservatively below.
  if (hasSubjectBoxes && subjectFocusConfidence(file) === undefined) return false;
  return typeof file.reviewScore === 'number' ||
    typeof file.sharpnessScore === 'number' ||
    typeof file.subjectSharpnessScore === 'number' ||
    !!file.sceneAnalysis ||
    (file.faceBoxes?.length ?? 0) > 0 ||
    (file.personBoxes?.length ?? 0) > 0 ||
    (file.poses?.length ?? 0) > 0;
}

function hasProposalCullingAnalysis(file: MediaFile, _eventMode: EventMode): boolean {
  if (file.reviewAnalysisUnavailable) return false;
  // A face-only screen cannot establish that a comparison frame contains no
  // person. Scene groups become eligible after the subjects/body pass; until
  // then hasCullingAnalysis intentionally keeps screened repeats manual.
  return hasCullingAnalysis(file);
}

function stableGroupEntries(files: MediaFile[], visualHashDistance: number): Array<{
  id: string;
  kind: AutoCullProposalGroup['kind'];
  files: MediaFile[];
}> {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const assigned = new Set<string>();
  const groups: Array<{ id: string; kind: AutoCullProposalGroup['kind']; files: MediaFile[] }> = [];
  const bursts = new Map<string, MediaFile[]>();

  for (const file of files) {
    if (!file.burstId || (file.burstSize ?? 0) < 2) continue;
    const group = bursts.get(file.burstId);
    if (group) group.push(file);
    else bursts.set(file.burstId, [file]);
  }
  for (const [id, group] of [...bursts].sort(([a], [b]) => a.localeCompare(b))) {
    const available = group.filter((file) => !assigned.has(file.path));
    if (available.length < 2) continue;
    available.forEach((file) => assigned.add(file.path));
    groups.push({ id: `burst:${id}`, kind: 'burst', files: available });
  }

  const availableForVisual = files.filter((file) => !assigned.has(file.path) && file.visualHash);
  const visualGroups = groupByVisualHash(availableForVisual, visualHashDistance);
  for (const [id, paths] of Object.entries(visualGroups)) {
    const group = paths.map((path) => byPath.get(path)).filter((file): file is MediaFile => !!file && !assigned.has(file.path));
    if (group.length < 2) continue;
    group.forEach((file) => assigned.add(file.path));
    groups.push({ id, kind: 'visual', files: group });
  }

  for (const file of files) {
    if (!assigned.has(file.path)) groups.push({ id: `standalone:${file.path}`, kind: 'standalone', files: [file] });
  }
  return groups;
}

/**
 * Build a deterministic, fully explainable proposal. It never changes picks or
 * deletes files: callers must present/accept the proposal separately. Only
 * well-supported comparisons become proposed rejects; close or incomplete
 * decisions remain uncertain/unanalysed.
 */
export function buildAutoCullProposal(
  files: MediaFile[],
  options: AutoCullProposalOptions = {},
): AutoCullProposal {
  const eventMode = options.eventMode ?? getReviewProfile();
  const genre = options.genre ?? 'auto';
  const previousMode = getReviewProfile();
  const previousGenre = getCullingGenre();
  configureReviewProfile(eventMode);
  configureCullingGenre(genre);

  try {
    const eligible = files.filter((file) =>
      file.type === 'photo' &&
      (!options.skipDuplicates || !file.duplicate),
    );
    const groups = stableGroupEntries(eligible, Math.max(0, Math.floor(options.visualHashDistance ?? 8)));
    const aggregate: Record<AutoCullProposalDisposition, string[]> = {
      keep: [], reject: [], uncertain: [], unanalysed: [],
    };
    const reasons: Record<string, string[]> = {};
    const proposalGroups: AutoCullProposalGroup[] = [];

    for (const group of groups) {
      const analysedByPath = new Map(group.files.map((file) => [
        file.path,
        hasProposalCullingAnalysis(file, eventMode),
      ]));
      const groupAnalysisComplete = group.files.length === 1 ||
        group.files.every((file) => analysedByPath.get(file.path));
      const ranked = rankBestShots(group.files);
      const decision = group.files.length > 1
        ? autoCullGroup(group.files, options)
        : null;
      const best = decision?.best ?? ranked.find(isAutoBestCandidate) ?? null;
      // Include a soft/blurred runner-up in confidence measurement: it may be
      // ineligible as a keeper precisely because the comparison evidence is
      // strong. Manual rejects remain explicit and are not used as runners.
      const runnerUp = ranked.find((file) => file.path !== best?.path && file.pick !== 'rejected');
      const comparisonConfidence = proposalComparisonConfidence(best, runnerUp, genre);
      const decisionRejects = new Set(decision?.reject ?? []);
      const decisionKeeps = new Set(decision?.keep ?? []);
      const items: AutoCullProposalItem[] = [];
      const bestExposure = best?.exposureValue;

      for (const file of ranked) {
        const analysis = scoreGenre(file, genre);
        let disposition: AutoCullProposalDisposition;
        const itemReasons: string[] = [];

        if (file.pick === 'rejected') {
          disposition = 'reject';
          itemReasons.push('manual reject');
        } else if (isMandatoryKeeper(file)) {
          disposition = 'keep';
          itemReasons.push('manual/protected keeper');
        } else if (!analysedByPath.get(file.path)) {
          disposition = 'unanalysed';
          itemReasons.push('quality analysis not available');
        } else if (!groupAnalysisComplete) {
          // Never reject a completed frame against an incompletely analysed
          // neighbour. The missing evidence could still change which member is
          // best, so completed members remain visible but unchanged.
          disposition = 'uncertain';
          itemReasons.push('comparison group is still being analysed');
        } else if (hasDetectedSubject(file) && (subjectFocusConfidence(file) ?? 0) < 0.2) {
          disposition = 'uncertain';
          itemReasons.push('subject focus confidence too low for an automatic decision');
        } else if (file.path !== best?.path &&
          typeof bestExposure === 'number' && typeof file.exposureValue === 'number' &&
          Math.abs(file.exposureValue - bestExposure) >= 0.7) {
          // Exposure brackets may share the same perceptual hash yet carry
          // different recoverable highlight/shadow detail. Keep them visible
          // for review instead of treating one as a redundant frame.
          disposition = 'uncertain';
          itemReasons.push(`distinct exposure variant (${Math.abs(file.exposureValue - bestExposure).toFixed(1)} EV)`);
          itemReasons.push(...analysis.cautions);
        } else if (decisionRejects.has(file.path) && comparisonConfidence !== 'low' && analysis.confidence >= 0.5) {
          disposition = 'reject';
          itemReasons.push(...(decision?.reasons[file.path] ?? ['lower-ranked repeat']));
        } else if (group.kind === 'standalone') {
          disposition = 'uncertain';
          itemReasons.push('no comparable burst or near-duplicate');
          itemReasons.push(...analysis.cautions);
        } else if (decisionKeeps.has(file.path) || file.path === best?.path) {
          disposition = 'keep';
          itemReasons.push(...(analysis.reasons.length > 0 ? analysis.reasons : ['best available representative']));
        } else {
          disposition = 'uncertain';
          itemReasons.push(...(analysis.cautions.length > 0 ? analysis.cautions : ['close comparison — review recommended']));
        }

        const uniqueReasons = [...new Set(itemReasons)].slice(0, 5);
        aggregate[disposition].push(file.path);
        reasons[file.path] = uniqueReasons;
        items.push({
          path: file.path,
          disposition,
          score: bestShotScore(file),
          genre: analysis.genre,
          analysisConfidence: analysis.confidence,
          reasons: uniqueReasons,
        });
      }

      proposalGroups.push({
        id: group.id,
        kind: group.kind,
        paths: group.files.map((file) => file.path),
        bestPath: best?.path,
        confidence: comparisonConfidence,
        items,
      });
    }

    return {
      eventMode,
      genre,
      keep: aggregate.keep,
      reject: aggregate.reject,
      uncertain: aggregate.uncertain,
      unanalysed: aggregate.unanalysed,
      groups: proposalGroups,
      reasons,
      automaticDeletion: false,
    };
  } finally {
    configureReviewProfile(previousMode);
    configureCullingGenre(previousGenre);
  }
}
