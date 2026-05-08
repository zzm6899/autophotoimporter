function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function summarizeImportScopePriority({
  selectedPathCount,
  queuedPathCount,
  importingCount,
}: {
  selectedPathCount: number;
  queuedPathCount: number;
  importingCount: number;
}): string | null {
  if (selectedPathCount <= 0 || queuedPathCount <= 0) return null;
  return `Selection overrides queue: importing ${pluralize(importingCount, 'selected file')}; ${pluralize(queuedPathCount, 'queued file')} waiting.`;
}
