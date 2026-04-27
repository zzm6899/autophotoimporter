import { app, BrowserWindow, Menu, globalShortcut } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { registerIpcHandlers } from './ipc-handlers';
import { ensureModelsDownloaded } from './services/model-downloader';

if (started) {
  app.quit();
}

// Enable the Shape Detection API (FaceDetector, BarcodeDetector, TextDetector)
// in the Chromium renderer. Must be set before app ready — webPreferences alone
// is not sufficient in newer Electron versions.
app.commandLine.appendSwitch('enable-blink-features', 'ShapeDetection');

let mainWindow: BrowserWindow | null = null;

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
    // On Windows, hiddenInset alone doesn't remove the menu bar frame —
    // autoHideMenuBar ensures it is fully suppressed even if Menu is non-null.
    autoHideMenuBar: true,
    backgroundColor: '#171717',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      enableBlinkFeatures: 'ShapeDetection',
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
};

app.on('ready', () => {
  registerIpcHandlers();
  createWindow();

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
    void ensureModelsDownloaded(mainWindow);
  }, 2000);
});

app.on('will-quit', () => {
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
