# Third-party model notices

Keptra includes third-party machine-learning model files. Those files remain
subject to their own license terms; Keptra's application license does not
replace those terms.

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

## Evaluation-only detector candidates

The following models are pinned in Keptra's detector candidate manifest but are
not bundled or selected by default. They may be downloaded only through the
explicit experimental evaluation workflow. Promotion requires a labelled
golden-corpus accuracy review.

### OpenCV YuNet

- File: `experimental/face_detection_yunet_2023mar.onnx`
- Purpose: candidate face boxes and five facial landmarks
- Pinned revision: `f12e12798e8314f7c074a6656816c048dcc95b7a`
- SHA-256: `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4`
- License: MIT; see `YuNet-MIT.txt`
- Project: https://github.com/opencv/opencv_zoo/tree/f12e12798e8314f7c074a6656816c048dcc95b7a/models/face_detection_yunet

### OpenCV NanoDet Plus

- File: `experimental/object_detection_nanodet_2022nov.onnx`
- Purpose: candidate COCO/person object detection
- Pinned revision: `510899a2a0adb8c25957915fd030d66dbd553919`
- SHA-256: `4b82da9944b88577175ee23a459dce2e26e6e4be573def65b1055dc2d9720186`
- License: Apache License 2.0; the full Apache text is included in `SFace-Apache-2.0.txt`
- Project: https://github.com/opencv/opencv_zoo/tree/510899a2a0adb8c25957915fd030d66dbd553919/models/object_detection_nanodet

### OpenCV YOLOX-S

- File: `experimental/object_detection_yolox_2022nov.onnx`
- Purpose: higher-accuracy candidate COCO/person object detection
- Pinned revision: `0b263e423d012606b83d1f81238d11c177da2b9c`
- SHA-256: `c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063`
- License: Apache License 2.0; the full Apache text is included in `SFace-Apache-2.0.txt`
- Copyright notice from the model directory: Copyright (c) 2021-2022 Megvii Inc. All rights reserved.
- Project: https://github.com/opencv/opencv_zoo/tree/0b263e423d012606b83d1f81238d11c177da2b9c/models/object_detection_yolox
