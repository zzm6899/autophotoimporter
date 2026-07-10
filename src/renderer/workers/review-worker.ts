/// <reference lib="webworker" />

import type { MediaFile } from '../../shared/types';
import { buildFaceIdentityGroups } from '../../shared/review';

type FaceGroupingRequest = {
  id: number;
  files: MediaFile[];
  threshold: number;
  includeSingletons: boolean;
};

self.onmessage = (event: MessageEvent<FaceGroupingRequest>) => {
  const { id, files, threshold, includeSingletons } = event.data;
  const startedAt = performance.now();
  try {
    const groups = buildFaceIdentityGroups(files, threshold, includeSingletons);
    self.postMessage({ id, groups, durationMs: performance.now() - startedAt });
  } catch (error) {
    self.postMessage({ id, groups: [], durationMs: performance.now() - startedAt, error: error instanceof Error ? error.message : String(error) });
  }
};

export {};
