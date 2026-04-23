import { createPublicKey, verify } from 'node:crypto';
import type { LicenseEntitlement, LicenseValidation } from '../../shared/types';
import { LICENSE_PUBLIC_KEY_PEM } from '../../shared/license-public-key';

const LICENSE_PREFIX = 'PI1-';
const PRODUCT_ID = 'photo-importer';

type CompactPayload = {
  n: string;
  e?: string;
  i: string;
  x?: string;
  t?: string;
  o?: string;
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
  return undefined;
}

function formatDisplayDate(value: string | undefined): string | undefined {
  const normalized = normalizeDate(value);
  if (!normalized) return undefined;
  const [year, month, day] = normalized.split('-');
  return `${day}-${month}-${year}`;
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
    expiresAt: normalizeDate(payload.x),
    tier: payload.t || 'Full access',
    notes: payload.o,
  };
}

export function validateLicenseKey(key: string): LicenseValidation {
  const rawKey = key.trim();
  if (!rawKey) {
    return { valid: false, message: 'Enter a license key.' };
  }
  if (!rawKey.startsWith(LICENSE_PREFIX)) {
    return { valid: false, key: rawKey, message: 'License key format is invalid.' };
  }

  const body = rawKey.slice(LICENSE_PREFIX.length);
  const dot = body.indexOf('.');
  if (dot <= 0 || dot === body.length - 1) {
    return { valid: false, key: rawKey, message: 'License key format is invalid.' };
  }

  const payloadPart = body.slice(0, dot);
  const signaturePart = body.slice(dot + 1);

  try {
    const payloadBuffer = toBase64UrlBuffer(payloadPart);
    const signature = toBase64UrlBuffer(signaturePart);
    const publicKey = createPublicKey(LICENSE_PUBLIC_KEY_PEM);
    const signed = verify(null, payloadBuffer, publicKey, signature);
    if (!signed) {
      return { valid: false, key: rawKey, message: 'Signature check failed.' };
    }

    const payload = JSON.parse(payloadBuffer.toString('utf8')) as CompactPayload | LicenseEntitlement;
    const entitlement = toEntitlement(payload);
    const shapeError = validateEntitlementShape(entitlement);
    if (shapeError) {
      return { valid: false, key: rawKey, message: shapeError };
    }

    const expiresAt = normalizeDate(entitlement.expiresAt);
    if (expiresAt && expiresAt < currentDateStamp()) {
      return {
        valid: false,
        key: rawKey,
        entitlement: { ...entitlement, expiresAt },
        message: `License expired on ${formatDisplayDate(expiresAt)}.`,
      };
    }

    return {
      valid: true,
      key: rawKey,
      entitlement: { ...entitlement, expiresAt },
      message: expiresAt
        ? `License active until ${formatDisplayDate(expiresAt)}.`
        : 'License active.',
    };
  } catch {
    return { valid: false, key: rawKey, message: 'License key could not be decoded.' };
  }
}
