import type { FaceAnalysisProfile } from './face-engine';

type Release = () => void;

interface WaitingJob {
  profile: FaceAnalysisProfile;
  generation: number;
  resolve: (release: Release) => void;
  reject: (error: Error) => void;
}

/**
 * Admission control for whole-photo work.
 *
 * Detector-only work has a reserved fast lane, while person/pose-capable jobs
 * share a smaller heavy-work budget. This prevents a batch of CPU-person jobs
 * from occupying every slot while queued DML face screens sit idle.
 */
export class FaceJobScheduler {
  private maxActive: number;
  private active = 0;
  private activeHeavy = 0;
  private queues: Record<FaceAnalysisProfile, WaitingJob[]> = {
    detect: [],
    subjects: [],
    full: [],
  };
  private nextQueue = 0;

  constructor(maxActive: number) {
    this.maxActive = FaceJobScheduler.clampSlots(maxActive);
  }

  static clampSlots(value: number): number {
    return Math.max(1, Math.min(16, Math.round(Number.isFinite(value) ? value : 1)));
  }

  get activeCount(): number { return this.active; }
  get queuedCount(): number {
    return this.queues.detect.length + this.queues.subjects.length + this.queues.full.length;
  }
  get slots(): number { return this.maxActive; }

  setSlots(value: number): void {
    this.maxActive = FaceJobScheduler.clampSlots(value);
    this.drain();
  }

  acquire(profile: FaceAnalysisProfile, generation: number): Promise<Release> {
    return new Promise<Release>((resolve, reject) => {
      this.queues[profile].push({ profile, generation, resolve, reject });
      this.drain();
    });
  }

  cancelQueuedBeforeGeneration(generation: number, message: string): void {
    for (const profile of ['detect', 'subjects', 'full'] as const) {
      const retained: WaitingJob[] = [];
      for (const job of this.queues[profile]) {
        if (job.generation < generation) job.reject(new Error(message));
        else retained.push(job);
      }
      this.queues[profile] = retained;
    }
    this.drain();
  }

  private heavyLimit(): number {
    // Decode can overlap with the serialized CPU person stage, but allowing a
    // dozen heavy jobs only creates head-of-line pressure on a 16-thread CPU.
    // Keep one slot available for the detector fast lane even on conservative
    // 2-4 slot configurations. A single-slot configuration necessarily shares
    // that slot between all profiles.
    if (this.maxActive <= 1) return 1;
    return Math.min(this.maxActive - 1, 4);
  }

  private canStart(profile: FaceAnalysisProfile): boolean {
    if (this.active >= this.maxActive) return false;
    return profile === 'detect' || this.activeHeavy < this.heavyLimit();
  }

  private takeNext(): WaitingJob | undefined {
    // Weighted round robin gives detector screening two turns without starving
    // enrichment. Heavy jobs are still bounded independently.
    const order: FaceAnalysisProfile[] = ['detect', 'subjects', 'detect', 'full'];
    for (let offset = 0; offset < order.length; offset++) {
      const index = (this.nextQueue + offset) % order.length;
      const profile = order[index];
      if (this.queues[profile].length === 0 || !this.canStart(profile)) continue;
      this.nextQueue = (index + 1) % order.length;
      return this.queues[profile].shift();
    }
    return undefined;
  }

  private drain(): void {
    while (this.active < this.maxActive) {
      const job = this.takeNext();
      if (!job) return;
      this.active++;
      if (job.profile !== 'detect') this.activeHeavy++;
      let released = false;
      job.resolve(() => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
        if (job.profile !== 'detect') this.activeHeavy = Math.max(0, this.activeHeavy - 1);
        this.drain();
      });
    }
  }
}
