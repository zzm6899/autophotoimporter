import { describe, expect, it } from 'vitest';
import { buildWatchFolder, isActiveWatchFolder, normalizeWatchFolder, normalizeWatchFolders } from '../watch-folders';

const NOW = '2026-05-02T00:00:00.000Z';

describe('watch-folders service', () => {
  it('normalizes a minimal folder into a safe saved config', () => {
    const folder = normalizeWatchFolder({ path: 'E:\\DCIM' }, NOW);

    expect(folder).toEqual(expect.objectContaining({
      label: 'DCIM',
      path: 'E:\\DCIM',
      enabled: true,
      destRoot: '',
      sourceProfile: 'auto',
      autoScan: true,
      autoImport: false,
      createdAt: NOW,
      updatedAt: NOW,
    }));
    expect(folder?.id).toMatch(/^watch-/);
  });

  it('drops invalid folder payloads and deduplicates by source path', () => {
    const folders = normalizeWatchFolders([
      { path: '' },
      { path: 'E:\\DCIM', label: 'Old card' },
      { path: 'e:\\dcim', label: 'Card' },
      { path: 'Z:\\Incoming', sourceProfile: 'nas', autoImport: true },
    ], NOW);

    expect(folders).toHaveLength(2);
    expect(folders.map((folder) => folder.label)).toEqual(['Card', 'Incoming']);
    expect(folders.find((folder) => folder.path === 'Z:\\Incoming')?.sourceProfile).toBe('nas');
  });

  it('builds a new folder with caller defaults', () => {
    const folder = buildWatchFolder('D:\\Tether', {
      destination: 'D:\\Photos',
      sourceProfile: 'ssd',
      autoImport: true,
    }, NOW);

    expect(folder).toEqual(expect.objectContaining({
      label: 'Tether',
      destRoot: 'D:\\Photos',
      sourceProfile: 'ssd',
      autoScan: true,
      autoImport: true,
    }));
  });

  it('keeps auto-import folders watched even when UI auto-scan is off', () => {
    const autoImportOnly = buildWatchFolder('D:\\Tether', {
      autoScan: false,
      autoImport: true,
    }, NOW);
    const passive = buildWatchFolder('D:\\Archive', {
      autoScan: false,
      autoImport: false,
    }, NOW);

    expect(isActiveWatchFolder(autoImportOnly)).toBe(true);
    expect(isActiveWatchFolder(passive)).toBe(false);
  });
});
