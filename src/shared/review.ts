import type { MediaFile } from './types';

export interface ReviewScoreInput {
  sharpnessScore?: number;
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
  if (sharpness >= 180) reasons.push('sharp');
  if (sharpness < 35) reasons.push('soft');
  if (input.visualGroupSize && input.visualGroupSize > 1) reasons.push('similar');
  if (typeof input.exposureValue === 'number') score += 5;

  const blurRisk: ReviewScore['blurRisk'] =
    sharpness < 25 ? 'high'
    : sharpness < 70 ? 'medium'
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

export function bestInGroup(files: MediaFile[]): MediaFile | null {
  if (files.length === 0) return null;
  return files.slice().sort((a, b) =>
    Number(!!b.isProtected) - Number(!!a.isProtected) ||
    (b.rating ?? 0) - (a.rating ?? 0) ||
    (b.reviewScore ?? 0) - (a.reviewScore ?? 0) ||
    (b.sharpnessScore ?? 0) - (a.sharpnessScore ?? 0) ||
    (a.burstIndex ?? 0) - (b.burstIndex ?? 0),
  )[0];
}
