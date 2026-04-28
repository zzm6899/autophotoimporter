import type { CullConfidence, EventMode, KeeperQuota, MediaFile } from './types';

export interface ReviewScoreInput {
  sharpnessScore?: number;
  subjectSharpnessScore?: number;
  faceCount?: number;
  faceBoxes?: MediaFile['faceBoxes'];
  faceDetection?: MediaFile['faceDetection'];
  personCount?: number;
  personBoxes?: MediaFile['personBoxes'];
  rating?: number;
  isProtected?: boolean;
  exposureValue?: number;
  visualGroupSize?: number;
}

export interface ReviewScore {
  score: number;
  blurRisk: 'low' | 'medium' | 'high';
  reasons: string[];
}

function clamp01(value: number | undefined, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function boxCenterScore(box: { x: number; y: number; width: number; height: number }): number {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dx = Math.abs(cx - 0.5);
  const dy = Math.abs(cy - 0.43);
  return clamp01(1 - (dx * 1.45 + dy * 1.05));
}

export function humanMomentQuality(
  file: Pick<MediaFile, 'faceCount' | 'faceBoxes' | 'personCount' | 'personBoxes' | 'subjectSharpnessScore'>,
): number {
  const faceBoxes = file.faceBoxes ?? [];
  const personBoxes = file.personBoxes ?? [];
  const faceCount = file.faceCount ?? faceBoxes.length;
  const personCount = file.personCount ?? personBoxes.length;
  const sharp = Math.min(24, (file.subjectSharpnessScore ?? 0) / 6);

  if (faceBoxes.length > 0) {
    const eyeScores = faceBoxes.map((box) => clamp01((box.eyeScore ?? 0) / 2));
    const smileScores = faceBoxes.map((box) => clamp01(box.smileScore ?? box.expressionScore, 0.5));
    const avgEye = eyeScores.reduce((sum, score) => sum + score, 0) / eyeScores.length;
    const minEye = Math.min(...eyeScores);
    const avgSmile = smileScores.reduce((sum, score) => sum + score, 0) / smileScores.length;
    const faceArea = faceBoxes.reduce((sum, box) => sum + box.width * box.height, 0);
    const centered = faceBoxes.reduce((best, box) => Math.max(best, boxCenterScore(box)), 0);
    const groupCoverage = faceCount >= 2 ? Math.min(18, faceCount * 4 + minEye * 14) : 0;

    return Math.round(
      avgEye * 34 +
      minEye * (faceCount >= 2 ? 28 : 14) +
      avgSmile * 12 +
      centered * 12 +
      Math.min(18, faceArea * 90) +
      groupCoverage +
      sharp,
    );
  }

  if (personBoxes.length > 0) {
    const personArea = personBoxes.reduce((sum, box) => sum + box.width * box.height, 0);
    const centered = personBoxes.reduce((best, box) => Math.max(best, boxCenterScore(box)), 0);
    return Math.round(
      Math.min(personCount, 4) * 8 +
      Math.min(24, personArea * 70) +
      centered * 14 +
      sharp,
    );
  }

  return Math.round(sharp);
}

export function faceQuality(file: Pick<MediaFile, 'faceCount' | 'faceBoxes' | 'faceDetection' | 'subjectSharpnessScore'>): number {
  const boxes = file.faceBoxes ?? [];
  const bestEye = boxes.reduce((best, box) => Math.max(best, box.eyeScore ?? 0), 0);
  const eyeSum = boxes.reduce((sum, box) => sum + (box.eyeScore ?? 0), 0);
  const expression = boxes.reduce((sum, box) => sum + clamp01(box.smileScore ?? box.expressionScore, 0.5), 0);
  const faceCount = file.faceCount ?? boxes.length;
  const faceArea = boxes.reduce((sum, box) => sum + box.width * box.height, 0);
  const largestFaceArea = boxes.reduce((best, box) => Math.max(best, box.width * box.height), 0);
  const sharp = Math.min(60, (file.subjectSharpnessScore ?? 0) / 3);
  const faceConfidence = file.faceDetection === 'estimated' ? 0.4 : 1;
  // ONNX detection confidence: average score across all face boxes (0..1).
  // Boosts photos where faces were detected with high certainty — helps
  // best-of-batch pick the shot where faces are clearest.
  const onnxConfidence = boxes.length > 0
    ? boxes.reduce((sum, box) => sum + (box.score ?? 0.85), 0) / boxes.length
    : 1;
  return Math.round(
    (Math.min(faceCount, 4) * 18 +
    bestEye * 18 +
    eyeSum * 7 +
    Math.min(14, expression * 5) +
    Math.min(20, largestFaceArea * 180) +
    Math.min(14, faceArea * 80)) * faceConfidence * Math.max(0.5, onnxConfidence) +
    sharp,
  );
}

export function subjectPresenceQuality(
  file: Pick<MediaFile, 'faceCount' | 'faceBoxes' | 'faceDetection' | 'personCount' | 'personBoxes' | 'subjectSharpnessScore'>,
): number {
  const face = faceQuality(file);
  const personBoxes = file.personBoxes ?? [];
  const personCount = file.personCount ?? personBoxes.length;
  const personArea = personBoxes.reduce((sum, box) => sum + box.width * box.height, 0);
  const personScore = Math.round(
    Math.min(personCount, 3) * 12 +
    Math.min(26, personArea * 90) +
    Math.min(20, (file.subjectSharpnessScore ?? 0) / 5),
  );
  return Math.max(face, personScore);
}

export function keeperScore(file: MediaFile): number {
  return (
    (file.isProtected ? 120 : 0) +
    (file.rating ?? 0) * 30 +
    subjectPresenceQuality(file) +
    Math.min(70, (file.subjectSharpnessScore ?? 0) / 2.4) +
    Math.min(45, (file.sharpnessScore ?? 0) / 6) +
    Math.min(55, file.reviewScore ?? 0) -
    (file.blurRisk === 'high' ? 90 : file.blurRisk === 'medium' ? 30 : 0)
  );
}

export function bestShotScore(file: MediaFile): number {
  const face = faceQuality(file);
  const subject = subjectPresenceQuality(file);
  const subjectSharp = file.subjectSharpnessScore ?? 0;
  const wholeSharp = file.sharpnessScore ?? 0;
  const review = file.reviewScore ?? 0;
  const hasFaces = (file.faceCount ?? file.faceBoxes?.length ?? 0) > 0;
  const humanMoment = humanMomentQuality(file);
  const faceReliability = file.faceDetection === 'estimated' ? 0.82 : 1;

  let score =
    (file.isProtected ? 220 : 0) +
    (file.rating ?? 0) * 55 +
    subject * 1.2 +
    face * (hasFaces ? 1.25 * faceReliability : 0.35) +
    humanMoment * 1.35 +
    Math.min(95, subjectSharp / 1.7) +
    Math.min(60, wholeSharp / 4.5) +
    Math.min(70, review * 1.05);

  if (file.pick === 'selected') score += 70;
  if (file.pick === 'rejected') score -= 140;
  if (typeof file.exposureValue === 'number') score += 8;
  if (file.blurRisk === 'high') score -= hasFaces ? 150 : 115;
  if (file.blurRisk === 'medium') score -= 44;
  if (hasFaces && subjectSharp > 0 && subjectSharp < 38) score -= 55;
  if (!hasFaces && subjectSharp > 0 && subjectSharp < 28) score -= 25;
  return Math.round(score);
}

export function isDetailStoryKeeper(file: MediaFile): boolean {
  const hasFaces = (file.faceCount ?? file.faceBoxes?.length ?? 0) > 0;
  const hasPeople = (file.personCount ?? file.personBoxes?.length ?? 0) > 0;
  const sharp = Math.max(file.sharpnessScore ?? 0, file.subjectSharpnessScore ?? 0);
  const review = file.reviewScore ?? 0;
  return !hasFaces && !hasPeople && file.type === 'photo' && file.blurRisk !== 'high' && (sharp >= 120 || review >= 68);
}

export function inferSceneBucket(file: MediaFile, eventMode: EventMode = 'general'): string {
  if (file.type === 'video') return 'Video';
  if ((file.faceCount ?? file.faceBoxes?.length ?? 0) >= 3 || (file.personCount ?? file.personBoxes?.length ?? 0) >= 3) {
    return 'Groups';
  }
  if ((file.faceCount ?? file.faceBoxes?.length ?? 0) > 0) {
    if (eventMode === 'stage') return 'Stage faces';
    if (eventMode === 'candids') return 'Candids';
    if (eventMode === 'cosplay') return 'Cosplay portraits';
    return 'People';
  }
  if ((file.personCount ?? file.personBoxes?.length ?? 0) > 0) {
    if (eventMode === 'cosplay') return 'Full costume';
    if (eventMode === 'stage') return 'Stage action';
    return 'People';
  }
  if (isDetailStoryKeeper(file)) {
    if (eventMode === 'cars-itasha') return 'Car details';
    if (eventMode === 'cosplay') return 'Costume details';
    return 'Details';
  }
  if (file.gps || file.locationName) return 'Location';
  return 'Scene';
}

export function assignSceneBuckets(files: MediaFile[], eventMode: EventMode = 'general'): MediaFile[] {
  const counts = new Map<string, number>();
  return files.map((file) => {
    const bucket = inferSceneBucket(file, eventMode);
    const nextCount = (counts.get(bucket) ?? 0) + 1;
    counts.set(bucket, nextCount);
    const sceneBucketId = `${bucket.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'scene'}-${nextCount}`;
    return { ...file, sceneBucket: bucket, sceneBucketId };
  });
}

export function rankBestShots(files: MediaFile[]): MediaFile[] {
  return files.slice().sort((a, b) =>
    Number(!!b.isProtected) - Number(!!a.isProtected) ||
    (b.rating ?? 0) - (a.rating ?? 0) ||
    bestShotScore(b) - bestShotScore(a) ||
    subjectPresenceQuality(b) - subjectPresenceQuality(a) ||
    faceQuality(b) - faceQuality(a) ||
    (b.subjectSharpnessScore ?? 0) - (a.subjectSharpnessScore ?? 0) ||
    Number(a.blurRisk === 'high') - Number(b.blurRisk === 'high') ||
    (b.sharpnessScore ?? 0) - (a.sharpnessScore ?? 0) ||
    (b.reviewScore ?? 0) - (a.reviewScore ?? 0) ||
    (a.burstIndex ?? 0) - (b.burstIndex ?? 0) ||
    a.name.localeCompare(b.name),
  );
}

export interface AutoCullDecision {
  best: MediaFile | null;
  keep: string[];
  reject: string[];
  confidence: 'low' | 'medium' | 'high';
  reasons: Record<string, string[]>;
}

export interface AutoCullOptions {
  confidence?: CullConfidence;
  groupPhotoEveryoneGood?: boolean;
  keeperQuota?: KeeperQuota;
}

function weakestFaceSignal(file: MediaFile): number {
  const boxes = file.faceBoxes ?? [];
  if (boxes.length === 0) return 1;
  return Math.min(...boxes.map((box) => {
    const eye = clamp01((box.eyeScore ?? 0) / 2);
    const detection = clamp01(box.score, 0.8);
    const expression = clamp01(box.smileScore ?? box.expressionScore, 0.5);
    return eye * 0.55 + detection * 0.3 + expression * 0.15;
  }));
}

function addQuotaKeepers(ranked: MediaFile[], keep: Set<string>, options: AutoCullOptions): void {
  const quota = options.keeperQuota ?? 'best-1';
  if (quota === 'top-2') {
    for (const file of ranked.slice(0, 2)) keep.add(file.path);
  } else if (quota === 'all-rated') {
    for (const file of ranked) {
      if (file.isProtected || (file.rating ?? 0) > 0 || file.pick === 'selected') keep.add(file.path);
    }
  } else if (quota === 'smile-and-sharp') {
    const expressionScore = (file: MediaFile) => {
      const boxes = file.faceBoxes ?? [];
      if (boxes.length === 0) return 0;
      return boxes.reduce((best, box) => Math.max(best, clamp01(box.smileScore ?? box.expressionScore, 0.5)), 0);
    };
    const smileBest = ranked.slice().sort((a, b) =>
      expressionScore(b) - expressionScore(a) ||
      humanMomentQuality(b) - humanMomentQuality(a),
    )[0];
    const sharpBest = ranked.slice().sort((a, b) =>
      (b.subjectSharpnessScore ?? b.sharpnessScore ?? 0) - (a.subjectSharpnessScore ?? a.sharpnessScore ?? 0),
    )[0];
    if (smileBest) keep.add(smileBest.path);
    if (sharpBest) keep.add(sharpBest.path);
  }
}

export function autoCullGroup(files: MediaFile[], options: AutoCullOptions = {}): AutoCullDecision {
  const ranked = rankBestShots(files);
  const best = ranked[0] ?? null;
  const keep = new Set<string>();
  const reject = new Set<string>();
  const reasons: Record<string, string[]> = {};
  if (!best) return { best: null, keep: [], reject: [], confidence: 'low', reasons };

  keep.add(best.path);
  addQuotaKeepers(ranked, keep, options);
  for (const path of keep) reasons[path] = path === best.path ? ['best shot'] : ['quota keeper'];
  const bestScore = bestShotScore(best);
  const secondScore = ranked[1] ? bestShotScore(ranked[1]) : 0;
  const gap = bestScore - secondScore;
  const confidence = options.confidence ?? 'balanced';
  const requiredReasons = confidence === 'conservative' ? 4 : confidence === 'aggressive' ? 1 : 2;
  const scoreGapThreshold = confidence === 'conservative' ? 92 : confidence === 'aggressive' ? 48 : 72;
  const blurGapThreshold = confidence === 'conservative' ? 58 : confidence === 'aggressive' ? 24 : 38;
  const groupMode = options.groupPhotoEveryoneGood;
  const bestFaceCount = best.faceCount ?? best.faceBoxes?.length ?? 0;
  const bestPersonCount = best.personCount ?? best.personBoxes?.length ?? 0;
  const bestWeakestFace = weakestFaceSignal(best);

  for (const file of files) {
    if (file.path === best.path) continue;
    if (file.isProtected || (file.rating ?? 0) > 0 || file.pick === 'selected') {
      keep.add(file.path);
      reasons[file.path] = ['manual keeper'];
      continue;
    }
    if (confidence !== 'aggressive' && isDetailStoryKeeper(file)) {
      keep.add(file.path);
      reasons[file.path] = ['detail/story keeper'];
      continue;
    }
    if (keep.has(file.path)) continue;
    const fileScore = bestShotScore(file);
    const fileReasons: string[] = [];
    const bestHumanMoment = humanMomentQuality(best);
    const fileHumanMoment = humanMomentQuality(file);
    const fileFaceCount = file.faceCount ?? file.faceBoxes?.length ?? 0;
    const filePersonCount = file.personCount ?? file.personBoxes?.length ?? 0;
    const weakFace = weakestFaceSignal(file);
    if (file.blurRisk === 'high') fileReasons.push('high blur risk');
    if (faceQuality(best) - faceQuality(file) >= 42) fileReasons.push('weaker face/eye detail');
    if (bestHumanMoment - fileHumanMoment >= 28) fileReasons.push('weaker eyes/smile moment');
    if (bestFaceCount >= 2 && bestFaceCount - fileFaceCount >= 1) fileReasons.push('missing group faces');
    if (bestPersonCount >= 2 && bestPersonCount - filePersonCount >= 1) fileReasons.push('fewer people detected');
    if (groupMode && bestFaceCount >= 2 && weakFace < 0.58 && bestWeakestFace - weakFace >= 0.12) fileReasons.push('blink/weak face risk');
    if (groupMode && (bestFaceCount >= 2 || bestPersonCount >= 2) && (fileFaceCount < bestFaceCount || filePersonCount < bestPersonCount)) fileReasons.push('everyone-good miss');
    if ((best.subjectSharpnessScore ?? 0) - (file.subjectSharpnessScore ?? 0) >= 28) fileReasons.push('softer subject');
    if ((best.reviewScore ?? 0) - (file.reviewScore ?? 0) >= 22) fileReasons.push('lower review score');
    if (bestScore - fileScore >= scoreGapThreshold) fileReasons.push('lower best-shot score');
    const enoughReasons = fileReasons.length >= requiredReasons &&
      (confidence !== 'conservative' || bestScore - fileScore >= 60);
    if (enoughReasons || (file.blurRisk === 'high' && bestScore - fileScore >= blurGapThreshold)) {
      reject.add(file.path);
      reasons[file.path] = fileReasons;
    }
  }

  return {
    best,
    keep: [...keep],
    reject: [...reject],
    confidence: gap >= 72 ? 'high' : gap >= 28 ? 'medium' : 'low',
    reasons,
  };
}

export function hammingDistanceHex(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  let distance = Math.abs(a.length - b.length) * 4;
  for (let i = 0; i < len; i++) {
    const av = parseInt(a[i], 16);
    const bv = parseInt(b[i], 16);
    if (Number.isNaN(av) || Number.isNaN(bv)) {
      distance += 4;
    } else {
      let x = av ^ bv;
      while (x) {
        distance += x & 1;
        x >>= 1;
      }
    }
  }
  return distance;
}

export function scoreReview(input: ReviewScoreInput): ReviewScore {
  const sharpness = input.sharpnessScore ?? 0;
  const subjectSharpness = input.subjectSharpnessScore ?? 0;
  const rating = input.rating ?? 0;
  let score = Math.min(55, Math.log10(Math.max(1, sharpness) + 1) * 18);
  const reasons: string[] = [];

  if (input.isProtected) {
    score += 25;
    reasons.push('protected');
  }
  if (rating > 0) {
    score += rating * 8;
    reasons.push(`${rating} star`);
  }
  if ((input.faceCount ?? 0) > 0) {
    score += 16 + Math.min(18, faceQuality(input) / 5);
    reasons.push(`${input.faceCount} face${input.faceCount === 1 ? '' : 's'}`);
    const eyeScore = (input.faceBoxes ?? []).reduce((best, box) => Math.max(best, box.eyeScore ?? 0), 0);
    if (eyeScore >= 2) reasons.push('eyes sharp');
    else if (eyeScore === 1) reasons.push('face present');
  } else if ((input.personCount ?? 0) > 0) {
    score += 12 + Math.min(14, subjectPresenceQuality(input) / 6);
    reasons.push(`${input.personCount} person${input.personCount === 1 ? '' : 's'}`);
  }
  if (subjectSharpness >= 120) {
    score += 22;
    reasons.push('subject sharp');
  } else if (subjectSharpness > 0 && subjectSharpness < 35) {
    score -= 18;
    reasons.push('subject soft');
  }
  if (sharpness >= 180) reasons.push('sharp');
  if (sharpness < 35) reasons.push('soft');
  if (input.visualGroupSize && input.visualGroupSize > 1) reasons.push('similar');
  if (typeof input.exposureValue === 'number') score += 5;

  const blurRisk: ReviewScore['blurRisk'] =
    Math.max(sharpness, subjectSharpness) < 25 ? 'high'
    : Math.max(sharpness, subjectSharpness) < 70 ? 'medium'
    : 'low';
  if (blurRisk === 'high') score -= 25;
  if (blurRisk === 'medium') score -= 8;
  if (blurRisk !== 'low' && !reasons.includes('soft')) reasons.push('soft');

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    blurRisk,
    reasons,
  };
}

export function groupByVisualHash(files: MediaFile[], threshold = 8): Record<string, string[]> {
  const hashed = files.filter((f) => f.visualHash);
  const visited = new Set<string>();
  const groups: Record<string, string[]> = {};
  let groupIndex = 1;

  for (const file of hashed) {
    if (visited.has(file.path) || !file.visualHash) continue;
    const group = [file.path];
    visited.add(file.path);

    for (const other of hashed) {
      if (visited.has(other.path) || !other.visualHash) continue;
      if (hammingDistanceHex(file.visualHash, other.visualHash) <= threshold) {
        visited.add(other.path);
        group.push(other.path);
      }
    }

    if (group.length > 1) {
      groups[`visual-${groupIndex++}`] = group;
    }
  }

  return groups;
}

export function groupByFaceSignature(files: MediaFile[], threshold = 10): Record<string, string[]> {
  const faceFiles = files.filter((f) => f.faceSignature && (f.faceCount ?? 0) > 0);
  const visited = new Set<string>();
  const groups: Record<string, string[]> = {};
  let groupIndex = 1;

  for (const file of faceFiles) {
    if (visited.has(file.path) || !file.faceSignature) continue;
    const group = [file.path];
    visited.add(file.path);

    for (const other of faceFiles) {
      if (visited.has(other.path) || !other.faceSignature) continue;
      if (hammingDistanceHex(file.faceSignature, other.faceSignature) <= threshold) {
        visited.add(other.path);
        group.push(other.path);
      }
    }

    if (group.length > 1) {
      groups[`face-${groupIndex++}`] = group;
    }
  }

  return groups;
}

export function deserializeEmbedding(hex: string): Float32Array | null {
  if (!hex || hex.length % 2 !== 0) return null;
  try {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      const value = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      if (Number.isNaN(value)) return null;
      bytes[i] = value;
    }
    return new Float32Array(bytes.buffer);
  } catch {
    return null;
  }
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aNorm += a[i] * a[i];
    bNorm += b[i] * b[i];
  }
  const denom = Math.sqrt(aNorm) * Math.sqrt(bNorm);
  if (denom <= 1e-10) return 0;
  return Math.max(0, Math.min(1, dot / denom));
}

export function groupByFaceEmbedding(files: MediaFile[], threshold = 0.67): Record<string, string[]> {
  const faceFiles = files
    .map((file) => ({ file, embedding: file.faceEmbedding ? deserializeEmbedding(file.faceEmbedding) : null }))
    .filter((entry): entry is { file: MediaFile; embedding: Float32Array } =>
      !!entry.embedding && (entry.file.faceCount ?? 0) > 0,
    );
  const visited = new Set<string>();
  const groups: Record<string, string[]> = {};
  let groupIndex = 1;

  for (const entry of faceFiles) {
    if (visited.has(entry.file.path)) continue;
    const group = [entry.file.path];
    visited.add(entry.file.path);

    for (const other of faceFiles) {
      if (visited.has(other.file.path)) continue;
      if (cosineSimilarity(entry.embedding, other.embedding) >= threshold) {
        visited.add(other.file.path);
        group.push(other.file.path);
      }
    }

    if (group.length > 1) {
      groups[`face-${groupIndex++}`] = group;
    }
  }

  return groups;
}

export function groupByFaceSimilarity(files: MediaFile[], embeddingThreshold = 0.67, signatureThreshold = 10): Record<string, string[]> {
  const embeddingGroups = groupByFaceEmbedding(files, embeddingThreshold);
  if (Object.keys(embeddingGroups).length > 0) return embeddingGroups;
  return groupByFaceSignature(files, signatureThreshold);
}

export function bestInGroup(files: MediaFile[]): MediaFile | null {
  if (files.length === 0) return null;
  return rankBestShots(files)[0];
}
