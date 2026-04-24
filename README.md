<p align="center">
  <img src="./assets/brand/logo-black.svg" alt="Photo Importer" width="260" />
</p>

<p align="center">
  Import photos and videos from cameras, SD cards, and FTP-enabled devices.
</p>

<p align="center">
  <em>Canceled Adobe, so no more Lightroom Classic for me.<br/>I realized I missed the way it imported photos, so I built my own :) (with the help of Claudio)</em>
</p>

<p align="center">
  <a href="https://github.com/juanmnl/importer/releases/latest">
    <img src="https://img.shields.io/github/v/release/juanmnl/importer?include_prereleases&label=download&color=black" alt="Download" />
  </a>
</p>

---

## Features

- **Cross-platform** — macOS (DMG) and Windows (EXE installer) builds
- **Auto-detect volumes** — Cameras and SD cards detected on mount, DCIM cards sorted first
- **FTP source** — Pull images straight from Wi-Fi cameras or NAS via FTP / FTPS
- **Protected-first ordering** — Files you locked in-camera or flagged read-only appear at the top for fast import
- **Star ratings** — Read EXIF `Rating` / `RatingPercent` and set 0–5 stars with keyboard
- **Quick-cull mode** — Detail view + auto-advance on rate; tear through a shoot in minutes
- **Filters** — Protected / picked / rejected / unrated / duplicates
- **Manifest export** — CSV of every scanned file (rating, pick state, camera, EXIF)
- **EXIF metadata** — Date, camera model, lens, dimensions, ISO / aperture / shutter
- **Folder patterns** — Organize imports by `YYYY/YYYY-MM-DD` or custom patterns
- **Duplicate detection** — Skip files that already exist at the destination
- **Pick / Reject workflow** — Flag keepers and rejects before importing
- **Light & dark themes** — Follows system preference

## Download

Grab the latest alpha from [**Releases**](https://github.com/juanmnl/importer/releases/latest).

**macOS** — download the `.dmg`. macOS will block the first launch; go to **System Settings → Privacy & Security** and click **Open Anyway**.

**Windows** — download `PhotoImporter-Setup.exe`. SmartScreen may warn on first run — click **More info → Run anyway**. Portable `.zip` builds are also attached to each release if you'd rather avoid the installer.

## Keyboard Shortcuts

`⌘` on macOS, `Ctrl` on Windows.

| Key | Action |
| --- | --- |
| `Click` | Focus thumbnail |
| `Double-click` | Detail view |
| `⌘/Ctrl + Click` | Toggle select |
| `Shift + Click` | Range select |
| `⌘/Ctrl + A` | Select all |
| `P` / `X` / `U` | Pick / Reject / Clear flag |
| `0` – `5` | Star rating |
| `C` | Toggle quick-cull mode |
| `← → ↑ ↓` | Navigate |
| `Esc` | Deselect / Back |

## FTP source

For cameras and NAS devices that expose an FTP server (Canon EOS / Nikon WT / Sony FTP push, or your own server), switch the source panel to **FTP** and enter:

- Host and port (FTP default 21, FTPS-explicit common on 990)
- User, password
- Remote path (commonly `/DCIM`)

**Test** probes the connection and counts media. **Mirror & Scan** downloads everything under the remote path into a staging directory inside the app's user data folder and runs the normal scan over it — so EXIF, duplicate detection, picks and imports all behave the same as a local card. Re-mirrors are incremental; files already present at the same size are skipped.

## Protected / locked files first

Any file that is read-only at the filesystem level (e.g. you used the camera's in-body "Protect" button, or your card is physically write-locked) is surfaced at the top of the grid with a green **PROTECTED** badge. Pair with the **Protected** filter for a clean keepers-only view.

## Build from Source

```bash
git clone https://github.com/juanmnl/importer.git
cd importer
npm ci
npm start            # dev mode (whichever OS you run it on)
npm run make         # build installers for the host platform
```

Requires **Node 20+**.

- On **macOS** `npm run make` produces a `.dmg` and a `.zip` under `out/make/`.
- On **Windows** it produces `PhotoImporter-Setup.exe` (Squirrel), a `.nupkg`, and a portable `.zip` under `out/make/`.

### Windows one-shot setup

Prefer clicking over typing? Double-click `scripts\setup-windows.cmd` (or run it from a Command Prompt in the repo root). It verifies Node 20+, installs dependencies, and shows a menu for dev / build / install-only. You can also pass the action directly:

```cmd
scripts\setup-windows.cmd dev      :: install + npm start (dev mode)
scripts\setup-windows.cmd build    :: install + npm run make (produces PhotoImporter-Setup.exe)
scripts\setup-windows.cmd install  :: install deps only
```

The GitHub Actions workflow builds both platforms on every push to `main` and publishes them to a rolling `v1.1.0-alpha` prerelease.

## License keys

The app now supports signed offline license keys.

Windows shortcut: run `scripts\license-tools.cmd` for an interactive console menu.

You can also use the Node console directly:

```bash
npm run license:console -- status
npm run license:console -- keypair
npm run license:console -- create --name "Customer Name" --expiry 31-12-2027 --tier "Full access"
npm run license:console -- build
```

1. Run `npm run license:keypair` once on your machine. This creates:
   `scripts/license-keys/private.pem`
   `scripts/license-keys/public.pem`
   and updates `src/shared/license-public-key.ts`
2. Keep `scripts/license-keys/private.pem` secret.
3. Generate a customer key with:

```bash
npm run license:generate -- --name "Customer Name" --email "customer@example.com" --expiry 31-12-2027 --tier "Full access"
```

Paste the generated key into the app's **Settings → License** section to activate it.

Important: existing EXEs will continue to accept newly generated customer licenses as long as you keep using the same `private.pem`. If you replace the keypair, you must ship a new app build with the new public key.

Without a valid license, the app stays in browse/review mode and importing is blocked.

## Architecture notes

- **Electron + Vite + React 19** (HTML renderer, so the same UI ships to every OS)
- Platform-specific services are isolated to `src/main/services/*`:
  - `volume-watcher.ts` — `/Volumes` watcher on macOS, PowerShell / `Win32_LogicalDisk` polling on Windows, `/media` + `/run/media` on Linux
  - `exif-parser.ts` — `exifr` everywhere; thumbnail fallback uses `sips` (macOS), `System.Drawing` via PowerShell (Windows), `convert` (Linux)
  - `import-engine.ts` — same platform split for in-flight format conversion
  - `ftp-source.ts` — `basic-ftp` client that mirrors into a staging directory

## License

[MIT](./LICENSE)
"# autophotoimporter" 
"# autophotoimporter" 
# Hosted Updates

For the TrueNAS-hosted update/admin stack:

1. Clone this repo onto the TrueNAS server.
2. Copy `.env.truenas.example` to `.env` and fill in real secrets.
3. Start from repo root:

```bash
docker compose up -d --build
```

Public endpoints:

- `https://admin.culler.z2hs.au`
- `https://updates.culler.z2hs.au`

If you prefer the TrueNAS Apps UI instead of shell-driven `docker compose`, use:

- [deploy/truenas/custom-app.yaml](/C:/Users/24681/Documents/Claude/importer/deploy/truenas/custom-app.yaml)

The hosted admin image is published from the private GitHub repo to:

- `ghcr.io/zzm6899/photo-importer-update-admin:latest`

Artifacts are served from the repo-root `artifacts/` directory through Caddy at:

- `https://updates.culler.z2hs.au/artifacts/...`

Windows release publishing from your local machine:

```powershell
$env:UPDATE_ADMIN_API_TOKEN="your-admin-api-token"
npm run release:windows -- -Version 1.1.1 -ServerUser root -ServerHost 172.20.20.251
```

You can also run the PowerShell script directly:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\release-windows.ps1 -Version 1.1.1
```

That script builds the Windows installer, uploads the EXE / `RELEASES` / `.nupkg` files to the TrueNAS repo, and registers the release with the hosted admin API.

If the hosted admin container has both `public.pem` and `private.pem` mounted, the Licenses page can also generate customer license keys directly in the web UI.
