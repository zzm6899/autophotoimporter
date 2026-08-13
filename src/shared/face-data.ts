import type { MediaFile, SceneAnalysis } from './types';

/**
 * Detector-derived fields that can describe, locate, or group a person.
 * Keeping this list in shared code makes the renderer, session store, and
 * catalog apply the same privacy boundary.
 */
const LOCAL_SUBJECT_DATA_KEYS = [
  'faceCount',
  'faceBoxes',
  'faceDetection',
  'personCount',
  'personBoxes',
  'poses',
  'faceSignature',
  'faceEmbedding',
  'faceEmbeddings',
  'faceEmbeddingBoxes',
  'faceGroupId',
  'faceGroupSize',
  'subjectSharpnessScore',
  'subjectReasons',
  'blurRisk',
  'enduranceSportsAnalysis',
  'reviewScore',
  'reviewReasons',
  'reviewAnalysisStage',
  'reviewAnalysisFeatures',
  'reviewAnalysisUnavailable',
  'reviewAnalysisUnavailableFeatures',
] as const satisfies readonly (keyof MediaFile)[];

/** Remove detector-dependent regions while retaining scene-only measurements. */
export function stripSceneSubjectAnalysis(analysis: SceneAnalysis | undefined): SceneAnalysis | undefined {
  if (!analysis) return undefined;
  const {
    subjectSharpnessScore: _subjectSharpnessScore,
    backgroundSharpnessScore: _backgroundSharpnessScore,
    subjectFocusConfidence: _subjectFocusConfidence,
    subjectFocusCoverage: _subjectFocusCoverage,
    subjectArea: _subjectArea,
    subjectCountAnalyzed: _subjectCountAnalyzed,
    subjectReasons,
    reasons,
    ...sceneOnly
  } = analysis;
  const staleReasons = new Set(subjectReasons ?? []);
  const sceneReasons = reasons?.filter((reason) => !staleReasons.has(reason));
  return {
    ...sceneOnly,
    ...(sceneReasons && sceneReasons.length > 0 ? { reasons: sceneReasons } : {}),
  };
}

export function hasLocalFaceOrSubjectData(file: MediaFile): boolean {
  if (LOCAL_SUBJECT_DATA_KEYS.some((key) => file[key] !== undefined)) return true;
  const scene = file.sceneAnalysis;
  return !!scene && (
    scene.subjectSharpnessScore !== undefined
    || scene.backgroundSharpnessScore !== undefined
    || scene.subjectFocusConfidence !== undefined
    || scene.subjectFocusCoverage !== undefined
    || scene.subjectArea !== undefined
    || scene.subjectCountAnalyzed !== undefined
    || scene.subjectReasons !== undefined
  );
}

/**
 * Return a copy without local face embeddings, face/body regions, pose
 * keypoints, identity groups, or scores derived from that evidence.
 * Photographer-authored state and non-subject metadata are deliberately kept.
 */
export function stripLocalFaceAndSubjectData(file: MediaFile): MediaFile {
  if (!hasLocalFaceOrSubjectData(file)) return file;
  const {
    faceCount: _faceCount,
    faceBoxes: _faceBoxes,
    faceDetection: _faceDetection,
    personCount: _personCount,
    personBoxes: _personBoxes,
    poses: _poses,
    faceSignature: _faceSignature,
    faceEmbedding: _faceEmbedding,
    faceEmbeddings: _faceEmbeddings,
    faceEmbeddingBoxes: _faceEmbeddingBoxes,
    faceGroupId: _faceGroupId,
    faceGroupSize: _faceGroupSize,
    subjectSharpnessScore: _subjectSharpnessScore,
    subjectReasons: _subjectReasons,
    blurRisk: _blurRisk,
    enduranceSportsAnalysis: _enduranceSportsAnalysis,
    reviewScore: _reviewScore,
    reviewReasons: _reviewReasons,
    reviewAnalysisStage: _reviewAnalysisStage,
    reviewAnalysisFeatures: _reviewAnalysisFeatures,
    reviewAnalysisUnavailable: _reviewAnalysisUnavailable,
    reviewAnalysisUnavailableFeatures: _reviewAnalysisUnavailableFeatures,
    ...retained
  } = file;
  return {
    ...retained,
    sceneAnalysis: stripSceneSubjectAnalysis(file.sceneAnalysis),
  };
}
