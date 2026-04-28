# Performance and AI Review

## GPU Diagnosis

Open Settings -> Workflow -> Performance and use **Diagnose GPU** to check which face-analysis provider is active.

- `detector:dml` means DirectML is being used for face detection.
- `embedder:dml` means DirectML is being used for similar-face grouping.
- `person:cpu` is expected. Person detection stays on CPU because local testing showed DirectML was slower for that model.
- A fallback reason means the app tried GPU for that model, but CPU was safer or faster.

## Optimize Settings

Use **Optimize settings** when setting up a new PC or GPU. It reads CPU threads, RAM, and the current face-engine benchmark, then asks before applying:

- Simultaneous face scans
- Preview workers
- RAW preview quality
- CPU optimization
- Fast Keeper Mode
- GPU face acceleration

Suggested starting points:

- Low-end laptop: 1-2 face scans, 1 preview worker, Fast Keeper Mode for large imports.
- Mid-range desktop: 2-6 face scans, 2-4 preview workers.
- RTX/DirectML desktop: 16-24 face scans when detector/embedder timings are under 8ms.
- Very fast GPUs: try 32 face scans only as a stress test if the UI remains smooth.

If the app feels laggy while reviewing, lower simultaneous face scans first. If thumbnails arrive slowly but review stays smooth, raise preview workers. Higher face scan counts also raise the per-image face embedding cap, so crowd/group photos can get more similar-face embeddings on fast GPUs.

On first launch and after each app update, Keptra shows a small **Check performance settings** prompt. Use **Open optimizer** to jump straight to Settings -> Workflow -> Performance. Dismissing the prompt hides it for the current app version, and it will appear again after the next update.

## AI Reasons

The AI reasons panel explains why a photo looks like a keeper or risk:

- Eyes/faces detected
- Blink or side-face risk
- Subject sharpness
- Burst or duplicate stack membership
- Blur risk
- Best-shot score

The reasons are local-only and are meant to guide review, not replace human judgement. For events, use Second Pass to inspect low-confidence keepers before import.

## Auto-Cull Confidence

- Conservative: only rejects obvious weaker frames.
- Balanced: default for most shoots.
- Aggressive: faster cleanup, but review the Second Pass lane before import.

For group photos, enable **Group photo: everyone good** so missing faces, weak eyes, and blink risk matter more.

## Exposure and White Balance

Converted outputs can preview and export Lightroom-style pixel edits:

- Bulk white balance in the Output panel previews on thumbnails, Compare, and Single view.
- Single view has per-photo Exposure, Temp, and Tint controls for one-off fixes.
- Per-photo white balance overrides the bulk setting for that image.
- Copy Edit / Paste carries manual EV, anchor-normalize state, and per-photo white balance.
- Sync in Single view applies the focused photo's edit recipe to selected photos, or to the same burst/scene when nothing is selected.

Original output remains byte-for-byte copy only. Exposure normalization and white balance are previewed/exported only when saving as JPEG, TIFF, or HEIC.
