const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { validateLicenseKey } = require('./lib/license');

const app = express();
const port = Number(process.env.PORT || 5071);

// Keys can be supplied as env vars (LICENSE_PUBLIC_KEY / LICENSE_PRIVATE_KEY)
// or as file paths (LICENSE_PUBLIC_KEY_PATH / LICENSE_PRIVATE_KEY_PATH).
// Env var content takes priority over file paths.
function loadKey(envContent, envPath, fallbackPath) {
  if (envContent) return envContent.replace(/\\n/g, '\n');
  const p = envPath || fallbackPath || '';
  if (p && fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  return '';
}
const licensePublicKeyPem = loadKey(
  process.env.LICENSE_PUBLIC_KEY,
  process.env.LICENSE_PUBLIC_KEY_PATH,
  path.resolve(__dirname, '../../scripts/license-keys/public.pem'),
);
const licensePrivateKeyPem = loadKey(
  process.env.LICENSE_PRIVATE_KEY,
  process.env.LICENSE_PRIVATE_KEY_PATH,
  '',
);
if (!licensePublicKeyPem) throw new Error('LICENSE_PUBLIC_KEY or LICENSE_PUBLIC_KEY_PATH must be set');
const sessionSecret = process.env.ADMIN_SESSION_SECRET || 'change-me-admin-session-secret';
const updateSecret = process.env.UPDATE_TOKEN_SECRET || 'change-me-update-token-secret';
const adminApiToken = process.env.ADMIN_API_TOKEN || '';
const artifactsRoot = process.env.ARTIFACTS_ROOT || '/srv/artifacts';
const githubApiBase = process.env.GITHUB_API_BASE_URL || 'https://api.github.com';
const githubRepoOwner = process.env.GITHUB_RELEASE_OWNER || '';
const githubRepoName = process.env.GITHUB_RELEASE_REPO || '';
const githubToken = process.env.GITHUB_RELEASE_TOKEN || '';
const ACTIVATION_CODE_PREFIX = 'PIC';
const ACTIVATION_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://photo_importer:photo_importer@db:5432/photo_importer_updates',
});

// --- Date formatting helpers ---
function fmtTime(val) {
  if (!val) return 'Never';
  const iso = new Date(val).toISOString();
  // Emit a <time> tag; browser JS converts to local time on load
  return `<time data-ts="${iso}" title="${iso}">${new Date(val).toUTCString()}</time>`;
}
function fmtDate(val) {
  if (!val) return '—';
  const iso = new Date(val).toISOString();
  return `<time data-ts="${iso}" title="${iso}">${new Date(val).toISOString().slice(0,10)}</time>`;
}
// ---

// --- Storage helpers ---
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function getDirSize(dirPath) {
  try {
    let total = 0;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isFile()) total += fs.statSync(full).size;
      else if (entry.isDirectory()) total += getDirSize(full);
    }
    return total;
  } catch { return 0; }
}

function getArtifactFiles(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .filter(e => e.isFile())
      .map(e => {
        const full = path.join(dirPath, e.name);
        const stat = fs.statSync(full);
        return { name: e.name, size: stat.size, mtime: stat.mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}

function getDiskStats(dirPath) {
  try {
    const { execSync } = require('node:child_process');
    const out = execSync(`df -k "${dirPath}" 2>/dev/null | tail -1`).toString().trim();
    const parts = out.split(/\s+/);
    // df -k: Filesystem, 1K-blocks, Used, Available, Use%, Mounted
    if (parts.length >= 5) {
      return {
        total: parseInt(parts[1]) * 1024,
        used: parseInt(parts[2]) * 1024,
        available: parseInt(parts[3]) * 1024,
        pct: parts[4],
      };
    }
  } catch {}
  return null;
}
// ---

app.set('trust proxy', true);
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use('/artifacts', express.static(artifactsRoot));
app.use(express.static(path.join(__dirname, 'web')));

function htmlPage(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} — Culler Admin</title>
  <script>
    // Convert all <time data-ts="..."> elements to local browser time on load
    document.addEventListener('DOMContentLoaded', () => {
      document.querySelectorAll('time[data-ts]').forEach(el => {
        const d = new Date(el.dataset.ts);
        if (!isNaN(d)) el.textContent = d.toLocaleString(undefined, {
          year:'numeric', month:'short', day:'numeric',
          hour:'2-digit', minute:'2-digit'
        });
      });
    });
  </script>
  <style>
    :root{--bg:#090e1a;--surface:#0f1829;--surface2:#172033;--border:#1e2d45;--border2:#2a3f5f;--text:#e8edf5;--muted:#7a90b0;--faint:#3d5068;--blue:#3b82f6;--blue-dk:#2563eb;--radius:12px}
    *,*::before,*::after{box-sizing:border-box}
    body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);margin:0;-webkit-font-smoothing:antialiased;line-height:1.6}
    a{color:var(--blue);text-decoration:none}
    a:hover{color:#93c5fd}
    code{font-family:ui-monospace,'SF Mono',Consolas,monospace;font-size:.8em;background:var(--surface2);padding:2px 6px;border-radius:4px;white-space:nowrap}
    h1{font-size:1.35rem;font-weight:700;margin:0;letter-spacing:-.02em}
    h2{font-size:.7rem;font-weight:600;margin:0 0 14px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
    p{margin:0 0 8px}
    label{display:block;font-size:.8rem;font-weight:500;color:var(--muted);margin-bottom:4px;margin-top:14px}
    label:first-child{margin-top:0}
    .shell{max-width:1200px;margin:0 auto;padding:20px 24px}
    .top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding-bottom:18px;margin-bottom:20px;border-bottom:1px solid var(--border)}
    .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin-bottom:20px}
    .card{background:var(--surface);border:1px solid var(--border2);border-radius:var(--radius);padding:16px 20px}
    .card-label{font-size:.7rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
    .card-value{font-size:2rem;font-weight:700;line-height:1.1;letter-spacing:-.04em}
    .panel{background:var(--surface);border:1px solid var(--border2);border-radius:var(--radius);padding:20px;margin-bottom:16px}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;margin-bottom:16px}
    .row{display:flex;gap:12px}
    .row>*{flex:1}
    .actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    form.inline{display:inline}
    .nav{display:flex;align-items:center;gap:2px;flex-wrap:wrap;background:var(--surface);border:1px solid var(--border2);border-radius:var(--radius);padding:5px}
    .nav a{font-size:.8125rem;font-weight:500;color:var(--muted);padding:6px 12px;border-radius:8px;transition:color .15s,background .15s}
    .nav a:hover,.nav a.active{color:var(--text);background:var(--surface2)}
    .nav-sep{width:1px;height:16px;background:var(--border2);margin:0 4px;flex-shrink:0}
    .nav form.inline button{font-size:.8125rem;padding:6px 12px;border-radius:8px;background:transparent;color:var(--muted);border:none;font-weight:500;cursor:pointer;font-family:inherit;transition:color .15s,background .15s}
    .nav form.inline button:hover{background:var(--surface2);color:var(--text)}
    table{width:100%;border-collapse:collapse;font-size:.8125rem}
    thead{border-bottom:2px solid var(--border2)}
    th{padding:10px;text-align:left;font-weight:600;font-size:.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;white-space:nowrap}
    td{padding:11px 10px;border-bottom:1px solid var(--border);vertical-align:middle}
    tbody tr:last-child td{border-bottom:none}
    tbody tr:hover td{background:rgba(255,255,255,.018)}
    input,textarea,select{width:100%;background:rgba(0,0,0,.3);border:1px solid var(--border2);border-radius:8px;color:var(--text);padding:9px 12px;box-sizing:border-box;font-size:.875rem;font-family:inherit;transition:border-color .15s,box-shadow .15s}
    input:focus,textarea:focus,select:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 3px rgba(59,130,246,.15)}
    textarea[readonly]{background:#020b18;font-family:ui-monospace,'SF Mono',Consolas,monospace;font-size:.78rem;line-height:1.5}
    select{cursor:pointer}
    button{background:var(--blue-dk);color:white;border:none;border-radius:8px;padding:9px 16px;cursor:pointer;font-size:.875rem;font-weight:500;transition:background .15s;font-family:inherit;line-height:1.4}
    button:hover{background:var(--blue)}
    button.secondary{background:var(--surface2);color:var(--text);border:1px solid var(--border2)}
    button.secondary:hover{background:var(--border2);color:var(--text)}
    button.sm{padding:5px 10px;font-size:.75rem}
    button.danger{background:#4a0e0e;color:#fca5a5;border:1px solid #7f1d1d}
    button.danger:hover{background:#7f1d1d}
    .pill{display:inline-flex;align-items:center;padding:3px 9px;border-radius:999px;font-size:.7rem;font-weight:600;letter-spacing:.02em;background:var(--surface2);color:var(--muted)}
    .pill-active,.pill-live{background:rgba(34,197,94,.12);color:#86efac}
    .pill-revoked{background:rgba(239,68,68,.12);color:#fca5a5}
    .pill-expired,.pill-draft{background:rgba(249,115,22,.1);color:#fdba74}
    .pill-disabled,.pill-hidden{background:rgba(100,116,139,.12);color:#64748b}
    .muted{color:var(--muted);font-size:.8125rem}
    .ok{color:#86efac}
    .bad{color:#fca5a5}
    .warn{color:#fdba74}
    @media(max-width:900px){
      .row{flex-direction:column}
      .shell{padding:12px 10px}
      .top{flex-direction:column;gap:10px}
      h1{font-size:1.15rem}
      .panel{padding:14px}
      .grid{grid-template-columns:1fr}
      .cards{grid-template-columns:repeat(2,1fr)}
      table{display:block;overflow-x:auto;-webkit-overflow-scrolling:touch;white-space:nowrap}
      .nav{gap:2px}
      .nav a{padding:5px 9px;font-size:.75rem}
      input,textarea,select{font-size:.875rem}
    }
    @media(max-width:480px){
      .cards{grid-template-columns:1fr}
      .actions{flex-direction:column;align-items:stretch}
      .actions a,.actions form.inline{display:block}
      .actions button{width:100%}
    }
    :root{--bg:#0d0d0f;--surface:rgba(20,20,22,.92);--surface2:#1c1c1f;--surface3:#242429;--border:#2a2a2e;--border2:#33333a;--text:#f0f0f0;--muted:#9d9da6;--faint:#64646d;--blue:#6c63ff;--blue-dk:#6c63ff;--radius:16px}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:radial-gradient(circle at top,#1a1a24 0,var(--bg) 42%),var(--bg)}
    a{color:var(--text)}
    a:hover{color:#fff}
    .shell{max-width:1240px;padding:28px 24px 40px}
    .nav{gap:4px;background:rgba(20,20,22,.88);border-radius:999px;padding:6px;box-shadow:0 14px 30px rgba(0,0,0,.14)}
    .nav a:hover,.nav a.active,.nav form.inline button:hover{background:rgba(108,99,255,.14)}
    .card,.panel{box-shadow:0 18px 42px rgba(0,0,0,.18);backdrop-filter:blur(14px)}
    .panel{border-radius:16px}
    input,textarea,select{background:rgba(0,0,0,.28);border-radius:12px;padding:10px 12px}
    input:focus,textarea:focus,select:focus{border-color:#6c63ff;box-shadow:0 0 0 3px rgba(108,99,255,.15)}
    textarea[readonly]{background:#111117}
    button{background:#6c63ff;border-radius:12px;padding:10px 16px;font-weight:600;transition:background .15s,transform .12s}
    button:hover{background:#7b73ff;transform:translateY(-1px)}
    button.secondary:hover{background:var(--surface3)}
    .hero{display:flex;justify-content:space-between;align-items:flex-end;gap:18px;padding:20px 22px;margin-bottom:18px;border:1px solid var(--border2);border-radius:24px;background:linear-gradient(135deg,rgba(108,99,255,.14),rgba(52,211,153,.06) 55%,rgba(20,20,22,.92));box-shadow:0 24px 50px rgba(0,0,0,.2)}
    .hero-kicker{font-size:.72rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:8px}
    .hero-copy p{color:var(--muted);margin-top:8px}
    .stack{display:flex;flex-direction:column;gap:12px}
    .list{margin:0;padding-left:18px;color:var(--muted)}
    .list li{margin:4px 0}
    @media(max-width:900px){.hero{flex-direction:column;align-items:flex-start;border-radius:18px}}
  </style>
</head>
<body><div class="shell">${body}</div></body></html>`;
}

function nav(page = '') {
  const link = (href, label, name) =>
    `<a href="${href}"${page === name ? ' class="active"' : ''}>${label}</a>`;
  return `<div class="nav">
    ${link('/admin', 'Dashboard', 'dashboard')}
    ${link('/admin/licenses', 'Licenses', 'licenses')}
    ${link('/admin/releases', 'Releases', 'releases')}
    ${link('/admin/customers', 'Customers', 'customers')}
    <div class="nav-sep"></div>
    <form class="inline" method="post" action="/admin/logout"><button type="submit">Log out</button></form>
  </div>`;
}

function statusPill(status) {
  const variants = { active: 1, live: 1, revoked: 1, expired: 1, draft: 1, disabled: 1, hidden: 1 };
  const cls = variants[String(status)] ? ` pill-${status}` : '';
  return `<span class="pill${cls}">${status}</span>`;
}

function publicUpdatesBaseUrl() {
  return String(process.env.PUBLIC_UPDATES_BASE_URL || 'https://updates.culler.z2hs.au').replace(/\/$/, '');
}

function sanitizeArtifactFilename(name) {
  const base = path.basename(String(name || '').trim());
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-');
  if (!safe || safe === '.' || safe === '..') {
    throw new Error('A valid filename is required.');
  }
  return safe;
}

function normalizeReleasePlatform(platform) {
  const value = String(platform || '').trim().toLowerCase();
  if (value === 'windows' || value === 'macos') return value;
  throw new Error('Platform must be windows or macos.');
}

function signSession(payload) {
  return jwt.sign(payload, sessionSecret, { expiresIn: '12h' });
}

function signDownloadToken(payload) {
  return jwt.sign(payload, updateSecret, { expiresIn: '15m' });
}

function base64Url(input) {
  return Buffer.from(input).toString('base64url');
}

function normalizeLicenseDate(value) {
  if (!value) return undefined;
  if (/^\d{2}-\d{2}-\d{4}$/.test(value)) {
    const [day, month, year] = value.split('-');
    return `${year}-${month}-${day}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return undefined;
}

function formatLicenseDate(value) {
  const normalized = normalizeLicenseDate(value);
  if (!normalized) return 'Never';
  const [year, month, day] = normalized.split('-');
  return `${day}-${month}-${year}`;
}

function todayLicenseDate() {
  return new Date().toISOString().slice(0, 10);
}

function canGenerateLicenses() {
  return Boolean(licensePrivateKeyPem);
}

function generateActivationCode() {
  const chars = [];
  for (let i = 0; i < 12; i += 1) {
    const byte = crypto.randomBytes(1)[0];
    chars.push(ACTIVATION_ALPHABET[byte % ACTIVATION_ALPHABET.length]);
  }
  return `${ACTIVATION_CODE_PREFIX}-${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8, 12).join('')}`;
}

function parseMaxDevices(value, fallback = 1) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error('Max devices must be a whole number greater than 0.');
  }
  return parsed;
}

function createLicenseKey({ name, email, expiry, notes, maxDevices }) {
  if (!canGenerateLicenses()) {
    throw new Error('License generation is not enabled on this server.');
  }
  if (!name || !name.trim()) {
    throw new Error('Customer name is required.');
  }

  const normalizedExpiry = expiry ? normalizeLicenseDate(expiry) : undefined;
  if (expiry && !normalizedExpiry) {
    throw new Error('Expiry must use DD-MM-YYYY.');
  }

  const payload = {
    n: name.trim(),
    i: todayLicenseDate(),
    t: 'Full access',
    d: parseMaxDevices(maxDevices, 1),
  };
  if (email?.trim()) payload.e = email.trim();
  if (normalizedExpiry) payload.x = normalizedExpiry;
  if (notes?.trim()) payload.o = notes.trim();

  const payloadBuffer = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = crypto.sign(null, payloadBuffer, crypto.createPrivateKey(licensePrivateKeyPem));
  return `PI1-${base64Url(payloadBuffer)}.${base64Url(signature)}`;
}

function shouldUseSecureCookies(req) {
  const configured = String(process.env.COOKIE_SECURE || 'auto').toLowerCase();
  if (configured === 'true') return true;
  if (configured === 'false') return false;
  if (req.secure) return true;
  const forwardedProto = req.header('x-forwarded-proto');
  return typeof forwardedProto === 'string' && forwardedProto.split(',')[0].trim().toLowerCase() === 'https';
}

function authSession(req, res, next) {
  const token = req.cookies.admin_session;
  if (!token) return res.redirect('/admin/login');
  try {
    req.admin = jwt.verify(token, sessionSecret);
    return next();
  } catch {
    return res.redirect('/admin/login');
  }
}

function requireAdminApiToken(req, res, next) {
  const token = req.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (!adminApiToken || token !== adminApiToken) {
    return res.status(401).json({ error: 'Invalid admin API token.' });
  }
  return next();
}

async function logUpdateEvent(eventType, values = {}) {
  await pool.query(
    `INSERT INTO update_events (fingerprint, event_type, app_version, platform, channel, allowed, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      values.fingerprint || null,
      eventType,
      values.appVersion || null,
      values.platform || null,
      values.channel || null,
      typeof values.allowed === 'boolean' ? values.allowed : null,
      values.detail || null,
    ],
  );
}

async function ensureAdminUser() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;
  const existing = await pool.query('SELECT id FROM admin_users WHERE email = $1', [email]);
  if (existing.rowCount) return;
  const hash = await bcrypt.hash(password, 10);
  await pool.query('INSERT INTO admin_users (email, password_hash) VALUES ($1, $2)', [email, hash]);
}

async function ensureRuntimeSchema() {
  // Single source of truth for schema - works on fresh and existing volumes.
  // init.sql only runs on brand-new volumes so we can never rely on it alone.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS license_records (
      id SERIAL PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      license_key TEXT NOT NULL,
      activation_code TEXT,
      customer_name TEXT NOT NULL,
      customer_email TEXT,
      issued_at DATE,
      expires_at DATE,
      max_devices INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      notes TEXT,
      last_seen_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('ALTER TABLE license_records ADD COLUMN IF NOT EXISTS activation_code TEXT');
  await pool.query('ALTER TABLE license_records ADD COLUMN IF NOT EXISTS max_devices INTEGER');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_license_records_activation_code ON license_records(activation_code)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS license_activations (
      id SERIAL PRIMARY KEY,
      license_fingerprint TEXT NOT NULL REFERENCES license_records(fingerprint) ON DELETE CASCADE,
      device_id TEXT NOT NULL,
      device_name TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (license_fingerprint, device_id)
    )
  `);
  await pool.query('ALTER TABLE license_activations ADD COLUMN IF NOT EXISTS expires_at DATE');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_license_activations_license ON license_activations(license_fingerprint, last_seen_at DESC)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS releases (
      id SERIAL PRIMARY KEY,
      version TEXT NOT NULL,
      platform TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'stable',
      release_name TEXT NOT NULL,
      release_notes TEXT,
      release_url TEXT,
      artifact_url TEXT NOT NULL,
      published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      rollout_state TEXT NOT NULL DEFAULT 'draft',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_releases_platform_channel_state ON releases(platform, channel, rollout_state, published_at DESC)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS update_events (
      id SERIAL PRIMARY KEY,
      fingerprint TEXT,
      event_type TEXT NOT NULL,
      app_version TEXT,
      platform TEXT,
      channel TEXT,
      allowed BOOLEAN,
      detail TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function assignActivationCode(fingerprint) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const activationCode = generateActivationCode();
    const result = await pool.query(
      `UPDATE license_records
       SET activation_code = $2, updated_at = NOW()
       WHERE fingerprint = $1 AND activation_code IS NULL
       RETURNING activation_code`,
      [fingerprint, activationCode],
    );
    if (result.rowCount > 0) return result.rows[0].activation_code;
    const existing = await pool.query('SELECT activation_code FROM license_records WHERE fingerprint = $1', [fingerprint]);
    if (existing.rowCount && existing.rows[0].activation_code) return existing.rows[0].activation_code;
  }
  throw new Error('Could not assign an activation code.');
}

async function upsertLicenseRecord(validated, notes) {
  await pool.query(
    `INSERT INTO license_records (fingerprint, license_key, customer_name, customer_email, issued_at, expires_at, max_devices, status, notes, last_seen_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,NOW(),NOW())
     ON CONFLICT (fingerprint) DO UPDATE
     SET license_key = EXCLUDED.license_key,
         customer_name = EXCLUDED.customer_name,
         customer_email = EXCLUDED.customer_email,
         issued_at = EXCLUDED.issued_at,
         expires_at = EXCLUDED.expires_at,
         max_devices = EXCLUDED.max_devices,
         status = 'active',
         notes = EXCLUDED.notes,
         updated_at = NOW()`,
    [
      validated.fingerprint,
      validated.key,
      validated.entitlement.name,
      validated.entitlement.email || null,
      validated.entitlement.issuedAt || null,
      validated.entitlement.expiresAt || null,
      validated.entitlement.maxDevices || null,
      notes || validated.entitlement.notes || null,
    ],
  );
  return assignActivationCode(validated.fingerprint);
}

async function activationSummary(fingerprint, deviceId) {
  const activations = await pool.query(
    `SELECT id, device_id, device_name, first_seen_at, last_seen_at, expires_at
     FROM license_activations
     WHERE license_fingerprint = $1
       AND (expires_at IS NULL OR expires_at >= CURRENT_DATE)
     ORDER BY last_seen_at DESC, id DESC`,
    [fingerprint],
  );
  return {
    count: activations.rowCount,
    rows: activations.rows,
    currentDeviceRegistered: deviceId ? activations.rows.some((row) => row.device_id === deviceId) : false,
  };
}

async function registerActivation(fingerprint, deviceId, deviceName) {
  if (!deviceId) return;
  await pool.query(
    `INSERT INTO license_activations (license_fingerprint, device_id, device_name, first_seen_at, last_seen_at, updated_at)
     VALUES ($1,$2,$3,NOW(),NOW(),NOW())
     ON CONFLICT (license_fingerprint, device_id) DO UPDATE
     SET device_name = EXCLUDED.device_name,
         last_seen_at = NOW(),
         updated_at = NOW()`,
    [fingerprint, deviceId, deviceName || null],
  );
}

function effectiveMaxDevices(validated, record) {
  return Number(record?.max_devices || validated.entitlement.maxDevices || 0) || null;
}

function deviceLimitMessage(maxDevices) {
  return `This license has reached its ${maxDevices}-device limit.`;
}

async function resolveLicenseRecord(licenseKey, options = {}) {
  const validated = validateLicenseKey(licenseKey, licensePublicKeyPem);
  if (!validated.valid) {
    return { ok: false, status: 403, message: validated.message };
  }

  const fingerprint = validated.fingerprint;
  const deviceId = String(options.deviceId || '').trim();
  const deviceName = String(options.deviceName || '').trim();
  const row = await pool.query('SELECT * FROM license_records WHERE fingerprint = $1', [fingerprint]);
  if (row.rowCount === 0) {
    await pool.query(
      `INSERT INTO license_records (fingerprint, license_key, customer_name, customer_email, issued_at, expires_at, max_devices, status, notes, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,NOW())
       ON CONFLICT (fingerprint) DO NOTHING`,
      [
        fingerprint,
        validated.key,
        validated.entitlement.name,
        validated.entitlement.email || null,
        validated.entitlement.issuedAt || null,
        validated.entitlement.expiresAt || null,
        validated.entitlement.maxDevices || null,
        validated.entitlement.notes || null,
      ],
    );
  }

  const recordResult = await pool.query('SELECT * FROM license_records WHERE fingerprint = $1', [fingerprint]);
  const record = recordResult.rows[0];
  await pool.query('UPDATE license_records SET last_seen_at = NOW(), updated_at = NOW() WHERE fingerprint = $1', [fingerprint]);
  if (record.status === 'revoked' || record.status === 'expired' || record.status === 'disabled') {
    const message = record.status === 'revoked' || record.status === 'disabled'
      ? 'License no longer active.'
      : `License expired on ${formatLicenseDate(record.expires_at)}.`;
    return {
      ok: false,
      status: 403,
      message,
      fingerprint,
      validated,
      record,
    };
  }

  const maxDevices = effectiveMaxDevices(validated, record);
  const summary = await activationSummary(fingerprint, deviceId);
  if (maxDevices && deviceId && !summary.currentDeviceRegistered && summary.count >= maxDevices) {
    return {
      ok: false,
      status: 403,
      message: deviceLimitMessage(maxDevices),
      fingerprint,
      validated,
      record,
      activation: {
        count: summary.count,
        currentDeviceRegistered: false,
        maxDevices,
      },
    };
  }

  if (deviceId) {
    await registerActivation(fingerprint, deviceId, deviceName);
  }
  const freshSummary = await activationSummary(fingerprint, deviceId);
  return {
    ok: true,
    validated,
    fingerprint,
    record,
    activation: {
      count: freshSummary.count,
      currentDeviceRegistered: freshSummary.currentDeviceRegistered,
      maxDevices,
      devices: freshSummary.rows,
    },
  };
}

async function latestRelease(platform, channel) {
  const result = await pool.query(
    `SELECT * FROM releases
     WHERE platform = $1 AND channel = $2 AND rollout_state = 'live'
     ORDER BY published_at DESC, id DESC
     LIMIT 1`,
    [platform, channel],
  );
  return result.rows[0] || null;
}

async function releaseByVersion(version) {
  const result = await pool.query(
    `SELECT * FROM releases
     WHERE version = $1
     ORDER BY published_at DESC, id DESC
     LIMIT 1`,
    [version],
  );
  return result.rows[0] || null;
}

function hasGitHubReleaseConfig() {
  return Boolean(githubRepoOwner && githubRepoName && githubToken);
}

function githubReleaseSummary() {
  if (!githubRepoOwner || !githubRepoName) return 'Not configured';
  return `${githubRepoOwner}/${githubRepoName}`;
}

function githubHeaders() {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${githubToken}`,
    'User-Agent': 'photo-importer-update-admin',
  };
}

function guessPlatformFromAssetName(name) {
  const normalized = String(name || '').toLowerCase();
  if (normalized.endsWith('.dmg') || normalized.includes('darwin') || normalized.includes('mac')) return 'macos';
  if (normalized.endsWith('.exe') || normalized.endsWith('.nupkg') || normalized.includes('win')) return 'windows';
  return null;
}

async function fetchLatestGitHubReleaseMeta() {
  if (!hasGitHubReleaseConfig()) {
    throw new Error('GitHub release sync is not configured.');
  }
  const response = await fetch(`${githubApiBase.replace(/\/$/, '')}/repos/${githubRepoOwner}/${githubRepoName}/releases/latest`, {
    headers: githubHeaders(),
  });
  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status}.`);
  }
  const release = await response.json();
  const assets = Array.isArray(release.assets) ? release.assets : [];
  return {
    tagName: release.tag_name,
    name: release.name,
    body: release.body,
    publishedAt: release.published_at,
    htmlUrl: release.html_url,
    assets: assets.map((asset) => ({
      name: asset.name,
      url: asset.browser_download_url,
      size: asset.size,
      platform: guessPlatformFromAssetName(asset.name),
    })),
  };
}

app.get('/healthz', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
});

app.get('/releases/:version', async (req, res) => {
  const release = await releaseByVersion(req.params.version);
  if (!release) {
    return res.status(404).send(htmlPage('Release Not Found', `
      <div class="panel" style="max-width:760px;margin:48px auto">
        <h1>Release not found</h1>
        <p class="muted">No hosted release exists for version ${req.params.version}.</p>
      </div>
    `));
  }

  return res.send(htmlPage(`${release.release_name} (${release.version})`, `
    <div class="panel" style="max-width:760px;margin:48px auto">
      <h1>${release.release_name}</h1>
      <p class="muted">Version ${release.version} - ${release.platform} - ${release.channel} - ${fmtDate(release.published_at)}</p>
      ${release.release_notes ? `<pre style="white-space:pre-wrap;background:#020617;border:1px solid #334155;border-radius:12px;padding:14px;margin-top:16px">${release.release_notes}</pre>` : '<p class="muted">No release notes were provided for this version.</p>'}
      <div class="actions" style="margin-top:16px">
        <a href="${release.artifact_url}"><button type="button">Download installer</button></a>
      </div>
    </div>
  `));
});

app.get('/admin/login', (req, res, next) => {
  const token = req.cookies.admin_session;
  if (!token) return next();
  try {
    jwt.verify(token, sessionSecret);
    return res.redirect('/admin');
  } catch {
    return next();
  }
}, (_req, res) => {
  res.send(htmlPage('Admin Login', `
    <div class="panel" style="max-width:420px;margin:48px auto">
      <h1>Photo Importer Admin</h1>
      <p class="muted">Sign in to manage updates and licenses for culler.z2hs.au.</p>
      <form method="post" action="/admin/login">
        <label>Email</label>
        <input type="email" name="email" required />
        <div style="height:10px"></div>
        <label>Password</label>
        <input type="password" name="password" required />
        <div style="height:14px"></div>
        <button type="submit">Sign in</button>
      </form>
    </div>
  `));
});

app.post('/admin/login', async (req, res) => {
  const { email, password } = req.body;
  const result = await pool.query('SELECT * FROM admin_users WHERE email = $1', [email]);
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).send(htmlPage('Admin Login', `
      <div class="panel" style="max-width:420px;margin:48px auto">
        <h1>Photo Importer Admin</h1>
        <p class="bad">Invalid email or password.</p>
        <a href="/admin/login">Try again</a>
      </div>
    `));
  }

  res.cookie('admin_session', signSession({ sub: user.id, email: user.email }), {
    httpOnly: true,
    sameSite: 'lax',
    secure: shouldUseSecureCookies(req),
    path: '/',
  });
  return res.redirect('/admin');
});

app.post('/admin/logout', (req, res) => {
  res.clearCookie('admin_session', {
    path: '/',
    sameSite: 'lax',
    secure: shouldUseSecureCookies(req),
  });
  res.redirect('/admin/login');
});

app.get('/admin', authSession, async (_req, res) => {
  const [licenseStats, releaseStats, recentEvents, errorEvents, topLicenses, deviceCount] = await Promise.all([
    pool.query(`SELECT status, COUNT(*)::int AS count FROM license_records GROUP BY status ORDER BY status`),
    pool.query(`SELECT platform, rollout_state, COUNT(*)::int AS count FROM releases GROUP BY platform, rollout_state ORDER BY platform, rollout_state`),
    pool.query(`SELECT event_type, detail, created_at, fingerprint FROM update_events ORDER BY created_at DESC LIMIT 15`),
    pool.query(`SELECT event_type, detail, created_at FROM update_events WHERE allowed = false ORDER BY created_at DESC LIMIT 5`),
    pool.query(`SELECT lr.fingerprint, lr.customer_name, lr.status, lr.last_seen_at, COUNT(la.id)::int AS device_count
      FROM license_records lr
      LEFT JOIN license_activations la ON la.license_fingerprint = lr.fingerprint
      GROUP BY lr.fingerprint, lr.customer_name, lr.status, lr.last_seen_at
      ORDER BY lr.last_seen_at DESC NULLS LAST LIMIT 5`),
    pool.query(`SELECT COUNT(*)::int AS count FROM license_activations`),
  ]);

  const artifactSize = getDirSize(artifactsRoot);
  const disk = getDiskStats(artifactsRoot);
  const diskPct = disk ? Math.round((disk.used / disk.total) * 100) : null;
  const diskBar = disk ? `<div style="margin-top:8px;background:var(--border2);border-radius:4px;height:6px;overflow:hidden"><div style="width:${diskPct}%;background:${diskPct > 85 ? '#f87171' : diskPct > 65 ? '#fdba74' : '#34d399'};height:100%;border-radius:4px"></div></div><p class="muted" style="margin-top:4px;font-size:.72rem">${formatBytes(disk.used)} used of ${formatBytes(disk.total)} (${disk.pct})</p>` : '';

  res.send(htmlPage('Admin Dashboard', `
    <div class="top"><div><h1>Update Admin</h1><p class="muted">admin.culler.z2hs.au</p></div>${nav('dashboard')}</div>
    <div class="cards">
      ${licenseStats.rows.map((row) => `<div class="card"><div class="card-label">Licenses · ${row.status}</div><div class="card-value">${row.count}</div></div>`).join('')}
      ${releaseStats.rows.map((row) => `<div class="card"><div class="card-label">Releases · ${row.platform} / ${row.rollout_state}</div><div class="card-value">${row.count}</div></div>`).join('')}
      <div class="card"><div class="card-label">Total devices</div><div class="card-value">${deviceCount.rows[0].count}</div></div>
    </div>
    <div class="grid">
      <div class="panel">
        <h2>Storage</h2>
        <div class="cards" style="grid-template-columns:1fr 1fr;gap:8px;margin-bottom:0">
          <div class="card"><div class="card-label">Artifacts</div><div class="card-value" style="font-size:1.3rem">${formatBytes(artifactSize)}</div></div>
          ${disk ? `<div class="card"><div class="card-label">Disk free</div><div class="card-value" style="font-size:1.3rem;color:${diskPct > 85 ? '#f87171' : diskPct > 65 ? '#fdba74' : 'inherit'}">${formatBytes(disk.available)}</div></div>` : ''}
        </div>
        ${diskBar}
      </div>
      <div class="panel">
        <h2>Recently active licenses</h2>
        <table><thead><tr><th>Customer</th><th>Status</th><th>Devices</th><th>Last seen</th></tr></thead><tbody>
        ${topLicenses.rows.map((row) => `<tr>
          <td>${row.customer_name}</td>
          <td><span class="pill pill-${row.status}">${row.status}</span></td>
          <td>${row.device_count}</td>
          <td class="muted">${row.last_seen_at ? fmtTime(row.last_seen_at) : 'Never'}</td>
        </tr>`).join('')}
        </tbody></table>
      </div>
    </div>
    <div class="grid">
      <div class="panel">
        <h2>Recent update activity</h2>
        <table><thead><tr><th>Event</th><th>Detail</th><th>Time</th></tr></thead><tbody>
        ${recentEvents.rows.map((row) => `<tr><td>${row.event_type}</td><td class="muted">${row.detail || '—'}</td><td class="muted">${fmtTime(row.created_at)}</td></tr>`).join('')}
        </tbody></table>
      </div>
      ${errorEvents.rows.length > 0 ? `<div class="panel">
        <h2>⚠ Blocked / failed events</h2>
        <table><thead><tr><th>Event</th><th>Detail</th><th>Time</th></tr></thead><tbody>
        ${errorEvents.rows.map((row) => `<tr><td class="bad">${row.event_type}</td><td class="muted">${row.detail || '—'}</td><td class="muted">${fmtTime(row.created_at)}</td></tr>`).join('')}
        </tbody></table>
      </div>` : ''}
    </div>
  `));
});

app.get('/admin/licenses', authSession, async (_req, res) => {
  const result = await pool.query('SELECT * FROM license_records ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT 100');
  const generatorEnabled = canGenerateLicenses();

  res.send(htmlPage('Licenses', `
    <div class="hero">
      <div class="hero-copy">
        <div class="hero-kicker">Licensing</div>
        <h1>Device-based licenses with adjustable seat counts.</h1>
        <p>Each license can carry its own device limit. The desktop app registers a stable machine fingerprint, so you can manage seats without depending on raw MAC addresses.</p>
      </div>
      ${nav('licenses')}
    </div>
    <div class="grid">
      <div class="panel">
        <h2>Generate license</h2>
        ${generatorEnabled
          ? `<p class="muted" style="margin-bottom:12px">Create a Full access customer key right here in the admin panel. Expiry uses DD-MM-YYYY.</p>
        <form method="post" action="/admin/licenses/generate">
          <label>Customer name</label>
          <input name="name" required placeholder="Jane Smith" />
          <label>Email</label>
          <input type="email" name="email" placeholder="jane@example.com" />
          <label>Expiry <span style="font-weight:400">(optional)</span></label>
          <input name="expiry" placeholder="31-12-2027" />
          <label>Max devices</label>
          <input type="number" name="maxDevices" min="1" step="1" value="1" />
          <label>Notes <span style="font-weight:400">(optional)</span></label>
          <textarea name="notes" rows="2"></textarea>
          <div style="height:16px"></div>
          <button type="submit">Generate and store</button>
        </form>`
          : `<p class="bad" style="margin-bottom:8px">License generation is disabled — <code>private.pem</code> is not mounted.</p>
        <p class="muted">You can still import already-generated licenses below.</p>`}
      </div>
      <div class="panel">
        <h2>Import existing license</h2>
        <form method="post" action="/admin/licenses/import">
          <label>License key</label>
          <textarea name="licenseKey" rows="5" required placeholder="PI1-..."></textarea>
          <label>Notes <span style="font-weight:400">(optional)</span></label>
          <textarea name="notes" rows="2"></textarea>
          <div style="height:16px"></div>
          <button type="submit">Store license</button>
        </form>
      </div>
      <div class="panel">
        <h2>Status guide</h2>
        <p class="muted"><span class="ok">Active</span> — can update normally.</p>
        <p class="muted"><span class="bad">Revoked</span> — blocks updates immediately.</p>
        <p class="muted"><span class="warn">Expired</span> — admin mirror of a lapsed subscription.</p>
        <p class="muted" style="color:#64748b">Disabled — temporary hold without full revocation.</p>
        <p class="muted" style="margin-top:12px">Generated keys use the same offline format as the desktop app and keep working with your shipped EXE as long as the same private key is used.</p>
      </div>
    </div>
    <div class="panel">
      <h2>All licenses</h2>
      <table><thead><tr><th>Customer</th><th>Status</th><th>Seats</th><th>Activation code</th><th>Expires</th><th>Last seen</th><th>Actions</th></tr></thead><tbody>
      ${result.rows.map((row) => `<tr>
        <td><span style="font-weight:600">${row.customer_name}</span>${row.customer_email ? `<div class="muted">${row.customer_email}</div>` : ''}</td>
        <td>${statusPill(row.status)}</td>
        <td class="muted">${row.max_devices || '&infin;'} device${row.max_devices === 1 ? '' : 's'}</td>
        <td><code>${row.activation_code || '—'}</code></td>
        <td class="muted">${formatLicenseDate(row.expires_at)}</td>
        <td class="muted">${row.last_seen_at ? fmtTime(row.last_seen_at) : 'Never'}</td>
        <td>
          <div class="actions">
            <a href="/admin/licenses/${row.id}"><button class="secondary sm" type="button">View</button></a>
            ${row.status !== 'revoked' ? `<form class="inline" method="post" action="/admin/licenses/${row.id}/revoke"><button class="secondary sm" type="submit">Revoke</button></form>` : ''}
            ${row.status !== 'active' ? `<form class="inline" method="post" action="/admin/licenses/${row.id}/activate"><button class="secondary sm" type="submit">Activate</button></form>` : ''}
          </div>
        </td>
      </tr>`).join('')}
      </tbody></table>
    </div>
  `));
});

app.post('/admin/licenses/generate', authSession, async (req, res) => {
  try {
    const licenseKey = createLicenseKey({
      name: req.body.name,
      email: req.body.email,
      expiry: req.body.expiry,
      notes: req.body.notes,
      maxDevices: req.body.maxDevices,
    });
    const validated = validateLicenseKey(licenseKey, licensePublicKeyPem);
    if (!validated.valid) {
      throw new Error(validated.message || 'Generated key did not validate.');
    }

    const activationCode = await upsertLicenseRecord(validated, req.body.notes);

    return res.send(htmlPage('License Generated', `
      <div class="top"><div><h1>License generated</h1><p class="muted">Store this key somewhere safe before leaving the page.</p></div>${nav('licenses')}</div>
      <div class="panel">
        <p><strong>${validated.entitlement.name}</strong>${validated.entitlement.email ? ` <span class="muted">(${validated.entitlement.email})</span>` : ''}</p>
        <p class="muted">Full access${validated.entitlement.expiresAt ? ` until ${formatLicenseDate(validated.entitlement.expiresAt)}` : ' with no expiry'}.</p>
        <p class="muted">Seat limit: ${validated.entitlement.maxDevices || 1} device${validated.entitlement.maxDevices === 1 ? '' : 's'}.</p>
        <label>Activation code</label>
        <input value="${activationCode}" readonly />
        <div style="height:10px"></div>
        <label>License key</label>
        <textarea rows="6" readonly>${licenseKey}</textarea>
        <div style="height:14px"></div>
        <div class="actions">
          <a href="/admin/licenses"><button type="button">Back to licenses</button></a>
        </div>
      </div>
    `));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not generate a license.';
    return res.status(400).send(htmlPage('License Error', `<div class="panel"><h1>License generation failed</h1><p class="bad">${message}</p><a href="/admin/licenses">Back</a></div>`));
  }
});

app.post('/admin/licenses/import', authSession, async (req, res) => {
  const validated = validateLicenseKey(req.body.licenseKey, licensePublicKeyPem);
  if (!validated.valid) {
    return res.status(400).send(htmlPage('License Error', `<div class="panel"><h1>License import failed</h1><p class="bad">${validated.message}</p><a href="/admin/licenses">Back</a></div>`));
  }

  await upsertLicenseRecord(validated, req.body.notes);
  return res.redirect('/admin/licenses');
});

app.get('/admin/licenses/:id', authSession, async (req, res) => {
  const result = await pool.query('SELECT * FROM license_records WHERE id = $1', [req.params.id]);
  if (!result.rowCount) {
    return res.status(404).send(htmlPage('License Not Found', `<div class="panel"><h1>License not found</h1><a href="/admin/licenses">Back</a></div>`));
  }
  const record = result.rows[0];
  const activations = await pool.query(
    `SELECT id, device_id, device_name, first_seen_at, last_seen_at, expires_at
     FROM license_activations
     WHERE license_fingerprint = $1
     ORDER BY last_seen_at DESC, id DESC`,
    [record.fingerprint],
  );
  return res.send(htmlPage(`License ${record.customer_name}`, `
    <div class="top"><div><h1>${record.customer_name}</h1><p class="muted">License details and activation info.</p></div>${nav('licenses')}</div>
    <div class="grid">
      <div class="panel">
        <h2>Details</h2>
        <p style="margin-bottom:12px">${statusPill(record.status)}</p>
        <p class="muted">Activation code: <code>${record.activation_code || '—'}</code></p>
        ${record.customer_email ? `<p class="muted">Email: ${record.customer_email}</p>` : ''}
        <p class="muted">Issued: ${formatLicenseDate(record.issued_at)}</p>
        <p class="muted">Expires: ${formatLicenseDate(record.expires_at)}</p>
        <p class="muted">Seat limit: ${record.max_devices || '&infin;'} device${record.max_devices === 1 ? '' : 's'}</p>
        <p class="muted">Devices seen: ${activations.rowCount}</p>
        <p class="muted">Last seen: ${record.last_seen_at ? fmtTime(record.last_seen_at) : 'Never'}</p>
        <form method="post" action="/admin/licenses/${record.id}/devices" style="margin-top:16px">
          <label>Max devices</label>
          <input type="number" name="maxDevices" min="1" step="1" value="${record.max_devices || 1}" />
          <div style="height:12px"></div>
          <button type="submit">Save seat limit</button>
        </form>
        <div style="margin-top:16px" class="actions">
          ${record.status !== 'revoked' ? `<form class="inline" method="post" action="/admin/licenses/${record.id}/revoke"><button class="secondary sm" type="submit">Revoke</button></form>` : ''}
          ${record.status !== 'active' ? `<form class="inline" method="post" action="/admin/licenses/${record.id}/activate"><button class="secondary sm" type="submit">Re-activate</button></form>` : ''}
        </div>
      </div>
      <div class="panel">
        <h2>Stored key</h2>
        <textarea rows="8" readonly>${record.license_key}</textarea>
      </div>
      <div class="panel">
        <h2>Registered devices</h2>
        ${activations.rowCount
          ? `<table><thead><tr><th>Device</th><th>Device ID</th><th>First seen</th><th>Last seen</th><th>Device expiry</th><th>Actions</th></tr></thead><tbody>
              ${activations.rows.map((row) => `<tr>
                <td>${row.device_name || 'Unnamed device'}</td>
                <td><code>${row.device_id}</code></td>
                <td class="muted">${fmtTime(row.first_seen_at)}</td>
                <td class="muted">${fmtTime(row.last_seen_at)}</td>
                <td>
                  <form class="inline" method="post" action="/admin/licenses/${record.id}/devices/${row.id}/expiry" style="display:flex;gap:6px;align-items:center">
                    <input type="date" name="expiresAt" value="${row.expires_at ? new Date(row.expires_at).toISOString().slice(0,10) : ''}" style="width:140px;padding:5px 8px;font-size:.75rem" />
                    <button class="secondary sm" type="submit" title="Save expiry">Save</button>
                  </form>
                </td>
                <td>
                  <form class="inline" method="post" action="/admin/licenses/${record.id}/devices/${row.id}/remove" onsubmit="return confirm('Remove this device from the license? It will need to re-register.')">
                    <button class="danger sm" type="submit">Remove</button>
                  </form>
                </td>
              </tr>`).join('')}
            </tbody></table>`
          : '<p class="muted">No devices have activated this license yet.</p>'}
      </div>
    </div>
  `));
});

app.post('/admin/licenses/:id/revoke', authSession, async (req, res) => {
  await pool.query(`UPDATE license_records SET status = 'revoked', updated_at = NOW() WHERE id = $1`, [req.params.id]);
  res.redirect('/admin/licenses');
});

app.post('/admin/licenses/:id/activate', authSession, async (req, res) => {
  await pool.query(`UPDATE license_records SET status = 'active', updated_at = NOW() WHERE id = $1`, [req.params.id]);
  res.redirect('/admin/licenses');
});

app.post('/admin/licenses/:id/devices', authSession, async (req, res) => {
  const maxDevices = parseMaxDevices(req.body.maxDevices, 1);
  await pool.query('UPDATE license_records SET max_devices = $1, updated_at = NOW() WHERE id = $2', [maxDevices, req.params.id]);
  res.redirect(`/admin/licenses/${req.params.id}`);
});

app.post('/admin/licenses/:id/devices/:deviceRowId/expiry', authSession, async (req, res) => {
  const expiresAt = req.body.expiresAt ? req.body.expiresAt : null;
  await pool.query(
    'UPDATE license_activations SET expires_at = $1, updated_at = NOW() WHERE id = $2',
    [expiresAt, req.params.deviceRowId],
  );
  res.redirect(`/admin/licenses/${req.params.id}`);
});

app.post('/admin/licenses/:id/devices/:deviceRowId/remove', authSession, async (req, res) => {
  await pool.query('DELETE FROM license_activations WHERE id = $1', [req.params.deviceRowId]);
  res.redirect(`/admin/licenses/${req.params.id}`);
});

app.get('/admin/releases', authSession, async (req, res) => {
  const releases = await pool.query('SELECT * FROM releases ORDER BY published_at DESC, id DESC LIMIT 100');
  const githubRelease = hasGitHubReleaseConfig()
    ? await fetchLatestGitHubReleaseMeta().catch((error) => ({ error: error instanceof Error ? error.message : 'Could not load GitHub release.' }))
    : null;
  const warnMsg = req.query.warn ? String(req.query.warn) : null;
  const warnBanner = warnMsg
    ? '<div style="background:#7f1d1d;border:1px solid #ef4444;border-radius:8px;padding:12px 16px;margin-bottom:16px;color:#fca5a5;font-size:.85rem">Warning: ' + warnMsg + '</div>'
    : '';
  res.send(htmlPage('Releases', warnBanner + `
    <div class="hero">
      <div class="hero-copy">
        <div class="hero-kicker">Hosted Releases</div>
        <h1>Keep the website, updater, and CI on the same latest release.</h1>
        <p>The update feed serves the newest live release only. GitHub metadata can be synced from the repo configured in your TrueNAS environment.</p>
      </div>
      ${nav('releases')}
    </div>
    <div class="grid">
      <div class="panel">
        <h2>Add release</h2>
        <form method="post" action="/admin/releases">
          <div class="row">
            <div><label>Version</label><input name="version" placeholder="1.1.1" required /></div>
            <div><label>Platform</label><select name="platform"><option value="windows">Windows</option><option value="macos">macOS</option></select></div>
          </div>
          <div class="row" style="margin-top:4px">
            <div><label>Channel</label><input name="channel" value="stable" required /></div>
            <div><label>Rollout</label><select name="rolloutState"><option value="live">Live</option><option value="draft">Draft</option><option value="hidden">Hidden</option></select></div>
          </div>
          <label>Release name</label><input name="releaseName" placeholder="Photo Importer 1.1.1" required />
          <label>Artifact URL</label><input name="artifactUrl" placeholder="https://updates.culler.z2hs.au/artifacts/windows/PhotoImporter-Setup-1.1.1.exe" required />
          <label>Release URL <span style="font-weight:400">(optional)</span></label><input name="releaseUrl" placeholder="https://admin.culler.z2hs.au/releases/1.1.1" />
          <label>Release notes <span style="font-weight:400">(optional)</span></label><textarea name="releaseNotes" rows="4"></textarea>
          <div style="height:16px"></div>
          <button type="submit">Save release</button>
        </form>
      </div>
      <div class="panel">
        <h2>CI automation</h2>
        <p class="muted" style="margin-bottom:8px">Use the admin API token with <code>scripts/publish-update-release.mjs</code> from CI or your local release machine to import Windows/macOS artifacts after GitHub builds them.</p>
        ${!hasGitHubReleaseConfig()
          ? `<p class="muted">GitHub sync is off until you set <code>GITHUB_RELEASE_OWNER</code>, <code>GITHUB_RELEASE_REPO</code>, and <code>GITHUB_RELEASE_TOKEN</code> in TrueNAS.</p>`
          : githubRelease?.error
            ? `<p class="bad">${githubRelease.error}</p>`
            : `<p class="muted">GitHub repo: <code>${githubReleaseSummary()}</code> · latest ${githubRelease?.tagName || 'Unknown'} · ${Array.isArray(githubRelease?.assets) ? githubRelease.assets.length : 0} assets found.</p>
               <form method="post" action="/admin/releases/sync-github" style="margin-top:12px">
                 <button type="submit">Import latest GitHub metadata</button>
               </form>`}
        <p class="muted">New releases are saved as <strong>Draft</strong> by default — go live explicitly when ready.</p>
      </div>
    </div>
    <div class="panel">
      <h2>All releases</h2>
      <table><thead><tr><th>Release</th><th>Platform</th><th>Channel</th><th>State</th><th>Published</th><th>Actions</th></tr></thead><tbody>
      ${releases.rows.map((row) => `<tr>
        <td><span style="font-weight:600">${row.release_name}</span><div class="muted">v${row.version}</div></td>
        <td class="muted">${row.platform}</td>
        <td class="muted">${row.channel}</td>
        <td>${statusPill(row.rollout_state)}</td>
        <td class="muted">${fmtTime(row.published_at)}</td>
        <td style="white-space:nowrap;width:1%">
          <div class="actions" style="flex-wrap:nowrap;gap:6px">
            <a href="/admin/releases/${row.id}/edit"><button class="secondary sm" type="button">Edit</button></a>
            ${row.rollout_state !== 'live' ? `<form class="inline" method="post" action="/admin/releases/${row.id}/live"><button class="secondary sm" type="submit">Go live</button></form>` : ''}
            ${row.rollout_state === 'live' ? `<form class="inline" method="post" action="/admin/releases/${row.id}/hide"><button class="secondary sm" type="submit">Hide</button></form>` : ''}
            <form class="inline" method="post" action="/admin/releases/${row.id}/delete" onsubmit="return confirm('Delete ${row.release_name} (${row.version})? This cannot be undone.')"><button class="danger sm" type="submit">Delete</button></form>
          </div>
        </td>
      </tr>`).join('')}
      </tbody></table>
    </div>
  `));
});

app.post('/admin/releases/sync-github', authSession, async (_req, res) => {
  if (!hasGitHubReleaseConfig()) {
    return res.status(400).send(htmlPage('GitHub Sync Error', `<div class="panel"><h1>GitHub sync is not configured</h1><p class="muted">Set GITHUB_RELEASE_OWNER, GITHUB_RELEASE_REPO, and GITHUB_RELEASE_TOKEN in TrueNAS first.</p><a href="/admin/releases">Back</a></div>`));
  }

  try {
    const latest = await fetchLatestGitHubReleaseMeta();
    const version = String(latest.tagName || '').replace(/^v/i, '');
    if (!version) {
      throw new Error('Latest GitHub release has no tag.');
    }

    const assets = latest.assets.filter((asset) => asset.platform && asset.url);
    for (const asset of assets) {
      await pool.query(
        `INSERT INTO releases (version, platform, channel, release_name, release_notes, release_url, artifact_url, rollout_state, published_at)
         VALUES ($1,$2,'stable',$3,$4,$5,$6,'draft',$7)
         ON CONFLICT DO NOTHING`,
        [
          version,
          asset.platform,
          latest.name || `Photo Importer ${version}`,
          latest.body || null,
          latest.htmlUrl || null,
          asset.url,
          latest.publishedAt || new Date().toISOString(),
        ],
      );
    }
    return res.redirect('/admin/releases');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not sync the latest GitHub release.';
    return res.status(400).send(htmlPage('GitHub Sync Error', `<div class="panel"><h1>GitHub sync failed</h1><p class="bad">${message}</p><a href="/admin/releases">Back</a></div>`));
  }
});

app.post('/admin/releases', authSession, async (req, res) => {
  const version = req.body.version;
  const releaseUrl = req.body.releaseUrl || publicUpdatesBaseUrl().replace('updates.', 'admin.') + `/releases/${version}`;
  await pool.query(
    `INSERT INTO releases (version, platform, channel, release_name, release_notes, release_url, artifact_url, rollout_state, published_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
    [
      version,
      req.body.platform,
      req.body.channel || 'stable',
      req.body.releaseName,
      req.body.releaseNotes || null,
      releaseUrl,
      req.body.artifactUrl,
      req.body.rolloutState || 'draft',
    ],
  );
  res.redirect('/admin/releases');
});

app.post('/admin/releases/:id/live', authSession, async (req, res) => {
  await pool.query(`UPDATE releases SET rollout_state = 'live' WHERE id = $1`, [req.params.id]);
  res.redirect('/admin/releases');
});

app.post('/admin/releases/:id/hide', authSession, async (req, res) => {
  await pool.query(`UPDATE releases SET rollout_state = 'hidden' WHERE id = $1`, [req.params.id]);
  res.redirect('/admin/releases');
});

app.get('/admin/releases/:id/edit', authSession, async (req, res) => {
  const result = await pool.query('SELECT * FROM releases WHERE id = $1', [req.params.id]);
  if (!result.rowCount) {
    return res.status(404).send(htmlPage('Not Found', `<div class="panel"><h1>Release not found</h1><a href="/admin/releases">Back</a></div>`));
  }
  const row = result.rows[0];
  return res.send(htmlPage(`Edit ${row.release_name}`, `
    <div class="top"><div><h1>Edit release</h1><p class="muted">${row.version} &middot; ${row.platform} &middot; ${row.channel}</p></div>${nav('releases')}</div>
    <div class="panel" style="max-width:680px">
      <form method="post" action="/admin/releases/${row.id}/edit">
        <label>Release name</label>
        <input name="releaseName" value="${row.release_name}" required />
        <div style="height:10px"></div>
        <label>Channel</label>
        <select name="channel">
          <option value="stable" ${row.channel === 'stable' ? 'selected' : ''}>stable</option>
          <option value="beta" ${row.channel === 'beta' ? 'selected' : ''}>beta</option>
        </select>
        <div style="height:10px"></div>
        <label>Rollout</label>
        <select name="rolloutState">
          <option value="live" ${row.rollout_state === 'live' ? 'selected' : ''}>live</option>
          <option value="draft" ${row.rollout_state === 'draft' ? 'selected' : ''}>draft</option>
          <option value="hidden" ${row.rollout_state === 'hidden' ? 'selected' : ''}>hidden</option>
        </select>
        <div style="height:10px"></div>
        <label>Artifact URL</label>
        <input name="artifactUrl" value="${row.artifact_url}" required />
        <div style="height:10px"></div>
        <label>Release notes</label>
        <textarea name="releaseNotes" rows="8">${row.release_notes || ''}</textarea>
        <div style="height:14px"></div>
        <div class="actions">
          <button type="submit">Save changes</button>
          <a href="/admin/releases"><button class="secondary" type="button">Cancel</button></a>
        </div>
      </form>
    </div>
    <div class="panel" style="max-width:680px;margin-top:16px;border-color:#4a0e0e">
      <h2 style="color:#fca5a5">Danger zone</h2>
      <p class="muted" style="margin-bottom:14px">Deleting a release removes it from the database and deletes the artifact file from the server if it is hosted here.</p>
      <form method="post" action="/admin/releases/${row.id}/delete" onsubmit="return confirm('Delete ${row.release_name} (${row.version})? This cannot be undone.')">
        <button class="danger" type="submit">Delete this release</button>
      </form>
    </div>
  `));
});

app.post('/admin/releases/:id/edit', authSession, async (req, res) => {
  await pool.query(
    `UPDATE releases
     SET release_name = $1, channel = $2, rollout_state = $3, artifact_url = $4, release_notes = $5
     WHERE id = $6`,
    [
      req.body.releaseName,
      req.body.channel || 'stable',
      req.body.rolloutState || 'draft',
      req.body.artifactUrl,
      req.body.releaseNotes || null,
      req.params.id,
    ],
  );
  res.redirect('/admin/releases');
});

app.post('/admin/releases/:id/delete', authSession, async (req, res) => {
  const release = await pool.query('SELECT * FROM releases WHERE id = $1', [req.params.id]);
  if (!release.rowCount) {
    return res.redirect('/admin/releases');
  }

  const row = release.rows[0];
  const artifactUrl = row.artifact_url || '';
  const deleteErrors = [];

  // ── Case 1: locally-hosted artifact ──────────────────────────────────────
  const baseUrl = publicUpdatesBaseUrl();
  if (artifactUrl.startsWith(baseUrl + '/artifacts/')) {
    try {
      const relPath = artifactUrl.slice((baseUrl + '/artifacts/').length);
      const localPath = path.join(artifactsRoot, decodeURIComponent(relPath));
      if (localPath.startsWith(path.resolve(artifactsRoot))) {
        await fs.promises.unlink(localPath);
      }
    } catch (err) {
      deleteErrors.push('Local file: ' + err.message);
    }
  }

  // ── Case 2: GitHub-hosted artifact ───────────────────────────────────────
  // artifact_url is a browser_download_url like:
  //   https://github.com/<owner>/<repo>/releases/download/<tag>/<file>
  const ghDownloadPrefix = 'https://github.com/' + githubRepoOwner + '/' + githubRepoName + '/releases/download/';
  if (hasGitHubReleaseConfig() && artifactUrl.startsWith(ghDownloadPrefix)) {
    try {
      const rest = artifactUrl.slice(ghDownloadPrefix.length); // "<tag>/<filename>"
      const tagName = rest.split('/')[0];
      const assetName = decodeURIComponent(rest.split('/').slice(1).join('/'));
      const ghBase = githubApiBase.replace(/\/$/, '');
      const releaseRes = await fetch(
        ghBase + '/repos/' + githubRepoOwner + '/' + githubRepoName + '/releases/tags/' + encodeURIComponent(tagName),
        { headers: githubHeaders() },
      );
      if (releaseRes.ok) {
        const ghRelease = await releaseRes.json();
        const asset = (ghRelease.assets || []).find((a) => a.name === assetName);
        if (asset) {
          const delRes = await fetch(
            ghBase + '/repos/' + githubRepoOwner + '/' + githubRepoName + '/releases/assets/' + asset.id,
            { method: 'DELETE', headers: githubHeaders() },
          );
          if (!delRes.ok && delRes.status !== 204) {
            deleteErrors.push('GitHub asset delete returned ' + delRes.status);
          }
        } else {
          // Asset may already be gone — not a hard error
          console.warn('[delete-release] GitHub asset not found in tag', tagName, '- may already be deleted');
        }
      } else {
        deleteErrors.push('GitHub release lookup for tag ' + tagName + ' returned ' + releaseRes.status);
      }
    } catch (err) {
      deleteErrors.push('GitHub delete: ' + err.message);
    }
  }

  // Always remove from DB regardless of file-deletion outcome
  await pool.query('DELETE FROM releases WHERE id = $1', [req.params.id]);

  if (deleteErrors.length > 0) {
    const warn = encodeURIComponent('Release removed from database, but cleanup had issues: ' + deleteErrors.join('; '));
    return res.redirect('/admin/releases?warn=' + warn);
  }
  res.redirect('/admin/releases');
});

app.get('/admin/customers', authSession, async (_req, res) => {
  const rows = await pool.query(`
    SELECT fingerprint, MAX(created_at) AS last_event, MAX(detail) FILTER (WHERE detail IS NOT NULL) AS detail
    FROM update_events
    GROUP BY fingerprint
    ORDER BY MAX(created_at) DESC
    LIMIT 100
  `);
  res.send(htmlPage('Customers', `
    <div class="top"><div><h1>Customers / installs</h1><p class="muted">Latest seen update activity per install fingerprint.</p></div>${nav('customers')}</div>
    <div class="panel">
      <h2>${rows.rows.length} active installs</h2>
      <table><thead><tr><th>Fingerprint</th><th>Last activity</th><th>Detail</th></tr></thead><tbody>
      ${rows.rows.map((row) => `<tr>
        <td><code style="font-size:.75rem">${row.fingerprint || 'Unknown'}</code></td>
        <td class="muted">${row.last_event ? fmtTime(row.last_event) : 'Never'}</td>
        <td class="muted">${row.detail || '—'}</td>
      </tr>`).join('')}
      </tbody></table>
    </div>
  `));
});

app.post('/admin/api/releases/import', requireAdminApiToken, async (req, res) => {
  const {
    version,
    platform,
    channel = 'stable',
    releaseName,
    releaseNotes,
    releaseUrl,
    artifactUrl,
    rolloutState = 'draft',
  } = req.body;
  if (!version || !platform || !releaseName || !artifactUrl) {
    return res.status(400).json({ error: 'version, platform, releaseName, and artifactUrl are required.' });
  }
  const resolvedReleaseUrl = releaseUrl || publicUpdatesBaseUrl().replace('updates.', 'admin.') + `/releases/${version}`;
  const result = await pool.query(
    `INSERT INTO releases (version, platform, channel, release_name, release_notes, release_url, artifact_url, rollout_state, published_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
     RETURNING id`,
    [version, platform, channel, releaseName, releaseNotes || null, resolvedReleaseUrl, artifactUrl, rolloutState],
  );
  return res.json({ ok: true, id: result.rows[0].id });
});

app.post('/admin/api/artifacts/upload', requireAdminApiToken, express.raw({ type: '*/*', limit: '2gb' }), async (req, res) => {
  try {
    const platform = normalizeReleasePlatform(req.query.platform);
    const filename = sanitizeArtifactFilename(req.query.filename);
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');

    if (!body.length) {
      return res.status(400).json({ error: 'Artifact body is empty.' });
    }

    const platformDir = path.join(artifactsRoot, platform);
    const targetPath = path.join(platformDir, filename);
    await fs.promises.mkdir(platformDir, { recursive: true });
    await fs.promises.writeFile(targetPath, body);

    return res.json({
      ok: true,
      filename,
      platform,
      artifactUrl: `${publicUpdatesBaseUrl()}/artifacts/${platform}/${encodeURIComponent(filename)}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not upload artifact.';
    return res.status(400).json({ error: message });
  }
});

app.post('/api/v1/license/resolve', async (req, res) => {
  const activationCode = String(req.body.activationCode || '').trim().toUpperCase();
  const deviceId = req.header('x-device-id');
  const deviceName = req.header('x-device-name');
  if (!activationCode) {
    return res.status(400).json({ allowed: false, message: 'Enter an activation code.', status: 'unknown' });
  }

  const result = await pool.query('SELECT * FROM license_records WHERE activation_code = $1', [activationCode]);
  if (!result.rowCount) {
    return res.status(404).json({ allowed: false, message: 'Activation code not found.', activationCode, status: 'unknown' });
  }

  const record = result.rows[0];
  if (record.status === 'revoked' || record.status === 'disabled') {
    return res.status(403).json({
      allowed: false,
      message: 'License no longer active.',
      activationCode,
      status: record.status,
    });
  }
  if (record.status === 'expired') {
    return res.status(403).json({
      allowed: false,
      message: `License expired on ${formatLicenseDate(record.expires_at)}.`,
      activationCode,
      status: 'expired',
    });
  }

  const maxDevices = Number(record.max_devices || 0) || null;
  const summary = await activationSummary(record.fingerprint, deviceId);
  if (maxDevices && deviceId && !summary.currentDeviceRegistered && summary.count >= maxDevices) {
    return res.status(403).json({
      allowed: false,
      message: deviceLimitMessage(maxDevices),
      activationCode,
      status: 'disabled',
      deviceId: deviceId || undefined,
      deviceName: deviceName || undefined,
      deviceSlotsUsed: summary.count,
      deviceSlotsTotal: maxDevices,
      currentDeviceRegistered: false,
    });
  }

  if (deviceId) {
    await registerActivation(record.fingerprint, deviceId, deviceName);
  }
  const freshSummary = await activationSummary(record.fingerprint, deviceId);
  await pool.query('UPDATE license_records SET last_seen_at = NOW(), updated_at = NOW() WHERE id = $1', [record.id]);
  return res.json({
    allowed: true,
    activationCode,
    licenseKey: record.license_key,
    message: record.expires_at
      ? `License active until ${formatLicenseDate(record.expires_at)}.`
      : 'License active.',
    status: 'active',
    entitlement: {
      product: 'photo-importer',
      name: record.customer_name,
      email: record.customer_email || undefined,
      issuedAt: record.issued_at,
      expiresAt: record.expires_at || undefined,
      tier: 'Full access',
      notes: record.notes || undefined,
      maxDevices: maxDevices || undefined,
    },
    deviceId: deviceId || undefined,
    deviceName: deviceName || undefined,
    deviceSlotsUsed: freshSummary.count,
    deviceSlotsTotal: maxDevices || undefined,
    currentDeviceRegistered: freshSummary.currentDeviceRegistered,
  });
});

app.get('/api/v1/license/status', async (req, res) => {
  const licenseKey = req.header('x-license-key');
  const deviceId = req.header('x-device-id');
  const deviceName = req.header('x-device-name');
  if (!licenseKey) {
    return res.status(400).json({ allowed: false, message: 'Missing license key.', status: 'unknown' });
  }

  const resolved = await resolveLicenseRecord(licenseKey, { deviceId, deviceName });
  if (!resolved.ok) {
    return res.status(resolved.status).json({
      allowed: false,
      message: resolved.message,
      status: resolved.record?.status || 'unknown',
      activationCode: resolved.record?.activation_code,
      entitlement: resolved.validated?.entitlement
        ? { ...resolved.validated.entitlement, maxDevices: resolved.activation?.maxDevices || resolved.validated.entitlement.maxDevices }
        : undefined,
      deviceId: deviceId || undefined,
      deviceName: deviceName || undefined,
      deviceSlotsUsed: resolved.activation?.count,
      deviceSlotsTotal: resolved.activation?.maxDevices,
      currentDeviceRegistered: resolved.activation?.currentDeviceRegistered,
    });
  }

  return res.json({
    allowed: true,
    message: resolved.record?.expires_at
      ? `License active until ${formatLicenseDate(resolved.record.expires_at)}.`
      : 'License active.',
    status: resolved.record?.status || 'active',
    activationCode: resolved.record?.activation_code,
    entitlement: resolved.validated?.entitlement
      ? { ...resolved.validated.entitlement, maxDevices: resolved.activation?.maxDevices || resolved.validated.entitlement.maxDevices }
      : undefined,
    deviceId: deviceId || undefined,
    deviceName: deviceName || undefined,
    deviceSlotsUsed: resolved.activation?.count,
    deviceSlotsTotal: resolved.activation?.maxDevices,
    currentDeviceRegistered: resolved.activation?.currentDeviceRegistered,
  });
});

app.get('/api/v1/app/update', async (req, res) => {
  const licenseKey = req.header('x-license-key');
  const deviceId = req.header('x-device-id');
  const deviceName = req.header('x-device-name');
  const platform = req.query.platform || 'windows';
  const version = req.query.version || '0.0.0';
  const channel = req.query.channel || 'stable';

  // Resolve license if provided — but allow update checks even without one.
  // Unlicensed installs get update info but no download token.
  let resolved = null;
  if (licenseKey) {
    const attempt = await resolveLicenseRecord(licenseKey, { deviceId, deviceName });
    if (attempt.ok) {
      resolved = attempt;
    } else {
      await logUpdateEvent('update-check', {
        fingerprint: attempt.fingerprint,
        appVersion: version,
        platform,
        channel,
        allowed: true,
        detail: `Unlicensed check: ${attempt.message}`,
      });
    }
  }

  const release = await latestRelease(platform, channel);
  if (!release) {
    await logUpdateEvent('update-check', {
      fingerprint: resolved.fingerprint,
      appVersion: version,
      platform,
      channel,
      allowed: true,
      detail: 'No live release',
    });
    return res.json({
      allowed: true,
      currentVersion: version,
      latestVersion: version,
      message: 'No published update is available yet.',
    });
  }

  // Only issue a download token for licensed installs
  const token = resolved ? signDownloadToken({
    fingerprint: resolved.fingerprint,
    releaseId: release.id,
    platform,
    channel,
  }) : null;
  await logUpdateEvent('update-check', {
    fingerprint: resolved?.fingerprint,
    appVersion: version,
    platform,
    channel,
    allowed: true,
    detail: `Offered ${release.version}${resolved ? '' : ' (unlicensed)'}`,
  });

  return res.json({
    allowed: true,
    currentVersion: version,
    latestVersion: release.version,
    releaseName: release.release_name,
    releaseNotes: release.release_notes,
    releaseDate: release.published_at,
    releaseUrl: release.release_url,
    ...(token ? {
      downloadUrl: `${publicUpdatesBaseUrl()}/api/v1/app/download/${release.id}?token=${encodeURIComponent(token)}`,
      feedUrl: platform === 'windows' ? `${publicUpdatesBaseUrl()}/artifacts/windows` : undefined,
    } : {}),
  });
});

function setPublicCors(req, res) {
  const origin = req.headers.origin;
  const allowed = ['https://culler.z2hs.au', 'http://culler.z2hs.au'];
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type');
  res.setHeader('Vary', 'Origin');
}

app.options('/api/v1/app/releases', (req, res) => {
  setPublicCors(req, res);
  res.sendStatus(204);
});

// Public endpoint — no license key required. Used by the download page.
app.get('/api/v1/app/releases', async (req, res) => {
  setPublicCors(req, res);
  const platform = req.query.platform || null;
  const channel = req.query.channel || 'stable';
  const latestOnly = String(req.query.latest || '').toLowerCase() === 'true';
  const limit = latestOnly ? 1 : Math.min(Number(req.query.limit || 10), 50);

  const rows = await pool.query(
    `SELECT version, release_name, release_notes, release_url, artifact_url, published_at, channel, platform
     FROM releases
     WHERE ($1::text IS NULL OR platform = $1)
       AND channel = $2
       AND rollout_state = 'live'
     ORDER BY published_at DESC, id DESC
     LIMIT $3`,
    [platform, channel, limit],
  );

  return res.json({
    releases: rows.rows.map((row) => ({
      version: row.version,
      releaseName: row.release_name,
      notes: row.release_notes,
      releaseUrl: row.release_url,
      artifactUrl: row.artifact_url,
      publishedAt: row.published_at,
      channel: row.channel,
      platform: row.platform,
    })),
  });
});

app.get('/api/v1/app/history', async (req, res) => {
  const licenseKey = req.header('x-license-key');
  const platform = req.query.platform || 'windows';
  const channel = req.query.channel || 'stable';
  const limit = Math.min(Number(req.query.limit || 8), 20);

  if (!licenseKey) {
    return res.status(403).json({ error: 'Missing license key.' });
  }

  const resolved = await resolveLicenseRecord(licenseKey);
  if (!resolved.ok) {
    return res.status(resolved.status).json({ error: resolved.message });
  }

  const rows = await pool.query(
    `SELECT version, release_name, release_notes, published_at, channel
     FROM releases
     WHERE platform = $1 AND channel = $2 AND rollout_state = 'live'
     ORDER BY published_at DESC, id DESC
     LIMIT $3`,
    [platform, channel, limit],
  );

  return res.json({
    releases: rows.rows.map((row) => ({
      version: row.version,
      notes: row.release_notes,
      publishedAt: row.published_at,
      channel: row.channel,
    })),
  });
});

app.get('/api/v1/app/download/:releaseId', async (req, res) => {
  try {
    const token = req.query.token;
    const payload = jwt.verify(String(token || ''), updateSecret);
    const releaseId = Number(req.params.releaseId);
    if (!payload || payload.releaseId !== releaseId) {
      return res.status(403).send('Invalid download token.');
    }

    const release = await pool.query('SELECT * FROM releases WHERE id = $1', [releaseId]);
    if (!release.rowCount) return res.status(404).send('Release not found.');

    await logUpdateEvent('update-download', {
      fingerprint: payload.fingerprint,
      platform: payload.platform,
      channel: payload.channel,
      allowed: true,
      detail: `Download ${release.rows[0].version}`,
    });
    // Set Content-Disposition so the client can parse the real filename
    // before following the redirect (path.basename of the token URL is just the release ID).
    const artifactFilename = decodeURIComponent(path.basename(release.rows[0].artifact_url));
    res.setHeader('Content-Disposition', `attachment; filename="${artifactFilename}"`);
    return res.redirect(release.rows[0].artifact_url);
  } catch {
    return res.status(403).send('Download token expired or invalid.');
  }
});

async function waitForDatabase(maxAttempts = 20, delayMs = 1500) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      if (attempt === maxAttempts) throw error;
      console.warn(`[update-admin] Database not ready yet (${attempt}/${maxAttempts}). Retrying...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function start() {
  await waitForDatabase();
  await ensureRuntimeSchema();
  await ensureAdminUser();
  app.listen(port, '0.0.0.0', () => {
    console.log(`[update-admin] Listening on 0.0.0.0:${port}`);
  });
}

start().catch((err) => {
  console.error('[update-admin] Failed to start:', err);
  process.exit(1);
});
