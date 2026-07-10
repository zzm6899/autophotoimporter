export interface PerformanceMetricSummary {
  count: number;
  totalMs: number;
  averageMs: number;
  maxMs: number;
  lastMs: number;
}

const metrics = new Map<string, { count: number; totalMs: number; maxMs: number; lastMs: number }>();

export function recordPerformanceMetric(name: string, durationMs: number): void {
  if (!name || !Number.isFinite(durationMs) || durationMs < 0) return;
  const current = metrics.get(name) ?? { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
  current.count++;
  current.totalMs += durationMs;
  current.maxMs = Math.max(current.maxMs, durationMs);
  current.lastMs = durationMs;
  metrics.set(name, current);
}

export async function measurePerformance<T>(name: string, task: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    return await task();
  } finally {
    recordPerformanceMetric(name, performance.now() - startedAt);
  }
}

export function getPerformanceMetrics(): Record<string, PerformanceMetricSummary> {
  return Object.fromEntries(Array.from(metrics.entries()).map(([name, value]) => [name, {
    ...value,
    totalMs: Number(value.totalMs.toFixed(1)),
    averageMs: Number((value.totalMs / value.count).toFixed(1)),
    maxMs: Number(value.maxMs.toFixed(1)),
    lastMs: Number(value.lastMs.toFixed(1)),
  }]));
}

export function resetPerformanceMetrics(): void {
  metrics.clear();
}
