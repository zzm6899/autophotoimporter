import { app, BrowserWindow, Menu, globalShortcut, shell } from 'electron';
import path from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import started from 'electron-squirrel-startup';
import { registerIpcHandlers } from './ipc-handlers';
import { ensureModelsDownloaded } from './services/model-downloader';
import { initializeLogging, log } from './logger';

if (started) {
  app.quit();
}

function getRendererDevServerUrl(): string | undefined {
  return typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === 'string'
    ? MAIN_WINDOW_VITE_DEV_SERVER_URL
    : undefined;
}

const rendererDevServerUrl = getRendererDevServerUrl();

if (rendererDevServerUrl) {
  app.setPath('userData', path.join(app.getPath('appData'), 'Keptra Dev'));
}

initializeLogging();

// ONNX DirectML runs in the main process and is independent of Chromium
// compositing. Keep the renderer on Chromium defaults unless support needs to
// force software rendering for a specific machine.
if (process.platform === 'win32' && process.env.KEPTRA_DISABLE_RENDERER_GPU === '1') {
  app.disableHardwareAcceleration();
}

let mainWindow: BrowserWindow | null = null;
const packageSmokeMode = process.env.KEPTRA_PACKAGE_SMOKE === '1';
const packageSmokeShowWindow = process.env.KEPTRA_PACKAGE_SMOKE_SHOW === '1';

function getWindowIconPath(): string | undefined {
  if (process.platform === 'darwin') return undefined;
  const fileName = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  const iconPath = path.join(app.getAppPath(), 'assets', 'brand', fileName);
  return existsSync(iconPath) ? iconPath : undefined;
}

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

function imageSmokeStatus(image: Electron.NativeImage) {
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  let sampled = 0;
  let nonDark = 0;
  let minLuma = 255;
  let maxLuma = 0;
  const stride = Math.max(4, Math.floor(bitmap.length / 50000 / 4) * 4);
  for (let offset = 0; offset + 3 < bitmap.length; offset += stride) {
    const blue = bitmap[offset] ?? 0;
    const green = bitmap[offset + 1] ?? 0;
    const red = bitmap[offset + 2] ?? 0;
    const luma = Math.round((red * 0.2126) + (green * 0.7152) + (blue * 0.0722));
    minLuma = Math.min(minLuma, luma);
    maxLuma = Math.max(maxLuma, luma);
    if (luma > 35) nonDark += 1;
    sampled += 1;
  }
  const nonDarkRatio = sampled > 0 ? nonDark / sampled : 0;
  return {
    width,
    height,
    sampled,
    nonDarkRatio: Number(nonDarkRatio.toFixed(4)),
    lumaRange: maxLuma - minLuma,
    ok: width > 0 && height > 0 && nonDarkRatio > 0.01 && (maxLuma - minLuma) > 8,
  };
}

function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    return [
      'keptra.z2hs.au',
      'updates.keptra.z2hs.au',
      'admin.keptra.z2hs.au',
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
  const windowIconPath = getWindowIconPath();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    ...(windowIconPath ? { icon: windowIconPath } : {}),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
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
    },
  });

  let windowShown = false;
  const showMainWindow = () => {
    if (windowShown) return;
    if (!packageSmokeMode || packageSmokeShowWindow) {
      windowShown = true;
      mainWindow?.show();
    }
  };
  mainWindow.once('ready-to-show', showMainWindow);
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(showMainWindow, 250);
  });
  setTimeout(showMainWindow, 3000);

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

  if (rendererDevServerUrl) {
    mainWindow.loadURL(rendererDevServerUrl);
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
          const smokeErrors = [];
          const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          window.addEventListener('error', (event) => {
            smokeErrors.push(event.message || String(event.error || 'window error'));
          });
          window.addEventListener('unhandledrejection', (event) => {
            smokeErrors.push(String(event.reason || 'unhandled rejection'));
          });
          const text = () => document.body?.innerText || '';
          const visibleButtons = () => Array.from(document.querySelectorAll('button'))
            .filter((button) => {
              const rect = button.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0 && getComputedStyle(button).visibility !== 'hidden';
            });
          const buttonLabel = (button) => [button.innerText, button.title, button.getAttribute('aria-label')]
            .filter(Boolean)
            .join(' ')
            .replace(/\\s+/g, ' ')
            .trim();
          const findButton = (pattern) => visibleButtons()
            .find((button) => pattern.test(buttonLabel(button)));
          const clickButton = async (name, pattern, expectedPatterns = []) => {
            const button = findButton(pattern);
            if (!button) return { name, found: false, ok: false };
            const disabled = button.disabled || button.getAttribute('aria-disabled') === 'true';
            if (!disabled) {
              button.click();
              await wait(180);
            }
            const bodyText = text();
            const expectations = expectedPatterns.map((expected) => ({
              expected: expected.source,
              found: expected.test(bodyText),
            }));
            return {
              name,
              found: true,
              disabled,
              label: buttonLabel(button),
              expectations,
              ok: !disabled && expectations.every((item) => item.found),
            };
          };
          const dismiss = async () => {
            for (const pattern of [/Dismiss performance setup/i, /Got it/i, /Later/i, /^Close$/i]) {
              const button = findButton(pattern);
              if (
                button &&
                /Quick Start|Activate Keptra|performance setup|Optimize settings|Update check failed|Updates locked|Update available|Update ready/i.test(text())
              ) {
                button.click();
                await wait(120);
              }
            }
          };
          await dismiss();
          const interactions = [];
          interactions.push(await clickButton('source ftp tab', /(^|\\s)FTP(\\s|$)/i, [/FTP Source/i, /Host/i, /Mirror and scan/i]));
          interactions.push(await clickButton('source drive tab', /(^|\\s)Drive(\\s|$)/i, [/Choose Folder/i, /HOW IT WORKS/i]));
          interactions.push(await clickButton('settings page', /(^|\\s)Settings(\\s|$)/i, [/General/i, /Workflow/i, /Account/i]));
          interactions.push(await clickButton('settings workflow tab', /(^|\\s)Workflow(\\s|$)/i, [/Backup Copy/i, /Folder/i]));
          interactions.push(await clickButton('settings account tab', /(^|\\s)Account(\\s|$)/i, [/License/i, /Buy license|Activate|Manage/i]));
          interactions.push(await clickButton('settings close', /Back|Close/i, [/HOW IT WORKS|Choose Folder/i]));
          await dismiss();
          interactions.push(await clickButton('help center', /(^|\\s)Help(\\s|$)/i, [/Help Center/i, /Fast Cull/i, /Fixed Shortcuts/i]));
          interactions.push(await clickButton('help close', /(^|\\s)Close(\\s|$)/i, [/HOW IT WORKS|Choose Folder/i]));
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
            visibleButtonCount: visibleButtons().length,
            visibleButtonsSample: visibleButtons().slice(0, 80).map(buttonLabel),
            interactions,
            smokeErrors,
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
        const interactionFailures = Array.isArray(preload?.interactions)
          ? preload.interactions.filter((item: { ok?: boolean }) => !item.ok)
          : [{ name: 'interactions unavailable' }];
        const smokeErrors = Array.isArray(preload?.smokeErrors) ? preload.smokeErrors : [];
        void mainWindow?.webContents.capturePage().then((image) => {
          const imageStatus = imageSmokeStatus(image);
          const output = process.env.KEPTRA_PACKAGE_SMOKE_OUTPUT;
          if (output) {
            try {
              writeFileSync(output.replace(/\.json$/i, '.png'), image.toPNG());
            } catch (error) {
              log.warn('Could not write package smoke screenshot', error);
            }
          }
          finishPackageSmoke(
            missingPreload.length === 0 &&
              rendererMounted &&
              interactionFailures.length === 0 &&
              smokeErrors.length === 0 &&
              imageStatus.ok &&
              resources.onnxRuntimeNode &&
              missingModels.length === 0,
            {
              preload,
              missingPreload,
              rendererMounted,
              interactionFailures,
              smokeErrors,
              imageStatus,
              resources,
              missingModels,
              updateMode: process.platform === 'darwin' ? 'manual-dmg' : 'installer-or-native',
            },
          );
        }).catch((error) => {
          finishPackageSmoke(false, {
            error: serializeError(error),
            preload,
            missingPreload,
            rendererMounted,
            resources,
            missingModels,
          });
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
