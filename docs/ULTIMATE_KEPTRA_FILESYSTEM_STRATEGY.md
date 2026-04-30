# Ultimate Keptra: File-System Optimization Strategy

This document proposes a practical plan to make Keptra feel "instant" on very large shoots (5k-100k photos), with emphasis on disk I/O, metadata pipelines, and cache architecture.

## 1) Core Performance Goals

- Keep the review UI responsive even while background analysis is running.
- Eliminate repeated RAW reads wherever possible.
- Make imports resumable and deterministic.
- Scale from laptop SSDs to NAS/USB workflows.

## 2) High-Impact File-System Ideas

## A. Content-Addressed Preview Cache (v2)

Current cache keys include path + mtime + size. Add a second-layer content key:

- **Primary key**: fast identity (`path + mtime + size`) for quick hit.
- **Secondary key**: content hash (xxHash/BLAKE3 sampled or full) to dedupe duplicates moved across folders/cards.

Benefits:
- Reusing thumbnails/previews across renamed folders and backup volumes.
- Lower disk usage for duplicate card copies.

## B. SQLite Index for Cache and Import State

Add a small local SQLite catalog:

Tables to track:
- file identity (path, inode/file-id where available, size, mtime)
- preview/thumbnail blobs or pointers
- face analysis status/version
- cull decisions and confidence snapshots
- export status and retry queue

Benefits:
- Fast startup and incremental re-import.
- Crash-safe resume for long sessions.
- Query-driven virtual folders (e.g., "unreviewed", "likely keepers", "blurry risks").

## C. Multi-Tier Cache Policy

Introduce cache tiers:

- **Tier 0 (memory)**: hot thumbnails currently visible + near-future prefetch window.
- **Tier 1 (local NVMe/SSD)**: JPEG previews, normalized metadata, embedding vectors.
- **Tier 2 (optional slower disk/NAS)**: archived previews and old project indexes.

Use weighted LRU + project pinning:
- Never evict active project assets first.
- Evict stale projects by recency and size pressure.

## D. Async Sequential Reader + Bounded Random Reads

For RAW/media ingestion:

- Read directory entries in batches.
- Use sequential reads for preview extraction whenever possible.
- Bound concurrent random reads (especially on HDD/network shares).
- Dynamically tune concurrency from observed latency (not static worker count only).

## E. Sidecar-Aware Metadata Pipeline

Treat sidecars (`.xmp`) and media atomically:

- Build a merge stage where RAW/JPEG + sidecar are indexed together.
- Use change journals to re-read only touched files.
- Persist "metadata fingerprint" to skip unnecessary parse work.

## F. NAS / External Drive Modes

Add a user-selectable source profile:

- **Local SSD mode**: high concurrency, aggressive prefetch.
- **External USB mode**: conservative random reads.
- **NAS mode**: larger read buffers, reduced seek churn, stronger local cache bias.

## G. Write-Ahead Export Queue

For output/import destination writes:

- Append export tasks to durable queue first.
- Worker pool executes copies/conversions with checksum verification.
- On crash/restart, resume exactly-once semantics for completed outputs.

## 3) "Ultimate Keptra" Feature Ideas (Built on FS Work)

- **Instant reopen**: restore prior project in seconds with preserved stacks, picks, filters.
- **Smart prefetch by user behavior**: pre-decode likely next images based on navigation rhythm.
- **Burst-locality scheduling**: process adjacent burst frames together to maximize cache locality.
- **Quality-first progressive loading**: tiny preview -> embedded jpeg -> full decode only on demand.
- **Cross-session duplicate memory**: if a near-duplicate was rejected last time, lower its review priority.

## 4) Suggested Implementation Phases

### Phase 1 (quick wins)

1. Add structured perf telemetry (read latency, cache hit rate, decode time, queue depth).
2. Add source profiles (SSD/USB/NAS) and dynamic I/O concurrency caps.
3. Add durable export queue with resume.

### Phase 2 (major UX gains)

1. Introduce SQLite index for import + analysis states.
2. Implement multi-tier cache policy with project pinning.
3. Add progressive loading pipeline and navigation-based prefetch.

### Phase 3 (ultimate scale)

1. Add content-addressed dedupe cache layer.
2. Add cross-session duplicate memory and ranking.
3. Add optional remote cache mirror for studio/NAS teams.

## 5) Metrics to Track

Track these per import/session:

- Time to first thumbnail
- Time to first cullable preview
- Mean/95p thumbnail latency while scrolling
- Cache hit rates by tier
- RAW bytes read per accepted keeper
- Resume success rate after forced restart

## 6) Practical Defaults

- Default to safe concurrency with auto-ramp after first 500 files.
- Keep face/AI pipelines separate from UI critical I/O queues.
- Prefer making "fast enough always" over peak benchmark speed.

---

If implemented in this order, Keptra can become a genuinely instant-feeling photo culling workflow even on huge weddings/events, while still remaining stable on lower-end systems.
