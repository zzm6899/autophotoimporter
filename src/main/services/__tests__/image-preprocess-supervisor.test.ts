import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd() },
  utilityProcess: { fork: vi.fn() },
}));

import {
  getImagePreprocessSupervisorDiagnostics,
  ImagePreprocessSupervisor,
  type PreprocessChild,
} from '../image-preprocess-supervisor';

class NodeForkAdapter {
  killed = false;

  constructor(private readonly child: ChildProcess) {}

  postMessage(message: unknown): void {
    this.child.send(message as any);
  }

  on(event: 'message' | 'exit' | 'error', listener: (...args: any[]) => void): this {
    this.child.on(event, listener);
    return this;
  }

  kill(): boolean {
    this.killed = true;
    return this.child.kill();
  }
}

class ImmediateWorker extends EventEmitter {
  killed = false;

  constructor() {
    super();
    queueMicrotask(() => this.emit('message', { type: 'ready' }));
  }

  postMessage(message: any): void {
    queueMicrotask(() => this.emit('message', {
      type: 'result', id: message.id, imagePath: message.imagePath,
      payload: { detectorCHW: new Float32Array(0), sourceWidth: 4, sourceHeight: 3 },
    }));
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  crash(): void {
    this.emit('exit', 1);
  }
}

class NeverReadyWorker extends EventEmitter {
  killed = false;
  postMessage(): void { /* never assigned while unready */ }
  kill(): boolean { this.killed = true; return true; }
}

class DelayedWorker extends EventEmitter {
  killed = false;

  constructor(private readonly delayMs: number) {
    super();
    queueMicrotask(() => this.emit('message', { type: 'ready' }));
  }

  postMessage(message: any): void {
    setTimeout(() => this.emit('message', {
      type: 'result', id: message.id, imagePath: message.imagePath,
      payload: { detectorCHW: new Float32Array(0), sourceWidth: 4, sourceHeight: 3 },
    }), this.delayMs);
  }

  kill(): boolean { this.killed = true; return true; }
}

class MalformedWorker extends EventEmitter {
  killed = false;

  constructor() {
    super();
    queueMicrotask(() => this.emit('message', { type: 'ready' }));
  }

  postMessage(message: any): void {
    queueMicrotask(() => this.emit('message', {
      type: 'result', id: message.id, imagePath: message.imagePath,
      payload: {
        detectorCHW: new Float32Array(7),
        surfaceBitmap: new Uint8Array(3),
        surfaceWidth: 40,
        surfaceHeight: 30,
        sourceWidth: 4,
        sourceHeight: 3,
      },
    }));
  }

  kill(): boolean { this.killed = true; return true; }
}

const supervisors: ImagePreprocessSupervisor[] = [];

afterEach(() => {
  for (const supervisor of supervisors.splice(0)) supervisor.dispose();
});

describe('ImagePreprocessSupervisor', () => {
  it('reports bounded pool diagnostics without exposing file paths or pixels', async () => {
    const supervisor = new ImagePreprocessSupervisor(() => new ImmediateWorker() as unknown as PreprocessChild, 2);
    supervisors.push(supervisor);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(getImagePreprocessSupervisorDiagnostics(supervisor)).toMatchObject({
      poolSize: 2,
      workers: 2,
      readyWorkers: 2,
      active: 0,
      queued: 0,
      quarantined: 0,
      disposed: false,
    });
  });

  it('contains an initial synchronous worker-factory failure and recovers on the request probe', async () => {
    let spawnCount = 0;
    let supervisor!: ImagePreprocessSupervisor;

    expect(() => {
      supervisor = new ImagePreprocessSupervisor(() => {
        spawnCount++;
        if (spawnCount === 1) throw new Error('initial fork failed');
        return new ImmediateWorker() as unknown as PreprocessChild;
      }, 1, 500);
    }).not.toThrow();
    supervisors.push(supervisor);

    await expect(supervisor.prepare({
      imagePath: 'after-initial-failure.jpg', orientation: 1,
      includeAnalysisSurface: false, includeDetectorTensor: false, includePersonTensors: false,
    })).resolves.toMatchObject({ sourceWidth: 4, sourceHeight: 3 });
    expect(spawnCount).toBe(2);
  });

  it('contains a synchronous replacement-factory failure and retries with backoff', async () => {
    const first = new ImmediateWorker();
    let spawnCount = 0;
    const supervisor = new ImagePreprocessSupervisor(() => {
      spawnCount++;
      if (spawnCount === 1) return first as unknown as PreprocessChild;
      if (spawnCount === 2) throw new Error('replacement fork failed');
      return new ImmediateWorker() as unknown as PreprocessChild;
    }, 1, 500);
    supervisors.push(supervisor);

    await expect(supervisor.prepare({
      imagePath: 'before-replacement.jpg', orientation: 1,
      includeAnalysisSurface: false, includeDetectorTensor: false, includePersonTensors: false,
    })).resolves.toMatchObject({ sourceWidth: 4 });
    first.crash();

    // The first delayed replacement throws synchronously. The supervisor must
    // contain that timer exception and schedule a backed-off follow-up probe.
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(spawnCount).toBe(3);
    await expect(supervisor.prepare({
      imagePath: 'after-replacement.jpg', orientation: 1,
      includeAnalysisSurface: false, includeDetectorTensor: false, includePersonTensors: false,
    })).resolves.toMatchObject({ sourceHeight: 3 });
  });

  it('opens the startup circuit after bounded synchronous factory failures', async () => {
    let spawnCount = 0;
    const supervisor = new ImagePreprocessSupervisor(() => {
      spawnCount++;
      throw new Error('fork remains unavailable');
    }, 1, 500);
    supervisors.push(supervisor);

    await expect(supervisor.prepare({
      imagePath: 'factory-down.jpg', orientation: 1,
      includeAnalysisSurface: false, includeDetectorTensor: false, includePersonTensors: false,
    })).rejects.toMatchObject({ code: 'PREPROCESS_WORKER_EXIT', stage: 'queued' });
    expect(spawnCount).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(spawnCount).toBe(3);
  });

  it('does not reject an arbitrary queued file when an unassigned worker misses startup', async () => {
    let spawnCount = 0;
    const first = new NeverReadyWorker();
    const supervisor = new ImagePreprocessSupervisor(() => {
      spawnCount++;
      return (spawnCount === 1 ? first : new DelayedWorker(80)) as unknown as PreprocessChild;
    }, 2, 500, 30);
    supervisors.push(supervisor);

    const firstRequest = supervisor.prepare({
      imagePath: 'first.jpg', orientation: 1, includeAnalysisSurface: false,
      includeDetectorTensor: false, includePersonTensors: false,
    });
    const queuedRequest = supervisor.prepare({
      imagePath: 'queued.jpg', orientation: 1, includeAnalysisSurface: false,
      includeDetectorTensor: false, includePersonTensors: false,
    });
    await expect(Promise.all([firstRequest, queuedRequest])).resolves.toHaveLength(2);
    expect(first.killed).toBe(true);
  });

  it('restores the configured pool after an idle ready worker exits', async () => {
    const children: ImmediateWorker[] = [];
    const supervisor = new ImagePreprocessSupervisor(() => {
      const child = new ImmediateWorker();
      children.push(child);
      return child as unknown as PreprocessChild;
    }, 3, 500);
    supervisors.push(supervisor);

    await expect(supervisor.prepare({
      imagePath: 'warmup.jpg', orientation: 1, includeAnalysisSurface: false,
      includeDetectorTensor: false, includePersonTensors: false,
    })).resolves.toMatchObject({ sourceWidth: 4 });
    expect(children).toHaveLength(3);
    children[0].crash();
    await new Promise((resolve) => setTimeout(resolve, 320));
    expect(children).toHaveLength(4);
    await expect(supervisor.prepare({
      imagePath: 'after-crash.jpg', orientation: 1, includeAnalysisSurface: false,
      includeDetectorTensor: false, includePersonTensors: false,
    })).resolves.toMatchObject({ sourceHeight: 3 });
  });

  it('keeps queued work on healthy slots while another slot repeatedly fails startup', async () => {
    let spawnCount = 0;
    const supervisor = new ImagePreprocessSupervisor(() => {
      spawnCount++;
      return (spawnCount === 1 ? new DelayedWorker(70) : new NeverReadyWorker()) as unknown as PreprocessChild;
    }, 2, 2_000, 20);
    supervisors.push(supervisor);

    const requests = Array.from({ length: 7 }, (_, index) => supervisor.prepare({
      imagePath: `healthy-${index}.jpg`, orientation: 1,
      includeAnalysisSurface: false, includeDetectorTensor: false, includePersonTensors: false,
    }));
    await expect(Promise.all(requests)).resolves.toHaveLength(7);
    expect(spawnCount).toBeGreaterThanOrEqual(3);
  });

  it('rejects malformed worker payloads and replaces only the corrupt slot', async () => {
    let spawnCount = 0;
    const bad = new MalformedWorker();
    const supervisor = new ImagePreprocessSupervisor(() => {
      spawnCount++;
      return (spawnCount === 1 ? bad : new ImmediateWorker()) as unknown as PreprocessChild;
    }, 1, 500);
    supervisors.push(supervisor);

    await expect(supervisor.prepare({
      imagePath: 'malformed.jpg', orientation: 1,
      includeAnalysisSurface: true, includeDetectorTensor: true, includePersonTensors: false,
    })).rejects.toMatchObject({ code: 'PREPROCESS_FAILED' });
    expect(bad.killed).toBe(true);
    await expect(supervisor.prepare({
      imagePath: 'next-valid.jpg', orientation: 1,
      includeAnalysisSurface: false, includeDetectorTensor: false, includePersonTensors: false,
    })).resolves.toMatchObject({ sourceWidth: 4, sourceHeight: 3 });
  });

  it('kills a non-returning native worker, keeps the event loop live, and continues in a replacement', async () => {
    const fixture = path.join(__dirname, 'fixtures', 'hanging-preprocess-worker.cjs');
    const children: NodeForkAdapter[] = [];
    const supervisor = new ImagePreprocessSupervisor(() => {
      const adapter = new NodeForkAdapter(fork(fixture, [], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'advanced',
      }));
      children.push(adapter);
      return adapter as unknown as PreprocessChild;
    }, 1, 120);
    supervisors.push(supervisor);

    let eventLoopTicked = false;
    setTimeout(() => { eventLoopTicked = true; }, 20);
    await expect(supervisor.prepare({
      imagePath: 'C:\\photos\\hang.jpg',
      orientation: 1,
      includeAnalysisSurface: false,
      includeDetectorTensor: false,
      includePersonTensors: false,
      testMode: 'hang',
    })).rejects.toMatchObject({
      code: 'PREPROCESS_TIMEOUT',
      imagePath: 'C:\\photos\\hang.jpg',
      stage: 'decode-resize',
    });

    expect(eventLoopTicked).toBe(true);
    expect(children[0].killed).toBe(true);
    await expect(supervisor.prepare({
      imagePath: 'C:\\photos\\next.jpg',
      orientation: 1,
      includeAnalysisSurface: false,
      includeDetectorTensor: false,
      includePersonTensors: false,
      testMode: 'echo',
    })).resolves.toMatchObject({ sourceWidth: 4, sourceHeight: 3 });
    expect(children.length).toBeGreaterThanOrEqual(2);
  });

  it('quarantines only the timed-out path', async () => {
    const fixture = path.join(__dirname, 'fixtures', 'hanging-preprocess-worker.cjs');
    const supervisor = new ImagePreprocessSupervisor(() => new NodeForkAdapter(fork(fixture, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'advanced',
    })) as unknown as PreprocessChild, 1, 80);
    supervisors.push(supervisor);
    const request = {
      imagePath: 'bad.jpg', orientation: 1, includeAnalysisSurface: false,
      includeDetectorTensor: false, includePersonTensors: false, testMode: 'hang' as const,
    };
    await expect(supervisor.prepare(request)).rejects.toMatchObject({ code: 'PREPROCESS_TIMEOUT' });
    const started = Date.now();
    await expect(supervisor.prepare(request)).rejects.toMatchObject({ code: 'PREPROCESS_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(30);
  });
});
