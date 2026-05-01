import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { SourceProfile, WatchFolder } from '../../shared/types';

const SOURCE_PROFILES = new Set<SourceProfile>(['auto', 'ssd', 'usb', 'nas']);

export interface WatchFolderTrigger {
  folder: WatchFolder;
  eventType: string;
  filename?: string;
  triggeredAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSourceProfile(value: unknown): value is SourceProfile {
  return typeof value === 'string' && SOURCE_PROFILES.has(value as SourceProfile);
}

function isIsoDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function hashText(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function displayNameForPath(folderPath: string): string {
  const parsed = path.basename(folderPath.replace(/[\\/]+$/, ''));
  return parsed || folderPath || 'Watch folder';
}

export function normalizeWatchFolder(value: unknown, now = new Date().toISOString()): WatchFolder | null {
  if (!isRecord(value)) return null;

  const rawPath = typeof value.path === 'string'
    ? value.path
    : typeof value.sourcePath === 'string'
      ? value.sourcePath
      : '';
  const folderPath = rawPath.trim();
  if (!folderPath || folderPath.includes('\0')) return null;

  const destination = typeof value.destination === 'string'
    ? value.destination.trim()
    : typeof value.destRoot === 'string'
      ? value.destRoot.trim()
      : '';
  const label = typeof value.label === 'string' && value.label.trim()
    ? value.label.trim()
    : displayNameForPath(folderPath);
  const createdAt = typeof value.createdAt === 'string' && isIsoDate(value.createdAt) ? value.createdAt : now;
  const updatedAt = typeof value.updatedAt === 'string' && isIsoDate(value.updatedAt) ? value.updatedAt : now;
  const idSeed = `${folderPath}|${createdAt}`;

  return {
    id: typeof value.id === 'string' && value.id.trim() ? value.id.trim() : `watch-${hashText(idSeed)}`,
    label,
    path: folderPath,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    destination,
    destRoot: destination,
    sourceProfile: isSourceProfile(value.sourceProfile) ? value.sourceProfile : 'auto',
    autoScan: typeof value.autoScan === 'boolean' ? value.autoScan : true,
    autoImport: typeof value.autoImport === 'boolean' ? value.autoImport : false,
    createdAt,
    updatedAt,
    lastTriggeredAt: typeof value.lastTriggeredAt === 'string' ? value.lastTriggeredAt : undefined,
    lastImportedAt: typeof value.lastImportedAt === 'string' ? value.lastImportedAt : undefined,
  };
}

export function normalizeWatchFolders(values: unknown, now = new Date().toISOString()): WatchFolder[] {
  if (!Array.isArray(values)) return [];
  const byPath = new Map<string, WatchFolder>();
  for (const value of values) {
    const folder = normalizeWatchFolder(value, now);
    if (!folder) continue;
    byPath.set(folder.path.toLocaleLowerCase(), folder);
  }
  return [...byPath.values()].sort((a, b) => (a.label ?? a.path).localeCompare(b.label ?? b.path));
}

export function buildWatchFolder(folderPath: string, patch: Partial<WatchFolder> = {}, now = new Date().toISOString()): WatchFolder {
  const folder = normalizeWatchFolder({ ...patch, path: folderPath, createdAt: patch.createdAt ?? now, updatedAt: now }, now);
  if (!folder) {
    throw new Error('Watch folder path is required.');
  }
  return folder;
}

export function isActiveWatchFolder(folder: WatchFolder): boolean {
  return folder.enabled && (folder.autoScan || folder.autoImport);
}

export class WatchFolderManager {
  private watchers = new Map<string, FSWatcher>();

  constructor(private readonly onTrigger: (trigger: WatchFolderTrigger) => void) {}

  update(folders: WatchFolder[]): void {
    const active = new Map(
      normalizeWatchFolders(folders)
        .filter(isActiveWatchFolder)
        .map((folder) => [folder.id, folder]),
    );

    for (const [id, watcher] of this.watchers) {
      if (!active.has(id)) {
        watcher.close();
        this.watchers.delete(id);
      }
    }

    for (const [id, folder] of active) {
      if (this.watchers.has(id)) continue;
      try {
        const watcher = watch(folder.path, { persistent: false }, (eventType, filename) => {
          this.onTrigger({
            folder,
            eventType,
            filename: typeof filename === 'string' ? filename : undefined,
            triggeredAt: new Date().toISOString(),
          });
        });
        watcher.on('error', () => {
          watcher.close();
          this.watchers.delete(id);
        });
        this.watchers.set(id, watcher);
      } catch {
        // Missing/offline folders are expected for cards, NAS mounts, and tether roots.
      }
    }
  }

  stop(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }
}
