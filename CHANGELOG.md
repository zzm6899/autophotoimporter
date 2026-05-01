# Changelog

## 1.4.15 - 2026-05-02

### Changed
- Prepared a clean `1.4.15` release build after the import reliability workflow work.
- Confirmed the packaged app launch smoke reports the new app version through the packaged Electron runtime.

### Verified
- `npm run typecheck -- --pretty false`
- `npm test`
- `npm run visual:smoke`
- `npm run package`
- `npm run package:smoke`
- `npm run make`
- `npm run release:manifest`

## 1.4.12 - 2026-05-01

### Fixed
- Fixed a `ThumbnailGrid` React hook-order crash that could appear when moving from settings, empty, or loading states into the photo grid.
- Kept the new filtered-set import controls while making their hooks render consistently across every UI state.

### Verified
- Built and published the Windows update through GitHub Actions.
- Confirmed the live updater serves `1.4.12` to Windows `1.4.0` clients from:
  - `https://keptra.z2hs.au`
  - `https://updates.keptra.z2hs.au`
  - `https://updates.culler.z2hs.au`

## 1.4.11 - 2026-05-01

### Added
- Added Settings > Diagnostics with app version, update endpoint status, license status, saved settings path, last update check, and last update error.
- Added Copy diagnostics and Repair updates actions for safer support and recovery.
- Added user-safe update/TLS error messaging so temporary endpoint failures do not show scary raw protocol errors.
- Added current-filter bulk actions for picking, rejecting, clearing, queueing, and importing visible files.
- Added clearer import preflight details, metadata visibility, path safety warnings, Copy Report, and Export Manifest.
- Added admin Health checks for required secrets, release artifact availability, update endpoint status, and latest Windows stable selection.
- Added a release smoke script and release notes template for repeatable update publishing.

### Changed
- Preserved license and settings storage across update installs; no license schema changes.
- Improved legacy update compatibility for Culler-hosted update clients.

### Verified
- `npm run verify`
- `npm run release:smoke`
