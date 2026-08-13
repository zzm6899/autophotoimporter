# Performance and AI Review

## GPU Diagnosis

Open Settings -> Workflow -> Performance and use **Diagnose GPU** to check which face-analysis provider is active.

- `detector:dml` means DirectML is being used for face detection.
- `embedder:dml` means DirectML is being used for similar-face grouping.
- `person:cpu` is expected. Person detection stays on CPU because local testing showed DirectML was slower for that model.
- A fallback reason means the app tried GPU for that model, but CPU was safer or faster.
- GPU selection is intentionally **Auto**. Windows display-adapter numbers are
  not DirectML device IDs; forwarding them previously allowed a UI-labelled RTX
  adapter to select a much slower execution path.

## Super Speed review

Super Speed is the default high-throughput route. It preserves the same
preview-before-apply rule while avoiding full person, pose, eye-detail, and
identity work on every frame:

1. Compute focus, scene, exposure, and visual hashes for every frame.
2. Reuse the scanner's bounded thumbnail for face screening on burst members,
   visual repeats, people-heavy
   genres, protected/selected photos, and other comparison candidates.
3. Run embeddings and pose only for faces or comparisons that need them.
4. Keep comparisons with incomplete evidence unanalysed/uncertain. They cannot
   become silent automatic rejects.

Landscape, architecture, and interior profiles use focus coverage, corner and
edge detail, clipping, tonal range, horizons, verticals, and composition first.
Unrelated standalone scenes skip people models. Repeated/comparison scenes run
one body pass because a face-only screen cannot rule out a turned-away person;
detected subjects also receive the subject-focus pass.

Short, profile-matched IPC batches reduce renderer/main-process overhead. The
CPU person session is independently serialized because one ONNX invocation
already uses several CPU threads; multiplying it by every photo worker reduced
throughput through oversubscription.

Native analysis is stored in a SQLite WAL cache with monotonic analysis depth:
a detector-only result can never satisfy a subject/full request, and a shallow
result cannot overwrite richer evidence. The default budget retains 1.25
million entries (up to 16 GiB) and prunes toward 1.15 million/14 GiB.

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
- RTX/DirectML desktop: 8-12 whole-photo jobs when detector/embedder timings are under 8ms.
- The normal-review hard limit is 16. Higher counts oversubscribe decode and
  CPU person work even when the face kernel itself is fast.

If the app feels laggy while reviewing, lower simultaneous face scans first. If thumbnails arrive slowly but review stays smooth, raise preview workers. Higher face scan counts also raise the per-image face embedding cap, so crowd/group photos can get more similar-face embeddings on fast GPUs.

## Million-photo performance target

The engineering target is **4-8 hours per million photos** (35-70 photos/s) on
the RTX 4070 / Ryzen 7 7800X3D reference workstation. This is a benchmark gate,
not a current product claim. A representative cold-cache corpus is still
required before publishing an end-to-end number.

Measured reference components on that workstation:

| Component | Result |
| --- | ---: |
| UltraFace detector, DirectML | 1.16 ms p50 |
| SFace embedding, DirectML | 0.79 ms p50 |
| Existing SSD person model, CPU | 13.28 ms p50 |
| New SQLite cache, 100k layout | 5,615 writes/s; 11,282 reads/s |
| Projected cache space, 1m entries with one embedding | 4.41 GiB |
| Detector preprocessing, cached scanner thumbs | 150.93 -> 237.51 photos/s (+57.4%) |
| Detector-only generated 12MP smoke, concurrency 8 | 259.34 photos/s (1.07 h/million) |
| Direct-source fallback, generated 8.7 MiB JPEGs | 45.41 photos/s (6.12 h/million) |

Kernel timings are lower bounds. Storage reads, JPEG/RAW decode, colour and
orientation transforms, scene pixels, cache work, and UI commits all count.
Reading 4 TB alone takes about 2.2 hours at 500 MB/s and 11.1 hours at 100 MB/s.
Embedded RAW previews and one shared decode are therefore requirements.

The acceptance benchmark must use at least 10,000 unique JPEG/RAW photos larger
than RAM, stratified by camera, resolution, orientation, portraits, crowds,
sports, low light, architecture, and no-subject scenes. Report cold and warm
cache photos/s, p50/p95/p99 stage time, bytes read, CPU/GPU/disk utilization,
memory, failures, cache hit rate, and accuracy/keeper changes. Repeating one file
is only a smoke test because OS caching makes its extrapolation misleading.

The generated-corpus rows above are controlled engineering smokes, not a
full-app SLA: they exclude a real RAW/JPEG camera mix, renderer scene scoring,
grouping, user interaction, and the deeper fraction selected by the cascade.

## Fast detector cascade

YuNet and NanoDet are digest-verified production fast passes; UltraFace and SSD
MobileNet remain selective safety fallbacks. On the RTX 4070, YuNet measured
1.12 ms and NanoDet 1.55 ms p50 at the model kernel. YOLOX-S (4.40 ms) remains
evaluation-only. Similar-face grouping uses opt-in local SFace embeddings only
as positive keeper evidence inside real burst/visual groups; it never names a
person or independently rejects a photo. See
[`detector-candidates.md`](detector-candidates.md) for hashes, licenses, HYROX
evidence, safety gates, and benchmark limitations.

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
