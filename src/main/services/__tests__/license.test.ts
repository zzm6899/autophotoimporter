import { beforeAll, afterEach, describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';

let validateLicenseKey: typeof import('../license').validateLicenseKey;
let activateLicenseInput: typeof import('../license').activateLicenseInput;
let checkHostedLicenseStatus: typeof import('../license').checkHostedLicenseStatus;
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

function makeLicense(payload: Record<string, string | undefined>) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = sign(null, body, privateKey);
  return `PI1-${body.toString('base64url')}.${signature.toString('base64url')}`;
}

beforeAll(async () => {
  vi.resetModules();
  vi.doMock('../../../shared/license-public-key', () => ({
    LICENSE_PUBLIC_KEY_PEM: publicPem,
  }));
  vi.doMock('../device-id', () => ({
    getDeviceIdentity: vi.fn(async () => ({ id: 'device-1', name: 'Test Machine' })),
  }));
  ({ validateLicenseKey, activateLicenseInput, checkHostedLicenseStatus } = await import('../license'));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('validateLicenseKey', () => {
  it('accepts a valid signed license', () => {
    const key = makeLicense({
      n: 'Test Customer',
      e: 'test@example.com',
      i: '24-04-2026',
      x: '31-12-2027',
      t: 'Full access',
    });

    const result = validateLicenseKey(key);
    expect(result.valid).toBe(true);
    expect(result.entitlement?.name).toBe('Test Customer');
    expect(result.entitlement?.tier).toBe('Full access');
  });

  it('rejects expired licenses', () => {
    const key = makeLicense({
      n: 'Expired Customer',
      i: '01-01-2024',
      x: '31-01-2024',
    });

    const result = validateLicenseKey(key);
    expect(result.valid).toBe(false);
    expect(result.message).toContain('expired');
  });

  it('rejects tampered payloads', () => {
    const key = makeLicense({
      n: 'Tamper Test',
      i: '24-04-2026',
    });
    const [, bodyAndSig] = key.split('PI1-');
    const [, sig] = bodyAndSig.split('.');
    const tamperedBody = Buffer.from(JSON.stringify({
      n: 'Someone Else',
      i: '24-04-2026',
    }), 'utf8').toString('base64url');

    const result = validateLicenseKey(`PI1-${tamperedBody}.${sig}`);
    expect(result.valid).toBe(false);
    expect(result.message).toContain('Signature');
  });

  it('keeps normalized expiry data when activating with an activation code', async () => {
    const key = makeLicense({
      n: 'Trial Customer',
      e: 'trial@example.com',
      i: '24-04-2026',
      x: '11-05-2026',
      t: 'Full access',
    });

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        allowed: true,
        licenseKey: key,
        activationCode: 'PIC-TEST-1234-ABCD',
        status: 'active',
        entitlement: {
          product: 'photo-importer',
          name: 'Trial Customer',
          email: 'trial@example.com',
          issuedAt: '2026-04-24T00:00:00.000Z',
          expiresAt: '2026-05-11T00:00:00.000Z',
          tier: 'Full access',
        },
      }),
    })) as unknown as typeof fetch);

    const result = await activateLicenseInput('PIC-TEST-1234-ABCD');
    expect(result.valid).toBe(true);
    expect(result.entitlement?.expiresAt).toBe('2026-05-11');
    expect(result.message).toContain('active');
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toBe('https://keptra.z2hs.au/api/v1/license/resolve');
  });

  it('preserves an existing activation code when hosted status omits it', async () => {
    const key = makeLicense({
      n: 'Existing Customer',
      e: 'existing@example.com',
      i: '24-04-2026',
      x: '31-12-2027',
      t: 'Full access',
    });

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        allowed: true,
        status: 'active',
      }),
    })) as unknown as typeof fetch);

    const result = await checkHostedLicenseStatus(key, {
      ...validateLicenseKey(key),
      activationCode: 'PIC-EXIST-1234-ABCD',
    });

    expect(result.valid).toBe(true);
    expect(result.activationCode).toBe('PIC-EXIST-1234-ABCD');
  });
});
