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
app.disable('x-powered-by');

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

function requiredSecret(name, forbiddenDefault) {
  const value = String(process.env[name] || '');
  const normalized = value.toLowerCase();
  const isPlaceholder =
    value === forbiddenDefault ||
    normalized.includes('change_me') ||
    normalized.includes('change-me') ||
    normalized.includes('replace_with') ||
    normalized.includes('replace-with');
  if (!value || isPlaceholder || value.length < 32) {
    throw new Error(`${name} must be set to a unique secret of at least 32 characters.`);
  }
  return value;
}

const sessionSecret = requiredSecret('ADMIN_SESSION_SECRET', 'change-me-admin-session-secret');
const updateSecret = requiredSecret('UPDATE_TOKEN_SECRET', 'change-me-update-token-secret');
const adminApiToken = process.env.ADMIN_API_TOKEN || '';
const artifactsRoot = process.env.ARTIFACTS_ROOT || '/srv/artifacts';
const githubApiBase = process.env.GITHUB_API_BASE_URL || 'https://api.github.com';
const githubRepoOwner = process.env.GITHUB_RELEASE_OWNER || '';
const githubRepoName = process.env.GITHUB_RELEASE_REPO || '';
const githubToken = process.env.GITHUB_RELEASE_TOKEN || '';
const HOME_URL = process.env.HOME_URL || 'https://keptra.z2hs.au/';
const ACTIVATION_CODE_PREFIX = 'PIC';
const ACTIVATION_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const defaultMaxDevices = Math.max(1, Number.parseInt(process.env.DEFAULT_MAX_DEVICES || '1', 10) || 1);
const checkoutMaxDevices = Math.max(defaultMaxDevices, Number.parseInt(process.env.CHECKOUT_MAX_DEVICES || '5', 10) || 5);

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
const emailFromAddress = process.env.MAIL_FROM || process.env.MAIL_USERNAME || 'no-reply@keptra.z2hs.au';

// --- Trial config ---
const trialDays = Math.max(1, Number.parseInt(process.env.TRIAL_DAYS || '14', 10) || 14);
const trialMaxDevices = Math.max(1, Number.parseInt(process.env.TRIAL_MAX_DEVICES || '1', 10) || 1);
const trialCooldownDays = Math.max(1, Number.parseInt(process.env.TRIAL_COOLDOWN_DAYS || '30', 10) || 30);

// CORS origins allowed to call public API endpoints from the Electron renderer
// and from the website. Legacy Culler hosts stay allowed so old app builds
// can still check/update while all public URLs are rewritten to Keptra.
const corsAllowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || 'https://keptra.z2hs.au,https://admin.keptra.z2hs.au,https://updates.keptra.z2hs.au,https://culler.z2hs.au,https://admin.culler.z2hs.au,https://updates.culler.z2hs.au,http://keptra.z2hs.au,http://admin.keptra.z2hs.au,http://updates.keptra.z2hs.au,http://culler.z2hs.au,http://admin.culler.z2hs.au,http://updates.culler.z2hs.au')
  .split(',').map((o) => o.trim()).filter(Boolean);

const KEPTRA_LOGO_SVG = '<svg viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="256" height="256" rx="56" fill="#0D1416"/><rect x="13" y="13" width="230" height="230" rx="46" fill="#142629" stroke="#37B69F" stroke-width="12"/><path d="M128 49L178 136H78L128 49Z" fill="#37B69F"/><path d="M211 116L161 202L112 116H211Z" fill="#52D7B5"/><path d="M55 152L104 67L154 152H55Z" fill="#2585A1"/><path d="M88 139L121 173L190 92" stroke="#F6FBFA" stroke-width="21" stroke-linecap="round" stroke-linejoin="round"/><path d="M67 67H101M67 67V101M188 67H222M222 67V101M67 188V222H101M188 222H222V188" stroke="#F6FBFA" stroke-opacity=".78" stroke-width="11" stroke-linecap="round"/></svg>';

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
  <meta name="color-scheme" content="dark" />
  <title>${title} — Keptra Admin</title>
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
    :root{--bg:#091116;--surface:rgba(13,24,31,.94);--surface-2:rgba(19,33,41,.95);--surface-3:rgba(28,45,55,.98);--border:rgba(95,130,147,.24);--border-strong:rgba(135,177,198,.32);--text:#edf5f7;--muted:#9db2bc;--faint:#6f8791;--accent:#60c7b2;--accent-strong:#1ea48b;--accent-soft:rgba(96,199,178,.16);--accent-warm:#f2bf83;--danger:#ff9d8d;--danger-soft:rgba(255,123,103,.14);--warning:#ffd08a;--ok:#9fe4bb;--shadow:0 22px 52px rgba(0,0,0,.24);--radius:12px;--radius-sm:8px}
    *,*::before,*::after{box-sizing:border-box}
    html{color-scheme:dark}
    body{font-family:'Segoe UI Variable','Avenir Next','Segoe UI',Tahoma,sans-serif;background:linear-gradient(180deg,#0b1318 0%,#091116 54%,#081015 100%);color:var(--text);margin:0;min-height:100vh;-webkit-font-smoothing:antialiased;line-height:1.55;position:relative;overflow-x:hidden}
    body::before{content:'';position:fixed;inset:0;pointer-events:none;background:linear-gradient(90deg,rgba(255,255,255,.018) 1px,transparent 1px),linear-gradient(rgba(255,255,255,.018) 1px,transparent 1px);background-size:48px 48px;mask-image:linear-gradient(180deg,rgba(0,0,0,.34),transparent 80%)}
    a{color:inherit;text-decoration:none}
    a:hover{color:#fff}
    code{font-family:ui-monospace,'SF Mono',Consolas,monospace;font-size:.83em;background:rgba(12,20,26,.88);border:1px solid rgba(128,163,178,.14);padding:3px 8px;border-radius:999px;white-space:normal;overflow-wrap:anywhere}
    pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
    h1{font-size:clamp(1.8rem,3vw,2.85rem);font-weight:750;margin:0;letter-spacing:0;line-height:1.04;max-width:16ch}
    h2{font-size:.78rem;font-weight:700;margin:0 0 14px;color:var(--muted);text-transform:uppercase;letter-spacing:.16em}
    p{margin:0}
    label{display:block;font-size:.8rem;font-weight:650;color:var(--muted);margin-bottom:6px;margin-top:14px;letter-spacing:.02em}
    label:first-child{margin-top:0}
    .shell{max-width:1380px;margin:0 auto;padding:34px 24px 56px;position:relative;z-index:1}
    .hero{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:22px;align-items:end;padding:28px 28px 24px;margin-bottom:22px;border:1px solid var(--border-strong);border-radius:16px;background:linear-gradient(135deg,rgba(96,199,178,.12),rgba(13,24,31,.94) 64%);box-shadow:var(--shadow);backdrop-filter:blur(18px)}
    .hero-copy{display:flex;flex-direction:column;gap:10px;min-width:0}
    .hero-copy p{max-width:66ch;color:var(--muted);font-size:1rem}
    .hero-kicker{font-size:.72rem;font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:var(--accent-warm)}
    .hero-meta{display:flex;gap:10px;flex-wrap:wrap}
    .hero-note{display:inline-flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid var(--border);border-radius:999px;background:rgba(6,14,18,.34);color:var(--muted);font-size:.8rem}
    .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px;margin-bottom:20px}
    .card,.panel{background:linear-gradient(180deg,rgba(17,29,36,.92),rgba(12,22,28,.94));border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow);backdrop-filter:blur(18px)}
    .card{padding:20px 20px 18px;min-height:154px;display:flex;flex-direction:column;justify-content:space-between}
    .card-label{font-size:.76rem;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.14em;line-height:1.45}
    .card-value{font-size:clamp(1.75rem,2.8vw,2.6rem);font-weight:760;line-height:1.02;letter-spacing:0;margin-top:12px}
    .card-note,.subtle{color:var(--muted);font-size:.88rem;line-height:1.45}
    .metric-list{display:grid;gap:8px;margin-top:14px}
    .metric-row{display:flex;justify-content:space-between;gap:12px;color:var(--muted);font-size:.88rem}
    .metric-row strong{color:var(--text);font-weight:700}
    .panel{padding:22px;margin-bottom:16px;overflow:hidden}
    .panel > * + *{margin-top:14px}
    .panel > h2:first-child{margin-top:0}
    .panel-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap}
    .panel-head p{max-width:64ch}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;margin-bottom:16px}
    .stack{display:flex;flex-direction:column;gap:16px}
    .row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
    .row-3{grid-template-columns:repeat(3,minmax(0,1fr))}
    .row-bottom{align-items:end}
    .toolbar{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end}
    .toolbar .grow{flex:1 1 220px}
    .toolbar .toolbar-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    form.inline{display:inline}
    .nav-shell{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end;max-width:100%}
    .nav-brand{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:999px;border:1px solid var(--border);background:rgba(7,15,19,.58);font-size:.88rem;font-weight:750;letter-spacing:0;box-shadow:0 10px 24px rgba(0,0,0,.18)}
    .nav-links{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px;border:1px solid var(--border);border-radius:999px;background:rgba(7,15,19,.58);box-shadow:0 10px 24px rgba(0,0,0,.18)}
    .nav-links a,.nav-shell form.inline button{font-size:.82rem;font-weight:650;color:var(--muted);padding:9px 14px;border-radius:999px;transition:background .18s,color .18s,border-color .18s,transform .18s;line-height:1.2}
    .nav-links a:hover,.nav-links a.active,.nav-shell form.inline button:hover{color:var(--text);background:rgba(96,199,178,.16)}
    .nav-links a.active{box-shadow:inset 0 0 0 1px rgba(96,199,178,.3)}
    .nav-shell form.inline button{background:rgba(7,15,19,.58);border:1px solid var(--border);cursor:pointer;font-family:inherit}
    .table-wrap{margin-top:12px;overflow:auto;border:1px solid var(--border);border-radius:12px;background:rgba(8,16,20,.48)}
    table{width:100%;border-collapse:collapse;font-size:.89rem;min-width:720px}
    thead{border-bottom:1px solid var(--border-strong);background:rgba(255,255,255,.02)}
    th{padding:14px 16px;text-align:left;font-weight:750;font-size:.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:.14em;white-space:nowrap}
    td{padding:15px 16px;border-bottom:1px solid rgba(116,148,161,.12);vertical-align:top;overflow-wrap:anywhere}
    tbody tr:last-child td{border-bottom:none}
    tbody tr:hover td{background:rgba(255,255,255,.02)}
    td code{display:inline-block;max-width:100%}
    .cell-actions{width:1%;white-space:nowrap}
    input,textarea,select{width:100%;background:rgba(6,14,18,.52);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:11px 14px;box-sizing:border-box;font-size:.92rem;font-family:inherit;transition:border-color .15s,box-shadow .15s,background .15s}
    input::placeholder,textarea::placeholder{color:#70848d}
    input:focus,textarea:focus,select:focus{outline:none;border-color:rgba(96,199,178,.7);box-shadow:0 0 0 4px rgba(96,199,178,.12);background:rgba(9,18,23,.8)}
    textarea{resize:vertical;min-height:100px}
    textarea[readonly]{background:rgba(6,12,16,.88);font-family:ui-monospace,'SF Mono',Consolas,monospace;font-size:.84rem;line-height:1.55}
    select{cursor:pointer}
    button{background:linear-gradient(135deg,var(--accent),var(--accent-strong));color:#041016;border:none;border-radius:999px;padding:10px 16px;cursor:pointer;font-size:.9rem;font-weight:750;transition:transform .15s,box-shadow .15s,opacity .15s;font-family:inherit;line-height:1.25;box-shadow:0 12px 24px rgba(30,164,139,.2)}
    button:hover{transform:translateY(-1px);box-shadow:0 16px 28px rgba(30,164,139,.24)}
    button.secondary{background:rgba(17,31,39,.9);color:var(--text);border:1px solid var(--border);box-shadow:none}
    button.secondary:hover{background:rgba(28,45,55,.98);box-shadow:none}
    button.sm{padding:7px 12px;font-size:.78rem}
    button.danger{background:linear-gradient(135deg,#6b231e,#87241f);color:#ffd8d1;border:1px solid rgba(255,123,103,.35);box-shadow:none}
    button.danger:hover{box-shadow:none;background:linear-gradient(135deg,#7f2a23,#992e26)}
    .pill{display:inline-flex;align-items:center;padding:5px 10px;border-radius:999px;font-size:.72rem;font-weight:760;letter-spacing:.08em;text-transform:uppercase;background:rgba(255,255,255,.06);color:var(--muted);border:1px solid transparent}
    .pill-active,.pill-live{background:rgba(80,200,120,.14);color:var(--ok);border-color:rgba(80,200,120,.22)}
    .pill-revoked{background:rgba(255,123,103,.14);color:var(--danger);border-color:rgba(255,123,103,.2)}
    .pill-expired,.pill-draft{background:rgba(242,191,131,.14);color:var(--warning);border-color:rgba(242,191,131,.22)}
    .pill-disabled,.pill-hidden{background:rgba(122,144,156,.16);color:#b1c1c8;border-color:rgba(122,144,156,.2)}
    .pill-trial{background:rgba(126,187,255,.14);color:#9fd0ff;border-color:rgba(126,187,255,.22)}
    .pill-monthly,.pill-yearly{background:rgba(96,199,178,.12);color:var(--accent);border-color:rgba(96,199,178,.2)}
    .pill-lifetime{background:rgba(189,160,255,.14);color:#d3c4ff;border-color:rgba(189,160,255,.22)}
    .pill-timed{background:rgba(242,191,131,.12);color:var(--warning);border-color:rgba(242,191,131,.2)}
    .muted{color:var(--muted);font-size:.88rem}
    .ok{color:var(--ok)}
    .bad{color:var(--danger)}
    .warn{color:var(--warning)}
    .list{margin:0;padding-left:18px;color:var(--muted)}
    .list li{margin:6px 0}
    .notice{padding:14px 16px;border:1px solid var(--border);border-radius:8px;background:rgba(96,199,178,.08)}
    .notice.warning{background:rgba(242,191,131,.09);border-color:rgba(242,191,131,.18)}
    .notice.danger{background:var(--danger-soft);border-color:rgba(255,123,103,.18)}
    .detail-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px}
    .detail-item{padding:14px 16px;border:1px solid rgba(116,148,161,.14);border-radius:8px;background:rgba(6,14,18,.36)}
    .detail-label{font-size:.72rem;font-weight:760;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:8px}
    .detail-value{font-size:1rem;font-weight:650;line-height:1.35;overflow-wrap:anywhere}
    .danger-zone{border-color:rgba(255,123,103,.24);background:linear-gradient(180deg,rgba(57,18,18,.66),rgba(25,11,11,.8))}
    .center-card{max-width:540px;margin:72px auto}
    .center-card.center-wide{max-width:760px}
    @media(max-width:1080px){
      .hero{grid-template-columns:1fr}
      .nav-shell{justify-content:flex-start}
    }
    @media(max-width:860px){
      .shell{padding:18px 12px 36px}
      .hero{padding:22px 18px 18px;border-radius:24px}
      h1{max-width:none}
      .panel,.card{border-radius:20px}
      .grid,.row,.row-3{grid-template-columns:1fr}
      .cards{grid-template-columns:repeat(auto-fit,minmax(160px,1fr))}
      .toolbar{flex-direction:column;align-items:stretch}
      .toolbar .toolbar-actions{width:100%}
      .table-wrap{overflow:visible}
      table.table-stack{min-width:0}
      .table-stack thead{display:none}
      .table-stack,.table-stack tbody,.table-stack tr,.table-stack td{display:block;width:100%}
      .table-stack tr{padding:14px 16px;border-bottom:1px solid rgba(116,148,161,.12)}
      .table-stack tbody tr:last-child{border-bottom:none}
      .table-stack td{padding:8px 0;border:none;display:grid;grid-template-columns:minmax(88px,120px) minmax(0,1fr);gap:12px;align-items:start}
      .table-stack td::before{content:attr(data-label);font-size:.7rem;font-weight:760;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
      .table-stack td.cell-actions{display:block}
      .table-stack td.cell-actions::before{display:block;margin-bottom:8px}
    }
    @media(max-width:560px){
      .cards{grid-template-columns:1fr}
      .actions{flex-direction:column;align-items:stretch}
      .actions a,.actions form.inline{display:block;width:100%}
      .actions button,.toolbar button{width:100%}
      .nav-brand,.nav-links,.nav-shell form.inline{width:100%}
      .nav-brand,.nav-links{justify-content:center}
    }
  </style>
</head>
<body><div class="shell">${body}</div></body></html>`;
}

function wantsHtml(req) {
  return (req.header('accept') || '').includes('text/html');
}

function nav(page = '') {
  const link = (href, label, name) =>
    `<a href="${href}"${page === name ? ' class="active"' : ''}>${label}</a>`;
  return `<div class="nav-shell">
    <a href="/admin" class="nav-brand"><span style="display:flex;align-items:center;width:18px;height:18px;flex-shrink:0">${KEPTRA_LOGO_SVG}</span><span>Keptra Admin</span></a>
    <div class="nav-links">
      ${link('/admin', 'Dashboard', 'dashboard')}
      ${link('/admin/licenses', 'Licenses', 'licenses')}
      ${link('/admin/pricing', 'Pricing', 'pricing')}
      ${link('/admin/releases', 'Releases', 'releases')}
      ${link('/admin/health', 'Health', 'health')}
      ${link('/admin/customers', 'Customers', 'customers')}
    </div>
    <form class="inline" method="post" action="/admin/logout"><button type="submit">Log out</button></form>
  </div>`;
}

function statusPill(status) {
  const variants = { active: 1, live: 1, revoked: 1, expired: 1, draft: 1, disabled: 1, hidden: 1 };
  const value = String(status || 'unknown').toLowerCase();
  const cls = variants[value] ? ` pill-${value}` : '';
  return `<span class="pill${cls}">${escapeHtml(value)}</span>`;
}

function planPill(plan, expiresAt) {
  const label = inferPlanType(plan, expiresAt);
  const cls = label.toLowerCase();
  return `<span class="pill pill-${cls}">${escapeHtml(label)}</span>`;
}

function publicUpdatesBaseUrl() {
  const raw = String(process.env.PUBLIC_UPDATES_BASE_URL || 'https://keptra.z2hs.au').replace(/\/$/, '');
  return raw
    .replace(/^https:\/\/updates\.culler\.z2hs\.au/i, 'https://keptra.z2hs.au')
    .replace(/^https:\/\/admin\.culler\.z2hs\.au/i, 'https://keptra.z2hs.au')
    .replace(/^https:\/\/culler\.z2hs\.au/i, 'https://keptra.z2hs.au')
    .replace(/^https:\/\/updates\.keptra\.z2hs\.au/i, 'https://keptra.z2hs.au')
    .replace(/^https:\/\/admin\.keptra\.z2hs\.au/i, 'https://keptra.z2hs.au');
}

function publicReleaseUrl(version) {
  return `${publicUpdatesBaseUrl()}/releases/${version}`;
}

function normalizePublicKeptraUrl(value) {
  if (!value) return value;
  const base = publicUpdatesBaseUrl();
  return String(value)
    .replace(/^https:\/\/updates\.culler\.z2hs\.au/i, base)
    .replace(/^https:\/\/admin\.culler\.z2hs\.au/i, base)
    .replace(/^https:\/\/culler\.z2hs\.au/i, 'https://keptra.z2hs.au')
    .replace(/^https:\/\/updates\.keptra\.z2hs\.au/i, base)
    .replace(/^https:\/\/admin\.keptra\.z2hs\.au/i, base);
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
  if (value === 'win32' || value === 'win') return 'windows';
  if (value === 'darwin' || value === 'mac' || value === 'osx') return 'macos';
  throw new Error('Platform must be windows or macos.');
}

function normalizePublicPlatform(platform, fallback = null) {
  if (!platform) return fallback;
  try {
    return normalizeReleasePlatform(platform);
  } catch {
    return fallback;
  }
}

function isPathInside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function githubDownloadPrefix() {
  if (!hasGitHubReleaseConfig()) return null;
  return `https://github.com/${githubRepoOwner}/${githubRepoName}/releases/download/`;
}

function normalizeArtifactUrl(value, platform) {
  const normalizedPlatform = normalizeReleasePlatform(platform);
  const normalized = normalizePublicKeptraUrl(value);
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('Artifact URL must be a valid URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Artifact URL must use HTTPS.');
  }

  const artifactHosts = new Set([
    'keptra.z2hs.au',
    'updates.keptra.z2hs.au',
    'culler.z2hs.au',
    'updates.culler.z2hs.au',
  ]);
  const artifactPathPrefix = `/artifacts/${normalizedPlatform}/`;
  if (artifactHosts.has(parsed.hostname) && parsed.pathname.startsWith(artifactPathPrefix)) {
    return normalized;
  }

  const ghPrefix = githubDownloadPrefix();
  if (ghPrefix && normalized.startsWith(ghPrefix)) {
    return normalized;
  }

  throw new Error('Artifact URL must point to a Keptra artifact or the configured GitHub release repository.');
}

function signSession(payload) {
  return jwt.sign(payload, sessionSecret, { expiresIn: '12h' });
}

function signDownloadToken(payload) {
  return jwt.sign(payload, updateSecret, { expiresIn: '7d' });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return value.slice(0, 10);
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

function compareLicenseDate(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function issuedDateForRecord(record) {
  return normalizeLicenseDate(record?.issued_at)
    || normalizeLicenseDate(record?.created_at)
    || null;
}

function latestDeviceExpiry(rows) {
  let latest = null;
  for (const row of rows || []) {
    const normalized = normalizeLicenseDate(row?.expires_at);
    if (!normalized) continue;
    if (!latest || compareLicenseDate(normalized, latest) > 0) {
      latest = normalized;
    }
  }
  return latest;
}

function isActiveOnDate(expiresAt, today = normalizeLicenseDate(new Date().toISOString())) {
  const normalized = normalizeLicenseDate(expiresAt);
  if (!normalized) return true;
  return compareLicenseDate(normalized, today) >= 0;
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

function normalizeActivationCode(value) {
  return String(value || '').trim().toUpperCase();
}

function parseMaxDevices(value, fallback = 1) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error('Max devices must be a whole number greater than 0.');
  }
  return parsed;
}

function safeParseMaxDevices(value, fallback = 1) {
  try {
    return parseMaxDevices(value, fallback);
  } catch {
    return fallback;
  }
}

function parseCheckoutMaxDevices(value, fallback = defaultMaxDevices) {
  const parsed = parseMaxDevices(value, fallback);
  if (parsed > checkoutMaxDevices) {
    throw new Error(`Device count must be between ${defaultMaxDevices} and ${checkoutMaxDevices}.`);
  }
  return parsed;
}

function normalizePlanValue(value) {
  const plan = String(value || '').trim().toLowerCase();
  if (!plan || plan === 'custom' || plan === 'timed') return null;
  if (!['trial', 'monthly', 'yearly', 'lifetime'].includes(plan)) {
    throw new Error('Plan must be trial, monthly, yearly, lifetime, or custom.');
  }
  return plan;
}

function toLicenseInputDate(value) {
  const normalized = normalizeLicenseDate(value);
  return normalized ? formatLicenseDate(normalized) : undefined;
}

function createLicenseKey({ name, email, expiry, notes, maxDevices, issuedAt }) {
  if (!canGenerateLicenses()) {
    throw new Error('License generation is not enabled on this server.');
  }
  if (!name || !name.trim()) {
    throw new Error('Customer name is required.');
  }

  const normalizedIssuedAt = normalizeLicenseDate(issuedAt || todayLicenseDate());
  if (!normalizedIssuedAt) {
    throw new Error('Issued date must use DD-MM-YYYY.');
  }
  const normalizedExpiry = expiry ? normalizeLicenseDate(expiry) : undefined;
  if (expiry && !normalizedExpiry) {
    throw new Error('Expiry must use DD-MM-YYYY.');
  }

  const payload = {
    n: name.trim(),
    i: normalizedIssuedAt,
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

function nextLicenseStatus(currentStatus, expiresAt) {
  if (currentStatus === 'revoked' || currentStatus === 'disabled') {
    return currentStatus;
  }
  if (expiresAt && compareLicenseDate(expiresAt, todayLicenseDate()) < 0) {
    return 'expired';
  }
  return 'active';
}

function buildUpdatedLicenseRecord(record, changes = {}) {
  const customerName = String(changes.customerName ?? record.customer_name ?? '').trim();
  if (!customerName) {
    throw new Error('Customer name is required.');
  }

  const customerEmailInput = changes.customerEmail ?? record.customer_email ?? '';
  const customerEmail = String(customerEmailInput || '').trim() || null;
  if (customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
    throw new Error('Customer email must be valid.');
  }
  const notesInput = changes.notes ?? record.notes ?? '';
  const notes = String(notesInput || '').trim() || null;
  const maxDevices = parseMaxDevices(changes.maxDevices ?? record.max_devices ?? 1, 1);
  const plan = changes.plan === undefined ? normalizePlanValue(record.plan) : normalizePlanValue(changes.plan);
  let expiresAt = changes.expiresAt === undefined
    ? normalizeLicenseDate(record.expires_at)
    : normalizeLicenseDate(changes.expiresAt);

  if (changes.expiresAt && !expiresAt) {
    throw new Error('Expiry must use YYYY-MM-DD.');
  }
  if (plan === 'lifetime') {
    expiresAt = null;
  }
  if ((plan === 'trial' || plan === 'monthly' || plan === 'yearly') && !expiresAt) {
    throw new Error('Trial, monthly, and yearly plans require an expiry date.');
  }

  const issuedAt = issuedDateForRecord(record) || todayLicenseDate();
  const licenseKey = createLicenseKey({
    name: customerName,
    email: customerEmail,
    expiry: toLicenseInputDate(expiresAt),
    notes,
    maxDevices,
    issuedAt,
  });
  const validated = validateLicenseKey(licenseKey, licensePublicKeyPem);
  if (!validated.valid) {
    throw new Error(validated.message || 'Key re-generation failed.');
  }

  return {
    customerName,
    customerEmail,
    expiresAt,
    issuedAt,
    licenseKey,
    maxDevices,
    notes,
    plan,
    status: nextLicenseStatus(record.status, expiresAt),
  };
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
  if (!token) return res.redirect(HOME_URL);
  try {
    req.admin = jwt.verify(token, sessionSecret);
    return next();
  } catch {
    return res.redirect(HOME_URL);
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
         issued_at = COALESCE(license_records.issued_at, EXCLUDED.issued_at),
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
  const normalizedCode = normalizeActivationCode(activationCode);
  if (!normalizedCode) return null;
  const result = await pool.query(
    `SELECT lr.id,
            lr.fingerprint,
            lr.license_key,
            lr.activation_code,
            lr.customer_name,
            lr.customer_email,
            lr.issued_at,
            lr.created_at,
            COALESCE(NULLIF(lr.plan, ''), ss.plan) AS plan,
            lr.max_devices,
            lr.expires_at,
            lr.status,
            lr.notes,
            lr.last_seen_at
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
    [normalizedCode],
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
     ORDER BY last_seen_at DESC, id DESC`,
    [fingerprint],
  );
  const rows = activations.rows;
  const currentDevice = deviceId ? rows.find((row) => row.device_id === deviceId) || null : null;
  const activeRows = rows.filter((row) => isActiveOnDate(row.expires_at));
  return {
    count: activeRows.length,
    rows,
    activeRows,
    currentDevice,
    currentDeviceRegistered: Boolean(currentDevice),
    currentDeviceActive: currentDevice ? isActiveOnDate(currentDevice.expires_at) : false,
    latestExpiry: latestDeviceExpiry(rows),
  };
}

async function registerActivation(fingerprint, deviceId, deviceName) {
  if (!deviceId) return;
  await pool.query(
    `INSERT INTO license_activations (license_fingerprint, device_id, device_name, expires_at, first_seen_at, last_seen_at, updated_at)
     VALUES ($1,$2,$3,(SELECT expires_at FROM license_records WHERE fingerprint = $1),NOW(),NOW(),NOW())
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
  if (deviceId && summary.currentDeviceRegistered && !summary.currentDeviceActive) {
    return {
      ok: false,
      status: 403,
      message: `This device expired on ${formatLicenseDate(summary.currentDevice.expires_at)}.`,
      fingerprint,
      validated,
      record,
      activation: {
        count: summary.count,
        currentDeviceRegistered: true,
        currentDeviceActive: false,
        currentDevice: summary.currentDevice,
        maxDevices,
        devices: summary.rows,
        latestExpiry: summary.latestExpiry,
      },
    };
  }
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
        currentDeviceActive: false,
        currentDevice: null,
        maxDevices,
        devices: summary.rows,
        latestExpiry: summary.latestExpiry,
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
      currentDeviceActive: freshSummary.currentDeviceActive,
      currentDevice: freshSummary.currentDevice,
      maxDevices,
      devices: freshSummary.rows,
      latestExpiry: freshSummary.latestExpiry,
    },
  };
}

async function latestRelease(platform, channel) {
  const releases = await liveReleases({ platform, channel, limit: 1 });
  return releases[0] || null;
}

function listWindowsArtifacts() {
  const dir = path.join(artifactsRoot, 'windows');
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(exe|nupkg|zip|msi)$/i.test(entry.name))
      .map((entry) => {
        const fullPath = path.join(dir, entry.name);
        const stat = fs.statSync(fullPath);
        return { name: entry.name, size: stat.size, modifiedAt: stat.mtime };
      })
      .sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  } catch (_error) {
    return [];
  }
}

async function collectAdminHealth() {
  const latestWindows = await latestRelease('windows', 'stable').catch(() => null);
  const artifacts = listWindowsArtifacts();
  const liveArtifactName = latestWindows?.artifact_url ? path.basename(String(latestWindows.artifact_url).split('?')[0]) : '';
  const liveArtifact = liveArtifactName
    ? artifacts.find((artifact) => artifact.name === decodeURIComponent(liveArtifactName))
    : null;
  const updateUrl = `${publicUpdatesBaseUrl()}/api/v1/app/update?platform=windows&version=1.4.0&channel=stable`;
  const legacyUrl = 'https://updates.culler.z2hs.au/api/v1/app/update?platform=windows&version=1.4.0&channel=stable';

  return {
    secrets: [
      { label: 'ADMIN_SESSION_SECRET', ok: sessionSecret.length >= 32, detail: `${sessionSecret.length} chars` },
      { label: 'UPDATE_TOKEN_SECRET', ok: updateSecret.length >= 32, detail: `${updateSecret.length} chars` },
      { label: 'LICENSE_PUBLIC_KEY', ok: !!licensePublicKeyPem, detail: licensePublicKeyPem ? 'loaded' : 'missing' },
      { label: 'LICENSE_PRIVATE_KEY', ok: !!licensePrivateKeyPem, detail: licensePrivateKeyPem ? 'loaded for admin minting' : 'not loaded' },
      { label: 'ADMIN_API_TOKEN', ok: adminApiToken.length >= 24, detail: adminApiToken ? `${adminApiToken.length} chars` : 'optional API token not set' },
    ],
    release: {
      latest: latestWindows,
      artifactCount: artifacts.length,
      artifacts: artifacts.slice(0, 6),
      liveArtifact,
    },
    endpoints: [
      { label: 'Primary update metadata', ok: !!latestWindows, detail: updateUrl },
      { label: 'Legacy Culler compatibility', ok: true, detail: legacyUrl },
      { label: 'Latest semver selection', ok: !!latestWindows?.version, detail: latestWindows?.version || 'No live Windows stable release' },
      { label: 'Release artifact availability', ok: !!liveArtifact || !!latestWindows?.artifact_url, detail: liveArtifact ? `${liveArtifact.name} (${formatBytes(liveArtifact.size)})` : latestWindows?.artifact_url || 'No live artifact URL' },
    ],
  };
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

function releaseVersionParts(version) {
  return String(version || '')
    .trim()
    .replace(/^v/i, '')
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}

function compareReleaseRows(a, b) {
  const aParts = releaseVersionParts(a.version);
  const bParts = releaseVersionParts(b.version);
  const length = Math.max(aParts.length, bParts.length, 3);
  for (let i = 0; i < length; i += 1) {
    const delta = (bParts[i] || 0) - (aParts[i] || 0);
    if (delta !== 0) return delta;
  }
  const publishedDelta = new Date(b.published_at).getTime() - new Date(a.published_at).getTime();
  if (publishedDelta !== 0) return publishedDelta;
  return Number(b.id || 0) - Number(a.id || 0);
}

async function liveReleases({ platform = null, channel = 'stable', limit = 10 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
  const rows = await pool.query(
    `SELECT *
     FROM releases
     WHERE ($1::text IS NULL OR platform = $1)
       AND channel = $2
       AND rollout_state = 'live'
     ORDER BY published_at DESC, id DESC`,
    [platform, channel],
  );
  return rows.rows.sort(compareReleaseRows).slice(0, safeLimit);
}

function serializePublicRelease(row) {
  return {
    version: row.version,
    releaseName: row.release_name,
    notes: row.release_notes,
    releaseUrl: normalizePublicKeptraUrl(row.release_url),
    artifactUrl: normalizePublicKeptraUrl(row.artifact_url),
    publishedAt: row.published_at,
    channel: row.channel,
    platform: row.platform,
  };
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

  const safeRelease = serializePublicRelease(release);
  return res.send(htmlPage(`${escapeHtml(safeRelease.releaseName)} (${escapeHtml(safeRelease.version)})`, `
    <div class="panel" style="max-width:760px;margin:48px auto">
      <h1>${escapeHtml(safeRelease.releaseName)}</h1>
      <p class="muted">Version ${escapeHtml(safeRelease.version)} - ${escapeHtml(safeRelease.platform)} - ${escapeHtml(safeRelease.channel)} - ${fmtDate(safeRelease.publishedAt)}</p>
      ${safeRelease.notes ? `<pre style="white-space:pre-wrap;background:#020617;border:1px solid #334155;border-radius:12px;padding:14px;margin-top:16px">${escapeHtml(safeRelease.notes)}</pre>` : '<p class="muted">No release notes were provided for this version.</p>'}
      <div class="actions" style="margin-top:16px">
        <a href="${escapeHtml(safeRelease.artifactUrl)}"><button type="button">Download installer</button></a>
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
    <div class="center-card">
      <div class="panel">
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:24px">
          <span style="display:flex;align-items:center;justify-content:center;width:44px;height:44px;flex-shrink:0;border-radius:14px;background:rgba(96,199,178,.14);border:1px solid var(--border)">${KEPTRA_LOGO_SVG}</span>
          <div>
            <div class="hero-kicker" style="margin-bottom:4px">Hosted admin</div>
            <div style="font-weight:780;font-size:1.15rem;letter-spacing:0">Keptra</div>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:22px">
          <h1 style="font-size:2rem;max-width:none">Sign in</h1>
          <p class="muted">Manage licenses, pricing, releases, and install activity from one place.</p>
        </div>
        <form method="post" action="/admin/login">
          <label>Email</label>
          <input type="email" name="email" required autofocus autocomplete="username" />
          <div style="height:12px"></div>
          <label>Password</label>
          <input type="password" name="password" required autocomplete="current-password" />
          <div style="height:18px"></div>
          <button type="submit" style="width:100%">Enter admin</button>
        </form>
        <div class="notice" style="margin-top:16px">
          <p class="muted">This panel controls live licensing and update delivery for <code>keptra.z2hs.au</code>.</p>
        </div>
      </div>
    </div>
  `));
});

app.post('/admin/login', async (req, res) => {
  const { email, password } = req.body;
  const result = await pool.query('SELECT * FROM admin_users WHERE email = $1', [email]);
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).send(htmlPage('Admin Login', `
      <div class="center-card">
        <div class="panel">
          <div style="display:flex;align-items:center;gap:14px;margin-bottom:24px">
            <span style="display:flex;align-items:center;justify-content:center;width:44px;height:44px;flex-shrink:0;border-radius:14px;background:rgba(255,123,103,.14);border:1px solid rgba(255,123,103,.22)">${KEPTRA_LOGO_SVG}</span>
            <div>
              <div class="hero-kicker" style="margin-bottom:4px;color:var(--danger)">Access denied</div>
              <div style="font-weight:780;font-size:1.15rem;letter-spacing:0">Keptra</div>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:18px">
            <h1 style="font-size:2rem;max-width:none">Sign in</h1>
            <p class="muted">Check your email and password, then try again.</p>
          </div>
          <div class="notice danger" style="margin-bottom:18px">
            <p class="bad">Invalid email or password.</p>
          </div>
          <a href="/admin/login"><button type="button" style="width:100%">Try again</button></a>
        </div>
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
  const diskBar = disk ? `<div style="margin-top:10px;background:rgba(255,255,255,.06);border-radius:999px;height:8px;overflow:hidden"><div style="width:${diskPct}%;background:${diskPct > 85 ? '#ff9d8d' : diskPct > 65 ? '#ffd08a' : '#60c7b2'};height:100%;border-radius:999px"></div></div><p class="muted" style="margin-top:8px">${formatBytes(disk.used)} used of ${formatBytes(disk.total)} (${disk.pct})</p>` : '';

  const stripeRow = stripeStats.rows[0] || { total_customers: 0, total_licenses: 0, licenses_30d: 0 };
  const plans = subStats.rows.reduce((acc, row) => { acc[row.plan] = row.cnt; return acc; }, { monthly: 0, yearly: 0, lifetime: 0 });
  const licenseCounts = licenseStats.rows.reduce((acc, row) => {
    acc[row.status] = Number(row.count || 0);
    return acc;
  }, {});
  const totalLicenses = Object.values(licenseCounts).reduce((sum, count) => sum + Number(count || 0), 0);
  const releaseCounts = releaseStats.rows.reduce((acc, row) => {
    const key = `${row.platform}_${row.rollout_state}`;
    acc[key] = Number(row.count || 0);
    acc.total += Number(row.count || 0);
    return acc;
  }, { total: 0 });
  const totalDevices = Number(deviceCount.rows[0]?.count || 0);
  const stripeCustomers = Number(stripeRow.total_customers || 0);
  const stripeLicenses = Number(stripeRow.total_licenses || 0);
  const stripeRecent = Number(stripeRow.licenses_30d || 0);

  res.send(htmlPage('Admin Dashboard', `
    <div class="hero">
      <div class="hero-copy">
        <div class="hero-kicker">Control room</div>
        <h1>Hosted admin overview</h1>
        <p>Track license health, release rollout, Stripe activity, and update delivery without digging through crowded tables.</p>
        <div class="hero-meta">
          <span class="hero-note">${totalLicenses} licenses tracked</span>
          <span class="hero-note">${totalDevices} devices registered</span>
          <span class="hero-note">${releaseCounts.total} release entries</span>
        </div>
      </div>
      ${nav('dashboard')}
    </div>
    <div class="cards">
      <div class="card">
        <div>
          <div class="card-label">License health</div>
          <div class="card-value">${totalLicenses}</div>
          <div class="card-note">Stored customer licenses</div>
        </div>
        <div class="metric-list">
          <div class="metric-row"><span>Active</span><strong>${licenseCounts.active || 0}</strong></div>
          <div class="metric-row"><span>Revoked</span><strong>${licenseCounts.revoked || 0}</strong></div>
          <div class="metric-row"><span>Expired / disabled</span><strong>${(licenseCounts.expired || 0) + (licenseCounts.disabled || 0)}</strong></div>
        </div>
      </div>
      <div class="card">
        <div>
          <div class="card-label">Release rollout</div>
          <div class="card-value">${releaseCounts.total}</div>
          <div class="card-note">Entries across Windows and macOS</div>
        </div>
        <div class="metric-list">
          <div class="metric-row"><span>Windows live / draft</span><strong>${releaseCounts.windows_live || 0} / ${releaseCounts.windows_draft || 0}</strong></div>
          <div class="metric-row"><span>macOS live / draft</span><strong>${releaseCounts.macos_live || 0} / ${releaseCounts.macos_draft || 0}</strong></div>
          <div class="metric-row"><span>Hidden</span><strong>${(releaseCounts.windows_hidden || 0) + (releaseCounts.macos_hidden || 0)}</strong></div>
        </div>
      </div>
      <div class="card">
        <div>
          <div class="card-label">Storage & devices</div>
          <div class="card-value">${formatBytes(artifactSize)}</div>
          <div class="card-note">Artifacts currently hosted</div>
        </div>
        <div class="metric-list">
          <div class="metric-row"><span>Registered devices</span><strong>${totalDevices}</strong></div>
          <div class="metric-row"><span>Disk free</span><strong>${disk ? formatBytes(disk.available) : 'Unknown'}</strong></div>
        </div>
      </div>
      <div class="card">
        <div>
          <div class="card-label">Stripe snapshot</div>
          <div class="card-value">${stripeLicenses}</div>
          <div class="card-note">Captured paid licenses</div>
        </div>
        <div class="metric-list">
          <div class="metric-row"><span>Customers</span><strong>${stripeCustomers}</strong></div>
          <div class="metric-row"><span>Last 30 days</span><strong>${stripeRecent}</strong></div>
          <div class="metric-row"><span>Plans (90d)</span><strong>${plans.monthly}/${plans.yearly}/${plans.lifetime}</strong></div>
        </div>
      </div>
    </div>

    <div class="grid">
      <div class="panel">
        <div class="panel-head">
          <div>
            <h2>Storage</h2>
            <p class="muted">Keep an eye on artifact usage before new builds land.</p>
          </div>
        </div>
        <div class="detail-grid">
          <div class="detail-item">
            <div class="detail-label">Artifacts</div>
            <div class="detail-value">${formatBytes(artifactSize)}</div>
          </div>
          ${disk ? `<div class="detail-item">
            <div class="detail-label">Disk free</div>
            <div class="detail-value" style="color:${diskPct > 85 ? 'var(--danger)' : diskPct > 65 ? 'var(--warning)' : 'var(--text)'}">${formatBytes(disk.available)}</div>
          </div>` : ''}
        </div>
        ${diskBar}
      </div>
      <div class="panel">
        <div class="panel-head">
          <div>
            <h2>Recently active licenses</h2>
            <p class="muted">The most recently seen customers and how many devices they occupy.</p>
          </div>
        </div>
        <div class="table-wrap">
          <table class="table-stack">
            <thead><tr><th>Customer</th><th>Status</th><th>Devices</th><th>Last seen</th></tr></thead>
            <tbody>
            ${topLicenses.rows.map((row) => `<tr>
              <td data-label="Customer">${row.customer_name}</td>
              <td data-label="Status">${statusPill(row.status)}</td>
              <td data-label="Devices">${row.device_count}</td>
              <td data-label="Last seen" class="muted">${row.last_seen_at ? fmtTime(row.last_seen_at) : 'Never'}</td>
            </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
    <div class="grid">
      <div class="panel">
        <div class="panel-head">
          <div>
            <h2>Recent update activity</h2>
            <p class="muted">The latest requests hitting the updater and API endpoints.</p>
          </div>
        </div>
        <div class="table-wrap">
          <table class="table-stack">
            <thead><tr><th>Event</th><th>Detail</th><th>Time</th></tr></thead>
            <tbody>
            ${recentEvents.rows.map((row) => `<tr>
              <td data-label="Event">${row.event_type}</td>
              <td data-label="Detail" class="muted">${row.detail || '—'}</td>
              <td data-label="Time" class="muted">${fmtTime(row.created_at)}</td>
            </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
      ${errorEvents.rows.length > 0 ? `<div class="panel">
        <div class="panel-head">
          <div>
            <h2>Blocked or failed events</h2>
            <p class="muted">Quick triage for rejected requests and failed update checks.</p>
          </div>
          <span class="pill pill-revoked">${errorEvents.rows.length} recent</span>
        </div>
        <div class="table-wrap">
          <table class="table-stack">
            <thead><tr><th>Event</th><th>Detail</th><th>Time</th></tr></thead>
            <tbody>
            ${errorEvents.rows.map((row) => `<tr>
              <td data-label="Event" class="bad">${row.event_type}</td>
              <td data-label="Detail" class="muted">${row.detail || '—'}</td>
              <td data-label="Time" class="muted">${fmtTime(row.created_at)}</td>
            </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>` : `<div class="panel">
        <div class="panel-head">
          <div>
            <h2>Plan mix</h2>
            <p class="muted">Recent plan selection from Stripe activity over the last 90 days.</p>
          </div>
        </div>
        <div class="detail-grid">
          <div class="detail-item">
            <div class="detail-label">Monthly</div>
            <div class="detail-value">${plans.monthly}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Yearly</div>
            <div class="detail-value">${plans.yearly}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Lifetime</div>
            <div class="detail-value">${plans.lifetime}</div>
          </div>
        </div>
      </div>`}
    </div>
  `));
});

app.get('/admin/health', authSession, async (_req, res) => {
  const health = await collectAdminHealth();
  const indicator = (ok) => statusPill(ok ? 'live' : 'revoked');
  res.send(htmlPage('Admin Health', `
    <div class="hero">
      <div class="hero-copy">
        <div class="hero-kicker">Release Safety</div>
        <h1>Admin health</h1>
        <p>Check the pieces that must be ready before publishing or troubleshooting client updates.</p>
      </div>
      ${nav('health')}
    </div>
    <div class="grid">
      <div class="panel">
        <div class="panel-head">
          <div>
            <h2>Required secrets</h2>
            <p class="muted">Server startup already blocks unsafe secret defaults. This page shows the live state.</p>
          </div>
        </div>
        <div class="table-wrap">
          <table class="table-stack">
            <thead><tr><th>Check</th><th>Status</th><th>Detail</th></tr></thead>
            <tbody>
              ${health.secrets.map((item) => `<tr>
                <td data-label="Check">${escapeHtml(item.label)}</td>
                <td data-label="Status">${indicator(item.ok)}</td>
                <td data-label="Detail" class="muted">${escapeHtml(item.detail)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head">
          <div>
            <h2>Update endpoints</h2>
            <p class="muted">Windows 1.4.0 clients and legacy Culler-hosted clients must resolve cleanly.</p>
          </div>
        </div>
        <div class="table-wrap">
          <table class="table-stack">
            <thead><tr><th>Check</th><th>Status</th><th>Detail</th></tr></thead>
            <tbody>
              ${health.endpoints.map((item) => `<tr>
                <td data-label="Check">${escapeHtml(item.label)}</td>
                <td data-label="Status">${indicator(item.ok)}</td>
                <td data-label="Detail" class="muted"><code>${escapeHtml(item.detail)}</code></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
    <div class="grid">
      <div class="panel">
        <div class="panel-head">
          <div>
            <h2>Latest Windows stable</h2>
            <p class="muted">The release selected for update checks.</p>
          </div>
          ${indicator(!!health.release.latest)}
        </div>
        ${health.release.latest ? `
          <div class="detail-grid">
            <div class="detail-item"><div class="detail-label">Version</div><div class="detail-value">${escapeHtml(health.release.latest.version)}</div></div>
            <div class="detail-item"><div class="detail-label">State</div><div class="detail-value">${escapeHtml(health.release.latest.rollout_state || 'live')}</div></div>
            <div class="detail-item"><div class="detail-label">Artifact</div><div class="detail-value" style="font-size:.95rem">${escapeHtml(path.basename(String(health.release.latest.artifact_url || '')))}</div></div>
          </div>
        ` : '<p class="bad">No live Windows stable release was found.</p>'}
      </div>
      <div class="panel">
        <div class="panel-head">
          <div>
            <h2>Artifact availability</h2>
            <p class="muted">Newest local Windows installer files under the artifact root.</p>
          </div>
          <span class="pill pill-live">${health.release.artifactCount} files</span>
        </div>
        <div class="table-wrap">
          <table class="table-stack">
            <thead><tr><th>File</th><th>Size</th><th>Modified</th></tr></thead>
            <tbody>
              ${health.release.artifacts.map((artifact) => `<tr>
                <td data-label="File">${escapeHtml(artifact.name)}</td>
                <td data-label="Size" class="muted">${formatBytes(artifact.size)}</td>
                <td data-label="Modified" class="muted">${fmtTime(artifact.modifiedAt)}</td>
              </tr>`).join('') || '<tr><td colspan="3" class="muted">No Windows artifacts found.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `));
});

app.get('/admin/licenses', authSession, async (req, res) => {
  const queryValue = String(req.query.q || '').trim();
  const rawStatus = String(req.query.status || '').trim().toLowerCase();
  const rawPlan = String(req.query.plan || '').trim().toLowerCase();
  const statusValue = ['active', 'revoked', 'expired', 'disabled'].includes(rawStatus) ? rawStatus : '';
  const planValue = ['trial', 'monthly', 'yearly', 'lifetime', 'timed'].includes(rawPlan) ? rawPlan : '';
  const params = [];
  const filters = [];
  if (queryValue) {
    params.push(`%${queryValue}%`);
    const idx = params.length;
    filters.push(`(
      customer_name ILIKE $${idx}
      OR COALESCE(customer_email, '') ILIKE $${idx}
      OR COALESCE(activation_code, '') ILIKE $${idx}
    )`);
  }
  if (statusValue) {
    params.push(statusValue);
    filters.push(`status = $${params.length}`);
  }
  if (planValue === 'timed') {
    filters.push(`(COALESCE(plan, '') = '' AND expires_at IS NOT NULL)`);
  } else if (planValue) {
    params.push(planValue);
    filters.push(`plan = $${params.length}`);
  }

  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const [licenseResult, stripeLicensesResult, licenseOverview] = await Promise.all([
    pool.query(`SELECT * FROM license_records ${whereClause} ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT 200`, params),
    pool.query('SELECT session_id, license_key, activation_code, customer_email, created_at FROM stripe_sessions ORDER BY created_at DESC LIMIT 50').catch(() => ({ rows: [] })),
    pool.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE status = 'active')::int AS active,
             COUNT(*) FILTER (WHERE status = 'revoked')::int AS revoked,
             COUNT(*) FILTER (WHERE status = 'expired')::int AS expired,
             COUNT(*) FILTER (WHERE status = 'disabled')::int AS disabled,
             COUNT(*) FILTER (WHERE plan = 'trial')::int AS trial,
             COUNT(*) FILTER (WHERE plan = 'lifetime' OR (plan IS NULL AND expires_at IS NULL))::int AS lifetime,
             COUNT(*) FILTER (WHERE activation_code IS NULL)::int AS missing_codes
      FROM license_records
    `),
  ]);

  const generatorEnabled = canGenerateLicenses();
  const overview = licenseOverview.rows[0] || {
    total: 0,
    active: 0,
    revoked: 0,
    expired: 0,
    disabled: 0,
    trial: 0,
    lifetime: 0,
    missing_codes: 0,
  };
  const shownCount = licenseResult.rows.length;
  const hasFilters = Boolean(queryValue || statusValue || planValue);

  res.send(htmlPage('Licenses', `
    <div class="hero">
      <div class="hero-copy">
        <div class="hero-kicker">Licensing</div>
        <h1>Clean up licenses without fighting the UI.</h1>
        <p>Search, filter, generate, import, revoke, re-activate, or fully delete old records so the list stays understandable as your customer base grows.</p>
        <div class="hero-meta">
          <span class="hero-note">${shownCount}${hasFilters ? ` of ${overview.total}` : ''} licenses shown</span>
          <span class="hero-note">${overview.missing_codes} missing activation codes</span>
          <span class="hero-note">Default seats: ${defaultMaxDevices}</span>
        </div>
      </div>
      ${nav('licenses')}
    </div>

    <div class="cards">
      <div class="card">
        <div>
          <div class="card-label">Tracked licenses</div>
          <div class="card-value">${overview.total}</div>
          <div class="card-note">All stored license records</div>
        </div>
      </div>
      <div class="card">
        <div>
          <div class="card-label">Active</div>
          <div class="card-value">${overview.active}</div>
          <div class="card-note">Currently valid and usable</div>
        </div>
      </div>
      <div class="card">
        <div>
          <div class="card-label">Revoked</div>
          <div class="card-value">${overview.revoked}</div>
          <div class="card-note">Blocked from future use</div>
        </div>
      </div>
      <div class="card">
        <div>
          <div class="card-label">Trial / lifetime</div>
          <div class="card-value">${overview.trial} / ${overview.lifetime}</div>
          <div class="card-note">Plan mix that often needs support context</div>
        </div>
      </div>
      <div class="card">
        <div>
          <div class="card-label">Needs cleanup</div>
          <div class="card-value">${overview.missing_codes}</div>
          <div class="card-note">Records missing an activation code</div>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <div>
          <h2>Find licenses</h2>
          <p class="muted">Filter by customer name, email, or activation code to reduce noise before you review or delete records.</p>
        </div>
      </div>
      <form class="toolbar" method="get" action="/admin/licenses">
        <div class="grow">
          <label>Search</label>
          <input name="q" value="${escapeHtml(queryValue)}" placeholder="Search customer, email, or activation code" />
        </div>
        <div style="min-width:180px">
          <label>Status</label>
          <select name="status">
            <option value=""${statusValue ? '' : ' selected'}>All statuses</option>
            <option value="active"${statusValue === 'active' ? ' selected' : ''}>Active</option>
            <option value="revoked"${statusValue === 'revoked' ? ' selected' : ''}>Revoked</option>
            <option value="expired"${statusValue === 'expired' ? ' selected' : ''}>Expired</option>
            <option value="disabled"${statusValue === 'disabled' ? ' selected' : ''}>Disabled</option>
          </select>
        </div>
        <div style="min-width:180px">
          <label>Plan</label>
          <select name="plan">
            <option value=""${planValue ? '' : ' selected'}>All plans</option>
            <option value="trial"${planValue === 'trial' ? ' selected' : ''}>Trial</option>
            <option value="monthly"${planValue === 'monthly' ? ' selected' : ''}>Monthly</option>
            <option value="yearly"${planValue === 'yearly' ? ' selected' : ''}>Yearly</option>
            <option value="lifetime"${planValue === 'lifetime' ? ' selected' : ''}>Lifetime</option>
            <option value="timed"${planValue === 'timed' ? ' selected' : ''}>Timed/custom</option>
          </select>
        </div>
        <div class="toolbar-actions">
          <button type="submit">Apply filters</button>
          ${hasFilters ? `<a href="/admin/licenses"><button class="secondary" type="button">Reset</button></a>` : ''}
        </div>
      </form>
    </div>

    <div class="grid">
      <div class="panel">
        <div class="panel-head">
          <div>
            <h2>Generate license</h2>
            <p class="muted">Create a new customer key here. Expiry uses <code>DD-MM-YYYY</code>.</p>
          </div>
        </div>
        ${generatorEnabled
          ? `<form method="post" action="/admin/licenses/generate">
            <label>Customer name</label>
            <input name="name" required placeholder="Jane Smith" />
            <label>Email</label>
            <input type="email" name="email" placeholder="jane@example.com" />
            <div class="row row-3">
              <div>
                <label>Plan</label>
                <select name="plan">
                  <option value="lifetime">Lifetime</option>
                  <option value="monthly">Monthly</option>
                  <option value="yearly">Yearly</option>
                  <option value="trial">Trial</option>
                  <option value="">Custom / timed</option>
                </select>
              </div>
              <div>
                <label>Expiry <span style="font-weight:400">(optional)</span></label>
                <input name="expiry" placeholder="31-12-2027" />
              </div>
              <div>
                <label>Max devices</label>
                <input type="number" name="maxDevices" min="1" step="1" value="${defaultMaxDevices}" />
              </div>
            </div>
            <label>Notes <span style="font-weight:400">(optional)</span></label>
            <textarea name="notes" rows="2"></textarea>
            <div class="actions" style="margin-top:16px">
              <button type="submit">Generate and store</button>
            </div>
          </form>`
          : `<div class="notice warning">
            <p class="bad">License generation is disabled because <code>private.pem</code> is not mounted.</p>
            <p class="muted" style="margin-top:6px">You can still import already-generated keys below.</p>
          </div>`}
      </div>
      <div class="panel">
        <div class="panel-head">
          <div>
            <h2>Import existing license</h2>
            <p class="muted">Store a previously generated key so it can be managed from the admin panel.</p>
          </div>
        </div>
        <form method="post" action="/admin/licenses/import">
          <label>License key</label>
          <textarea name="licenseKey" rows="5" required placeholder="PI1-..."></textarea>
          <label>Notes <span style="font-weight:400">(optional)</span></label>
          <textarea name="notes" rows="2"></textarea>
          <div class="actions" style="margin-top:16px">
            <button type="submit">Store license</button>
          </div>
        </form>
      </div>
      <div class="panel">
        <div class="panel-head">
          <div>
            <h2>Status guide</h2>
            <p class="muted">Use revoke when you want to block a key, and delete when you want to remove clutter entirely.</p>
          </div>
        </div>
        <ul class="list">
          <li><span class="ok">Active</span> means updates and activation checks can proceed normally.</li>
          <li><span class="bad">Revoked</span> blocks the license immediately but keeps the record for history.</li>
          <li><span class="warn">Expired</span> mirrors a timed license or subscription that has lapsed.</li>
          <li><span style="color:#b1c1c8">Disabled</span> is useful for a temporary hold without full revocation.</li>
          <li>Deleting a license also removes its stored device activations, which is the quickest way to clear duplicates and dead records.</li>
        </ul>
      </div>
    </div>

    ${stripeLicensesResult.rows.length > 0 ? `<div class="panel">
      <div class="panel-head">
        <div>
          <h2>Recent Stripe licenses</h2>
          <p class="muted">The latest paid licenses mirrored from Stripe sessions.</p>
        </div>
      </div>
      <div class="table-wrap">
        <table class="table-stack">
          <thead><tr><th>Customer email</th><th>Activation code</th><th>License key</th><th>Issued</th></tr></thead>
          <tbody>
          ${stripeLicensesResult.rows.map((row) => `<tr>
            <td data-label="Customer email" class="muted">${row.customer_email}</td>
            <td data-label="Activation code"><code>${row.activation_code || '—'}</code></td>
            <td data-label="License key"><code>${row.license_key.substring(0, 40)}...</code></td>
            <td data-label="Issued" class="muted">${fmtTime(row.created_at)}</td>
          </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>` : ''}

    <div class="panel">
      <div class="panel-head">
        <div>
          <h2>All licenses</h2>
          <p class="muted">${hasFilters ? 'Filtered results below.' : 'Newest license activity appears first.'}</p>
        </div>
      </div>
      ${licenseResult.rows.length ? `<div class="table-wrap">
        <table class="table-stack">
          <thead><tr><th>Customer</th><th>Status</th><th>Plan</th><th>Seats</th><th>Activation code</th><th>Expires</th><th>Last seen</th><th>Actions</th></tr></thead>
          <tbody>
          ${licenseResult.rows.map((row) => `<tr>
            <td data-label="Customer"><span style="font-weight:700">${row.customer_name}</span>${row.customer_email ? `<div class="muted">${row.customer_email}</div>` : ''}</td>
            <td data-label="Status">${statusPill(row.status)}</td>
            <td data-label="Plan">${planPill(row.plan, row.expires_at)}</td>
            <td data-label="Seats" class="muted">${row.max_devices || '&infin;'} device${row.max_devices === 1 ? '' : 's'}</td>
            <td data-label="Activation code"><code>${row.activation_code || '—'}</code></td>
            <td data-label="Expires" class="muted">${formatLicenseDate(row.expires_at)}</td>
            <td data-label="Last seen" class="muted">${row.last_seen_at ? fmtTime(row.last_seen_at) : 'Never'}</td>
            <td data-label="Actions" class="cell-actions">
              <div class="actions">
                <a href="/admin/licenses/${row.id}"><button class="secondary sm" type="button">View</button></a>
              </div>
            </td>
          </tr>`).join('')}
          </tbody>
        </table>
      </div>` : `<div class="notice"><p class="muted">No licenses matched the current filters.</p></div>`}
    </div>
  `));
});

app.post('/admin/licenses/generate', authSession, async (req, res) => {
  try {
    const plan = normalizePlanValue(req.body.plan);
    const requestedExpiry = String(req.body.expiry || '').trim();
    const expiry = requestedExpiry || formatExpiryForLicense(calculatePlanExpiryDate(plan));
    const licenseKey = createLicenseKey({
      name: req.body.name,
      email: req.body.email,
      expiry,
      notes: req.body.notes,
      maxDevices: req.body.maxDevices,
    });
    const validated = validateLicenseKey(licenseKey, licensePublicKeyPem);
    if (!validated.valid) {
      throw new Error(validated.message || 'Generated key did not validate.');
    }

    const activationCode = await upsertLicenseRecord(validated, req.body.notes, plan);

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
  const issuedAt = issuedDateForRecord(record);
  const detailsExpiry = latestDeviceExpiry(activations.rows) || normalizeLicenseDate(record.expires_at);
  const editablePlan = record.plan || (detailsExpiry ? '' : 'lifetime');
  const editableExpiry = detailsExpiry || '';
  const hasActivations = activations.rowCount > 0;
  const activationCodeJson = JSON.stringify(record.activation_code || '');
  const manageLicenseHref = record.activation_code
    ? `/manage-license?code=${encodeURIComponent(record.activation_code)}`
    : '';
  return res.send(htmlPage(`License ${record.customer_name}`, `
    <div class="hero">
      <div class="hero-copy">
        <div class="hero-kicker">License</div>
        <h1>${record.customer_name}</h1>
        <p>Review entitlement details, device usage, extensions, and cleanup actions for this customer.</p>
        <div class="hero-meta">
          <span class="hero-note">Status: ${record.status}</span>
          <span class="hero-note">${activations.rowCount} registered device${activations.rowCount === 1 ? '' : 's'}</span>
          <span class="hero-note">${record.activation_code || 'No activation code'}</span>
        </div>
      </div>
      ${nav('licenses')}
    </div>
    <div class="grid">
      <div class="panel">
        <div class="panel-head">
          <div>
            <h2>Details</h2>
            <p class="muted">Everything tied to this stored license record.</p>
          </div>
          ${statusPill(record.status)}
        </div>
        <div class="detail-grid">
          <div class="detail-item">
            <div class="detail-label">Activation code</div>
            <div class="detail-value"><code>${record.activation_code || '—'}</code></div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Customer email</div>
            <div class="detail-value">${record.customer_email || '—'}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Plan</div>
            <div class="detail-value">${inferPlanType(record.plan, detailsExpiry)}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Issued</div>
            <div class="detail-value">${formatLicenseDate(issuedAt)}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Expires</div>
            <div class="detail-value">${formatLicenseDate(detailsExpiry)}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Seat limit</div>
            <div class="detail-value">${record.max_devices || '&infin;'} device${record.max_devices === 1 ? '' : 's'}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Devices seen</div>
            <div class="detail-value">${activations.rowCount}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Last seen</div>
            <div class="detail-value">${record.last_seen_at ? fmtTime(record.last_seen_at) : 'Never'}</div>
          </div>
        </div>
        <div class="actions" style="margin-top:14px">
          ${record.activation_code
            ? `<button class="secondary sm" type="button" onclick="navigator.clipboard && navigator.clipboard.writeText(${activationCodeJson})">Copy activation code</button>
               <a href="${manageLicenseHref}" target="_blank" rel="noreferrer"><button class="secondary sm" type="button">Open customer view</button></a>`
            : '<span class="muted">No activation code has been assigned to this record.</span>'}
        </div>
        <form method="post" action="/admin/licenses/${record.id}/entitlement" style="margin-top:18px">
          <div class="panel-head" style="margin-bottom:10px">
            <div>
              <h2>Edit entitlement</h2>
              <p class="muted">${hasActivations
                ? 'Changes here regenerate the stored key and sync expiry across registered devices so the record stays consistent.'
                : 'No devices are attached yet, so this is the fastest place to reshape the plan or expiry before first activation.'}</p>
            </div>
          </div>
          <div class="row">
            <div>
              <label>Customer name</label>
              <input name="customerName" value="${escapeHtml(record.customer_name)}" required />
            </div>
            <div>
              <label>Customer email</label>
              <input type="email" name="customerEmail" value="${escapeHtml(record.customer_email || '')}" placeholder="customer@example.com" />
            </div>
          </div>
          <div class="row row-3">
            <div>
              <label>Plan</label>
              <select name="plan">
                <option value=""${editablePlan ? '' : ' selected'}>Custom / timed</option>
                <option value="trial"${editablePlan === 'trial' ? ' selected' : ''}>Trial</option>
                <option value="monthly"${editablePlan === 'monthly' ? ' selected' : ''}>Monthly</option>
                <option value="yearly"${editablePlan === 'yearly' ? ' selected' : ''}>Yearly</option>
                <option value="lifetime"${editablePlan === 'lifetime' ? ' selected' : ''}>Lifetime</option>
              </select>
            </div>
            <div>
              <label>Expiry</label>
              <input type="date" name="expiresAt" value="${editableExpiry}" />
            </div>
            <div>
              <label>Max devices</label>
              <input type="number" name="maxDevices" min="1" step="1" value="${record.max_devices || 1}" />
            </div>
          </div>
          <label>Notes</label>
          <textarea name="notes" rows="3" placeholder="Internal notes shown in the admin panel">${escapeHtml(record.notes || '')}</textarea>
          <div class="actions" style="margin-top:14px">
            <button type="submit">Save license details</button>
          </div>
        </form>
      </div>
      <div class="stack">
        <div class="panel">
          <div class="panel-head">
            <div>
              <h2>Extend license</h2>
              <p class="muted">Adds time to the current expiry, regenerates the key, and emails the customer.</p>
            </div>
          </div>
          <form method="post" action="/admin/licenses/${record.id}/extend">
            <div class="row row-bottom">
              <div>
                <label>Amount</label>
                <input type="number" name="amount" min="1" step="1" value="1" />
              </div>
              <div>
                <label>Unit</label>
                <select name="unit">
                  <option value="months">Months</option>
                  <option value="years">Years</option>
                  <option value="days">Days</option>
                </select>
              </div>
            </div>
            <div class="actions" style="margin-top:14px">
              <button type="submit">Extend and email customer</button>
            </div>
          </form>
        </div>
        <div class="panel">
          <div class="panel-head">
            <div>
              <h2>Stored key</h2>
              <p class="muted">The exact license key currently stored for this record.</p>
            </div>
          </div>
          <textarea rows="8" readonly>${record.license_key}</textarea>
        </div>
        <div class="panel danger-zone">
          <div class="panel-head">
            <div>
              <h2>Danger zone</h2>
              <p class="muted">Use these only when the customer should lose access or the record should be removed entirely.</p>
            </div>
          </div>
          <div class="actions" style="margin-bottom:14px">
            ${record.status !== 'revoked' ? `<form class="inline" method="post" action="/admin/licenses/${record.id}/revoke" onsubmit="return confirm('Revoke this license now? The customer will no longer be able to activate or validate it.')"><button class="secondary sm" type="submit">Revoke license</button></form>` : ''}
            ${record.status !== 'active' ? `<form class="inline" method="post" action="/admin/licenses/${record.id}/activate"><button class="secondary sm" type="submit">Re-activate license</button></form>` : ''}
          </div>
          <form method="post" action="/admin/licenses/${record.id}/delete" onsubmit="return confirm('Delete this license and all device activations? This cannot be undone.')">
            <button class="danger" type="submit">Delete this license</button>
          </form>
        </div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head">
        <div>
          <h2>Registered devices</h2>
          <p class="muted">Per-device registration history and optional device-level expiry overrides.</p>
        </div>
      </div>
      ${activations.rowCount
        ? `<div class="table-wrap">
            <table class="table-stack">
              <thead><tr><th>Device</th><th>Device ID</th><th>First seen</th><th>Last seen</th><th>Device expiry</th><th>Actions</th></tr></thead><tbody>
              ${activations.rows.map((row) => `<tr>
                <td data-label="Device">${row.device_name || 'Unnamed device'}</td>
                <td data-label="Device ID"><code>${row.device_id}</code></td>
                <td data-label="First seen" class="muted">${fmtTime(row.first_seen_at)}</td>
                <td data-label="Last seen" class="muted">${fmtTime(row.last_seen_at)}</td>
                <td data-label="Device expiry">
                  <form class="inline" method="post" action="/admin/licenses/${record.id}/devices/${row.id}/expiry" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                    <input type="date" name="expiresAt" value="${row.expires_at ? new Date(row.expires_at).toISOString().slice(0,10) : ''}" style="width:160px;padding:9px 12px;font-size:.82rem" />
                    <button class="secondary sm" type="submit" title="Save expiry">Save</button>
                  </form>
                </td>
                <td data-label="Actions" class="cell-actions">
                  <form class="inline" method="post" action="/admin/licenses/${record.id}/devices/${row.id}/remove" onsubmit="return confirm('Remove this device from the license? It will need to re-register.')">
                    <button class="danger sm" type="submit">Remove</button>
                  </form>
                </td>
              </tr>`).join('')}
            </tbody></table>
          </div>`
        : '<div class="notice"><p class="muted">No devices have activated this license yet.</p></div>'}
      </div>
  `));
});

app.post('/admin/licenses/:id/revoke', authSession, async (req, res) => {
  await pool.query(`UPDATE license_records SET status = 'revoked', updated_at = NOW() WHERE id = $1`, [req.params.id]);
  res.redirect(`/admin/licenses/${req.params.id}`);
});

app.post('/admin/licenses/:id/activate', authSession, async (req, res) => {
  await pool.query(`UPDATE license_records SET status = 'active', updated_at = NOW() WHERE id = $1`, [req.params.id]);
  res.redirect(`/admin/licenses/${req.params.id}`);
});

app.post('/admin/licenses/:id/delete', authSession, async (req, res) => {
  await pool.query('DELETE FROM license_records WHERE id = $1', [req.params.id]);
  res.redirect('/admin/licenses');
});

app.post('/admin/licenses/:id/devices', authSession, async (req, res) => {
  const maxDevices = parseMaxDevices(req.body.maxDevices, 1);
  await pool.query('UPDATE license_records SET max_devices = $1, updated_at = NOW() WHERE id = $2', [maxDevices, req.params.id]);
  res.redirect(`/admin/licenses/${req.params.id}`);
});

app.post('/admin/licenses/:id/entitlement', authSession, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM license_records WHERE id = $1', [req.params.id]);
    if (!result.rowCount) {
      return res.status(404).send(htmlPage('License Not Found', `<div class="panel"><h1>License not found</h1><a href="/admin/licenses">Back</a></div>`));
    }

    const currentRecord = result.rows[0];
    const updated = buildUpdatedLicenseRecord(currentRecord, {
      customerName: req.body.customerName,
      customerEmail: req.body.customerEmail,
      expiresAt: req.body.expiresAt || null,
      maxDevices: req.body.maxDevices,
      notes: req.body.notes,
      plan: req.body.plan,
    });

    await pool.query(
      `UPDATE license_records
       SET license_key = $1,
           customer_name = $2,
           customer_email = $3,
           plan = $4,
           expires_at = $5,
           max_devices = $6,
           notes = $7,
           status = $8,
           updated_at = NOW()
       WHERE id = $9`,
      [
        updated.licenseKey,
        updated.customerName,
        updated.customerEmail,
        updated.plan,
        updated.expiresAt,
        updated.maxDevices,
        updated.notes,
        updated.status,
        req.params.id,
      ],
    );
    await pool.query(
      `UPDATE license_activations
       SET expires_at = $1, updated_at = NOW()
       WHERE license_fingerprint = $2`,
      [updated.expiresAt, currentRecord.fingerprint],
    );
    await pool.query(
      `UPDATE stripe_sessions
       SET license_key = $1,
           customer_email = $2,
           plan = $3,
           max_devices = $4,
           expires_at = $5
       WHERE activation_code = $6`,
      [updated.licenseKey, updated.customerEmail, updated.plan, updated.maxDevices, updated.expiresAt, currentRecord.activation_code],
    ).catch(() => {});

    return res.redirect(`/admin/licenses/${req.params.id}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not update the license.';
    return res.status(400).send(htmlPage('License Update Failed', `
      <div class="panel" style="max-width:620px;margin:60px auto">
        <h1>License update failed</h1>
        <p class="bad">${escapeHtml(message)}</p>
        <div class="actions" style="margin-top:16px">
          <a href="/admin/licenses/${req.params.id}"><button type="button">Back to license</button></a>
        </div>
      </div>
    `));
  }
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
    ? `<div class="notice danger" style="margin-bottom:18px"><p class="bad">Warning: ${escapeHtml(warnMsg)}</p></div>`
    : '';
  const releaseSummary = releases.rows.reduce((acc, row) => {
    acc.total += 1;
    acc[row.rollout_state] = (acc[row.rollout_state] || 0) + 1;
    acc[row.platform] = (acc[row.platform] || 0) + 1;
    return acc;
  }, { total: 0, live: 0, draft: 0, hidden: 0, windows: 0, macos: 0 });
  res.send(htmlPage('Releases', warnBanner + `
    <div class="hero">
      <div class="hero-copy">
        <div class="hero-kicker">Hosted Releases</div>
        <h1>Keep release metadata tidy and easy to ship.</h1>
        <p>The update feed serves the newest live release only. Keep draft, hidden, and live records readable while CI and GitHub metadata stay in sync.</p>
        <div class="hero-meta">
          <span class="hero-note">${releaseSummary.total} tracked releases</span>
          <span class="hero-note">${releaseSummary.windows} Windows / ${releaseSummary.macos} macOS</span>
          <span class="hero-note">${releaseSummary.live} live</span>
        </div>
      </div>
      ${nav('releases')}
    </div>
    <div class="cards">
      <div class="card">
        <div>
          <div class="card-label">Total releases</div>
          <div class="card-value">${releaseSummary.total}</div>
          <div class="card-note">All stored rollout entries</div>
        </div>
      </div>
      <div class="card">
        <div>
          <div class="card-label">Live</div>
          <div class="card-value">${releaseSummary.live}</div>
          <div class="card-note">Currently served by the updater</div>
        </div>
      </div>
      <div class="card">
        <div>
          <div class="card-label">Draft</div>
          <div class="card-value">${releaseSummary.draft}</div>
          <div class="card-note">Waiting for manual launch</div>
        </div>
      </div>
      <div class="card">
        <div>
          <div class="card-label">Hidden</div>
          <div class="card-value">${releaseSummary.hidden}</div>
          <div class="card-note">Stored but not public</div>
        </div>
      </div>
    </div>
    <div class="grid">
      <div class="panel">
        <div class="panel-head">
          <div>
            <h2>Add release</h2>
            <p class="muted">Create a release record manually when you already know the final artifact URL.</p>
          </div>
        </div>
        <form method="post" action="/admin/releases">
          <div class="row">
            <div><label>Version</label><input name="version" placeholder="1.1.1" required /></div>
            <div><label>Platform</label><select name="platform"><option value="windows">Windows</option><option value="macos">macOS</option></select></div>
          </div>
          <div class="row" style="margin-top:4px">
            <div><label>Channel</label><input name="channel" value="stable" required /></div>
            <div><label>Rollout</label><select name="rolloutState"><option value="live">Live</option><option value="draft">Draft</option><option value="hidden">Hidden</option></select></div>
          </div>
          <label>Release name</label><input name="releaseName" placeholder="Keptra 1.1.1" required />
          <label>Artifact URL</label><input name="artifactUrl" placeholder="https://keptra.z2hs.au/artifacts/windows/Keptra-Setup-1.1.1.exe" required />
          <label>Release URL <span style="font-weight:400">(optional)</span></label><input name="releaseUrl" placeholder="https://keptra.z2hs.au/releases/1.1.1" />
          <label>Release notes <span style="font-weight:400">(optional)</span></label><textarea name="releaseNotes" rows="4"></textarea>
          <div class="actions" style="margin-top:16px">
            <button type="submit">Save release</button>
          </div>
        </form>
      </div>
      <div class="panel">
        <div class="panel-head">
          <div>
            <h2>CI automation</h2>
            <p class="muted">Use the admin API token with <code>scripts/publish-update-release.mjs</code> to import artifacts automatically after builds finish.</p>
          </div>
        </div>
        ${!hasGitHubReleaseConfig()
          ? `<div class="notice warning"><p class="muted">GitHub sync is off until you set <code>GITHUB_RELEASE_OWNER</code>, <code>GITHUB_RELEASE_REPO</code>, and <code>GITHUB_RELEASE_TOKEN</code> in TrueNAS.</p></div>`
          : githubRelease?.error
            ? `<div class="notice danger"><p class="bad">${githubRelease.error}</p></div>`
            : `<div class="detail-grid">
                 <div class="detail-item">
                   <div class="detail-label">GitHub repo</div>
                   <div class="detail-value"><code>${githubReleaseSummary()}</code></div>
                 </div>
                 <div class="detail-item">
                   <div class="detail-label">Latest tag</div>
                   <div class="detail-value">${githubRelease?.tagName || 'Unknown'}</div>
                 </div>
                 <div class="detail-item">
                   <div class="detail-label">Assets found</div>
                   <div class="detail-value">${Array.isArray(githubRelease?.assets) ? githubRelease.assets.length : 0}</div>
                 </div>
               </div>
               <form method="post" action="/admin/releases/sync-github" style="margin-top:12px">
                 <button type="submit">Import latest GitHub metadata</button>
               </form>`}
        <div class="notice" style="margin-top:14px">
          <p class="muted">New releases are saved as <strong>Draft</strong> by default, so you can review them before going live.</p>
        </div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head">
        <div>
          <h2>All releases</h2>
          <p class="muted">Review each release record, then promote or hide it without the table overflowing every time a title gets longer.</p>
        </div>
      </div>
      <div class="table-wrap">
        <table class="table-stack">
          <thead><tr><th>Release</th><th>Distribution</th><th>State</th><th>Published</th><th>Actions</th></tr></thead><tbody>
          ${releases.rows.map((row) => `<tr>
            <td data-label="Release"><span style="font-weight:700">${escapeHtml(row.release_name)}</span><div class="muted">v${escapeHtml(row.version)}</div></td>
            <td data-label="Distribution" class="muted">${escapeHtml(row.platform)} · ${escapeHtml(row.channel)}${row.release_url ? `<div><a href="${escapeHtml(row.release_url)}" class="muted">Hosted page</a></div>` : ''}${row.artifact_url ? `<div><a href="${escapeHtml(row.artifact_url)}" class="muted">Artifact</a></div>` : ''}</td>
            <td data-label="State">${statusPill(row.rollout_state)}</td>
            <td data-label="Published" class="muted">${fmtTime(row.published_at)}</td>
            <td data-label="Actions" class="cell-actions">
              <div class="actions">
                <a href="/admin/releases/${row.id}/edit"><button class="secondary sm" type="button">Edit</button></a>
                ${row.rollout_state !== 'live' ? `<form class="inline" method="post" action="/admin/releases/${row.id}/live"><button class="secondary sm" type="submit">Go live</button></form>` : ''}
                ${row.rollout_state === 'live' ? `<form class="inline" method="post" action="/admin/releases/${row.id}/hide"><button class="secondary sm" type="submit">Hide</button></form>` : ''}
                <form class="inline" method="post" action="/admin/releases/${row.id}/delete" onsubmit="return confirm('Delete this release? This cannot be undone.')"><button class="danger sm" type="submit">Delete</button></form>
              </div>
            </td>
          </tr>`).join('')}
          </tbody>
        </table>
      </div>
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
          latest.name || `Keptra ${version}`,
          latest.body || null,
          publicReleaseUrl(version),
          asset.url,
          latest.publishedAt || new Date().toISOString(),
        ],
      );
    }
    return res.redirect('/admin/releases');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not sync the latest GitHub release.';
    return res.status(400).send(htmlPage('GitHub Sync Error', `<div class="panel"><h1>GitHub sync failed</h1><p class="bad">${escapeHtml(message)}</p><a href="/admin/releases">Back</a></div>`));
  }
});

app.post('/admin/releases', authSession, async (req, res) => {
  const version = req.body.version;
  let platform;
  let releaseUrl;
  let artifactUrl;
  try {
    platform = normalizeReleasePlatform(req.body.platform);
    releaseUrl = normalizePublicKeptraUrl(req.body.releaseUrl || publicReleaseUrl(version));
    artifactUrl = normalizeArtifactUrl(req.body.artifactUrl, platform);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid release metadata.';
    return res.status(400).send(htmlPage('Release Error', `<div class="panel"><h1>Release was not saved</h1><p class="bad">${escapeHtml(message)}</p><a href="/admin/releases">Back</a></div>`));
  }
  await pool.query(
    `INSERT INTO releases (version, platform, channel, release_name, release_notes, release_url, artifact_url, rollout_state, published_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
    [
      version,
      platform,
      req.body.channel || 'stable',
      req.body.releaseName,
      req.body.releaseNotes || null,
      releaseUrl,
      artifactUrl,
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
  return res.send(htmlPage(`Edit ${escapeHtml(row.release_name)}`, `
    <div class="hero">
      <div class="hero-copy">
        <div class="hero-kicker">Edit Release</div>
        <h1>${escapeHtml(row.release_name)}</h1>
        <p>Update rollout state, copy, and artifact details without leaving the admin flow.</p>
        <div class="hero-meta">
          <span class="hero-note">v${escapeHtml(row.version)}</span>
          <span class="hero-note">${escapeHtml(row.platform)}</span>
          <span class="hero-note">${escapeHtml(row.channel)}</span>
        </div>
      </div>
      ${nav('releases')}
    </div>
    <div class="panel" style="max-width:780px">
      <div class="panel-head">
        <div>
          <h2>Release details</h2>
          <p class="muted">Edit the customer-facing metadata and rollout settings for this version.</p>
        </div>
      </div>
      <form method="post" action="/admin/releases/${row.id}/edit">
        <label>Release name</label>
        <input name="releaseName" value="${escapeHtml(row.release_name)}" required />
        <div class="row">
          <div>
            <label>Channel</label>
            <select name="channel">
              <option value="stable" ${row.channel === 'stable' ? 'selected' : ''}>stable</option>
              <option value="beta" ${row.channel === 'beta' ? 'selected' : ''}>beta</option>
            </select>
          </div>
          <div>
            <label>Rollout</label>
            <select name="rolloutState">
              <option value="live" ${row.rollout_state === 'live' ? 'selected' : ''}>live</option>
              <option value="draft" ${row.rollout_state === 'draft' ? 'selected' : ''}>draft</option>
              <option value="hidden" ${row.rollout_state === 'hidden' ? 'selected' : ''}>hidden</option>
            </select>
          </div>
        </div>
        <label>Artifact URL</label>
        <input name="artifactUrl" value="${escapeHtml(row.artifact_url)}" required />
        <label>Release notes</label>
        <textarea name="releaseNotes" rows="8">${escapeHtml(row.release_notes || '')}</textarea>
        <div class="actions">
          <button type="submit">Save changes</button>
          <a href="/admin/releases"><button class="secondary" type="button">Cancel</button></a>
        </div>
      </form>
    </div>
    <div class="panel danger-zone" style="max-width:780px;margin-top:16px">
      <div class="panel-head">
        <div>
          <h2>Danger zone</h2>
          <p class="muted">Deleting a release removes it from the database and also tries to clean up the hosted artifact if it lives on this server or in GitHub assets.</p>
        </div>
      </div>
      <form method="post" action="/admin/releases/${row.id}/delete" onsubmit="return confirm('Delete this release? This cannot be undone.')">
        <button class="danger" type="submit">Delete this release</button>
      </form>
    </div>
  `));
});

app.post('/admin/releases/:id/edit', authSession, async (req, res) => {
  const current = await pool.query('SELECT platform FROM releases WHERE id = $1', [req.params.id]);
  if (!current.rowCount) return res.redirect('/admin/releases');
  let artifactUrl;
  try {
    artifactUrl = normalizeArtifactUrl(req.body.artifactUrl, current.rows[0].platform);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid release artifact.';
    return res.status(400).send(htmlPage('Release Error', `<div class="panel"><h1>Release was not updated</h1><p class="bad">${escapeHtml(message)}</p><a href="/admin/releases/${escapeHtml(req.params.id)}/edit">Back</a></div>`));
  }
  await pool.query(
    `UPDATE releases
     SET release_name = $1, channel = $2, rollout_state = $3, artifact_url = $4, release_notes = $5
     WHERE id = $6`,
    [
      req.body.releaseName,
      req.body.channel || 'stable',
      req.body.rolloutState || 'draft',
      artifactUrl,
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
      const localPath = path.resolve(artifactsRoot, decodeURIComponent(relPath));
      if (isPathInside(artifactsRoot, localPath)) {
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

app.get('/admin/customers', authSession, async (req, res) => {
  const queryValue = String(req.query.q || '').trim();
  const params = [];
  let whereClause = '';
  if (queryValue) {
    params.push(`%${queryValue}%`);
    whereClause = `
      WHERE fingerprint ILIKE $1
         OR COALESCE(detail, '') ILIKE $1
    `;
  }
  const [rows, summary] = await Promise.all([
    pool.query(`
      SELECT fingerprint, MAX(created_at) AS last_event, MAX(detail) FILTER (WHERE detail IS NOT NULL) AS detail
      FROM update_events
      ${whereClause}
      GROUP BY fingerprint
      ORDER BY MAX(created_at) DESC
      LIMIT 150
    `, params),
    pool.query(`
      SELECT COUNT(DISTINCT fingerprint)::int AS total,
             COUNT(DISTINCT CASE WHEN created_at > NOW() - INTERVAL '24 hours' THEN fingerprint END)::int AS active_24h,
             COUNT(DISTINCT CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN fingerprint END)::int AS active_7d
      FROM update_events
      WHERE fingerprint IS NOT NULL
    `),
  ]);
  const overview = summary.rows[0] || { total: 0, active_24h: 0, active_7d: 0 };
  res.send(htmlPage('Customers', `
    <div class="hero">
      <div class="hero-copy">
        <div class="hero-kicker">Installs</div>
        <h1>Install activity and customer fingerprints</h1>
        <p>Use this page to see which installs have checked in recently and to inspect the latest event detail per fingerprint.</p>
        <div class="hero-meta">
          <span class="hero-note">${overview.total} tracked fingerprints</span>
          <span class="hero-note">${overview.active_24h} active in 24h</span>
          <span class="hero-note">${overview.active_7d} active in 7d</span>
        </div>
      </div>
      ${nav('customers')}
    </div>
    <div class="cards">
      <div class="card">
        <div>
          <div class="card-label">Tracked installs</div>
          <div class="card-value">${overview.total}</div>
          <div class="card-note">Distinct update fingerprints seen</div>
        </div>
      </div>
      <div class="card">
        <div>
          <div class="card-label">Active in 24h</div>
          <div class="card-value">${overview.active_24h}</div>
          <div class="card-note">Recent install check-ins</div>
        </div>
      </div>
      <div class="card">
        <div>
          <div class="card-label">Active in 7d</div>
          <div class="card-value">${overview.active_7d}</div>
          <div class="card-note">Weekly install activity</div>
        </div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head">
        <div>
          <h2>Find installs</h2>
          <p class="muted">Search by fingerprint or the latest detail string to narrow down a noisy activity list.</p>
        </div>
      </div>
      <form class="toolbar" method="get" action="/admin/customers">
        <div class="grow">
          <label>Search</label>
          <input name="q" value="${escapeHtml(queryValue)}" placeholder="Search fingerprint or detail" />
        </div>
        <div class="toolbar-actions">
          <button type="submit">Apply filter</button>
          ${queryValue ? `<a href="/admin/customers"><button class="secondary" type="button">Reset</button></a>` : ''}
        </div>
      </form>
    </div>
    <div class="panel">
      <div class="panel-head">
        <div>
          <h2>Latest install activity</h2>
          <p class="muted">${queryValue ? `${rows.rows.length} matching installs` : `${rows.rows.length} most recent installs`}</p>
        </div>
      </div>
      <div class="table-wrap">
        <table class="table-stack"><thead><tr><th>Fingerprint</th><th>Last activity</th><th>Detail</th></tr></thead><tbody>
        ${rows.rows.map((row) => `<tr>
          <td data-label="Fingerprint"><code>${row.fingerprint || 'Unknown'}</code></td>
          <td data-label="Last activity" class="muted">${row.last_event ? fmtTime(row.last_event) : 'Never'}</td>
          <td data-label="Detail" class="muted">${row.detail || '—'}</td>
        </tr>`).join('')}
        </tbody></table>
      </div>
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
  let normalizedPlatform;
  let normalizedArtifactUrl;
  let resolvedReleaseUrl;
  try {
    normalizedPlatform = normalizeReleasePlatform(platform);
    normalizedArtifactUrl = normalizeArtifactUrl(artifactUrl, normalizedPlatform);
    resolvedReleaseUrl = normalizePublicKeptraUrl(releaseUrl || publicReleaseUrl(version));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid release artifact.';
    return res.status(400).json({ error: message });
  }
  const result = await pool.query(
    `INSERT INTO releases (version, platform, channel, release_name, release_notes, release_url, artifact_url, rollout_state, published_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
     RETURNING id`,
    [version, normalizedPlatform, channel, releaseName, releaseNotes || null, resolvedReleaseUrl, normalizedArtifactUrl, rolloutState],
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
  const activationCode = normalizeActivationCode(req.body.activationCode);
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
  const issuedAt = issuedDateForRecord(record);
  const currentDeviceExpiry = summary.currentDeviceRegistered ? normalizeLicenseDate(summary.currentDevice?.expires_at) : null;
  const effectiveExpiry = currentDeviceExpiry || normalizeLicenseDate(record.expires_at);
  const activeMessage = effectiveExpiry
    ? `License active until ${formatLicenseDate(effectiveExpiry)}.`
    : 'License active.';
  if (deviceId && summary.currentDeviceRegistered && !summary.currentDeviceActive) {
    return res.status(403).json({
      allowed: false,
      message: `This device expired on ${formatLicenseDate(summary.currentDevice.expires_at)}.`,
      activationCode,
      status: 'expired',
      entitlement: {
        product: 'photo-importer',
        name: record.customer_name,
        email: record.customer_email || undefined,
        issuedAt,
        expiresAt: currentDeviceExpiry || undefined,
        tier: 'Full access',
        notes: record.notes || undefined,
        maxDevices: maxDevices || undefined,
      },
      deviceId: deviceId || undefined,
      deviceName: deviceName || undefined,
      deviceSlotsUsed: summary.count,
      deviceSlotsTotal: maxDevices || undefined,
      currentDeviceRegistered: true,
    });
  }
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
    message: activeMessage,
    status: 'active',
    entitlement: {
      product: 'photo-importer',
      name: record.customer_name,
      email: record.customer_email || undefined,
      issuedAt,
      expiresAt: effectiveExpiry || undefined,
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
  const issuedAt = resolved.record ? issuedDateForRecord(resolved.record) : resolved.validated?.entitlement?.issuedAt;
  const effectiveExpiry = resolved.activation?.currentDevice?.expires_at
    ? normalizeLicenseDate(resolved.activation.currentDevice.expires_at)
    : (resolved.activation?.latestExpiry || resolved.record?.expires_at || resolved.validated?.entitlement?.expiresAt || null);
  if (!resolved.ok) {
    return res.status(resolved.status).json({
      allowed: false,
      message: resolved.message,
      status: resolved.record?.status || 'unknown',
      activationCode: resolved.record?.activation_code,
      entitlement: resolved.validated?.entitlement
        ? {
            ...resolved.validated.entitlement,
            issuedAt: issuedAt || resolved.validated.entitlement.issuedAt,
            expiresAt: effectiveExpiry || undefined,
            maxDevices: resolved.activation?.maxDevices || resolved.validated.entitlement.maxDevices,
          }
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
    message: effectiveExpiry
      ? `License active until ${formatLicenseDate(effectiveExpiry)}.`
      : 'License active.',
    status: resolved.record?.status || 'active',
    activationCode: resolved.record?.activation_code,
    entitlement: resolved.validated?.entitlement
      ? {
          ...resolved.validated.entitlement,
          issuedAt: issuedAt || resolved.validated.entitlement.issuedAt,
          expiresAt: effectiveExpiry || undefined,
          maxDevices: resolved.activation?.maxDevices || resolved.validated.entitlement.maxDevices,
        }
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
  const platform = normalizePublicPlatform(req.query.platform, 'windows');
  const version = req.query.version || '0.0.0';
  const channel = req.query.channel || 'stable';

  // Resolve license if provided, but allow update checks even without one.
  // Legacy desktop clients need a downloadUrl in the metadata to update.
  let resolved = null;
  if (!licenseKey && wantsHtml(req)) {
    await logUpdateEvent('update-denied', {
      appVersion: version,
      platform,
      channel,
      allowed: false,
      detail: 'Missing license key header',
    });
    return res.redirect(HOME_URL);
  }
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
      if (wantsHtml(req)) return res.redirect(HOME_URL);
    }
  }

  const release = await latestRelease(platform, channel);
  if (!release) {
    await logUpdateEvent('update-check', {
      fingerprint: resolved?.fingerprint,
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

  // Issue a short-lived token whenever a live release is offered. Older
  // clients treat metadata without a downloadUrl as a notes-only release.
  const token = signDownloadToken({
    fingerprint: resolved?.fingerprint || 'anonymous',
    releaseId: release.id,
    platform,
    channel,
  });
  await logUpdateEvent('update-check', {
    fingerprint: resolved?.fingerprint,
    appVersion: version,
    platform,
    channel,
    allowed: true,
    detail: `Offered ${release.version}${resolved ? '' : ' (unlicensed)'}`,
  });

  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    allowed: true,
    currentVersion: version,
    latestVersion: release.version,
    releaseName: serializePublicRelease(release).releaseName,
    releaseNotes: serializePublicRelease(release).notes,
    releaseDate: serializePublicRelease(release).publishedAt,
    releaseUrl: serializePublicRelease(release).releaseUrl,
    downloadUrl: `${publicUpdatesBaseUrl()}/api/v1/app/download/${release.id}?token=${encodeURIComponent(token)}`,
    feedUrl: platform === 'windows' ? `${publicUpdatesBaseUrl()}/artifacts/windows` : undefined,
  });
});

function setPublicCors(req, res) {
  const origin = req.headers.origin;
  const allowed = [
    'https://keptra.z2hs.au',
    'https://admin.keptra.z2hs.au',
    'https://updates.keptra.z2hs.au',
    'https://culler.z2hs.au',
    'https://admin.culler.z2hs.au',
    'https://updates.culler.z2hs.au',
    'http://keptra.z2hs.au',
    'http://admin.keptra.z2hs.au',
    'http://updates.keptra.z2hs.au',
    'http://culler.z2hs.au',
    'http://admin.culler.z2hs.au',
    'http://updates.culler.z2hs.au',
  ];
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
  const platform = normalizePublicPlatform(req.query.platform, null);
  const channel = req.query.channel || 'stable';
  const latestOnly = String(req.query.latest || '').toLowerCase() === 'true';
  const limit = latestOnly ? 1 : Math.min(Number(req.query.limit || 10), 50);

  const rows = await liveReleases({ platform, channel, limit });

  return res.json({
    releases: rows.map(serializePublicRelease),
  });
});

app.get('/api/v1/app/history', async (req, res) => {
  const licenseKey = req.header('x-license-key');
  const platform = normalizePublicPlatform(req.query.platform, 'windows');
  const channel = req.query.channel || 'stable';
  const limit = Math.min(Number(req.query.limit || 8), 20);

  if (!licenseKey) {
    if (wantsHtml(req)) return res.redirect(HOME_URL);
    return res.status(403).json({ error: 'Missing license key.' });
  }

  const resolved = await resolveLicenseRecord(licenseKey);
  if (!resolved.ok) {
    if (wantsHtml(req)) return res.redirect(HOME_URL);
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
      if (wantsHtml(req)) return res.redirect(HOME_URL);
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
    const artifactUrl = normalizeArtifactUrl(release.rows[0].artifact_url, release.rows[0].platform);
    const artifactFilename = decodeURIComponent(path.basename(new URL(artifactUrl).pathname));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `attachment; filename="${artifactFilename}"`);
    return res.redirect(artifactUrl);
  } catch {
    if (wantsHtml(req)) return res.redirect(HOME_URL);
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
      <h2 style="margin-bottom:4px">Your Keptra license</h2>
      <p>Hi ${customerName},</p>
      <p>Thanks for trying Keptra. Here are your license details:</p>
      ${expiry}
      <p><strong>Activation code</strong> (easiest — paste this into Keptra → Settings → License):</p>
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
  const expiresLabel = expiry ? formatLicenseDate(normalizeLicenseDate(expiry)).replace(/-/g, '/') : null;
  return { licenseKey, activationCode, expiresLabel };
}

function calculatePlanExpiryDate(plan, now = new Date()) {
  if (plan === 'trial') {
    const expiry = new Date(now);
    expiry.setDate(expiry.getDate() + trialDays);
    return expiry;
  }
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
      subject: `Your Keptra ${trialDays}-day trial license`,
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
// In your Stripe dashboard point the webhook at: https://keptra.z2hs.au/stripe/webhook
// Events to listen for: checkout.session.completed
// ---------------------------------------------------------------------------
app.post(
  '/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!stripeWebhookSecret) {
      if (process.env.NODE_ENV !== 'development' && process.env.ALLOW_UNSIGNED_STRIPE_WEBHOOKS !== 'true') {
        console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET is required.');
        return res.status(500).json({ error: 'Stripe webhook verification is not configured.' });
      }
      console.warn('[stripe] STRIPE_WEBHOOK_SECRET not set — accepting webhook without verification because development override is enabled');
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
      const customerName = session.customer_details?.name || 'Keptra Customer';
      const amountTotal = session.amount_total; // cents
      const currency = (session.currency || 'aud').toUpperCase();
      const plan = session.metadata?.plan || 'lifetime';
      const maxDevices = safeParseMaxDevices(session.metadata?.max_devices, defaultMaxDevices);
      const expiryDate = calculatePlanExpiryDate(plan);
      const expiryString = formatExpiryForLicense(expiryDate);
      const expiresLabel = formatExpiryLabel(expiryDate);

      console.log(`[stripe] checkout.session.completed — session: ${sessionId} — email: ${customerEmail} — amount: ${amountTotal / 100} ${currency}`);

      try {
        const { licenseKey, activationCode } = await generateAndStoreLicense({
          name: customerName,
          email: customerEmail,
          expiry: expiryString,
          notes: `Stripe ${plan} purchase ${sessionId} (${amountTotal / 100} ${currency}, ${maxDevices} devices)`,
          maxDevices,
          plan,
        });

        console.log(`[stripe] ✓ License generated — activation: ${activationCode.substring(0, 20)}...`);

        // Store session-to-license mapping for success page retrieval
        try {
          await pool.query(
            'INSERT INTO stripe_sessions (session_id, license_key, activation_code, customer_email, plan, max_devices, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (session_id) DO UPDATE SET license_key=$2, activation_code=$3, customer_email=$4, plan=$5, max_devices=$6, expires_at=$7',
            [sessionId, licenseKey, activationCode, customerEmail, plan, maxDevices, expiryDate]
          );
          console.log(`[stripe] ✓ Session stored in stripe_sessions — session: ${sessionId}`);
        } catch (dbErr) {
          console.error('[stripe] ✗ Failed to store session in stripe_sessions:', dbErr.message, dbErr.detail);
          throw dbErr;
        }

        await sendEmail({
          to: customerEmail,
          subject: 'Your Keptra license — thank you!',
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
      let customerName = checkoutSession?.customer_details?.name || paymentIntent.metadata?.customer_name || 'Keptra Customer';
      const plan = checkoutSession?.metadata?.plan || paymentIntent.metadata?.plan || 'lifetime';
      const maxDevices = safeParseMaxDevices(checkoutSession?.metadata?.max_devices || paymentIntent.metadata?.max_devices, defaultMaxDevices);

      if (!customerEmail) {
        console.warn('[stripe] Could not determine customer email from checkout session or payment_intent — skipping');
        return res.json({ received: true });
      }

      // Calculate expiry date based on plan
      let expiryDate = null;
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
          notes: `Stripe ${plan} purchase ${sessionId} (${amountTotal / 100} ${currency}, ${maxDevices} devices)`,
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
          subject: 'Your Keptra license — thank you!',
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
        const licenseResult = await pool.query(
          'SELECT * FROM license_records WHERE activation_code = $1',
          [activationCode]
        );

        if (!licenseResult.rowCount) {
          console.error('[stripe] ✗ License not found for upgrade:', activationCode);
          return res.json({ received: true });
        }

        const license = licenseResult.rows[0];
        const updated = buildUpdatedLicenseRecord(license, { maxDevices: newDeviceCount });
        await pool.query(
          `UPDATE license_records
           SET license_key = $1,
               max_devices = $2,
               status = $3,
               updated_at = NOW()
           WHERE id = $4`,
          [updated.licenseKey, updated.maxDevices, updated.status, license.id]
        );
        await pool.query(
          `UPDATE stripe_sessions
           SET license_key = $1,
               max_devices = $2
           WHERE activation_code = $3`,
          [updated.licenseKey, updated.maxDevices, activationCode]
        ).catch(() => {});
        console.log(`[stripe] ✓ License updated to ${newDeviceCount} devices`);

        // Send confirmation email
        await sendEmail({
          to: license.customer_email,
          subject: 'Keptra license device upgrade — done!',
          html: `
            <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a">
              <h2>Device upgrade successful</h2>
              <p>Hi ${license.customer_name},</p>
              <p>Your Keptra license has been upgraded to <strong>${newDeviceCount} devices</strong>.</p>
              <p>Your stored license key has been refreshed too, so future activations stay in sync.</p>
              <p>Simply restart Keptra on your devices and they will all work with this license.</p>
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
          'SELECT * FROM license_records WHERE activation_code = $1',
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

        const updated = buildUpdatedLicenseRecord(license, { expiresAt: newExpiry.toISOString().slice(0, 10) });
        await pool.query(
          `UPDATE license_records
           SET license_key = $1,
               expires_at = $2,
               status = $3,
               updated_at = NOW()
           WHERE activation_code = $4`,
          [updated.licenseKey, updated.expiresAt, updated.status, activationCode]
        );
        await pool.query(
          `UPDATE license_activations
           SET expires_at = $1, updated_at = NOW()
           WHERE license_fingerprint = (
             SELECT fingerprint FROM license_records WHERE activation_code = $2
           )`,
          [updated.expiresAt, activationCode]
        );
        await pool.query(
          `UPDATE stripe_sessions
           SET license_key = $1,
               expires_at = $2
           WHERE activation_code = $3`,
          [updated.licenseKey, updated.expiresAt, activationCode]
        ).catch(() => {});

        console.log(`[stripe] ✓ License extended to ${newExpiry.toISOString()}`);

        // Send confirmation email
        await sendEmail({
          to: license.customer_email,
          subject: 'Keptra license extended!',
          html: `
            <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a">
              <h2>License extended</h2>
              <p>Hi ${license.customer_name},</p>
              <p>Your Keptra license has been extended by <strong>${extendAmount} ${extendUnit}</strong>.</p>
              <p>New expiry date: <strong>${newExpiry.toLocaleDateString('en-AU', {year: 'numeric', month: 'short', day: 'numeric'})}</strong></p>
              <p>Your stored license key has also been regenerated to match the new end date.</p>
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
// Body: { plan: 'monthly'|'yearly'|'lifetime', name, email, maxDevices?, extensionCode? }
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
      includedDevices: defaultMaxDevices,
      maxCheckoutDevices: checkoutMaxDevices,
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
  const { plan, name, email, maxDevices, extensionCode } = req.body || {};
  const customerName = String(name || '').trim();
  const customerEmail = String(email || '').trim().toLowerCase();
  if (!['monthly', 'yearly', 'lifetime'].includes(plan)) {
    return res.status(400).json({ error: 'plan must be monthly, yearly, or lifetime.' });
  }
  if (customerName.length < 2 || customerName.length > 120) {
    return res.status(400).json({ error: 'Name must be between 2 and 120 characters.' });
  }
  if (!customerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
    return res.status(400).json({ error: 'Valid email required.' });
  }

  const pricing = await getStripePricing();
  const priceId = pricing[`stripe_price_${plan}`];
  const amountCents = Number(pricing[`price_${plan}_cents`] || 0);
  const pricePerExtraDeviceCents = Number(pricing.device_upgrade_price_cents || 0);
  const currency = pricing['currency'] || 'aud';
  let selectedMaxDevices;
  try {
    selectedMaxDevices = parseCheckoutMaxDevices(maxDevices, defaultMaxDevices);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const extraDevices = Math.max(0, selectedMaxDevices - defaultMaxDevices);
  const checkoutTotalCents = amountCents + (extraDevices * pricePerExtraDeviceCents);

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
      'customer_email': customerEmail,
      'success_url': successUrl,
      'cancel_url': cancelUrl,
      'metadata[plan]': plan,
      'metadata[max_devices]': String(selectedMaxDevices),
      'metadata[customer_name]': customerName,
      'metadata[customer_email]': customerEmail,
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
      stripeBody.set('line_items[0][price_data][product_data][name]', `Keptra Pro — ${plan}`);
      stripeBody.set('line_items[0][quantity]', '1');
    }

    if (extraDevices > 0 && pricePerExtraDeviceCents > 0) {
      stripeBody.set('line_items[1][price_data][currency]', currency);
      stripeBody.set('line_items[1][price_data][unit_amount]', String(pricePerExtraDeviceCents));
      stripeBody.set('line_items[1][price_data][product_data][name]', 'Keptra additional device seat');
      stripeBody.set('line_items[1][price_data][product_data][description]', `Adds ${extraDevices} extra device${extraDevices > 1 ? 's' : ''} to this license.`);
      stripeBody.set('line_items[1][quantity]', String(extraDevices));
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
    return res.json({
      url: session.url,
      summary: {
        plan,
        maxDevices: selectedMaxDevices,
        includedDevices: defaultMaxDevices,
        extraDevices,
        totalCents: checkoutTotalCents,
        currency: String(currency).toUpperCase(),
      },
    });
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

  const { newDeviceCount } = req.body || {};
  const activationCode = normalizeActivationCode(req.body?.activationCode);
  const count = Number(newDeviceCount);

  if (!activationCode) return res.status(400).json({ error: 'activationCode required.' });
  if (!Number.isInteger(count) || count < 2 || count > 100) {
    return res.status(400).json({ error: 'newDeviceCount must be integer between 2 and 100.' });
  }

  try {
    // Look up license by activation code
    const licenseResult = await pool.query(
      'SELECT id, fingerprint, customer_email, customer_name, max_devices, status FROM license_records WHERE activation_code = $1',
      [activationCode]
    );

    if (!licenseResult.rowCount) {
      return res.status(404).json({ error: 'License not found.' });
    }

    const license = licenseResult.rows[0];
    if (license.status === 'revoked' || license.status === 'disabled') {
      return res.status(403).json({ error: `This license is ${license.status} and cannot be upgraded.` });
    }
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
      'line_items[0][price_data][product_data][name]': `Keptra — ${devicesToAdd} additional device${devicesToAdd > 1 ? 's' : ''}`,
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
  const currency = String(cfg.currency || 'AUD').toUpperCase();
  const previewMoney = (value) => Number(value || 0) > 0 ? formatMoneyFromCents(Number(value || 0), currency) : 'Not set';
  return res.send(htmlPage('Pricing Config', `
    <div class="hero">
      <div class="hero-copy">
        <div class="hero-kicker">Revenue</div>
        <h1>Pricing &amp; Plans</h1>
        <p>Set plan amounts, device upgrade pricing, and Stripe references without squinting through a long settings form.</p>
        <div class="hero-meta">
          <span class="hero-note">Currency: ${currency}</span>
          <span class="hero-note">Trial: ${cfg.trial_days || '14'} days</span>
          <span class="hero-note">Device upgrade: ${previewMoney(cfg.device_upgrade_price_cents)}</span>
        </div>
      </div>
      ${nav('pricing')}
    </div>
    <div class="cards">
      <div class="card">
        <div>
          <div class="card-label">Monthly</div>
          <div class="card-value">${previewMoney(cfg.price_monthly_cents)}</div>
          <div class="card-note">${cfg.stripe_price_monthly ? 'Stripe price linked' : 'Manual amount only'}</div>
        </div>
      </div>
      <div class="card">
        <div>
          <div class="card-label">Yearly</div>
          <div class="card-value">${previewMoney(cfg.price_yearly_cents)}</div>
          <div class="card-note">${cfg.stripe_price_yearly ? 'Stripe price linked' : 'Manual amount only'}</div>
        </div>
      </div>
      <div class="card">
        <div>
          <div class="card-label">Lifetime</div>
          <div class="card-value">${previewMoney(cfg.price_lifetime_cents)}</div>
          <div class="card-note">${cfg.stripe_price_lifetime ? 'Stripe price linked' : 'Manual amount only'}</div>
        </div>
      </div>
      <div class="card">
        <div>
          <div class="card-label">Extensions</div>
          <div class="card-value">${previewMoney(cfg.extend_month_price_cents)}</div>
          <div class="card-note">Per month extension price</div>
        </div>
      </div>
    </div>
    <form method="post" action="/admin/pricing">
    <div class="grid">
      <div class="panel">
        <div class="panel-head">
          <div>
            <h2>Monthly</h2>
            <p class="muted">Subscription or recurring monthly plan.</p>
          </div>
        </div>
        <label>Price (cents, e.g. 900 = $9.00)</label>
        <input type="number" name="price_monthly_cents" value="${cfg.price_monthly_cents || ''}" placeholder="900" />
        <label>Stripe Price ID <span style="font-weight:400">(optional, for subscriptions)</span></label>
        <input name="stripe_price_monthly" value="${cfg.stripe_price_monthly || ''}" placeholder="price_xxx" />
      </div>
      <div class="panel">
        <div class="panel-head">
          <div>
            <h2>Yearly</h2>
            <p class="muted">Best for annual renewals and discounted long-term billing.</p>
          </div>
        </div>
        <label>Price (cents)</label>
        <input type="number" name="price_yearly_cents" value="${cfg.price_yearly_cents || ''}" placeholder="4900" />
        <label>Stripe Price ID</label>
        <input name="stripe_price_yearly" value="${cfg.stripe_price_yearly || ''}" placeholder="price_xxx" />
      </div>
      <div class="panel">
        <div class="panel-head">
          <div>
            <h2>Lifetime</h2>
            <p class="muted">One-time purchase with no recurring renewal.</p>
          </div>
        </div>
        <label>Price (cents)</label>
        <input type="number" name="price_lifetime_cents" value="${cfg.price_lifetime_cents || ''}" placeholder="4900" />
        <label>Stripe Price ID <span style="font-weight:400">(one-time payment)</span></label>
        <input name="stripe_price_lifetime" value="${cfg.stripe_price_lifetime || ''}" placeholder="price_xxx" />
      </div>
      <div class="panel">
        <div class="panel-head">
          <div>
            <h2>Device upgrades</h2>
            <p class="muted">Charged per additional device slot.</p>
          </div>
        </div>
        <label>Price per additional device (cents)</label>
        <input type="number" name="device_upgrade_price_cents" value="${cfg.device_upgrade_price_cents || ''}" placeholder="500" />
        <p class="muted">Charged per device when upgrading from 1→2, 2→5, 5→10, and so on.</p>
      </div>
      <div class="panel">
        <div class="panel-head">
          <div>
            <h2>Extension pricing</h2>
            <p class="muted">Used when a customer adds more time to an existing timed license.</p>
          </div>
        </div>
        <label>Price per extra day (cents)</label>
        <input type="number" name="extend_day_price_cents" value="${cfg.extend_day_price_cents || ''}" placeholder="100" />
        <label>Price per extra month (cents)</label>
        <input type="number" name="extend_month_price_cents" value="${cfg.extend_month_price_cents || ''}" placeholder="900" />
        <label>Price per extra year (cents)</label>
        <input type="number" name="extend_year_price_cents" value="${cfg.extend_year_price_cents || ''}" placeholder="4900" />
      </div>
      <div class="panel">
        <div class="panel-head">
          <div>
            <h2>Global settings</h2>
            <p class="muted">Shared checkout defaults and read-only publishable key info.</p>
          </div>
        </div>
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
      <div class="panel-head">
        <div>
          <h2>How checkout works</h2>
          <p class="muted">The desktop app calls <code>POST /api/v1/checkout/create</code> with <code>{ plan, name, email }</code>. The server creates a Stripe Checkout Session and returns a redirect URL. After payment, Stripe calls the webhook and the license is generated and emailed automatically.</p>
        </div>
      </div>
      <div class="notice">
        <p class="muted">For subscription plans, set a Stripe Price ID so Keptra can treat the purchase as a renewable timed license.</p>
        <p class="muted" style="margin-top:8px">Webhook URL to register in Stripe: <code>${publicUpdatesBaseUrl()}/stripe/webhook</code></p>
      </div>
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
          <li>Restart Keptra on your devices</li>
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
    issuedAt: issuedDateForRecord(row),
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
        subject: 'Your Keptra license has been extended',
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
  const code = normalizeActivationCode(req.params.code);
  if (!code) return res.status(400).json({ error: 'Activation code required.' });

  try {
    const row = await getLicenseRecordByActivationCode(code);
    if (!row) {
      return res.status(404).json({ error: 'License not found.' });
    }
    const summary = await activationSummary(row.fingerprint);

    return res.json({
      id: row.id,
      activationCode: row.activation_code,
      customerName: row.customer_name,
      customerEmail: row.customer_email,
      plan: row.plan,
      status: row.status || 'active',
      maxDevices: row.max_devices,
      deviceSlotsUsed: summary.count,
      deviceSlotsTotal: row.max_devices,
      issuedAt: issuedDateForRecord(row),
      expiresAt: summary.latestExpiry || normalizeLicenseDate(row.expires_at),
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
  const { amount, unit } = req.body;
  const activationCode = normalizeActivationCode(req.body.activationCode);
  const amountValue = Number.parseInt(String(amount), 10);

  if (!activationCode || !amountValue || !unit) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  if (!Number.isInteger(amountValue) || amountValue < 1 || amountValue > 120) {
    return res.status(400).json({ error: 'Extension amount must be a whole number between 1 and 120.' });
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
    if (license.status === 'revoked' || license.status === 'disabled') {
      return res.status(403).json({ error: `This license is ${license.status} and cannot be extended.` });
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

    const extendCents = unitPriceCents * amountValue;

    const origin = req.headers.origin || publicUpdatesBaseUrl();
    const successUrl = `${origin}/manage-license?code=${encodeURIComponent(activationCode)}`;
    const cancelUrl = `${origin}/manage-license?code=${encodeURIComponent(activationCode)}`;

    const stripeBody = new URLSearchParams({
      'payment_method_types[]': 'card',
      'customer_email': license.customer_email,
      'success_url': successUrl,
      'cancel_url': cancelUrl,
      'mode': 'payment',
      'metadata[activation_code]': activationCode,
      'metadata[license_id]': String(license.id),
      'metadata[extend_amount]': String(amountValue),
      'metadata[extend_unit]': unit,
      'line_items[0][price_data][currency]': currency,
      'line_items[0][price_data][unit_amount]': String(extendCents),
      'line_items[0][price_data][product_data][name]': `Keptra extension - +${amountValue} ${unit}`,
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

    console.log(`[extend] License extension checkout created for ${license.customer_email}: +${amountValue} ${unit}`);
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
  const code = normalizeActivationCode(_req.query.code);
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
      <p id="upgradeReason" class="muted" style="display:none;text-align:center;margin:-2px 0 12px;font-size:.85rem"></p>
      <a href="/manage-license" style="display:block;text-align:center;color:var(--text-muted);text-decoration:none;padding:8px">← Back</a>
    </div>

    <script>
      const code = ${JSON.stringify(code)};
      let currentDevices = 1;
      let pricePerDevice = 0;
      let pricingCurrency = 'AUD';

      async function loadLicense() {
        if (!code) {
          document.getElementById('upgradeBtn').disabled = true;
          const reason = document.getElementById('upgradeReason');
          reason.textContent = 'Enter your activation code in the license manager before adding devices.';
          reason.style.display = 'block';
          return;
        }

        try {
          const res = await fetch('/api/v1/license-info/' + encodeURIComponent(code));
          const data = await res.json();
          if (res.ok) {
            currentDevices = data.maxDevices || 1;
            document.getElementById('currentDevices').textContent = currentDevices;
            document.getElementById('deviceCount').value = String(Math.min(100, currentDevices + 1));
            const licenseState = String(data.status || '').toLowerCase();
            if (['revoked', 'disabled'].includes(licenseState)) {
              const btn = document.getElementById('upgradeBtn');
              btn.disabled = true;
              btn.textContent = 'License cannot be upgraded';
              const reason = document.getElementById('upgradeReason');
              reason.textContent = licenseState === 'revoked'
                ? 'This license is revoked. Device upgrades are blocked until support reviews it.'
                : 'This license is disabled. Device upgrades are blocked until support re-enables it.';
              reason.style.display = 'block';
            }
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
    <div class="shell" style="max-width:1040px;padding-top:56px">
      <div class="hero" style="max-width:980px;margin:0 auto 18px">
        <div class="hero-copy">
          <div class="hero-kicker">Payment received</div>
          <h1>Your Keptra license is being prepared.</h1>
          <p class="muted" id="loadingMsg">Pairing your payment with an activation code now.</p>
          <div class="hero-meta">
            <span class="hero-note" id="statusBadge">Waiting for license sync</span>
            <span class="hero-note">Usually ready in under 10 seconds</span>
            <span class="hero-note">A copy is emailed automatically</span>
          </div>
        </div>
        <div class="actions">
          <a href="https://keptra.z2hs.au/download.html" target="_blank" rel="noreferrer"><button type="button">Download Keptra</button></a>
          <a href="/manage-license"><button class="secondary" type="button">Manage license</button></a>
        </div>
      </div>

      <div class="grid" style="max-width:980px;margin:0 auto">
        <div class="stack">
          <div class="panel" id="loadingPanel">
            <div class="panel-head">
              <div>
                <h2>Generating your activation</h2>
                <p class="muted">We wait for the payment webhook, mint the signed key, and attach it to your session automatically.</p>
              </div>
            </div>
            <div class="notice">
              <p style="font-weight:700;margin-bottom:6px">What is happening right now</p>
              <p class="muted" id="loadingDetail">Checking Stripe session and looking for the fresh license record.</p>
            </div>
          </div>

          <div class="panel" id="licenseBox" style="display:none">
            <div class="panel-head">
              <div>
                <h2>Activation code</h2>
                <p class="muted">Paste this into Keptra and keep it somewhere safe for later.</p>
              </div>
            </div>
            <div style="padding:18px;border:1px solid var(--border-strong);border-radius:22px;background:linear-gradient(135deg,rgba(96,199,178,.14),rgba(242,191,131,.08) 42%,rgba(12,22,28,.92) 100%)">
              <div style="display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap">
                <code id="activationCode" style="display:block;font-size:1.1rem;font-weight:780;letter-spacing:.18em;padding:16px 18px;border-radius:18px;border:1px solid rgba(255,255,255,.1);background:rgba(5,12,16,.68);flex:1;min-width:260px;text-align:center"></code>
                <button id="copyBtn" class="secondary" type="button">Copy code</button>
              </div>
            </div>
            <div class="detail-grid" style="margin-top:16px">
              <div class="detail-item">
                <div class="detail-label">Plan</div>
                <div class="detail-value" id="planType">—</div>
              </div>
              <div class="detail-item">
                <div class="detail-label">Seat limit</div>
                <div class="detail-value"><span id="maxDevices">—</span> device<span id="devicePlural"></span></div>
              </div>
              <div class="detail-item" id="expiryItem" style="display:none">
                <div class="detail-label">Expires</div>
                <div class="detail-value" id="expiryDate">—</div>
              </div>
            </div>
            <div class="actions" style="margin-top:18px">
              <a href="https://keptra.z2hs.au/download.html" target="_blank" rel="noreferrer"><button type="button">Open download page</button></a>
              <a href="/manage-license"><button class="secondary" type="button">Open license manager</button></a>
            </div>
          </div>

          <div id="errorBox" class="notice danger" style="display:none"></div>
        </div>

        <div class="stack">
          <div class="panel">
            <div class="panel-head">
              <div>
                <h2>Next steps</h2>
                <p class="muted">You should only need a minute from here to get the app unlocked.</p>
              </div>
            </div>
            <ol class="list" style="padding-left:20px">
              <li>Download or open the latest Keptra build.</li>
              <li>Go to <strong>Settings → License</strong>.</li>
              <li>Paste the activation code and confirm.</li>
              <li>Restart the app if it was already open.</li>
            </ol>
          </div>

          <div class="panel">
            <div class="panel-head">
              <div>
                <h2>Email backup</h2>
                <p class="muted">The same activation details are also sent to your inbox for safekeeping.</p>
              </div>
            </div>
            <div class="notice">
              <p style="font-weight:700;margin-bottom:6px">If the page is closed too early</p>
              <p class="muted">Check your email, including spam or promotions. The activation code normally arrives there within a couple of minutes.</p>
            </div>
          </div>

          <div class="panel" id="helpBox" style="display:none">
            <div class="panel-head">
              <div>
                <h2>Taking longer than expected?</h2>
                <p class="muted">This usually resolves on its own, but these checks cover the common delays.</p>
              </div>
            </div>
            <ol class="list" style="padding-left:20px">
              <li>Refresh this page after another minute.</li>
              <li>Check your email and spam folder for the activation message.</li>
              <li>Use the license manager if you already have the code.</li>
            </ol>
          </div>
        </div>
      </div>
    </div>

    <script>
      const params = new URLSearchParams(window.location.search);
      let sessionId = params.get('session_id');
      let retryCount = 0;
      const MAX_RETRIES = 30;
      const statusBadge = document.getElementById('statusBadge');
      const loadingMsg = document.getElementById('loadingMsg');
      const loadingPanel = document.getElementById('loadingPanel');
      const loadingDetail = document.getElementById('loadingDetail');

      if (sessionId && sessionId.includes(':')) {
        sessionId = sessionId.split(':')[0];
      }

      function displayPlan(plan, expiresAt) {
        if (plan === 'trial') return 'Trial';
        if (plan === 'monthly') return 'Monthly';
        if (plan === 'yearly') return 'Yearly';
        if (plan === 'lifetime') return 'Lifetime';
        return expiresAt ? 'Timed' : 'Lifetime';
      }

      async function loadLicense() {
        retryCount++;

        if (!sessionId) {
          showError('No session ID found. Please check your payment link.');
          return;
        }

        loadingMsg.textContent = retryCount === 1
          ? 'Pairing your payment with an activation code now.'
          : 'Still working on it. Checking again for your code.';
        loadingDetail.textContent = 'Attempt ' + retryCount + ' of ' + MAX_RETRIES + '. Looking for the Stripe session and generated license.';
        statusBadge.textContent = retryCount === 1 ? 'Waiting for license sync' : 'Retrying license lookup';

        try {
          const res = await fetch('/api/v1/license/' + sessionId);
          const data = await res.json();

          if (!res.ok) {
            if (retryCount >= MAX_RETRIES) {
              loadingPanel.style.display = 'none';
              loadingMsg.textContent = 'We have not received the activation code yet.';
              statusBadge.textContent = 'Needs a quick retry';
              document.getElementById('helpBox').style.display = 'block';
              return;
            }

            setTimeout(loadLicense, 2000);
            return;
          }

          loadingPanel.style.display = 'none';
          loadingMsg.textContent = 'Activation code ready.';
          statusBadge.textContent = 'Ready to activate';
          document.getElementById('helpBox').style.display = 'none';
          const codeEl = document.getElementById('activationCode');
          codeEl.textContent = data.activationCode;
          document.getElementById('licenseBox').style.display = 'block';

          document.getElementById('planType').textContent = displayPlan(data.plan, data.expiresAt);
          const deviceCount = Number(data.maxDevices || 1);
          document.getElementById('maxDevices').textContent = String(deviceCount);
          document.getElementById('devicePlural').textContent = deviceCount === 1 ? '' : 's';
          if (data.expiresAt) {
            const date = new Date(data.expiresAt);
            document.getElementById('expiryDate').textContent = date.toLocaleDateString('en-AU', {year: 'numeric', month: 'short', day: 'numeric'});
            document.getElementById('expiryItem').style.display = 'block';
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
        loadingPanel.style.display = 'none';
        loadingMsg.textContent = 'We hit a snag fetching your activation code.';
        statusBadge.textContent = 'Needs attention';
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
    <style>
      .ml-wrap { max-width: 860px; margin: 42px auto 64px; }
      .ml-hero {
        display: grid;
        gap: 10px;
        margin-bottom: 22px;
        padding: 24px;
        border: 1px solid var(--border-strong);
        border-radius: 16px;
        background: linear-gradient(135deg, rgba(96,199,178,.12), rgba(13,24,31,.9));
        box-shadow: var(--shadow);
      }
      .ml-hero h1 { max-width: none; }
      .ml-hero p { max-width: 56ch; }
      .ml-section {
        margin-bottom: 18px;
        padding: 18px;
        border: 1px solid var(--border);
        border-radius: 12px;
        background: rgba(13,24,31,.68);
      }
      .ml-helper {
        margin-top: 10px;
        color: var(--muted);
        font-size: .84rem;
        line-height: 1.45;
      }
      .ml-help-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 10px;
        margin: 0 0 18px;
      }
      .ml-help-card {
        padding: 13px 14px;
        border: 1px solid var(--border);
        border-radius: 10px;
        background: rgba(6,14,18,.34);
      }
      .ml-help-card strong {
        display: block;
        margin-bottom: 4px;
        font-size: .82rem;
      }
      .ml-help-card span {
        color: var(--muted);
        font-size: .78rem;
        line-height: 1.4;
      }
      .ml-lookup { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: stretch; }
      .ml-lookup input {
        flex: 1;
        font-family: ui-monospace, 'SF Mono', Consolas, monospace;
        font-size: .92rem;
        letter-spacing: .03em;
        padding: 11px 14px;
        background: rgba(6,14,18,.6);
        border: 1px solid var(--border-strong);
        border-radius: 8px;
        color: var(--text);
        transition: border-color .15s, box-shadow .15s;
      }
      .ml-lookup input:focus { outline: none; border-color: rgba(96,199,178,.65); box-shadow: 0 0 0 3px rgba(96,199,178,.1); }
      .ml-lookup input::placeholder { color: var(--faint); letter-spacing: 0; }
      .ml-lookup button {
        padding: 11px 20px;
        border-radius: 8px;
        font-size: .88rem;
        white-space: nowrap;
        flex-shrink: 0;
      }
      .ml-error {
        display: none;
        padding: 11px 14px;
        border-radius: 8px;
        background: var(--danger-soft);
        border: 1px solid rgba(255,123,103,.22);
        color: var(--danger);
        font-size: .88rem;
        margin-bottom: 16px;
      }
      .ml-error.show { display: block; }
      .ml-spinner {
        display: none;
        text-align: center;
        padding: 24px;
        color: var(--muted);
        font-size: .9rem;
      }
      .ml-spinner.show { display: block; }
      .ml-details { display: none; }
      .ml-details.show { display: block; }
      .ml-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
        margin-bottom: 20px;
      }
      .ml-field {
        padding: 14px 16px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: rgba(6,14,18,.38);
      }
      .ml-field-label {
        font-size: .7rem;
        font-weight: 760;
        text-transform: uppercase;
        letter-spacing: .14em;
        color: var(--muted);
        margin-bottom: 6px;
      }
      .ml-field-value {
        font-size: .96rem;
        font-weight: 650;
        line-height: 1.3;
        overflow-wrap: anywhere;
      }
      .ml-status-pill {
        display: inline-flex;
        align-items: center;
        min-height: 24px;
        padding: 3px 9px;
        border-radius: 999px;
        border: 1px solid rgba(96,199,178,.28);
        background: rgba(96,199,178,.12);
        color: var(--accent);
      }
      .ml-status-pill.warn {
        border-color: rgba(255,207,92,.28);
        background: rgba(255,207,92,.12);
        color: #ffcf5c;
      }
      .ml-status-pill.bad {
        border-color: rgba(255,123,103,.28);
        background: rgba(255,123,103,.12);
        color: var(--danger);
      }
      .ml-field.span2 { grid-column: 1 / -1; }
      .ml-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 20px; }
      .ml-actions button { border-radius: 8px; padding: 12px 16px; font-size: .88rem; }
      .ml-action-reason {
        display: none;
        margin: -8px 0 18px;
        padding: 10px 12px;
        border: 1px solid rgba(255,207,92,.22);
        border-radius: 8px;
        background: rgba(255,207,92,.08);
        color: var(--warning);
        font-size: .82rem;
      }
      .ml-action-reason.show { display: block; }
      .ml-extend {
        display: none;
        padding: 20px;
        border: 1px solid var(--border-strong);
        border-radius: 12px;
        background: rgba(13,24,31,.7);
        margin-bottom: 16px;
      }
      .ml-extend.show { display: block; }
      .ml-extend h3 { font-size: 1rem; font-weight: 700; margin: 0 0 16px; }
      .ml-extend-row { display: grid; grid-template-columns: 2fr 3fr; gap: 10px; margin-bottom: 12px; }
      .ml-price { font-size: .88rem; color: var(--muted); margin-bottom: 16px; }
      .ml-extend-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      .ml-extend-actions button { border-radius: 8px; padding: 11px 16px; font-size: .88rem; }
      @media (max-width: 560px) {
        .ml-wrap { margin: 18px auto 44px; }
        .ml-hero, .ml-section { padding: 18px; }
        .ml-lookup, .ml-grid, .ml-actions, .ml-extend-row, .ml-extend-actions, .ml-help-grid { grid-template-columns: 1fr; }
        .ml-field.span2 { grid-column: auto; }
      }
    </style>

    <div class="ml-wrap">
      <div class="ml-hero">
        <div class="hero-kicker">License manager</div>
        <h1>Manage your Keptra license</h1>
        <p class="muted">View status, renew a timed license, or add device seats with the activation code from your purchase email.</p>
      </div>

      <div class="ml-section">
        <div class="ml-lookup">
          <input id="activationCodeInput" type="text" placeholder="PIC-XXXX-XXXX-XXXX" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="characters" />
          <button id="lookupBtn">Look up</button>
        </div>
        <div class="ml-helper">Paste the activation code from your email or Keptra settings. You can renew a timed license, add seats, or check whether a webhook/payment is still pending.</div>
      </div>

      <div class="ml-help-grid">
        <div class="ml-help-card"><strong>Renew</strong><span>Extend monthly, yearly, trial, or other timed licenses before they expire.</span></div>
        <div class="ml-help-card"><strong>Add seats</strong><span>Upgrade device count before checkout so the renewal total is clear.</span></div>
        <div class="ml-help-card"><strong>Support check</strong><span>Expired, revoked, disabled, or delayed-payment states show directly here.</span></div>
      </div>

      <div class="ml-error" id="errorMsg"></div>
      <div class="ml-spinner" id="loadingMsg">Looking up license…</div>

      <div class="ml-details" id="licenseDetails">
        <div class="ml-grid">
          <div class="ml-field">
            <div class="ml-field-label">Name</div>
            <div class="ml-field-value" id="customerName">—</div>
          </div>
          <div class="ml-field">
            <div class="ml-field-label">Plan</div>
            <div class="ml-field-value" id="planType">—</div>
          </div>
          <div class="ml-field">
            <div class="ml-field-label">Devices</div>
            <div class="ml-field-value" id="maxDevices">—</div>
          </div>
          <div class="ml-field">
            <div class="ml-field-label">Status</div>
            <div class="ml-field-value"><span id="statusText" class="ml-status-pill">—</span></div>
          </div>
          <div class="ml-field span2">
            <div class="ml-field-label">Expiry</div>
            <div class="ml-field-value" id="expiryDate">—</div>
          </div>
        </div>

        <div class="ml-actions">
          <button id="extendBtn" class="secondary">Extend validity</button>
          <button id="upgradeBtn" class="secondary">Add devices</button>
        </div>
        <div id="actionReason" class="ml-action-reason"></div>
      </div>

      <div class="ml-extend" id="extendForm">
        <h3>Extend validity</h3>
        <div class="ml-extend-row">
          <input id="extendAmount" type="number" min="1" value="1" />
          <select id="extendUnit">
            <option value="days">Days</option>
            <option value="months">Months</option>
            <option value="years">Years</option>
          </select>
        </div>
        <div class="ml-price" id="extendPriceSummary">Loading pricing…</div>
        <div class="ml-extend-actions">
          <button id="confirmExtendBtn">Pay and extend</button>
          <button id="cancelExtendBtn" class="secondary">Cancel</button>
        </div>
      </div>
    </div>

    <script>
      let currentLicense = null;
      let pricingData = null;
      const codeInput = document.getElementById('activationCodeInput');

      function formatMoney(cents) {
        const currency = (pricingData && pricingData.currency) || 'AUD';
        return new Intl.NumberFormat('en-AU', {
          style: 'currency', currency,
          minimumFractionDigits: 0, maximumFractionDigits: 2,
        }).format((Number(cents) || 0) / 100);
      }

      function displayPlan(plan, expiresAt) {
        if (plan === 'trial')    return 'Trial';
        if (plan === 'monthly')  return 'Monthly';
        if (plan === 'yearly')   return 'Yearly';
        if (plan === 'lifetime') return 'Lifetime';
        return expiresAt ? 'Timed' : 'Lifetime';
      }

      function displayLicenseStatus(license) {
        const status = (license.status || '').toLowerCase();
        if (status === 'revoked') return 'Revoked';
        if (status === 'disabled') return 'Disabled';
        if (status === 'expired') return 'Expired';
        if (license.expiresAt && new Date(license.expiresAt).getTime() < Date.now()) return 'Expired';
        return license.expiresAt ? 'Active' : 'Lifetime';
      }

      function canModifyLicense(license) {
        const status = (license.status || '').toLowerCase();
        return status !== 'revoked' && status !== 'disabled';
      }

      async function loadPricing() {
        try {
          const res = await fetch('/api/v1/pricing');
          if (!res.ok) return;
          pricingData = await res.json();
          updateExtendSummary();
        } catch (err) { console.error(err); }
      }

      function updateExtendSummary() {
        const el = document.getElementById('extendPriceSummary');
        if (!el) return;
        const amount = parseInt(document.getElementById('extendAmount').value, 10) || 1;
        const unit = document.getElementById('extendUnit').value;
        const prices = (pricingData && pricingData.extensionPrices) ? pricingData.extensionPrices : {};
        const totalCents = (Number(prices[unit]) || 0) * amount;
        el.textContent = totalCents > 0 ? 'Total: ' + formatMoney(totalCents) : 'Pricing not configured';
      }

      async function lookupLicense() {
        const code = codeInput.value.trim().toUpperCase();
        if (!code) { showError('Enter an activation code first.'); return; }
        showLoading();
        try {
          const res = await fetch('/api/v1/license-info/' + encodeURIComponent(code));
          const data = await res.json();
          if (!res.ok) { showError(data.error || 'License not found.'); return; }
          currentLicense = data;
          showLicenseDetails();
        } catch (err) { showError('Request failed: ' + err.message); }
      }

      function showLoading() {
        document.getElementById('loadingMsg').classList.add('show');
        document.getElementById('errorMsg').classList.remove('show');
        document.getElementById('licenseDetails').classList.remove('show');
        document.getElementById('extendForm').classList.remove('show');
      }

      function showError(msg) {
        document.getElementById('loadingMsg').classList.remove('show');
        const el = document.getElementById('errorMsg');
        el.textContent = msg;
        el.classList.add('show');
      }

      function showLicenseDetails() {
        document.getElementById('loadingMsg').classList.remove('show');
        document.getElementById('errorMsg').classList.remove('show');

        document.getElementById('customerName').textContent = currentLicense.customerName || '—';
        document.getElementById('planType').textContent = displayPlan(currentLicense.plan, currentLicense.expiresAt);
        const used = Number(currentLicense.deviceSlotsUsed || 0);
        const total = Number(currentLicense.deviceSlotsTotal || currentLicense.maxDevices || 1);
        document.getElementById('maxDevices').textContent = used > 0
          ? used + '/' + total + ' seat' + (total === 1 ? '' : 's') + ' used'
          : total + ' device' + (total === 1 ? '' : 's');
        const statusLabel = displayLicenseStatus(currentLicense);
        const statusEl = document.getElementById('statusText');
        statusEl.textContent = statusLabel;
        statusEl.className = 'ml-status-pill';
        if (statusLabel === 'Expired') statusEl.classList.add('warn');
        if (statusLabel === 'Revoked' || statusLabel === 'Disabled') statusEl.classList.add('bad');
        const modifiable = canModifyLicense(currentLicense);
        const actionReasonEl = document.getElementById('actionReason');
        let actionReason = '';
        if (!modifiable) {
          actionReason = statusLabel === 'Revoked'
            ? 'This license is revoked, so renewal and device upgrades are blocked. Contact support if this was unexpected.'
            : 'This license is disabled, so renewal and device upgrades are blocked until support re-enables it.';
        }

        if (currentLicense.expiresAt) {
          document.getElementById('expiryDate').textContent = new Date(currentLicense.expiresAt).toLocaleDateString('en-AU', { year: 'numeric', month: 'short', day: 'numeric' });
          document.getElementById('extendBtn').style.display = modifiable ? '' : 'none';
          document.getElementById('extendBtn').disabled = !modifiable;
        } else {
          document.getElementById('expiryDate').textContent = 'Does not expire';
          document.getElementById('extendBtn').style.display = 'none';
        }
        document.getElementById('upgradeBtn').disabled = !modifiable;
        document.getElementById('upgradeBtn').textContent = modifiable ? 'Add devices' : 'License cannot be changed';
        actionReasonEl.textContent = actionReason;
        actionReasonEl.classList.toggle('show', !!actionReason);

        document.getElementById('licenseDetails').classList.add('show');
      }

      document.getElementById('lookupBtn').onclick = () => void lookupLicense();
      codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') void lookupLicense(); });

      document.getElementById('extendBtn').onclick = () => {
        if (!currentLicense || !canModifyLicense(currentLicense)) return;
        document.getElementById('extendForm').classList.add('show');
        document.getElementById('licenseDetails').classList.remove('show');
        updateExtendSummary();
      };

      document.getElementById('cancelExtendBtn').onclick = () => {
        document.getElementById('extendForm').classList.remove('show');
        if (currentLicense) document.getElementById('licenseDetails').classList.add('show');
      };

      document.getElementById('extendAmount').oninput = updateExtendSummary;
      document.getElementById('extendUnit').onchange = updateExtendSummary;

      document.getElementById('confirmExtendBtn').onclick = async () => {
        if (!currentLicense) return;
        const amount = parseInt(document.getElementById('extendAmount').value, 10);
        const unit = document.getElementById('extendUnit').value;
        if (!amount || amount < 1) { showError('Enter a valid duration.'); return; }
        const btn = document.getElementById('confirmExtendBtn');
        btn.disabled = true;
        btn.textContent = 'Processing…';
        try {
          const res = await fetch('/api/v1/extend-license', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ activationCode: currentLicense.activationCode, amount, unit }),
          });
          const data = await res.json();
          if (!res.ok) {
            showError(data.error || 'Could not create extension.');
            return;
          }
          window.location.href = data.url;
        } catch (err) {
          showError('Request failed: ' + err.message);
        } finally {
          btn.disabled = false;
          btn.textContent = 'Pay and extend';
        }
      };

      document.getElementById('upgradeBtn').onclick = () => {
        if (!currentLicense) return;
        if (!canModifyLicense(currentLicense)) return;
        window.location.href = '/upgrade-license?code=' + encodeURIComponent(currentLicense.activationCode);
      };

      const params = new URLSearchParams(window.location.search);
      const initialCode = params.get('code');
      if (initialCode) { codeInput.value = initialCode; void lookupLicense(); }

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
