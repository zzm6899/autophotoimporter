import type { AppSession, MediaFile } from './types';

export const SESSION_DELTA_FIELD = '__keptraSessionDelta' as const;
export const MAX_SESSION_FILE_COUNT = 1_250_000;
export const MAX_SESSION_DELTA_ROWS = MAX_SESSION_FILE_COUNT;

export interface SessionDeltaDescriptor {
  version: 1;
  mode: 'delta';
  totalFileCount: number;
  /** Parallel to session.files; retains the full catalogue order in SQLite. */
  fileIndexes: number[];
  removedPaths: string[];
  selectedPathsChanged: boolean;
  queuedPathsChanged: boolean;
}

export type SessionDeltaEnvelope = AppSession & {
  [SESSION_DELTA_FIELD]?: SessionDeltaDescriptor;
};

export function getSessionDeltaDescriptor(session: AppSession): SessionDeltaDescriptor | null {
  const candidate = (session as SessionDeltaEnvelope)[SESSION_DELTA_FIELD];
  if (!candidate || candidate.version !== 1 || candidate.mode !== 'delta') return null;
  if (!Number.isInteger(candidate.totalFileCount)
    || candidate.totalFileCount < 0
    || candidate.totalFileCount > MAX_SESSION_FILE_COUNT) return null;
  if (session.files.length > MAX_SESSION_DELTA_ROWS || session.files.length > candidate.totalFileCount) return null;
  if (!Array.isArray(candidate.fileIndexes) || candidate.fileIndexes.length !== session.files.length) return null;
  if (!candidate.fileIndexes.every((value) => Number.isInteger(value) && value >= 0 && value < candidate.totalFileCount)) return null;
  if (new Set(candidate.fileIndexes).size !== candidate.fileIndexes.length) return null;
  // Catalogue removals are deliberately unsupported. The renderer currently
  // emits metadata-only deltas; accepting removals without verifying every
  // shifted sort index can corrupt ordering and the aggregate row count.
  if (!Array.isArray(candidate.removedPaths) || candidate.removedPaths.length !== 0) return null;
  if (typeof candidate.selectedPathsChanged !== 'boolean' || typeof candidate.queuedPathsChanged !== 'boolean') return null;
  if (!candidate.selectedPathsChanged && session.selectedPaths.length !== 0) return null;
  if (!candidate.queuedPathsChanged && session.queuedPaths.length !== 0) return null;
  if (!session.files.every((file) => typeof file?.path === 'string' && file.path.trim().length > 0)) return null;
  const paths = new Set(session.files.map((file) => file.path));
  if (paths.size !== session.files.length) return null;
  return candidate;
}

export function hasSessionDeltaField(value: AppSession): boolean {
  return Object.prototype.hasOwnProperty.call(value, SESSION_DELTA_FIELD);
}

export function createSessionDeltaEnvelope(
  session: AppSession,
  descriptor: Omit<SessionDeltaDescriptor, 'version' | 'mode'>,
): SessionDeltaEnvelope {
  return {
    ...session,
    [SESSION_DELTA_FIELD]: { version: 1, mode: 'delta', ...descriptor },
  };
}

/** Merge a delta for the JSON fallback and for recovery from a SQLite write failure. */
export function applySessionDelta(base: AppSession, deltaSession: AppSession): AppSession | null {
  const descriptor = getSessionDeltaDescriptor(deltaSession);
  if (!descriptor || base.id !== deltaSession.id) return null;
  if (base.files.length !== descriptor.totalFileCount) return null;

  const files: MediaFile[] = [...base.files];
  for (let i = 0; i < deltaSession.files.length; i++) {
    const file = deltaSession.files[i];
    const index = descriptor.fileIndexes[i];
    // Deltas update metadata in-place. Replacing the path at a durable index
    // would be an addition/removal pair and requires a full checkpoint.
    if (files[index]?.path !== file.path) return null;
    files[index] = file;
  }

  return {
    id: deltaSession.id,
    updatedAt: deltaSession.updatedAt,
    sourcePath: deltaSession.sourcePath,
    destRoot: deltaSession.destRoot,
    files,
    selectedPaths: descriptor.selectedPathsChanged ? deltaSession.selectedPaths : base.selectedPaths,
    queuedPaths: descriptor.queuedPathsChanged ? deltaSession.queuedPaths : base.queuedPaths,
    filter: deltaSession.filter,
    focusedPath: deltaSession.focusedPath,
    importLedgerId: deltaSession.importLedgerId,
    stats: deltaSession.stats,
  };
}
