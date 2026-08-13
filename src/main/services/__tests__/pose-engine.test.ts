import { existsSync } from 'node:fs';
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

import {
  createPoseInferenceSession,
  PoseInferenceCircuit,
  PoseInferenceCircuitError,
  PoseSessionRuntime,
  verifyPoseModelFile,
} from '../pose-engine';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('pose model integrity', () => {
  it('accepts the installed pinned MoveNet model and fails closed before models are downloaded', async () => {
    const modelPath = path.resolve(process.cwd(), 'models', 'movenet_thunder.onnx');
    await expect(verifyPoseModelFile(modelPath)).resolves.toBe(existsSync(modelPath));
  });

  it('rejects an untrusted file', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'keptra-pose-model-'));
    temporaryDirectories.push(directory);
    const modelPath = path.join(directory, 'movenet_thunder.onnx');
    await writeFile(modelPath, 'not a trusted ONNX model');
    await expect(verifyPoseModelFile(modelPath)).resolves.toBe(false);
  });
});

describe('MoveNet session creation', () => {
  it('uses the DirectML-required sequential mode with memory patterns disabled on Windows', async () => {
    const nativeSession = { run: vi.fn(), release: vi.fn() };
    const create = vi.fn(async () => nativeSession);

    await expect(createPoseInferenceSession(
      { create },
      'movenet_thunder.onnx',
      'win32',
    )).resolves.toBe(nativeSession);
    expect(create).toHaveBeenCalledWith('movenet_thunder.onnx', {
      executionProviders: ['dml', 'cpu'],
      executionMode: 'sequential',
      enableMemPattern: false,
      graphOptimizationLevel: 'all',
      logSeverityLevel: 3,
    });
  });

  it('falls back to CPU when DirectML session creation is unavailable', async () => {
    const nativeSession = { run: vi.fn(), release: vi.fn() };
    const create = vi.fn()
      .mockRejectedValueOnce(new Error('display adapter is unavailable'))
      .mockResolvedValueOnce(nativeSession);

    await expect(createPoseInferenceSession(
      { create },
      'movenet_thunder.onnx',
      'win32',
    )).resolves.toBe(nativeSession);
    expect(create).toHaveBeenNthCalledWith(1, 'movenet_thunder.onnx', {
      executionProviders: ['dml', 'cpu'],
      executionMode: 'sequential',
      enableMemPattern: false,
      graphOptimizationLevel: 'all',
      logSeverityLevel: 3,
    });
    expect(create).toHaveBeenNthCalledWith(2, 'movenet_thunder.onnx', {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
      logSeverityLevel: 3,
    });
  });
});

describe('MoveNet native session lifecycle', () => {
  it('serializes concurrent callers to one native Run on the shared session', async () => {
    const circuit = new PoseInferenceCircuit();
    let active = 0;
    let maxActive = 0;
    const release = vi.fn(async () => undefined);
    const run = vi.fn(async (feeds: { input: number }) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      active--;
      return feeds.input;
    });
    const runtime = new PoseSessionRuntime({ run, release }, 1, 'input', 'int32');

    const calls = Array.from({ length: 16 }, (_, index) =>
      runtime.run<number>({ input: index }, circuit, 2_000));

    await expect(Promise.all(calls)).resolves.toEqual(
      Array.from({ length: 16 }, (_, index) => index),
    );
    expect(maxActive).toBe(1);
    expect(run).toHaveBeenCalledTimes(16);
    expect(circuit.diagnostics()).toMatchObject({
      state: 'closed', active: 0, queued: 0, maxConcurrent: 1,
    });
    expect(runtime.diagnostics()).toMatchObject({ activeNativeRuns: 0, retired: false });

    await runtime.retire('test session');
    expect(release).toHaveBeenCalledOnce();
  });

  it('times out the owner, rejects queued calls, fails fast, and resets after native settlement', async () => {
    vi.useFakeTimers();
    try {
      const circuit = new PoseInferenceCircuit();
      let resolveNative!: (value: number) => void;
      const nativeRun = new Promise<number>((resolve) => { resolveNative = resolve; });
      const run = vi.fn(() => nativeRun);
      const runtime = new PoseSessionRuntime({ run, release: vi.fn() }, 4, 'input', 'int32');
      const owner = runtime.run<number>({ input: 1 }, circuit, 100);
      const queued = runtime.run<number>({ input: 2 }, circuit, 100);
      const ownerOutcome = owner.catch((error: PoseInferenceCircuitError) => error);
      const queuedOutcome = queued.catch((error: PoseInferenceCircuitError) => error);

      await vi.advanceTimersByTimeAsync(0);
      expect(run).toHaveBeenCalledOnce();
      expect(runtime.diagnostics()).toMatchObject({ activeNativeRuns: 1 });
      await vi.advanceTimersByTimeAsync(101);

      await expect(ownerOutcome).resolves.toMatchObject({ code: 'POSE_INFERENCE_TIMEOUT' });
      await expect(queuedOutcome).resolves.toMatchObject({ code: 'POSE_INFERENCE_TIMEOUT' });
      expect(run).toHaveBeenCalledOnce();
      expect(circuit.diagnostics()).toMatchObject({
        state: 'open', active: 0, queued: 0, failureCode: 'POSE_INFERENCE_TIMEOUT',
      });
      await expect(runtime.run<number>({ input: 3 }, circuit, 100)).rejects.toMatchObject({
        code: 'POSE_INFERENCE_CIRCUIT_OPEN',
      });

      resolveNative(7);
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.diagnostics()).toMatchObject({ activeNativeRuns: 0 });
      circuit.reset('test session reset');
      await expect(runtime.run<number>({ input: 4 }, circuit, 100)).resolves.toBe(7);
      expect(circuit.diagnostics()).toMatchObject({ state: 'closed', active: 0, queued: 0 });
      await runtime.retire('test session');
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds disposal while a native Run is delayed and releases only after it settles', async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      const circuit = new PoseInferenceCircuit();
      let resolveNative!: (value: number) => void;
      const nativeRun = new Promise<number>((resolve) => { resolveNative = resolve; });
      const release = vi.fn(async () => { events.push('release'); });
      const runtime = new PoseSessionRuntime({
        run: vi.fn(() => nativeRun.finally(() => { events.push('native-settled'); })),
        release,
      }, 8, 'input', 'int32');
      const caller = runtime.run<number>({ input: 1 }, circuit, 10_000);
      const callerOutcome = caller.catch((error: PoseInferenceCircuitError) => error);

      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.diagnostics()).toMatchObject({ activeNativeRuns: 1 });
      circuit.reset('application shutdown');
      const boundedRetirement = runtime.retireBounded('shutdown session', 25);
      await vi.advanceTimersByTimeAsync(26);
      await expect(boundedRetirement).resolves.toBe(false);
      await expect(callerOutcome).resolves.toMatchObject({ code: 'POSE_INFERENCE_RESET' });
      expect(release).not.toHaveBeenCalled();

      resolveNative(1);
      await vi.advanceTimersByTimeAsync(0);
      await runtime.retire('shutdown session');
      expect(release).toHaveBeenCalledOnce();
      expect(events).toEqual(['native-settled', 'release']);

      // A stale completion/retirement cannot poison the replacement generation.
      const replacementRelease = vi.fn(async () => undefined);
      const replacement = new PoseSessionRuntime({
        run: vi.fn(async () => 9), release: replacementRelease,
      }, 9, 'input', 'int32');
      await expect(replacement.run<number>({ input: 2 }, circuit, 100)).resolves.toBe(9);
      await replacement.retire('replacement session');
      expect(replacementRelease).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
