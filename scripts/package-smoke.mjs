import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

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
];

for (const target of required) {
  if (!existsSync(target)) fail(`Missing packaged runtime asset: ${target}`);
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
for (const model of models) {
  const modelPath = path.join(modelDir, model);
  if (!existsSync(modelPath)) fail(`Missing packaged model: ${model}`);
  if (statSync(modelPath).size <= 0) fail(`Packaged model is empty: ${model}`);
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
const thirdPartyDir = path.join(resourcesDir, 'third_party');
for (const notice of ['NOTICES.md', 'SFace-Apache-2.0.txt']) {
  if (!existsSync(path.join(thirdPartyDir, notice))) fail(`Missing packaged third-party notice: ${notice}`);
}

const manifest = {
  checkedAt: new Date().toISOString(),
  platform,
  arch,
  appDir,
  resourcesDir,
  models: models.map((model) => ({ name: model, bytes: statSync(path.join(modelDir, model)).size })),
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
