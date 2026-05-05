import { describe, expect, it } from 'vitest';
import {
  buildCommandItems,
  commandNeedsConfirmation,
  filterCommandItems,
  type CommandBuildContext,
} from '../CommandPalette';

const baseContext: CommandBuildContext = {
  phase: 'ready',
  scanPaused: false,
  fileCount: 120,
  photoCount: 118,
  selectedSource: 'D:\\DCIM',
  destination: 'E:\\Import',
  queuedCount: 12,
  selectedCount: 0,
  focused: true,
  filter: 'all',
  theme: 'dark',
  showLeftPanel: true,
  showRightPanel: true,
  licenseValid: true,
  platform: 'win32',
};

describe('CommandPalette command helpers', () => {
  it('ranks direct label matches before loose keyword matches', () => {
    const commands = buildCommandItems(baseContext);
    const labels = filterCommandItems(commands, 'queue').slice(0, 4).map((command) => command.label);

    expect(labels[0]).toContain('Queue');
    expect(labels).toContain('Queue Keepers');
  });

  it('shows disabled reasons for commands that cannot run yet', () => {
    const commands = buildCommandItems({
      ...baseContext,
      phase: 'idle',
      fileCount: 0,
      photoCount: 0,
      selectedSource: null,
      destination: null,
      queuedCount: 0,
      focused: false,
    });

    expect(commands.find((command) => command.id === 'review.pick')?.disabledReason).toBe('Focus a photo first.');
    expect(commands.find((command) => command.id === 'import.queue')?.disabledReason).toBe('Queue files first.');
    expect(commands.find((command) => command.id === 'source.rescan')?.disabledReason).toBe('Choose a source first.');
  });

  it('exposes group photo review through people and everyone-good search terms', () => {
    const commands = buildCommandItems(baseContext);
    const peopleMatch = filterCommandItems(commands, 'group photos')[0];
    const everyoneMatch = filterCommandItems(commands, 'everyone good')[0];

    expect(peopleMatch?.id).toBe('filter.group-photos');
    expect(everyoneMatch?.id).toBe('filter.group-photos');
  });

  it('marks bulk and destructive commands as confirmation-gated', () => {
    const commands = buildCommandItems(baseContext);

    expect(commandNeedsConfirmation(commands.find((command) => command.id === 'queue.visible')!)).toBe(true);
    expect(commandNeedsConfirmation(commands.find((command) => command.id === 'queue.clear')!)).toBe(true);
    expect(commandNeedsConfirmation(commands.find((command) => command.id === 'review.pick')!)).toBe(false);
  });
});
