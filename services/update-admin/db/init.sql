CREATE TABLE IF NOT EXISTS admin_users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS license_records (
  id SERIAL PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  license_key TEXT NOT NULL,
  activation_code TEXT UNIQUE,
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
);

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
);

CREATE INDEX IF NOT EXISTS idx_license_activations_license
  ON license_activations(license_fingerprint, last_seen_at DESC);

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
);

CREATE INDEX IF NOT EXISTS idx_releases_platform_channel_state
  ON releases(platform, channel, rollout_state, published_at DESC);

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
);
