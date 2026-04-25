/**
 * useFaceAnalysis.ts
 *
 * React hook for running ONNX-based face detection + embedding on a batch of
 * MediaFile paths. Designed to run lazily after the scan completes, so it
 * doesn't block the main import workflow.
 *
 * The hook:
 *  1. Checks whether face models are available on disk (via IPC).
 *  2. If available, queues files for analysis in small batches so the main
 *     process isn't flooded with simultaneous ONNX inference calls.
 *  3. Returns per-path results that callers can merge back onto MediaFile
 *     objects (faceCount, faceBoxes, faceEmbedding).
 *
 * Usage:
 *   const { modelsAvailable, results, analyzing, analyze } = useFaceAnalysis();
 *   // call analyze(files) after scan completes
 *   // results is a Map<path, FaceResult>
 */

import { useState, useCallback, useRef } from 'react';

export interface FaceResult {
  path: string;
  faceCount: number;
  /** Normalised bounding boxes, x/y/width/height in 0..1 */
  boxes: Array<{ x: number; y: number; width: number; height: number; score: number }>;
  /** Hex-serialised 128-d embeddings — one per detected face */
  embeddings: string[];
  error?: string;
}

interface UseFaceAnalysisReturn {
  /** True when ONNX models are downloaded and usable */
  modelsAvailable: boolean | null; // null = not yet checked
  /** Results indexed by file path */
  results: Map<string, FaceResult>;
  /** True while analysis is running */
  analyzing: boolean;
  /** How many files have been processed so far */
  processedCount: number;
  /** Total files queued for this run */
  totalCount: number;
  /** Kick off face analysis for a list of image paths */
  analyze: (paths: string[]) => Promise<void>;
  /** Cancel an in-progress analysis */
  cancel: () => void;
}

const BATCH_SIZE = 1; // one at a time — face analysis is CPU-heavy (~1–4s each) and
                      // running multiple in parallel blocks the main process event loop,
                      // causing the UI to freeze. Sequential keeps the app responsive.

export function useFaceAnalysis(): UseFaceAnalysisReturn {
  const [modelsAvailable, setModelsAvailable] = useState<boolean | null>(null);
  const [results, setResults] = useState<Map<string, FaceResult>>(new Map());
  const [analyzing, setAnalyzing] = useState(false);
  const [processedCount, setProcessedCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const cancelledRef = useRef(false);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
  }, []);

  const analyze = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;

    cancelledRef.current = false;

    // Check model availability on first call (result is cached in state)
    let available = modelsAvailable;
    if (available === null) {
      try {
        available = await window.electronAPI.faceModelsAvailable();
        setModelsAvailable(available);
      } catch {
        setModelsAvailable(false);
        return;
      }
    }

    if (!available) return;

    // Filter to photo files only (skip videos — onnxruntime can't decode them)
    // All RAW formats use embedded JPEG preview extraction in face-engine.ts
    const photoExts = new Set([
      '.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.avif', '.tiff', '.tif',
      // Canon
      '.cr2', '.cr3', '.crw',
      // Nikon
      '.nef', '.nrw',
      // Sony
      '.arw', '.srf', '.sr2',
      // Fujifilm
      '.raf',
      // Olympus / OM System
      '.orf',
      // Panasonic
      '.rw2',
      // Pentax
      '.pef',
      // Samsung
      '.srw',
      // Leica
      '.rwl',
      // Sigma
      '.x3f',
      // Hasselblad
      '.3fr', '.fff',
      // Phase One
      '.iiq',
      // Adobe / Generic
      '.dng',
      // GoPro
      '.gpr',
      // Minolta
      '.mrw',
      // Epson
      '.erf',
    ]);
    const photoPaths = paths.filter((p) => {
      const ext = p.slice(p.lastIndexOf('.')).toLowerCase();
      return photoExts.has(ext);
    });

    if (photoPaths.length === 0) return;

    setAnalyzing(true);
    setProcessedCount(0);
    setTotalCount(photoPaths.length);
    setResults(new Map());

    let done = 0;
    try {
      for (let i = 0; i < photoPaths.length; i += BATCH_SIZE) {
        if (cancelledRef.current) break;

        const batch = photoPaths.slice(i, i + BATCH_SIZE);
        const batchResults = await window.electronAPI.analyzeFaces(batch);

        setResults((prev) => {
          const next = new Map(prev);
          for (const r of batchResults) {
            next.set(r.path, {
              path: r.path,
              faceCount: r.faceCount,
              boxes: r.boxes,
              embeddings: r.embeddings,
              error: r.error,
            });
          }
          return next;
        });

        done += batch.length;
        setProcessedCount(done);
      }
    } finally {
      setAnalyzing(false);
    }
  }, [modelsAvailable]);

  return { modelsAvailable, results, analyzing, processedCount, totalCount, analyze, cancel };
}

// ---------------------------------------------------------------------------
// Clustering helper — groups faces by embedding similarity
// ---------------------------------------------------------------------------

const SAME_FACE_THRESHOLD = 0.67; // cosine similarity above this = same person

/**
 * Given a map of FaceResults, compute a simple face group assignment.
 * Returns a Map<path, groupId> where groupId is the path of the "representative"
 * image for that cluster. Photos with no faces get no entry.
 *
 * This is O(n²) over face count — fine for typical import batches (<1000 photos).
 * For very large batches a proper clustering algorithm (DBSCAN) would be better.
 */
export function clusterFaces(
  results: Map<string, FaceResult>,
  deserializeEmbedding: (hex: string) => Float32Array,
): Map<string, string> {
  const groups = new Map<string, string>(); // path → groupId (representative path)

  type Entry = { path: string; embedding: Float32Array };
  const reps: Entry[] = []; // one representative per cluster

  for (const [filePath, result] of results) {
    if (result.faceCount === 0 || result.embeddings.length === 0) continue;

    // Use the first (highest-confidence) face embedding as the photo's identity
    const embedding = deserializeEmbedding(result.embeddings[0]);

    // Find the closest existing cluster representative
    let bestGroup: string | null = null;
    let bestSim = SAME_FACE_THRESHOLD;

    for (const rep of reps) {
      const sim = cosineSimilarity(embedding, rep.embedding);
      if (sim > bestSim) {
        bestSim = sim;
        bestGroup = rep.path;
      }
    }

    if (bestGroup) {
      groups.set(filePath, bestGroup);
    } else {
      // Start a new cluster with this image as representative
      reps.push({ path: filePath, embedding });
      groups.set(filePath, filePath);
    }
  }

  return groups;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return Math.max(0, Math.min(1, dot));
}

/**
 * Helper: deserialise a hex embedding string back to Float32Array.
 * Mirrors serializeEmbedding() in face-engine.ts.
 */
export function deserializeEmbedding(hex: string): Float32Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return new Float32Array(bytes.buffer);
}
