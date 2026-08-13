import { describe, expect, it } from 'vitest';
import { appendCatalogueFiles, applyIndexedCatalogueMapUpdates, applyIndexedCatalogueUpdates, getCataloguePathIndex } from '../catalogueDelta';

type Row = { path: string; value: number; thumbnail?: string };

describe('catalogueDelta', () => {
  it('applies sparse updates by indexed path without scanning catalogue rows', () => {
    const files: Row[] = Array.from({ length: 100_000 }, (_, index) => ({ path: `/p/${index}.jpg`, value: index }));
    const result = applyIndexedCatalogueUpdates(
      files,
      { '/p/17.jpg': 'a', '/p/99999.jpg': 'b', '/missing.jpg': 'c' },
      (file, thumbnail) => ({ ...file, thumbnail }),
    );

    expect(result).toMatchObject({ lookups: 3, changed: 2, rowsScanned: 0 });
    expect(result.files).not.toBe(files);
    expect(result.files[17]).toEqual(expect.objectContaining({ thumbnail: 'a' }));
    expect(result.files[99_999]).toEqual(expect.objectContaining({ thumbnail: 'b' }));
    expect(result.files[18]).toBe(files[18]);
  });

  it('applies Map-backed AI overlays in proportion to overlay size', () => {
    const files: Row[] = Array.from({ length: 10_000 }, (_, index) => ({ path: `/p/${index}`, value: index }));
    const updates = new Map([['/p/5000', 9]]);
    const result = applyIndexedCatalogueMapUpdates(files, updates, (file, value) => ({ ...file, value }));
    expect(result).toMatchObject({ lookups: 1, changed: 1, rowsScanned: 0 });
    expect(result.files[5_000].value).toBe(9);
  });

  it('reuses the inherited path index after immutable append', () => {
    const first: Row[] = [{ path: '/a', value: 1 }, { path: '/b', value: 2 }];
    const firstIndex = getCataloguePathIndex(first);
    const next = appendCatalogueFiles(first, [{ path: '/c', value: 3 }]);
    const nextIndex = getCataloguePathIndex(next);

    expect(firstIndex.get('/b')).toBe(1);
    expect(nextIndex.get('/c')).toBe(2);
    expect(next.slice(0, 2)).toEqual(first);
  });
});
