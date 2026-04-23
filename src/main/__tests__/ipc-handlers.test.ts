import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ImportConfig, ImportResult, MediaFile } from '../../shared/types';

// Mocks
const mockHandle = vi.fn();
const mockOn = vi.fn();
const mockGetAllWindows = vi.fn(() => []);
const mockShowOpenDialog = vi.fn();
const mockOpenPath = vi.fn();
const mockGetPath = vi.fn((_name: string) => '/tmp/userData');

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: Function) => mockHandle(channel, handler) },
  dialog: { showOpenDialog: (...args: unknown[]) => mockShowOpenDialog(...args) },
  shell: { openPath: (...args: unknown[]) => mockOpenPath(...args) },
  app: { getPath: (name: string) => mockGetPath(name), on: (event: string, cb: Function) => mockOn(event, cb) },
  BrowserWindow: { getAllWindows: () => mockGetAllWindows() },
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  statfs: vi.fn(),
}));

vi.mock('../services/volume-watcher', () => ({
  listVolumes: vi.fn().mockResolvedValue([]),
  startWatching: vi.fn(),
  stopWatching: vi.fn(),
}));

vi.mock('../services/file-scanner', () => ({
  scanFiles: vi.fn(),
  cancelScan: vi.fn(),
}));

vi.mock('../services/import-engine', () => ({
  importFiles: vi.fn(),
  cancelImport: vi.fn(),
}));

vi.mock('../services/duplicate-detector', () => ({
  isDuplicate: vi.fn(),
}));

vi.mock('../services/exif-parser', () => ({
  generatePreview: vi.fn(),
}));

vi.mock('../services/ftp-source', () => ({
  probeFtp: vi.fn(),
  mirrorFtp: vi.fn(),
}));

vi.mock('../services/update-checker', () => ({
  checkForUpdate: vi.fn().mockResolvedValue(null),
}));

vi.mock('../services/license', () => ({
  validateLicenseKey: vi.fn((key: string) =>
    key === 'valid-key'
      ? { valid: true, key, message: 'License active.', entitlement: { product: 'photo-importer', name: 'Test', issuedAt: '2026-04-24', tier: 'Full access' } }
      : { valid: false, key, message: 'Signature check failed.' }),
}));

import { registerIpcHandlers } from '../ipc-handlers';
import { importFiles } from '../services/import-engine';
import { scanFiles } from '../services/file-scanner';
import { readFile } from 'node:fs/promises';

const mockImportFiles = vi.mocked(importFiles);
const mockScanFiles = vi.mocked(scanFiles);
const mockReadFile = vi.mocked(readFile);

// Helper: register all handlers, then extract the handler function for a given channel
function getHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  registerIpcHandlers();
  const call = mockHandle.mock.calls.find((c: unknown[]) => c[0] === channel);
  if (!call) throw new Error(`No handler registered for ${channel}`);
  return call[1] as (...args: unknown[]) => Promise<unknown>;
}

describe('IPC Handlers', () => {
  beforeEach(() => {
    mockHandle.mockClear();
    mockOn.mockClear();
  });

  describe('IMPORT_START', () => {
    it('catches exceptions and returns ImportResult with error (Bug 1 fix)', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ licenseKey: 'valid-key' }) as any);
      mockImportFiles.mockRejectedValue(new Error('Unexpected crash'));
      const handler = getHandler('import:start');
      const config: ImportConfig = {
        sourcePath: '/src',
        destRoot: '/dest',
        skipDuplicates: true,
        saveFormat: 'original',
        jpegQuality: 90,
      };

      const result = (await handler({}, config)) as ImportResult;

      expect(result.imported).toBe(0);
      expect(result.errors).toEqual([{ file: 'system', error: 'Unexpected crash' }]);
      expect(result.totalBytes).toBe(0);
    });

    it('filters files without destPath', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ licenseKey: 'valid-key' }) as any);
      const successResult: ImportResult = { imported: 0, skipped: 0, errors: [], totalBytes: 0, durationMs: 0 };
      mockImportFiles.mockResolvedValue(successResult);
      const handler = getHandler('import:start');

      await handler({}, { sourcePath: '/src', destRoot: '/dest', skipDuplicates: true, saveFormat: 'original', jpegQuality: 90 });

      // importFiles should be called with filtered array (scannedFiles is empty at start)
      expect(mockImportFiles).toHaveBeenCalledWith(
        [],
        expect.any(Object),
        expect.any(Function),
      );
    });

    it('sends progress events to renderer', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ licenseKey: 'valid-key' }) as any);
      const mockWin = { webContents: { send: vi.fn() } };
      mockGetAllWindows.mockReturnValue([mockWin] as any);

      mockImportFiles.mockImplementation(async (_files, _config, onProgress) => {
        onProgress({ currentFile: 'test.jpg', currentIndex: 1, totalFiles: 1, bytesTransferred: 100, totalBytes: 100, skipped: 0, errors: 0 });
        return { imported: 1, skipped: 0, errors: [], totalBytes: 100, durationMs: 10 };
      });

      const handler = getHandler('import:start');
      await handler({}, { sourcePath: '/src', destRoot: '/dest', skipDuplicates: true, saveFormat: 'original', jpegQuality: 90 });

      expect(mockWin.webContents.send).toHaveBeenCalledWith('import:progress', expect.objectContaining({ currentFile: 'test.jpg' }));
    });
  });

  describe('SCAN_START', () => {
    it('catches errors and sends SCAN_COMPLETE(0)', async () => {
      const mockWin = { webContents: { send: vi.fn() } };
      mockGetAllWindows.mockReturnValue([mockWin] as any);
      mockScanFiles.mockRejectedValue(new Error('scan failed'));

      const handler = getHandler('scan:start');
      await handler({}, '/some/path');

      expect(mockWin.webContents.send).toHaveBeenCalledWith('scan:complete', 0);
    });

    it('accumulates batches and sends SCAN_COMPLETE with total', async () => {
      const mockWin = { webContents: { send: vi.fn() } };
      mockGetAllWindows.mockReturnValue([mockWin] as any);
      mockScanFiles.mockResolvedValue(5);

      const handler = getHandler('scan:start');
      await handler({}, '/some/path');

      expect(mockWin.webContents.send).toHaveBeenCalledWith('scan:complete', 5);
    });
  });

  describe('Settings', () => {
    it('returns defaults when settings file is missing', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));
      const handler = getHandler('settings:get');
      const settings = await handler({});

      expect(settings).toEqual(expect.objectContaining({
        skipDuplicates: true,
        saveFormat: 'original',
        jpegQuality: 90,
      }));
    });

    it('parses valid JSON settings', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ skipDuplicates: false, theme: 'light' }) as any);
      const handler = getHandler('settings:get');
      const settings = await handler({}) as any;

      expect(settings.skipDuplicates).toBe(false);
      expect(settings.theme).toBe('light');
    });

    it('returns defaults on JSON parse error', async () => {
      mockReadFile.mockResolvedValue('not-json' as any);
      const handler = getHandler('settings:get');

      // JSON.parse will throw, caught by loadSettings
      const settings = await handler({}) as any;
      expect(settings.skipDuplicates).toBe(true);
    });

    it('rejects an invalid license key', async () => {
      const generate = getHandler('license:activate');
      const result = await generate({}, 'not-a-real-key') as any;
      expect(result.valid).toBe(false);
    });
  });
});
