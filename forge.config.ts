import path from 'path';
import fs from 'fs';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const windowsIconPath = path.resolve(__dirname, 'assets/brand/icon.ico');

const config: ForgeConfig = {
  packagerConfig: {
    asar: {
      // onnxruntime-node ships a native .node binary that cannot live inside
      // the asar archive. Must be unpacked so Node can load the .node binary
      // at runtime via the external require() emitted by Vite.
      unpackDir: '{node_modules/onnxruntime-node,node_modules/onnxruntime-node/**}',
    },
    name: 'Photo Importer',
    icon: path.resolve(__dirname, 'assets/brand/icon'),
    extraResource: [
      // ONNX face models — bundled alongside the app, outside the asar so
      // onnxruntime can read them directly from the filesystem at runtime.
      path.resolve(__dirname, 'models'),
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
      name: 'photo-importer',
      setupExe: 'PhotoImporter-Setup.exe',
      iconUrl: 'https://raw.githubusercontent.com/juanmnl/importer/main/assets/brand/icon.ico',
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
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
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
