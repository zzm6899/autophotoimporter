import { useEffect, useRef, useState } from 'react';
import type { MediaFile } from '../../shared/types';
import type { FaceIdentityGroup } from '../../shared/review';

export function useFaceIdentityWorker(
  files: MediaFile[],
  fingerprint: string,
  threshold: number,
  includeSingletons: boolean,
  enabled: boolean,
): FaceIdentityGroup[] {
  const [groups, setGroups] = useState<FaceIdentityGroup[]>([]);
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => () => workerRef.current?.terminate(), []);

  useEffect(() => {
    if (!enabled) {
      setGroups([]);
      return;
    }
    // Never show clusters from the previous source/threshold while the worker
    // is calculating the next result.
    setGroups([]);
    workerRef.current ??= new Worker(new URL('../workers/review-worker.ts', import.meta.url), { type: 'module' });
    const worker = workerRef.current;
    const id = ++requestIdRef.current;
    const onMessage = (event: MessageEvent<{ id: number; groups: FaceIdentityGroup[] }>) => {
      if (event.data.id !== id) return;
      setGroups(event.data.groups);
    };
    worker.addEventListener('message', onMessage);
    // Face grouping only needs identity signals. Avoid cloning the full media
    // records (EXIF, import metadata, paths, UI state) into the worker.
    const faceFiles = files.map((file) => ({
      path: file.path,
      faceEmbedding: file.faceEmbedding,
      faceEmbeddings: file.faceEmbeddings,
      faceEmbeddingBoxes: file.faceEmbeddingBoxes,
      faceBoxes: file.faceBoxes,
      faceCount: file.faceCount,
      faceDetection: file.faceDetection,
      subjectSharpnessScore: file.subjectSharpnessScore,
    })) as MediaFile[];
    worker.postMessage({ id, files: faceFiles, threshold, includeSingletons });
    return () => worker.removeEventListener('message', onMessage);
  // The fingerprint intentionally replaces the large files dependency: review
  // score-only updates must not clone the full shoot into the worker again.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, fingerprint, includeSingletons, threshold]);

  return groups;
}
