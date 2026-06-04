/**
 * tune-harness.ts — headless weight-tuning harness (NOT shipped).
 *
 * Runs the REAL ONNX face/person detection on a sample of real photos, computes
 * sharpness the same way the renderer does (96² and 480-wide Laplacian variance),
 * applies the Taekwondo sports scoring, and prints a ranked table + a cull-to-N
 * summary so weights can be tuned against actual data.
 *
 * Run:
 *   npx esbuild scripts/tune-harness.ts --bundle --platform=node --format=cjs \
 *     --external:electron --external:onnxruntime-node --outfile=tmp/tune.cjs
 *   npx electron tmp/tune.cjs "<folder>" <sampleCount> <cullPercent>
 */

import { app, nativeImage } from 'electron';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { analyzeFaces } from '../src/main/services/face-engine';
import {
  athleteContactSignal, frozenActionSignal, sportsActionQuality,
  bestShotScore, keeperScore, scoreReview, configureReviewProfile,
  selectKeepersToTarget,
} from '../src/shared/review';
import type { MediaFile } from '../src/shared/types';

const IS_BGRA = process.platform === 'win32' || process.platform === 'darwin';
const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.nef', '.cr2', '.cr3', '.arw', '.raf', '.dng', '.tif', '.tiff']);

function lapVariance(buf: Buffer, w: number, h: number, region?: { x: number; y: number; w: number; h: number }): number {
  const rOff = IS_BGRA ? 2 : 0;
  const gray = (i: number) => buf[i + rOff] * 0.299 + buf[i + 1] * 0.587 + buf[i + (IS_BGRA ? 0 : 2)] * 0.114;
  const left = Math.max(1, Math.floor(region?.x ?? 1));
  const top = Math.max(1, Math.floor(region?.y ?? 1));
  const right = Math.min(w - 1, Math.ceil((region?.x ?? 0) + (region?.w ?? w - 2)));
  const bottom = Math.min(h - 1, Math.ceil((region?.y ?? 0) + (region?.h ?? h - 2)));
  let sum = 0, sumSq = 0, count = 0;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const i = (y * w + x) * 4;
      const lap = Math.abs(gray(i - w * 4) + gray(i + w * 4) + gray(i - 4) + gray(i + 4) - 4 * gray(i));
      sum += lap; sumSq += lap * lap; count++;
    }
  }
  const mean = sum / Math.max(1, count);
  return Math.round(Math.max(0, sumSq / Math.max(1, count) - mean * mean));
}

function bitmapAt(img: Electron.NativeImage, w: number, h: number): { buf: Buffer; w: number; h: number } {
  const r = img.resize({ width: w, height: h });
  const sz = r.getSize();
  return { buf: (r.toBitmap?.() ?? r.getBitmap()) as Buffer, w: sz.width, h: sz.height };
}

async function main() {
  const folder = process.argv[2];
  const sampleCount = parseInt(process.argv[3] ?? '80', 10);
  const cullPercent = parseFloat(process.argv[4] ?? '8');
  if (!folder) { console.error('usage: electron tune.cjs <folder> <sampleCount> <cullPercent>'); app.quit(); return; }

  const all = readdirSync(folder).filter((f) => PHOTO_EXT.has(path.extname(f).toLowerCase()));
  const stride = Math.max(1, Math.floor(all.length / sampleCount));
  const sample = all.filter((_, i) => i % stride === 0).slice(0, sampleCount);
  console.log(`\nFolder: ${folder}\nTotal photos: ${all.length} | sampling every ${stride} → ${sample.length} frames\n`);

  const files: MediaFile[] = [];
  let n = 0;
  for (const name of sample) {
    const p = path.join(folder, name);
    try {
      const fa = await analyzeFaces(p);
      const img = await nativeImage.createThumbnailFromPath(p, { width: 1600, height: 1600 }).catch(() => nativeImage.createFromPath(p));
      const whole = bitmapAt(img, 96, 96);
      const wholeSharp = lapVariance(whole.buf, whole.w, whole.h);
      const sub = bitmapAt(img, 480, Math.round(480 * (img.getSize().height / Math.max(1, img.getSize().width))));
      let subjSharp = lapVariance(sub.buf, sub.w, sub.h, { x: sub.w * 0.2, y: sub.h * 0.1, w: sub.w * 0.6, h: sub.h * 0.8 });
      // Refine subject sharpness over the largest face/person box, like the renderer.
      const boxes = [...fa.boxes, ...fa.personBoxes];
      for (const b of boxes) {
        const rs = lapVariance(sub.buf, sub.w, sub.h, { x: b.x * sub.w, y: b.y * sub.h, w: b.width * sub.w, h: b.height * sub.h });
        subjSharp = Math.max(subjSharp, rs);
      }
      const review = scoreReview({ sharpnessScore: wholeSharp, subjectSharpnessScore: subjSharp, faceCount: fa.boxes.length, faceBoxes: fa.boxes, personCount: fa.personBoxes.length, personBoxes: fa.personBoxes });
      files.push({
        path: p, name, size: 1, type: 'photo', extension: path.extname(name),
        sharpnessScore: wholeSharp, subjectSharpnessScore: subjSharp,
        faceCount: fa.boxes.length, faceBoxes: fa.boxes, faceDetection: 'native',
        personCount: fa.personBoxes.length, personBoxes: fa.personBoxes,
        blurRisk: review.blurRisk, reviewScore: review.score,
      });
    } catch (e) {
      console.error(`  skip ${name}: ${(e as Error).message}`);
    }
    if (++n % 10 === 0) process.stdout.write(`  …${n}/${sample.length}\n`);
  }

  configureReviewProfile('taekwondo');
  const rows = files.map((f) => ({
    f,
    faces: f.faceCount ?? 0,
    persons: f.personCount ?? 0,
    contact: athleteContactSignal(f),
    action: frozenActionSignal(f),
    whole: f.sharpnessScore ?? 0,
    subj: f.subjectSharpnessScore ?? 0,
    blur: f.blurRisk,
    sports: sportsActionQuality(f),
    best: bestShotScore(f),
    keep: keeperScore(f),
  })).sort((a, b) => b.best - a.best);

  console.log('\n=== RANKED (Taekwondo scoring) ===');
  console.log('rank  best  sports  contact action  faces person  whole  subj  blur   file');
  rows.forEach((r, i) => {
    console.log(
      `${String(i + 1).padStart(3)}  ${String(r.best).padStart(5)}  ${String(r.sports).padStart(5)}  ` +
      `${r.contact.toFixed(2)}    ${r.action.toFixed(2)}   ${String(r.faces).padStart(2)}    ${String(r.persons).padStart(2)}    ` +
      `${String(r.whole).padStart(5)} ${String(r.subj).padStart(5)} ${(r.blur ?? '?').padEnd(6)} ${r.f.name}`,
    );
  });

  const target = Math.max(1, Math.round(files.length * (cullPercent / 100)));
  const cull = selectKeepersToTarget(files, { target, eventMode: 'taekwondo' });
  const keptSet = new Set(cull.keep);
  console.log(`\n=== CULL to ${cullPercent}% → ${target} keepers (of ${files.length}) ===`);
  console.log('Kept frames:');
  rows.filter((r) => keptSet.has(r.f.path)).forEach((r) =>
    console.log(`  best=${String(r.best).padStart(5)} contact=${r.contact.toFixed(2)} action=${r.action.toFixed(2)} faces=${r.faces} persons=${r.persons} subj=${r.subj}  ${r.f.name}`));

  // Distribution summary to sanity-check the weighting.
  const avg = (sel: (r: typeof rows[number]) => number) => (rows.reduce((s, r) => s + sel(r), 0) / Math.max(1, rows.length));
  console.log(`\nSample averages: contact=${avg((r) => r.contact).toFixed(2)} action=${avg((r) => r.action).toFixed(2)} sports=${avg((r) => r.sports).toFixed(0)} best=${avg((r) => r.best).toFixed(0)}`);
  const withPeople = rows.filter((r) => r.persons > 0 || r.faces > 0).length;
  console.log(`Frames with a subject: ${withPeople}/${rows.length} | high-blur: ${rows.filter((r) => r.blur === 'high').length}`);
  app.quit();
}

app.whenReady().then(main).catch((e) => { console.error(e); app.quit(); });
