import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp' },
  nativeImage: {},
}));

vi.mock('exifr', () => ({
  default: {
    parse: vi.fn().mockResolvedValue(null),
    thumbnail: vi.fn().mockResolvedValue(null),
  },
}));

import {
  FaceInferenceCircuit,
  FaceInferenceCircuitError,
} from '../face-engine';

describe('FaceInferenceCircuit', () => {
  it.each(['detector', 'embedder', 'person'] as const)(
    'serializes high-concurrency %s work to one native Run per session',
    async (stage) => {
      const circuit = new FaceInferenceCircuit(stage);
      let active = 0;
      let maxActive = 0;
      const runs = Array.from({ length: 24 }, (_, index) => circuit.run(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        active--;
        return index;
      }, 2_000));

      await expect(Promise.all(runs)).resolves.toEqual(Array.from({ length: 24 }, (_, index) => index));
      expect(maxActive).toBe(1);
      expect(circuit.diagnostics()).toMatchObject({
        state: 'closed', active: 0, queued: 0, maxConcurrent: 1,
      });
    },
  );

  it('times out a hung native owner, rejects queued waiters, and fails later calls fast', async () => {
    vi.useFakeTimers();
    try {
      const circuit = new FaceInferenceCircuit('person', 1);
      const never = new Promise<number>(() => undefined);
      const owner = circuit.run(() => never, 100);
      const queuedWork = vi.fn(async () => 2);
      const queued = circuit.run(queuedWork, 100);
      // Register rejection handlers before advancing fake time so Node never
      // observes an intentionally triggered circuit rejection as unhandled.
      const ownerOutcome = owner.then(
        (value) => ({ value }),
        (error: FaceInferenceCircuitError) => ({ error }),
      );
      const queuedOutcome = queued.then(
        (value) => ({ value }),
        (error: FaceInferenceCircuitError) => ({ error }),
      );

      await vi.advanceTimersByTimeAsync(101);
      await expect(ownerOutcome).resolves.toMatchObject({ error: {
        code: 'FACE_INFERENCE_TIMEOUT', stage: 'person',
      } });
      await expect(queuedOutcome).resolves.toMatchObject({ error: {
        code: 'FACE_INFERENCE_TIMEOUT', stage: 'person',
      } });
      expect(queuedWork).not.toHaveBeenCalled();
      expect(circuit.diagnostics()).toMatchObject({
        state: 'open', active: 0, queued: 0,
        failureCode: 'FACE_INFERENCE_TIMEOUT',
      });

      const started = Date.now();
      await expect(circuit.run(async () => 3, 100)).rejects.toMatchObject({
        code: 'FACE_INFERENCE_CIRCUIT_OPEN', stage: 'person',
      });
      expect(Date.now() - started).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens on native rejection without dispatching serialized waiters', async () => {
    const circuit = new FaceInferenceCircuit('person', 1);
    let rejectOwner!: (error: Error) => void;
    const ownerWork = new Promise<number>((_resolve, reject) => { rejectOwner = reject; });
    const owner = circuit.run(() => ownerWork, 1_000);
    const waiter = circuit.run(async () => 9, 1_000);
    const ownerOutcome = owner.catch((error: FaceInferenceCircuitError) => error);
    const waiterOutcome = waiter.catch((error: FaceInferenceCircuitError) => error);
    rejectOwner(new Error('ORT execution provider failed'));

    await expect(ownerOutcome).resolves.toMatchObject({
      code: 'FACE_INFERENCE_FAILED', stage: 'person',
    });
    await expect(waiterOutcome).resolves.toMatchObject({
      code: 'FACE_INFERENCE_FAILED', stage: 'person',
    });
  });

  it('rejects every concurrent detector owner when one native run fails', async () => {
    const circuit = new FaceInferenceCircuit('detector');
    let rejectFirst!: (error: Error) => void;
    const firstNative = new Promise<number>((_resolve, reject) => { rejectFirst = reject; });
    const first = circuit.run(() => firstNative, 1_000)
      .catch((error: FaceInferenceCircuitError) => error);
    const second = circuit.run(() => new Promise<number>(() => undefined), 1_000)
      .catch((error: FaceInferenceCircuitError) => error);
    rejectFirst(new Error('DML device removed'));

    await expect(first).resolves.toMatchObject({ code: 'FACE_INFERENCE_FAILED', stage: 'detector' });
    await expect(second).resolves.toMatchObject({ code: 'FACE_INFERENCE_FAILED', stage: 'detector' });
    await expect(circuit.run(async () => 1, 1_000)).rejects.toMatchObject({
      code: 'FACE_INFERENCE_CIRCUIT_OPEN', stage: 'detector',
    });
  });

  it('reset rejects active and queued work, then permits a fresh session call', async () => {
    const circuit = new FaceInferenceCircuit('person', 1);
    const owner = circuit.run(() => new Promise<number>(() => undefined), 10_000);
    const queued = circuit.run(async () => 2, 10_000);
    circuit.reset('test session replaced');

    await expect(owner).rejects.toMatchObject({ code: 'FACE_INFERENCE_RESET' });
    await expect(queued).rejects.toMatchObject({ code: 'FACE_INFERENCE_RESET' });
    await expect(circuit.run(async () => 7, 1_000)).resolves.toBe(7);
    expect(circuit.diagnostics()).toMatchObject({ state: 'closed', active: 0, queued: 0 });
  });

  it('ignores a stale native completion after reset without corrupting the new generation', async () => {
    const circuit = new FaceInferenceCircuit('detector', 1);
    let resolveStale!: (value: number) => void;
    const staleNative = new Promise<number>((resolve) => { resolveStale = resolve; });
    const stale = circuit.run(() => staleNative, 10_000);
    const staleOutcome = stale.catch((error: FaceInferenceCircuitError) => error);
    circuit.reset('detector session replaced');
    await expect(staleOutcome).resolves.toMatchObject({ code: 'FACE_INFERENCE_RESET' });

    await expect(circuit.run(async () => 11, 1_000)).resolves.toBe(11);
    resolveStale(5);
    await Promise.resolve();
    expect(circuit.diagnostics()).toMatchObject({ state: 'closed', active: 0, queued: 0 });
    await expect(circuit.run(async () => 12, 1_000)).resolves.toBe(12);
  });

  it('preserves explicit machine-readable error identity', () => {
    const error = new FaceInferenceCircuitError(
      'FACE_INFERENCE_CIRCUIT_OPEN', 'detector', 'previous timeout',
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('FaceInferenceCircuitError');
    expect(error.message).toContain('detector inference unavailable');
  });
});
