import { describe, expect, it } from 'vitest';
import { FaceJobScheduler } from '../face-job-scheduler';

describe('FaceJobScheduler', () => {
  it('reserves capacity for detector screens while heavy work is saturated', async () => {
    const scheduler = new FaceJobScheduler(8);
    const heavy = await Promise.all(Array.from({ length: 4 }, () => scheduler.acquire('subjects', 1)));
    const queuedHeavy = scheduler.acquire('full', 1);
    const detect = await scheduler.acquire('detect', 1);

    expect(scheduler.activeCount).toBe(5);
    expect(scheduler.queuedCount).toBe(1);

    detect();
    heavy.forEach((release) => release());
    const releaseQueued = await queuedHeavy;
    releaseQueued();
    expect(scheduler.activeCount).toBe(0);
  });

  it.each([2, 3, 4])('keeps a detector lane at a %i-slot limit', async (slots) => {
    const scheduler = new FaceJobScheduler(slots);
    const heavy = await Promise.all(
      Array.from({ length: slots - 1 }, () => scheduler.acquire('subjects', 1)),
    );
    const queuedHeavy = scheduler.acquire('full', 1);
    const detect = await scheduler.acquire('detect', 1);

    expect(scheduler.activeCount).toBe(slots);
    expect(scheduler.queuedCount).toBe(1);

    detect();
    heavy.forEach((release) => release());
    const releaseQueued = await queuedHeavy;
    releaseQueued();
    expect(scheduler.activeCount).toBe(0);
  });

  it('rejects only stale queued generations', async () => {
    const scheduler = new FaceJobScheduler(1);
    const active = await scheduler.acquire('detect', 2);
    const stale = scheduler.acquire('detect', 2);
    const current = scheduler.acquire('detect', 3);

    scheduler.cancelQueuedBeforeGeneration(3, 'stale-face-job');
    await expect(stale).rejects.toThrow('stale-face-job');
    active();
    const releaseCurrent = await current;
    releaseCurrent();
    expect(scheduler.queuedCount).toBe(0);
  });

  it('applies slot changes without oversubscribing active work', async () => {
    const scheduler = new FaceJobScheduler(3);
    const releases = await Promise.all([
      scheduler.acquire('detect', 1),
      scheduler.acquire('detect', 1),
      scheduler.acquire('detect', 1),
    ]);
    scheduler.setSlots(1);
    const waiting = scheduler.acquire('detect', 1);
    expect(scheduler.activeCount).toBe(3);
    releases[0]();
    releases[1]();
    expect(scheduler.activeCount).toBe(1);
    releases[2]();
    const releaseWaiting = await waiting;
    releaseWaiting();
    expect(scheduler.activeCount).toBe(0);
  });
});
