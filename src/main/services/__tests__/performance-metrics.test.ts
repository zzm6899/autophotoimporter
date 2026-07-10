import { beforeEach, describe, expect, it } from 'vitest';
import { getPerformanceMetrics, measurePerformance, recordPerformanceMetric, resetPerformanceMetrics } from '../performance-metrics';

describe('performance metrics', () => {
  beforeEach(() => resetPerformanceMetrics());

  it('summarizes local operation timings', () => {
    recordPerformanceMetric('preview.detail', 10);
    recordPerformanceMetric('preview.detail', 30);
    expect(getPerformanceMetrics()['preview.detail']).toMatchObject({ count: 2, averageMs: 20, maxMs: 30, lastMs: 30 });
  });

  it('records rejected operations as well as successful ones', async () => {
    await expect(measurePerformance('catalog.browse', async () => { throw new Error('failed'); })).rejects.toThrow('failed');
    expect(getPerformanceMetrics()['catalog.browse'].count).toBe(1);
  });
});
