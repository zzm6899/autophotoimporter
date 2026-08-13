# Third-party model notices

Keptra includes third-party machine-learning model files. Those files remain
subject to their own license terms; Keptra's application license does not
replace those terms.

## UltraFace RFB 640

- File: `version-RFB-640.onnx`
- Purpose: local face detection
- Upstream model: ONNX Model Zoo `version-RFB-640`
- Pinned model revision: `c39647011b1d0eb48037ce3051438e51b19e2b11`
- Original model-file revision: `cc497be475371d891d5795e46fc80ebaddf683c5`
- SHA-256: `8f4c659275977e7a3bfbfa339a9c769ad793df50f9c0baa8c14b11baa1646430`
- License: MIT; see `UltraFace-MIT.txt`. The Hugging Face front matter says Apache-2.0, while its card body and the original ONNX/project license identify MIT; Keptra conservatively includes and attributes the original MIT terms.
- Model: https://huggingface.co/onnxmodelzoo/version-RFB-640/tree/c39647011b1d0eb48037ce3051438e51b19e2b11
- Exact original model file: https://github.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB/blob/cc497be475371d891d5795e46fc80ebaddf683c5/models/onnx/version-RFB-640.onnx

The model card identifies WIDER FACE-derived training data. Dataset terms are
separate from the software/model notice and should be reviewed when changing or
retraining this detector.

## SSD MobileNet V1

- File: `ssd_mobilenet_v1_12.onnx`
- Purpose: local person/body detection
- Upstream: ONNX Model Zoo, `ssd_mobilenet_v1_12`
- Pinned revision: `019281f3fcb151a90e491f3b2f0273f9f31bd6be`
- SHA-256: `b8fba5e404077d4048d27fcd1667e85e27e192eb9bf51e696c46a3acd7d21058`
- Model Zoo license/SPDX: MIT; see `ONNX-Model-Zoo-MIT.txt`
- TensorFlow source/tooling lineage: Apache License 2.0; full text in `SFace-Apache-2.0.txt`
- Model: https://huggingface.co/onnxmodelzoo/ssd_mobilenet_v1_12/tree/019281f3fcb151a90e491f3b2f0273f9f31bd6be
- Original ONNX model introduction: https://github.com/onnx/models/tree/91849267da7c576503f0f87a941b3139b64b7781/vision/object_detection_segmentation/ssd-mobilenetv1

The upstream model card documents TensorFlow SSD MobileNet conversion and COCO
evaluation/training lineage. Keptra redistributes the pinned ONNX bytes
unchanged.

## MoveNet SinglePose Thunder

- File: `movenet_thunder.onnx`
- Purpose: optional local pose estimation for shortlisted sports photographs
- Upstream conversion: Xenova MoveNet SinglePose Thunder ONNX
- Pinned revision: `38296077a99667cdad67af5096ce7eeb9b327453`
- SHA-256: `3dca9f6e5f8a64dc9935a5be06fd8bf81bf01e696c9c05c6f2a650e0a401b763`
- License metadata: Apache License 2.0; full text in `SFace-Apache-2.0.txt`
- Model: https://huggingface.co/Xenova/movenet-singlepose-thunder/tree/38296077a99667cdad67af5096ce7eeb9b327453
- Official Google model card: https://github.com/tensorflow/tfhub.dev/blob/3364a833d9b3b5ff16af08beb04b1832cb012033/assets/docs/google/models/movenet/singlepose/thunder/4.md

The conversion repository declares Apache-2.0 metadata. The packaged
`onnx/model.onnx` is renamed byte-for-byte to `movenet_thunder.onnx`; graph
metadata names `tf2onnx 1.16.1` and `movenet_singlepose_thunder_4`, supporting
the v4 lineage. Its short model card still does not provide a reproducible
conversion recipe; retain this pinned identity and provenance caveat until a
first-party, reproducibly converted model replaces it. Keptra verifies this
exact digest before loading and during package smoke.

## OpenCV SFace

- File: `face_recognition_sface_2021dec.onnx`
- Purpose: local face-embedding inference for similar-face grouping
- Upstream: OpenCV Zoo, `models/face_recognition_sface`
- Pinned revision: `ba91a3b91d00d76e86540d4013f944bd6b514e39`
- SHA-256: `0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79`
- License: Apache License 2.0; see `SFace-Apache-2.0.txt`
- Project: https://github.com/opencv/opencv_zoo/tree/ba91a3b91d00d76e86540d4013f944bd6b514e39/models/face_recognition_sface

The OpenCV Zoo documentation credits Yaoyao Zhong for SFace and Chengrui Wang
for the ONNX conversion. Keptra redistributes the upstream ONNX file unchanged.
The exact training dataset for this pinned `2021dec` weight is not stated in
the model directory. Similar-face matching is therefore local-only, explicitly
opt-in, produces no names or identity claims, and is never negative evidence
for an automatic rejection. The SFace paper discusses CASIA-WebFace,
VGGFace2, and MS-Celeb-1M experiments; that paper-level lineage does not prove
which dataset produced this exact weight.

## Production fast detector cascade

The following digest-pinned detectors are bundled as Keptra's fast first pass.
UltraFace and SSD MobileNet remain selective fallbacks for weak, empty, edge,
or disagreement cases. Automatic bulk decisions continue to require completed
subject-safety evidence and are previewed before application.

### OpenCV YuNet

- File: `face_detection_yunet_2023mar.onnx`
- Purpose: fast face boxes and five facial landmarks
- Pinned revision: `f12e12798e8314f7c074a6656816c048dcc95b7a`
- SHA-256: `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4`
- License: MIT; see `YuNet-MIT.txt`
- Project: https://github.com/opencv/opencv_zoo/tree/f12e12798e8314f7c074a6656816c048dcc95b7a/models/face_detection_yunet

The upstream model card states that YuNet was trained on WIDER FACE. WIDER FACE
dataset terms remain separate from the MIT model-directory license. Keptra uses
the landmarks to improve eye crops and SFace alignment, not to infer a person's
name or sensitive traits.

### OpenCV NanoDet Plus

- File: `object_detection_nanodet_2022nov.onnx`
- Purpose: fast COCO person/body detection
- Pinned revision: `510899a2a0adb8c25957915fd030d66dbd553919`
- SHA-256: `4b82da9944b88577175ee23a459dce2e26e6e4be573def65b1055dc2d9720186`
- License: Apache License 2.0; the full Apache text is included in `SFace-Apache-2.0.txt`
- Project: https://github.com/opencv/opencv_zoo/tree/510899a2a0adb8c25957915fd030d66dbd553919/models/object_detection_nanodet

The upstream NanoDet model is trained/evaluated on COCO. COCO image and dataset
terms remain separate from the Apache-2.0 model-directory license. Keptra uses
only the person class in the production culling cascade.

## Evaluation-only detector candidate

YOLOX-S remains unbundled and cannot enter the production detector cascade. It
may be downloaded only by the explicit experimental evaluation command.

### OpenCV YOLOX-S

- File: `experimental/object_detection_yolox_2022nov.onnx`
- Purpose: higher-accuracy candidate COCO/person object detection
- Pinned revision: `0b263e423d012606b83d1f81238d11c177da2b9c`
- SHA-256: `c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063`
- License: Apache License 2.0; the full Apache text is included in `SFace-Apache-2.0.txt`
- Copyright notice from the model directory: Copyright (c) 2021-2022 Megvii Inc. All rights reserved.
- Project: https://github.com/opencv/opencv_zoo/tree/0b263e423d012606b83d1f81238d11c177da2b9c/models/object_detection_yolox
