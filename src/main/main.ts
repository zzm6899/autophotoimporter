import { app, BrowserWindow, Menu, globalShortcut, shell } from 'electron';
import path from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import started from 'electron-squirrel-startup';
import { registerIpcHandlers } from './ipc-handlers';
import { ensureModelsDownloaded } from './services/model-downloader';
import { initializeLogging, log } from './logger';

initializeLogging();

if (started) {
  app.quit();
}

// Enable the Shape Detection API (FaceDetector, BarcodeDetector, TextDetector)
// in the Chromium renderer. Must be set before app ready — webPreferences alone
// is not sufficient in newer Electron versions.
app.commandLine.appendSwitch('enable-blink-features', 'ShapeDetection');

// Some Windows GPU/driver combinations can load the renderer DOM but fail to
// present it, leaving customers with a solid black window. ONNX DirectML runs in
// the main process, so disabling Chromium compositing keeps the UI reliable
// without turning off the photo analysis GPU path.
if (process.platform === 'win32' && process.env.KEPTRA_ENABLE_RENDERER_GPU !== '1') {
  app.disableHardwareAcceleration();
}

let mainWindow: BrowserWindow | null = null;
const packageSmokeMode = process.env.KEPTRA_PACKAGE_SMOKE === '1';

function modelSmokeStatus() {
  const resourcesPath = process.resourcesPath;
  const models = ['version-RFB-640.onnx', 'w600k_mbf.onnx', 'ssd_mobilenet_v1_12.onnx'];
  return {
    resourcesPath,
    onnxRuntimeNode: existsSync(path.join(resourcesPath, 'onnxruntime-node', 'dist', 'index.js')),
    models: models.map((name) => ({
      name,
      exists: existsSync(path.join(resourcesPath, 'models', name)),
    })),
  };
}

function finishPackageSmoke(ok: boolean, details: Record<string, unknown>): void {
  const payload = {
    ok,
    checkedAt: new Date().toISOString(),
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    ...details,
  };
  const output = process.env.KEPTRA_PACKAGE_SMOKE_OUTPUT;
  if (output) {
    try {
      writeFileSync(output, JSON.stringify(payload, null, 2), 'utf8');
    } catch (error) {
      log.warn('Could not write package smoke output', error);
    }
  }
  app.exit(ok ? 0 : 1);
}

function serializeError(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error);
}

function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    return [
      'updates.culler.z2hs.au',
      'github.com',
      'checkout.stripe.com',
    ].includes(url.hostname);
  } catch {
    return false;
  }
}

const createWindow = () => {
  // Remove the native menu bar entirely (File / Edit / View / Window / Help).
  // DevTools are still accessible via Ctrl+Shift+I (registered below).
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    show: false,
    // On Windows, hiddenInset alone doesn't remove the menu bar frame —
    // autoHideMenuBar ensures it is fully suppressed even if Menu is non-null.
    autoHideMenuBar: true,
    backgroundColor: '#171717',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      enableBlinkFeatures: 'ShapeDetection',
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!packageSmokeMode) {
      mainWindow?.show();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const payload = { level, sourceId, line };
    if (level >= 2) {
      log.warn(`[renderer] ${message}`, payload);
    } else {
      log.info(`[renderer] ${message}`, payload);
    }
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    log.error('Renderer failed to load', { errorCode, errorDescription, validatedURL });
    if (packageSmokeMode) {
      finishPackageSmoke(false, {
        error: 'Renderer failed to load',
        errorCode,
        errorDescription,
        validatedURL,
        resources: modelSmokeStatus(),
      });
    }
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log.error('Renderer process gone', details);
    if (packageSmokeMode) {
      finishPackageSmoke(false, {
        error: 'Renderer process gone',
        details,
        resources: modelSmokeStatus(),
      });
    }
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = mainWindow?.webContents.getURL();
    if (url !== currentUrl) {
      event.preventDefault();
    }
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  if (packageSmokeMode) {
    const timeout = setTimeout(() => {
      finishPackageSmoke(false, { error: 'Timed out waiting for renderer smoke check', resources: modelSmokeStatus() });
    }, 15000);
    mainWindow.webContents.once('did-finish-load', () => {
      void mainWindow?.webContents.executeJavaScript(`
        (async () => {
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          await new Promise((resolve) => setTimeout(resolve, 250));
          const api = window.electronAPI || {};
          const root = document.getElementById('root');
          const bodyText = document.body?.innerText || '';
          const rootRect = root?.getBoundingClientRect();
          return {
            hasApi: !!window.electronAPI,
            preloadFunctions: ['getSettings', 'startImport', 'preflightImport', 'retryFailedImport', 'exportDiagnostics', 'checkForUpdates', 'downloadUpdate', 'installUpdate']
              .filter((key) => typeof api[key] === 'function'),
            platform: api.platform,
            href: window.location.href,
            title: document.title,
            rootChildCount: root?.childElementCount ?? 0,
            rootHtmlLength: root?.innerHTML.length ?? 0,
            rootRect: rootRect ? {
              width: Math.round(rootRect.width),
              height: Math.round(rootRect.height),
            } : null,
            bodyTextLength: bodyText.length,
            bodyTextSample: bodyText.slice(0, 1000),
            hasVisibleAppText: /Source|Review|Destination|Import|Settings|Help/.test(bodyText),
          };
        })()
      `, true).then((preload) => {
        clearTimeout(timeout);
        const resources = modelSmokeStatus();
        const requiredPreload = ['getSettings', 'startImport', 'preflightImport', 'retryFailedImport', 'exportDiagnostics', 'checkForUpdates', 'downloadUpdate', 'installUpdate'];
        const preloadFunctions = Array.isArray(preload?.preloadFunctions) ? preload.preloadFunctions : [];
        const missingPreload = requiredPreload.filter((name) => !preloadFunctions.includes(name));
        const missingModels = resources.models.filter((model) => !model.exists).map((model) => model.name);
        const rendererMounted =
          Number(preload?.rootChildCount ?? 0) > 0 &&
          Number(preload?.rootHtmlLength ?? 0) > 0 &&
          preload?.hasVisibleAppText === true;
        finishPackageSmoke(missingPreload.length === 0 && rendererMounted && resources.onnxRuntimeNode && missingModels.length === 0, {
          preload,
          missingPreload,
          rendererMounted,
          resources,
          missingModels,
          updateMode: process.platform === 'darwin' ? 'manual-dmg' : 'installer-or-native',
        });
      }).catch((error) => {
        clearTimeout(timeout);
        finishPackageSmoke(false, { error: serializeError(error), resources: modelSmokeStatus() });
      });
    });
  }
};

app.on('ready', () => {
  log.info('App ready');
  registerIpcHandlers();
  createWindow();

  if (packageSmokeMode) return;

  // Ctrl+Shift+I (Win/Linux) or Cmd+Option+I (Mac) toggles DevTools.
  // Works even with no application menu.
  const devToolsShortcut = process.platform === 'darwin' ? 'Cmd+Option+I' : 'Ctrl+Shift+I';
  globalShortcut.register(devToolsShortcut, () => {
    const win = mainWindow ?? BrowserWindow.getFocusedWindow();
    if (win) {
      if (win.webContents.isDevToolsOpened()) {
        win.webContents.closeDevTools();
      } else {
        win.webContents.openDevTools();
      }
    }
  });

  // Download ONNX face models in the background if not already present.
  // Non-blocking — the app is fully usable while this runs. Progress is
  // broadcast to the renderer via FACE_MODEL_DOWNLOAD_PROGRESS.
  // Small delay so the window finishes painting before network I/O starts.
  setTimeout(() => {
    void ensureModelsDownloaded(mainWindow).catch((error) => {
      log.warn('Background model download failed', error);
    });
  }, 2000);
});

app.on('will-quit', () => {
  log.info('App will quit');
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
