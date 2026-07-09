# Changelog

## 1.5.3 - 2026-07-10

### Changed
- **AI UI hides when AI review is disabled.** With the AI review master switch off, the toolbar no longer shows the "AI x/y" counter, "Auto speed", "Pause/Resume AI", or "Best Page" buttons, and the AI Overview strip stays hidden — no more "Analyzing 0/16449" while analysis is intentionally off. The `ai.toggle`/`ai.overview` keybinds become no-ops too. Everything reappears when the switch is turned back on.

### Verified
- `npm run typecheck` — clean
- `npm test` — 514 passed, 11 skipped (37 files)

## 1.5.2 - 2026-07-10

### Fixed
- **Blank thumbnails/previews in restored review sessions.** Session restore only rebuilt renderer state; after an app restart the main process had an empty scan set, so its security path-guard rejected every thumbnail and preview request — the grid showed metadata and badges but no images (most visible on RAW-heavy sessions). Restoring a session now re-registers the file set with the main process, and thumbnails/previews regenerate on demand from the source files.
- Grid-cell rehydration now requests the lightweight embedded thumbnail instead of a full 1920px preview per cell — restored 10k+ file sessions fill the grid far faster (a RAW preview costs a multi-MB byte-scan; the embedded thumb is near-free).

### Added
- End-to-end main-process pipeline test using a synthetic NEF (real scanner, exifr, sharp, and the keptra-preview protocol handler — only Electron mocked), covering live scans, the app-restart/restore case, and both thumb and loupe variants.

### Verified
- `npm run typecheck` — clean
- `npm test` — 514 passed, 11 skipped (37 files)

## 1.5.1 - 2026-07-09

### Culling responsiveness

### Added
- **AI review master switch.** Settings → performance now has a single toggle that fully disables the AI review pipeline: no face/person scans, no sharpness or duplicate scoring, zero background analysis while culling. Previously even Fast Keeper mode kept canvas-based scoring running.
- **Navigation quiet window.** The review loop now goes completely quiet for ~1.2s after every focus/navigation event and resumes when input goes idle. Flipping through images no longer competes with ONNX inference and canvas scoring — this was the main cause of 1–3s full-preview loads on capable hardware.

### Changed
- **Focused-image previews skip every queue.** High-priority (focused) preview requests borrow an extra renderer worker slot and bypass the main-process generation lane, so navigation never waits behind background preview warms.
- Re-opening an image whose preview is already cached now renders immediately (the 80–220ms debounce only applies to first loads).
- Default preview workers 2 → 3 (and balanced-tier hardware profile floors at 3) — sharp resizes run off-thread, so the extra lane is free responsiveness.

### Fixed
- The `v1.5.0` tag was cut from a commit that predated the face-recognition fix for new devices/external sources/JPEGs (`daee8c5`); 1.5.1 includes it.

### Verified
- `npm run typecheck` — clean
- `npm test` — 510 passed, 11 skipped (36 files)

## 1.5.0 - 2026-07-07

### Performance overhaul — previews, culling, import, and export

### Added
- **sharp (libvips) image engine.** Previews, thumbnails, and format conversions now run in-process on worker threads instead of spawning PowerShell/sips/ImageMagick per file (~4x faster than ImageMagick, far more vs PowerShell spawn overhead, and no longer blocking the main-process event loop). Loads lazily with automatic fallback to the previous platform tools when unavailable (foreign-arch builds, HEIC output, camera-RAW input).
- **`keptra-preview://` protocol.** Grid thumbnails and loupe/detail previews stream from the main-process disk/memory cache straight into `<img>` tags. No more base64 payloads over IPC (+33% size, structured-clone stalls) and no more multi-hundred-MB preview strings in renderer memory on 10k+ file scans. Canvas consumers (histogram, clipping, face crops, sharpness analysis) load protocol images with `crossOrigin="anonymous"` against ACAO-enabled responses so readback never taints.
- **Video grid thumbnails via system ffmpeg.** When ffmpeg is on PATH, videos get a real frame in the grid (t=1s, falling back to t=0 for short clips); without it they keep the placeholder as before. Keptra still ships no ffmpeg.

### Changed
- **Checksum-verified imports read the source card once, not twice.** The copy stream hashes the source inline; only the destination is re-read for verification. Roughly a third less I/O per verified import.
- **Sharp-powered converted imports.** JPEG/TIFF exports with exposure normalization, white balance, watermarks (image and SVG-text with a one-time font probe), and EXIF-orientation baking — pixel-parity multipliers with the old GDI+/ImageMagick paths, with EXIF/ICC preserved. Converted-import concurrency 2 → 4 when sharp is active.
- Detail-preview lane 1 → 2 concurrent when sharp is active; scanner slow-lane thumbnails 4 → 10 wide.
- Directory walk stats files in batches of 16 instead of one at a time.
- Embedded RAW previews are persisted to the disk cache (previously re-extracted from the RAW on every request); cached previews are served without occupying a generation slot.
- Contact sheet preview hydration runs 6-wide (was fully sequential for up to 500 files).

### Verified
- `npm run typecheck` — clean
- `npm test` — 510 passed, 11 skipped (36 files)
- sharp conversion parity validated pixel-exact on synthetic images (per-channel multipliers, EXIF rotation baking, watermark compositing, metadata preservation)

## 1.4.60 - 2026-06-25

### Repo health
- Renormalized all tracked text files to LF per `.gitattributes`, collapsing the phantom whole-file CRLF diffs that appeared on Windows checkouts.
- Removed five deprecated completion-summary doc stubs (`GPU_CHANGES_SUMMARY`, `GPU_COMPLETE`, `IMPLEMENTATION_COMPLETE`, `RAW_CPU_COMPLETE`, `STATUS_COMPLETE`) that only redirected to `docs/architecture-status.md`.
- Completed the truncated 1.4.11 changelog entry and reconciled `main` with the upstream taekwondo/sports-culling PR merges so the release line is unified.

### Verified
- `npm run verify` — typecheck clean, 505 passed / 11 skipped, runtime audit clear at the high threshold.

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
