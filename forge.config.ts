import path from 'path';
import fs from 'fs';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

/**
 * Copy a directory recursively (like cp -r src dst).
 * dst is created if it doesn't exist.
 */
function copyDirSync(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function copySharpRuntime(resourcesDir: string, platform: string, arch: string): void {
  const sharpRoot = path.resolve(__dirname, 'node_modules', 'sharp');
  const runtimeRoot = path.join(resourcesDir, 'sharp-runtime', 'node_modules');
  if (!fs.existsSync(sharpRoot)) throw new Error(`Sharp runtime is missing: ${sharpRoot}`);
  copyDirSync(sharpRoot, path.join(runtimeRoot, 'sharp'));
  for (const packageName of ['detect-libc', 'semver']) {
    const source = path.resolve(__dirname, 'node_modules', packageName);
    if (!fs.existsSync(source)) throw new Error(`Sharp dependency is missing: ${packageName}`);
    copyDirSync(source, path.join(runtimeRoot, packageName));
  }
  const colourSource = path.resolve(__dirname, 'node_modules', '@img', 'colour');
  if (!fs.existsSync(colourSource)) throw new Error('Sharp dependency is missing: @img/colour');
  copyDirSync(colourSource, path.join(runtimeRoot, '@img', 'colour'));

  const packages = platform === 'darwin' && arch === 'universal'
    ? ['sharp-darwin-arm64', 'sharp-darwin-x64']
    : [`sharp-${platform}-${arch}`];
  for (const packageName of packages) {
    const source = path.resolve(__dirname, 'node_modules', '@img', packageName);
    if (!fs.existsSync(source)) {
      throw new Error(`Sharp native target package is missing: @img/${packageName}`);
    }
    copyDirSync(source, path.join(runtimeRoot, '@img', packageName));
    const libvipsName = packageName.replace(/^sharp-/, 'sharp-libvips-');
    const libvipsSource = path.resolve(__dirname, 'node_modules', '@img', libvipsName);
    if (fs.existsSync(libvipsSource)) {
      copyDirSync(libvipsSource, path.join(runtimeRoot, '@img', libvipsName));
    }
  }
}

function pruneEvaluationOnlyDetectorResources(resourcesDir: string): void {
  if (process.env.KEPTRA_PACKAGE_EXPERIMENTAL_DETECTORS === '1') return;
  const modelRoot = path.resolve(resourcesDir, 'models');
  const candidateDir = path.resolve(modelRoot, 'experimental');
  if (!candidateDir.startsWith(modelRoot + path.sep)) {
    throw new Error(`Refusing to prune an unsafe detector path: ${candidateDir}`);
  }
  if (fs.existsSync(candidateDir)) fs.rmSync(candidateDir, { recursive: true, force: true });
}

const ortNativeArchitectures: Readonly<Record<string, readonly string[]>> = {
  darwin: ['arm64', 'x64'],
  linux: ['arm64', 'x64'],
  win32: ['arm64', 'x64'],
};

function directorySizeSync(dir: string): number {
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    bytes += entry.isDirectory() ? directorySizeSync(entryPath) : fs.statSync(entryPath).size;
  }
  return bytes;
}

function retainedOrtArchitectures(platform: string, arch: string): readonly string[] {
  const supported = ortNativeArchitectures[platform];
  if (!supported) {
    throw new Error(`onnxruntime-node does not ship a native binary for platform "${platform}".`);
  }
  if (platform === 'darwin' && arch === 'universal') return supported;
  if (!supported.includes(arch)) {
    throw new Error(
      `onnxruntime-node does not ship a native binary for ${platform}-${arch}; ` +
      `available architectures: ${supported.join(', ')}.`,
    );
  }
  return [arch];
}

/**
 * onnxruntime-node's npm package contains native binaries for every supported
 * OS and architecture. Keep only the binaries this package can execute. The
 * active target is validated before anything is removed so an unexpected
 * Electron Forge target fails closed instead of producing a broken build.
 */
function pruneOrtNativeBinaries(ortRoot: string, platform: string, arch: string): void {
  const nativeRoot = path.join(ortRoot, 'bin', 'napi-v3');
  if (!fs.existsSync(nativeRoot)) {
    throw new Error(`onnxruntime-node native binary directory is missing: ${nativeRoot}`);
  }

  const retainedArchitectures = retainedOrtArchitectures(platform, arch);
  const targetPlatformDir = path.join(nativeRoot, platform);

  // Verify every active target before deleting foreign binaries.
  for (const retainedArch of retainedArchitectures) {
    const targetDir = path.join(targetPlatformDir, retainedArch);
    if (!fs.existsSync(targetDir)) {
      throw new Error(`Required onnxruntime-node target directory is missing: ${targetDir}`);
    }
    const targetFiles = fs.readdirSync(targetDir);
    if (!targetFiles.some((name) => name.endsWith('.node'))) {
      throw new Error(`Required onnxruntime-node binding is missing from: ${targetDir}`);
    }
  }

  const bytesBefore = directorySizeSync(nativeRoot);
  for (const platformEntry of fs.readdirSync(nativeRoot, { withFileTypes: true })) {
    if (!platformEntry.isDirectory()) continue;
    const platformDir = path.join(nativeRoot, platformEntry.name);
    if (platformEntry.name !== platform) {
      fs.rmSync(platformDir, { recursive: true, force: true });
      continue;
    }
    for (const archEntry of fs.readdirSync(platformDir, { withFileTypes: true })) {
      if (archEntry.isDirectory() && !retainedArchitectures.includes(archEntry.name)) {
        fs.rmSync(path.join(platformDir, archEntry.name), { recursive: true, force: true });
      }
    }
  }

  const remainingPlatforms = fs.readdirSync(nativeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const remainingArchitectures = fs.readdirSync(targetPlatformDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (remainingPlatforms.some((entry) => entry !== platform)) {
    throw new Error(`Foreign onnxruntime-node platforms remain after pruning: ${remainingPlatforms.join(', ')}`);
  }
  if (remainingArchitectures.some((entry) => !retainedArchitectures.includes(entry))) {
    throw new Error(`Foreign onnxruntime-node architectures remain after pruning: ${remainingArchitectures.join(', ')}`);
  }

  const bytesAfter = directorySizeSync(nativeRoot);
  const savedMiB = (bytesBefore - bytesAfter) / (1024 * 1024);
  console.info(
    `[forge] onnxruntime-node ${platform}-${arch}: retained ${retainedArchitectures.join('+')}, ` +
    `removed ${savedMiB.toFixed(1)} MiB of foreign native binaries.`,
  );
}

const windowsIconPath = path.resolve(__dirname, 'assets/brand/icon.ico');
const productName = 'Keptra';
const macAppBundleId = process.env.MAC_APP_BUNDLE_ID || 'au.z2hs.keptra';
const macAppCategoryType = process.env.MAC_APP_CATEGORY_TYPE || 'public.app-category.photography';
const macSigningIdentity = process.env.APPLE_SIGNING_IDENTITY;
const macNotarizeEnabled = !!(
  process.env.APPLE_ID &&
  process.env.APPLE_APP_SPECIFIC_PASSWORD &&
  process.env.APPLE_TEAM_ID
);

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: productName,
    executableName: productName,
    appBundleId: macAppBundleId,
    appCategoryType: macAppCategoryType,
    appCopyright: `Copyright © ${new Date().getFullYear()} Z2HS. All rights reserved.`,
    extendInfo: {
      CFBundleDisplayName: productName,
      CFBundleName: productName,
      CFBundleIdentifier: macAppBundleId,
      LSApplicationCategoryType: macAppCategoryType,
      NSHighResolutionCapable: true,
      NSHumanReadableCopyright: `Copyright © ${new Date().getFullYear()} Z2HS. All rights reserved.`,
      NSPhotoLibraryUsageDescription: 'Keptra only accesses photo libraries and folders you choose for import and review.',
      NSRemovableVolumesUsageDescription: 'Keptra needs access to memory cards and removable drives you choose for photo import.',
      NSDownloadsFolderUsageDescription: 'Keptra can save downloads, diagnostics, and exported reports to your Downloads folder when you choose.',
    },
    icon: path.resolve(__dirname, 'assets/brand/icon'),
    ...(process.platform === 'darwin' && macSigningIdentity ? {
      osxSign: {
        identity: macSigningIdentity,
        hardenedRuntime: true,
        entitlements: path.resolve(__dirname, 'assets/entitlements.mac.plist'),
        'entitlements-inherit': path.resolve(__dirname, 'assets/entitlements.mac.inherit.plist'),
        'gatekeeper-assess': false,
      },
      ...(macNotarizeEnabled ? {
        osxNotarize: {
          appleId: process.env.APPLE_ID,
          appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
          teamId: process.env.APPLE_TEAM_ID,
        },
      } : {}),
    } : {}),
    extraResource: [
      // ONNX face models — loaded at runtime from process.resourcesPath/models
      path.resolve(__dirname, 'models'),
      // Redistributable model provenance and license texts.
      path.resolve(__dirname, 'third_party'),
      // ExifTool's proprietary camera tag database is required for protected
      // and rated images whose fields are not decoded by Exifr. It must be
      // outside ASAR because the vendored executable loads companion files.
      path.resolve(__dirname, 'node_modules', process.platform === 'win32' ? 'exiftool-vendored.exe' : 'exiftool-vendored.pl'),
      // onnxruntime-node ships a native .node binary that cannot live inside
      // the asar archive. Copied here as an extraResource so it lands in
      // resources/onnxruntime-node/ and can be required via process.resourcesPath.
      path.resolve(__dirname, 'node_modules', 'onnxruntime-node'),
      // UtilityProcess entrypoints are also kept outside app.asar. Electron's
      // hardened ASAR fuse can reject a forked module before JavaScript runs;
      // the same Vite bundle remains in app.asar for integrity/audit, while
      // this executable copy gives the process a normal filesystem path.
      path.resolve(__dirname, '.vite', 'build', 'image-preprocess-worker.js'),
    ],
    // After copying extraResources, inject onnxruntime-common (and global-agent)
    // into onnxruntime-node/node_modules/ so bare require() calls inside
    // onnxruntime-node/dist/index.js resolve correctly from the resources path.
    afterCopy: [
      (buildPath: string, _electronVersion: string, _platform: string, _arch: string, done: (error?: Error) => void) => {
        try {
          const ortRoot = path.join(buildPath, '..', 'onnxruntime-node');
          const ortNodeModules = path.join(ortRoot, 'node_modules');
          const projectNodeModules = path.resolve(__dirname, 'node_modules');
          for (const pkg of ['onnxruntime-common', 'global-agent', 'semver']) {
            const src = path.join(projectNodeModules, pkg);
            const dst = path.join(ortNodeModules, pkg);
            if (!fs.existsSync(src)) {
              throw new Error(`Required onnxruntime-node dependency missing: ${pkg}`);
            }
            if (fs.existsSync(src) && !fs.existsSync(dst)) {
              copyDirSync(src, dst);
            }
          }
          done();
        } catch (e) {
          done(e instanceof Error ? e : new Error(String(e)));
        }
      },
    ],
    // extraResource is copied after afterCopy/afterPrune/afterAsar. Prune only
    // once Electron Packager confirms those resources are in their final tree.
    afterCopyExtraResources: [
      (stagingPath: string, _electronVersion: string, platform: string, arch: string, done: (error?: Error) => void) => {
        try {
          const resourcesDir = platform === 'darwin'
            ? path.join(stagingPath, `${productName}.app`, 'Contents', 'Resources')
            : path.join(stagingPath, 'resources');
          pruneEvaluationOnlyDetectorResources(resourcesDir);
          copySharpRuntime(resourcesDir, platform, arch);
          pruneOrtNativeBinaries(path.join(resourcesDir, 'onnxruntime-node'), platform, arch);
          // Candidate weights are permitted in local evaluation checkouts but
          // must never enter a normal production artifact implicitly.
          if (process.env.KEPTRA_PACKAGE_EXPERIMENTAL_DETECTORS !== '1') {
            fs.rmSync(path.join(resourcesDir, 'models', 'experimental'), {
              recursive: true,
              force: true,
            });
          }
          done();
        } catch (e) {
          done(e instanceof Error ? e : new Error(String(e)));
        }
      },
    ],
  },
  rebuildConfig: {},
  makers: [
    // macOS — DMG installer
    new MakerDMG({
      format: 'ULFO',
      icon: path.resolve(__dirname, 'assets/brand/icon.icns'),
      contents: (opts) => [
        { x: 192, y: 160, type: 'file', path: opts.appPath },
        { x: 448, y: 160, type: 'link', path: '/Applications' },
      ],
      background: path.resolve(__dirname, 'assets/brand/dmg-bg.png'),
      additionalDMGOptions: {
        window: { size: { width: 640, height: 380 } },
        'icon-size': 80,
      },
    }),
    // macOS ZIP (for auto-update feeds)
    new MakerZIP({}, ['darwin']),
    // Windows — Squirrel installer (.exe) + portable ZIP fallback
    new MakerSquirrel({
      name: 'keptra',
      setupExe: 'Keptra-Setup.exe',
      iconUrl: 'https://raw.githubusercontent.com/zzm6899/autophotoimporter/main/assets/brand/icon.ico',
      ...(fs.existsSync(windowsIconPath) ? { setupIcon: windowsIconPath } : {}),
      noMsi: true,
    }),
    new MakerZIP({}, ['win32']),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/main/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        {
          entry: 'src/main/workers/image-preprocess-worker.ts',
          config: 'vite.preprocess-worker.config.ts',
          target: 'main',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // Automatically detects and unpacks native .node addons (like onnxruntime-node)
    // from the asar archive into app.asar.unpacked so Node can dlopen them.
    new AutoUnpackNativesPlugin({}),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
