import { createPublicKey, verify } from 'node:crypto';
import type { LicenseEntitlement, LicenseValidation } from '../../shared/types';
import { LICENSE_PUBLIC_KEY_PEM } from '../../shared/license-public-key';
import { getDeviceIdentity } from './device-id';

const LICENSE_PREFIX = 'PI1-';
const ACTIVATION_PREFIX = 'PIC-';
const PRODUCT_ID = 'photo-importer';
const LICENSE_SERVICE_BASE_URL = 'https://keptra.z2hs.au';

type CompactPayload = {
  n: string;
  e?: string;
  i: string;
  a?: string;
  ax?: string;
  x?: string;
  t?: string;
  o?: string;
  d?: number;
};

type RemoteLicensePayload = {
  allowed: boolean;
  licenseKey?: string;
  activationCode?: string;
  message?: string;
  status?: LicenseValidation['status'];
  entitlement?: LicenseEntitlement;
  activatedAt?: string;
  expiresAt?: string;
  deviceId?: string;
  deviceName?: string;
  deviceSlotsUsed?: number;
  deviceSlotsTotal?: number;
  currentDeviceRegistered?: boolean;
};

function toBase64UrlBuffer(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  return Buffer.from(padded, 'base64');
}

function normalizeDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^\d{2}-\d{2}-\d{4}$/.test(value)) {
    const [day, month, year] = value.split('-');
    return `${year}-${month}-${day}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return value.slice(0, 10);
  return undefined;
}

function formatDisplayDate(value: string | undefined): string | undefined {
  const normalized = normalizeDate(value);
  if (!normalized) return undefined;
  const [year, month, day] = normalized.split('-');
  return `${day}-${month}-${year}`;
}

function compactInput(value: string): string {
  return value.trim().replace(/\s+/g, '');
}

function normalizeLicenseKeyInput(value: string): string {
  const compact = compactInput(value);
  return compact.slice(0, LICENSE_PREFIX.length).toUpperCase() === LICENSE_PREFIX
    ? `${LICENSE_PREFIX}${compact.slice(LICENSE_PREFIX.length)}`
    : compact;
}

function normalizeActivationCodeInput(value: string): string {
  return compactInput(value).toUpperCase();
}

function validateEntitlementShape(entitlement: LicenseEntitlement): string | null {
  if (entitlement.product !== PRODUCT_ID) return 'This key is for a different product.';
  if (!entitlement.name?.trim()) return 'License owner name is missing.';
  if (!normalizeDate(entitlement.issuedAt)) return 'Issued date is invalid.';
  if (entitlement.expiresAt && !normalizeDate(entitlement.expiresAt)) return 'Expiry date is invalid.';
  return null;
}

function currentDateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function toEntitlement(payload: CompactPayload | LicenseEntitlement): LicenseEntitlement {
  if ('product' in payload) {
    return {
      ...payload,
      issuedAt: normalizeDate(payload.issuedAt) ?? payload.issuedAt,
      expiresAt: normalizeDate(payload.expiresAt),
    };
  }
  return {
    product: PRODUCT_ID,
    name: payload.n,
    email: payload.e,
    issuedAt: normalizeDate(payload.i) ?? payload.i,
    activatedAt: normalizeDate(payload.a),
    activationExpiresAt: normalizeDate(payload.ax),
    expiresAt: normalizeDate(payload.x),
    tier: payload.t || 'Full access',
    notes: payload.o,
    maxDevices: typeof payload.d === 'number' && payload.d > 0 ? payload.d : undefined,
  };
}

function normalizeValidation(result: LicenseValidation): LicenseValidation {
  const entitlement = result.entitlement ? toEntitlement(result.entitlement) : undefined;
  const effectiveExpiresAt = normalizeDate(
    result.expiresAt
    ?? entitlement?.activationExpiresAt
    ?? entitlement?.expiresAt,
  );
  const effectiveActivatedAt = normalizeDate(
    result.activatedAt
    ?? entitlement?.activatedAt,
  );
  return {
    ...result,
    entitlement,
    activatedAt: effectiveActivatedAt,
    expiresAt: effectiveExpiresAt,
    status: result.status ?? (result.valid ? 'active' : 'unknown'),
  };
}

function pickActivationCode(
  remote: string | undefined,
  fallback: string | undefined,
): string | undefined {
  const normalizedRemote = remote?.trim();
  if (normalizedRemote) return normalizedRemote;
  const normalizedFallback = fallback?.trim();
  return normalizedFallback || undefined;
}

function mergeEntitlement(
  remote: LicenseEntitlement | undefined,
  fallback: LicenseEntitlement | undefined,
): LicenseEntitlement | undefined {
  if (!remote) return fallback;

  const normalizedRemote = toEntitlement(remote);
  if (!fallback) return normalizedRemote;

  return {
    ...fallback,
    ...normalizedRemote,
    activatedAt: normalizedRemote.activatedAt ?? fallback.activatedAt,
    activationExpiresAt: normalizedRemote.activationExpiresAt ?? fallback.activationExpiresAt,
    issuedAt: normalizedRemote.issuedAt || fallback.issuedAt,
    expiresAt: normalizedRemote.expiresAt ?? fallback.expiresAt,
  };
}

export function validateLicenseKey(key: string): LicenseValidation {
  const rawKey = normalizeLicenseKeyInput(key);
  if (!rawKey) {
    return { valid: false, message: 'Enter a license key.', status: 'unknown' };
  }
  if (!rawKey.startsWith(LICENSE_PREFIX)) {
    return { valid: false, key: rawKey, message: 'License key format is invalid.', status: 'unknown' };
  }

  const body = rawKey.slice(LICENSE_PREFIX.length);
  const dot = body.indexOf('.');
  if (dot <= 0 || dot === body.length - 1) {
    return { valid: false, key: rawKey, message: 'License key format is invalid.', status: 'unknown' };
  }

  const payloadPart = body.slice(0, dot);
  const signaturePart = body.slice(dot + 1);

  try {
    const payloadBuffer = toBase64UrlBuffer(payloadPart);
    const signature = toBase64UrlBuffer(signaturePart);
    const publicKey = createPublicKey(LICENSE_PUBLIC_KEY_PEM);
    const signed = verify(null, payloadBuffer, publicKey, signature);
    if (!signed) {
      return { valid: false, key: rawKey, message: 'Signature check failed.', status: 'unknown' };
    }

    const payload = JSON.parse(payloadBuffer.toString('utf8')) as CompactPayload | LicenseEntitlement;
    const entitlement = toEntitlement(payload);
    const shapeError = validateEntitlementShape(entitlement);
    if (shapeError) {
      return { valid: false, key: rawKey, message: shapeError, status: 'unknown' };
    }

    const activatedAt = normalizeDate(entitlement.activatedAt);
    const expiresAt = normalizeDate(entitlement.activationExpiresAt ?? entitlement.expiresAt);
    if (expiresAt && expiresAt < currentDateStamp()) {
      return {
        valid: false,
        key: rawKey,
        entitlement: { ...entitlement, activatedAt, activationExpiresAt: normalizeDate(entitlement.activationExpiresAt), expiresAt },
        activatedAt,
        expiresAt,
        message: `License expired on ${formatDisplayDate(expiresAt)}.`,
        status: 'expired',
      };
    }

    return {
      valid: true,
      key: rawKey,
      entitlement: { ...entitlement, activatedAt, activationExpiresAt: normalizeDate(entitlement.activationExpiresAt), expiresAt: normalizeDate(entitlement.expiresAt) },
      activatedAt,
      expiresAt,
      message: expiresAt
        ? `License active until ${formatDisplayDate(expiresAt)}.`
        : 'License active.',
      status: 'active',
    };
  } catch {
    return { valid: false, key: rawKey, message: 'License key could not be decoded.', status: 'unknown' };
  }
}

async function fetchLicenseJson(pathname: string, init?: RequestInit): Promise<RemoteLicensePayload> {
  const device = await getDeviceIdentity();
  const response = await fetch(`${LICENSE_SERVICE_BASE_URL}${pathname}`, {
    ...init,
    headers: {
      'X-Device-Id': device.id,
      'X-Device-Name': device.name,
      ...(init?.headers ?? {}),
    },
  });
  let payload: RemoteLicensePayload = { allowed: false };
  try {
    payload = await response.json() as RemoteLicensePayload;
  } catch {
    payload = { allowed: false };
  }

  if (!response.ok && !payload.message) {
    payload.message = `License service returned ${response.status}.`;
  }
  return payload;
}

export async function activateLicenseInput(input: string): Promise<LicenseValidation> {
  const trimmed = compactInput(input);
  if (!trimmed) {
    return { valid: false, message: 'Enter a license key.', status: 'unknown' };
  }

  const normalizedKey = normalizeLicenseKeyInput(trimmed);
  if (normalizedKey.startsWith(LICENSE_PREFIX)) {
    const local = validateLicenseKey(normalizedKey);
    if (!local.valid) return local;
    return checkHostedLicenseStatus(normalizedKey, local);
  }

  const activationCode = normalizeActivationCodeInput(trimmed);
  if (activationCode.startsWith(ACTIVATION_PREFIX)) {
    try {
      const payload = await fetchLicenseJson('/api/v1/license/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ activationCode }),
      });

      if (!payload.allowed || !payload.licenseKey) {
        return {
          valid: false,
          message: payload.message || 'License no longer active.',
          entitlement: payload.entitlement,
          activationCode: payload.activationCode ?? activationCode,
          status: payload.status ?? 'unknown',
        };
      }

      const local = validateLicenseKey(payload.licenseKey);
      if (!local.valid) {
        return local;
      }

      return normalizeValidation({
        ...local,
        activationCode: pickActivationCode(payload.activationCode, activationCode),
        entitlement: mergeEntitlement(payload.entitlement, local.entitlement),
        activatedAt: normalizeDate(payload.activatedAt) ?? local.activatedAt,
        expiresAt: normalizeDate(payload.expiresAt) ?? local.expiresAt,
        message: payload.message || local.message,
        status: payload.status ?? 'active',
        deviceId: payload.deviceId,
        deviceName: payload.deviceName,
        deviceSlotsUsed: payload.deviceSlotsUsed,
        deviceSlotsTotal: payload.deviceSlotsTotal,
        currentDeviceRegistered: payload.currentDeviceRegistered,
      });
    } catch {
      return {
        valid: false,
        message: 'Could not reach the license service.',
        activationCode,
        status: 'unknown',
      };
    }
  }

  return { valid: false, key: trimmed, message: 'License key format is invalid.', status: 'unknown' };
}

export async function checkHostedLicenseStatus(
  key: string,
  existing?: LicenseValidation,
): Promise<LicenseValidation> {
  const local = existing ?? validateLicenseKey(key);
  if (!local.valid || !local.key) {
    return normalizeValidation(local);
  }

  try {
    const payload = await fetchLicenseJson('/api/v1/license/status', {
      headers: {
        Accept: 'application/json',
        'X-License-Key': local.key,
      },
    });

    if (!payload.allowed) {
      return {
        valid: false,
        key: local.key,
        entitlement: mergeEntitlement(payload.entitlement, local.entitlement),
        activatedAt: normalizeDate(payload.activatedAt) ?? existing?.activatedAt ?? local.activatedAt,
        expiresAt: normalizeDate(payload.expiresAt) ?? existing?.expiresAt ?? local.expiresAt,
        message: payload.message || 'License no longer active.',
        activationCode: pickActivationCode(payload.activationCode, existing?.activationCode),
        status: payload.status ?? 'unknown',
        deviceId: payload.deviceId,
        deviceName: payload.deviceName,
        deviceSlotsUsed: payload.deviceSlotsUsed,
        deviceSlotsTotal: payload.deviceSlotsTotal,
        currentDeviceRegistered: payload.currentDeviceRegistered,
      };
    }

    return normalizeValidation({
      ...local,
      entitlement: mergeEntitlement(payload.entitlement, local.entitlement),
      activationCode: pickActivationCode(payload.activationCode, existing?.activationCode),
      activatedAt: normalizeDate(payload.activatedAt) ?? existing?.activatedAt ?? local.activatedAt,
      expiresAt: normalizeDate(payload.expiresAt) ?? existing?.expiresAt ?? local.expiresAt,
      message: payload.message || local.message,
      status: payload.status ?? 'active',
      deviceId: payload.deviceId,
      deviceName: payload.deviceName,
      deviceSlotsUsed: payload.deviceSlotsUsed,
      deviceSlotsTotal: payload.deviceSlotsTotal,
      currentDeviceRegistered: payload.currentDeviceRegistered,
    });
  } catch {
    return normalizeValidation(local);
  }
}
