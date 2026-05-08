import { describe, expect, it } from 'vitest';
import { summarizeImportScopePriority } from '../importScopeSummary';

describe('summarizeImportScopePriority', () => {
  it('warns when manual selection overrides an existing queue', () => {
    expect(summarizeImportScopePriority({
      selectedPathCount: 12,
      queuedPathCount: 48,
      importingCount: 12,
    })).toBe('Selection overrides queue: importing 12 selected files; 48 queued files waiting.');
  });

  it('uses singular labels for one selected and one queued file', () => {
    expect(summarizeImportScopePriority({
      selectedPathCount: 1,
      queuedPathCount: 1,
      importingCount: 1,
    })).toBe('Selection overrides queue: importing 1 selected file; 1 queued file waiting.');
  });

  it('stays quiet unless both a selection and queue are present', () => {
    expect(summarizeImportScopePriority({
      selectedPathCount: 0,
      queuedPathCount: 4,
      importingCount: 4,
    })).toBeNull();
    expect(summarizeImportScopePriority({
      selectedPathCount: 3,
      queuedPathCount: 0,
      importingCount: 3,
    })).toBeNull();
  });
});
