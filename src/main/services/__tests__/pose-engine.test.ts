import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => os.tmpdir(),
  },
}));

import { verifyPoseModelFile } from '../pose-engine';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('pose model integrity', () => {
  it('accepts the repository MoveNet model pinned by the production manifest', async () => {
    const modelPath = path.resolve(process.cwd(), 'models', 'movenet_thunder.onnx');
    await expect(verifyPoseModelFile(modelPath)).resolves.toBe(true);
  });

  it('rejects an untrusted file', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'keptra-pose-model-'));
    temporaryDirectories.push(directory);
    const modelPath = path.join(directory, 'movenet_thunder.onnx');
    await writeFile(modelPath, 'not a trusted ONNX model');
    await expect(verifyPoseModelFile(modelPath)).resolves.toBe(false);
  });
});
