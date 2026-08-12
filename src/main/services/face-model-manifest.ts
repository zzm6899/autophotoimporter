/**
 * Pinned model identities used by the main-process culling pipeline.
 *
 * Keep this manifest independent from Electron/ONNX so the cache and model
 * loader can share one provenance source without pulling native modules into
 * tests. A digest change or preprocessing revision must change the pipeline
 * fingerprint and therefore invalidate persisted inference results.
 */

export type FaceModelRole = 'detector' | 'embedder' | 'person';

export interface FaceModelIdentity {
  fileName: string;
  sha256: string;
}

export const FACE_MODEL_IDENTITIES: Record<FaceModelRole, FaceModelIdentity> = {
  detector: {
    fileName: 'version-RFB-640.onnx',
    sha256: '8f4c659275977e7a3bfbfa339a9c769ad793df50f9c0baa8c14b11baa1646430',
  },
  embedder: {
    fileName: 'w600k_mbf.onnx',
    sha256: '9cc6e4a75f0e2bf0b1aed94578f144d15175f357bdc05e815e5c4a02b319eb4f',
  },
  person: {
    fileName: 'ssd_mobilenet_v1_12.onnx',
    sha256: 'b8fba5e404077d4048d27fcd1667e85e27e192eb9bf51e696c46a3acd7d21058',
  },
};

// Bump for any change that can alter returned boxes, embeddings, poses, or
// per-face quality signals even when the model files themselves are unchanged.
export const FACE_PREPROCESSING_REVISION = 'orientation-v1.person-cascade-v1.eye-detail-v1';

export const FACE_PIPELINE_FINGERPRINT = [
  'face-pipeline-v4',
  FACE_PREPROCESSING_REVISION,
  ...(['detector', 'embedder', 'person'] as const).map((role) =>
    `${role}:${FACE_MODEL_IDENTITIES[role].sha256}`,
  ),
].join('|');
