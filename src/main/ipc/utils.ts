import { BrowserWindow } from 'electron';

export function getMainWindow(): Electron.BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null;
}

export function sendToRenderer(channel: string, ...args: unknown[]): void {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  const { webContents } = win;
  if (webContents.isDestroyed() || webContents.isCrashed()) return;
  try {
    webContents.send(channel, ...args);
  } catch {
    // The renderer can disappear during dev restarts or shutdown. Dropping
    // non-critical status events keeps background jobs from taking down Forge.
  }
}

export function asErrorResult(error: unknown, fallback: string): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : fallback };
}
