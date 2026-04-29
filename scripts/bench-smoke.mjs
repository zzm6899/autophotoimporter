import { readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const root = process.cwd();
const fixtureDir = path.join(root, 'fixtures', 'smoke');
const outDir = path.join(root, 'artifacts', 'benchmarks');
mkdirSync(outDir, { recursive: true });

function roundMs(value) {
  return Math.round(value * 100) / 100;
}

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const startedAt = new Date().toISOString();
const records = [];
const mark = (phase, status, extra = {}) => {
  records.push({
    at: new Date().toISOString(),
    runId,
    suite: 'smoke-fixtures',
    phase,
    status,
    ...extra,
  });
};

const start = performance.now();
mark('run', 'started');

const discoverStart = performance.now();
const files = walk(fixtureDir).map((file) => {
  const s = statSync(file);
  return { path: path.relative(root, file), bytes: s.size, ext: path.extname(file).toLowerCase() || '(none)' };
});
mark('discover', 'completed', {
  files: files.length,
  wallMs: roundMs(performance.now() - discoverStart),
});

const aggregateStart = performance.now();
const elapsedMs = performance.now() - start;
const byExt = Object.fromEntries(
  [...new Set(files.map((file) => file.ext))].sort().map((ext) => [
    ext,
    files.filter((file) => file.ext === ext).length,
  ]),
);
mark('aggregate', 'completed', {
  bytes: files.reduce((sum, file) => sum + file.bytes, 0),
  extensionMix: byExt,
  wallMs: roundMs(performance.now() - aggregateStart),
});

const record = {
  at: startedAt,
  runId,
  suite: 'smoke-fixtures',
  phase: 'summary',
  status: 'completed',
  files: files.length,
  bytes: files.reduce((sum, file) => sum + file.bytes, 0),
  extensionMix: byExt,
  wallMs: roundMs(elapsedMs),
  p50Ms: roundMs(elapsedMs),
  p95Ms: roundMs(elapsedMs),
  cacheHitRate: null,
  provider: null,
  faceConcurrency: null,
  previewConcurrency: null,
};
mark('run', 'completed', {
  files: record.files,
  bytes: record.bytes,
  wallMs: record.wallMs,
});
const outPath = path.join(outDir, 'smoke.jsonl');
writeFileSync(outPath, [...records, record].map((item) => JSON.stringify(item)).join('\n') + '\n', { flag: 'a' });
console.log(`[bench-smoke] ${files.length} fixtures, ${record.bytes} bytes, ${records.length + 1} records -> ${outPath}`);
