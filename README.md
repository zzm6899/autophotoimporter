<p align="center">
  <img src="./assets/brand/logo-black.svg" alt="Keptra" width="260" />
</p>

<p align="center">
  Import photos and videos from cameras, SD cards, and FTP-enabled devices.
</p>

<p align="center">
  <em>Canceled Adobe, so no more Lightroom Classic for me.<br/>I realized I missed the way it imported photos, so I built my own :) (with the help of Claudio)</em>
</p>

<p align="center">
  <a href="https://github.com/zzm6899/autophotoimporter/releases/latest">
    <img src="https://img.shields.io/github/v/release/zzm6899/autophotoimporter?include_prereleases&label=download&color=black" alt="Download" />
  </a>
</p>

---

## Features

- Install on macOS from a DMG or Windows from an EXE.
- Keptra detects cameras and SD cards as they mount and lists cards with DCIM folders first. It can also pull photos from Wi-Fi cameras or network storage over FTP or FTPS.
- Files you locked in-camera or marked read-only appear first. Pick or reject photos before importing, or filter to protected files, picks, rejects, unrated photos or duplicates.
- Keptra reads EXIF `Rating` / `RatingPercent`. Use the keyboard to set 0 to 5 stars. Quick-cull mode opens the detail view and advances when you rate a photo.
- See EXIF data such as date, camera model, lens, dimensions, ISO, aperture and shutter speed. Export a CSV of all scanned files with ratings, picks, camera details and EXIF data.
- Organize imports by `YYYY/YYYY-MM-DD` or your own pattern. Keptra skips files already at the destination.
- The light and dark themes follow your system setting.

## Download

**macOS:** Download the matching Intel (`x64`) or Apple Silicon (`arm64`) `.dmg`, open it, then drag Keptra to Applications. Download updates as DMGs until the signed and notarized updater is ready.

**Windows:** Download `Keptra-Setup.exe`. If SmartScreen warns on first run, click **More info → Run anyway**. Each release also includes a portable `.zip` you can run without an installer.

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

**Test** checks the connection and counts media files. **Mirror & Scan** downloads everything under the remote path to a staging directory inside the app's user data folder. The scan handles EXIF, duplicates, picks and imports the same way it does for a local card. Subsequent mirrors skip files already present at the same size.

## Protected / locked files first

Keptra shows files that are read-only at the filesystem level at the top of the grid with a green **PROTECTED** badge. This can happen when you use the camera's "Protect" button or physically write-lock the card. Use the **Protected** filter to see only those files.

## AI acceleration and diagnostics

Keptra runs face, person, eye-detail and similarity analysis locally through ONNX Runtime. The execution provider depends on the platform and model.

- **Windows:** the face detector and face embedder benchmark DirectML against CPU at startup and keep DirectML only when it is stable and measurably faster. Person detection remains on CPU.
- **macOS and Linux:** the current build uses CPU inference. CoreML and CUDA are not shipped execution providers yet.
- When a model or provider fails, Keptra reports an error for that file and lets you retry. It does not cache the failure as a valid "no subject found" result.

Open **Settings → Workflow → Performance → Diagnose GPU** to see the provider, model-load time, warm inference timing and fallback reason on your machine. RAW preview size, storage, subject count and hardware all affect those timings. Keptra doesn't publish per-photo timings it hasn't verified.

## Compatibility & Support Matrix

<!-- SUPPORT_MATRIX:START -->
| OS | FTP | GPU provider | Auto-updates |
| --- | --- | --- | --- |
| Windows 10/11 | Supported | Benchmarked DirectML for face models; CPU person detector/fallback | Supported (Squirrel + hosted feed) |
| macOS 13+ (Intel/Apple Silicon) | Supported | CPU | Manual DMG download/install |
| Linux (dev/test) | Supported | CPU | Not packaged for end users |

_Generated from `docs/support-matrix.json` on 2026-08-13._
<!-- SUPPORT_MATRIX:END -->

## Build from Source

```bash
git clone https://github.com/zzm6899/autophotoimporter.git
cd importer
npm ci
npm start            # dev mode (whichever OS you run it on)
npm run make         # build installers for the host platform
```

Requires **Node 20+**.

- On **macOS** `npm run make` produces a `.dmg` and a `.zip` under `out/make/`.
- On **Windows** it produces `Keptra-Setup.exe` (Squirrel), a `.nupkg`, and a portable `.zip` under `out/make/`.

Useful macOS build shortcuts:

```bash
npm run make:mac       # current Mac architecture
npm run make:mac:x64   # Intel build
npm run make:mac:arm64 # Apple Silicon build
```

The macOS app bundle metadata is set in `forge.config.ts`:

- App name: `Keptra`
- Bundle ID: `au.z2hs.keptra` by default, or `MAC_APP_BUNDLE_ID`
- Category: `public.app-category.photography`
- DMG icon/background: `assets/brand/icon.icns` and `assets/brand/dmg-bg.png`

For signed and notarized GitHub release builds, add these repository secrets:

- `APPLE_CERTIFICATE_BASE64` — base64-encoded `.p12` Developer ID Application certificate
- `APPLE_CERTIFICATE_PASSWORD` — password for that `.p12`
- `APPLE_SIGNING_IDENTITY` — usually `Developer ID Application: Your Name (TEAMID)`
- `APPLE_ID` — Apple developer account email
- `APPLE_APP_SPECIFIC_PASSWORD` — app-specific Apple ID password
- `APPLE_TEAM_ID` — Apple Developer Team ID

Optional:

- `APPLE_KEYCHAIN_PASSWORD` — temporary CI keychain password
- `MAC_APP_BUNDLE_ID` — override for the default `au.z2hs.keptra`
- `REQUIRE_MAC_SIGNING=true` — fail release builds instead of producing unsigned macOS artifacts

Unsigned macOS DMG/ZIP artifacts can still be built without Apple secrets. They are useful for private testing, but macOS Gatekeeper will warn users until the app is signed and notarized with an Apple Developer ID certificate.

### Windows one-shot setup

Double-click `scripts\setup-windows.cmd` or run it from a Command Prompt in the repo root. It checks for Node 20+, installs dependencies and lets you choose dev, build or install-only. You can also pass the action directly:

```cmd
scripts\setup-windows.cmd dev      :: install + npm start (dev mode)
scripts\setup-windows.cmd build    :: install + npm run make (produces Keptra-Setup.exe)
scripts\setup-windows.cmd install  :: install deps only
```

The GitHub Actions workflow now builds release artifacts from version tags. From Windows CMD or PowerShell:

```cmd
git tag v1.1.6
git push origin v1.1.6
```

That tag triggers GitHub Actions to build both macOS and Windows. If the TrueNAS publish secrets are configured, the workflow also mirrors the public artifacts into the hosted update feed automatically.

### Release readiness

Before tagging, follow [docs/release-checklist.md](docs/release-checklist.md). The short version is:

```bash
npm run verify
npm run make
npm run package:smoke
npm run bench:smoke
npm run release:manifest
```

`npm run release:manifest` writes `artifacts/release/release-readiness-manifest.json` with the package version, git commit, smoke manifests, benchmark summaries, support matrix, artifact list, and key release commands.

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

MIT

## Hosted Updates

For the TrueNAS-hosted update/admin stack:

1. Clone this repo onto the TrueNAS server.
2. Copy `.env.truenas.example` to `.env` and fill in real secrets.
3. Start from repo root:

Generate the random secret values with one of:

```bash
openssl rand -hex 32
```

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
```

Use different generated values for `ADMIN_SESSION_SECRET`, `UPDATE_TOKEN_SECRET`, and `ADMIN_API_TOKEN`. The server rejects empty values and unchanged `CHANGE_ME` / `REPLACE_WITH` placeholders.

```bash
docker compose up -d --build
```

Public endpoints:

- `https://keptra.z2hs.au`
- `https://admin.keptra.z2hs.au`
- `https://updates.keptra.z2hs.au`

To set up the stack in the TrueNAS Apps UI, use this file instead of running `docker compose`:

- [deploy/truenas/custom-app.yaml](deploy/truenas/custom-app.yaml)

The hosted admin image is published from the private GitHub repo to:

- `ghcr.io/zzm6899/photo-importer-update-admin:latest`

Artifacts are served from the repo-root `artifacts/` directory through Caddy at:

- `https://keptra.z2hs.au/artifacts/...`
- `https://updates.keptra.z2hs.au/artifacts/...`

Optional private-GitHub sync for the admin panel:

- `GITHUB_RELEASE_OWNER`
- `GITHUB_RELEASE_REPO`
- `GITHUB_RELEASE_TOKEN`
- `GITHUB_API_BASE_URL` (defaults to `https://api.github.com`)

Local/manual release registration:

```powershell
$env:UPDATE_ADMIN_API_TOKEN="your-admin-api-token"
npm run update:publish -- --endpoint https://admin.keptra.z2hs.au --platform windows --version 1.1.11 --file .\out\make\squirrel.windows\x64\Keptra-Setup.exe --release-name "Keptra 1.1.11" --release-url https://keptra.z2hs.au/releases/1.1.11 --notes "Manual release import" --rollout live
```

The helper uploads the installer to the hosted admin and update service, then registers the release. GitHub Actions does this automatically when you set `UPDATE_ADMIN_ENDPOINT` and `UPDATE_ADMIN_API_TOKEN` as repo secrets.

If the hosted admin container has both `public.pem` and `private.pem` mounted, the Licenses page can also generate customer license keys directly in the web UI.
