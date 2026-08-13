import type { EventMode, MediaFile } from '../../shared/types';

export type ReviewAnalysisProfile = 'detect' | 'subjects' | 'full';

export interface SuperSpeedRoutingOptions {
  eventMode: EventMode;
  faceMatching: boolean;
  personDetection: boolean;
  poseAnalysis?: boolean;
  /** Manual attention always receives complete evidence. */
  priority?: boolean;
}

const SCENE_ONLY_MODES: ReadonlySet<EventMode> = new Set([
  'landscape',
  'architecture',
  'interior',
  'cars-itasha',
]);

const SUBJECT_CRITICAL_MODES: ReadonlySet<EventMode> = new Set([
  'stage',
  'candids',
  'cosplay',
  'crowd',
  'panels',
  'meetups',
  'taekwondo',
  'sports-combat',
]);

function detectedSubjectCount(file: MediaFile): number {
  return Math.max(
    file.faceBoxes?.length ?? file.faceCount ?? 0,
    file.personBoxes?.length ?? file.personCount ?? 0,
  );
}

function detectedFaceCount(file: MediaFile): number {
  return file.faceBoxes?.length ?? file.faceCount ?? 0;
}

function detectedPersonCount(file: MediaFile): number {
  return file.personBoxes?.length ?? file.personCount ?? 0;
}

function completedProfileRank(file: MediaFile): number {
  const explicit = superSpeedProfileRank(
    file.reviewAnalysisStage === 'screened'
      ? 'detect'
      : file.reviewAnalysisStage ?? null,
  );
  if (explicit > 0) return explicit;

  // Backwards-compatible inference for sessions written before
  // reviewAnalysisStage existed. Do not treat arbitrary faceBoxes as native:
  // the renderer's old estimated-face pass populated the same field.
  if (file.faceEmbedding || (file.faceEmbeddings?.length ?? 0) > 0) return 3;
  if (file.personBoxes !== undefined || file.personCount !== undefined) return 2;
  if (file.faceDetection === 'native') return 1;
  return 0;
}

function completedFeature(file: MediaFile, feature: 'personDetection' | 'faceMatching' | 'poseAnalysis'): boolean {
  const explicit = file.reviewAnalysisFeatures?.[feature];
  if (typeof explicit === 'boolean') return explicit;
  // Backwards-compatible evidence for sessions written before the exact
  // capability marker existed. Empty arrays count because they prove the
  // requested detector completed and found nothing.
  if (feature === 'personDetection') {
    return file.personBoxes !== undefined || file.personCount !== undefined;
  }
  if (feature === 'faceMatching') {
    return !!file.faceEmbedding || file.faceEmbeddings !== undefined;
  }
  return file.poses !== undefined;
}

function isComparisonCandidate(file: MediaFile): boolean {
  return (file.burstSize ?? 0) > 1 ||
    !!file.burstId ||
    (file.visualGroupSize ?? 0) > 1 ||
    !!file.visualGroupId;
}

/**
 * Select the least expensive native analysis pass that can still support a
 * safe culling decision. The route is deterministic and conservative:
 * anything the operator selected/protected, any uncertain subject frame, and
 * subject-critical genres retain the evidence needed for a full comparison.
 */
export function selectSuperSpeedProfile(
  file: MediaFile,
  options: SuperSpeedRoutingOptions,
): ReviewAnalysisProfile | null {
  if (file.type !== 'photo') return null;
  if (file.reviewAnalysisUnavailable) return null;

  const priority = options.priority ||
    file.pick === 'selected' ||
    file.isProtected ||
    (file.rating ?? 0) > 0 ||
    file.reviewApproved;
  const knownSubjects = detectedSubjectCount(file);
  const knownFaces = detectedFaceCount(file);
  const knownPeople = detectedPersonCount(file);
  const completedRank = completedProfileRank(file);
  const hasNativeFacePass = completedRank >= superSpeedProfileRank('detect');
  const hasPersonPass = completedFeature(file, 'personDetection') ||
    (!options.personDetection && completedRank >= superSpeedProfileRank('subjects'));
  const hasMatchData = !!file.faceEmbedding || (file.faceEmbeddings?.length ?? 0) > 0;
  const hasMatchingPass = completedFeature(file, 'faceMatching');
  const hasPosePass = completedFeature(file, 'poseAnalysis');
  const matchingUnavailable = file.reviewAnalysisUnavailableFeatures?.faceMatching === true;
  const poseUnavailable = file.reviewAnalysisUnavailableFeatures?.poseAnalysis === true;
  const comparisonCandidate = isComparisonCandidate(file);
  const subjectCritical = SUBJECT_CRITICAL_MODES.has(options.eventMode);

  if (!hasNativeFacePass) {
    // Standalone frames cannot replace another image, so run their cheap
    // scene/hash/focus pass only. Once burst/hash grouping proves a comparison
    // exists, native screening is required before any automatic choice.
    if (priority) return options.faceMatching || options.poseAnalysis ? 'full' : 'subjects';
    // Subject-critical shoots need bodies/eyes immediately, but identity and
    // pose stay shortlisted to priority/repeat comparisons.
    if (subjectCritical) return 'subjects';
    return comparisonCandidate ? 'detect' : null;
  }

  if (
    !priority &&
    SCENE_ONLY_MODES.has(options.eventMode) &&
    knownSubjects === 0 &&
    // A face-only screen cannot rule out a turned-away or distant person.
    // Repeated scene frames need one completed body pass before automation may
    // compare them; unrelated standalone scenes remain on the cheap path.
    (!comparisonCandidate || hasPersonPass || !options.personDetection)
  ) {
    return null;
  }

  if (!hasPersonPass && options.personDetection && (
    priority ||
    subjectCritical ||
    comparisonCandidate ||
    knownSubjects > 0
  )) {
    // Identity embeddings only help when there is actually a face and the
    // frame participates in a meaningful comparison. A body-only result must
    // not trigger a redundant full pass just because face matching is on.
    return options.faceMatching && knownFaces > 0 && (priority || comparisonCandidate)
      ? 'full'
      : 'subjects';
  }

  const needsMatching = options.faceMatching && knownFaces > 0 && !hasMatchingPass && !hasMatchData && !matchingUnavailable;
  // MoveNet runs on person crops. A face without a corresponding body box is
  // not a pose candidate and must not keep requesting a full pass forever.
  const needsPose = !!options.poseAnalysis && knownPeople > 0 && !hasPosePass && !poseUnavailable;
  if ((needsMatching || needsPose) && (priority || comparisonCandidate)) {
    return 'full';
  }

  return null;
}

export function superSpeedProfileRank(profile: ReviewAnalysisProfile | null): number {
  return profile === 'full' ? 3 : profile === 'subjects' ? 2 : profile === 'detect' ? 1 : 0;
}

export interface SuperSpeedRoutingEstimate {
  photos: number;
  skipped: number;
  detect: number;
  subjects: number;
  full: number;
  /** Share of photos routed to either subjects or full on this pass. */
  expensiveFraction: number;
  /** Share of photos routed to embedding/pose-capable full analysis. */
  fullFraction: number;
}

export interface ReviewCanvasRequirements {
  fastKeeperMode: boolean;
  faceAnalysis: boolean;
  visualDuplicates: boolean;
  superSpeedMode: boolean;
}

/**
 * Whether the renderer still owes a thumbnail-derived review pass. Keeping
 * this predicate pure makes loop termination testable: Super Speed may finish
 * a people-free frame without inventing a subject score, while a detected
 * subject must wait until scene ROI confidence proves that focus was measured.
 */
export function needsReviewCanvasAnalysis(
  file: MediaFile,
  options: ReviewCanvasRequirements,
): boolean {
  if (!file.thumbnail) return false;
  if (file.reviewAnalysisUnavailable) return false;
  if (typeof file.sharpnessScore !== 'number') return true;
  if (options.visualDuplicates && !file.visualHash) return true;
  if (file.sceneAnalysis === undefined) return true;
  if (options.fastKeeperMode || !options.faceAnalysis) return false;

  const hasSubjectBoxes = (file.faceBoxes?.length ?? 0) > 0 ||
    (file.personBoxes?.length ?? 0) > 0;
  if (hasSubjectBoxes) {
    return typeof file.sceneAnalysis.subjectFocusConfidence !== 'number';
  }

  if (options.superSpeedMode) {
    if (!isComparisonCandidate(file)) return false;
    if (completedProfileRank(file) >= superSpeedProfileRank('detect')) return false;
  }
  return typeof file.subjectSharpnessScore !== 'number';
}

/**
 * Summarise a routing snapshot without decoding photos or invoking ONNX. This
 * makes it possible to benchmark cascade selectivity on synthetic metadata (or
 * anonymised aggregate manifests) before committing to a million-file run.
 */
export function estimateSuperSpeedRouting(
  files: readonly MediaFile[],
  options: SuperSpeedRoutingOptions,
): SuperSpeedRoutingEstimate {
  const result: SuperSpeedRoutingEstimate = {
    photos: 0,
    skipped: 0,
    detect: 0,
    subjects: 0,
    full: 0,
    expensiveFraction: 0,
    fullFraction: 0,
  };

  for (const file of files) {
    if (file.type !== 'photo') continue;
    result.photos++;
    const profile = selectSuperSpeedProfile(file, options);
    if (profile === null) result.skipped++;
    else result[profile]++;
  }

  if (result.photos > 0) {
    result.expensiveFraction = (result.subjects + result.full) / result.photos;
    result.fullFraction = result.full / result.photos;
  }
  return result;
}
