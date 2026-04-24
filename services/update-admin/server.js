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
const publicKeyPath = process.env.LICENSE_PUBLIC_KEY_PATH || path.resolve(__dirname, '../../scripts/license-keys/public.pem');
const privateKeyPath = process.env.LICENSE_PRIVATE_KEY_PATH || '';
const licensePublicKeyPem = fs.readFileSync(publicKeyPath, 'utf8');
const licensePrivateKeyPem = privateKeyPath && fs.existsSync(privateKeyPath)
  ? fs.readFileSync(privateKeyPath, 'utf8')
  : '';
const sessionSecret = process.env.ADMIN_SESSION_SECRET || 'change-me-admin-session-secret';
const updateSecret = process.env.UPDATE_TOKEN_SECRET || 'change-me-update-token-secret';
const adminApiToken = process.env.ADMIN_API_TOKEN || '';
const artifactsRoot = process.env.ARTIFACTS_ROOT || '/srv/artifacts';
const ACTIVATION_CODE_PREFIX = 'PIC';
const ACTIVATION_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://photo_importer:photo_importer@db:5432/photo_importer_updates',
});

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

function createLicenseKey({ name, email, expiry, notes }) {
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
  await pool.query('ALTER TABLE license_records ADD COLUMN IF NOT EXISTS activation_code TEXT');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_license_records_activation_code ON license_records(activation_code)');
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
    `INSERT INTO license_records (fingerprint, license_key, customer_name, customer_email, issued_at, expires_at, status, notes, last_seen_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'active',$7,NOW(),NOW())
     ON CONFLICT (fingerprint) DO UPDATE
     SET license_key = EXCLUDED.license_key,
         customer_name = EXCLUDED.customer_name,
         customer_email = EXCLUDED.customer_email,
         issued_at = EXCLUDED.issued_at,
         expires_at = EXCLUDED.expires_at,
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
      notes || validated.entitlement.notes || null,
    ],
  );
  return assignActivationCode(validated.fingerprint);
}

async function resolveLicenseRecord(licenseKey) {
  const validated = validateLicenseKey(licenseKey, licensePublicKeyPem);
  if (!validated.valid) {
    return { ok: false, status: 403, message: validated.message };
  }

  const fingerprint = validated.fingerprint;
  const row = await pool.query('SELECT * FROM license_records WHERE fingerprint = $1', [fingerprint]);
  if (row.rowCount === 0) {
    await pool.query(
      `INSERT INTO license_records (fingerprint, license_key, customer_name, customer_email, issued_at, expires_at, status, notes, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,'active',$7,NOW())
       ON CONFLICT (fingerprint) DO NOTHING`,
      [
        fingerprint,
        validated.key,
        validated.entitlement.name,
        validated.entitlement.email || null,
        validated.entitlement.issuedAt || null,
        validated.entitlement.expiresAt || null,
        validated.entitlement.notes || null,
      ],
    );
    return { ok: true, validated, fingerprint, record: { status: 'active' } };
  }

  const record = row.rows[0];
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

  return { ok: true, validated, fingerprint, record };
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
      <p class="muted">Version ${release.version} - ${release.platform} - ${release.channel} - ${new Date(release.published_at).toLocaleDateString('en-AU')}</p>
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
  const [licenseStats, releaseStats, recentEvents] = await Promise.all([
    pool.query(`SELECT status, COUNT(*)::int AS count FROM license_records GROUP BY status ORDER BY status`),
    pool.query(`SELECT platform, rollout_state, COUNT(*)::int AS count FROM releases GROUP BY platform, rollout_state ORDER BY platform, rollout_state`),
    pool.query(`SELECT event_type, detail, created_at FROM update_events ORDER BY created_at DESC LIMIT 10`),
  ]);

  res.send(htmlPage('Admin Dashboard', `
    <div class="top"><div><h1>Update Admin</h1><p class="muted">admin.culler.z2hs.au</p></div>${nav('dashboard')}</div>
    <div class="cards">
      ${licenseStats.rows.map((row) => `<div class="card"><div class="card-label">Licenses · ${row.status}</div><div class="card-value">${row.count}</div></div>`).join('')}
      ${releaseStats.rows.map((row) => `<div class="card"><div class="card-label">Releases · ${row.platform} / ${row.rollout_state}</div><div class="card-value">${row.count}</div></div>`).join('')}
    </div>
    <div class="panel">
      <h2>Recent update activity</h2>
      <table><thead><tr><th>Event</th><th>Detail</th><th>Time</th></tr></thead><tbody>
      ${recentEvents.rows.map((row) => `<tr><td>${row.event_type}</td><td class="muted">${row.detail || '—'}</td><td class="muted">${new Date(row.created_at).toLocaleString('en-AU')}</td></tr>`).join('')}
      </tbody></table>
    </div>
  `));
});

app.get('/admin/licenses', authSession, async (_req, res) => {
  const result = await pool.query('SELECT * FROM license_records ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT 100');
  const generatorEnabled = canGenerateLicenses();

  res.send(htmlPage('Licenses', `
    <div class="top"><div><h1>Licenses</h1><p class="muted">Import, generate, revoke, and track entitlement state.</p></div>${nav('licenses')}</div>
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
      <table><thead><tr><th>Customer</th><th>Status</th><th>Activation code</th><th>Expires</th><th>Last seen</th><th>Actions</th></tr></thead><tbody>
      ${result.rows.map((row) => `<tr>
        <td><span style="font-weight:600">${row.customer_name}</span>${row.customer_email ? `<div class="muted">${row.customer_email}</div>` : ''}</td>
        <td>${statusPill(row.status)}</td>
        <td><code>${row.activation_code || '—'}</code></td>
        <td class="muted">${formatLicenseDate(row.expires_at)}</td>
        <td class="muted">${row.last_seen_at ? new Date(row.last_seen_at).toLocaleString('en-AU') : 'Never'}</td>
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
        <p class="muted">Last seen: ${record.last_seen_at ? new Date(record.last_seen_at).toLocaleString('en-AU') : 'Never'}</p>
        <div style="margin-top:16px" class="actions">
          ${record.status !== 'revoked' ? `<form class="inline" method="post" action="/admin/licenses/${record.id}/revoke"><button class="secondary sm" type="submit">Revoke</button></form>` : ''}
          ${record.status !== 'active' ? `<form class="inline" method="post" action="/admin/licenses/${record.id}/activate"><button class="secondary sm" type="submit">Re-activate</button></form>` : ''}
        </div>
      </div>
      <div class="panel">
        <h2>Stored key</h2>
        <textarea rows="8" readonly>${record.license_key}</textarea>
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

app.get('/admin/releases', authSession, async (_req, res) => {
  const releases = await pool.query('SELECT * FROM releases ORDER BY published_at DESC, id DESC LIMIT 100');
  res.send(htmlPage('Releases', `
    <div class="top"><div><h1>Releases</h1><p class="muted">Publish from private GitHub into the hosted update feed.</p></div>${nav('releases')}</div>
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
        <td class="muted">${new Date(row.published_at).toLocaleString('en-AU')}</td>
        <td>
          <div class="actions">
            <a href="/admin/releases/${row.id}/edit"><button class="secondary sm" type="button">Edit</button></a>
            ${row.rollout_state !== 'live' ? `<form class="inline" method="post" action="/admin/releases/${row.id}/live"><button class="secondary sm" type="submit">Go live</button></form>` : ''}
            ${row.rollout_state === 'live' ? `<form class="inline" method="post" action="/admin/releases/${row.id}/hide"><button class="secondary sm" type="submit">Hide</button></form>` : ''}
          </div>
        </td>
      </tr>`).join('')}
      </tbody></table>
    </div>
  `));
});

app.post('/admin/releases', authSession, async (req, res) => {
  const version = req.body.version;
  const releaseUrl = req.body.releaseUrl || `${process.env.PUBLIC_UPDATES_BASE_URL || 'https://updates.culler.z2hs.au'}`.replace('updates.', 'admin.') + `/releases/${version}`;
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
      <p class="muted" style="margin-bottom:14px">Deleting a release removes it from the database. Artifact files on the server are <strong>not deleted</strong> — remove them via SSH to free storage.</p>
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
  await pool.query('DELETE FROM releases WHERE id = $1', [req.params.id]);
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
        <td class="muted">${row.last_event ? new Date(row.last_event).toLocaleString('en-AU') : 'Never'}</td>
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
  const resolvedReleaseUrl = releaseUrl || `${process.env.PUBLIC_UPDATES_BASE_URL || 'https://updates.culler.z2hs.au'}`.replace('updates.', 'admin.') + `/releases/${version}`;
  const result = await pool.query(
    `INSERT INTO releases (version, platform, channel, release_name, release_notes, release_url, artifact_url, rollout_state, published_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
     RETURNING id`,
    [version, platform, channel, releaseName, releaseNotes || null, resolvedReleaseUrl, artifactUrl, rolloutState],
  );
  return res.json({ ok: true, id: result.rows[0].id });
});

app.post('/api/v1/license/resolve', async (req, res) => {
  const activationCode = String(req.body.activationCode || '').trim().toUpperCase();
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
    },
  });
});

app.get('/api/v1/license/status', async (req, res) => {
  const licenseKey = req.header('x-license-key');
  if (!licenseKey) {
    return res.status(400).json({ allowed: false, message: 'Missing license key.', status: 'unknown' });
  }

  const resolved = await resolveLicenseRecord(licenseKey);
  if (!resolved.ok) {
    return res.status(resolved.status).json({
      allowed: false,
      message: resolved.message,
      status: resolved.record?.status || 'unknown',
      activationCode: resolved.record?.activation_code,
      entitlement: resolved.validated?.entitlement,
    });
  }

  return res.json({
    allowed: true,
    message: resolved.record?.expires_at
      ? `License active until ${formatLicenseDate(resolved.record.expires_at)}.`
      : 'License active.',
    status: resolved.record?.status || 'active',
    activationCode: resolved.record?.activation_code,
    entitlement: resolved.validated?.entitlement,
  });
});

app.get('/api/v1/app/update', async (req, res) => {
  const licenseKey = req.header('x-license-key');
  const platform = req.query.platform || 'windows';
  const version = req.query.version || '0.0.0';
  const channel = req.query.channel || 'stable';

  if (!licenseKey) {
    await logUpdateEvent('update-denied', {
      appVersion: version,
      platform,
      channel,
      allowed: false,
      detail: 'Missing license key header',
    });
    return res.status(403).json({ allowed: false, message: 'Activate a valid license before checking for updates.' });
  }

  const resolved = await resolveLicenseRecord(licenseKey);
  if (!resolved.ok) {
    await logUpdateEvent('update-denied', {
      fingerprint: resolved.fingerprint,
      appVersion: version,
      platform,
      channel,
      allowed: false,
      detail: resolved.message,
    });
    return res.status(resolved.status).json({ allowed: false, message: resolved.message });
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

  const token = signDownloadToken({
    fingerprint: resolved.fingerprint,
    releaseId: release.id,
    platform,
    channel,
  });
  await logUpdateEvent('update-check', {
    fingerprint: resolved.fingerprint,
    appVersion: version,
    platform,
    channel,
    allowed: true,
    detail: `Offered ${release.version}`,
  });

  return res.json({
    allowed: true,
    currentVersion: version,
    latestVersion: release.version,
    releaseName: release.release_name,
    releaseNotes: release.release_notes,
    releaseDate: release.published_at,
    releaseUrl: release.release_url,
    downloadUrl: `${process.env.PUBLIC_UPDATES_BASE_URL || 'https://updates.culler.z2hs.au'}/api/v1/app/download/${release.id}?token=${encodeURIComponent(token)}`,
    feedUrl: platform === 'windows' ? `${process.env.PUBLIC_UPDATES_BASE_URL || 'https://updates.culler.z2hs.au'}/artifacts/windows` : undefined,
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
  const limit = Math.min(Number(req.query.limit || 10), 50);

  const rows = await pool.query(
    `SELECT version, release_name, release_notes, release_url, artifact_url, published_at, channel, platform
     FROM releases
     WHERE ($1::text IS NULL OR platform = $1)
       AND channel = $2
       AND rollout_state != 'hidden'
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
      releaseName: row.release_name,
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
