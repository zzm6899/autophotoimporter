# Detector candidate evaluation

Keptra's current UltraFace, SFace, and SSD MobileNet pipeline remains the
production default. YuNet, NanoDet, and YOLOX-S are pinned as evaluation-only
candidates: startup does not download them, packaging rejects them unless an
explicit experimental build flag is present, and the face engine never selects
them automatically.

## RTX 4070 measurements

Measured on the local RTX 4070 with ONNX Runtime Node 1.21.0 and the DirectML
execution provider, using 100 warmed inferences per model:

| Model | Role | FP32 DirectML p50 | p95 | Published accuracy |
| --- | --- | ---: | ---: | --- |
| UltraFace RFB 640 (current) | face | 1.20 ms | 2.66 ms | WIDER easy/medium/hard: .855/.822/.579 |
| YuNet 2023mar | face + 5 landmarks | 1.12 ms | 2.36 ms | WIDER easy/medium/hard: .884/.866/.750 |
| SSD MobileNet V1 (current) | objects/person | 40.62 ms on DML; 15.71 ms CPU | 46.99 ms DML | legacy baseline |
| NanoDet Plus 416 | objects/person | 1.55 ms | 3.07 ms | COCO AP .304; person AP .418, AP50 .675 |
| YOLOX-S 640 | objects/person | 4.40 ms | 6.71 ms | COCO AP .405; person AP .541 |

These are model-kernel measurements, not full-photo latency. Decode, colour
conversion, letterboxing, post-processing, storage, and renderer work must be
included before making a throughput claim. The aggregate local reports are
`artifacts/benchmarks/detector-candidates-dml.json` and
`artifacts/benchmarks/detector-candidates-cpu.json`.

The executable evaluator now measures the complete candidate path with real
pixels: EXIF auto-orientation, centre letterboxing, channel conversion,
normalisation, ONNX inference, output validation, decoding, NMS, and mapping
back to the source image. It deliberately uses a preprocessed real image for
the model-ceiling loop instead of an all-zero tensor.

```text
npm run models -- --experimental-detectors
npm run bench:detectors -- --images C:\labelled-corpus --provider dml \
  --labels C:\labelled-corpus\labels.json --iterations 1000 \
  --output artifacts\benchmarks\detector-candidates-e2e.json
```

On the local RTX 4070, a 100-image warm-cache smoke run cycling three real
OpenCV sample images measured:

| Candidate | Model + decoder | Full decode-to-box rate | Million-photo projection |
| --- | ---: | ---: | ---: |
| YuNet 640 | 634.65 photos/s | 54.01 photos/s | 5.14 hours |
| NanoDet 416 | 298.16 photos/s | 54.00 photos/s | 5.14 hours |

This confirms that each candidate can meet the 35 photos/s lower bound in
isolation on preview-sized inputs. It does **not** prove that running both on
every image, processing full-resolution originals, cold-reading storage, or
updating the UI will meet that rate. The production cascade should share the
decoded preview, run YuNet for comparison/subject frames, and add person
detection only where body evidence is needed. Unrelated standalone frames stay
manual and need only the cheap scene/hash/focus pass because they cannot replace
another image.

The FP32 graphs are the viable DirectML candidates. The tested INT8 NanoDet
graph was more than ten times slower than FP32 on DirectML, and block-quantized
variants either failed ONNX Runtime 1.21 CPU execution or model shape
validation. Do not select a quantized graph solely because its file is smaller.

## Recommended cascade

1. Run YuNet on comparison/subject frames, then NanoDet where body evidence is
   needed. YuNet's eye landmarks should replace estimated eye positions for
   crops and SFace alignment.
2. Run YOLOX-S only for uncertainty: crowded frames, face/person count
   disagreement, low NanoDet confidence, tiny subjects, or final burst
   candidates.
3. Run face embeddings and pose only for shortlisted faces/people, not every
   detected region in every frame.
4. Preserve every proposed bulk decision in the review preview; low-confidence
   results must be marked for review rather than rejected automatically.

At the measured kernel rates, the fast face/person pass consumes well under one
hour per million photos. A 4–8 hour target therefore depends primarily on a
single shared decode, embedded RAW previews, stage-specific queues, batched
cache writes, and database-paged UI—not on a larger YOLO model.

## Evaluation workflow

Download the pinned candidates only when preparing a labelled evaluation:

```text
npm run models -- --experimental-detectors
```

Weights are isolated under `models/experimental/`, ignored by git, and checked
against exact byte sizes and SHA-256 digests. A packaged build containing them
requires `KEPTRA_PACKAGE_EXPERIMENTAL_DETECTORS=1`; otherwise package smoke
fails. Runtime code may explicitly request one candidate through
`ensureExperimentalDetectorDownloaded`, but no production path calls it.

## Promotion gate

Do not add a user-visible model selector or replace the current detector until
the candidate decoders pass a labelled, versioned corpus containing at least:

- portraits, weddings, crowded groups, sports, children, occlusion, side
  profiles, masks, glasses, dark skin and varied lighting;
- small/distant people and faces, partial bodies, motion blur and high ISO;
- landscape, architecture and interiors with no people to measure false
  positives;
- JPEG plus embedded previews from every supported RAW family.

Record face/person recall, precision, false positives per image, small-subject
recall, box IoU, landmark error, burst-winner changes, end-to-end photos/second,
peak memory, and provider fallback rate. Promotion requires non-inferior recall
and false-positive rates in every safety-critical segment, deterministic output
decoding, graceful fallback to the existing models, and an updated pipeline
fingerprint so cached analyses cannot cross model versions.

The evaluator accepts an optional schema-versioned label file and reports
confidence-ordered IoU 0.5 precision, recall, and F1. Until that report exists
for the full segmented corpus, both candidates remain blocked from production
promotion even though the throughput smoke target passes.

## Decoder verification

`detector-candidate-runtime.ts` ports the pinned upstream output contracts:

- YuNet combines clamped class/object scores, decodes the 8/16/32 stride heads,
  returns five facial landmarks, and applies 0.3-IoU NMS.
- NanoDet applies the published RGB mean/std transform, decodes its
  distribution-focal-loss bins, keeps the strongest 1,000 anchors per feature
  level, applies upstream-compatible class-agnostic NMS, then selects COCO
  class 0 (person).
- Every output head and tensor length is validated. Unexpected shapes fail the
  candidate run instead of silently emitting plausible-looking boxes.

Non-zero correctness fixtures cover colour planes, normalisation, letterbox
mapping, landmarks, GFL distributions, NMS, output-shape failures, and IoU
metrics. A manual real-image cross-check against OpenCV 4.11 produced the same
single Lena face and closely matching box/landmark coordinates; minor score and
edge differences are expected from Sharp Lanczos versus OpenCV resize kernels.

## Provenance

- [OpenCV YuNet](https://github.com/opencv/opencv_zoo/tree/f12e12798e8314f7c074a6656816c048dcc95b7a/models/face_detection_yunet) — MIT.
- [OpenCV NanoDet](https://github.com/opencv/opencv_zoo/tree/510899a2a0adb8c25957915fd030d66dbd553919/models/object_detection_nanodet) — Apache-2.0.
- [OpenCV YOLOX-S](https://github.com/opencv/opencv_zoo/tree/0b263e423d012606b83d1f81238d11c177da2b9c/models/object_detection_yolox) — Apache-2.0.

The manifest pins immutable upstream revisions, weight hashes, input contracts,
decoder identifiers, licenses, and redistribution policy. Provenance permits
evaluation and potential redistribution; it does not substitute for an accuracy
or product-safety review.
