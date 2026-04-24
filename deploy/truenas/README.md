# TrueNAS Update Stack

This stack hosts:

- `admin.culler.z2hs.au` for the admin panel
- `updates.culler.z2hs.au` for the desktop app update API and download redirects

The Node service listens on `0.0.0.0:5071` inside the app container, and the reverse proxy publishes it over HTTPS.

## TrueNAS Apps UI

If you want this to show up in the TrueNAS Apps UI as a Custom App, use:

- [custom-app.yaml](/C:/Users/24681/Documents/Claude/importer/deploy/truenas/custom-app.yaml)

Recommended image:

- `ghcr.io/zzm6899/photo-importer-update-admin:latest`

This image is published from the private GitHub repo by:

- [publish-update-admin-image.yml](/C:/Users/24681/Documents/Claude/importer/.github/workflows/publish-update-admin-image.yml)

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
3. Make sure `../../scripts/license-keys/public.pem` contains the public key that matches the private key used to generate customer licenses.
4. If you want the hosted admin panel to generate customer keys itself, also mount `../../scripts/license-keys/private.pem` into the app container. Keep it secret.
5. Point DNS for:
   - `admin.culler.z2hs.au`
   - `updates.culler.z2hs.au`
6. Start the stack:

```bash
docker compose up -d --build
```

If you are using the Apps UI instead of `docker compose`, create these host paths first:

- `/mnt/tank/apps/photo-importer/postgres`
- `/mnt/tank/apps/photo-importer/artifacts`
- `/mnt/tank/apps/photo-importer/scripts/license-keys/public.pem`
- `/mnt/tank/apps/photo-importer/scripts/license-keys/private.pem`

The included [custom-app.yaml](/C:/Users/24681/Documents/Claude/importer/deploy/truenas/custom-app.yaml) mounts both `public.pem` and `private.pem`, so the Licenses page can generate and store customer keys directly in the web UI.

## Publish Flow

Import a release from CI or your release machine:

```bash
node scripts/publish-update-release.mjs \
  --endpoint https://admin.culler.z2hs.au \
  --token "$UPDATE_ADMIN_API_TOKEN" \
  --version 1.1.1 \
  --platform windows \
  --release-name "Photo Importer 1.1.1" \
  --artifact-url https://updates.culler.z2hs.au/artifacts/windows/PhotoImporter-Setup-1.1.1.exe \
  --release-url https://admin.culler.z2hs.au/releases/1.1.1 \
  --notes "Improved culling and hosted updates" \
  --rollout live
```
