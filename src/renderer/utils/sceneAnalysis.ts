import type { SceneAnalysis, SceneAnalysisKind } from '../../shared/types';

export type { SceneAnalysisKind } from '../../shared/types';

export interface SceneAnalysisMetrics extends SceneAnalysis {
  /** Fraction of the frame's analysis tiles carrying useful edge detail (0..1). */
  focusCoverage: number;
  /** Ratio between weaker and stronger in-focus tiles (0..1). */
  focusUniformity: number;
  /** Raw Laplacian variance in the centre tiles. */
  centerSharpness: number;
  /** Raw Laplacian variance in the four corner tiles. */
  cornerSharpness: number;
  /** Raw 75th-percentile Laplacian variance across all tiles. */
  edgeSharpness: number;
  highlightClipping: number;
  shadowClipping: number;
  dynamicRange: number;
  compositionBalance: number;
  /** Weighted prevalence of near-horizontal and near-vertical edges (0..1). */
  lineStrength: number;
  horizonTiltDeg?: number;
  verticalTiltDeg?: number;
  /** Area-weighted Laplacian variance inside detected face/person regions. */
  subjectSharpnessScore?: number;
  /** Laplacian variance outside the detected subject footprint. */
  backgroundSharpnessScore?: number;
  /** Reliability of the subject-focus measurement (0..1). */
  subjectFocusConfidence?: number;
  /** Fraction of reliable subject regions carrying useful detail (0..1). */
  subjectFocusCoverage?: number;
  /** Approximate union of detected subject regions as a fraction of the frame. */
  subjectArea?: number;
  /** Number of usable face/person regions contributing to the focus result. */
  subjectCountAnalyzed?: number;
  /** Subject-specific explanations, also appended to `reasons` for old UIs. */
  subjectReasons?: string[];
  reasons: string[];
}

export interface SceneSubjectBox {
  /** Normalized horizontal origin in the box's declared coordinate space. */
  x: number;
  /** Normalized vertical origin in the box's declared coordinate space. */
  y: number;
  width: number;
  height: number;
  /** Detector confidence (0..1). Missing confidence is treated conservatively. */
  score?: number;
}

export interface SceneAnalysisOptions {
  hasPeople?: boolean;
  preferredKind?: SceneAnalysisKind;
  /** EXIF orientation describing how stored pixels should be displayed (1..8). */
  orientation?: number;
  /**
   * Coordinate space used by supplied boxes. Native detector results in Keptra
   * are mapped back to `stored`, which is therefore the safe default. Callers
   * using boxes from an upright/display-space detector must opt into `upright`.
   */
  boxCoordinateSpace?: 'stored' | 'upright';
  faceBoxes?: readonly SceneSubjectBox[];
  personBoxes?: readonly SceneSubjectBox[];
}

type SubjectKind = 'face' | 'person';

interface NormalizedSubjectBox extends SceneSubjectBox {
  kind: SubjectKind;
}

interface SubjectMeasurement extends NormalizedSubjectBox {
  area: number;
  reliability: number;
  sharpness: number;
}

interface SubjectAggregate {
  score: number;
  confidence: number;
  coverage: number;
  count: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * fraction)));
  return sorted[index];
}

function lumaAt(data: Uint8ClampedArray, width: number, x: number, y: number): number {
  const index = (y * width + x) * 4;
  return data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
}

function safeExifOrientation(value?: number): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 8
    ? value as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
    : 1;
}

function uprightPointToStored(
  x: number,
  y: number,
  orientationValue?: number,
): { x: number; y: number } {
  switch (safeExifOrientation(orientationValue)) {
    case 2: return { x: 1 - x, y };
    case 3: return { x: 1 - x, y: 1 - y };
    case 4: return { x, y: 1 - y };
    case 5: return { x: y, y: x };
    case 6: return { x: y, y: 1 - x };
    case 7: return { x: 1 - y, y: 1 - x };
    case 8: return { x: 1 - y, y: x };
    default: return { x, y };
  }
}

function normalizeSubjectBox(
  input: SceneSubjectBox,
  kind: SubjectKind,
  options: SceneAnalysisOptions,
): NormalizedSubjectBox | null {
  if (![input.x, input.y, input.width, input.height].every(Number.isFinite)) return null;
  if (input.width <= 0 || input.height <= 0) return null;

  let x1 = input.x;
  let y1 = input.y;
  let x2 = input.x + input.width;
  let y2 = input.y + input.height;
  if (options.boxCoordinateSpace === 'upright') {
    const corners = [
      uprightPointToStored(x1, y1, options.orientation),
      uprightPointToStored(x2, y1, options.orientation),
      uprightPointToStored(x1, y2, options.orientation),
      uprightPointToStored(x2, y2, options.orientation),
    ];
    x1 = Math.min(...corners.map((point) => point.x));
    y1 = Math.min(...corners.map((point) => point.y));
    x2 = Math.max(...corners.map((point) => point.x));
    y2 = Math.max(...corners.map((point) => point.y));
  }

  x1 = clamp01(x1);
  y1 = clamp01(y1);
  x2 = clamp01(x2);
  y2 = clamp01(y2);
  if (x2 - x1 <= 0 || y2 - y1 <= 0) return null;
  return {
    x: x1,
    y: y1,
    width: x2 - x1,
    height: y2 - y1,
    score: input.score,
    kind,
  };
}

function subjectRoi(box: NormalizedSubjectBox): NormalizedSubjectBox {
  // Detector boxes often include a halo of background. A gentle inset keeps
  // the measurement on facial/body detail without making small boxes brittle.
  const insetX = box.width * (box.kind === 'face' ? 0.08 : 0.1);
  const insetY = box.height * (box.kind === 'face' ? 0.08 : 0.06);
  return {
    ...box,
    x: box.x + insetX,
    y: box.y + insetY,
    width: Math.max(0, box.width - insetX * 2),
    height: Math.max(0, box.height - insetY * 2),
  };
}

function measureSubjectBox(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  box: NormalizedSubjectBox,
): SubjectMeasurement {
  const roi = subjectRoi(box);
  const area = box.width * box.height;
  const shortSidePixels = Math.min(roi.width * width, roi.height * height);
  const targetArea = box.kind === 'face' ? 0.025 : 0.14;
  const areaReliability = clamp01(Math.sqrt(area / targetArea));
  // Below roughly 8 preview pixels the Laplacian is mostly resize artefact;
  // reach full sampling confidence at 28px on the shorter ROI side.
  const samplingReliability = clamp01((shortSidePixels - 6) / 22);
  const detectorReliability = typeof box.score === 'number' ? clamp01(box.score) : 0.78;
  return {
    ...box,
    area,
    reliability: areaReliability * samplingReliability * detectorReliability,
    sharpness: laplacianVariance(
      data,
      width,
      height,
      roi.x * width,
      roi.y * height,
      (roi.x + roi.width) * width,
      (roi.y + roi.height) * height,
    ),
  };
}

function weightedPercentile(
  values: Array<{ value: number; weight: number }>,
  fraction: number,
): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) return sorted[0].value;
  const target = total * fraction;
  let cumulative = 0;
  for (const item of sorted) {
    cumulative += item.weight;
    if (cumulative >= target) return item.value;
  }
  return sorted[sorted.length - 1].value;
}

function aggregateSubjectMeasurements(
  measurements: SubjectMeasurement[],
  frameReference: number,
): SubjectAggregate | undefined {
  if (measurements.length === 0) return undefined;
  const scored = measurements.map((measurement) => {
    // Pull small/low-confidence regions toward the frame reference. This is
    // the important guard against a tiny, high-frequency face dominating a
    // full-size subject whose focus can actually be judged.
    const scoringReliability = measurement.reliability * Math.sqrt(measurement.reliability);
    const conservativeSharpness =
      measurement.sharpness * scoringReliability +
      frameReference * (1 - scoringReliability);
    return {
      measurement,
      value: conservativeSharpness,
      weight: Math.max(0.0001, Math.sqrt(measurement.area) * measurement.reliability),
    };
  });
  const weightSum = scored.reduce((sum, item) => sum + item.weight, 0);
  const mean = weightSum > 0
    ? scored.reduce((sum, item) => sum + item.value * item.weight, 0) / weightSum
    : frameReference;
  // For groups, retain some lower-quartile influence so one crisp face cannot
  // hide several visibly softer people.
  const lowerQuartile = weightedPercentile(scored, 0.25);
  const score = scored.length > 1 ? mean * 0.74 + lowerQuartile * 0.26 : mean;
  const missProbability = measurements.reduce(
    (remaining, measurement) => remaining * (1 - measurement.reliability),
    1,
  );
  const maxReliability = Math.max(...measurements.map((measurement) => measurement.reliability));
  const confidence = clamp01(maxReliability * 0.72 + (1 - missProbability) * 0.28);
  const usefulThreshold = Math.max(12, frameReference * 0.72);
  const coverageWeight = scored.reduce((sum, item) => sum + item.weight, 0);
  const coverage = coverageWeight > 0
    ? scored.reduce(
      (sum, item) => sum + (item.value >= usefulThreshold ? item.weight : 0),
      0,
    ) / coverageWeight
    : 0;
  return { score, confidence, coverage: clamp01(coverage), count: measurements.length };
}

function backgroundSharpnessOutsideSubjects(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  boxes: NormalizedSubjectBox[],
): { sharpness?: number; subjectArea: number } {
  if (boxes.length === 0) return { subjectArea: 0 };
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  let subjectSamples = 0;
  let totalSamples = 0;
  for (let y = 1; y < height - 1; y += 2) {
    const normalizedY = (y + 0.5) / height;
    for (let x = 1; x < width - 1; x += 2) {
      const normalizedX = (x + 0.5) / width;
      totalSamples++;
      const inSubject = boxes.some((box) => (
        normalizedX >= box.x && normalizedX <= box.x + box.width &&
        normalizedY >= box.y && normalizedY <= box.y + box.height
      ));
      if (inSubject) {
        subjectSamples++;
        continue;
      }
      const centre = lumaAt(data, width, x, y);
      const lap = (
        lumaAt(data, width, x, y - 1) +
        lumaAt(data, width, x, y + 1) +
        lumaAt(data, width, x - 1, y) +
        lumaAt(data, width, x + 1, y) -
        4 * centre
      );
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }
  return {
    sharpness: count >= 16 ? Math.max(0, sumSq / count - (sum / count) ** 2) : undefined,
    subjectArea: clamp01(subjectSamples / Math.max(1, totalSamples)),
  };
}

function laplacianVariance(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): number {
  const x0 = Math.max(1, Math.floor(left));
  const y0 = Math.max(1, Math.floor(top));
  const x1 = Math.min(width - 1, Math.ceil(right));
  const y1 = Math.min(height - 1, Math.ceil(bottom));
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const centre = lumaAt(data, width, x, y);
      // Keep the Laplacian signed. Taking abs() before variance makes a crisp,
      // regular checker/grid look artificially flat because every edge can
      // have the same magnitude.
      const lap = (
        lumaAt(data, width, x, y - 1) +
        lumaAt(data, width, x, y + 1) +
        lumaAt(data, width, x - 1, y) +
        lumaAt(data, width, x + 1, y) -
        4 * centre
      );
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return Math.max(0, sumSq / count - mean * mean);
}

function signedLineDeviation(angleDeg: number, axisDeg: number): number {
  let difference = angleDeg - axisDeg;
  while (difference > 90) difference -= 180;
  while (difference < -90) difference += 180;
  return difference;
}

/**
 * Extract deterministic scene-quality evidence from an already decoded frame.
 * This is intentionally not a semantic replacement for a trained scene model:
 * it measures the properties that make landscape/interior/architecture selects
 * useful, and it exposes its confidence so the UI can keep uncertain batches in
 * manual review.
 */
export function analyzeScenePixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options: SceneAnalysisOptions = {},
): SceneAnalysisMetrics {
  if (width < 8 || height < 8 || data.length < width * height * 4) {
    return {
      kind: options.preferredKind ?? (options.hasPeople ? 'people' : 'general'),
      confidence: options.preferredKind || options.hasPeople ? 1 : 0,
      focusCoverage: 0,
      focusUniformity: 0,
      centerSharpness: 0,
      cornerSharpness: 0,
      edgeSharpness: 0,
      highlightClipping: 0,
      shadowClipping: 0,
      dynamicRange: 0,
      compositionBalance: 0,
      lineStrength: 0,
      reasons: ['scene analysis unavailable'],
    };
  }

  const gridX = 4;
  const gridY = 4;
  const tileSharpness: number[] = [];
  for (let tileY = 0; tileY < gridY; tileY++) {
    for (let tileX = 0; tileX < gridX; tileX++) {
      tileSharpness.push(laplacianVariance(
        data,
        width,
        height,
        tileX * width / gridX,
        tileY * height / gridY,
        (tileX + 1) * width / gridX,
        (tileY + 1) * height / gridY,
      ));
    }
  }
  const sortedSharpness = tileSharpness.slice().sort((a, b) => a - b);
  const sharpQ25 = percentile(sortedSharpness, 0.25);
  const sharpQ50 = percentile(sortedSharpness, 0.5);
  const sharpQ75 = percentile(sortedSharpness, 0.75);
  const sharpQ90 = percentile(sortedSharpness, 0.9);
  const usefulThreshold = Math.max(4, sharpQ75 * 0.24);
  const focusCoverage = clamp01(tileSharpness.filter((value) => value >= usefulThreshold).length / tileSharpness.length);
  const focusUniformity = sharpQ75 > 0 ? clamp01(sharpQ25 / sharpQ75) : 0;
  const centreIndices = [5, 6, 9, 10];
  const cornerIndices = [0, 3, 12, 15];
  const centreSharpness = centreIndices.reduce((sum, index) => sum + tileSharpness[index], 0) / centreIndices.length;
  const cornerSharpness = cornerIndices.reduce((sum, index) => sum + tileSharpness[index], 0) / cornerIndices.length;

  const normalizedFaceBoxes = (options.faceBoxes ?? [])
    .map((box) => normalizeSubjectBox(box, 'face', options))
    .filter((box): box is NormalizedSubjectBox => box !== null)
    .sort((a, b) => (b.score ?? 0.78) * b.width * b.height - (a.score ?? 0.78) * a.width * a.height)
    .slice(0, 64);
  const normalizedPersonBoxes = (options.personBoxes ?? [])
    .map((box) => normalizeSubjectBox(box, 'person', options))
    .filter((box): box is NormalizedSubjectBox => box !== null)
    .sort((a, b) => (b.score ?? 0.78) * b.width * b.height - (a.score ?? 0.78) * a.width * a.height)
    .slice(0, 64);
  const crediblePersonMasks = normalizedPersonBoxes.filter((box) => (box.score ?? 0.78) >= 0.2);
  const credibleFaceMasks = normalizedFaceBoxes.filter((box) => (box.score ?? 0.78) >= 0.2);
  const subjectMasks = crediblePersonMasks.length > 0 ? crediblePersonMasks : credibleFaceMasks;
  const backgroundMeasurement = backgroundSharpnessOutsideSubjects(data, width, height, subjectMasks);
  const frameSharpnessReference = backgroundMeasurement.sharpness ?? sharpQ75;
  const faceMeasurements = normalizedFaceBoxes
    .map((box) => measureSubjectBox(data, width, height, box))
    .filter((measurement) => measurement.reliability > 0);
  const personMeasurements = normalizedPersonBoxes
    .map((box) => measureSubjectBox(data, width, height, box))
    .filter((measurement) => measurement.reliability > 0);
  const faceAggregate = aggregateSubjectMeasurements(faceMeasurements, frameSharpnessReference);
  const personAggregate = aggregateSubjectMeasurements(personMeasurements, frameSharpnessReference);

  let subjectAggregate: SubjectAggregate | undefined;
  if (faceAggregate && personAggregate) {
    // A reliably sized face is the photographer's usual focus target. Body
    // detail remains a useful fallback for distant subjects and sports frames.
    const faceWeight = clamp01(0.25 + faceAggregate.confidence * 0.75);
    subjectAggregate = {
      score: faceAggregate.score * faceWeight + personAggregate.score * (1 - faceWeight),
      confidence: clamp01(1 - (1 - faceAggregate.confidence) * (1 - personAggregate.confidence * 0.55)),
      coverage: clamp01(faceAggregate.coverage * faceWeight + personAggregate.coverage * (1 - faceWeight)),
      count: faceAggregate.count + personAggregate.count,
    };
  } else {
    subjectAggregate = faceAggregate ?? personAggregate;
  }

  const suppliedSubjectCount = normalizedFaceBoxes.length + normalizedPersonBoxes.length;
  const subjectReasons: string[] = [];
  if (subjectAggregate) {
    if (faceAggregate && personAggregate && faceAggregate.confidence < 0.45) {
      subjectReasons.push('face and body focus combined');
    } else if (faceAggregate) {
      subjectReasons.push(faceAggregate.count === 1 ? 'face-area focus measured' : `${faceAggregate.count} face areas compared`);
    } else if (personAggregate) {
      subjectReasons.push(personAggregate.count === 1 ? 'subject-area focus measured' : `${personAggregate.count} subject areas compared`);
    }
    if (subjectAggregate.confidence < 0.35) subjectReasons.push('small subject area limits focus confidence');
    if (subjectAggregate.count > 1 && subjectAggregate.coverage < 0.65) subjectReasons.push('mixed focus across subjects');
    else if (subjectAggregate.count > 1 && subjectAggregate.coverage >= 0.95) subjectReasons.push('consistent focus across subjects');
    if (typeof backgroundMeasurement.sharpness === 'number') {
      const separation = (subjectAggregate.score - backgroundMeasurement.sharpness) /
        Math.max(1, subjectAggregate.score + backgroundMeasurement.sharpness);
      if (separation >= 0.18) subjectReasons.push('sharp subject against softer background');
      else if (separation <= -0.18) subjectReasons.push('subject softer than surrounding scene');
    }
  } else if (suppliedSubjectCount > 0) {
    subjectReasons.push('subject boxes too small for reliable focus');
  }

  const histogram = new Array<number>(256).fill(0);
  let highlights = 0;
  let shadows = 0;
  let pixels = 0;
  let leftEnergy = 0;
  let rightEnergy = 0;
  let topEnergy = 0;
  let bottomEnergy = 0;
  let totalEdgeEnergy = 0;
  let horizontalWeight = 0;
  let horizontalSigned = 0;
  let verticalWeight = 0;
  let verticalSigned = 0;
  let axisAlignedWeight = 0;

  // A 2px stride is enough for frame-level exposure and line evidence and
  // keeps this pass cheap when thousands of previews are analysed.
  for (let y = 1; y < height - 1; y += 2) {
    for (let x = 1; x < width - 1; x += 2) {
      const luma = lumaAt(data, width, x, y);
      const rounded = Math.max(0, Math.min(255, Math.round(luma)));
      histogram[rounded]++;
      if (rounded >= 250) highlights++;
      if (rounded <= 5) shadows++;
      pixels++;

      const gx =
        -lumaAt(data, width, x - 1, y - 1) + lumaAt(data, width, x + 1, y - 1) +
        -2 * lumaAt(data, width, x - 1, y) + 2 * lumaAt(data, width, x + 1, y) +
        -lumaAt(data, width, x - 1, y + 1) + lumaAt(data, width, x + 1, y + 1);
      const gy =
        -lumaAt(data, width, x - 1, y - 1) - 2 * lumaAt(data, width, x, y - 1) - lumaAt(data, width, x + 1, y - 1) +
        lumaAt(data, width, x - 1, y + 1) + 2 * lumaAt(data, width, x, y + 1) + lumaAt(data, width, x + 1, y + 1);
      const magnitude = Math.hypot(gx, gy);
      if (magnitude < 48) continue;
      totalEdgeEnergy += magnitude;
      if (x < width / 2) leftEnergy += magnitude;
      else rightEnergy += magnitude;
      if (y < height / 2) topEnergy += magnitude;
      else bottomEnergy += magnitude;

      // Gradient direction is perpendicular to the visible line direction.
      let lineAngle = Math.atan2(gy, gx) * 180 / Math.PI + 90;
      while (lineAngle >= 90) lineAngle -= 180;
      while (lineAngle < -90) lineAngle += 180;
      const horizontalDeviation = signedLineDeviation(lineAngle, 0);
      const verticalDeviation = signedLineDeviation(lineAngle, 90);
      if (Math.abs(horizontalDeviation) <= 14) {
        horizontalWeight += magnitude;
        horizontalSigned += horizontalDeviation * magnitude;
        axisAlignedWeight += magnitude;
      } else if (Math.abs(verticalDeviation) <= 14) {
        verticalWeight += magnitude;
        verticalSigned += verticalDeviation * magnitude;
        axisAlignedWeight += magnitude;
      }
    }
  }

  const cumulativeTarget = (fraction: number) => Math.max(1, pixels) * fraction;
  const histogramPercentile = (fraction: number): number => {
    let cumulative = 0;
    const target = cumulativeTarget(fraction);
    for (let value = 0; value < histogram.length; value++) {
      cumulative += histogram[value];
      if (cumulative >= target) return value;
    }
    return 255;
  };
  const p05 = histogramPercentile(0.05);
  const p95 = histogramPercentile(0.95);
  const highlightClipping = highlights / Math.max(1, pixels);
  const shadowClipping = shadows / Math.max(1, pixels);
  const dynamicRange = clamp01((p95 - p05) / 255);
  const horizontalBalance = 1 - Math.abs(leftEnergy - rightEnergy) / Math.max(1, leftEnergy + rightEnergy);
  const verticalBalance = 1 - Math.abs(topEnergy - bottomEnergy) / Math.max(1, topEnergy + bottomEnergy);
  const compositionBalance = clamp01(horizontalBalance * 0.62 + verticalBalance * 0.38);
  const lineStrength = clamp01(axisAlignedWeight / Math.max(1, totalEdgeEnergy));
  const horizonTiltDeg = horizontalWeight > 0 ? horizontalSigned / horizontalWeight : undefined;
  const verticalTiltDeg = verticalWeight > 0 ? verticalSigned / verticalWeight : undefined;

  const aspect = width / Math.max(1, height);
  let kind: SceneAnalysisKind = 'general';
  let confidence = 0.42;
  if (options.hasPeople) {
    kind = 'people';
    confidence = 1;
  } else if (options.preferredKind) {
    kind = options.preferredKind;
    confidence = 1;
  } else if (lineStrength >= 0.52 && verticalWeight > 0 && horizontalWeight > 0) {
    kind = 'architecture';
    confidence = clamp01(0.55 + (lineStrength - 0.52) * 1.5);
  } else if (aspect >= 1.28 && focusCoverage >= 0.56) {
    kind = 'landscape';
    confidence = clamp01(0.46 + (aspect - 1.28) * 0.22 + focusCoverage * 0.28);
  } else if (focusCoverage <= 0.38 && sharpQ90 >= Math.max(16, sharpQ50 * 2.5)) {
    kind = 'detail';
    confidence = clamp01(0.48 + (0.38 - focusCoverage));
  }

  const reasons: string[] = [];
  if (focusCoverage >= 0.7) reasons.push('broad frame focus');
  else if (focusCoverage <= 0.35) reasons.push('limited focus coverage');
  if (focusUniformity >= 0.6) reasons.push('even corner-to-centre detail');
  if (highlightClipping >= 0.025) reasons.push('clipped highlights');
  if (shadowClipping >= 0.04) reasons.push('blocked shadows');
  if (dynamicRange >= 0.62) reasons.push('strong tonal range');
  if (lineStrength >= 0.52) reasons.push('strong architectural lines');
  if (typeof horizonTiltDeg === 'number' && Math.abs(horizonTiltDeg) >= 1.5) reasons.push('horizon may need levelling');
  if (typeof verticalTiltDeg === 'number' && Math.abs(verticalTiltDeg) >= 2) reasons.push('verticals may need correction');
  if (compositionBalance >= 0.78) reasons.push('balanced edge distribution');
  reasons.push(...subjectReasons);
  if (reasons.length === 0) reasons.push('general scene quality');

  return {
    kind,
    confidence,
    focusCoverage,
    focusUniformity,
    centerSharpness: Math.round(centreSharpness),
    cornerSharpness: Math.round(cornerSharpness),
    edgeSharpness: Math.round(sharpQ75),
    highlightClipping,
    shadowClipping,
    dynamicRange,
    compositionBalance,
    lineStrength,
    horizonTiltDeg,
    verticalTiltDeg,
    subjectSharpnessScore: subjectAggregate ? Math.round(subjectAggregate.score) : undefined,
    backgroundSharpnessScore: typeof backgroundMeasurement.sharpness === 'number'
      ? Math.round(backgroundMeasurement.sharpness)
      : undefined,
    subjectFocusConfidence: subjectAggregate?.confidence ?? (suppliedSubjectCount > 0 ? 0 : undefined),
    subjectFocusCoverage: subjectAggregate?.coverage,
    subjectArea: suppliedSubjectCount > 0 ? backgroundMeasurement.subjectArea : undefined,
    subjectCountAnalyzed: subjectAggregate?.count ?? (suppliedSubjectCount > 0 ? 0 : undefined),
    subjectReasons: subjectReasons.length > 0 ? subjectReasons : undefined,
    reasons,
  };
}

export function analyzeSceneFromImage(
  image: HTMLImageElement,
  options: SceneAnalysisOptions = {},
): SceneAnalysisMetrics | undefined {
  if (!image.naturalWidth || !image.naturalHeight) return undefined;
  // Keep this bounded: scene analysis runs beside preview decoding and must not
  // make large shoots feel slower than the detector pass.
  const maxSide = 160;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(8, Math.round(image.naturalWidth * scale));
  const height = Math.max(8, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return undefined;
  context.drawImage(image, 0, 0, width, height);
  const data = context.getImageData(0, 0, width, height).data;
  return analyzeScenePixels(data, width, height, options);
}
