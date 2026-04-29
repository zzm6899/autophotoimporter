# Architecture & Engineering Status

Last updated: 2026-04-29

## Current architecture snapshot

- Desktop app: Electron + Vite + React renderer.
- Main process services: volume discovery, import engine, EXIF pipeline, FTP mirror source, duplicate detection, update checker, and license validation.
- AI stack: ONNX Runtime with runtime provider fallback (DirectML / CoreML / CUDA / CPU depending on host).
- Deployment: desktop installers plus optional self-hosted update/admin stack under `deploy/truenas/`.

## Delivery status

- ✅ Core import/review workflow: delivered.
- ✅ FTP source + staging mirror flow: delivered.
- ✅ Face analysis pipeline with GPU fallback behavior: delivered.
- ✅ Hosted update administration service + release publishing scripts: delivered.
- ✅ Offline signed license tooling (CLI + admin integration path): delivered.

## Canonical status policy

This file is the canonical engineering status document.

Deprecated summary files remain only as compatibility stubs and should not be used as source-of-truth:

- `STATUS_COMPLETE.md`
- `IMPLEMENTATION_COMPLETE.md`
- `GPU_COMPLETE.md`
- `RAW_CPU_COMPLETE.md`
- `GPU_CHANGES_SUMMARY.md`
