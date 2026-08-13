import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { extractFile, listPackage } from '@electron/asar';

const root = process.cwd();
const outDir = path.join(root, 'out');
const platform = process.platform;
const arch = process.env.npm_config_arch || process.arch;
const appName = 'Keptra';
const ortNativeArchitectures = {
  darwin: ['arm64', 'x64'],
  linux: ['arm64', 'x64'],
  win32: ['arm64', 'x64'],
};

function fail(message) {
  console.error(`[package-smoke] ${message}`);
  process.exit(1);
}

function retainedOrtArchitectures(targetPlatform, targetArch) {
  const supported = ortNativeArchitectures[targetPlatform];
  if (!supported) fail(`onnxruntime-node has no smoke-test target for platform "${targetPlatform}".`);
  if (targetPlatform === 'darwin' && targetArch === 'universal') return supported;
  if (!supported.includes(targetArch)) {
    fail(
      `onnxruntime-node has no native binary for ${targetPlatform}-${targetArch}; ` +
      `available architectures: ${supported.join(', ')}.`,
    );
  }
  return [targetArch];
}

function listFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    return entry.isDirectory()
      ? listFiles(entryPath, base)
      : [{ path: path.relative(base, entryPath), bytes: statSync(entryPath).size }];
  });
}

function findPackagedApp() {
  if (!existsSync(outDir)) fail('out/ does not exist. Run npm run package or npm run make first.');
  const candidates = readdirSync(outDir)
    .map((name) => path.join(outDir, name))
    .filter((entry) => {
      try { return statSync(entry).isDirectory(); } catch { return false; }
    });
  if (platform === 'win32') {
    return candidates.find((entry) => existsSync(path.join(entry, `${appName}.exe`)));
  }
  if (platform === 'darwin') {
    return candidates.find((entry) => existsSync(path.join(entry, `${appName}.app`, 'Contents', 'MacOS', appName)));
  }
  return candidates[0];
}

const appDir = findPackagedApp();
if (!appDir) fail(`No packaged ${appName} app found under out/.`);

const resourcesDir = platform === 'darwin'
  ? path.join(appDir, `${appName}.app`, 'Contents', 'Resources')
  : path.join(appDir, 'resources');

const required = [
  resourcesDir,
  path.join(resourcesDir, 'models'),
  path.join(resourcesDir, 'onnxruntime-node', 'dist', 'index.js'),
  path.join(resourcesDir, 'sharp-runtime', 'node_modules', 'sharp', 'dist', 'index.cjs'),
  path.join(resourcesDir, 'image-preprocess-worker.js'),
];

for (const target of required) {
  if (!existsSync(target)) fail(`Missing packaged runtime asset: ${target}`);
}

const asarPath = path.join(resourcesDir, 'app.asar');
if (!existsSync(asarPath)) fail(`Missing packaged app.asar: ${asarPath}`);
const asarEntries = listPackage(asarPath);
if (!asarEntries.some((entry) => entry.replaceAll('\\', '/').endsWith('/.vite/build/image-preprocess-worker.js'))) {
  fail('Packaged app.asar is missing .vite/build/image-preprocess-worker.js');
}
const looseWorkerPath = path.join(resourcesDir, 'image-preprocess-worker.js');
// @electron/asar expects the host platform's path separator when extracting
// (listPackage itself returns platform-shaped entries as well).
const protectedWorkerEntry = path.join('.vite', 'build', 'image-preprocess-worker.js');
const asarWorker = extractFile(asarPath, protectedWorkerEntry);
const looseWorker = readFileSync(looseWorkerPath);
const asarWorkerDigest = createHash('sha256').update(asarWorker).digest('hex');
const looseWorkerDigest = createHash('sha256').update(looseWorker).digest('hex');
if (asarWorkerDigest !== looseWorkerDigest) {
  fail(`Loose preprocess worker differs from integrity-protected ASAR worker: ${looseWorkerDigest} != ${asarWorkerDigest}`);
}
const sharpRuntimeDir = path.join(resourcesDir, 'sharp-runtime', 'node_modules');
const sharpProbe = spawnSync(process.execPath, ['-e', `
  const path = require('node:path');
  const runtime = ${JSON.stringify(sharpRuntimeDir)};
  for (const dependency of ['@img/colour', 'detect-libc', 'semver']) {
    const resolved = require.resolve(dependency, { paths: [path.join(runtime, 'sharp')] });
    if (!resolved.startsWith(runtime + path.sep)) {
      throw new Error(dependency + ' escaped packaged sharp-runtime: ' + resolved);
    }
  }
  const sharp = require(path.join(runtime, 'sharp'));
  sharp({ create: { width: 2, height: 2, channels: 3, background: '#336699' } })
    .raw().toBuffer().then((b) => { if (b.length !== 12) process.exit(2); });
`], { encoding: 'utf8', timeout: 15000 });
if (sharpProbe.status !== 0 || sharpProbe.error) {
  fail(`Packaged Sharp runtime is not resolvable: ${sharpProbe.error?.message ?? sharpProbe.stderr}`);
}

const ortNativeRoot = path.join(resourcesDir, 'onnxruntime-node', 'bin', 'napi-v3');
if (!existsSync(ortNativeRoot)) fail(`Missing packaged onnxruntime-node native directory: ${ortNativeRoot}`);
const retainedArchitectures = retainedOrtArchitectures(platform, arch);
const remainingPlatforms = readdirSync(ortNativeRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const foreignPlatforms = remainingPlatforms.filter((entry) => entry !== platform);
if (foreignPlatforms.length > 0) {
  fail(`Foreign onnxruntime-node platforms were packaged: ${foreignPlatforms.join(', ')}`);
}

const targetPlatformDir = path.join(ortNativeRoot, platform);
if (!existsSync(targetPlatformDir)) fail(`Missing onnxruntime-node target platform: ${platform}`);
const remainingArchitectures = readdirSync(targetPlatformDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const foreignArchitectures = remainingArchitectures.filter((entry) => !retainedArchitectures.includes(entry));
if (foreignArchitectures.length > 0) {
  fail(`Foreign onnxruntime-node architectures were packaged: ${foreignArchitectures.join(', ')}`);
}
for (const retainedArch of retainedArchitectures) {
  const targetDir = path.join(targetPlatformDir, retainedArch);
  if (!existsSync(targetDir)) fail(`Missing onnxruntime-node target architecture: ${platform}-${retainedArch}`);
  const nativeFiles = listFiles(targetDir);
  if (!nativeFiles.some((file) => file.path.endsWith('.node'))) {
    fail(`Missing onnxruntime-node binding for ${platform}-${retainedArch}`);
  }
  if (!nativeFiles.some((file) => /\.(?:dll|dylib|so(?:\.|$))/.test(file.path))) {
    fail(`Missing onnxruntime-node shared library for ${platform}-${retainedArch}`);
  }
}

const modelDir = path.join(resourcesDir, 'models');
const models = ['version-RFB-640.onnx', 'face_recognition_sface_2021dec.onnx', 'ssd_mobilenet_v1_12.onnx', 'movenet_thunder.onnx'];
const expectedModelDigests = {
  'version-RFB-640.onnx': '8f4c659275977e7a3bfbfa339a9c769ad793df50f9c0baa8c14b11baa1646430',
  'face_recognition_sface_2021dec.onnx': '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79',
  'ssd_mobilenet_v1_12.onnx': 'b8fba5e404077d4048d27fcd1667e85e27e192eb9bf51e696c46a3acd7d21058',
  'movenet_thunder.onnx': '3dca9f6e5f8a64dc9935a5be06fd8bf81bf01e696c9c05c6f2a650e0a401b763',
};
const packagedModelDigests = {};
for (const model of models) {
  const modelPath = path.join(modelDir, model);
  if (!existsSync(modelPath)) fail(`Missing packaged model: ${model}`);
  if (statSync(modelPath).size <= 0) fail(`Packaged model is empty: ${model}`);
  const digest = createHash('sha256').update(readFileSync(modelPath)).digest('hex');
  packagedModelDigests[model] = digest;
  if (digest !== expectedModelDigests[model]) fail(`Packaged model digest mismatch: ${model} (${digest})`);
}
const deprecatedModel = path.join(modelDir, 'w600k_mbf.onnx');
if (existsSync(deprecatedModel)) fail('Non-commercial legacy face model was packaged: w600k_mbf.onnx');
const forbiddenModelDigest = '9cc6e4a75f0e2bf0b1aed94578f144d15175f357bdc05e815e5c4a02b319eb4f';
for (const entry of readdirSync(modelDir, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.onnx')) continue;
  const digest = createHash('sha256').update(readFileSync(path.join(modelDir, entry.name))).digest('hex');
  if (digest === forbiddenModelDigest) {
    fail(`Non-commercial legacy face model digest was packaged as: ${entry.name}`);
  }
}
const detectorManifestPath = path.join(root, 'src', 'main', 'services', 'detector-model-manifest.json');
if (!existsSync(detectorManifestPath)) fail('Missing detector candidate manifest.');
const detectorManifest = JSON.parse(readFileSync(detectorManifestPath, 'utf8'));
if (detectorManifest.schemaVersion !== 1 || detectorManifest.status !== 'evaluation-only' ||
    detectorManifest.goldenCorpusRequired !== true || !Array.isArray(detectorManifest.models)) {
  fail('Invalid detector candidate manifest.');
}
const experimentalModelDir = path.join(modelDir, 'experimental');
const packagedExperimentalDetectors = [];
if (existsSync(experimentalModelDir)) {
  const knownFiles = new Set(detectorManifest.models.map((candidate) => candidate.fileName));
  for (const entry of readdirSync(experimentalModelDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.onnx')) continue;
    if (!knownFiles.has(entry.name)) fail(`Unknown experimental detector was packaged: ${entry.name}`);
    const candidate = detectorManifest.models.find((model) => model.fileName === entry.name);
    const filePath = path.join(experimentalModelDir, entry.name);
    const digest = createHash('sha256').update(readFileSync(filePath)).digest('hex');
    if (statSync(filePath).size !== candidate.bytes || digest !== candidate.sha256) {
      fail(`Experimental detector failed manifest verification: ${entry.name}`);
    }
    packagedExperimentalDetectors.push({ id: candidate.id, name: entry.name, bytes: statSync(filePath).size });
  }
}
if (packagedExperimentalDetectors.length > 0 && process.env.KEPTRA_PACKAGE_EXPERIMENTAL_DETECTORS !== '1') {
  fail('Evaluation-only detector weights were packaged without KEPTRA_PACKAGE_EXPERIMENTAL_DETECTORS=1.');
}
const thirdPartyDir = path.join(resourcesDir, 'third_party');
for (const notice of ['NOTICES.md', 'ONNX-Model-Zoo-MIT.txt', 'SFace-Apache-2.0.txt', 'UltraFace-MIT.txt', 'YuNet-MIT.txt']) {
  if (!existsSync(path.join(thirdPartyDir, notice))) fail(`Missing packaged third-party notice: ${notice}`);
}
const notices = readFileSync(path.join(thirdPartyDir, 'NOTICES.md'), 'utf8');
for (const requiredNoticeToken of [
  'c39647011b1d0eb48037ce3051438e51b19e2b11',
  'cc497be475371d891d5795e46fc80ebaddf683c5',
  '019281f3fcb151a90e491f3b2f0273f9f31bd6be',
  '91849267da7c576503f0f87a941b3139b64b7781',
  '38296077a99667cdad67af5096ce7eeb9b327453',
  '3364a833d9b3b5ff16af08beb04b1832cb012033',
  'ONNX-Model-Zoo-MIT.txt',
  'UltraFace-MIT.txt',
]) {
  if (!notices.includes(requiredNoticeToken)) fail(`Third-party notices omit pinned provenance: ${requiredNoticeToken}`);
}
if (notices.includes('929618539097dbeb779c13aed75dfe346d016d48')) {
  fail('Third-party notices retain the invalid historical SSD revision.');
}
for (const licenseCheck of [
  ['ONNX-Model-Zoo-MIT.txt', 'Copyright (c) ONNX Project Contributors'],
  ['UltraFace-MIT.txt', 'Copyright (c) 2019 linzai'],
  ['SFace-Apache-2.0.txt', 'Apache License'],
]) {
  const licenseText = readFileSync(path.join(thirdPartyDir, licenseCheck[0]), 'utf8');
  if (!licenseText.includes(licenseCheck[1])) fail(`Third-party license text is incomplete: ${licenseCheck[0]}`);
}

const manifest = {
  checkedAt: new Date().toISOString(),
  platform,
  arch,
  appDir,
  resourcesDir,
  models: models.map((model) => ({ name: model, bytes: statSync(path.join(modelDir, model)).size })),
  modelDigests: packagedModelDigests,
  preprocessWorkerDigest: looseWorkerDigest,
  experimentalDetectors: packagedExperimentalDetectors,
  onnxRuntime: {
    retainedArchitectures,
    nativeFiles: listFiles(targetPlatformDir),
  },
};
const executable = platform === 'win32'
  ? path.join(appDir, `${appName}.exe`)
  : platform === 'darwin'
    ? path.join(appDir, `${appName}.app`, 'Contents', 'MacOS', appName)
    : path.join(appDir, appName);

if (process.env.PACKAGE_SMOKE_LAUNCH !== '0') {
  if (!existsSync(executable)) fail(`Packaged executable missing: ${executable}`);
  const launchManifestPath = path.join(outDir, `package-launch-smoke-${platform}-${arch}.json`);
  const launched = spawnSync(executable, [], {
    env: {
      ...process.env,
      KEPTRA_PACKAGE_SMOKE: '1',
      KEPTRA_PACKAGE_SMOKE_SHOW: '1',
      KEPTRA_PACKAGE_SMOKE_OUTPUT: launchManifestPath,
      ELECTRON_ENABLE_LOGGING: '1',
    },
    timeout: 60000,
    windowsHide: true,
    encoding: 'utf8',
  });
  manifest.launch = {
    status: launched.status,
    signal: launched.signal,
    stdout: launched.stdout?.slice(-4000) ?? '',
    stderr: launched.stderr?.slice(-4000) ?? '',
    output: launchManifestPath,
  };
  if (launched.error) fail(`Launch smoke failed to start: ${launched.error.message}`);
  if (launched.status !== 0) {
    const diagnostic = existsSync(launchManifestPath)
      ? readFileSync(launchManifestPath, 'utf8').slice(-12000)
      : 'No launch manifest was written.';
    fail(`Launch smoke exited with ${launched.status ?? launched.signal}. ${launched.stderr ?? ''}\n${diagnostic}`);
  }
  if (!existsSync(launchManifestPath)) fail('Launch smoke did not write an output manifest.');
  const launchManifest = JSON.parse(readFileSync(launchManifestPath, 'utf8'));
  manifest.launch.manifest = launchManifest;
  if (!launchManifest.ok) fail(`Launch smoke manifest reported failure: ${JSON.stringify(launchManifest)}`);
}
const manifestPath = path.join(outDir, `package-smoke-${platform}-${arch}.json`);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`[package-smoke] ok: ${appDir}`);
