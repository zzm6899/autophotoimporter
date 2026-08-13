import type { AppSession } from '../../shared/types';

export interface SessionChangeSnapshot {
  revision: number;
  fullCheckpoint: boolean;
  paths: string[];
}

let revision = 0;
let fullCheckpointRevision = 0;
let capturedFullCheckpointRevision = 0;
const pathRevisions = new Map<string, number>();
let restoredSessionSeed: { session: AppSession; revision: number } | null = null;

export function resetSessionChangeJournal(requireCheckpoint = true): number {
  revision++;
  pathRevisions.clear();
  fullCheckpointRevision = requireCheckpoint ? revision : 0;
  capturedFullCheckpointRevision = 0;
  restoredSessionSeed = null;
  return revision;
}

/** Mark a main-owned restored checkpoint as the renderer's durable baseline. */
export function stageRestoredSessionBaseline(session: AppSession): number {
  const restoredRevision = resetSessionChangeJournal(false);
  restoredSessionSeed = { session, revision: restoredRevision };
  return restoredRevision;
}

export function consumeRestoredSessionBaseline(
  source: string,
  fileCount: number,
): { session: AppSession; revision: number } | null {
  const seed = restoredSessionSeed;
  if (!seed || seed.session.sourcePath !== source || seed.session.files.length !== fileCount) return null;
  restoredSessionSeed = null;
  return seed;
}

export function markSessionPathsChanged(paths: Iterable<string>): number {
  // Before a full snapshot is captured, remembering each dirty path is
  // redundant: the checkpoint contains every row. This avoids a second
  // million-entry string Map while a fresh scan is still being reviewed.
  if (fullCheckpointRevision > 0 && capturedFullCheckpointRevision === 0) {
    for (const _path of paths) {
      revision++;
      return revision;
    }
    return revision;
  }
  const unique = new Set(paths);
  if (unique.size === 0) return revision;
  revision++;
  for (const filePath of unique) pathRevisions.set(filePath, revision);
  return revision;
}

export function markSessionCheckpointRequired(): number {
  revision++;
  fullCheckpointRevision = revision;
  capturedFullCheckpointRevision = 0;
  pathRevisions.clear();
  return revision;
}

export function snapshotSessionChanges(afterRevision: number): SessionChangeSnapshot {
  const paths: string[] = [];
  for (const [filePath, changedAt] of pathRevisions) {
    if (changedAt > afterRevision) paths.push(filePath);
  }
  const fullCheckpoint = fullCheckpointRevision > afterRevision;
  const snapshot = {
    revision,
    fullCheckpoint,
    paths,
  };
  if (fullCheckpoint) {
    // Future path writes must be journalled while this full checkpoint is in
    // flight, but everything already represented by it can be discarded.
    pathRevisions.clear();
    capturedFullCheckpointRevision = revision;
    snapshot.paths = [];
  }
  return snapshot;
}

/**
 * Remove only changes included in a completed durable save. A newer update to
 * the same path retains its higher revision and remains pending.
 */
export function acknowledgeSessionChanges(upToRevision: number): void {
  for (const [filePath, changedAt] of pathRevisions) {
    if (changedAt <= upToRevision) pathRevisions.delete(filePath);
  }
  if (fullCheckpointRevision <= upToRevision) fullCheckpointRevision = 0;
  if (capturedFullCheckpointRevision <= upToRevision) capturedFullCheckpointRevision = 0;
}

export function currentSessionChangeRevision(): number {
  return revision;
}
