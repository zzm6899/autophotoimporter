import { EventEmitter } from 'node:events';
import { watch } from 'node:fs';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { buildWatchFolder, isActiveWatchFolder, normalizeWatchFolder, normalizeWatchFolders, WatchFolderManager } from '../watch-folders';

vi.mock('node:fs', () => ({
  watch: vi.fn(),
}));

const NOW = '2026-05-02T00:00:00.000Z';
const mockWatch = vi.mocked(watch);

type MockWatcher = EventEmitter & {
  close: ReturnType<typeof vi.fn>;
  ref: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
};

function makeWatcher(): MockWatcher {
  return Object.assign(new EventEmitter(), { close: vi.fn(), ref: vi.fn(), unref: vi.fn() });
}

describe('watch-folders service', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockWatch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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

  it('debounces bursts of watch events into one trigger after the folder settles', () => {
    const watcher = makeWatcher();
    const onTrigger = vi.fn();
    mockWatch.mockReturnValue(watcher as ReturnType<typeof watch>);

    const manager = new WatchFolderManager(onTrigger);
    manager.update([buildWatchFolder('D:\\Tether', {}, NOW)]);

    const listener = (mockWatch.mock.calls[0] as unknown as [unknown, unknown, (eventType: string, filename?: string) => void])[2];
    listener('rename', 'first.jpg');
    vi.advanceTimersByTime(1000);
    listener('change', 'second.jpg');
    vi.advanceTimersByTime(2999);
    expect(onTrigger).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(onTrigger).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'change',
      filename: 'second.jpg',
    }));

    manager.stop();
  });

  it('uses the latest folder settings for an existing watcher', () => {
    const watcher = makeWatcher();
    const onTrigger = vi.fn();
    mockWatch.mockReturnValue(watcher as ReturnType<typeof watch>);

    const manager = new WatchFolderManager(onTrigger);
    const folder = buildWatchFolder('D:\\Tether', { autoImport: true }, NOW);
    manager.update([folder]);
    manager.update([{ ...folder, autoImport: false, autoScan: true, updatedAt: '2026-05-02T00:01:00.000Z' }]);

    const listener = (mockWatch.mock.calls[0] as unknown as [unknown, unknown, (eventType: string, filename?: string) => void])[2];
    listener('change', 'photo.jpg');
    vi.advanceTimersByTime(3000);

    expect(mockWatch).toHaveBeenCalledTimes(1);
    expect(onTrigger).toHaveBeenCalledWith(expect.objectContaining({
      folder: expect.objectContaining({
        autoImport: false,
        updatedAt: '2026-05-02T00:01:00.000Z',
      }),
    }));

    manager.stop();
  });
});
