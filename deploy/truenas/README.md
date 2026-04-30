# TrueNAS Update Stack

This stack hosts:

- `keptra.z2hs.au` for the public website, desktop app update API, license API, checkout, and download redirects
- `admin.keptra.z2hs.au` for the admin panel

The Node service listens on `0.0.0.0:5071` inside the app container, and the reverse proxy publishes it over HTTPS.

## TrueNAS Apps UI

If you want this to show up in the TrueNAS Apps UI as a Custom App, use:

- [custom-app.yaml](deploy/truenas/custom-app.yaml)

Recommended image:

- `ghcr.io/zzm6899/photo-importer-update-admin:latest`

This image is published from the private GitHub repo by:

- `publish-update-admin-image.yml` (private workflow in release infra repo)

In TrueNAS:

1. Apps
2. Discover Apps
3. `...`
4. Install via YAML
5. Paste the contents of `custom-app.yaml`
6. Replace all `CHANGE_ME_...` values before saving

## Setup

1. Copy `.env.example` to `.env`
2. Set strong values for:
   - `POSTGRES_PASSWORD`
   - `ADMIN_EMAIL`
   - `ADMIN_PASSWORD`
   - `ADMIN_SESSION_SECRET`
   - `UPDATE_TOKEN_SECRET`
   - `ADMIN_API_TOKEN`
   - `GITHUB_RELEASE_TOKEN` if the repo is private and you want the admin panel to read the latest GitHub release metadata
3. Make sure `../../scripts/license-keys/public.pem` contains the public key that matches the private key used to generate customer licenses.
4. If you want the hosted admin panel to generate customer keys itself, also mount `../../scripts/license-keys/private.pem` into the app container. Keep it secret.
5. Point DNS for:
   - `keptra.z2hs.au`
   - `admin.keptra.z2hs.au`
   - `updates.keptra.z2hs.au` only if you still need the legacy update subdomain
6. Start the stack:

```bash
docker compose up -d --build
```

If you are using the Apps UI instead of `docker compose`, create these host paths first:

- `/mnt/tank/apps/photo-importer/postgres`
- `/mnt/tank/apps/photo-importer/artifacts`
- `/mnt/tank/apps/photo-importer/scripts/license-keys/public.pem`
- `/mnt/tank/apps/photo-importer/scripts/license-keys/private.pem`

The included [custom-app.yaml](deploy/truenas/custom-app.yaml) mounts both `public.pem` and `private.pem`, so the Licenses page can generate and store customer keys directly in the web UI.

## Publish Flow

Import a release from CI or your release machine:

```bash
node scripts/publish-update-release.mjs \
  --endpoint https://admin.keptra.z2hs.au \
  --token "$UPDATE_ADMIN_API_TOKEN" \
  --version 1.1.1 \
  --platform windows \
  --release-name "Keptra 1.1.1" \
  --file ./out/make/squirrel.windows/x64/Keptra-Setup.exe \
  --release-url https://keptra.z2hs.au/releases/1.1.1 \
  --notes "Improved culling and hosted updates" \
  --rollout live
```

If your repo is private, you can also configure the admin panel to inspect the latest GitHub release from TrueNAS itself by setting:

- `GITHUB_RELEASE_OWNER`
- `GITHUB_RELEASE_REPO`
- `GITHUB_RELEASE_TOKEN`
- `GITHUB_API_BASE_URL` (optional)

Those values are now exposed in [custom-app.yaml](deploy/truenas/custom-app.yaml), so they stay easy to edit from the TrueNAS Apps UI.
