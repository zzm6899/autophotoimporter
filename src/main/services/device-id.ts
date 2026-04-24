import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import os from 'node:os';

const execFileAsync = promisify(execFile);

type DeviceIdentity = {
  id: string;
  name: string;
};

let cachedIdentity: Promise<DeviceIdentity> | null = null;

function hashParts(...parts: Array<string | undefined>) {
  return createHash('sha256')
    .update(parts.filter(Boolean).join('|'))
    .digest('hex');
}

async function readMachineSeed(): Promise<string> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('reg.exe', [
        'query',
        'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
        '/v',
        'MachineGuid',
      ], { windowsHide: true, timeout: 10_000 });
      const match = stdout.match(/MachineGuid\s+REG_\w+\s+([^\r\n]+)/i);
      if (match?.[1]) return match[1].trim();
    }

    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
        timeout: 10_000,
      });
      const match = stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/i);
      if (match?.[1]) return match[1].trim();
    }

    const machineIdCandidates = ['/etc/machine-id', '/var/lib/dbus/machine-id'];
    for (const filePath of machineIdCandidates) {
      try {
        const value = (await readFile(filePath, 'utf8')).trim();
        if (value) return value;
      } catch {
        // Keep trying fallback sources.
      }
    }
  } catch {
    // Fall through to the hostname-based fallback.
  }

  return hashParts(os.hostname(), os.arch(), os.platform(), os.userInfo().username);
}

async function buildIdentity(): Promise<DeviceIdentity> {
  const seed = await readMachineSeed();
  return {
    id: hashParts('photo-importer-device', seed),
    name: os.hostname() || `${os.platform()}-${os.arch()}`,
  };
}

export function getDeviceIdentity(): Promise<DeviceIdentity> {
  cachedIdentity ??= buildIdentity();
  return cachedIdentity;
}
