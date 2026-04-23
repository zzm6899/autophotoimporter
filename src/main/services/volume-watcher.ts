import { execFile } from 'node:child_process';
import { watch, existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Volume } from '../../shared/types';

const execFileAsync = promisify(execFile);

// Cross-platform constants
const MAC_VOLUMES_DIR = '/Volumes';
const LINUX_MEDIA_DIRS = ['/media', '/run/media', '/mnt'];
const DEBOUNCE_MS = 500;
const WIN_POLL_MS = 2500;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let fsWatcher: ReturnType<typeof watch> | null = null;
let fsWatchers: ReturnType<typeof watch>[] = [];
let winPollTimer: ReturnType<typeof setInterval> | null = null;
let lastWinSignature = '';
let changeCallback: ((volumes: Volume[]) => void) | null = null;

// --------------------------------------------------------------
// macOS
// --------------------------------------------------------------

async function getMacVolumeInfo(volumePath: string): Promise<Volume | null> {
  try {
    const { stdout } = await execFileAsync('diskutil', ['info', '-plist', volumePath]);
    const isRemovable = stdout.includes('<key>Removable</key>\n\t<true/>') ||
      stdout.includes('<key>RemovableMedia</key>\n\t<true/>');
    const isExternal = stdout.includes('<key>Internal</key>\n\t<false/>');
    const isNetwork = stdout.includes('<key>Network</key>\n\t<true/>');

    if (isNetwork) return null;

    let totalSize: number | undefined;
    let freeSpace: number | undefined;
    const totalMatch = stdout.match(/<key>TotalSize<\/key>\s*<integer>(\d+)<\/integer>/);
    const freeMatch = stdout.match(/<key>ContainerFree<\/key>\s*<integer>(\d+)<\/integer>/) ||
      stdout.match(/<key>APFSContainerFree<\/key>\s*<integer>(\d+)<\/integer>/) ||
      stdout.match(/<key>FreeSpace<\/key>\s*<integer>(\d+)<\/integer>/);

    if (totalMatch) totalSize = parseInt(totalMatch[1], 10);
    if (freeMatch) freeSpace = parseInt(freeMatch[1], 10);

    const hasDcim = await detectDcim(volumePath);

    return {
      name: path.basename(volumePath),
      path: volumePath,
      isRemovable,
      isExternal,
      totalSize,
      freeSpace,
      hasDcim,
    };
  } catch {
    return null;
  }
}

async function listMacVolumes(): Promise<Volume[]> {
  if (!existsSync(MAC_VOLUMES_DIR)) return [];
  const entries = await readdir(MAC_VOLUMES_DIR);
  const volumes: Volume[] = [];
  for (const entry of entries) {
    if (entry === 'Macintosh HD' || entry === 'Macintosh HD - Data') continue;
    const volumePath = path.join(MAC_VOLUMES_DIR, entry);
    const info = await getMacVolumeInfo(volumePath);
    if (info && (info.isExternal || info.isRemovable)) {
      volumes.push(info);
    }
  }
  return volumes;
}

// --------------------------------------------------------------
// Windows
// --------------------------------------------------------------

// Uses PowerShell Get-CimInstance Win32_LogicalDisk.
// DriveType: 2=Removable, 3=Fixed, 4=Network, 5=CD-ROM, 6=RAMDisk.
// Properties: DeviceID ("E:"), VolumeName, Size, FreeSpace, DriveType.
async function listWinVolumes(): Promise<Volume[]> {
  try {
    const script =
      "Get-CimInstance Win32_LogicalDisk | " +
      "Where-Object { $_.DriveType -eq 2 -or $_.DriveType -eq 3 } | " +
      "Select-Object DeviceID,VolumeName,Size,FreeSpace,DriveType | " +
      "ConvertTo-Json -Compress";

    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 10000, windowsHide: true },
    );

    const raw = stdout.trim();
    if (!raw) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    const rows: Array<{
      DeviceID?: string;
      VolumeName?: string;
      Size?: number | string;
      FreeSpace?: number | string;
      DriveType?: number;
    }> = Array.isArray(parsed) ? parsed : [parsed as Record<string, unknown>];

    const volumes: Volume[] = [];
    for (const row of rows) {
      if (!row.DeviceID) continue;
      const driveLetter = row.DeviceID.endsWith('\\') ? row.DeviceID : `${row.DeviceID}\\`;

      // Skip drives that aren't actually mounted (e.g. empty card reader slot)
      if (!existsSync(driveLetter)) continue;

      const isRemovable = row.DriveType === 2;
      const totalSize = row.Size != null ? Number(row.Size) : undefined;
      const freeSpace = row.FreeSpace != null ? Number(row.FreeSpace) : undefined;

      // On Windows, a friendly "name" prefers volume label, then drive letter
      const name = row.VolumeName && row.VolumeName.trim().length > 0
        ? `${row.VolumeName} (${row.DeviceID})`
        : row.DeviceID;

      const hasDcim = await detectDcim(driveLetter);

      // Only surface non-system fixed drives if they have a DCIM folder.
      // Removable drives are always shown (card readers may be empty but still useful).
      const isSystem = driveLetter.toUpperCase().startsWith('C:');
      if (!isRemovable && (isSystem || !hasDcim)) continue;

      volumes.push({
        name,
        path: driveLetter,
        isRemovable,
        isExternal: !isRemovable && !isSystem,
        totalSize,
        freeSpace,
        hasDcim,
      });
    }
    return volumes;
  } catch {
    return [];
  }
}

// Cheap signature so the poll only fires callback on real changes.
function winSignature(vols: Volume[]): string {
  return vols.map((v) => `${v.path}|${v.totalSize}|${v.freeSpace}|${v.hasDcim ? 1 : 0}`).join(';');
}

// --------------------------------------------------------------
// Linux
// --------------------------------------------------------------

async function listLinuxVolumes(): Promise<Volume[]> {
  const volumes: Volume[] = [];
  for (const base of LINUX_MEDIA_DIRS) {
    if (!existsSync(base)) continue;
    let entries: string[] = [];
    try {
      entries = await readdir(base);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = path.join(base, entry);
      try {
        const s = await stat(p);
        if (!s.isDirectory()) continue;
        // /media/<user> wraps per-user mounts — descend one level.
        if (base === '/media' && entry.match(/^[a-z_][a-z0-9_-]*$/i)) {
          const sub = await readdir(p).catch(() => []);
          for (const child of sub) {
            const childPath = path.join(p, child);
            const hasDcim = await detectDcim(childPath);
            volumes.push({
              name: child,
              path: childPath,
              isRemovable: true,
              isExternal: true,
              hasDcim,
            });
          }
          continue;
        }
        const hasDcim = await detectDcim(p);
        volumes.push({
          name: entry,
          path: p,
          isRemovable: true,
          isExternal: true,
          hasDcim,
        });
      } catch {
        // ignore
      }
    }
  }
  return volumes;
}

// --------------------------------------------------------------
// Shared
// --------------------------------------------------------------

async function detectDcim(volumePath: string): Promise<boolean> {
  try {
    const entries = await readdir(volumePath);
    return entries.some((e) => e.toUpperCase() === 'DCIM');
  } catch {
    return false;
  }
}

export async function listVolumes(): Promise<Volume[]> {
  if (process.platform === 'darwin') return listMacVolumes();
  if (process.platform === 'win32') return listWinVolumes();
  return listLinuxVolumes();
}

export function startWatching(onChange: (volumes: Volume[]) => void): void {
  changeCallback = onChange;

  if (process.platform === 'darwin') {
    if (!existsSync(MAC_VOLUMES_DIR)) return;
    fsWatcher = watch(MAC_VOLUMES_DIR, () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        const vols = await listVolumes();
        changeCallback?.(vols);
      }, DEBOUNCE_MS);
    });
    return;
  }

  if (process.platform === 'win32') {
    // Windows has no /Volumes-style dir to fs.watch — poll via PowerShell.
    const tick = async () => {
      const vols = await listVolumes();
      const sig = winSignature(vols);
      if (sig !== lastWinSignature) {
        lastWinSignature = sig;
        changeCallback?.(vols);
      }
    };
    void tick();
    winPollTimer = setInterval(tick, WIN_POLL_MS);
    return;
  }

  // Linux — watch each mount root that exists
  fsWatchers = [];
  for (const base of LINUX_MEDIA_DIRS) {
    if (!existsSync(base)) continue;
    try {
      const w = watch(base, () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          const vols = await listVolumes();
          changeCallback?.(vols);
        }, DEBOUNCE_MS);
      });
      fsWatchers.push(w);
    } catch {
      // ignore — some mount roots aren't watchable
    }
  }
  fsWatcher = fsWatchers[0] ?? null;
}

export function stopWatching(): void {
  for (const w of fsWatchers) w.close();
  fsWatchers = [];
  fsWatcher?.close();
  fsWatcher = null;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  if (winPollTimer) clearInterval(winPollTimer);
  winPollTimer = null;
  lastWinSignature = '';
  changeCallback = null;
}
