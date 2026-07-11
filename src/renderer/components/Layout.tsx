import { useEffect, useState, type ReactNode } from 'react';
import { CircleHelp, Moon, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Search, Settings, Sun } from 'lucide-react';
import { useAppState, useAppDispatch } from '../context/ImportContext';
import { BrandMark } from './BrandMark';
import type { ModelDownloadProgress } from '../../main/preload';
import { OPEN_COMMAND_PALETTE_EVENT } from './CommandPalette';
import { IconButton } from './ui';
import { WorkflowStepper } from './WorkflowStepper';

interface LayoutProps {
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
}

export function Layout({ left, center, right }: LayoutProps) {
  const [modelDl, setModelDl] = useState<ModelDownloadProgress | null>(null);

  useEffect(() => {
    const unsub = window.electronAPI.onFaceModelDownloadProgress((progress) => {
      // Clear the indicator a moment after completion
      setModelDl(progress);
      if (progress.status === 'done') {
        setTimeout(() => setModelDl(null), 3000);
      }
    });
    return () => {
      unsub();
    };
  }, []);

  const {
    theme,
    showLeftPanel,
    showRightPanel,
    files,
    phase,
    importRunning,
    scanPaused,
    viewMode,
    filter,
    experienceMode,
  } = useAppState();
  const dispatch = useAppDispatch();

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    dispatch({ type: 'SET_THEME', theme: next });
    window.electronAPI.setSettings({ theme: next });
  };

  const handleExperienceMode = (mode: 'simple' | 'pro') => {
    dispatch({ type: 'SET_EXPERIENCE_MODE', mode });
    void window.electronAPI.setSettings({ experienceMode: mode });
  };

  const activeFilter = filter === 'all' ? 'All photos' : filter.replace(/^face:/, 'Face ');
  const primaryStatus = phase === 'scanning'
    ? scanPaused ? 'Scan paused' : 'Scanning source'
    : importRunning
      ? 'Export running'
      : phase === 'complete'
        ? 'Import complete'
        : files.length > 0
          ? `${viewMode} · ${activeFilter}`
          : 'Ready';

  return (
    <div className="h-screen flex flex-col bg-surface text-text">
      {/* Titlebar drag region */}
      <div className="h-10 shrink-0 border-b border-border bg-surface-alt [-webkit-app-region:drag] relative flex items-center px-3">
        <div className="flex min-w-0 items-center gap-2">
          <BrandMark className="h-4 w-4 shrink-0" />
          <div className="min-w-0">
            <div className="text-xs font-semibold leading-none text-text">Keptra</div>
            <div className="mt-0.5 text-[9px] font-medium uppercase tracking-wider text-text-muted">
              {experienceMode === 'pro' ? 'Pro review workspace' : 'Simple import workflow'}
            </div>
          </div>
        </div>
        <div className="pointer-events-none absolute inset-x-0 flex justify-center">
          <span className="rounded-full border border-border bg-surface/70 px-3 py-1 text-[10px] text-text-secondary">
            {primaryStatus}
          </span>
        </div>
        <div className="absolute right-2 flex items-center gap-1 [-webkit-app-region:no-drag]">
          <div className="mr-1 inline-flex items-center gap-px rounded-md border border-border bg-surface p-0.5" aria-label="Experience mode">
            {(['simple', 'pro'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => handleExperienceMode(mode)}
                className={`rounded px-2 py-1 text-[10px] font-medium transition-colors ${
                  experienceMode === mode
                    ? 'bg-surface-raised text-text'
                    : 'text-text-muted hover:text-text-secondary'
                }`}
                title={mode === 'simple' ? 'Show the everyday card, folder, review, and import workflow.' : 'Expose FTP, watch folders, diagnostics, catalog, and advanced output controls.'}
              >
                {mode === 'simple' ? 'Simple' : 'Pro'}
              </button>
            ))}
          </div>
          <IconButton
            icon={showLeftPanel ? PanelLeftClose : PanelLeftOpen}
            label={showLeftPanel ? 'Hide source panel' : 'Show source panel'}
            onClick={() => dispatch({ type: 'TOGGLE_LEFT_PANEL' })}
            size="xs"
          />
          <IconButton
            icon={showRightPanel ? PanelRightClose : PanelRightOpen}
            label={showRightPanel ? 'Hide output inspector' : 'Show output inspector'}
            onClick={() => dispatch({ type: 'TOGGLE_RIGHT_PANEL' })}
            size="xs"
          />
          <IconButton
            icon={Search}
            label="Open command palette (Ctrl/Cmd+K)"
            onClick={() => window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT))}
            size="xs"
          />
          <IconButton
            icon={Settings}
            label="Open settings"
            onClick={() => dispatch({ type: 'SET_VIEW_MODE', mode: 'settings' })}
            active={false}
            size="xs"
          />
          <IconButton
            icon={CircleHelp}
            label="Open help and shortcuts"
            onClick={() => window.dispatchEvent(new Event('photo-importer:shortcuts'))}
            size="xs"
          />
          <IconButton
            icon={theme === 'dark' ? Sun : Moon}
            label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            onClick={toggleTheme}
            size="xs"
          />
        </div>
      </div>

      <WorkflowStepper modelDownload={modelDl} />

      <div className="flex flex-1 min-h-0 pb-7">
        {/* Left panel - Source */}
        {showLeftPanel && (
          <div className="w-[232px] shrink-0 border-r border-border bg-surface-alt overflow-y-auto">
            {left}
          </div>
        )}

        {/* Center panel - Thumbnails */}
        <div className="flex-1 min-w-0 overflow-hidden bg-surface">
          {center}
        </div>

        {/* Right panel - Destination + Settings */}
        {showRightPanel && (
          <div className="w-[320px] shrink-0 border-l border-border bg-surface-alt overflow-y-auto">
            {right}
          </div>
        )}
      </div>
    </div>
  );
}
