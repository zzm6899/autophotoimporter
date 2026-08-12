import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const ort = require('onnxruntime-node');
const root = process.cwd();
const requestedProvider = process.argv.find((arg) => arg.startsWith('--provider='))?.split('=')[1] ?? 'cpu';
const iterationsArg = Number(process.argv.find((arg) => arg.startsWith('--iterations='))?.split('=')[1] ?? 10);
const iterations = Math.max(3, Math.min(100, Number.isFinite(iterationsArg) ? Math.round(iterationsArg) : 10));

if (!['cpu', 'dml'].includes(requestedProvider)) {
  throw new Error(`Unsupported provider "${requestedProvider}". Use --provider=cpu or --provider=dml.`);
}
if (requestedProvider === 'dml' && process.platform !== 'win32') {
  throw new Error('DirectML is available only on Windows in the shipped runtime.');
}

const models = [
  { key: 'face-detector', file: 'version-RFB-640.onnx', type: 'float32', dims: [1, 3, 480, 640] },
  { key: 'face-embedder', file: 'w600k_mbf.onnx', type: 'float32', dims: [1, 3, 112, 112] },
  { key: 'person-detector', file: 'ssd_mobilenet_v1_12.onnx', type: 'uint8', dims: [1, 320, 320, 3] },
];

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
  return sorted[index];
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function makeTensor(spec) {
  const length = spec.dims.reduce((product, value) => product * value, 1);
  const data = spec.type === 'uint8' ? new Uint8Array(length) : new Float32Array(length);
  return new ort.Tensor(spec.type, data, spec.dims);
}

async function benchmarkModel(spec) {
  const modelPath = path.join(root, 'models', spec.file);
  const sizeBytes = statSync(modelPath).size;
  const executionProviders = requestedProvider === 'dml'
    ? [{ name: 'dml' }]
    : ['cpu'];
  const loadStarted = performance.now();
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders,
    graphOptimizationLevel: 'all',
    intraOpNumThreads: requestedProvider === 'cpu' ? Math.min(6, os.cpus().length || 1) : 1,
    interOpNumThreads: 1,
    logSeverityLevel: 3,
  });
  const loadMs = performance.now() - loadStarted;
  const inputName = session.inputNames?.[0];
  if (!inputName) throw new Error(`${spec.key} has no input name`);
  const tensor = makeTensor(spec);

  // Warm graph compilation and memory allocation before collecting samples.
  await session.run({ [inputName]: tensor });
  await session.run({ [inputName]: tensor });

  const samplesMs = [];
  for (let index = 0; index < iterations; index++) {
    const started = performance.now();
    await session.run({ [inputName]: tensor });
    samplesMs.push(performance.now() - started);
  }
  await session.release?.();

  return {
    model: spec.key,
    file: spec.file,
    sha256: sha256(modelPath),
    sizeBytes,
    provider: requestedProvider,
    input: { type: spec.type, dims: spec.dims },
    loadMs: round(loadMs),
    samples: samplesMs.length,
    minMs: round(Math.min(...samplesMs)),
    p50Ms: round(percentile(samplesMs, 0.5)),
    p95Ms: round(percentile(samplesMs, 0.95)),
    maxMs: round(Math.max(...samplesMs)),
    meanMs: round(samplesMs.reduce((sum, value) => sum + value, 0) / samplesMs.length),
  };
}

const startedAt = new Date().toISOString();
const results = [];
for (const model of models) {
  try {
    results.push({ status: 'passed', ...(await benchmarkModel(model)) });
  } catch (error) {
    results.push({
      status: 'failed',
      model: model.key,
      file: model.file,
      provider: requestedProvider,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const report = {
  schemaVersion: 1,
  suite: 'keptra-ai-models',
  startedAt,
  completedAt: new Date().toISOString(),
  runtime: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    provider: requestedProvider,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    logicalCores: os.cpus().length,
    memoryGB: round(os.totalmem() / 1024 / 1024 / 1024),
  },
  results,
};

const outDir = path.join(root, 'artifacts', 'benchmarks');
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `ai-models-${requestedProvider}.json`);
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

for (const result of results) {
  if (result.status === 'passed') {
    console.log(`[bench:ai] ${result.model}: load ${result.loadMs}ms, p50 ${result.p50Ms}ms, p95 ${result.p95Ms}ms (${result.provider})`);
  } else {
    console.error(`[bench:ai] ${result.model}: FAILED - ${result.error}`);
  }
}
console.log(`[bench:ai] report: ${outPath}`);
if (results.some((result) => result.status === 'failed')) process.exitCode = 1;
