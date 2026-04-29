import type { MediaFile } from '../../shared/types';
import { bestShotScore, faceQuality, humanMomentQuality } from '../../shared/review';

export function buildAiReasons(file: MediaFile, limit = 6): string[] {
  const reasons = new Set<string>();
  if (file.pick === 'selected') reasons.add('picked keeper');
  if (file.pick === 'rejected') reasons.add('marked reject');
  for (const reason of file.reviewReasons ?? []) reasons.add(reason);
  for (const reason of file.subjectReasons ?? []) reasons.add(reason);

  const faceCount = file.faceCount ?? file.faceBoxes?.length ?? 0;
  const personCount = file.personCount ?? file.personBoxes?.length ?? 0;
  if (faceCount > 0) {
    const bestEye = (file.faceBoxes ?? []).reduce((best, box) => Math.max(best, box.eyeScore ?? 0), 0);
    reasons.add(`${faceCount} face${faceCount === 1 ? '' : 's'} detected`);
    if (bestEye >= 2) reasons.add('best eyes open');
    else if (bestEye === 1) reasons.add('blink/side-face risk');
    if (humanMomentQuality(file) >= 75) reasons.add('strong expression moment');
    if (faceQuality(file) < 45) reasons.add('weak face detail');
  }
  if (personCount > 0) reasons.add(`${personCount} person${personCount === 1 ? '' : 's'} detected`);
  if ((file.subjectSharpnessScore ?? 0) >= 120) reasons.add('sharpest subject candidate');
  if ((file.subjectSharpnessScore ?? 0) > 0 && (file.subjectSharpnessScore ?? 0) < 35) reasons.add('softer subject');
  if (file.blurRisk === 'high') reasons.add('high blur risk');
  if (file.blurRisk === 'medium') reasons.add('medium blur risk');
  if (file.visualGroupSize && file.visualGroupSize > 1) reasons.add(`similar stack ${file.visualGroupSize}`);
  if (file.burstSize && file.burstSize > 1) reasons.add(`burst frame ${file.burstIndex ?? '?'} of ${file.burstSize}`);
  if (file.faceGroupSize && file.faceGroupSize > 1) reasons.add(`similar face group ${file.faceGroupSize}`);
  if (bestShotScore(file) >= 185) reasons.add('high best-shot score');
  return [...reasons].slice(0, limit);
}

export function buildAiBadges(file: MediaFile): string[] {
  const badges: string[] = [];
  if (typeof file.reviewScore === 'number') badges.push(`Score ${file.reviewScore}`);
  if ((file.reviewScore ?? 0) >= 70) badges.push('Best');
  if (file.blurRisk === 'high' || file.blurRisk === 'medium') badges.push('Blur');
  if ((file.faceCount ?? 0) > 0) badges.push(`Face ${file.faceCount}`);
  if ((file.personCount ?? 0) > 0) badges.push(`Person ${file.personCount}`);
  if (file.visualGroupSize && file.visualGroupSize > 1) badges.push(`Similar ${file.visualGroupSize}`);
  if (file.faceGroupSize && file.faceGroupSize > 1) badges.push(`Face group ${file.faceGroupSize}`);
  if (typeof file.subjectSharpnessScore === 'number') badges.push(`Subject ${file.subjectSharpnessScore}`);
  return badges.slice(0, 5);
}
