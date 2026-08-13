/**
 * Immutable catalogue updates without an O(N) predicate scan for every small
 * patch. The array still needs one shallow copy when something changes (React
 * correctness requires a new reference), but path lookup and object creation
 * are proportional to the delta size.
 */

export interface PathEntry {
  path: string;
}

export interface IndexedCatalogueUpdate<T> {
  files: T[];
  lookups: number;
  changed: number;
  /** Number of catalogue rows inspected to locate updates. */
  rowsScanned: number;
}

const pathIndexCache = new WeakMap<readonly PathEntry[], ReadonlyMap<string, number>>();

export function getCataloguePathIndex<T extends PathEntry>(files: readonly T[]): ReadonlyMap<string, number> {
  const cached = pathIndexCache.get(files);
  if (cached) return cached;
  const index = new Map<string, number>();
  for (let i = 0; i < files.length; i++) index.set(files[i].path, i);
  pathIndexCache.set(files, index);
  return index;
}

export function inheritCataloguePathIndex<T extends PathEntry>(source: readonly T[], target: readonly T[]): void {
  if (source.length !== target.length) return;
  pathIndexCache.set(target, getCataloguePathIndex(source));
}

export function appendCatalogueFiles<T extends PathEntry>(current: readonly T[], incoming: readonly T[]): T[] {
  if (incoming.length === 0) return current as T[];
  const next = new Array<T>(current.length + incoming.length);
  for (let i = 0; i < current.length; i++) next[i] = current[i];
  for (let i = 0; i < incoming.length; i++) next[current.length + i] = incoming[i];

  const index = new Map(getCataloguePathIndex(current));
  for (let i = 0; i < incoming.length; i++) index.set(incoming[i].path, current.length + i);
  pathIndexCache.set(next, index);
  return next;
}

export function applyIndexedCatalogueUpdates<T extends PathEntry, U>(
  current: readonly T[],
  updates: Readonly<Record<string, U>>,
  update: (file: T, value: U, path: string) => T,
): IndexedCatalogueUpdate<T> {
  const paths = Object.keys(updates);
  if (paths.length === 0) {
    return { files: current as T[], lookups: 0, changed: 0, rowsScanned: 0 };
  }

  const index = getCataloguePathIndex(current);
  let next: T[] | undefined;
  let changed = 0;
  for (const filePath of paths) {
    const fileIndex = index.get(filePath);
    if (fileIndex === undefined) continue;
    const source = next?.[fileIndex] ?? current[fileIndex];
    const replacement = update(source, updates[filePath], filePath);
    if (replacement === source) continue;
    next ??= current.slice();
    next[fileIndex] = replacement;
    changed++;
  }

  if (!next) return { files: current as T[], lookups: paths.length, changed: 0, rowsScanned: 0 };
  pathIndexCache.set(next, index);
  return { files: next, lookups: paths.length, changed, rowsScanned: 0 };
}

export function applyIndexedCatalogueMapUpdates<T extends PathEntry, U>(
  current: readonly T[],
  updates: ReadonlyMap<string, U>,
  update: (file: T, value: U, path: string) => T,
): IndexedCatalogueUpdate<T> {
  if (updates.size === 0) {
    return { files: current as T[], lookups: 0, changed: 0, rowsScanned: 0 };
  }
  const index = getCataloguePathIndex(current);
  let next: T[] | undefined;
  let changed = 0;
  for (const [filePath, value] of updates) {
    const fileIndex = index.get(filePath);
    if (fileIndex === undefined) continue;
    const source = next?.[fileIndex] ?? current[fileIndex];
    const replacement = update(source, value, filePath);
    if (replacement === source) continue;
    next ??= current.slice();
    next[fileIndex] = replacement;
    changed++;
  }
  if (!next) return { files: current as T[], lookups: updates.size, changed: 0, rowsScanned: 0 };
  pathIndexCache.set(next, index);
  return { files: next, lookups: updates.size, changed, rowsScanned: 0 };
}
