# Changelog

## 1.4.59 - 2026-06-25

### Changed
- **Unified release line.** Merged the `perf/review-loop-scaling` (AI review loop scaling, face-review cancellation on close, large-batch scheduling) and `feature/taekwondo-sports-culling` work into the photographer-schedule-import branch so all recent fixes and features ship together.

### Fixed
- Resolved a merge conflict in the destination folder preview so the `{photographerCode}` token is preserved end to end.
- Made the import-engine format-conversion tests platform-aware: Linux now asserts the ImageMagick `convert` path, macOS keeps `sips`, and Windows keeps PowerShell. Previously the suite assumed `sips` on every non-Windows platform and failed on Linux/CI.

### Repo health
- Added `.gitattributes` to normalize line endings to LF, eliminating CRLF/LF churn that produced phantom whole-file diffs on Windows checkouts.

### Verified
- `npm run typecheck` — clean
- `npm test` — 505 passed, 11 skipped (36 files)

## 1.4.53 - 2026-06-04

### Added
- **Taekwondo / martial-arts and Combat / contact-sports session types.** Action-first culling that rewards athlete-to-athlete contact (sparring/kick exchanges), frozen peak motion, emotion at impact, and clean team/group focus. New scene buckets: Sparring / contact, Kicks / action, Poomsae / form, Team / group.
- **Cull to budget.** One-click reduce a huge batch to a hard keeper count (e.g. 25k → ~1000). Keeps the strongest frame per burst/visual/face group first for variety, always retains protected/rated/picked shots, and is undoable. Also suppresses visual near-duplicates by perceptual hash, so consecutive near-identical frames and RAW+JPEG pairs collapse even when burst detection missed them (e.g. RAW files with no parseable capture time).
- **Optional pose estimation (MoveNet).** When the optional `movenet_thunder.onnx` model is installed and a sports session type is active, scoring uses measured kick straightness (hip-knee-ankle extension) and real foot-to-torso contact instead of person-box proxies. Fully gated — zero cost and no behaviour change when the model is absent.

### Changed
- **Faster face analysis on crowded frames (10k+ people).** Embedding count now scales down as faces-per-frame rises (12+ faces → embed only the 4 strongest), since packed-stand spectators have little identity value but dominate cost.
- Sports action scoring tuned against real event photos: sharpness signal rescaled for well-lit shoots (no longer saturates), with duel-aware contact weighting and crowd damping so clean kicks surface above static clumps.

### Verified
- `npm run typecheck`
- `npm test` (496 passing)
- `npm run audit:runtime` (0 vulnerabilities)

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
- Added Settings > Diagnostics with app version, update endpoint status, license