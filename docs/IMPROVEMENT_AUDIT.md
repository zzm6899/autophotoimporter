# Improvement Audit — July 2026

Codebase review focused on culling speed, import/export efficiency, and editing. Ten changes were implemented and verified (`tsc` clean, 510 tests passing); the rest are prioritized recommendations. Shipped as v1.5.0.

## Implemented

### 1. sharp (libvips) fast path for previews and thumbnails
`src/main/services/exif-parser.ts`, `vite.main.config.ts`, `package.json`

Every preview and thumbnail resize previously went through a per-file process spawn (PowerShell + GDI+ on Windows, `sips` on macOS, ImageMagick on Linux) or synchronous `nativeImage` work on the main-process event loop. sharp now handles these in-process on libuv worker threads, with automatic fallback to the old paths for formats it can't decode (HEIC, camera RAW) or if the native module is missing.

Measured on a 24MP JPEG: ~139ms per 1920px preview with sharp vs ~570ms with ImageMagick; PowerShell on Windows typically costs 1–2s per file including spawn overhead. Expect grid thumbnails and loupe previews to land several times faster, with a more responsive UI during scans because decode work no longer blocks the main process.

Note: sharp does not auto-rotate here on purpose — the renderer sets `imageOrientation: 'none'` and applies EXIF rotation via CSS, so pixels must stay as stored.

**Action required on your machine: run `npm install` once** so npm fetches the Windows binaries for sharp (the sandbox installed Linux ones). If sharp ever fails to load in a packaged build, the app silently falls back to the previous behavior.

### 2. Wider thumbnail concurrency when sharp is active
`src/main/services/file-scanner.ts`

The "slow lane" (non-embedded-JPEG formats) was capped at 4 concurrent because each item spawned a PowerShell process. With sharp active it runs 10 wide.

### 3. Verified imports read the source once, not twice
`src/main/services/import-engine.ts`

With **Verify checksums** enabled, the engine copied the file, then re-read the entire source *and* destination to hash them. The copy is now streamed with the source SHA-256 computed inline, so the source — usually the slowest device in the chain, an SD card — is read exactly once. Roughly a third less I/O per verified import; on a 64GB card that's 64GB of reads avoided.

### 4. Contact sheet export parallelized
`src/main/ipc-handlers.ts`

Preview hydration for the 500-file contact sheet was strictly sequential; it now runs 6 wide.

### 5. Previews served over a custom protocol instead of base64 IPC
`src/main/main.ts`, `src/main/ipc-handlers.ts`, `src/main/services/exif-parser.ts`, `src/main/preload.ts`, `src/renderer/utils/previewCache.ts`, plus canvas consumers

Loupe/detail previews (300KB–2MB each, up to 500 held in the renderer) previously traveled as base64 data URIs: encoded on the main process (+33% size), structure-cloned across IPC, then retained as giant strings in renderer memory. Now a `keptra-preview://` protocol streams the cached JPEG straight from disk; the renderer holds only short URL strings and Chromium fetches, HTTP-caches, and decodes off-thread. Details:

- `generatePreview` was refactored around a Buffer-returning core (`generatePreviewPayload`); the data-URI wrapper remains for the contact sheet. Embedded RAW previews are now also persisted to the disk cache (previously re-extracted from the RAW on every request).
- `SCAN_PREVIEW` IPC returns `{ src }` — a protocol URL, or a data URI only when the user has disabled the RAW preview cache (transient mode, nothing on disk to serve).
- Cached previews are served without occupying a generation slot, so a queued RAW decode no longer delays re-display of an already-generated preview.
- Protocol responses carry `Access-Control-Allow-Origin` and canvas consumers (histogram, exposure clipping, face crops, sharpness/visual-hash analysis) mark protocol images `crossOrigin="anonymous"` via `applyCanvasSafeCrossOrigin`, so `getImageData`/`toBlob` don't hit tainted-canvas errors.
- URL carries `size-mtime-quality` version token for natural cache invalidation; scheme is allowed in the packaged CSP (`img-src`).

### 6. Editing/export pipeline moved to sharp
`src/main/services/import-engine.ts`, `src/main/services/sharp-loader.ts`

Converted imports (JPEG/TIFF output with exposure normalization, white balance, watermarks, auto-straighten) previously spawned a PowerShell + GDI+ script or ImageMagick per file at concurrency 2. `convertWithSharp` now does all of it in-process on libvips worker threads, and converted-import concurrency rises to 4 when sharp is active. Parity notes:

- Exposure + WB use per-channel `linear` multipliers — same encoded-domain math as the GDI+ ColorMatrix and ImageMagick `-evaluate Multiply` paths (verified pixel-exact on synthetic images).
- Image watermarks multiply the logo's own alpha by the configured opacity (GDI+ semantics); text watermarks render via SVG with a one-time font probe — if fontconfig can't find fonts, text marks fall back to the platform tools instead of silently rendering nothing.
- EXIF orientation is baked on Windows (GDI+ parity) or when auto-straighten is on (ImageMagick parity); EXIF/ICC metadata is preserved in output.
- HEIC output and RAW input still fall back to sips/PowerShell/ImageMagick automatically. ImageMagick is no longer required on Linux for the common cases.

The sharp loader moved to `sharp-loader.ts` (electron-free) so both pipelines share one instance and services stay unit-testable.

### 7. Detail preview concurrency raised when sharp is active
`src/main/ipc-handlers.ts`

Detail (3840px) previews were limited to one at a time to avoid starving UI IPC while a process-spawn resize ran. With sharp doing the work off-thread, two can safely run in flight.

Also evaluated and rejected: stream-hashing backup mirror copies. The current read-back of the backup file is what catches backup-media write corruption; inline hashing would save I/O by weakening that guarantee.

### 8. Grid thumbnails served over the preview protocol
`src/main/services/exif-parser.ts`, `src/main/services/file-scanner.ts`, `src/main/ipc-handlers.ts`

Scan-time thumbnails were the last base64 payloads (~30–80KB each, thousands held in React state on big scans). The scanner now only *ensures* thumbnail bytes exist (in-memory Buffer cache or disk cache) and the renderer receives a `keptra-preview://…variant=thumb` URL. The protocol serves from the memory/disk cache with a dedicated bounded lane (6-wide) plus inflight dedupe so grid `<img>` bursts can't stampede RAW byte-scans. The face-analysis engine already decodes from file paths in the main process, so the AI review loop is unaffected; renderer canvas consumers were already `crossOrigin`-safe from change 5.

### 9. Video grid thumbnails via system ffmpeg
`src/main/services/exif-parser.ts`, `src/main/services/file-scanner.ts`

Keptra ships no ffmpeg, but if one is on PATH (probed once), videos get a real grid frame (t=1s, retrying t=0 for sub-second clips, scaled to thumbnail width, cached on disk). Without ffmpeg, behavior is unchanged — placeholders.

### 10. Parallel stat during the directory walk
`src/main/services/file-scanner.ts`

The scan walk stat'ed files one at a time; it now batches 16-wide per directory, keeping pause/cancel semantics.

## Recommended next

### A. HEIC on Windows
Prebuilt sharp lacks HEIF decode (patent licensing), and GDI+ has no codec by default either, so HEIC previews on Windows depend on the embedded EXIF thumbnail. If HEIC users matter, evaluate a libheif-enabled sharp build.

### B. XMP sidecars at source
Consider an option to write XMP sidecars next to *source* files during culling (before import) for Lightroom/Bridge interop mid-shoot.

## Verification

- `npx tsc --noEmit` — clean
- `npx vitest run` — 36 files, 510 passed / 11 skipped (includes one test-mock update for the new `isSharpAvailable` export)
- Renderer orientation handling confirmed unaffected (previews stay un-rotated; CSS applies EXIF rotation)
- sharp resize output benchmarked against ImageMagick on a synthetic 24MP JPEG
