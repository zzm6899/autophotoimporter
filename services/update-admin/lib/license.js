const crypto = require('node:crypto');

const LICENSE_PREFIX = 'PI1-';
const PRODUCT_ID = 'photo-importer';

function toBase64UrlBuffer(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  return Buffer.from(padded, 'base64');
}

function normalizeDate(value) {
  if (!value) return undefined;
  if (/^\d{2}-\d{2}-\d{4}$/.test(value)) {
    const [day, month, year] = value.split('-');
    return `${year}-${month}-${day}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return undefined;
}

function currentDateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function toEntitlement(payload) {
  if (payload.product) {
    return {
      ...payload,
      issuedAt: normalizeDate(payload.issuedAt) || payload.issuedAt,
      expiresAt: normalizeDate(payload.expiresAt),
    };
  }
  return {
    product: PRODUCT_ID,
    name: payload.n,
    email: payload.e,
    issuedAt: normalizeDate(payload.i) || payload.i,
    expiresAt: normalizeDate(payload.x),
    tier: payload.t || 'Full access',
    notes: payload.o,
    maxDevices: typeof payload.d === 'number' && payload.d > 0 ? payload.d : undefined,
  };
}

function fingerprintLicense(key) {
  return crypto.createHash('sha256').update(key.trim()).digest('hex');
}

function validateLicenseKey(key, publicKeyPem) {
  const rawKey = (key || '').trim();
  if (!rawKey) return { valid: false, message: 'Enter a license key.' };
  if (!rawKey.startsWith(LICENSE_PREFIX)) return { valid: false, key: rawKey, message: 'License key format is invalid.' };

  const body = rawKey.slice(LICENSE_PREFIX.length);
  const dot = body.indexOf('.');
  if (dot <= 0 || dot === body.length - 1) {
    return { valid: false, key: rawKey, message: 'License key format is invalid.' };
  }

  try {
    const payloadBuffer = toBase64UrlBuffer(body.slice(0, dot));
    const signature = toBase64UrlBuffer(body.slice(dot + 1));
    const publicKey = crypto.createPublicKey(publicKeyPem);
    const signed = crypto.verify(null, payloadBuffer, publicKey, signature);
    if (!signed) return { valid: false, key: rawKey, message: 'Signature check failed.' };

    const payload = JSON.parse(payloadBuffer.toString('utf8'));
    const entitlement = toEntitlement(payload);
    if (entitlement.product !== PRODUCT_ID) {
      return { valid: false, key: rawKey, message: 'This key is for a different product.' };
    }
    if (!entitlement.name || !normalizeDate(entitlement.issuedAt)) {
      return { valid: false, key: rawKey, message: 'License details are incomplete.' };
    }
    const expiresAt = normalizeDate(entitlement.expiresAt);
    if (expiresAt && expiresAt < currentDateStamp()) {
      return {
        valid: false,
        key: rawKey,
        entitlement: { ...entitlement, expiresAt },
        message: `License expired on ${expiresAt}.`,
      };
    }
    return {
      valid: true,
      key: rawKey,
      entitlement: { ...entitlement, expiresAt },
      fingerprint: fingerprintLicense(rawKey),
      message: expiresAt ? `License active until ${expiresAt}.` : 'License active.',
    };
  } catch (error) {
    return { valid: false, key: rawKey, message: error instanceof Error ? error.message : 'License key could not be decoded.' };
  }
}

module.exports = {
  validateLicenseKey,
  fingerprintLicense,
};
