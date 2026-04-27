const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const nodemailer = require('nodemailer');
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
const defaultMaxDevices = Math.max(1, Number.parseInt(process.env.DEFAULT_MAX_DEVICES || '1', 10) || 1);

// --- Payment / trial config ---
// Stripe: STRIPE_SECRET_KEY (sk_live_... or sk_test_...) and STRIPE_WEBHOOK_SECRET.
// Pricing tiers are stored in DB and configurable from the admin /admin/pricing page.
// STRIPE_PUBLISHABLE_KEY is sent to the checkout page client-side.
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripePublishableKey = process.env.STRIPE_PUBLISHABLE_KEY || '';
const stripePaymentLink = process.env.STRIPE_PAYMENT_LINK || '';

// --- SMTP email config ---
// Uses nodemailer with any SMTP server (Gmail, Mailgun, etc.).
const smtpConfig = {
  host: process.env.MAIL_SERVER || '',
  port: Number.parseInt(process.env.MAIL_PORT || '587', 10),
  secure: process.env.MAIL_PORT === '465',
  auth: {
    user: process.env.MAIL_USERNAME || '',
    pass: process.env.MAIL_PASSWORD || '',
  },
};
const emailFromAddress = process.env.MAIL_FROM || process.env.MAIL_USERNAME || 'no-reply@culler.z2hs.au';

// --- Trial config ---
const trialDays = Math.max(1, Number.parseInt(process.env.TRIAL_DAYS || '14', 10) || 14);
const trialMaxDevices = Math.max(1, Number.parseInt(process.env.TRIAL_MAX_DEVICES || '1', 10) || 1);
const trialCooldownDays = Math.max(1, Number.parseInt(process.env.TRIAL_COOLDOWN_DAYS || '30', 10) || 30);

// CORS origins allowed to call public API endpoints from the Electron renderer
// and from the website (localhost:5173 for dev, culler.z2hs.au for prod).
const corsAllowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || 'https://culler.z2hs.au,http://culler.z2hs.au')
  .split(',').map((o) => o.trim()).filter(Boolean);

const CULLER_LOGO_SVG = '<svg viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M128 252C196.483 252 252 196.483 252 128C252 59.5167 196.483 4 128 4C59.5167 4 4 59.5167 4 128C4 196.483 59.5167 252 128 252ZM128 226.694C182.507 226.694 226.694 182.507 226.694 128C226.694 73.4929 182.507 29.3061 128 29.3061C73.4929 29.3061 29.3061 73.4929 29.3061 128C29.3061 182.507 73.4929 226.694 128 226.694ZM188.633 131.549C181.333 137.253 172.145 140.653 162.163 140.653C138.404 140.653 119.143 121.392 119.143 97.6327C119.143 85.8325 123.894 75.1419 131.587 67.3695C130.4 67.3004 129.204 67.2653 128 67.2653C94.4572 67.2653 67.2653 94.4572 67.2653 128C67.2653 161.543 94.4572 188.735 128 188.735C160.352 188.735 186.795 163.44 188.633 131.549ZM117.878 148.245C123.468 148.245 128 143.713 128 138.122C128 132.532 123.468 128 117.878 128C112.287 128 107.755 132.532 107.755 138.122C107.755 143.713 112.287 148.245 117.878 148.245ZM107.755 153.306C107.755 156.101 105.489 158.367 102.694 158.367C99.8986 158.367 97.6327 156.101 97.6327 153.306C97.6327 150.511 99.8986 148.245 102.694 148.245C105.489 148.245 107.755 150.511 107.755 153.306ZM177.347 97.6326C177.347 106.018 170.549 112.816 162.163 112.816C161.21 112.816 160.278 112.729 159.373 112.561C163.87 111.53 167.225 107.503 167.225 102.694C167.225 97.1034 162.693 92.5714 157.102 92.5714C152.292 92.5714 148.266 95.9258 147.235 100.423C147.067 99.5183 146.98 98.5857 146.98 97.6326C146.98 89.2469 153.778 82.449 162.163 82.449C170.549 82.449 177.347 89.2469 177.347 97.6326Z" fill="white"/></svg>';

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
// Skip global JSON parsing for the Stripe webhook — it needs the raw body for signature verification.
app.use((req, res, next) => {
  if (req.path === '/stripe/webhook') return next();
  express.json({ limit: '2mb' })(req, res, next);
});
app.use(cookieParser());

// CORS for public API endpoints called from the Electron renderer + website.
// Allows localhost:* in development; only listed origins in production.
function apiCors(req, res, next) {
  const origin = req.headers.origin || '';
  const isLocalhost = /^https?:\/\/localhost(:\d+)?$/.test(origin);
  const isAllowed = isLocalhost || corsAllowedOrigins.includes(origin);
  if (isAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
}

// Apply CORS to all public /api/v1/* routes
app.use('/api/v1', apiCors);
app.use('/stripe', apiCors);
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
    <a href="/admin" style="display:flex;align-items:center;gap:7px;padding:4px 10px 4px 6px;border-radius:8px;color:var(--text);font-size:.8125rem;font-weight:700;letter-spacing:-.01em"><span style="display:flex;align-items:center;width:18px;height:18px;flex-shrink:0">${CULLER_LOGO_SVG}</span> Culler</a>
    <div class="nav-sep"></div>
    ${link('/admin', 'Dashboard', 'dashboard')}
    ${link('/admin/licenses', 'Licenses', 'licenses')}
    ${link('/admin/pricing', 'Pricing', 'pricing')}
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

function inferPlanType(plan, expiresAt) {
  if (plan === 'trial') return 'Trial';
  if (plan === 'monthly') return 'Monthly';
  if (plan === 'yearly') return 'Yearly';
  if (plan === 'lifetime') return 'Lifetime';
  return expiresAt ? 'Timed' : 'Lifetime';
}

function formatMoneyFromCents(cents, currency = 'AUD') {
  const amount = Number(cents || 0) / 100;
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: String(currency || 'AUD').toUpperCase(),
    minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
  }).format(amount);
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
  await pool.query('ALTER TABLE license_records ADD COLUMN IF NOT EXISTS plan TEXT');
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

async function upsertLicenseRecord(validated, notes, plan = null) {
  await pool.query(
    `INSERT INTO license_records (fingerprint, license_key, customer_name, customer_email, issued_at, expires_at, plan, max_devices, status, notes, last_seen_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,NOW(),NOW())
     ON CONFLICT (fingerprint) DO UPDATE
     SET license_key = EXCLUDED.license_key,
         customer_name = EXCLUDED.customer_name,
         customer_email = EXCLUDED.customer_email,
         issued_at = EXCLUDED.issued_at,
         expires_at = EXCLUDED.expires_at,
         plan = COALESCE(EXCLUDED.plan, license_records.plan),
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
      plan || null,
      validated.entitlement.maxDevices || null,
      notes || validated.entitlement.notes || null,
    ],
  );
  return assignActivationCode(validated.fingerprint);
}

async function getLicenseRecordByActivationCode(activationCode) {
  const result = await pool.query(
    `SELECT lr.id,
            lr.fingerprint,
            lr.activation_code,
            lr.customer_name,
            lr.customer_email,
            COALESCE(NULLIF(lr.plan, ''), ss.plan) AS plan,
            lr.max_devices,
            lr.expires_at
     FROM license_records lr
     LEFT JOIN LATERAL (
       SELECT plan
       FROM stripe_sessions
       WHERE activation_code = lr.activation_code
         AND plan IS NOT NULL
         AND plan <> ''
       ORDER BY created_at DESC, id DESC
       LIMIT 1
     ) ss ON TRUE
     WHERE lr.activation_code = $1`,
    [activationCode],
  );

  const row = result.rows[0];
  if (row && row.plan) {
    await pool.query(
      `UPDATE license_records
       SET plan = $1, updated_at = NOW()
       WHERE id = $2 AND (plan IS NULL OR plan = '')`,
      [row.plan, row.id],
    );
  }

  return row || null;
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
    `INSERT INTO license_activations (license_fingerprint, device_id, device_name, expires_at, first_seen_at, last_seen_at, updated_at)
     VALUES ($1,$2,$3,(SELECT expires_at FROM license_records WHERE fingerprint = $1),NOW(),NOW(),NOW())
     ON CONFLICT (license_fingerprint, device_id) DO UPDATE
     SET device_name = EXCLUDED.device_name,
         expires_at = (SELECT expires_at FROM license_records WHERE fingerprint = $1),
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
      <div style="display:flex;align-items:center;gap:11px;margin-bottom:24px">
        <span style="display:flex;align-items:center;width:36px;height:36px;flex-shrink:0">${CULLER_LOGO_SVG}</span>
        <div>
          <div style="font-weight:700;font-size:1.1rem;letter-spacing:-.02em">Culler</div>
          <div style="font-size:.75rem;color:var(--muted)">Admin Panel</div>
        </div>
      </div>
      <h1 style="margin-bottom:6px">Sign in</h1>
      <p class="muted" style="margin-bottom:20px">Manage updates and licenses for culler.z2hs.au.</p>
      <form method="post" action="/admin/login">
        <label>Email</label>
        <input type="email" name="email" required autofocus />
        <div style="height:10px"></div>
        <label>Password</label>
        <input type="password" name="password" required />
        <div style="height:14px"></div>
        <button type="submit" style="width:100%">Sign in</button>
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
        <div style="display:flex;align-items:center;gap:11px;margin-bottom:24px">
          <span style="display:flex;align-items:center;width:36px;height:36px;flex-shrink:0">${CULLER_LOGO_SVG}</span>
          <div>
            <div style="font-weight:700;font-size:1.1rem;letter-spacing:-.02em">Culler</div>
            <div style="font-size:.75rem;color:var(--muted)">Admin Panel</div>
          </div>
        </div>
        <h1 style="margin-bottom:6px">Sign in</h1>
        <p class="bad" style="margin-bottom:16px">Invalid email or password.</p>
        <a href="/admin/login"><button type="button" style="width:100%">Try again</button></a>
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
  const [licenseStats, releaseStats, recentEvents, errorEvents, topLicenses, deviceCount, stripeStats, subStats] = await Promise.all([
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
    pool.query(`SELECT 
      COUNT(DISTINCT customer_email)::int AS total_customers,
      COUNT(*)::int AS total_licenses,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days')::int AS licenses_30d
    FROM stripe_sessions`).catch(() => ({ rows: [{ total_customers: 0, total_licenses: 0, licenses_30d: 0 }] })),
    pool.query(`SELECT 'monthly' as plan, COUNT(*)::int AS cnt FROM stripe_sessions WHERE created_at > NOW() - INTERVAL '90 days' AND session_id ILIKE '%monthly%'
      UNION ALL SELECT 'yearly', COUNT(*)::int FROM stripe_sessions WHERE created_at > NOW() - INTERVAL '90 days' AND session_id ILIKE '%yearly%'
      UNION ALL SELECT 'lifetime', COUNT(*)::int FROM stripe_sessions WHERE created_at > NOW() - INTERVAL '90 days' AND session_id ILIKE '%lifetime%'`).catch(() => ({ rows: [] })),
  ]);

  const artifactSize = getDirSize(artifactsRoot);
  const disk = getDiskStats(artifactsRoot);
  const diskPct = disk ? Math.round((disk.used / disk.total) * 100) : null;
  const diskBar = disk ? `<div style="margin-top:8px;background:var(--border2);border-radius:4px;height:6px;overflow:hidden"><div style="width:${diskPct}%;background:${diskPct > 85 ? '#f87171' : diskPct > 65 ? '#fdba74' : '#34d399'};height:100%;border-radius:4px"></div></div><p class="muted" style="margin-top:4px;font-size:.72rem">${formatBytes(disk.used)} used of ${formatBytes(disk.total)} (${disk.pct})</p>` : '';

  const stripeRow = stripeStats.rows[0] || { total_customers: 0, total_licenses: 0, licenses_30d: 0 };
  const plans = subStats.rows.reduce((acc, row) => { acc[row.plan] = row.cnt; return acc; }, { monthly: 0, yearly: 0, lifetime: 0 });

  res.send(htmlPage('Admin Dashboard', `
    <div class="hero">
      <div class="hero-copy">
        <div class="hero-kicker">Dashboard</div>
        <h1>Update Admin</h1>
        <p>Manage licenses, releases, and update delivery for culler.z2hs.au.</p>
      </div>
      ${nav('dashboard')}
    </div>
    <div class="cards">
      ${licenseStats.rows.map((row) => `<div class="card"><div class="card-label">Licenses · ${row.status}</div><div class="card-value">${row.count}</div></div>`).join('')}
      ${releaseStats.rows.map((row) => `<div class="card"><div class="card-label">Releases · ${row.platform} / ${row.rollout_state}</div><div class="card-value">${row.count}</div></div>`).join('')}
      <div class="card"><div class="card-label">Total devices</div><div class="card-value">${deviceCount.rows[0].count}</div></div>
    </div>
    
    <div class="cards">
      <div class="card"><div class="card-label">💳 Stripe customers</div><div class="card-value">${stripeRow.total_customers}</div></div>
      <div class="card"><div class="card-label">📦 Licenses sold</div><div class="card-value">${stripeRow.total_licenses}</div></div>
      <div class="card"><div class="card-label">📈 Last 30 days</div><div class="card-value">${stripeRow.licenses_30d}</div></div>
      <div class="card"><div class="card-label">🎯 Plans (90d)</div><div class="card-value" style="font-size:0.8rem;line-height:1.8">
        <span style="color:#34d399">●</span> Monthly: ${plans.monthly}<br/>
        <span style="color:#60a5fa">●</span> Yearly: ${plans.yearly}<br/>
        <span style="color:#f59e0b">●</span> Lifetime: ${plans.lifetime}
      </div></div>
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
  const [licenseResult, stripeLicensesResult] = await Promise.all([
    pool.query('SELECT * FROM license_records ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT 100'),
    pool.query('SELECT session_id, license_key, activation_code, customer_email, created_at FROM stripe_sessions ORDER BY created_at DESC LIMIT 50').catch(() => ({ rows: [] })),
  ]);
  
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
          <input type="number" name="maxDevices" min="1" step="1" value="${defaultMaxDevices}" />
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
    
    ${stripeLicensesResult.rows.length > 0 ? `<div class="panel">
      <h2>Stripe licenses (recent payments)</h2>
      <table><thead><tr><th>Customer email</th><th>Activation code</th><th>License key</th><th>Issued</th></tr></thead><tbody>
      ${stripeLicensesResult.rows.map((row) => `<tr>
        <td class="muted">${row.customer_email}</td>
        <td><code style="font-size:0.75rem">${row.activation_code}</code></td>
        <td><code style="font-size:0.65rem;word-break:break-all">${row.license_key.substring(0, 40)}...</code></td>
        <td class="muted">${fmtTime(row.created_at)}</td>
      </tr>`).join('')}
      </tbody></table>
    </div>` : ''}
    
    <div class="panel">
      <h2>All licenses</h2>
      <table><thead><tr><th>Customer</th><th>Status</th><th>Seats</th><th>Activation code</th><th>Expires</th><th>Last seen</th><th>Actions</th></tr></thead><tbody>
      ${licenseResult.rows.map((row) => `<tr>
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
      <div class="hero">
        <div class="hero-copy">
          <div class="hero-kicker">Success</div>
          <h1>License generated</h1>
          <p>Store this key somewhere safe before leaving the page.</p>
        </div>
        ${nav('licenses')}
      </div>
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
  const rawRecord = result.rows[0];
  const managedRecord = rawRecord.activation_code
    ? await getLicenseRecordByActivationCode(rawRecord.activation_code)
    : null;
  const record = managedRecord ? { ...rawRecord, ...managedRecord } : rawRecord;
  const activations = await pool.query(
    `SELECT id, device_id, device_name, first_seen_at, last_seen_at, expires_at
     FROM license_activations
     WHERE license_fingerprint = $1
     ORDER BY last_seen_at DESC, id DESC`,
    [record.fingerprint],
  );
  return res.send(htmlPage(`License ${record.customer_name}`, `
    <div class="hero">
      <div class="hero-copy">
        <div class="hero-kicker">License</div>
        <h1>${record.customer_name}</h1>
        <p>License details and device activation info.</p>
      </div>
      ${nav('licenses')}
    </div>
    <div class="grid">
      <div class="panel">
        <h2>Details</h2>
        <p style="margin-bottom:12px">${statusPill(record.status)}</p>
        <p class="muted">Activation code: <code>${record.activation_code || '—'}</code></p>
        ${record.customer_email ? `<p class="muted">Email: ${record.customer_email}</p>` : ''}
        <p class="muted">Plan: ${inferPlanType(record.plan, record.expires_at)}</p>
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
        <h2>Extend license</h2>
        <p class="muted" style="margin-bottom:12px">Adds time to the current expiry (or from today if perpetual). Regenerates the key and emails the customer.</p>
        <form method="post" action="/admin/licenses/${record.id}/extend">
          <div style="display:flex;gap:8px;align-items:flex-end">
            <div style="flex:1">
              <label>Amount</label>
              <input type="number" name="amount" min="1" step="1" value="1" />
            </div>
            <div style="flex:1">
              <label>Unit</label>
              <select name="unit">
                <option value="months">Months</option>
                <option value="years">Years</option>
                <option value="days">Days</option>
              </select>
            </div>
          </div>
          <div style="height:12px"></div>
          <button type="submit">Extend &amp; email customer</button>
        </form>
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
    <div class="hero">
      <div class="hero-copy">
        <div class="hero-kicker">Edit Release</div>
        <h1>${row.release_name}</h1>
        <p>${row.version} &middot; ${row.platform} &middot; ${row.channel}</p>
      </div>
      ${nav('releases')}
    </div>
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
    <div class="hero">
      <div class="hero-copy">
        <div class="hero-kicker">Installs</div>
        <h1>Customers / Installs</h1>
        <p>Latest seen update activity per install fingerprint.</p>
      </div>
      ${nav('customers')}
    </div>
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

// ---------------------------------------------------------------------------
// Email helper — nodemailer SMTP
// ---------------------------------------------------------------------------
let _mailerTransport = null;
function getMailer() {
  if (!smtpConfig.host || !smtpConfig.auth.user) return null;
  if (!_mailerTransport) {
    _mailerTransport = nodemailer.createTransport(smtpConfig);
  }
  return _mailerTransport;
}

async function sendEmail({ to, subject, html }) {
  const mailer = getMailer();
  if (!mailer) {
    console.warn('[email] SMTP not configured (MAIL_SERVER / MAIL_USERNAME missing) — skipping email to', to);
    return;
  }
  try {
    const info = await mailer.sendMail({ from: emailFromAddress, to, subject, html });
    console.log('[email] sent to', to, '—', info.messageId);
  } catch (err) {
    console.error('[email] failed to send to', to, err);
    throw err;
  }
}

function licenseEmailHtml({ customerName, licenseKey, activationCode, expiresLabel }) {
  const expiry = expiresLabel ? `<p>This license expires on <strong>${expiresLabel}</strong>.</p>` : '';
  return `
    <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a">
      <h2 style="margin-bottom:4px">Your Culler license</h2>
      <p>Hi ${customerName},</p>
      <p>Thanks for trying Culler. Here are your license details:</p>
      ${expiry}
      <p><strong>Activation code</strong> (easiest — paste this into Culler → Settings → License):</p>
      <pre style="background:#f4f4f5;padding:12px 16px;border-radius:8px;font-size:15px;letter-spacing:.05em">${activationCode}</pre>
      <p style="margin-top:24px"><strong>Full license key</strong> (alternative, for offline use):</p>
      <pre style="background:#f4f4f5;padding:12px 16px;border-radius:8px;font-size:11px;word-break:break-all;white-space:pre-wrap">${licenseKey}</pre>
      <p style="color:#6b7280;font-size:13px;margin-top:32px">Questions? Reply to this email.</p>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Stripe helper — verify webhook signature without the stripe npm package
// ---------------------------------------------------------------------------
function verifyStripeSignature(rawBody, sigHeader, secret) {
  // Stripe-Signature: t=timestamp,v1=hmac,...
  const parts = Object.fromEntries(
    sigHeader.split(',').map((p) => p.split('=')),
  );
  const timestamp = parts.t;
  const signatures = sigHeader.split(',')
    .filter((p) => p.startsWith('v1='))
    .map((p) => p.slice(3));
  if (!timestamp || !signatures.length) return false;
  const payload = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  // Timing-safe compare against each signature
  return signatures.some((sig) => {
    try {
      return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
    } catch { return false; }
  });
}

// ---------------------------------------------------------------------------
// Trial: add cooldown column if not present
// ---------------------------------------------------------------------------
async function ensureTrialSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trial_requests (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      license_fingerprint TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_trial_requests_email ON trial_requests(email, created_at DESC)');
}

async function ensureStripeSessionsSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stripe_sessions (
      session_id TEXT PRIMARY KEY,
      license_key TEXT NOT NULL,
      activation_code TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      plan TEXT,
      max_devices INTEGER,
      expires_at DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_stripe_sessions_email ON stripe_sessions(customer_email)');
  
  // Add new columns if they don't exist (migration for existing tables)
  try {
    await pool.query('ALTER TABLE stripe_sessions ADD COLUMN plan TEXT');
  } catch (err) {
    if (!err.message.includes('already exists')) throw err;
  }
  try {
    await pool.query('ALTER TABLE stripe_sessions ADD COLUMN max_devices INTEGER');
  } catch (err) {
    if (!err.message.includes('already exists')) throw err;
  }
  try {
    await pool.query('ALTER TABLE stripe_sessions ADD COLUMN expires_at DATE');
  } catch (err) {
    if (!err.message.includes('already exists')) throw err;
  }
}

// ---------------------------------------------------------------------------
// Shared: generate a license and return { licenseKey, activationCode, expiresLabel }
// ---------------------------------------------------------------------------
async function generateAndStoreLicense({ name, email, expiry, notes, maxDevices, plan }) {
  const licenseKey = createLicenseKey({ name, email, expiry, notes, maxDevices });
  const validated = validateLicenseKey(licenseKey, licensePublicKeyPem);
  if (!validated.valid) throw new Error(validated.message || 'Generated key did not validate.');
  const activationCode = await upsertLicenseRecord(validated, notes, plan);
  const expiresLabel = expiry ? expiry.split('-').reverse().join('/') : null; // DD-MM-YYYY → DD/MM/YYYY
  return { licenseKey, activationCode, expiresLabel };
}

function calculatePlanExpiryDate(plan, now = new Date()) {
  if (plan === 'monthly') {
    return new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());
  }
  if (plan === 'yearly') {
    return new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());
  }
  return null;
}

function formatExpiryForLicense(expiryDate) {
  return expiryDate ? expiryDate.toISOString().split('T')[0].split('-').reverse().join('-') : undefined;
}

function formatExpiryLabel(expiryDate) {
  return expiryDate ? expiryDate.toISOString().split('T')[0].split('-').reverse().join('/') : null;
}

// ---------------------------------------------------------------------------
// Trial endpoint  POST /api/v1/trial/request
// Body: { name, email }
// ---------------------------------------------------------------------------
app.post('/api/v1/trial/request', async (req, res) => {
  const { name, email } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required.' });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }
  const cleanEmail = email.trim().toLowerCase();
  const cleanName = name.trim();

  try {
    // Cooldown check — one trial per email per trialCooldownDays
    const cooldown = await pool.query(
      `SELECT id FROM trial_requests WHERE lower(email) = $1 AND created_at > NOW() - ($2 || ' days')::interval LIMIT 1`,
      [cleanEmail, trialCooldownDays],
    );
    if (cooldown.rowCount > 0) {
      return res.status(429).json({ error: `A trial was already issued to this address recently. Please wait ${trialCooldownDays} days before requesting another.` });
    }

    // Compute expiry date DD-MM-YYYY
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + trialDays);
    const dd = String(expiryDate.getDate()).padStart(2, '0');
    const mm = String(expiryDate.getMonth() + 1).padStart(2, '0');
    const yyyy = expiryDate.getFullYear();
    const expiry = `${dd}-${mm}-${yyyy}`;

    const { licenseKey, activationCode, expiresLabel } = await generateAndStoreLicense({
      name: cleanName,
      email: cleanEmail,
      expiry,
      notes: `Trial (${trialDays} days)`,
      maxDevices: trialMaxDevices,
      plan: 'trial',
    });

    // Record trial so we can enforce cooldown
    await pool.query(
      `INSERT INTO trial_requests (email, license_fingerprint) VALUES ($1, (SELECT fingerprint FROM license_records WHERE activation_code = $2))`,
      [cleanEmail, activationCode],
    );

    // Send email
    await sendEmail({
      to: cleanEmail,
      subject: `Your Culler ${trialDays}-day trial license`,
      html: licenseEmailHtml({ customerName: cleanName, licenseKey, activationCode, expiresLabel }),
    });

    return res.json({ ok: true, activationCode, expiresLabel });
  } catch (err) {
    console.error('[trial] error:', err);
    return res.status(500).json({ error: 'Could not issue trial license. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Stripe webhook diagnostic endpoint (for debugging)  GET /stripe/webhook/status
// ---------------------------------------------------------------------------
app.get('/stripe/webhook/status', authSession, async (_req, res) => {
  const config = await pool.query('SELECT key, value FROM pricing_config WHERE key LIKE \'stripe_%\'');
  const stripeConfig = {};
  for (const row of config.rows) {
    stripeConfig[row.key] = row.value ? `${row.value.substring(0, 10)}...` : '(not set)';
  }
  
  const sessionsCount = await pool.query('SELECT COUNT(*)::int AS cnt FROM stripe_sessions');
  const recentSessions = await pool.query(`
    SELECT session_id, license_key, customer_email, created_at FROM stripe_sessions 
    ORDER BY created_at DESC LIMIT 5
  `);
  
  return res.json({
    timestamp: new Date().toISOString(),
    stripeConfig,
    sessionsCount: sessionsCount.rows[0].cnt,
    recentSessions: recentSessions.rows.map(r => ({
      sessionId: r.session_id.substring(0, 30) + '...',
      email: r.customer_email,
      hasLicense: !!r.license_key,
      createdAt: r.created_at,
    })),
    webhookUrl: `${publicUpdatesBaseUrl()}/stripe/webhook`,
    diagnosticUrl: `${publicUpdatesBaseUrl()}/stripe/webhook/test?session_id=test_abc123&email=test@example.com`,
    notes: 'Make sure this webhook URL is registered in your Stripe dashboard under Developers → Webhooks. Subscribe to checkout.session.completed event.',
  });
});

// Manual test endpoint to simulate a webhook (for debugging)
app.post('/stripe/webhook/test', authSession, async (req, res) => {
  const { session_id, email, name } = req.query;
  
  if (!session_id || !email) {
    return res.status(400).json({ error: 'Requires: session_id and email query params' });
  }

  console.log(`[stripe-test] Manual webhook test: session=${session_id}, email=${email}`);

  try {
    const { licenseKey, activationCode } = await generateAndStoreLicense({
      name: name || 'Test User',
      email: email,
      expiry: undefined,
      notes: `Stripe test ${session_id}`,
      maxDevices: defaultMaxDevices,
      plan: 'lifetime',
    });

    console.log(`[stripe-test] ✓ License generated — activation: ${activationCode.substring(0, 20)}...`);

    await pool.query(
      'INSERT INTO stripe_sessions (session_id, license_key, activation_code, customer_email) VALUES ($1, $2, $3, $4) ON CONFLICT (session_id) DO UPDATE SET license_key=$2, activation_code=$3',
      [session_id, licenseKey, activationCode, email]
    );

    console.log(`[stripe-test] ✓ Session stored — session: ${session_id}`);

    return res.json({ 
      ok: true, 
      sessionId: session_id,
      licenseKey: licenseKey.substring(0, 50) + '...',
      activationCode,
      message: 'Test license created successfully'
    });
  } catch (err) {
    console.error('[stripe-test] Error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Stripe webhook  POST /stripe/webhook
// Must be registered as a raw-body route (before express.json parses it).
// In your Stripe dashboard point the webhook at: https://updates.culler.z2hs.au/stripe/webhook
// Events to listen for: checkout.session.completed
// ---------------------------------------------------------------------------
app.post(
  '/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!stripeWebhookSecret) {
      console.warn('[stripe] STRIPE_WEBHOOK_SECRET not set — accepting webhook without verification (dev only)');
    } else {
      const sig = req.headers['stripe-signature'];
      if (!sig || !verifyStripeSignature(req.body.toString('utf8'), sig, stripeWebhookSecret)) {
        console.error('[stripe-webhook] Invalid signature');
        return res.status(400).json({ error: 'Invalid Stripe signature.' });
      }
    }

    let event;
    try {
      event = JSON.parse(req.body.toString('utf8'));
    } catch {
      console.error('[stripe-webhook] Invalid JSON');
      return res.status(400).json({ error: 'Invalid JSON.' });
    }

    console.log(`[stripe-webhook] Received event: ${event.type}`);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const sessionId = session.id;
      const customerEmail = session.customer_details?.email || session.customer_email || '';
      const customerName = session.customer_details?.name || 'Culler Customer';
      const amountTotal = session.amount_total; // cents
      const currency = (session.currency || 'aud').toUpperCase();
      const plan = session.metadata?.plan || 'lifetime';
      const expiryDate = calculatePlanExpiryDate(plan);
      const expiryString = formatExpiryForLicense(expiryDate);
      const expiresLabel = formatExpiryLabel(expiryDate);

      console.log(`[stripe] checkout.session.completed — session: ${sessionId} — email: ${customerEmail} — amount: ${amountTotal / 100} ${currency}`);

      try {
        const { licenseKey, activationCode } = await generateAndStoreLicense({
          name: customerName,
          email: customerEmail,
          expiry: expiryString,
          notes: `Stripe ${plan} purchase ${sessionId} (${amountTotal / 100} ${currency})`,
          maxDevices: defaultMaxDevices,
          plan,
        });

        console.log(`[stripe] ✓ License generated — activation: ${activationCode.substring(0, 20)}...`);

        // Store session-to-license mapping for success page retrieval
        try {
          await pool.query(
            'INSERT INTO stripe_sessions (session_id, license_key, activation_code, customer_email, plan, max_devices, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (session_id) DO UPDATE SET license_key=$2, activation_code=$3, customer_email=$4, plan=$5, max_devices=$6, expires_at=$7',
            [sessionId, licenseKey, activationCode, customerEmail, plan, defaultMaxDevices, expiryDate]
          );
          console.log(`[stripe] ✓ Session stored in stripe_sessions — session: ${sessionId}`);
        } catch (dbErr) {
          console.error('[stripe] ✗ Failed to store session in stripe_sessions:', dbErr.message, dbErr.detail);
          throw dbErr;
        }

        await sendEmail({
          to: customerEmail,
          subject: 'Your Culler license — thank you!',
          html: licenseEmailHtml({ customerName, licenseKey, activationCode, expiresLabel }),
        });

        console.log(`[stripe] ✓ License email sent to ${customerEmail}`);
      } catch (err) {
        console.error('[stripe] ✗ Failed to generate license after payment:');
        console.error(err);
        // Return 200 so Stripe doesn't retry — but log for manual follow-up
      }
    } else if (event.type === 'payment_intent.succeeded') {
      // Handle payment_intent.succeeded (alternative to checkout.session.completed)
      const paymentIntent = event.data.object;
      const sessionId = paymentIntent.payment_details?.order_reference; // Session ID stored in order_reference
      const amountTotal = paymentIntent.amount; // cents
      const currency = (paymentIntent.currency || 'aud').toUpperCase();

      console.log(`[stripe] payment_intent.succeeded — session: ${sessionId} — amount: ${amountTotal / 100} ${currency}`);

      if (!sessionId) {
        console.warn('[stripe] payment_intent.succeeded has no order_reference (session ID) — skipping license generation');
        return res.json({ received: true });
      }

      // Fetch checkout session from Stripe to get customer details
      let checkoutSession;
      try {
        console.log(`[stripe] Fetching checkout session details from Stripe: ${sessionId}`);
        const stripeRes = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
          method: 'GET',
          headers: {
            'Authorization': `Basic ${Buffer.from(stripeSecretKey + ':').toString('base64')}`,
          },
        });
        checkoutSession = await stripeRes.json();
        if (!stripeRes.ok) {
          throw new Error(`Stripe API error: ${checkoutSession.error?.message || 'Unknown error'}`);
        }
        console.log(`[stripe] ✓ Retrieved checkout session`);
      } catch (err) {
        console.error('[stripe] ✗ Failed to fetch checkout session from Stripe:', err.message);
        console.error('[stripe] Proceeding with payment_intent metadata only');
        checkoutSession = null;
      }

      let customerEmail = checkoutSession?.customer_details?.email || paymentIntent.receipt_email || '';
      let customerName = checkoutSession?.customer_details?.name || paymentIntent.metadata?.customer_name || 'Culler Customer';
      const plan = checkoutSession?.metadata?.plan || paymentIntent.metadata?.plan || 'lifetime';

      if (!customerEmail) {
        console.warn('[stripe] Could not determine customer email from checkout session or payment_intent — skipping');
        return res.json({ received: true });
      }

      // Calculate expiry date based on plan
      let expiryDate = null;
      const maxDevices = defaultMaxDevices;
      expiryDate = calculatePlanExpiryDate(plan);

      if (expiryDate) {
        console.log(`[stripe] ${plan} plan — expires: ${expiryDate.toISOString().split('T')[0]}`);
      } else {
        // Lifetime — no expiry
        console.log(`[stripe] Lifetime plan — no expiration`);
      }

      try {
        console.log(`[stripe] Generating license for: ${customerName} (${customerEmail})`);
        const expiryString = formatExpiryForLicense(expiryDate);
        const expiresLabel = formatExpiryLabel(expiryDate);
        const { licenseKey, activationCode } = await generateAndStoreLicense({
          name: customerName,
          email: customerEmail,
          expiry: expiryString, // DD-MM-YYYY format or undefined for lifetime
          notes: `Stripe ${plan} purchase ${sessionId} (${amountTotal / 100} ${currency})`,
          maxDevices,
          plan,
        });


        console.log(`[stripe] ✓ License generated — activation: ${activationCode.substring(0, 20)}...`);
        console.log(`[stripe] Storing session in stripe_sessions: session=${sessionId}, email=${customerEmail}, plan=${plan}, expires=${expiryDate?.toISOString().split('T')[0] || 'never'}`);

        // Store session-to-license mapping for success page retrieval
        try {
          const insertResult = await pool.query(
            'INSERT INTO stripe_sessions (session_id, license_key, activation_code, customer_email, plan, max_devices, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (session_id) DO UPDATE SET license_key=$2, activation_code=$3, plan=$5, max_devices=$6, expires_at=$7',
            [sessionId, licenseKey, activationCode, customerEmail, plan, maxDevices, expiryDate]
          );
          console.log(`[stripe] ✓ Session stored in stripe_sessions — session: ${sessionId}`);
        } catch (dbErr) {
          console.error('[stripe] ✗ Database error storing session:');
          console.error('  Error:', dbErr.message);
          console.error('  Detail:', dbErr.detail);
          console.error('  Code:', dbErr.code);
          throw dbErr;
        }

        console.log(`[stripe] Sending email to ${customerEmail}`);
        await sendEmail({
          to: customerEmail,
          subject: 'Your Culler license — thank you!',
          html: licenseEmailHtml({ customerName, licenseKey, activationCode, expiresLabel }),
        });

        console.log(`[stripe] ✓ License email sent to ${customerEmail}`);
      } catch (err) {
        console.error('[stripe] ✗ Failed to generate license after payment_intent.succeeded:');
        console.error('  Error type:', err.constructor.name);
        console.error('  Message:', err.message);
        console.error('  Stack:', err.stack);
      }
    } else if (event.type === 'charge.succeeded' && event.data.object.metadata?.activation_code) {
      // Handle device upgrade payment (charge.succeeded for device upgrades)
      const charge = event.data.object;
      const activationCode = charge.metadata?.activation_code;
      const newDeviceCount = Number(charge.metadata?.new_device_count);
      const licenseId = Number(charge.metadata?.license_id);
      
      if (!activationCode || !newDeviceCount) {
        console.log('[stripe] charge.succeeded without device upgrade metadata — skipping');
        return res.json({ received: true });
      }
      
      console.log(`[stripe] charge.succeeded — device upgrade: ${activationCode} → ${newDeviceCount} devices`);
      
      try {
        // Update license max_devices
        const updateResult = await pool.query(
          'UPDATE license_records SET max_devices = $1, updated_at = NOW() WHERE activation_code = $2 RETURNING id, customer_email, customer_name',
          [newDeviceCount, activationCode]
        );
        
        if (!updateResult.rowCount) {
          console.error('[stripe] ✗ License not found for upgrade:', activationCode);
          return res.json({ received: true });
        }
        
        const license = updateResult.rows[0];
        console.log(`[stripe] ✓ License updated to ${newDeviceCount} devices`);
        
        // Send confirmation email
        await sendEmail({
          to: license.customer_email,
          subject: 'Culler license device upgrade — done!',
          html: `
            <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a">
              <h2>Device upgrade successful</h2>
              <p>Hi ${license.customer_name},</p>
              <p>Your Culler license has been upgraded to <strong>${newDeviceCount} devices</strong>.</p>
              <p>Simply restart Culler on your devices and they will all work with this license.</p>
              <p style="margin-top:24px;font-size:14px;color:#666"><strong>Activation code:</strong> ${activationCode}</p>
            </div>
          `,
        });
        
        console.log(`[stripe] ✓ Upgrade confirmation email sent to ${license.customer_email}`);
      } catch (err) {
        console.error('[stripe] ✗ Failed to process device upgrade:');
        console.error('  Error:', err.message);
        console.error('  Stack:', err.stack);
      }
    } else if (event.type === 'charge.succeeded' && event.data.object.metadata?.extend_unit) {
      // Handle license extension payment
      const charge = event.data.object;
      const activationCode = charge.metadata?.activation_code;
      const extendAmount = Number(charge.metadata?.extend_amount);
      const extendUnit = charge.metadata?.extend_unit;
      
      if (!activationCode || !extendAmount || !extendUnit) {
        console.log('[stripe] charge.succeeded without extension metadata — skipping');
        return res.json({ received: true });
      }
      
      console.log(`[stripe] charge.succeeded — license extension: ${activationCode} +${extendAmount} ${extendUnit}`);
      
      try {
        // Get current license to calculate new expiry
        const licenseResult = await pool.query(
          'SELECT id, customer_email, customer_name, expires_at FROM license_records WHERE activation_code = $1',
          [activationCode]
        );
        
        if (!licenseResult.rowCount) {
          console.error('[stripe] ✗ License not found for extension:', activationCode);
          return res.json({ received: true });
        }
        
        const license = licenseResult.rows[0];
        
        // Calculate new expiry date
        const currentExpiry = license.expires_at ? new Date(license.expires_at) : new Date();
        const newExpiry = new Date(currentExpiry);
        
        if (extendUnit === 'days') newExpiry.setDate(newExpiry.getDate() + extendAmount);
        else if (extendUnit === 'months') newExpiry.setMonth(newExpiry.getMonth() + extendAmount);
        else if (extendUnit === 'years') newExpiry.setFullYear(newExpiry.getFullYear() + extendAmount);
        
        // Update license
        await pool.query(
          'UPDATE license_records SET expires_at = $1, updated_at = NOW() WHERE activation_code = $2',
          [newExpiry, activationCode]
        );
        await pool.query(
          `UPDATE license_activations
           SET expires_at = $1, updated_at = NOW()
           WHERE license_fingerprint = (
             SELECT fingerprint FROM license_records WHERE activation_code = $2
           )`,
          [newExpiry, activationCode]
        );
        
        console.log(`[stripe] ✓ License extended to ${newExpiry.toISOString()}`);
        
        // Send confirmation email
        await sendEmail({
          to: license.customer_email,
          subject: 'Culler license extended!',
          html: `
            <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a">
              <h2>License extended</h2>
              <p>Hi ${license.customer_name},</p>
              <p>Your Culler license has been extended by <strong>${extendAmount} ${extendUnit}</strong>.</p>
              <p>New expiry date: <strong>${newExpiry.toLocaleDateString('en-AU', {year: 'numeric', month: 'short', day: 'numeric'})}</strong></p>
              <p style="margin-top:24px;font-size:14px;color:#666"><strong>Activation code:</strong> ${activationCode}</p>
            </div>
          `,
        });
        
        console.log(`[stripe] ✓ Extension confirmation email sent to ${license.customer_email}`);
      } catch (err) {
        console.error('[stripe] ✗ Failed to process extension:');
        console.error('  Error:', err.message);
        console.error('  Stack:', err.stack);
      }
    }

    return res.json({ received: true });
  },
);



// ---------------------------------------------------------------------------
// Stripe checkout session  POST /api/v1/checkout/create
// Body: { plan: 'monthly'|'yearly'|'lifetime', name, email, extensionCode? }
// Creates a Stripe Checkout Session and returns { url }.
// extensionCode: if provided, extend that activation code after payment.
// ---------------------------------------------------------------------------
async function getStripePricing() {
  const result = await pool.query('SELECT key, value FROM pricing_config');
  const cfg = {};
  for (const row of result.rows) cfg[row.key] = row.value;
  return cfg;
}

// Public pricing endpoint — website fetches this to show live plan prices
app.get('/api/v1/pricing', apiCors, async (_req, res) => {
  try {
    const cfg = await getStripePricing();
    const fmt = (cents) => Number(cents || 0) / 100;
    return res.json({
      currency: (cfg.currency || 'aud').toUpperCase(),
      plans: {
        monthly:  { price: fmt(cfg.price_monthly_cents),  label: 'Monthly',  period: '/mo' },
        yearly:   { price: fmt(cfg.price_yearly_cents),   label: 'Yearly',   period: '/yr' },
        lifetime: { price: fmt(cfg.price_lifetime_cents), label: 'Lifetime', period: '' },
      },
      deviceUpgradePrice: Number(cfg.device_upgrade_price_cents || 0),
      extensionPrices: {
        days: Number(cfg.extend_day_price_cents || 0),
        months: Number(cfg.extend_month_price_cents || 0),
        years: Number(cfg.extend_year_price_cents || 0),
      },
      trial_days: Number(cfg.trial_days || 14),
    });
  } catch (err) {
    console.error('[pricing]', err);
    return res.status(500).json({ error: 'Could not load pricing.' });
  }
});

app.post('/api/v1/checkout/create', async (req, res) => {
  if (!stripeSecretKey) return res.status(503).json({ error: 'Payments not configured.' });
  const { plan, name, email, extensionCode } = req.body || {};
  if (!['monthly', 'yearly', 'lifetime'].includes(plan)) {
    return res.status(400).json({ error: 'plan must be monthly, yearly, or lifetime.' });
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return res.status(400).json({ error: 'Valid email required.' });
  }

  const pricing = await getStripePricing();
  const priceId = pricing[`stripe_price_${plan}`];
  const amountCents = Number(pricing[`price_${plan}_cents`] || 0);
  const currency = pricing['currency'] || 'aud';

  if (!priceId && !amountCents) {
    return res.status(503).json({ error: `No price configured for plan: ${plan}` });
  }

  try {
    const origin = req.headers.origin || publicUpdatesBaseUrl();
    const successUrl = `${origin}/checkout-success?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${origin}/`;

    // Build Stripe Checkout Session via API
    const stripeBody = new URLSearchParams({
      'payment_method_types[]': 'card',
      'customer_email': email.trim(),
      'success_url': successUrl,
      'cancel_url': cancelUrl,
      'metadata[plan]': plan,
      'metadata[customer_name]': (name || '').trim(),
      'metadata[customer_email]': email.trim(),
      'metadata[extension_code]': extensionCode || '',
    });

    if (priceId) {
      // Use pre-configured Stripe Price ID (supports subscriptions too)
      const mode = plan === 'lifetime' ? 'payment' : 'subscription';
      stripeBody.set('mode', mode);
      stripeBody.set('line_items[0][price]', priceId);
      stripeBody.set('line_items[0][quantity]', '1');
    } else {
      // Fallback: ad-hoc one-time price
      stripeBody.set('mode', 'payment');
      stripeBody.set('line_items[0][price_data][currency]', currency);
      stripeBody.set('line_items[0][price_data][unit_amount]', String(amountCents));
      stripeBody.set('line_items[0][price_data][product_data][name]', `Culler Pro — ${plan}`);
      stripeBody.set('line_items[0][quantity]', '1');
    }

    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(stripeSecretKey + ':').toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: stripeBody.toString(),
    });
    const session = await stripeRes.json();
    if (!stripeRes.ok) return res.status(400).json({ error: session.error?.message || 'Stripe error.' });
    return res.json({ url: session.url });
  } catch (err) {
    console.error('[checkout] error:', err);
    return res.status(500).json({ error: 'Could not create checkout session.' });
  }
});

// ---------------------------------------------------------------------------
// Pricing schema + admin page
// ---------------------------------------------------------------------------
async function ensurePricingSchema() {
  // Use an advisory lock so concurrent restarts don't race on CREATE TABLE.
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(8675309)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS pricing_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Seed defaults if empty
    const defaults = [
      ['price_monthly_cents', '900'],
      ['price_yearly_cents', '4900'],
      ['price_lifetime_cents', '4900'],
      ['extend_day_price_cents', '100'],
      ['extend_month_price_cents', '900'],
      ['extend_year_price_cents', '4900'],
      ['stripe_price_monthly', ''],
      ['stripe_price_yearly', ''],
      ['stripe_price_lifetime', ''],
      ['currency', 'aud'],
      ['trial_days', '14'],
    ];
    for (const [key, value] of defaults) {
      await client.query(
        `INSERT INTO pricing_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
        [key, value],
      );
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(8675309)');
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Device upgrade checkout  POST /api/v1/upgrade-devices
// Body: { activationCode, newDeviceCount }
// Creates a Stripe Checkout Session for device upgrade
// ---------------------------------------------------------------------------
app.post('/api/v1/upgrade-devices', async (req, res) => {
  if (!stripeSecretKey) return res.status(503).json({ error: 'Payments not configured.' });
  
  const { activationCode, newDeviceCount } = req.body || {};
  const count = Number(newDeviceCount);
  
  if (!activationCode) return res.status(400).json({ error: 'activationCode required.' });
  if (!Number.isInteger(count) || count < 2 || count > 100) {
    return res.status(400).json({ error: 'newDeviceCount must be integer between 2 and 100.' });
  }

  try {
    // Look up license by activation code
    const licenseResult = await pool.query(
      'SELECT id, fingerprint, customer_email, customer_name, max_devices FROM license_records WHERE activation_code = $1',
      [activationCode]
    );
    
    if (!licenseResult.rowCount) {
      return res.status(404).json({ error: 'License not found.' });
    }
    
    const license = licenseResult.rows[0];
    const currentDevices = license.max_devices || 1;
    
    if (count <= currentDevices) {
      return res.status(400).json({ error: `New device count (${count}) must be higher than current (${currentDevices}).` });
    }
    
    const devicesToAdd = count - currentDevices;
    const pricing = await getStripePricing();
    const pricePerDevice = Number(pricing.device_upgrade_price_cents || 0);
    const currency = pricing.currency || 'aud';
    
    if (pricePerDevice === 0) {
      return res.status(503).json({ error: 'Device upgrade pricing not configured.' });
    }
    
    const totalCents = pricePerDevice * devicesToAdd;
    
    const origin = req.headers.origin || publicUpdatesBaseUrl();
    const successUrl = `${origin}/upgrade-success?activation_code=${encodeURIComponent(activationCode)}&new_devices=${count}`;
    const cancelUrl = `${origin}/`;

    // Build Stripe Checkout Session
    const stripeBody = new URLSearchParams({
      'payment_method_types[]': 'card',
      'customer_email': license.customer_email,
      'success_url': successUrl,
      'cancel_url': cancelUrl,
      'mode': 'payment',
      'metadata[activation_code]': activationCode,
      'metadata[license_id]': String(license.id),
      'metadata[new_device_count]': String(count),
      'metadata[devices_to_add]': String(devicesToAdd),
      'line_items[0][price_data][currency]': currency,
      'line_items[0][price_data][unit_amount]': String(totalCents),
      'line_items[0][price_data][product_data][name]': `Culler — ${devicesToAdd} additional device${devicesToAdd > 1 ? 's' : ''}`,
      'line_items[0][quantity]': '1',
    });

    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(stripeSecretKey + ':').toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: stripeBody.toString(),
    });
    
    const session = await stripeRes.json();
    if (!stripeRes.ok) return res.status(400).json({ error: session.error?.message || 'Stripe error.' });
    
    console.log(`[upgrade] Device upgrade checkout created: ${devicesToAdd} devices for ${license.customer_email}`);
    return res.json({ url: session.url });
  } catch (err) {
    console.error('[upgrade] error:', err);
    return res.status(500).json({ error: 'Could not create upgrade checkout.' });
  }
});

app.get('/admin/pricing', authSession, async (_req, res) => {
  const result = await pool.query('SELECT key, value FROM pricing_config ORDER BY key');
  const cfg = {};
  for (const row of result.rows) cfg[row.key] = row.value;
  return res.send(htmlPage('Pricing Config', `
    <div class="hero">
      <div class="hero-copy">
        <div class="hero-kicker">Revenue</div>
        <h1>Pricing &amp; Plans</h1>
        <p>Set prices and Stripe Price IDs for each plan. Stripe Price IDs override manual amounts — use them for subscriptions.</p>
      </div>
      ${nav('pricing')}
    </div>
    <form method="post" action="/admin/pricing">
    <div class="grid">
      <div class="panel">
        <h2>Monthly</h2>
        <label>Price (cents, e.g. 900 = $9.00)</label>
        <input type="number" name="price_monthly_cents" value="${cfg.price_monthly_cents || ''}" placeholder="900" />
        <label>Stripe Price ID <span style="font-weight:400">(optional, for subscriptions)</span></label>
        <input name="stripe_price_monthly" value="${cfg.stripe_price_monthly || ''}" placeholder="price_xxx" />
      </div>
      <div class="panel">
        <h2>Yearly</h2>
        <label>Price (cents)</label>
        <input type="number" name="price_yearly_cents" value="${cfg.price_yearly_cents || ''}" placeholder="4900" />
        <label>Stripe Price ID</label>
        <input name="stripe_price_yearly" value="${cfg.stripe_price_yearly || ''}" placeholder="price_xxx" />
      </div>
      <div class="panel">
        <h2>Lifetime</h2>
        <label>Price (cents)</label>
        <input type="number" name="price_lifetime_cents" value="${cfg.price_lifetime_cents || ''}" placeholder="4900" />
        <label>Stripe Price ID <span style="font-weight:400">(one-time payment)</span></label>
        <input name="stripe_price_lifetime" value="${cfg.stripe_price_lifetime || ''}" placeholder="price_xxx" />
      </div>
      <div class="panel">
        <h2>Device Upgrades</h2>
        <label>Price per additional device (cents)</label>
        <input type="number" name="device_upgrade_price_cents" value="${cfg.device_upgrade_price_cents || ''}" placeholder="500" />
        <p class="muted" style="font-size:0.85rem;margin-top:8px">Charged per device when upgrading from 1→2, 2→5, 5→10, etc.</p>
      </div>
      <div class="panel">
        <h2>Extension Pricing</h2>
        <label>Price per extra day (cents)</label>
        <input type="number" name="extend_day_price_cents" value="${cfg.extend_day_price_cents || ''}" placeholder="100" />
        <label>Price per extra month (cents)</label>
        <input type="number" name="extend_month_price_cents" value="${cfg.extend_month_price_cents || ''}" placeholder="900" />
        <label>Price per extra year (cents)</label>
        <input type="number" name="extend_year_price_cents" value="${cfg.extend_year_price_cents || ''}" placeholder="4900" />
      </div>
      <div class="panel">
        <h2>Global settings</h2>
        <label>Currency code</label>
        <input name="currency" value="${cfg.currency || 'aud'}" placeholder="aud" />
        <label>Trial length (days)</label>
        <input type="number" name="trial_days" value="${cfg.trial_days || '14'}" />
        <label>Stripe Publishable Key <span style="font-weight:400">(shown to client)</span></label>
        <input name="stripe_publishable_key" value="${stripePublishableKey}" readonly style="opacity:.5" />
        <p class="muted" style="margin-top:6px">Set via <code>STRIPE_PUBLISHABLE_KEY</code> env var.</p>
      </div>
    </div>
    <div class="panel" style="margin-top:0">
      <div class="actions">
        <button type="submit">Save pricing</button>
      </div>
    </div>
    </form>
    <div class="panel">
      <h2>How checkout works</h2>
      <p class="muted">The app calls <code>POST /api/v1/checkout/create</code> with <code>{ plan, name, email }</code>. The server creates a Stripe Checkout Session and returns a redirect URL. After payment, Stripe calls the webhook and the license is auto-generated and emailed. For subscription plans, set a Stripe Price ID — Culler will treat the subscription as a time-limited license renewed each period.</p>
      <p class="muted" style="margin-top:8px">Webhook URL to register in Stripe: <code>${publicUpdatesBaseUrl()}/stripe/webhook</code></p>
    </div>
  `));
});

app.post('/admin/pricing', authSession, async (req, res) => {
  const fields = ['price_monthly_cents', 'price_yearly_cents', 'price_lifetime_cents',
    'stripe_price_monthly', 'stripe_price_yearly', 'stripe_price_lifetime', 'currency', 'trial_days',
    'device_upgrade_price_cents', 'extend_day_price_cents', 'extend_month_price_cents', 'extend_year_price_cents'];
  for (const key of fields) {
    const value = String(req.body[key] ?? '').trim();
    await pool.query(
      `INSERT INTO pricing_config (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, value],
    );
  }
  return res.redirect('/admin/pricing');
});

// ---------------------------------------------------------------------------
// Device upgrade success page  GET /upgrade-success
// ---------------------------------------------------------------------------
app.get('/upgrade-success', (_req, res) => {
  return res.send(htmlPage('Upgrade complete', `
    <div class="panel" style="max-width:620px;margin:80px auto;text-align:center">
      <div style="font-size:2.5rem;margin-bottom:16px">✓</div>
      <h1 style="margin-bottom:8px">Upgrade complete</h1>
      <p class="muted" style="margin-bottom:24px">Your device limit has been increased!</p>
      
      <div style="background:var(--surface-raised);border:1px solid var(--border);border-radius:12px;padding:24px;text-align:left;margin-bottom:24px">
        <p style="font-size:0.85rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">What's next</p>
        <ol style="margin-left:20px;line-height:1.8">
          <li>Restart Culler on your devices</li>
          <li>All devices will activate with your license</li>
          <li>Confirmation email has been sent</li>
        </ol>
      </div>
      
      <p class="muted"><a href="/#pricing">← Back to pricing</a></p>
    </div>
  `));
});

// ---------------------------------------------------------------------------
// License extension  POST /admin/licenses/:id/extend
// Adds days/months/years to expires_at (or from today if perpetual) and
// regenerates the license key with the new expiry.
// ---------------------------------------------------------------------------
app.post('/admin/licenses/:id/extend', authSession, async (req, res) => {
  const { amount, unit } = req.body; // unit: days | months | years
  if (!['days','months','years'].includes(unit) || !Number.isInteger(Number(amount)) || Number(amount) < 1) {
    return res.status(400).send(htmlPage('Error', `<div class="panel"><p class="bad">Invalid extension params.</p><a href="/admin/licenses/${req.params.id}">Back</a></div>`));
  }
  const record = await pool.query('SELECT * FROM license_records WHERE id = $1', [req.params.id]);
  if (!record.rowCount) return res.status(404).send('Not found');
  const row = record.rows[0];

  // Calculate new expiry
  const base = row.expires_at ? new Date(row.expires_at) : new Date();
  if (unit === 'days') base.setDate(base.getDate() + Number(amount));
  else if (unit === 'months') base.setMonth(base.getMonth() + Number(amount));
  else base.setFullYear(base.getFullYear() + Number(amount));
  const dd = String(base.getDate()).padStart(2,'0');
  const mm = String(base.getMonth()+1).padStart(2,'0');
  const yyyy = base.getFullYear();
  const expiry = `${dd}-${mm}-${yyyy}`;

  // Regenerate license key with new expiry
  const newKey = createLicenseKey({
    name: row.customer_name,
    email: row.customer_email,
    expiry,
    notes: row.notes,
    maxDevices: row.max_devices,
  });
  const validated = validateLicenseKey(newKey, licensePublicKeyPem);
  if (!validated.valid) return res.status(500).send('Key re-generation failed');

  await pool.query(
    `UPDATE license_records SET license_key=$1, expires_at=$2, status='active', updated_at=NOW() WHERE id=$3`,
    [newKey, base.toISOString().slice(0,10), row.id],
  );
  await pool.query(
    `UPDATE license_activations
     SET expires_at = $1, updated_at = NOW()
     WHERE license_fingerprint = $2`,
    [base.toISOString().slice(0,10), row.fingerprint],
  );

  // Email customer the updated key if they have an email
  if (row.customer_email) {
    try {
      await sendEmail({
        to: row.customer_email,
        subject: 'Your Culler license has been extended',
        html: licenseEmailHtml({
          customerName: row.customer_name,
          licenseKey: newKey,
          activationCode: row.activation_code,
          expiresLabel: `${dd}/${mm}/${yyyy}`,
        }),
      });
    } catch { /* non-fatal */ }
  }

  return res.redirect(`/admin/licenses/${row.id}`);
});

// ---------------------------------------------------------------------------
// Stripe webhook — extended to handle subscription renewals
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Stripe webhook  POST /stripe/webhook  (already registered above)
// Extended: handle customer.subscription.updated for renewals
// Also: use metadata[customer_name] and metadata[extension_code] from checkout
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Get license by session ID  GET /api/v1/license/:sessionId
// Called by checkout-success page to display license immediately
// ---------------------------------------------------------------------------
app.get('/api/v1/license/:sessionId', apiCors, async (req, res) => {
  let { sessionId } = req.params;
  
  // Handle case where Stripe appends metadata to session ID (e.g., cs_live_...:150)
  if (sessionId.includes(':')) {
    const original = sessionId;
    sessionId = sessionId.split(':')[0];
    console.log(`[license-lookup] Cleaned session ID: ${original} → ${sessionId}`);
  }
  
  try {
    console.log(`[license-lookup] Querying stripe_sessions for: ${sessionId}`);
    const result = await pool.query(
      'SELECT ss.license_key, ss.activation_code, ss.customer_email, ss.plan, ss.max_devices, ss.expires_at FROM stripe_sessions ss WHERE ss.session_id = $1',
      [sessionId]
    );
    
    console.log(`[license-lookup] Query returned ${result.rows.length} rows`);
    
    if (result.rows.length === 0) {
      console.warn(`[license-lookup] Session not found: ${sessionId}`);
      return res.status(404).json({ error: 'License not found. It may take a few seconds to process. Please refresh.' });
    }
    const row = result.rows[0];
    console.log(`[license-lookup] ✓ Found license for ${row.customer_email}`);
    return res.json({
      licenseKey: row.license_key,
      activationCode: row.activation_code,
      email: row.customer_email,
      plan: row.plan,
      maxDevices: row.max_devices,
      expiresAt: row.expires_at,
    });
  } catch (err) {
    console.error('[license-lookup] Database error:', err.message);
    console.error('[license-lookup] Stack:', err.stack);
    return res.status(500).json({ error: 'Could not retrieve license.' });
  }
});

// ---------------------------------------------------------------------------
// License info API  GET /api/v1/license-info/:activationCode
// Look up a license by activation code
// ---------------------------------------------------------------------------
app.get('/api/v1/license-info/:code', apiCors, async (req, res) => {
  const code = req.params.code?.trim();
  if (!code) return res.status(400).json({ error: 'Activation code required.' });
  
  try {
    const row = await getLicenseRecordByActivationCode(code);

    if (!row) {
      return res.status(404).json({ error: 'License not found.' });
    }

    return res.json({
      id: row.id,
      activationCode: row.activation_code,
      customerName: row.customer_name,
      customerEmail: row.customer_email,
      plan: row.plan,
      maxDevices: row.max_devices,
      expiresAt: row.expires_at,
    });
  } catch (err) {
    console.error('[license-info] Error:', err.message);
    return res.status(500).json({ error: 'Could not retrieve license.' });
  }
});

// ---------------------------------------------------------------------------
// Extend license  POST /api/v1/extend-license
// Body: { activationCode, amount, unit: 'days'|'months'|'years' }
// Returns Stripe checkout URL
// ---------------------------------------------------------------------------
app.post('/api/v1/extend-license', apiCors, async (req, res) => {
  const { activationCode, amount, unit } = req.body;
  
  if (!activationCode || !amount || !unit) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  
  if (!['days', 'months', 'years'].includes(unit)) {
    return res.status(400).json({ error: 'Invalid unit (days/months/years).' });
  }
  
  try {
    // Get pricing config
    const cfg = await getStripePricing();
    const currency = (cfg.currency || 'aud').toLowerCase();
    
    // Look up license
    const license = await getLicenseRecordByActivationCode(activationCode);

    if (!license) {
      return res.status(404).json({ error: 'License not found.' });
    }

    const unitPriceKey = unit === 'days'
      ? 'extend_day_price_cents'
      : unit === 'months'
        ? 'extend_month_price_cents'
        : 'extend_year_price_cents';
    const unitPriceCents = Number(cfg[unitPriceKey] || 0);
    
    if (!unitPriceCents) {
      return res.status(503).json({ error: `Extension pricing not configured for ${unit}.` });
    }
    
    const extendCents = unitPriceCents * Number(amount);
    
    const origin = req.headers.origin || publicUpdatesBaseUrl();
    const successUrl = `${origin}/manage-license`;
    const cancelUrl = `${origin}/manage-license`;
    
    const stripeBody = new URLSearchParams({
      'payment_method_types[]': 'card',
      'customer_email': license.customer_email,
      'success_url': successUrl,
      'cancel_url': cancelUrl,
      'mode': 'payment',
      'metadata[activation_code]': activationCode,
      'metadata[license_id]': String(license.id),
      'metadata[extend_amount]': String(amount),
      'metadata[extend_unit]': unit,
      'line_items[0][price_data][currency]': currency,
      'line_items[0][price_data][unit_amount]': String(extendCents),
      'line_items[0][price_data][product_data][name]': `Culler extension — +${amount} ${unit}`,
      'line_items[0][quantity]': '1',
    });
    
    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(stripeSecretKey + ':').toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: stripeBody.toString(),
    });
    
    const session = await stripeRes.json();
    if (!stripeRes.ok) return res.status(400).json({ error: session.error?.message || 'Stripe error.' });
    
    console.log(`[extend] License extension checkout created for ${license.customer_email}: +${amount} ${unit}`);
    return res.json({ url: session.url });
  } catch (err) {
    console.error('[extend] error:', err);
    return res.status(500).json({ error: 'Could not create extension checkout.' });
  }
});

// ---------------------------------------------------------------------------
// Upgrade license page  GET /upgrade-license
// Redirect to device upgrade with activation code pre-filled
// ---------------------------------------------------------------------------
app.get('/upgrade-license', (_req, res) => {
  const code = _req.query.code || '';
  return res.send(htmlPage('Add devices to your license', `
    <div class="panel" style="max-width:620px;margin:60px auto">
      <h1 style="text-align:center;margin-bottom:8px">Add devices to your license</h1>
      <p class="muted" style="text-align:center;margin-bottom:32px">Your current license will be upgraded to cover more devices</p>
      
      <div style="background:var(--surface-raised);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:24px">
        <label style="display:block;margin-bottom:8px;font-weight:500">How many devices do you need?</label>
        <input id="deviceCount" type="number" min="2" max="100" value="5" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:6px;font-size:1rem" />
        <p class="muted" style="font-size:0.85rem;margin-top:8px">Current devices: <span id="currentDevices">1</span> → New: <span id="newDevices">5</span> | Cost: <span id="costDisplay">—</span></p>
      </div>
      
      <button id="upgradeBtn" style="width:100%;background:var(--accent);color:#fff;border:none;border-radius:6px;padding:12px;font-weight:500;cursor:pointer;font-size:1rem;margin-bottom:12px">Proceed to payment</button>
      <a href="/manage-license" style="display:block;text-align:center;color:var(--text-muted);text-decoration:none;padding:8px">← Back</a>
    </div>
    
    <script>
      const code = '${code.replace(/'/g, "\\'")}';
      let currentDevices = 1;
      let pricePerDevice = 0;
      let pricingCurrency = 'AUD';
      
      async function loadLicense() {
        if (!code) {
          document.getElementById('upgradeBtn').disabled = true;
          return;
        }
        
        try {
          const res = await fetch('/api/v1/license-info/' + encodeURIComponent(code));
          const data = await res.json();
          if (res.ok) {
            currentDevices = data.maxDevices || 1;
            document.getElementById('currentDevices').textContent = currentDevices;
            updateCost();
          }
        } catch (err) {
          console.error(err);
        }
      }
      
      async function getPricing() {
        try {
          const res = await fetch('/api/v1/pricing');
          const data = await res.json();
          pricePerDevice = (data.deviceUpgradePrice || 0) / 100;
          pricingCurrency = (data.currency || 'AUD').toUpperCase();
          updateCost();
        } catch (err) {
          console.error(err);
        }
      }
      
      function updateCost() {
        const newCount = parseInt(document.getElementById('deviceCount').value) || currentDevices;
        const devicesToAdd = newCount - currentDevices;
        const totalCost = devicesToAdd * pricePerDevice;
        document.getElementById('newDevices').textContent = newCount;
        document.getElementById('costDisplay').textContent = totalCost > 0
          ? new Intl.NumberFormat('en-AU', { style: 'currency', currency: pricingCurrency }).format(totalCost)
          : 'FREE';
      }
      
      document.getElementById('deviceCount').oninput = updateCost;
      
      document.getElementById('upgradeBtn').onclick = async () => {
        const newCount = parseInt(document.getElementById('deviceCount').value);
        if (newCount <= currentDevices) {
          alert('Please select a number greater than ' + currentDevices);
          return;
        }
        
        try {
          const res = await fetch('/api/v1/upgrade-devices', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              activationCode: code,
              newDeviceCount: newCount
            })
          });
          
          const data = await res.json();
          if (res.ok) {
            window.location.href = data.url;
          } else {
            alert('Error: ' + (data.error || 'Failed to create checkout'));
          }
        } catch (err) {
          alert('Error: ' + err.message);
        }
      };
      
      loadLicense();
      getPricing();
    </script>
  `));
});
// Shows license + download prompt
// ---------------------------------------------------------------------------
app.get('/checkout-success', (_req, res) => {
  return res.send(htmlPage('Purchase complete', `
    <div class="panel" style="max-width:620px;margin:80px auto;text-align:center">
      <div style="font-size:2.5rem;margin-bottom:16px">✓</div>
      <h1 style="margin-bottom:8px">Payment confirmed</h1>
      <p class="muted" id="loadingMsg">Loading your activation code...</p>
      
      <div id="licenseBox" style="display:none;margin-top:24px;text-align:left;background:var(--surface-raised);border:1px solid var(--border);border-radius:12px;padding:20px">
        <p style="font-size:0.85rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">Your activation code</p>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px;font-family:monospace;word-break:break-all;margin-bottom:12px;display:flex;align-items:flex-start;gap:12px">
          <code id="activationCode" style="font-size:0.9rem;line-height:1.6;flex:1;font-weight:600"></code>
          <button id="copyBtn" style="flex-shrink:0;background:var(--accent);color:#fff;border:none;border-radius:6px;padding:6px 12px;font-size:0.8rem;font-weight:500;cursor:pointer;white-space:nowrap">Copy</button>
        </div>
        <p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:8px">Paste it into:</p>
        <p style="font-size:0.9rem;margin-bottom:16px"><strong>Culler → Settings → License</strong></p>
        
        <div id="planInfo" style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:0.85rem;line-height:1.6;margin-bottom:16px">
          <p style="margin-bottom:8px"><strong>License details:</strong></p>
          <div style="margin-left:12px">
            <p>Plan: <strong id="planType">—</strong></p>
            <p>Devices: <strong id="maxDevices">—</strong></p>
            <p id="expiryLine" style="display:none">Expires: <strong id="expiryDate">—</strong></p>
          </div>
        </div>
        
        <div style="background:rgba(100,150,200,0.1);border:1px solid rgba(100,150,200,0.3);border-radius:8px;padding:12px;margin-bottom:16px;text-align:center">
          <p style="font-size:0.9rem;margin-bottom:8px">Ready to get started?</p>
          <a href="https://culler.z2hs.au/download.html" target="_blank" style="display:inline-block;background:var(--accent);color:#fff;text-decoration:none;border-radius:6px;padding:8px 16px;font-size:0.9rem;font-weight:500">↓ Download Culler</a>
        </div>
      </div>
      
      <div id="errorBox" style="display:none;margin-top:16px;background:#ff6b6b;background:rgba(255,107,107,0.1);border:1px solid rgba(255,107,107,0.3);border-radius:8px;padding:12px;color:#ff6b6b;font-size:0.9rem"></div>
      
      <div id="helpBox" style="display:none;margin-top:24px;background:rgba(100,150,200,0.1);border:1px solid rgba(100,150,200,0.3);border-radius:8px;padding:16px;font-size:0.85rem;line-height:1.6">
        <p style="margin-bottom:8px"><strong>License taking longer than expected?</strong></p>
        <p style="margin-bottom:8px">Usually arrives within 10 seconds. If it doesn't appear soon, please:</p>
        <ol style="margin-left:20px;margin-bottom:8px">
          <li>Check your email (spam folder too)</li>
          <li>Wait another minute and refresh this page</li>
          <li>Contact support if the issue persists</li>
        </ol>
      </div>
      
      <p class="muted" style="margin-top:24px">A copy has also been sent to your email. Check spam if it doesn't arrive within a few minutes.</p>
    </div>

    <script>
      const params = new URLSearchParams(window.location.search);
      let sessionId = params.get('session_id');
      let retryCount = 0;
      const MAX_RETRIES = 30;

      if (sessionId && sessionId.includes(':')) {
        sessionId = sessionId.split(':')[0];
      }

      async function loadLicense() {
        retryCount++;
        
        if (!sessionId) {
          showError('No session ID found. Please check your payment link.');
          return;
        }

        try {
          const res = await fetch('/api/v1/license/' + sessionId);
          const data = await res.json();

          if (!res.ok) {
            if (retryCount >= MAX_RETRIES) {
              document.getElementById('loadingMsg').style.display = 'none';
              document.getElementById('helpBox').style.display = 'block';
              return;
            }
            
            setTimeout(loadLicense, 2000);
            return;
          }

          document.getElementById('loadingMsg').style.display = 'none';
          document.getElementById('helpBox').style.display = 'none';
          const codeEl = document.getElementById('activationCode');
          codeEl.textContent = data.activationCode;
          document.getElementById('licenseBox').style.display = 'block';
          
          if (data.plan) document.getElementById('planType').textContent = 
            data.plan === 'monthly' ? 'Monthly' : data.plan === 'yearly' ? 'Yearly' : 'Lifetime';
          if (data.maxDevices) document.getElementById('maxDevices').textContent = data.maxDevices;
          if (data.expiresAt) {
            const date = new Date(data.expiresAt);
            document.getElementById('expiryDate').textContent = date.toLocaleDateString('en-AU', {year: 'numeric', month: 'short', day: 'numeric'});
            document.getElementById('expiryLine').style.display = 'block';
          }
          
          document.getElementById('copyBtn').onclick = async () => {
            try {
              await navigator.clipboard.writeText(data.activationCode);
              const btn = document.getElementById('copyBtn');
              const old = btn.textContent;
              btn.textContent = '✓ Copied!';
              setTimeout(() => { btn.textContent = old; }, 2000);
            } catch (err) {
              alert('Failed to copy to clipboard');
            }
          };
        } catch (err) {
          showError('Error: ' + err.message);
        }
      }

      function showError(msg) {
        document.getElementById('loadingMsg').style.display = 'none';
        const errorBox = document.getElementById('errorBox');
        errorBox.textContent = msg;
        errorBox.style.display = 'block';
      }

      loadLicense();
    </script>
  `));
});

// ---------------------------------------------------------------------------
// License management page  GET /manage-license
// Let users enter their activation code to view/extend/upgrade
// ---------------------------------------------------------------------------
app.get('/manage-license', (_req, res) => {
  return res.send(htmlPage('Manage your license', `
    <div class="panel" style="max-width:620px;margin:60px auto">
      <div style="text-align:center;margin-bottom:32px">
        <h1 style="margin-bottom:8px">Manage your license</h1>
        <p class="muted">Enter your activation code to view details, extend validity, or add devices</p>
      </div>
      
      <div style="background:var(--surface-raised);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:24px">
        <label style="display:block;margin-bottom:8px;font-weight:500">Activation code</label>
        <div style="display:flex;gap:8px">
          <input id="activationCodeInput" type="text" placeholder="PI1-ABC123..." style="flex:1;padding:10px;border:1px solid var(--border);border-radius:6px;font-family:monospace;font-size:0.9rem" />
          <button id="lookupBtn" style="background:var(--accent);color:#fff;border:none;border-radius:6px;padding:10px 20px;font-weight:500;cursor:pointer">Lookup</button>
        </div>
      </div>
      
      <div id="loadingMsg" style="display:none;text-align:center;padding:20px;color:var(--text-muted)">
        <p>Loading license details...</p>
      </div>
      
      <div id="errorMsg" style="display:none;background:rgba(255,107,107,0.1);border:1px solid rgba(255,107,107,0.3);border-radius:8px;padding:12px;color:#ff6b6b;margin-bottom:16px"></div>
      
      <div id="licenseDetails" style="display:none">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:20px">
          <h3 style="margin-bottom:16px;margin-top:0">Current status</h3>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;font-size:0.9rem">
            <div>
              <p style="color:var(--text-muted);margin-bottom:4px;font-size:0.85rem">Customer</p>
              <p style="font-weight:600" id="customerName">—</p>
            </div>
            <div>
              <p style="color:var(--text-muted);margin-bottom:4px;font-size:0.85rem">Plan</p>
              <p style="font-weight:600" id="planType">—</p>
            </div>
            <div>
              <p style="color:var(--text-muted);margin-bottom:4px;font-size:0.85rem">Devices</p>
              <p style="font-weight:600" id="maxDevices">—</p>
            </div>
            <div>
              <p style="color:var(--text-muted);margin-bottom:4px;font-size:0.85rem">Status</p>
              <p style="font-weight:600" id="statusText">—</p>
            </div>
            <div style="grid-column:1/-1">
              <p style="color:var(--text-muted);margin-bottom:4px;font-size:0.85rem">Expiry date</p>
              <p style="font-weight:600" id="expiryDate">—</p>
            </div>
          </div>
        </div>
        
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <button id="extendBtn" style="background:rgba(76,175,80,0.1);border:1px solid rgba(76,175,80,0.5);color:#4caf50;border-radius:6px;padding:12px;font-weight:500;cursor:pointer;text-align:center">📅 Extend validity</button>
          <button id="upgradeBtn" style="background:rgba(33,150,243,0.1);border:1px solid rgba(33,150,243,0.5);color:#2196f3;border-radius:6px;padding:12px;font-weight:500;cursor:pointer;text-align:center">🚀 Add devices</button>
        </div>
      </div>
      
      <div id="extendForm" style="display:none;background:var(--surface-raised);border:1px solid var(--border);border-radius:8px;padding:20px;margin-top:20px">
        <h3 style="margin-top:0">Extend your license</h3>
        <label style="display:block;margin-bottom:8px;font-weight:500">Add time to your license</label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
          <input id="extendAmount" type="number" min="1" value="1" style="padding:10px;border:1px solid var(--border);border-radius:6px" />
          <select id="extendUnit" style="padding:10px;border:1px solid var(--border);border-radius:6px">
            <option value="days">Days</option>
            <option value="months">Months</option>
            <option value="years">Years</option>
          </select>
        </div>
        <p id="extendPriceSummary" style="color:var(--text-muted);font-size:0.85rem;margin:0 0 16px">Loading pricing...</p>
        <button id="confirmExtendBtn" style="width:100%;background:var(--accent);color:#fff;border:none;border-radius:6px;padding:10px;font-weight:500;cursor:pointer">Proceed to payment</button>
        <button id="cancelExtendBtn" style="width:100%;background:transparent;color:var(--text-muted);border:1px solid var(--border);border-radius:6px;padding:10px;font-weight:500;cursor:pointer;margin-top:8px">Cancel</button>
      </div>
    </div>
    
    <script>
      let currentLicense = null;
      let pricingData = null;
      const activationCodeInput = document.getElementById('activationCodeInput');

      function formatMoney(cents) {
        const currency = (pricingData && pricingData.currency) || 'AUD';
        return new Intl.NumberFormat('en-AU', {
          style: 'currency',
          currency,
          minimumFractionDigits: 0,
          maximumFractionDigits: 2,
        }).format((Number(cents) || 0) / 100);
      }

      function displayPlan(plan, expiresAt) {
        if (plan === 'trial') return 'Trial';
        if (plan === 'monthly') return 'Monthly';
        if (plan === 'yearly') return 'Yearly';
        if (plan === 'lifetime') return 'Lifetime';
        return expiresAt ? 'Timed' : 'Lifetime';
      }

      async function loadPricing() {
        try {
          const res = await fetch('/api/v1/pricing');
          if (!res.ok) return;
          pricingData = await res.json();
          updateExtendSummary();
        } catch (err) {
          console.error(err);
        }
      }

      function updateExtendSummary() {
        const summary = document.getElementById('extendPriceSummary');
        if (!summary) return;
        const amount = parseInt(document.getElementById('extendAmount').value, 10) || 1;
        const unit = document.getElementById('extendUnit').value;
        const unitPrices = pricingData && pricingData.extensionPrices ? pricingData.extensionPrices : {};
        const totalCents = (Number(unitPrices[unit]) || 0) * amount;
        summary.textContent = totalCents > 0
          ? 'Total: ' + formatMoney(totalCents)
          : 'Pricing not configured yet';
      }

      async function lookupLicense() {
        const code = activationCodeInput.value.trim();
        if (!code) {
          showError('Please enter an activation code');
          return;
        }
        
        showLoading();
        try {
          const res = await fetch('/api/v1/license-info/' + encodeURIComponent(code));
          const data = await res.json();
          
          if (!res.ok) {
            showError(data.error || 'License not found');
            return;
          }
          
          currentLicense = data;
          showLicenseDetails();
        } catch (err) {
          showError('Error: ' + err.message);
        }
      }

      document.getElementById('lookupBtn').onclick = () => {
        void lookupLicense();
      };
      
      function showLoading() {
        document.getElementById('loadingMsg').style.display = 'block';
        document.getElementById('errorMsg').style.display = 'none';
        document.getElementById('licenseDetails').style.display = 'none';
        document.getElementById('extendForm').style.display = 'none';
      }
      
      function showError(msg) {
        document.getElementById('loadingMsg').style.display = 'none';
        const errorBox = document.getElementById('errorMsg');
        errorBox.textContent = msg;
        errorBox.style.display = 'block';
      }
      
      function showLicenseDetails() {
        document.getElementById('loadingMsg').style.display = 'none';
        document.getElementById('errorMsg').style.display = 'none';
        
        document.getElementById('customerName').textContent = currentLicense.customerName || '—';
        document.getElementById('planType').textContent = displayPlan(currentLicense.plan, currentLicense.expiresAt);
        document.getElementById('maxDevices').textContent = currentLicense.maxDevices || 1;
        
        const isLifetime = !currentLicense.expiresAt;
        document.getElementById('statusText').textContent = isLifetime ? 'Lifetime' : 'Active';
        
        if (currentLicense.expiresAt) {
          const date = new Date(currentLicense.expiresAt);
          document.getElementById('expiryDate').textContent = date.toLocaleDateString('en-AU', {year: 'numeric', month: 'short', day: 'numeric'});
        } else {
          document.getElementById('expiryDate').textContent = 'Never expires';
        }
        
        document.getElementById('licenseDetails').style.display = 'block';
      }
      
      document.getElementById('extendBtn').onclick = () => {
        document.getElementById('licenseDetails').style.display = 'none';
        document.getElementById('extendForm').style.display = 'block';
        updateExtendSummary();
      };
      
      document.getElementById('cancelExtendBtn').onclick = () => {
        document.getElementById('extendForm').style.display = 'none';
        document.getElementById('licenseDetails').style.display = 'block';
      };

      document.getElementById('extendAmount').oninput = updateExtendSummary;
      document.getElementById('extendUnit').onchange = updateExtendSummary;
      
      document.getElementById('confirmExtendBtn').onclick = async () => {
        const amount = parseInt(document.getElementById('extendAmount').value);
        const unit = document.getElementById('extendUnit').value;
        
        if (!amount || amount < 1) {
          alert('Please enter a valid amount');
          return;
        }
        
        showLoading();
        try {
          const res = await fetch('/api/v1/extend-license', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              activationCode: currentLicense.activationCode,
              amount,
              unit
            })
          });
          
          const data = await res.json();
          if (!res.ok) {
            showError(data.error || 'Failed to create extension');
            return;
          }
          
          // Redirect to Stripe checkout
          window.location.href = data.url;
        } catch (err) {
          showError('Error: ' + err.message);
        }
      };
      
      document.getElementById('upgradeBtn').onclick = () => {
        window.location.href = '/upgrade-license?code=' + encodeURIComponent(currentLicense.activationCode);
      };

      const params = new URLSearchParams(window.location.search);
      const initialCode = params.get('code');
      if (initialCode) {
        activationCodeInput.value = initialCode;
        void lookupLicense();
      }

      void loadPricing();
    </script>
  `));
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
  await ensureTrialSchema();
  await ensurePricingSchema();
  await ensureStripeSessionsSchema();
  await ensureAdminUser();
  app.listen(port, '0.0.0.0', () => {
    console.log(`[update-admin] Listening on 0.0.0.0:${port}`);
  });
}

start().catch((err) => {
  console.error('[update-admin] Failed to start:', err);
  process.exit(1);
});
