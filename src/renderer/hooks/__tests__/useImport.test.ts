import { describe, expect, it } from 'vitest';
import { resolveImportPaths } from '../useImport';
import type { MediaFile } from '../../../shared/types';

function file(overrides: Partial<MediaFile> = {}): MediaFile {
  return {
    path: '/photos/a.jpg',
    name: 'a.jpg',
    size: 100,
    type: 'photo',
    extension: '.jpg',
    destPath: '/dest/a.jpg',
    ...overrides,
  };
}

describe('resolveImportPaths', () => {
  it('honors an explicit empty override instead of falling through to selected, queued, or picked files', () => {
    const files = [
      file({ path: '/photos/selected.jpg', pick: 'selected', destPath: '/dest/selected.jpg' }),
      file({ path: '/photos/queued.jpg', destPath: '/dest/queued.jpg' }),
    ];

    expect(resolveImportPaths({
      files,
      selectedPaths: ['/photos/selected.jpg'],
      queuedPaths: ['/photos/queued.jpg'],
      skipDuplicates: true,
      selectedPathsOverride: [],
    })).toEqual([]);
  });

  it('filters explicit overrides to importable files', () => {
    const files = [
      file({ path: '/photos/ok.jpg', destPath: '/dest/ok.jpg' }),
      file({ path: '/photos/rejected.jpg', destPath: '/dest/rejected.jpg', pick: 'rejected' }),
      file({ path: '/photos/duplicate.jpg', destPath: '/dest/duplicate.jpg', duplicate: true }),
      file({ path: '/photos/no-dest.jpg', destPath: undefined }),
    ];

    expect(resolveImportPaths({
      files,
      selectedPaths: [],
      queuedPaths: [],
      skipDuplicates: true,
      selectedPathsOverride: [
        '/photos/ok.jpg',
        '/photos/rejected.jpg',
        '/photos/duplicate.jpg',
        '/photos/no-dest.jpg',
      ],
    })).toEqual(['/photos/ok.jpg']);
  });
});
