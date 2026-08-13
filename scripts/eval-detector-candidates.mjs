#!/usr/bin/env node
/**
 * Evaluate pinned face/person detector candidates with real image pixels.
 *
 * Requires Node 22.18+ for TypeScript type stripping (the shipped Electron
 * runtime uses Node 24). Candidate weights remain opt-in and are verified by
 * the runtime before ONNX Runtime loads them.
 */
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  DetectorCandidateRuntime,
  prepareCandidateInput,
  scoreDetections,
} from '../src/main/services/detector-candidate-runtime.ts';

const root = path.resolve(import.meta.dirname, '..');
const manifestPath = path.join(root, 'src', 'main', 'services', 'detector-model-manifest.json');
const supportedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.avif']);

function usage(exitCode = 0) {
  const output = `Usage:
  npm run bench:detectors -- --images <file-or-directory> [options]

Options:
  --model <id>        YuNet or NanoDet candidate id; repeat for both
  --provider <value>  auto, cpu, or dml (default: auto)
  --iterations <n>    End-to-end samples, cycling through input images
  --warmup <n>        Warmed real-image runs excluded from results (default: 3)
  --labels <json>     Optional labelled corpus for precision/recall
  --output <json>     Write the aggregate report to this path
  --predictions <json> Write per-image predictions (off by default)
  --help              Show this message

Label schema:
  {"schemaVersion":1,"images":{"relative/photo.jpg":{"faces":[box],"persons":[box]}}}
  where each box is {"x":0..1,"y":0..1,"width":0..1,"height":0..1}.

This is an evaluation gate, not a production model switch. RAW files should be
represented by the same extracted JPEG preview that the app would analyse.`;
  (exitCode === 0 ? console.log : console.error)(output);
  process.exit(exitCode);
}

function parseArguments(argv) {
  const parsed = { images: [], models: [], provider: 'auto', warmup: 3 };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') usage(0);
    const value = argv[index + 1];
    if (argument === '--images' || argument === '-i') {
      if (!value) usage(2);
      parsed.images.push(value);
      index++;
    } else if (argument === '--model' || argument === '-m') {
      if (!value) usage(2);
      parsed.models.push(value);
      index++;
    } else if (argument === '--provider') {
      if (!value) usage(2);
      parsed.provider = value;
      index++;
    } else if (argument === '--iterations') {
      parsed.iterations = Number(value);
      index++;
    } else if (argument === '--warmup') {
      parsed.warmup = Number(value);
      index++;
    } else if (argument === '--labels') {
      parsed.labels = value;
      index++;
    } else if (argument === '--output') {
      parsed.output = value;
      index++;
    } else if (argument === '--predictions') {
      parsed.predictions = value;
      index++;
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (parsed.images.length === 0) usage(2);
  if (!['auto', 'cpu', 'dml'].includes(parsed.provider)) throw new Error('--provider must be auto, cpu, or dml');
  if (!Number.isInteger(parsed.warmup) || parsed.warmup < 0 || parsed.warmup > 100) {
    throw new Error('--warmup must be an integer from 0 to 100');
  }
  if (parsed.iterations !== undefined && (!Number.isInteger(parsed.iterations) || parsed.iterations < 1)) {
    throw new Error('--iterations must be a positive integer');
  }
  return parsed;
}

async function collectImages(inputs) {
  const files = [];
  async function visit(input) {
    const absolute = path.resolve(input);
    const entry = await stat(absolute);
    if (entry.isDirectory()) {
      const children = await readdir(absolute, { withFileTypes: true });
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) await visit(path.join(absolute, child.name));
      return;
    }
    if (entry.isFile() && supportedExtensions.has(path.extname(absolute).toLowerCase())) files.push(absolute);
  }
  for (const input of inputs) await visit(input);
  return [...new Set(files)];
}

function percentile(sorted, proportion) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * proportion))];
}

function round(value, places = 3) {
  return Number(value.toFixed(places));
}

function timingSummary(samples, wallMs) {
  const totals = samples.map((sample) => sample.timings.totalMs).sort((a, b) => a - b);
  const sum = (key) => samples.reduce((total, sample) => total + sample.timings[key], 0);
  const photosPerSecond = samples.length / Math.max(Number.EPSILON, wallMs / 1_000);
  return {
    samples: samples.length,
    wallMs: round(wallMs),
    photosPerSecond: round(photosPerSecond),
    projectedMillionHours: round(1_000_000 / photosPerSecond / 3_600),
    target35PhotosPerSecondMet: photosPerSecond >= 35,
    target4HourRateMet: photosPerSecond >= 1_000_000 / (4 * 3_600),
    totalMs: {
      min: round(totals[0] ?? 0),
      p50: round(percentile(totals, 0.5)),
      p95: round(percentile(totals, 0.95)),
      p99: round(percentile(totals, 0.99)),
      max: round(totals.at(-1) ?? 0),
      mean: round(sum('totalMs') / Math.max(1, samples.length)),
    },
    meanStageMs: {
      preprocess: round(sum('preprocessMs') / Math.max(1, samples.length)),
      inference: round(sum('inferenceMs') / Math.max(1, samples.length)),
      postprocess: round(sum('postprocessMs') / Math.max(1, samples.length)),
    },
  };
}

function addMetrics(accumulator, metrics) {
  accumulator.truePositives += metrics.truePositives;
  accumulator.falsePositives += metrics.falsePositives;
  accumulator.falseNegatives += metrics.falseNegatives;
}

function finishMetrics(counts) {
  const precision = counts.truePositives / Math.max(1, counts.truePositives + counts.falsePositives);
  const recall = counts.truePositives / Math.max(1, counts.truePositives + counts.falseNegatives);
  return {
    ...counts,
    precision: round(precision, 6),
    recall: round(recall, 6),
    f1: round(precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall), 6),
  };
}

function labelFor(labels, imagePath) {
  if (!labels) return undefined;
  const relative = path.relative(process.cwd(), imagePath).replaceAll('\\', '/');
  return labels.images?.[relative] ?? labels.images?.[path.basename(imagePath)];
}

async function evaluate(candidate, modelPath, provider, images, options, labels) {
  const runtime = await DetectorCandidateRuntime.create(candidate, modelPath, provider);
  try {
    const firstPrepared = await prepareCandidateInput(images[0], candidate);
    for (let index = 0; index < options.warmup; index++) await runtime.runPrepared(firstPrepared);

    // The model ceiling uses a non-zero tensor made from the first real image.
    const kernelSamples = [];
    const kernelRuns = Math.max(10, Math.min(100, options.iterations));
    const kernelStarted = performance.now();
    for (let index = 0; index < kernelRuns; index++) kernelSamples.push(await runtime.runPrepared(firstPrepared));
    const kernelWallMs = performance.now() - kernelStarted;

    const samples = [];
    const predictions = {};
    const metricCounts = { truePositives: 0, falsePositives: 0, falseNegatives: 0 };
    const measuredUnique = new Set();
    const started = performance.now();
    for (let index = 0; index < options.iterations; index++) {
      const imagePath = images[index % images.length];
      const result = await runtime.run(imagePath);
      samples.push(result);
      const relative = path.relative(process.cwd(), imagePath).replaceAll('\\', '/');
      if (!predictions[relative]) predictions[relative] = result.detections;
      if (!measuredUnique.has(imagePath)) {
        measuredUnique.add(imagePath);
        const labelled = labelFor(labels, imagePath);
        if (labelled) {
          const roleLabels = candidate.role === 'face' ? labelled.faces ?? [] : labelled.persons ?? [];
          addMetrics(metricCounts, scoreDetections(result.detections, roleLabels));
        }
      }
    }
    const wallMs = performance.now() - started;

    return {
      candidateId: candidate.id,
      displayName: candidate.displayName,
      role: candidate.role,
      decoder: candidate.decoder,
      provider,
      modelFile: candidate.fileName,
      modelSha256: candidate.sha256,
      imageCount: images.length,
      warmupRuns: options.warmup,
      kernelAndPostprocess: timingSummary(kernelSamples, kernelWallMs),
      endToEndWarmCache: timingSummary(samples, wallMs),
      detections: {
        total: samples.reduce((total, sample) => total + sample.detections.length, 0),
        meanPerImage: round(samples.reduce((total, sample) => total + sample.detections.length, 0) / samples.length),
      },
      ...(labels ? { labelledCorpus: finishMetrics(metricCounts) } : {}),
      predictions,
    };
  } finally {
    await runtime.close();
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 2 || manifest.status !== 'mixed' || !manifest.productionFastPass) {
    throw new Error('Detector manifest is not mixed schema v2');
  }
  const runnable = manifest.models.filter((candidate) =>
    candidate.decoder === 'yunet-v1' || candidate.decoder === 'nanodet-plus-gfl-v1');
  const requestedIds = options.models.length > 0 ? options.models : runnable.map((candidate) => candidate.id);
  const candidates = requestedIds.map((id) => {
    const candidate = runnable.find((entry) => entry.id === id);
    if (!candidate) throw new Error(`Candidate is not supported by this evaluator: ${id}`);
    return candidate;
  });
  const images = await collectImages(options.images);
  if (images.length === 0) throw new Error('No supported images were found');
  const provider = options.provider === 'auto' ? (process.platform === 'win32' ? 'dml' : 'cpu') : options.provider;
  const labels = options.labels ? JSON.parse(await readFile(path.resolve(options.labels), 'utf8')) : undefined;
  if (labels && (labels.schemaVersion !== 1 || typeof labels.images !== 'object')) {
    throw new Error('Label file must use detector corpus schemaVersion 1');
  }
  const iterations = options.iterations ?? images.length;

  const report = {
    schemaVersion: 1,
    suite: 'keptra-detector-candidate-e2e',
    generatedAt: new Date().toISOString(),
    safetyStatus: 'mixed-production-fast-pass-and-evaluation',
    throughputTarget: {
      millionPhotosHours: [4, 8],
      requiredPhotosPerSecond: [round(1_000_000 / (8 * 3_600)), round(1_000_000 / (4 * 3_600))],
      caveat: 'Warm-cache single-process projection; validate cold storage, RAW previews, UI, and labelled accuracy separately.',
    },
    runtime: {
      provider,
      node: process.version,
      onnxRuntime: process.versions.onnxruntime ?? '1.21.0 package',
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
      logicalCpuCount: os.cpus().length,
      totalMemoryGiB: round(os.totalmem() / 1024 ** 3, 2),
    },
    inputs: {
      images: images.length,
      iterations,
      labels: Boolean(labels),
    },
    results: [],
  };

  for (const candidate of candidates) {
    const modelPath = path.join(
      root,
      'models',
      ...(candidate.bundledByDefault ? [] : ['experimental']),
      candidate.fileName,
    );
    console.error(`[eval] ${candidate.displayName} (${provider}) on ${images.length} real image(s)`);
    const result = await evaluate(candidate, modelPath, provider, images, { ...options, iterations }, labels);
    const { predictions, ...summary } = result;
    report.results.push(summary);
    if (options.predictions) {
      const predictionPath = path.resolve(options.predictions);
      const existing = report.predictions ?? {};
      report.predictions = { ...existing, [candidate.id]: predictions };
      await writeFile(predictionPath, `${JSON.stringify(report.predictions, null, 2)}\n`, 'utf8');
    }
  }

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) await writeFile(path.resolve(options.output), json, 'utf8');
  process.stdout.write(json);
}

main().catch((error) => {
  console.error(`[eval] ${error instanceof Error ? error.message : String(error)}`);
  console.error('Download production weights with `npm run models`; add --experimental-detectors for YOLOX.');
  process.exitCode = 1;
});
