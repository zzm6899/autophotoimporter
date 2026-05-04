import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  BadgeHelp,
  CheckCircle2,
  ClipboardCheck,
  Copy,
  Download,
  Eye,
  FileSearch,
  Filter,
  FolderOpen,
  Grid2X2,
  HardDrive,
  Image,
  KeyRound,
  ListChecks,
  Moon,
  PanelLeft,
  PanelRight,
  Pause,
  Play,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  Sun,
  Tag,
  Trash2,
  UploadCloud,
  Wand2,
  XCircle,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useAppDispatch, useAppState } from '../context/ImportContext';
import type { FilterMode } from '../context/ImportContext';
import { useFileScanner } from '../hooks/useFileScanner';
import { useImport } from '../hooks/useImport';

export const OPEN_COMMAND_PALETTE_EVENT = 'photo-importer:command-palette';
export const REVIEW_COMMAND_EVENT = 'photo-importer:review-command';

export type CommandDangerLevel = 'safe' | 'bulk' | 'destructive';

export interface CommandItem {
  id: string;
  label: string;
  group: string;
  description?: string;
  keywords?: string[];
  shortcut?: string;
  icon?: LucideIcon;
  danger?: CommandDangerLevel;
  disabledReason?: string;
  confirmMessage?: string;
  run?: () => void | Promise<void>;
}

export interface CommandBuildContext {
  phase: 'idle' | 'scanning' | 'ready' | 'importing' | 'complete';
  scanPaused: boolean;
  fileCount: number;
  photoCount: number;
  selectedSource?: string | null;
  destination?: string | null;
  queuedCount: number;
  selectedCount: number;
  focused: boolean;
  filter: string;
  theme: 'light' | 'dark';
  showLeftPanel: boolean;
  showRightPanel: boolean;
  licenseValid: boolean;
  platform: string;
}

const MOD = typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin' ? 'Cmd' : 'Ctrl';

const reviewEvent = (id: string) => () => {
  window.dispatchEvent(new CustomEvent(REVIEW_COMMAND_EVENT, { detail: { id } }));
};

export function commandNeedsConfirmation(command: CommandItem): boolean {
  return !!command.confirmMessage || command.danger === 'bulk' || command.danger === 'destructive';
}

export function commandSearchText(command: CommandItem): string {
  return [
    command.group,
    command.label,
    command.description,
    command.shortcut,
    ...(command.keywords ?? []),
  ].filter(Boolean).join(' ').toLowerCase();
}

export function filterCommandItems(commands: CommandItem[], query: string): CommandItem[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return commands;
  const terms = normalized.split(/\s+/).filter(Boolean);
  return commands
    .map((command, index) => {
      const haystack = commandSearchText(command);
      if (!terms.every((term) => haystack.includes(term))) return null;
      const label = command.label.toLowerCase();
      const group = command.group.toLowerCase();
      const score =
        (label === normalized ? 0 : label.startsWith(normalized) ? 1 : group.includes(normalized) ? 2 : 3) +
        (command.disabledReason ? 0.4 : 0) +
        index / 1000;
      return { command, score };
    })
    .filter((item): item is { command: CommandItem; score: number } => !!item)
    .sort((a, b) => a.score - b.score)
    .map((item) => item.command);
}

export function buildCommandItems(
  context: CommandBuildContext,
  handlers: Partial<Record<string, () => void | Promise<void>>> = {},
): CommandItem[] {
  const busy = context.phase === 'scanning' || context.phase === 'importing';
  const needsFiles = context.fileCount === 0 ? 'Scan a source first.' : undefined;
  const needsPhoto = context.photoCount === 0 ? 'Scan photos first.' : undefined;
  const needsFocus = !context.focused ? 'Focus a photo first.' : undefined;
  const needsDestination = !context.destination ? 'Choose a destination first.' : undefined;
  const busyReason = busy ? 'Wait for the current scan or import to finish.' : undefined;
  const importingReason = context.phase === 'importing' ? 'Import is already running.' : undefined;
  const queueReason = context.queuedCount === 0 ? 'Queue files first.' : undefined;
  const commands: CommandItem[] = [
    {
      id: 'source.choose-folder',
      group: 'Source',
      label: 'Choose Source Folder',
      description: 'Select a folder and scan it.',
      icon: FolderOpen,
      disabledReason: busyReason,
      run: handlers['source.choose-folder'],
    },
    {
      id: 'source.rescan',
      group: 'Source',
      label: 'Rescan Current Source',
      shortcut: 'R',
      icon: RefreshCw,
      disabledReason: busyReason || (!context.selectedSource ? 'Choose a source first.' : undefined),
      run: handlers['source.rescan'],
    },
    {
      id: 'source.drive',
      group: 'Source',
      label: 'Use Drive / SD Source',
      icon: HardDrive,
      disabledReason: busyReason,
      run: handlers['source.drive'],
    },
    {
      id: 'source.ftp',
      group: 'Source',
      label: 'Use FTP Source',
      icon: UploadCloud,
      disabledReason: busyReason,
      run: handlers['source.ftp'],
    },
    {
      id: context.scanPaused ? 'scan.resume' : 'scan.pause',
      group: 'Source',
      label: context.scanPaused ? 'Resume Scan' : 'Pause Scan',
      icon: context.scanPaused ? Play : Pause,
      disabledReason: context.phase !== 'scanning' ? 'No scan is running.' : undefined,
      run: handlers[context.scanPaused ? 'scan.resume' : 'scan.pause'],
    },
    {
      id: 'destination.choose',
      group: 'Destination',
      label: 'Choose Destination Folder',
      icon: FolderOpen,
      run: handlers['destination.choose'],
    },
    {
      id: 'destination.open',
      group: 'Destination',
      label: 'Open Destination Folder',
      icon: FolderOpen,
      disabledReason: !context.destination ? 'Choose a destination first.' : undefined,
      run: handlers['destination.open'],
    },
    {
      id: 'destination.fast-raw-ingest',
      group: 'Destination',
      label: 'Apply Fastest Raw Ingest Settings',
      description: 'Original files, no checksum, no backup/FTP, no conversion, no duplicate checks.',
      icon: Zap,
      run: handlers['destination.fast-raw-ingest'],
    },
    {
      id: 'view.grid',
      group: 'View',
      label: 'Grid View',
      icon: Grid2X2,
      disabledReason: needsFiles,
      run: handlers['view.grid'],
    },
    {
      id: 'view.single',
      group: 'View',
      label: 'Single Photo View',
      icon: Image,
      disabledReason: needsFiles,
      run: handlers['view.single'],
    },
    {
      id: 'view.split',
      group: 'View',
      label: 'Split Review View',
      icon: FileSearch,
      disabledReason: needsFiles,
      run: handlers['view.split'],
    },
    {
      id: 'view.compare',
      group: 'View',
      label: 'Compare View',
      icon: Eye,
      disabledReason: needsFiles,
      run: handlers['view.compare'],
    },
    {
      id: 'view.back',
      group: 'View',
      label: 'Back / Clear Current View',
      shortcut: 'Esc',
      icon: ArrowLeft,
      disabledReason: context.fileCount === 0 && context.filter === 'all' ? 'Nothing to go back from.' : undefined,
      run: handlers['view.back'],
    },
    {
      id: 'filter.all',
      group: 'Filters',
      label: 'Show All Photos',
      icon: Filter,
      disabledReason: needsFiles,
      run: handlers['filter.all'],
    },
    {
      id: 'filter.unmarked',
      group: 'Filters',
      label: 'Show Unmarked',
      icon: Filter,
      disabledReason: needsFiles,
      run: handlers['filter.unmarked'],
    },
    {
      id: 'filter.queue',
      group: 'Filters',
      label: `Show Queue (${context.queuedCount})`,
      icon: ClipboardCheck,
      disabledReason: queueReason,
      run: handlers['filter.queue'],
    },
    {
      id: 'filter.blur',
      group: 'Filters',
      label: 'Show Blur Risk',
      icon: AlertTriangle,
      disabledReason: needsPhoto,
      run: handlers['filter.blur'],
    },
    {
      id: 'filter.face-groups',
      group: 'Filters',
      label: 'Show Similar Face Groups',
      icon: Filter,
      disabledReason: needsPhoto,
      run: handlers['filter.face-groups'],
    },
    {
      id: 'filter.duplicates',
      group: 'Filters',
      label: 'Show Similar / Duplicate Photos',
      icon: Copy,
      disabledReason: needsPhoto,
      run: handlers['filter.duplicates'],
    },
    {
      id: 'filter.clear-search',
      group: 'Filters',
      label: 'Clear Search and Filters',
      icon: XCircle,
      disabledReason: needsFiles,
      run: handlers['filter.clear-search'],
    },
    {
      id: 'review.start',
      group: 'Review',
      label: 'Start Review Sprint',
      shortcut: 'Enter',
      icon: ListChecks,
      disabledReason: needsFiles,
      run: handlers['review.start'],
    },
    {
      id: 'review.pick',
      group: 'Review',
      label: context.selectedCount > 0 ? `Pick ${context.selectedCount} Selected` : 'Pick Focused Photo',
      shortcut: 'P',
      icon: CheckCircle2,
      disabledReason: needsFocus,
      run: handlers['review.pick'],
    },
    {
      id: 'review.reject',
      group: 'Review',
      label: context.selectedCount > 0 ? `Reject ${context.selectedCount} Selected` : 'Reject Focused Photo',
      shortcut: 'X',
      icon: XCircle,
      danger: context.selectedCount > 1 ? 'bulk' : 'safe',
      confirmMessage: context.selectedCount > 1 ? `Reject ${context.selectedCount} selected photos?` : undefined,
      disabledReason: needsFocus,
      run: handlers['review.reject'],
    },
    {
      id: 'review.clear',
      group: 'Review',
      label: 'Clear Pick / Reject Flag',
      shortcut: 'U',
      icon: Tag,
      disabledReason: needsFocus,
      run: handlers['review.clear'],
    },
    {
      id: 'review.sync-edits',
      group: 'Review',
      label: 'Sync Focused Edit Recipe',
      description: 'Apply focused exposure and white-balance adjustments to the selected set or matching burst/group.',
      icon: Copy,
      danger: context.selectedCount > 1 ? 'bulk' : 'safe',
      confirmMessage: context.selectedCount > 1 ? `Sync edit recipe to ${context.selectedCount} selected files?` : undefined,
      disabledReason: needsFocus,
      run: handlers['review.sync-edits'],
    },
    ...[5, 4, 3, 2, 1, 0].map((rating) => ({
      id: `review.rating-${rating}`,
      group: 'Review',
      label: rating === 0 ? 'Clear Star Rating' : `Set ${rating} Star${rating === 1 ? '' : 's'}`,
      shortcut: String(rating),
      icon: Star,
      disabledReason: needsFocus,
      run: handlers[`review.rating-${rating}`],
    } satisfies CommandItem)),
    {
      id: 'selection.select-visible',
      group: 'Selection',
      label: 'Select All Visible',
      shortcut: `${MOD}+A`,
      icon: ListChecks,
      disabledReason: needsFiles,
      run: handlers['selection.select-visible'],
    },
    {
      id: 'selection.clear',
      group: 'Selection',
      label: 'Clear Selection',
      icon: XCircle,
      disabledReason: context.selectedCount === 0 ? 'No selected photos.' : undefined,
      run: handlers['selection.clear'],
    },
    {
      id: 'queue.keepers',
      group: 'Queue',
      label: 'Queue Keepers',
      icon: ClipboardCheck,
      disabledReason: busyReason || needsPhoto,
      run: handlers['queue.keepers'],
    },
    {
      id: 'queue.visible',
      group: 'Queue',
      label: 'Queue Visible Photos',
      icon: ClipboardCheck,
      danger: 'bulk',
      confirmMessage: 'Queue every currently visible file?',
      disabledReason: busyReason || needsFiles,
      run: handlers['queue.visible'],
    },
    {
      id: 'queue.clear',
      group: 'Queue',
      label: `Clear Queue (${context.queuedCount})`,
      icon: Trash2,
      danger: 'destructive',
      confirmMessage: `Clear all ${context.queuedCount} queued files?`,
      disabledReason: busyReason || queueReason,
      run: handlers['queue.clear'],
    },
    {
      id: 'import.queue',
      group: 'Import',
      label: `Import Queue (${context.queuedCount})`,
      icon: Download,
      disabledReason: importingReason || queueReason || needsDestination,
      run: handlers['import.queue'],
    },
    {
      id: 'import.visible',
      group: 'Import',
      label: 'Import Visible Files',
      icon: Download,
      danger: 'bulk',
      confirmMessage: 'Import every currently visible file?',
      disabledReason: importingReason || needsFiles || needsDestination,
      run: handlers['import.visible'],
    },
    {
      id: 'ai.toggle',
      group: 'AI Review',
      label: 'Pause / Resume AI Review',
      icon: Sparkles,
      disabledReason: needsPhoto,
      run: handlers['ai.toggle'],
    },
    {
      id: 'ai.overview',
      group: 'AI Review',
      label: 'Show AI Overview',
      icon: Sparkles,
      disabledReason: needsPhoto,
      run: handlers['ai.overview'],
    },
    {
      id: 'best.burst',
      group: 'AI Review',
      label: 'Best of Focused Burst / Selection',
      shortcut: 'Shift+B',
      icon: Wand2,
      disabledReason: needsFocus,
      run: handlers['best.burst'],
    },
    {
      id: 'best.batch',
      group: 'AI Review',
      label: 'Best of Batch',
      icon: Wand2,
      disabledReason: needsPhoto,
      run: handlers['best.batch'],
    },
    {
      id: 'bulk.safe-cull',
      group: 'Bulk Actions',
      label: 'Safe Cull Grouped Photos',
      icon: ShieldCheck,
      danger: 'bulk',
      confirmMessage: 'Auto-reject clearly worse grouped alternatives? Protected, starred, and picked files are preserved.',
      disabledReason: needsPhoto,
      run: handlers['bulk.safe-cull'],
    },
    {
      id: 'bulk.pick-burst-best',
      group: 'Bulk Actions',
      label: 'Pick Burst Best and Reject Alternates',
      icon: ShieldCheck,
      danger: 'bulk',
      confirmMessage: 'Pick the top shot in each burst/group and reject alternates?',
      disabledReason: needsPhoto,
      run: handlers['bulk.pick-burst-best'],
    },
    {
      id: 'bulk.pick-visible',
      group: 'Bulk Actions',
      label: 'Pick Visible Files',
      icon: CheckCircle2,
      danger: 'bulk',
      confirmMessage: 'Pick every currently visible file?',
      disabledReason: needsFiles,
      run: handlers['bulk.pick-visible'],
    },
    {
      id: 'bulk.reject-visible',
      group: 'Bulk Actions',
      label: 'Reject Visible Files',
      icon: XCircle,
      danger: 'bulk',
      confirmMessage: 'Reject every currently visible file?',
      disabledReason: needsFiles,
      run: handlers['bulk.reject-visible'],
    },
    {
      id: 'bulk.clear-visible',
      group: 'Bulk Actions',
      label: 'Clear Visible Flags',
      icon: Tag,
      danger: 'bulk',
      confirmMessage: 'Clear pick/reject flags on every currently visible file?',
      disabledReason: needsFiles,
      run: handlers['bulk.clear-visible'],
    },
    {
      id: 'bulk.reject-blur',
      group: 'Bulk Actions',
      label: 'Reject High Blur-Risk Files',
      icon: AlertTriangle,
      danger: 'bulk',
      confirmMessage: 'Reject high blur-risk files that are not already picked?',
      disabledReason: needsPhoto,
      run: handlers['bulk.reject-blur'],
    },
    {
      id: 'settings.open',
      group: 'System',
      label: 'Open Settings',
      shortcut: `${MOD}+,`,
      icon: Settings,
      run: handlers['settings.open'],
    },
    {
      id: 'help.open',
      group: 'System',
      label: 'Open Help Center',
      icon: BadgeHelp,
      run: handlers['help.open'],
    },
    {
      id: 'help.tutorial',
      group: 'System',
      label: 'Show Guided Tutorial',
      icon: BadgeHelp,
      run: handlers['help.tutorial'],
    },
    {
      id: 'license.open',
      group: 'System',
      label: context.licenseValid ? 'Manage License in App' : 'Activate License',
      icon: KeyRound,
      run: handlers['license.open'],
    },
    {
      id: 'license.manage-online',
      group: 'System',
      label: 'Manage License Online',
      icon: KeyRound,
      run: handlers['license.manage-online'],
    },
    {
      id: 'updates.check',
      group: 'System',
      label: 'Check for Updates',
      icon: RefreshCw,
      run: handlers['updates.check'],
    },
    {
      id: 'theme.toggle',
      group: 'System',
      label: context.theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode',
      icon: context.theme === 'dark' ? Sun : Moon,
      run: handlers['theme.toggle'],
    },
    {
      id: 'panel.left',
      group: 'System',
      label: context.showLeftPanel ? 'Hide Source Panel' : 'Show Source Panel',
      icon: PanelLeft,
      run: handlers['panel.left'],
    },
    {
      id: 'panel.right',
      group: 'System',
      label: context.showRightPanel ? 'Hide Output Panel' : 'Show Output Panel',
      icon: PanelRight,
      run: handlers['panel.right'],
    },
  ];

  return commands;
}

export function CommandPalette() {
  const dispatch = useAppDispatch();
  const {
    phase,
    scanPaused,
    files,
    selectedSource,
    destination,
    queuedPaths,
    selectedPaths,
    focusedIndex,
    focusedPath,
    filter,
    theme,
    showLeftPanel,
    showRightPanel,
    licenseStatus,
  } = useAppState();
  const { startScan, pauseScan, resumeScan } = useFileScanner();
  const { startImport } = useImport();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const photoCount = files.filter((file) => file.type === 'photo').length;
  const focused = selectedPaths.length > 0 || focusedIndex >= 0 || !!focusedPath;

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  const runReview = (id: string) => reviewEvent(id)();
  const setFilter = (next: FilterMode) => {
    if (next === 'face-groups') dispatch({ type: 'GROUP_FACE_SIMILAR', threshold: 10 });
    if (next === 'near-duplicates') dispatch({ type: 'GROUP_VISUAL_DUPLICATES', threshold: 8 });
    dispatch({ type: 'SET_FILTER', filter: next });
  };

  const handlers = useMemo<Partial<Record<string, () => void | Promise<void>>>>(() => ({
    'source.choose-folder': async () => {
      const folder = await window.electronAPI.selectFolder('Select Source Folder');
      if (!folder) return;
      dispatch({ type: 'SET_SOURCE_KIND', kind: 'volume' });
      dispatch({ type: 'SELECT_SOURCE', path: folder });
      await startScan(folder);
    },
    'source.rescan': () => startScan(),
    'source.drive': () => dispatch({ type: 'SET_SOURCE_KIND', kind: 'volume' }),
    'source.ftp': () => dispatch({ type: 'SET_SOURCE_KIND', kind: 'ftp' }),
    'scan.pause': () => pauseScan(),
    'scan.resume': () => resumeScan(),
    'destination.choose': async () => {
      const folder = await window.electronAPI.selectFolder('Select Destination Folder');
      if (!folder) return;
      dispatch({ type: 'SET_DESTINATION', path: folder });
      await window.electronAPI.setSettings({ lastDestination: folder });
    },
    'destination.open': () => {
      if (destination) void window.electronAPI.openPath(destination);
    },
    'destination.fast-raw-ingest': async () => {
      dispatch({ type: 'SET_SAVE_FORMAT', format: 'original' });
      dispatch({ type: 'SET_SKIP_DUPLICATES', value: false });
      dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'verifyChecksums', value: false });
      dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'ftpDestEnabled', value: false });
      dispatch({ type: 'SET_WORKFLOW_STRING', key: 'backupDestRoot', value: '' });
      dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'normalizeExposure', value: false });
      dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'autoStraighten', value: false });
      dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'watermarkEnabled', value: false });
      await window.electronAPI.setSettings({
        saveFormat: 'original',
        skipDuplicates: false,
        verifyChecksums: false,
        ftpDestEnabled: false,
        backupDestRoot: '',
        normalizeExposure: false,
        autoStraighten: false,
        watermarkEnabled: false,
      });
    },
    'view.grid': () => dispatch({ type: 'SET_VIEW_MODE', mode: 'grid' }),
    'view.single': () => runReview('view.single'),
    'view.split': () => runReview('view.split'),
    'view.compare': () => runReview('view.compare'),
    'view.back': () => runReview('view.back'),
    'filter.all': () => setFilter('all'),
    'filter.unmarked': () => setFilter('unmarked'),
    'filter.queue': () => setFilter('queue'),
    'filter.blur': () => setFilter('blur-risk'),
    'filter.face-groups': () => setFilter('face-groups'),
    'filter.duplicates': () => {
      setFilter('near-duplicates');
      dispatch({ type: 'SET_VIEW_MODE', mode: 'compare' });
    },
    'filter.clear-search': () => runReview('filter.clear-search'),
    'review.start': () => runReview('review.start'),
    'review.pick': () => runReview('review.pick'),
    'review.reject': () => runReview('review.reject'),
    'review.clear': () => runReview('review.clear'),
    'review.sync-edits': () => runReview('review.sync-edits'),
    'review.rating-5': () => runReview('review.rating-5'),
    'review.rating-4': () => runReview('review.rating-4'),
    'review.rating-3': () => runReview('review.rating-3'),
    'review.rating-2': () => runReview('review.rating-2'),
    'review.rating-1': () => runReview('review.rating-1'),
    'review.rating-0': () => runReview('review.rating-0'),
    'selection.select-visible': () => runReview('selection.select-visible'),
    'selection.clear': () => runReview('selection.clear'),
    'queue.keepers': () => runReview('queue.keepers'),
    'queue.visible': () => runReview('queue.visible'),
    'queue.clear': () => dispatch({ type: 'QUEUE_CLEAR' }),
    'import.queue': () => startImport({ selectedPathsOverride: queuedPaths }),
    'import.visible': () => runReview('import.visible'),
    'ai.toggle': () => runReview('ai.toggle'),
    'ai.overview': () => runReview('ai.overview'),
    'best.burst': () => runReview('best.burst'),
    'best.batch': () => runReview('best.batch'),
    'bulk.safe-cull': () => runReview('bulk.safe-cull'),
    'bulk.pick-burst-best': () => runReview('bulk.pick-burst-best'),
    'bulk.pick-visible': () => runReview('bulk.pick-visible'),
    'bulk.reject-visible': () => runReview('bulk.reject-visible'),
    'bulk.clear-visible': () => runReview('bulk.clear-visible'),
    'bulk.reject-blur': () => runReview('bulk.reject-blur'),
    'settings.open': () => { dispatch({ type: 'SET_VIEW_MODE', mode: 'settings' }); },
    'help.open': () => { window.dispatchEvent(new Event('photo-importer:shortcuts')); },
    'help.tutorial': () => { window.dispatchEvent(new Event('photo-importer:tutorial')); },
    'license.open': () => { dispatch({ type: 'OPEN_LICENSE_PROMPT' }); },
    'license.manage-online': async () => { await window.electronAPI.openExternal('https://keptra.z2hs.au/manage-license'); },
    'updates.check': async () => { await window.electronAPI.checkForUpdates(); },
    'theme.toggle': () => {
      const next = theme === 'dark' ? 'light' : 'dark';
      dispatch({ type: 'SET_THEME', theme: next });
      void window.electronAPI.setSettings({ theme: next });
    },
    'panel.left': () => { dispatch({ type: 'TOGGLE_LEFT_PANEL' }); },
    'panel.right': () => { dispatch({ type: 'TOGGLE_RIGHT_PANEL' }); },
  }), [destination, dispatch, pauseScan, queuedPaths, resumeScan, setFilter, startImport, startScan, theme]);

  const commands = useMemo(() => buildCommandItems({
    phase,
    scanPaused,
    fileCount: files.length,
    photoCount,
    selectedSource,
    destination,
    queuedCount: queuedPaths.length,
    selectedCount: selectedPaths.length,
    focused,
    filter,
    theme,
    showLeftPanel,
    showRightPanel,
    licenseValid: !!licenseStatus?.valid,
    platform: window.electronAPI.platform,
  }, handlers), [
    destination,
    files.length,
    filter,
    focused,
    handlers,
    licenseStatus?.valid,
    phase,
    photoCount,
    queuedPaths.length,
    scanPaused,
    selectedPaths.length,
    selectedSource,
    showLeftPanel,
    showRightPanel,
    theme,
  ]);
  const visibleCommands = useMemo(() => filterCommandItems(commands, query), [commands, query]);
  const activeCommand = visibleCommands[Math.min(activeIndex, Math.max(0, visibleCommands.length - 1))];

  useEffect(() => {
    if (activeIndex >= visibleCommands.length) setActiveIndex(Math.max(0, visibleCommands.length - 1));
  }, [activeIndex, visibleCommands.length]);

  if (!open) return null;

  const execute = async (command: CommandItem | undefined) => {
    if (!command || command.disabledReason) return;
    if (commandNeedsConfirmation(command)) {
      const message = command.confirmMessage ?? `Run "${command.label}"?`;
      if (!window.confirm(message)) return;
    }
    setOpen(false);
    await command.run?.();
  };

  return (
    <div
      className="fixed inset-0 z-[90] bg-black/55 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div className="mx-auto mt-[9vh] w-[min(720px,calc(100vw-32px))] overflow-hidden rounded-xl border border-border bg-surface shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border bg-surface-alt px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setOpen(false);
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveIndex((value) => Math.min(value + 1, visibleCommands.length - 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveIndex((value) => Math.max(value - 1, 0));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                void execute(activeCommand);
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-text-muted"
            placeholder="Search actions, views, filters, imports, settings..."
          />
          <span className="rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] text-text-muted">{MOD}+K</span>
        </div>
        <div className="max-h-[58vh] overflow-y-auto py-1">
          {visibleCommands.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-text-muted">No matching commands</div>
          ) : (
            visibleCommands.map((command, index) => {
              const Icon = command.icon;
              const active = index === activeIndex;
              const dangerClass = command.danger === 'destructive'
                ? 'text-red-300'
                : command.danger === 'bulk'
                  ? 'text-yellow-300'
                  : 'text-text-secondary';
              return (
                <button
                  key={command.id}
                  type="button"
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => void execute(command)}
                  className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors ${
                    active ? 'bg-surface-raised' : 'hover:bg-surface-alt'
                  } ${command.disabledReason ? 'opacity-55' : ''}`}
                >
                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-alt ${dangerClass}`}>
                    {Icon && <Icon className="h-4 w-4" aria-hidden="true" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className={`truncate text-sm font-medium ${command.disabledReason ? 'text-text-muted' : 'text-text'}`}>{command.label}</span>
                      {command.danger === 'destructive' && <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[9px] font-medium text-red-300">Danger</span>}
                      {command.danger === 'bulk' && <span className="rounded bg-yellow-500/15 px-1.5 py-0.5 text-[9px] font-medium text-yellow-300">Bulk</span>}
                    </span>
                    <span className="mt-0.5 flex min-w-0 items-center gap-2 text-[10px] text-text-muted">
                      <span className="shrink-0">{command.group}</span>
                      {command.disabledReason ? <span className="truncate text-yellow-300">{command.disabledReason}</span> : command.description && <span className="truncate">{command.description}</span>}
                    </span>
                  </span>
                  {command.shortcut && <span className="shrink-0 rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] text-text-muted">{command.shortcut}</span>}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
