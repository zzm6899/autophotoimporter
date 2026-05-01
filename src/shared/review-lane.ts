import type { MediaFile } from './types';

export type SecondPassReason =
  | 'unreviewed'
  | 'blur-risk'
  | 'low-confidence-keeper'
  | 'near-duplicate'
  | 'unmarked';

export function getSecondPassReasons(file: MediaFile): SecondPassReason[] {
  if (file.type !== 'photo' || file.reviewApproved) return [];

  const reasons: SecondPassReason[] = [];
  if (!file.reviewScore) reasons.push('unreviewed');
  if (file.blurRisk === 'high') reasons.push('blur-risk');
  if (file.pick === 'selected' && (file.reviewScore ?? 0) < 58) reasons.push('low-confidence-keeper');
  if (file.visualGroupId && !file.pick) reasons.push('near-duplicate');
  if (!file.pick) reasons.push('unmarked');
  return reasons;
}

export function needsSecondPass(file: MediaFile): boolean {
  return getSecondPassReasons(file).length > 0;
}
