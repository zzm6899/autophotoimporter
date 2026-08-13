import { describe, expect, it } from 'vitest';
import type { AppSession, MediaFile } from '../types';
import { applySessionDelta, createSessionDeltaEnvelope, getSessionDeltaDescriptor } from '../session-delta';

const file = (path: string, rating?: number): MediaFile => ({
  path,
  name: path.split('/').pop()!,
  size: 1,
  type: 'photo',
  extension: '.jpg',
  rating,
});

const base: AppSession = {
  id: 's', updatedAt: 'a', sourcePath: '/src', destRoot: '/dst',
  files: [file('/a.jpg'), file('/b.jpg')],
  selectedPaths: [], queuedPaths: [], filter: 'all',
  stats: { totalFiles: 2, picked: 0, rejected: 0, queued: 0, reviewed: 0 },
};

describe('session delta envelope', () => {
  it('merges changed rows while preserving checkpoint order and untouched rows', () => {
    const delta = createSessionDeltaEnvelope(
      { ...base, updatedAt: 'b', files: [file('/b.jpg', 5)], filter: 'best' },
      { totalFileCount: 2, fileIndexes: [1], removedPaths: [], selectedPathsChanged: false, queuedPathsChanged: false },
    );
    const merged = applySessionDelta(base, delta);
    expect(merged?.files.map((item) => [item.path, item.rating])).toEqual([['/a.jpg', undefined], ['/b.jpg', 5]]);
    expect(merged?.filter).toBe('best');
  });

  it('rejects removals until an order-safe removal protocol is implemented', () => {
    const delta = createSessionDeltaEnvelope(
      { ...base, files: [], selectedPaths: [], queuedPaths: [] },
      { totalFileCount: 1, fileIndexes: [], removedPaths: ['/b.jpg'], selectedPathsChanged: false, queuedPathsChanged: false },
    );
    expect(getSessionDeltaDescriptor(delta)).toBeNull();
    expect(applySessionDelta(base, delta)).toBeNull();
  });

  it('rejects changed paths that do not match their durable catalogue index', () => {
    const delta = createSessionDeltaEnvelope(
      { ...base, files: [file('/replacement.jpg', 5)] },
      { totalFileCount: 2, fileIndexes: [1], removedPaths: [], selectedPathsChanged: false, queuedPathsChanged: false },
    );
    expect(applySessionDelta(base, delta)).toBeNull();
  });

  it('rejects unchanged list descriptors that smuggle replacement arrays', () => {
    const delta = createSessionDeltaEnvelope(
      { ...base, files: [], selectedPaths: ['/a.jpg'] },
      { totalFileCount: 2, fileIndexes: [], removedPaths: [], selectedPathsChanged: false, queuedPathsChanged: false },
    );
    expect(getSessionDeltaDescriptor(delta)).toBeNull();
  });
});
