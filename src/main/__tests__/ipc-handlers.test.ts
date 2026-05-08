import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppSession, ImportConfig, ImportLedger, ImportResult, MediaFile } from '../../shared/types';

// Mocks
const mockHandle = vi.fn();
const mockOn = vi.fn();
const mockGetAllWindows = vi.fn(() => []);
const mockShowOpenDialog = vi.fn();
const mockOpenPath = vi.fn();
const mockOpenExternal = vi.fn();
const mockGetPath = vi.fn((_name: string) => '/tmp/userData');

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: Function) => mockHandle(channel, handler) },
  dialog: { showOpenDialog: (...args: unknown[]) => mockShowOpenDialog(...args) },
  shell: {
    openPath: (...args: unknown[]) => mockOpenPath(...args),
    openExternal: (...args: unknown[]) => mockOpenExternal(...args),
  },
  app: { getPath: (name: string) => mockGetPath(name), getVersion: () => '1.1.0', on: (event: string, cb: Function) => mockOn(event, cb) },
  BrowserWindow: { getAllWindows: () => mockGetAllWindows() },
  autoUpdater: {
    on: vi.fn(),
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
  },
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  chmod: vi.fn().mockResolvedValue(undefined),
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
  setRawPreviewQuality: vi.fn(),
}));

vi.mock('../services/ftp-source', () => ({
  probeFtp: vi.fn(),
  mirrorFtp: vi.fn(),
}));

vi.mock('../services/update-checker', () => ({
  checkForUpdate: vi.fn().mockResolvedValue({ status: 'up-to-date', currentVersion: '1.1.0', latestVersion: '1.1.0' }),
  fetchUpdateHistory: vi.fn().mockResolvedValue([]),
  readLastKnownGoodUpdateMetadata: vi.fn().mockResolvedValue(null),
}));

vi.mock('../services/license', () => ({
  validateLicenseKey: vi.fn((key: string) =>
    key === 'valid-key'
      ? { valid: true, key, message: 'License active.', entitlement: { product: 'photo-importer', name: 'Test', issuedAt: '2026-04-24', tier: 'Full access' } }
      : { valid: false, key, message: 'Signature check failed.' }),
  activateLicenseInput: vi.fn(async (key: string) =>
    key === 'valid-key'
      ? {
          valid: true,
          key,
          activationCode: 'PIC-TEST-1234-ABCD',
          activatedAt: '2026-04-27',
          expiresAt: '2026-05-27',
          deviceSlotsUsed: 1,
          deviceSlotsTotal: 2,
          currentDeviceRegistered: true,
          message: 'License active until 27-05-2026.',
          entitlement: {
            product: 'photo-importer',
            name: 'Test',
            issuedAt: '2026-04-24',
            activatedAt: '2026-04-27',
            activationExpiresAt: '2026-05-27',
            tier: 'Full access',
            maxDevices: 2,
          },
        }
      : { valid: false, key, message: 'Signature check failed.' }),
  checkHostedLicenseStatus: vi.fn(async (_key: string, existing: any) => existing ?? { valid: false, message: 'No license activated.' }),
}));

import { registerIpcHandlers } from '../ipc-handlers';
import { importFiles } from '../services/import-engine';
import { scanFiles } from '../services/file-scanner';
import { isDuplicate } from '../services/duplicate-detector';
import { checkForUpdate, fetchUpdateHistory } from '../services/update-checker';
import { readFile, writeFile, chmod } from 'node:fs/promises';

const mockImportFiles = vi.mocked(importFiles);
const mockScanFiles = vi.mocked(scanFiles);
const mockIsDuplicate = vi.mocked(isDuplicate);
const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockChmod = vi.mocked(chmod);
const mockCheckForUpdate = vi.mocked(checkForUpdate);
const mockFetchUpdateHistory = vi.mocked(fetchUpdateHistory);

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
    mockOpenPath.mockClear();
    mockOpenExternal.mockClear();
    mockImportFiles.mockReset();
    mockScanFiles.mockReset();
    mockReadFile.mockReset();
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    mockWriteFile.mockClear();
    mockChmod.mockReset();
    mockChmod.mockResolvedValue(undefined);
    mockCheckForUpdate.mockReset();
    mockCheckForUpdate.mockResolvedValue({ status: 'up-to-date', currentVersion: '1.1.0', latestVersion: '1.1.0' });
    mockFetchUpdateHistory.mockReset();
    mockFetchUpdateHistory.mockResolvedValue([]);
    mockIsDuplicate.mockReset();
    mockIsDuplicate.mockResolvedValue(false);
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

    it('still applies duplicate and reject filters to selected paths', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ licenseKey: 'valid-key' }) as any);
      const files: MediaFile[] = [
        { path: '/src/keep.jpg', name: 'keep.jpg', size: 100, type: 'photo', extension: '.jpg', destPath: '2026/keep.jpg' },
        { path: '/src/duplicate.jpg', name: 'duplicate.jpg', size: 100, type: 'photo', extension: '.jpg', destPath: '2026/duplicate.jpg', duplicate: true },
        { path: '/src/rejected.jpg', name: 'rejected.jpg', size: 100, type: 'photo', extension: '.jpg', destPath: '2026/rejected.jpg', pick: 'rejected' },
      ];
      mockScanFiles.mockImplementation(async (_sourcePath, onBatch: (batch: MediaFile[]) => void) => {
        onBatch(files);
        return files.length;
      });
      mockImportFiles.mockResolvedValue({ imported: 1, skipped: 0, errors: [], totalBytes: 100, durationMs: 10 });

      await getHandler('scan:start')({}, '/src');
      await getHandler('import:start')({}, {
        sourcePath: '/src',
        destRoot: '/dest',
        skipDuplicates: true,
        saveFormat: 'original',
        jpegQuality: 90,
        selectedPaths: files.map((file) => file.path),
      });

      expect(mockImportFiles).toHaveBeenLastCalledWith(
        [files[0]],
        expect.any(Object),
        expect.any(Function),
      );
    });

    it('treats an empty selected path list as an explicit empty import scope', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ licenseKey: 'valid-key' }) as any);
      const files: MediaFile[] = [
        { path: '/src/keep.jpg', name: 'keep.jpg', size: 100, type: 'photo', extension: '.jpg', destPath: '2026/keep.jpg' },
        { path: '/src/rejected.jpg', name: 'rejected.jpg', size: 100, type: 'photo', extension: '.jpg', destPath: '2026/rejected.jpg', pick: 'rejected' },
      ];
      mockScanFiles.mockImplementation(async (_sourcePath, onBatch: (batch: MediaFile[]) => void) => {
        onBatch(files);
        return files.length;
      });
      mockImportFiles.mockResolvedValue({ imported: 1, skipped: 0, errors: [], totalBytes: 100, durationMs: 10 });

      await getHandler('scan:start')({}, '/src');
      await getHandler('import:start')({}, {
        sourcePath: '/src',
        destRoot: '/dest',
        skipDuplicates: true,
        saveFormat: 'original',
        jpegQuality: 90,
        selectedPaths: [],
      });

      expect(mockImportFiles).toHaveBeenLastCalledWith(
        [],
        expect.any(Object),
        expect.any(Function),
      );
    });

    it('clears destination-only duplicate flags when rechecking a new destination', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ licenseKey: 'valid-key' }) as any);
      const files: MediaFile[] = [
        { path: '/src/keeper.jpg', name: 'keeper.jpg', size: 100, type: 'photo', extension: '.jpg', destPath: '2026/keeper.jpg' },
      ];
      mockScanFiles.mockImplementation(async (_sourcePath, onBatch: (batch: MediaFile[]) => void) => {
        onBatch(files);
        return files.length;
      });
      mockIsDuplicate.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      mockImportFiles.mockResolvedValue({ imported: 1, skipped: 0, errors: [], totalBytes: 100, durationMs: 10 });

      await getHandler('scan:start')({}, '/src');
      await getHandler('scan:check-duplicates')({}, '/dest-a');
      await getHandler('scan:check-duplicates')({}, '/dest-b');
      await getHandler('import:start')({}, {
        sourcePath: '/src',
        destRoot: '/dest-b',
        skipDuplicates: true,
        saveFormat: 'original',
        jpegQuality: 90,
      });

      expect(mockImportFiles).toHaveBeenLastCalledWith(
        [expect.objectContaining({ path: '/src/keeper.jpg', duplicate: false })],
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

    it('returns an explicit recovery error when retry paths are not in the current scan', async () => {
      const ledger: ImportLedger = {
        id: 'ledger-1',
        createdAt: '2026-05-08T00:00:00.000Z',
        sourcePath: '/src',
        destRoot: '/dest',
        saveFormat: 'original',
        totalFiles: 1,
        imported: 0,
        skipped: 0,
        failed: 1,
        pending: 0,
        totalBytes: 100,
        durationMs: 10,
        items: [
          { sourcePath: '/src/missing.jpg', name: 'missing.jpg', size: 100, status: 'failed', error: 'Disk full' },
        ],
      };
      mockReadFile.mockImplementation(async (filePath) => {
        const value = String(filePath);
        if (value.endsWith('settings.json')) return JSON.stringify({ licenseKey: 'valid-key' }) as any;
        if (value.endsWith('latest.json')) return JSON.stringify(ledger) as any;
        throw new Error('ENOENT');
      });

      const result = await getHandler('import:retry-failed')({}, {
        sourcePath: '/src',
        destRoot: '/dest',
        skipDuplicates: true,
        saveFormat: 'original',
        jpegQuality: 90,
      }) as ImportResult;

      expect(result.imported).toBe(0);
      expect(result.recoveryCount).toBe(1);
      expect(result.errors[0]).toEqual({
        file: 'recovery',
        error: 'Retry needs the previous source to be scanned first so failed and pending files can be matched.',
      });
      expect(mockImportFiles).not.toHaveBeenCalled();
    });

    it('retries only failed and pending ledger paths from the current scan', async () => {
      const files: MediaFile[] = [
        { path: '/src/failed.jpg', name: 'failed.jpg', size: 100, type: 'photo', extension: '.jpg', destPath: '2026/failed.jpg' },
        { path: '/src/pending.jpg', name: 'pending.jpg', size: 200, type: 'photo', extension: '.jpg', destPath: '2026/pending.jpg' },
        { path: '/src/imported.jpg', name: 'imported.jpg', size: 300, type: 'photo', extension: '.jpg', destPath: '2026/imported.jpg' },
        { path: '/src/skipped.jpg', name: 'skipped.jpg', size: 400, type: 'photo', extension: '.jpg', destPath: '2026/skipped.jpg' },
      ];
      const ledger: ImportLedger = {
        id: 'ledger-1',
        createdAt: '2026-05-08T00:00:00.000Z',
        sourcePath: '/src',
        destRoot: '/dest',
        saveFormat: 'original',
        totalFiles: 4,
        imported: 1,
        skipped: 1,
        failed: 1,
        pending: 1,
        totalBytes: 1000,
        durationMs: 10,
        items: [
          { sourcePath: files[0].path, name: files[0].name, size: files[0].size, status: 'failed', error: 'Disk full' },
          { sourcePath: files[1].path, name: files[1].name, size: files[1].size, status: 'pending' },
          { sourcePath: files[2].path, name: files[2].name, size: files[2].size, status: 'imported' },
          { sourcePath: files[3].path, name: files[3].name, size: files[3].size, status: 'skipped' },
        ],
      };
      mockReadFile.mockImplementation(async (filePath) => {
        const value = String(filePath);
        if (value.endsWith('settings.json')) return JSON.stringify({ licenseKey: 'valid-key' }) as any;
        if (value.endsWith('latest.json')) return JSON.stringify(ledger) as any;
        throw new Error('ENOENT');
      });
      mockScanFiles.mockImplementation(async (_sourcePath, onBatch: (batch: MediaFile[]) => void) => {
        onBatch(files);
        return files.length;
      });
      mockImportFiles.mockResolvedValue({
        imported: 2,
        skipped: 0,
        errors: [],
        totalBytes: 300,
        durationMs: 10,
        ledgerItems: [
          { sourcePath: files[0].path, name: files[0].name, size: files[0].size, status: 'imported' },
          { sourcePath: files[1].path, name: files[1].name, size: files[1].size, status: 'imported' },
        ],
      });

      await getHandler('scan:start')({}, '/src');
      const result = await getHandler('import:retry-failed')({}, {
        sourcePath: '/src',
        destRoot: '/dest',
        skipDuplicates: true,
        saveFormat: 'original',
        jpegQuality: 90,
      }) as ImportResult;

      expect(result.recoveryCount).toBe(2);
      expect(mockImportFiles).toHaveBeenLastCalledWith(
        [files[0], files[1]],
        expect.objectContaining({ selectedPaths: [files[0].path, files[1].path] }),
        expect.any(Function),
      );
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

    it('clamps saved face concurrency to a device-safe maximum', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ perfTier: 'high', faceConcurrency: 24 }) as any);
      const handler = getHandler('settings:get');
      const settings = await handler({}) as any;

      expect(settings.faceConcurrency).toBeGreaterThanOrEqual(1);
      expect(settings.faceConcurrency).toBeLessThanOrEqual(8);
    });

    it('applies low-tier performance defaults when only perfTier is saved', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ perfTier: 'low' }) as any);
      const handler = getHandler('settings:get');
      const settings = await handler({}) as any;

      expect(settings.cpuOptimization).toBe(true);
      expect(settings.rawPreviewQuality).toBe(55);
      expect(settings.faceConcurrency).toBe(1);
    });

    it('preserves explicit performance overrides on a saved tier', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ perfTier: 'low', cpuOptimization: false, rawPreviewQuality: 70 }) as any);
      const handler = getHandler('settings:get');
      const settings = await handler({}) as any;

      expect(settings.cpuOptimization).toBe(false);
      expect(settings.rawPreviewQuality).toBe(70);
      expect(settings.faceConcurrency).toBe(1);
    });

    it('persists clamped face concurrency when settings are updated', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ perfTier: 'high', faceConcurrency: 24 }) as any);
      const handler = getHandler('settings:set');

      await handler({}, { faceConcurrency: 24 });
      const written = JSON.parse(String(mockWriteFile.mock.calls[0][1]));

      expect(written.faceConcurrency).toBeGreaterThanOrEqual(1);
      expect(written.faceConcurrency).toBeLessThanOrEqual(8);
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

    it('persists hosted license status metadata on activation', async () => {
      mockReadFile
        .mockRejectedValueOnce(new Error('ENOENT'))
        .mockResolvedValueOnce(JSON.stringify({
          licenseKey: 'valid-key',
          licenseActivationCode: 'PIC-TEST-1234-ABCD',
          licenseStatus: {
            valid: true,
            key: 'valid-key',
            activationCode: 'PIC-TEST-1234-ABCD',
            activatedAt: '2026-04-27',
            expiresAt: '2026-05-27',
            deviceSlotsUsed: 1,
            deviceSlotsTotal: 2,
            currentDeviceRegistered: true,
            message: 'License active until 27-05-2026.',
            entitlement: {
              product: 'photo-importer',
              name: 'Test',
              issuedAt: '2026-04-24',
              activatedAt: '2026-04-27',
              activationExpiresAt: '2026-05-27',
              tier: 'Full access',
              maxDevices: 2,
            },
          },
        }) as any);

      const activate = getHandler('license:activate');
      const result = await activate({}, 'valid-key') as any;

      expect(mockWriteFile).toHaveBeenCalled();
      const savedJson = String(mockWriteFile.mock.calls.at(-1)?.[1] ?? '');
      const saved = JSON.parse(savedJson);
      expect(saved.licenseStatus).toEqual(expect.objectContaining({
        valid: true,
        key: 'valid-key',
        activationCode: 'PIC-TEST-1234-ABCD',
        activatedAt: '2026-04-27',
        expiresAt: '2026-05-27',
        deviceSlotsUsed: 1,
        deviceSlotsTotal: 2,
      }));
    });
  });

  describe('Sessions', () => {
    const makeSession = (): AppSession => {
      const file: MediaFile = {
        path: '/photos/IMG_0001.JPG',
        name: 'IMG_0001.JPG',
        size: 1234,
        type: 'photo',
        extension: '.jpg',
        thumbnail: 'data:image/jpeg;base64,large-preview-payload',
      };
      return {
        id: 'session-1',
        updatedAt: '2026-05-06T00:00:00.000Z',
        sourcePath: '/photos',
        destRoot: '/dest',
        files: [file],
        selectedPaths: [file.path],
        queuedPaths: [],
        filter: 'all',
        focusedPath: file.path,
        stats: { totalFiles: 1, picked: 0, rejected: 0, queued: 0, reviewed: 0 },
      };
    };

    it('persists review sessions without thumbnail payloads', async () => {
      const handler = getHandler('session:save');
      const result = await handler({}, makeSession()) as AppSession;

      expect(result.files[0].thumbnail).toBeUndefined();
      const sessionWrites = mockWriteFile.mock.calls.filter(([filePath]) => String(filePath).includes('sessions'));
      expect(sessionWrites.length).toBeGreaterThanOrEqual(2);
      for (const [, content] of sessionWrites) {
        expect(String(content)).not.toContain('large-preview-payload');
        expect(JSON.parse(String(content)).files[0].thumbnail).toBeUndefined();
      }
    });

    it('compacts old latest sessions before returning them to the renderer', async () => {
      const session = makeSession();
      mockReadFile.mockImplementation(async (filePath) => {
        if (String(filePath).includes('latest.json')) return JSON.stringify(session);
        throw new Error('ENOENT');
      });
      const handler = getHandler('session:latest');

      const result = await handler({}) as AppSession;

      expect(result.files[0].thumbnail).toBeUndefined();
      const sessionWrites = mockWriteFile.mock.calls.filter(([filePath]) => String(filePath).includes('sessions'));
      expect(sessionWrites.length).toBeGreaterThanOrEqual(2);
      for (const [, content] of sessionWrites) {
        expect(String(content)).not.toContain('large-preview-payload');
      }
    });
  });

  describe('Payload validation', () => {
    it('rejects malformed import config', async () => {
      const handler = getHandler('import:start');
      const result = await handler({}, { sourcePath: 42 }) as any;
      expect(result).toEqual({
        ok: false,
        code: 'VALIDATION_ERROR',
        message: 'Invalid import config payload.',
      });
    });

    it('rejects malformed FTP config', async () => {
      const handler = getHandler('ftp:probe');
      const result = await handler({}, { host: '', port: '21' }) as any;
      expect(result).toEqual({
        ok: false,
        code: 'VALIDATION_ERROR',
        message: 'Invalid FTP config payload.',
      });
    });

    it('rejects malformed open-external URL', async () => {
      const handler = getHandler('shell:open-external');
      const result = await handler({}, 'javascript:alert(1)') as any;
      expect(result).toEqual({
        ok: false,
        code: 'VALIDATION_ERROR',
        message: 'Invalid URL payload.',
      });
      expect(mockOpenExternal).not.toHaveBeenCalled();
    });

    it('blocks opening executable paths through shell.openPath', async () => {
      const handler = getHandler('dialog:open-path');
      const result = await handler({}, 'C:\\Windows\\System32\\calc.exe') as any;
      expect(result).toEqual({
        ok: false,
        code: 'VALIDATION_ERROR',
        message: 'Invalid path payload.',
      });
      expect(mockOpenPath).not.toHaveBeenCalled();
    });

    it('rejects invalid face analysis paths', async () => {
      const handler = getHandler('face:analyze');
      const result = await handler({}, ['C:\\Users\\test\\photo.jpg', 'C:\\Windows\\System32\\calc.exe']) as any;
      expect(result).toEqual({
        ok: false,
        code: 'VALIDATION_ERROR',
        message: 'Invalid face analysis payload.',
      });
    });

    it('rejects invalid face concurrency values', async () => {
      const handler = getHandler('face:set-concurrency');
      const result = await handler({}, 1000) as any;
      expect(result).toEqual({
        ok: false,
        code: 'VALIDATION_ERROR',
        message: 'Invalid face concurrency payload.',
      });
    });

    it('rejects malformed settings patch', async () => {
      const handler = getHandler('settings:set');
      const result = await handler({}, { ftpConfig: { host: 'bad' } }) as any;
      expect(result).toEqual({
        ok: false,
        code: 'VALIDATION_ERROR',
        message: 'Invalid settings patch payload.',
      });
    });
  });

  describe('Updates', () => {
    it('blocks non-allowlisted release URLs from renderer', async () => {
      const handler = getHandler('update:open-release');
      const result = await handler({}, 'http://evil.example.com/release') as any;
      expect(result).toEqual({
        ok: false,
        code: 'VALIDATION_ERROR',
        message: 'Release URL failed allowlist trust checks.',
      });
      expect(mockOpenExternal).not.toHaveBeenCalled();
    });

    it('returns trust-check error when download URL is not allowlisted', async () => {
      mockCheckForUpdate.mockResolvedValue({
        status: 'available',
        currentVersion: '1.1.0',
        latestVersion: '1.2.0',
        downloadUrl: 'http://evil.example.com/update.exe',
      } as any);
      const checkNow = getHandler('update:check-now');
      const download = getHandler('update:download');
      await checkNow({});
      const result = await download({}) as any;
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/trust checks/i);
    });
  });
});
