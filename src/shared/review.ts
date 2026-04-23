import type { MediaFile } from './types';

export interface ReviewScoreInput {
  sharpnessScore?: number;
  subjectSharpnessScore?: number;
  faceCount?: number;
  faceBoxes?: MediaFile['faceBoxes'];
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

export function faceQuality(file: Pick<MediaFile, 'faceCount' | 'faceBoxes' | 'subjectSharpnessScore'>): number {
  const boxes = file.faceBoxes ?? [];
  const bestEye = boxes.reduce((best, box) => Math.max(best, box.eyeScore ?? 0), 0);
  const eyeSum = boxes.reduce((sum, box) => sum + (box.eyeScore ?? 0), 0);
  const faceCount = file.faceCount ?? boxes.length;
  const faceArea = boxes.reduce((sum, box) => sum + box.width * box.height, 0);
  const sharp = Math.min(60, (file.subjectSharpnessScore ?? 0) / 3);
  return Math.round(
    Math.min(faceCount, 4) * 18 +
    bestEye * 18 +
    eyeSum * 7 +
    Math.min(18, faceArea * 120) +
    sharp,
  );
}

export function keeperScore(file: MediaFile): number {
  return (
    (file.isProtected ? 120 : 0) +
    (file.rating ?? 0) * 30 +
    faceQuality(file) +
    Math.min(70, (file.subjectSharpnessScore ?? 0) / 2.4) +
    Math.min(45, (file.sharpnessScore ?? 0) / 6) +
    Math.min(55, file.reviewScore ?? 0) -
    (file.blurRisk === 'high' ? 90 : file.blurRisk === 'medium' ? 30 : 0)
  );
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

export function bestInGroup(files: MediaFile[]): MediaFile | null {
  if (files.length === 0) return null;
  return files.slice().sort((a, b) =>
    Number(!!b.isProtected) - Number(!!a.isProtected) ||
    (b.rating ?? 0) - (a.rating ?? 0) ||
    faceQuality(b) - faceQuality(a) ||
    (b.faceCount ?? 0) - (a.faceCount ?? 0) ||
    (b.subjectSharpnessScore ?? 0) - (a.subjectSharpnessScore ?? 0) ||
    Number(a.blurRisk === 'high') - Number(b.blurRisk === 'high') ||
    keeperScore(b) - keeperScore(a) ||
    (b.sharpnessScore ?? 0) - (a.sharpnessScore ?? 0) ||
    (b.reviewScore ?? 0) - (a.reviewScore ?? 0) ||
    (a.burstIndex ?? 0) - (b.burstIndex ?? 0),
  )[0];
}
