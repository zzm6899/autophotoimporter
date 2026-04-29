import { EventEmitter } from 'node:events';

export type JobState = 'queued' | 'running' | 'paused' | 'cancelled' | 'completed' | 'failed';

export interface JobProgress {
  current?: number;
  total?: number;
  message?: string;
  percent?: number;
  meta?: Record<string, unknown>;
}

export interface JobStatusEvent {
  jobId: string;
  state: JobState;
  progress?: JobProgress;
  error?: string;
  at: number;
}

export class JobController {
  readonly jobId: string;
  readonly abortController = new AbortController();
  private state: JobState = 'queued';
  private readonly emitter = new EventEmitter();

  constructor(jobId: string) {
    this.jobId = jobId;
    this.emit({ state: 'queued' });
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get currentState(): JobState {
    return this.state;
  }

  onStatus(listener: (event: JobStatusEvent) => void): () => void {
    this.emitter.on('status', listener);
    return () => this.emitter.off('status', listener);
  }

  queue(progress?: JobProgress): void { this.setState('queued', progress); }
  start(progress?: JobProgress): void { this.setState('running', progress); }
  pause(progress?: JobProgress): void { this.setState('paused', progress); }
  resume(progress?: JobProgress): void { this.setState('running', progress); }
  complete(progress?: JobProgress): void { this.setState('completed', progress); }
  fail(error: unknown, progress?: JobProgress): void {
    this.setState('failed', progress, error instanceof Error ? error.message : String(error));
  }
  cancel(progress?: JobProgress): void {
    if (!this.abortController.signal.aborted) this.abortController.abort();
    this.setState('cancelled', progress);
  }

  progress(progress: JobProgress): void {
    this.emit({ state: this.state, progress });
  }

  private setState(state: JobState, progress?: JobProgress, error?: string): void {
    this.state = state;
    this.emit({ state, progress, error });
  }

  private emit(payload: { state: JobState; progress?: JobProgress; error?: string }): void {
    this.emitter.emit('status', {
      jobId: this.jobId,
      state: payload.state,
      progress: payload.progress,
      error: payload.error,
      at: Date.now(),
    } satisfies JobStatusEvent);
  }
}
