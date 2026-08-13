// End-to-end main-process preview pipeline test with REAL fs, file-scanner,
// exif-parser, exifr, and sharp. Only Electron and heavyweight externals are
// mocked. Exercises: scan -> embedded RAW thumbnail extraction -> protocol
// URL emission -> keptra-preview protocol handler -> JPEG bytes.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, statSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'keptra-it-'));
const userDataDir = path.join(tmpRoot, 'userData');
const tempDir = path.join(tmpRoot, 'temp');
mkdirSync(userDataDir, { recursive: true });
mkdirSync(tempDir, { recursive: true });

const ipcHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const protocolHandlers = new Map<string, (request: { url: string }) => Promise<Response>>();
const rendererEvents: Array<{ channel: string; args: unknown[] }> = [];

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => ipcHandlers.set(channel, handler) },
  protocol: {
    handle: (scheme: string, handler: (request: { url: string }) => Promise<Response>) => protocolHandlers.set(scheme, handler),
    registerSchemesAsPrivileged: vi.fn(),
  },
  app: {
    getPath: (name: string) => (name === 'temp' ? tempDir : userDataDir),
    getVersion: () => '0.0.0-test',
    on: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: () => [{
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, ...args: unknown[]) => rendererEvents.push({ channel, args }),
        isDestroyed: () => false,
      },
    }],
  },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
  autoUpdater: { on: vi.fn(), setFeedURL: vi.fn(), checkForUpdates: vi.fn(), quitAndInstall: vi.fn() },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
}));

vi.mock('../services/volume-watcher', () => ({
  listVolumes: vi.fn().mockResolvedValue([]),
  startWatching: vi.fn(),
  stopWatching: vi.fn(),
}));

vi.mock('../services/import-engine', () => ({
  importFiles: vi.fn(),
  cancelImport: vi.fn(),
  planImportFiles: vi.fn(async () => ({ items: [], sessionWarnings: [] })),
}));

vi.mock('../services/duplicate-detector', () => ({ isDuplicate: vi.fn() }));
vi.mock('../services/ftp-source', () => ({ probeFtp: vi.fn(), mirrorFtp: vi.fn() }));
vi.mock('../services/update-checker', () => ({
  checkForUpdate: vi.fn().mockResolvedValue({ status: 'up-to-date' }),
  fetchUpdateHistory: vi.fn().mockResolvedValue([]),
  readLastKnownGoodUpdateMetadata: vi.fn().mockResolvedValue(null),
}));
vi.mock('../services/license', () => ({
  validateLicenseKey: vi.fn(() => ({ valid: false, message: 'test' })),
  activateLicenseInput: vi.fn(async () => ({ valid: false, message: 'test' })),
  checkHostedLicenseStatus: vi.fn(async () => ({ valid: false, message: 'test' })),
}));
vi.mock('../services/face-engine', () => ({
  analyzeFaces: vi.fn(),
  faceModelsAvailable: vi.fn(async () => false),
  serializeEmbedding: vi.fn(),
  isGpuAvailable: vi.fn(async () => false),
  getActualExecutionProvider: vi.fn(() => null),
  getFaceFeatureOptions: vi.fn((profile: string) => ({
    faceDetection: true,
    personDetection: profile !== 'detect',
    faceMatching: false,
    poseAnalysis: false,
    embeddingLimit: 0,
  })),
  getFaceProviderDiagnostics: vi.fn(() => ({})),
  getProductionFastDetectorRuntimeStatus: vi.fn(() => ({
    state: 'unchecked',
    active: false,
    faceModel: 'yunet',
    personModel: 'nanodet',
    faceRuns: 0,
    personRuns: 0,
    ssdFallbacks: 0,
    ssdFallbackRate: null,
    legacyFaceFallbacks: 0,
    legacyPersonFallbacks: 0,
  })),
  configureGpuAcceleration: vi.fn(),
  configureGpuDevice: vi.fn(),
  configureCpuOptimization: vi.fn(),
  configureFaceFeatureOptions: vi.fn(),
  configureFaceThroughput: vi.fn(),
  clearImageDecodeCache: vi.fn(),
  diagnoseFaceEngine: vi.fn(),
  runFaceGpuStressTest: vi.fn(),
  isNanoDetSportsFallbackActive: vi.fn(async () => false),
  cancelActiveFacePreprocessing: vi.fn(),
  disposeFaceEngine: vi.fn(async () => undefined),
}));
vi.mock('../services/pose-engine', () => ({
  configurePoseAnalysis: vi.fn(),
  poseModelAvailable: vi.fn(() => false),
}));
vi.mock('../services/catalog', () => ({
  openCatalog: vi.fn(async () => ({
    upsertMediaFiles: vi.fn(async () => ({ upserted: 0, duplicateCandidates: [] })),
    findDuplicateMemory: vi.fn(async () => []),
    close: vi.fn(async () => undefined),
  })),
}));
vi.mock('../services/face-cache', () => ({
  getCachedFaceResult: vi.fn(async () => null),
  getBestCachedFaceResult: vi.fn(async () => null),
  setCachedFaceResult: vi.fn(async () => undefined),
  clearFaceCache: vi.fn(),
  closeFaceCache: vi.fn(),
}));

import sharp from 'sharp';
import { registerIpcHandlers } from '../ipc-handlers';
import { analyzeFaces } from '../services/face-engine';
import { setCachedFaceResult } from '../services/face-cache';

const mockAnalyzeFaces = vi.mocked(analyzeFaces);
const mockSetCachedFaceResult = vi.mocked(setCachedFaceResult);

function getHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const handler = ipcHandlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler;
}

function tiffEntry(tag: number, type: number, count: number, value: number): Buffer {
  const b = Buffer.alloc(12);
  b.writeUInt16LE(tag, 0);
  b.writeUInt16LE(type, 2);
  b.writeUInt32LE(count, 4);
  b.writeUInt32LE(value, 8);
  return b;
}

// Minimal NEF-style TIFF: IFD0 (dimensions) -> IFD1 with an embedded JPEG
// thumbnail via JPEGInterchangeFormat — the same layout exifr.thumbnail()
// reads from real Nikon NEFs.
async function writeSyntheticNef(filePath: string): Promise<number> {
  const thumb = await sharp({ create: { width: 160, height: 120, channels: 3, background: { r: 200, g: 120, b: 40 } } })
    .jpeg({ quality: 80 })
    .toBuffer();
  const header = Buffer.alloc(8);
  header.write('II', 0, 'ascii');
  header.writeUInt16LE(42, 2);
  header.writeUInt32LE(8, 4);
  const ifd0Count = 2;
  const ifd1Offset = 8 + 2 + ifd0Count * 12 + 4;
  const ifd1Count = 4;
  const thumbOffset = ifd1Offset + 2 + ifd1Count * 12 + 4;
  const ifd0 = Buffer.concat([
    (() => { const b = Buffer.alloc(2); b.writeUInt16LE(ifd0Count, 0); return b; })(),
    tiffEntry(0x0100, 3, 1, 6000),
    tiffEntry(0x0101, 3, 1, 4000),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(ifd1Offset, 0); return b; })(),
  ]);
  const ifd1 = Buffer.concat([
    (() => { const b = Buffer.alloc(2); b.writeUInt16LE(ifd1Count, 0); return b; })(),
    tiffEntry(0x0103, 3, 1, 6),
    tiffEntry(0x0112, 3, 1, 1),
    tiffEntry(0x0201, 4, 1, thumbOffset),
    tiffEntry(0x0202, 4, 1, thumb.length),
    Buffer.alloc(4),
  ]);
  writeFileSync(filePath, Buffer.concat([header, ifd0, ifd1, thumb]));
  return thumb.length;
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 8000): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('preview pipeline integration (real scanner + exifr + sharp)', () => {
  const sourceDir = path.join(tmpRoot, 'card');
  let nefPath: string;
  let jpegPath: string;

  beforeAll(async () => {
    mkdirSync(sourceDir, { recursive: true });
    nefPath = path.join(sourceDir, 'IMG_0001.NEF');
    jpegPath = path.join(sourceDir, 'IMG_0002.JPG');
    await writeSyntheticNef(nefPath);
    const jpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 30, g: 90, b: 160 } } })
      .jpeg({ quality: 85 })
      .toBuffer();
    writeFileSync(jpegPath, jpeg);
    registerIpcHandlers();
  });

  it('scans RAW files and serves grid thumbnails through the preview protocol', async () => {
    await getHandler('scan:start')({}, sourceDir, undefined, 'it-scan');

    // Thumbnails stream in the background after scan completion.
    const nefThumbEvent = await waitFor(() =>
      rendererEvents.find((e) => e.channel === 'scan:thumbnail' && String(e.args[1]) === nefPath));
    const url = String(nefThumbEvent.args[2]);
    expect(url.startsWith('keptra-preview://')).toBe(true);
    expect(url).toContain('variant=thumb');

    const protocolHandler = protocolHandlers.get('keptra-preview');
    expect(protocolHandler).toBeTypeOf('function');
    const response = await protocolHandler!({ url });
    expect(response.status).toBe(200);
    const body = Buffer.from(await response.arrayBuffer());
    // JPEG magic bytes — the embedded NEF thumbnail made it through intact.
    expect(body[0]).toBe(0xff);
    expect(body[1]).toBe(0xd8);
    expect(body.length).toBeGreaterThan(100);
  });

  it('serves the JPEG grid thumbnail too', async () => {
    const jpgThumbEvent = await waitFor(() =>
      rendererEvents.find((e) => e.channel === 'scan:thumbnail' && String(e.args[1]) === jpegPath));
    const url = String(jpgThumbEvent.args[2]);
    const response = await protocolHandlers.get('keptra-preview')!({ url });
    expect(response.status).toBe(200);
    const body = Buffer.from(await response.arrayBuffer());
    expect(body[0]).toBe(0xff);
    expect(body[1]).toBe(0xd8);
  });

  it('does not return or cache AI evidence when source bytes change while queued analysis runs', async () => {
    let analysisStarted!: () => void;
    const started = new Promise<void>((resolve) => { analysisStarted = resolve; });
    let finishAnalysis!: () => void;
    const finish = new Promise<void>((resolve) => { finishAnalysis = resolve; });
    mockSetCachedFaceResult.mockClear();
    mockAnalyzeFaces.mockImplementationOnce(async () => {
      analysisStarted();
      await finish;
      return {
        boxes: [{ x: 0.2, y: 0.2, width: 0.2, height: 0.2, score: 0.9 }],
        personBoxes: [], embeddings: [], embeddingBoxes: [], poses: [],
        features: {
          faceMatching: false, personDetection: false, poseAnalysis: false,
          embeddingLimit: 0, eyeDetail: false,
        },
      };
    });

    const pending = getHandler('face:analyze')({}, jpegPath, {
      profile: 'detect', orientation: 1,
    }) as Promise<Array<{ errorCode?: string; faceCount: number }>>;
    await started;
    const before = statSync(jpegPath);
    utimesSync(jpegPath, before.atime, new Date(before.mtimeMs + 2_000));
    finishAnalysis();

    await expect(pending).resolves.toEqual([
      expect.objectContaining({ errorCode: 'SOURCE_CHANGED', faceCount: 0 }),
    ]);
    expect(mockSetCachedFaceResult).not.toHaveBeenCalled();
  });

  it('serves thumbnails after a session restore re-registers files (app-restart case)', async () => {
    // Simulate an app restart: a fresh source the main process has never
    // scanned. Without registration, the guard must reject; after
    // SESSION_REGISTER_FILES, thumbnails must serve.
    const restoredDir = path.join(tmpRoot, 'restored');
    mkdirSync(restoredDir, { recursive: true });
    const restoredNef = path.join(restoredDir, 'IMG_0100.NEF');
    await writeSyntheticNef(restoredNef);
    const { statSync } = await import('node:fs');
    const s = statSync(restoredNef);

    const guardedUrl = `keptra-preview://media/?path=${encodeURIComponent(restoredNef)}&variant=thumb&v=x`;
    const protocolHandler = protocolHandlers.get('keptra-preview')!;
    const rejected = await protocolHandler({ url: guardedUrl });
    expect(rejected.status).toBe(404);

    const restoredFile = {
      path: restoredNef,
      name: 'IMG_0100.NEF',
      size: s.size,
      sourceModifiedAtMs: s.mtimeMs,
      type: 'photo',
      extension: '.nef',
    } as const;
    const restoreSession = {
      id: 'preview-restore-session',
      updatedAt: '2026-08-13T00:00:00.000Z',
      sourcePath: restoredDir,
      destRoot: null,
      files: [restoredFile],
      selectedPaths: [],
      queuedPaths: [],
      filter: 'all',
      focusedPath: restoredNef,
      stats: { totalFiles: 1, picked: 0, rejected: 0, queued: 0, reviewed: 0 },
    };
    // Persist only after the main process has discovered the source. Then scan
    // an empty source to simulate a restarted process with no active allow-list.
    await getHandler('scan:start')({}, restoredDir, undefined, 'it-restore-source');
    await getHandler('session:save')({}, restoreSession);
    const emptyDir = path.join(tmpRoot, 'empty-after-restore');
    mkdirSync(emptyDir, { recursive: true });
    await getHandler('scan:start')({}, emptyDir, undefined, 'it-empty-source');
    await getHandler('session:latest')({});
    const register = getHandler('session:register-files');
    await register({}, {
      action: 'begin', generation: 'preview-restore', restoreSessionId: restoreSession.id, totalFiles: 1,
    });
    await register({}, { action: 'append', generation: 'preview-restore', offset: 0, files: [restoredFile] });
    const registration = await register({}, {
      action: 'finalize', generation: 'preview-restore',
    }) as { registered: number };
    expect(registration.registered).toBe(1);

    // Renderer hydration path: SCAN_PREVIEW with variant=thumb returns a URL...
    const ensured = await getHandler('scan:preview')({}, restoredNef, 'thumb') as { src: string } | undefined;
    expect(ensured?.src).toContain('variant=thumb');
    // ...and the protocol now serves the bytes.
    const served = await protocolHandler({ url: ensured!.src });
    expect(served.status).toBe(200);
    const body = Buffer.from(await served.arrayBuffer());
    expect(body[0]).toBe(0xff);
    expect(body[1]).toBe(0xd8);
  });

  it('serves loupe previews for RAW via SCAN_PREVIEW ensure + protocol fetch', async () => {
    // The restore test above replaced the registered set — re-register the
    // scanned files (registration is a wholesale swap by design, mirroring
    // how a session restore replaces the renderer's working set).
    const { statSync } = await import('node:fs');
    const files = [nefPath, jpegPath].map((filePath) => ({
      path: filePath,
      name: path.basename(filePath),
      size: statSync(filePath).size,
      sourceModifiedAtMs: statSync(filePath).mtimeMs,
      type: 'photo' as const,
      extension: path.extname(filePath).toLowerCase(),
    }));
    const restoreSession = {
      id: 'preview-loupe-session', updatedAt: '2026-08-13T00:01:00.000Z',
      sourcePath: sourceDir, destRoot: null, files, selectedPaths: [], queuedPaths: [],
      filter: 'all', focusedPath: nefPath,
      stats: { totalFiles: files.length, picked: 0, rejected: 0, queued: 0, reviewed: 0 },
    };
    await getHandler('scan:start')({}, sourceDir, undefined, 'it-loupe-source');
    await getHandler('session:save')({}, restoreSession);
    const emptyDir = path.join(tmpRoot, 'empty-before-loupe-restore');
    mkdirSync(emptyDir, { recursive: true });
    await getHandler('scan:start')({}, emptyDir, undefined, 'it-loupe-empty');
    await getHandler('session:latest')({});
    const register = getHandler('session:register-files');
    await register({}, {
      action: 'begin', generation: 'preview-loupe', restoreSessionId: restoreSession.id, totalFiles: files.length,
    });
    await register({}, { action: 'append', generation: 'preview-loupe', offset: 0, files });
    await register({}, { action: 'finalize', generation: 'preview-loupe' });
    const result = await getHandler('scan:preview')({}, nefPath, 'preview') as { src: string } | undefined;
    expect(result?.src.startsWith('keptra-preview://')).toBe(true);
    const response = await protocolHandlers.get('keptra-preview')!({ url: result!.src });
    expect(response.status).toBe(200);
    const body = Buffer.from(await response.arrayBuffer());
    expect(body[0]).toBe(0xff);
    expect(body[1]).toBe(0xd8);
  });
});
