import { app, BrowserWindow } from 'electron';
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
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
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
  // Download ONNX face models in the background if not already present.
  // Non-blocking — the app is fully usable while this runs. Progress is
  // broadcast to the renderer via FACE_MODEL_DOWNLOAD_PROGRESS.
  // Small delay so the window finishes painting before network I/O starts.
  setTimeout(() => {
    void ensureModelsDownloaded(mainWindow);
  }, 2000);
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
