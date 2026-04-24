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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://photo_importer:photo_importer@db:5432/photo_importer_updates',
});

app.set('trust proxy', true);
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

function htmlPage(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f172a;color:#e2e8f0;margin:0}
    a{color:#93c5fd;text-decoration:none}
    code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
    .shell{max-width:1120px;margin:0 auto;padding:24px}
    .top{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:20px}
    .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:20px}
    .card,.panel{background:#111827;border:1px solid #334155;border-radius:14px;padding:16px}
    .panel{margin-bottom:16px}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th,td{padding:10px 8px;border-bottom:1px solid #334155;text-align:left;vertical-align:top}
    input,textarea,select{width:100%;background:#0f172a;border:1px solid #334155;border-radius:10px;color:#e2e8f0;padding:10px;box-sizing:border-box}
    textarea[readonly]{background:#020617}
    button{background:#2563eb;color:white;border:none;border-radius:10px;padding:10px 14px;cursor:pointer}
    button.secondary{background:#334155}
    form.inline{display:inline}
    .muted{color:#94a3b8;font-size:13px}
    .row{display:flex;gap:10px}
    .row > *{flex:1}
    .nav{display:flex;gap:10px;flex-wrap:wrap}
    .pill{display:inline-block;padding:4px 8px;border-radius:999px;background:#1e293b;font-size:12px}
    .ok{color:#86efac}
    .bad{color:#fca5a5}
    .actions{display:flex;gap:10px;flex-wrap:wrap}
    @media (max-width: 900px){.row{flex-direction:column}}
  </style>
</head>
<body><div class="shell">${body}</div></body></html>`;
}

function nav() {
  return `<div class="nav">
    <a href="/admin">Dashboard</a>
    <a href="/admin/licenses">Licenses</a>
    <a href="/admin/releases">Releases</a>
    <a href="/admin/customers">Customers</a>
    <form class="inline" method="post" action="/admin/logout"><button class="secondary" type="submit">Log out</button></form>
  </div>`;
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
    return {
      ok: false,
      status: 403,
      message: `Updates are blocked for this license (${record.status}).`,
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

app.get('/healthz', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
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
    <div class="top"><div><h1>Update Admin</h1><p class="muted">admin.culler.z2hs.au</p></div>${nav()}</div>
    <div class="cards">
      ${licenseStats.rows.map((row) => `<div class="card"><div class="muted">Licenses - ${row.status}</div><div style="font-size:28px;font-weight:700">${row.count}</div></div>`).join('')}
      ${releaseStats.rows.map((row) => `<div class="card"><div class="muted">Releases - ${row.platform} / ${row.rollout_state}</div><div style="font-size:28px;font-weight:700">${row.count}</div></div>`).join('')}
    </div>
    <div class="panel">
      <h2>Recent update activity</h2>
      <table><thead><tr><th>Event</th><th>Detail</th><th>Time</th></tr></thead><tbody>
      ${recentEvents.rows.map((row) => `<tr><td>${row.event_type}</td><td>${row.detail || ''}</td><td>${new Date(row.created_at).toLocaleString('en-AU')}</td></tr>`).join('')}
      </tbody></table>
    </div>
  `));
});

app.get('/admin/licenses', authSession, async (_req, res) => {
  const result = await pool.query('SELECT * FROM license_records ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT 100');
  const generatorEnabled = canGenerateLicenses();

  res.send(htmlPage('Licenses', `
    <div class="top"><div><h1>Licenses</h1><p class="muted">Import, generate, revoke, and track entitlement state.</p></div>${nav()}</div>
    <div class="grid">
      <div class="panel">
        <h2>Generate license</h2>
        ${generatorEnabled
          ? `<p class="muted">Create a Full access customer key right here in the admin panel. Expiry uses DD-MM-YYYY.</p>
        <form method="post" action="/admin/licenses/generate">
          <label>Customer name</label>
          <input name="name" required />
          <div style="height:10px"></div>
          <label>Email</label>
          <input type="email" name="email" />
          <div style="height:10px"></div>
          <label>Expiry</label>
          <input name="expiry" placeholder="31-12-2027" />
          <div style="height:10px"></div>
          <label>Notes</label>
          <textarea name="notes" rows="2"></textarea>
          <div style="height:14px"></div>
          <button type="submit">Generate and store</button>
        </form>`
          : `<p class="bad">License generation is disabled on this server because <code>private.pem</code> is not mounted into the app container yet.</p>
        <p class="muted">You can still import already-generated licenses below.</p>`}
      </div>
      <div class="panel">
        <h2>Import existing license</h2>
        <form method="post" action="/admin/licenses/import">
          <label>License key</label>
          <textarea name="licenseKey" rows="4" required></textarea>
          <div style="height:10px"></div>
          <label>Notes</label>
          <textarea name="notes" rows="2"></textarea>
          <div style="height:14px"></div>
          <button type="submit">Store license</button>
        </form>
      </div>
      <div class="panel">
        <h2>Status guide</h2>
        <p class="muted">Active can update, revoked blocks updates immediately, expired is for admin-side mirror of a lapsed subscription, and disabled is a temporary hold.</p>
        <p class="muted">Generated keys use the same offline format as the desktop app, so they keep working with your shipped EXE as long as the same private key is used.</p>
      </div>
    </div>
    <div class="panel">
      <table><thead><tr><th>Customer</th><th>Status</th><th>Expires</th><th>Last seen</th><th>Action</th></tr></thead><tbody>
      ${result.rows.map((row) => `<tr>
        <td><strong>${row.customer_name}</strong><div class="muted">${row.customer_email || ''}</div></td>
        <td><span class="pill">${row.status}</span></td>
        <td>${formatLicenseDate(row.expires_at)}</td>
        <td>${row.last_seen_at ? new Date(row.last_seen_at).toLocaleString('en-AU') : 'Never'}</td>
        <td>
          ${row.status !== 'revoked' ? `<form class="inline" method="post" action="/admin/licenses/${row.id}/revoke"><button class="secondary" type="submit">Revoke</button></form>` : ''}
          ${row.status !== 'active' ? `<form class="inline" method="post" action="/admin/licenses/${row.id}/activate"><button class="secondary" type="submit">Activate</button></form>` : ''}
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

    await upsertLicenseRecord(validated, req.body.notes);

    return res.send(htmlPage('License Generated', `
      <div class="top"><div><h1>License generated</h1><p class="muted">Store this key somewhere safe before leaving the page.</p></div>${nav()}</div>
      <div class="panel">
        <p><strong>${validated.entitlement.name}</strong>${validated.entitlement.email ? ` <span class="muted">(${validated.entitlement.email})</span>` : ''}</p>
        <p class="muted">Full access${validated.entitlement.expiresAt ? ` until ${formatLicenseDate(validated.entitlement.expiresAt)}` : ' with no expiry'}.</p>
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
    <div class="top"><div><h1>Releases</h1><p class="muted">Publish from private GitHub into the hosted update feed.</p></div>${nav()}</div>
    <div class="grid">
      <div class="panel">
        <h2>Import release</h2>
        <form method="post" action="/admin/releases">
          <div class="row">
            <div><label>Version</label><input name="version" placeholder="1.1.1" required /></div>
            <div><label>Platform</label><select name="platform"><option value="windows">Windows</option><option value="macos">macOS</option></select></div>
          </div>
          <div style="height:10px"></div>
          <div class="row">
            <div><label>Channel</label><input name="channel" value="stable" required /></div>
            <div><label>Rollout</label><select name="rolloutState"><option value="draft">Draft</option><option value="live">Live</option><option value="hidden">Hidden</option></select></div>
          </div>
          <div style="height:10px"></div>
          <label>Release name</label><input name="releaseName" placeholder="Photo Importer 1.1.1" required />
          <div style="height:10px"></div>
          <label>Release URL</label><input name="releaseUrl" placeholder="https://admin.culler.z2hs.au/releases/1.1.1" />
          <div style="height:10px"></div>
          <label>Artifact URL</label><input name="artifactUrl" placeholder="https://updates.culler.z2hs.au/artifacts/windows/PhotoImporter-Setup-1.1.1.exe" required />
          <div style="height:10px"></div>
          <label>Release notes</label><textarea name="releaseNotes" rows="4"></textarea>
          <div style="height:14px"></div>
          <button type="submit">Save release</button>
        </form>
      </div>
      <div class="panel">
        <h2>Automation</h2>
        <p class="muted">Use the admin API token with the scripts/publish-update-release.mjs helper from CI or your local release machine to import Windows/macOS artifacts after GitHub builds them.</p>
      </div>
    </div>
    <div class="panel">
      <table><thead><tr><th>Version</th><th>Platform</th><th>Rollout</th><th>Published</th><th>Actions</th></tr></thead><tbody>
      ${releases.rows.map((row) => `<tr>
        <td><strong>${row.release_name}</strong><div class="muted">${row.version}</div></td>
        <td>${row.platform}</td>
        <td><span class="pill">${row.rollout_state}</span></td>
        <td>${new Date(row.published_at).toLocaleString('en-AU')}</td>
        <td>
          ${row.rollout_state !== 'live' ? `<form class="inline" method="post" action="/admin/releases/${row.id}/live"><button class="secondary" type="submit">Go live</button></form>` : ''}
          ${row.rollout_state !== 'hidden' ? `<form class="inline" method="post" action="/admin/releases/${row.id}/hide"><button class="secondary" type="submit">Hide</button></form>` : ''}
        </td>
      </tr>`).join('')}
      </tbody></table>
    </div>
  `));
});

app.post('/admin/releases', authSession, async (req, res) => {
  await pool.query(
    `INSERT INTO releases (version, platform, channel, release_name, release_notes, release_url, artifact_url, rollout_state, published_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
    [
      req.body.version,
      req.body.platform,
      req.body.channel || 'stable',
      req.body.releaseName,
      req.body.releaseNotes || null,
      req.body.releaseUrl || null,
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

app.get('/admin/customers', authSession, async (_req, res) => {
  const rows = await pool.query(`
    SELECT fingerprint, MAX(created_at) AS last_event, MAX(detail) FILTER (WHERE detail IS NOT NULL) AS detail
    FROM update_events
    GROUP BY fingerprint
    ORDER BY MAX(created_at) DESC
    LIMIT 100
  `);
  res.send(htmlPage('Customers', `
    <div class="top"><div><h1>Customers / installs</h1><p class="muted">Latest seen update activity per install fingerprint.</p></div>${nav()}</div>
    <div class="panel">
      <table><thead><tr><th>Fingerprint</th><th>Last activity</th><th>Detail</th></tr></thead><tbody>
      ${rows.rows.map((row) => `<tr><td>${row.fingerprint || 'Unknown'}</td><td>${row.last_event ? new Date(row.last_event).toLocaleString('en-AU') : 'Never'}</td><td>${row.detail || ''}</td></tr>`).join('')}
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
  const result = await pool.query(
    `INSERT INTO releases (version, platform, channel, release_name, release_notes, release_url, artifact_url, rollout_state, published_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
     RETURNING id`,
    [version, platform, channel, releaseName, releaseNotes || null, releaseUrl || null, artifactUrl, rolloutState],
  );
  return res.json({ ok: true, id: result.rows[0].id });
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
  await ensureAdminUser();
  app.listen(port, '0.0.0.0', () => {
    console.log(`[update-admin] Listening on 0.0.0.0:${port}`);
  });
}

start().catch((err) => {
  console.error('[update-admin] Failed to start:', err);
  process.exit(1);
});
