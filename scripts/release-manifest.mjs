import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const outDir = path.join(root, 'out');
const artifactDir = path.join(root, 'artifacts', 'release');
const packagePath = path.join(root, 'package.json');
const supportMatrixPath = path.join(root, 'docs', 'support-matrix.json');
const benchmarkDir = path.join(root, 'artifacts', 'benchmarks');

const outputArg = process.argv.find((arg) => arg.startsWith('--output='));
const outputPath = path.resolve(root, outputArg?.slice('--output='.length) || path.join(artifactDir, 'release-readiness-manifest.json'));

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function optionalJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return readJson(filePath);
  } catch (error) {
    return { error: error.message };
  }
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  } catch (error) {
    return null;
  }
}

function relative(filePath) {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function listJsonFiles(dir, predicate) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json') && predicate(name))
    .sort()
    .map((name) => path.join(dir, name));
}

function parseJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return { parseError: error.message, raw: line };
      }
    });
}

function summarizeBenchmark(filePath) {
  const records = parseJsonl(filePath);
  const summaries = records.filter((record) => record.phase === 'summary');
  const latest = summaries.at(-1) || records.at(-1) || null;
  return {
    path: relative(filePath),
    records: records.length,
    summaries: summaries.length,
    latest,
  };
}

function summarizeSmokeManifest(filePath) {
  const manifest = optionalJson(filePath);
  return {
    path: relative(filePath),
    checkedAt: manifest?.checkedAt ?? null,
    ok: manifest?.ok ?? manifest?.launch?.manifest?.ok ?? null,
    platform: manifest?.platform ?? manifest?.launch?.manifest?.platform ?? null,
    arch: manifest?.arch ?? manifest?.launch?.manifest?.arch ?? null,
    version: manifest?.version ?? manifest?.launch?.manifest?.version ?? null,
    appDir: manifest?.appDir ? relative(manifest.appDir) : null,
    models: manifest?.models ?? manifest?.resources?.models ?? [],
    launch: manifest?.launch ? {
      status: manifest.launch.status,
      signal: manifest.launch.signal,
      output: manifest.launch.output ? relative(manifest.launch.output) : null,
      ok: manifest.launch.manifest?.ok ?? null,
      missingModels: manifest.launch.manifest?.missingModels ?? [],
      missingPreload: manifest.launch.manifest?.missingPreload ?? [],
      updateMode: manifest.launch.manifest?.updateMode ?? null,
    } : null,
  };
}

function collectMakeArtifacts() {
  const makeDir = path.join(outDir, 'make');
  if (!fs.existsSync(makeDir)) return [];
  const artifacts = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const stat = fs.statSync(full);
        artifacts.push({
          path: relative(full),
          bytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        });
      }
    }
  };
  walk(makeDir);
  return artifacts.sort((a, b) => a.path.localeCompare(b.path));
}

const packageJson = readJson(packagePath);
const supportMatrix = readJson(supportMatrixPath);
const smokeManifestFiles = listJsonFiles(outDir, (name) => /^package(-launch)?-smoke-/.test(name));
const benchmarkFiles = fs.existsSync(benchmarkDir)
  ? fs.readdirSync(benchmarkDir).filter((name) => name.endsWith('.jsonl')).sort().map((name) => path.join(benchmarkDir, name))
  : [];
const dirtyFiles = git(['status', '--short'])?.split(/\r?\n/).filter(Boolean) ?? [];
const makeArtifacts = collectMakeArtifacts();
const currentMakeArtifacts = makeArtifacts.filter((artifact) => artifact.path.includes(packageJson.version));

const manifest = {
  generatedAt: new Date().toISOString(),
  package: {
    name: packageJson.name,
    productName: packageJson.productName,
    version: packageJson.version,
    description: packageJson.description,
    private: packageJson.private,
    node: packageJson.engines?.node ?? null,
    electron: packageJson.devDependencies?.electron ?? null,
  },
  git: {
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    commit: git(['rev-parse', 'HEAD']),
    shortCommit: git(['rev-parse', '--short', 'HEAD']),
    commitDate: git(['show', '-s', '--format=%cI', 'HEAD']),
    dirty: dirtyFiles.length > 0,
    dirtyFiles,
  },
  supportMatrix: {
    path: relative(supportMatrixPath),
    generatedAt: supportMatrix.generatedAt,
    features: supportMatrix.features,
    platforms: supportMatrix.platforms,
  },
  smoke: {
    manifests: smokeManifestFiles.map(summarizeSmokeManifest),
  },
  benchmarks: benchmarkFiles.map(summarizeBenchmark),
  artifacts: {
    currentVersion: currentMakeArtifacts,
    historical: makeArtifacts.filter((artifact) => !currentMakeArtifacts.includes(artifact)),
  },
  commands: {
    verify: 'npm run verify',
    package: 'npm run package',
    make: 'npm run make',
    packageSmoke: 'npm run package:smoke',
    fixtureSmoke: 'npm run fixtures:smoke',
    benchmarkSmoke: 'npm run bench:smoke',
    supportMatrix: 'npm run docs:sync-matrix',
    docsCheck: 'npm run docs:check',
    releaseManifest: 'npm run release:manifest',
    publishUpdate: 'npm run update:publish -- --endpoint <url> --platform <platform> --version <version> --file <artifact>',
  },
  readiness: {
    packageVersionPresent: Boolean(packageJson.version),
    cleanGitAtGeneration: dirtyFiles.length === 0,
    packageSmokeManifests: smokeManifestFiles.length,
    benchmarkSummaries: benchmarkFiles.map(parseJsonl).flat().filter((record) => record.phase === 'summary').length,
    supportMatrixPlatforms: supportMatrix.platforms?.length ?? 0,
    makeArtifacts: currentMakeArtifacts.length,
  },
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`[release-manifest] wrote ${relative(outputPath)}`);
