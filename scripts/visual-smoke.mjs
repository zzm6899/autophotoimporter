import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const rendererDir = path.join(root, '.vite', 'renderer', 'main_window');
const buildDir = path.join(root, '.vite', 'build');
const outDir = path.join(root, 'out');

function rel(filePath) {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function parseArgs(argv) {
  const options = {
    json: false,
    manifestPath: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--manifest') {
      const next = argv[index + 1];
      if (next && !next.startsWith('--')) {
        options.manifestPath = path.resolve(root, next);
        index += 1;
      } else {
        options.manifestPath = path.join(outDir, `visual-smoke-${process.platform}-${process.arch}.json`);
      }
    } else if (arg.startsWith('--manifest=')) {
      options.manifestPath = path.resolve(root, arg.slice('--manifest='.length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function readText(filePath) {
  return readFileSync(filePath, 'utf8');
}

function fileStatus(filePath) {
  const exists = existsSync(filePath);
  const bytes = exists ? statSync(filePath).size : 0;
  return {
    path: rel(filePath),
    exists,
    bytes,
    ok: exists && bytes > 0,
  };
}

function findRendererAssets() {
  if (!existsSync(rendererDir)) return [];
  const assetsDir = path.join(rendererDir, 'assets');
  if (!existsSync(assetsDir)) return [];
  return readdirSync(assetsDir)
    .filter((name) => /\.(js|css)$/.test(name))
    .map((name) => path.join(assetsDir, name))
    .sort();
}

function checkTokens(filePath, tokens) {
  const content = existsSync(filePath) ? readText(filePath) : '';
  return tokens.map((token) => ({
    token,
    found: content.includes(token),
  }));
}

function checkAnyAssetTokens(assetPaths, tokens) {
  const contents = assetPaths
    .filter((assetPath) => assetPath.endsWith('.js'))
    .map((assetPath) => ({ assetPath, content: readText(assetPath) }));

  return tokens.map((token) => {
    const match = contents.find(({ content }) => content.includes(token));
    return {
      token,
      found: Boolean(match),
      asset: match ? rel(match.assetPath) : null,
    };
  });
}

const requiredBuildFiles = [
  path.join(buildDir, 'main.js'),
  path.join(buildDir, 'preload.js'),
  path.join(rendererDir, 'index.html'),
];

const requiredUiFiles = [
  path.join(root, 'src', 'renderer', 'App.tsx'),
  path.join(root, 'src', 'renderer', 'App.css'),
  path.join(root, 'src', 'renderer', 'main.tsx'),
  path.join(root, 'src', 'renderer', 'components', 'DestinationPanel.tsx'),
  path.join(root, 'src', 'renderer', 'components', 'ImportResumeView.tsx'),
  path.join(root, 'src', 'renderer', 'components', 'SettingsPage.tsx'),
  path.join(root, 'src', 'renderer', 'components', 'CompareView.tsx'),
  path.join(root, 'src', 'renderer', 'components', 'ThumbnailGrid.tsx'),
];

const screens = [
  {
    id: 'preflight',
    label: 'Import preflight',
    source: path.join(root, 'src', 'renderer', 'components', 'DestinationPanel.tsx'),
    sourceTokens: ['Preflight', 'Preview Import', 'Check Plan', 'preflightImport'],
    bundleTokens: ['Preflight', 'Preview Import', 'Check Plan'],
  },
  {
    id: 'resume-view',
    label: 'Resume view',
    source: path.join(root, 'src', 'renderer', 'components', 'ImportResumeView.tsx'),
    sourceTokens: ['Import resume', 'Restore Session', 'Retry Failed', 'getLatestImportLedger'],
    bundleTokens: ['Import resume', 'Restore Session', 'Retry Failed'],
  },
  {
    id: 'settings-diagnostics-benchmark',
    label: 'Settings diagnostics and benchmark',
    source: path.join(root, 'src', 'renderer', 'components', 'SettingsPage.tsx'),
    sourceTokens: ['Diagnose GPU', 'Run smoke bench', 'Export diagnostics', 'Optimize settings'],
    bundleTokens: ['Diagnose GPU', 'Run smoke bench', 'Export diagnostics'],
  },
  {
    id: 'compare-cockpit',
    label: 'Compare cockpit',
    source: path.join(root, 'src', 'renderer', 'components', 'CompareView.tsx'),
    sourceTokens: ['Compare view', 'AI pick', 'Winner', 'Queue', 'Reject'],
    bundleTokens: ['Compare view', 'AI pick', 'Winner'],
  },
  {
    id: 'review-sprint',
    label: 'Focus Review',
    source: path.join(root, 'src', 'renderer', 'components', 'ThumbnailGrid.tsx'),
    sourceTokens: ['Focus Review', 'Queue Keepers', 'Best of Burst', 'Pause AI', 'reviewSprintMode'],
    bundleTokens: ['Focus Review', 'Queue Keepers', 'Best of Burst'],
  },
];

function buildManifest() {
  const assetPaths = findRendererAssets();
  const assetStatuses = assetPaths.map(fileStatus);
  const jsAssetCount = assetStatuses.filter((asset) => asset.path.endsWith('.js') && asset.ok).length;
  const cssAssetCount = assetStatuses.filter((asset) => asset.path.endsWith('.css') && asset.ok).length;

  const screenChecks = screens.map((screen) => {
    const sourceFile = fileStatus(screen.source);
    const sourceTokens = checkTokens(screen.source, screen.sourceTokens);
    const bundleTokens = checkAnyAssetTokens(assetPaths, screen.bundleTokens);
    return {
      id: screen.id,
      label: screen.label,
      source: sourceFile,
      sourceTokens,
      bundleTokens,
      ok: sourceFile.ok && sourceTokens.every((check) => check.found) && bundleTokens.every((check) => check.found),
    };
  });

  const buildFiles = requiredBuildFiles.map(fileStatus);
  const uiFiles = requiredUiFiles.map(fileStatus);
  const indexHtml = path.join(rendererDir, 'index.html');
  const indexReferences = existsSync(indexHtml)
    ? assetPaths.map((assetPath) => ({
      asset: rel(assetPath),
      referenced: readText(indexHtml).includes(path.basename(assetPath)),
    }))
    : [];

  const errors = [];
  for (const item of [...buildFiles, ...uiFiles, ...assetStatuses]) {
    if (!item.ok) errors.push(`Missing or empty file: ${item.path}`);
  }
  if (jsAssetCount === 0) errors.push('No built renderer JavaScript asset found.');
  if (cssAssetCount === 0) errors.push('No built renderer CSS asset found.');
  for (const reference of indexReferences) {
    if (!reference.referenced) errors.push(`Renderer index.html does not reference ${reference.asset}`);
  }
  for (const screen of screenChecks) {
    if (!screen.source.ok) errors.push(`Screen source missing: ${screen.id}`);
    for (const token of screen.sourceTokens) {
      if (!token.found) errors.push(`Screen ${screen.id} source token missing: ${token.token}`);
    }
    for (const token of screen.bundleTokens) {
      if (!token.found) errors.push(`Screen ${screen.id} built token missing: ${token.token}`);
    }
  }

  return {
    ok: errors.length === 0,
    checkedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    rendererDir: rel(rendererDir),
    buildFiles,
    rendererAssets: assetStatuses,
    rendererIndexReferences: indexReferences,
    uiFiles,
    screens: screenChecks,
    errors,
  };
}

const options = parseArgs(process.argv.slice(2));
const manifest = buildManifest();

if (options.manifestPath) {
  mkdirSync(path.dirname(options.manifestPath), { recursive: true });
  writeFileSync(options.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (options.json) {
  console.log(JSON.stringify(manifest, null, 2));
} else if (manifest.ok) {
  console.log(`[visual-smoke] ok: ${manifest.screens.length} screens, ${manifest.rendererAssets.length} renderer assets`);
  if (options.manifestPath) console.log(`[visual-smoke] manifest: ${rel(options.manifestPath)}`);
} else {
  console.error('[visual-smoke] failed');
  for (const error of manifest.errors) console.error(`- ${error}`);
}

process.exit(manifest.ok ? 0 : 1);
