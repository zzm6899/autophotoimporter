import { useEffect, useState, type ReactNode } from 'react';
import { CircleHelp, Moon, PanelLeftOpen, PanelRightOpen, Search, Settings, Sun } from 'lucide-react';
import { useAppState, useAppDispatch } from '../context/ImportContext';
import { formatSize } from '../utils/formatters';
import { BrandMark } from './BrandMark';
import type { ModelDownloadProgress } from '../../main/preload';
import { OPEN_COMMAND_PALETTE_EVENT } from './CommandPalette';
import { IconButton } from './ui';

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
    selectedSource,
    destination,
    files,
    queuedPaths,
    phase,
    ftpSyncStatus,
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

  const sourceDone = !!selectedSource;
  const reviewDone = files.length > 0;
  const outputDone = !!destination;
  const photoCount = files.filter((f) => f.type === 'photo').length;
  const videoCount = files.filter((f) => f.type === 'video').length;
  const pickedCount = files.filter((f) => f.pick === 'selected').length;
  const rejectedCount = files.filter((f) => f.pick === 'rejected').length;
  const protectedCount = files.filter((f) => f.isProtected).length;
  const faceCount = files.filter((f) => (f.faceCount ?? 0) > 0).length;
  const estimatedFaceCount = files.filter((f) => (f.faceCount ?? 0) > 0 && f.faceDetection === 'estimated').length;
  const faceGroupCount = new Set(files.map((f) => f.faceGroupId).filter(Boolean)).size;
  const blurCount = files.filter((f) => f.blurRisk === 'high' || f.blurRisk === 'medium').length;
  const analyzedCount = files.filter((f) => typeof f.reviewScore === 'number' || typeof f.subjectSharpnessScore === 'number').length;
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  const stepClass = (done: boolean, active: boolean) =>
    `flex items-center gap-1 rounded px-2 py-0.5 text-[10px] ${
      done
        ? 'bg-emerald-500/15 text-emerald-300'
        : active
          ? 'bg-blue-500/15 text-blue-300'
          : 'bg-surface-raised text-text-muted'
    }`;

  return (
    <div className="h-screen flex flex-col bg-surface text-text">
      {/* Titlebar drag region */}
      <div className="h-8 shrink-0 bg-surface-alt [-webkit-app-region:drag] relative flex items-center justify-center px-2">
        <BrandMark className="h-4 w-4 shrink-0" />
        {(!showLeftPanel || !showRightPanel) && (
          <div className="absolute left-2 flex items-center gap-1 [-webkit-app-region:no-drag]">
            {!showLeftPanel && (
              <IconButton
                icon={PanelLeftOpen}
                label="Show source panel"
                onClick={() => dispatch({ type: 'TOGGLE_LEFT_PANEL' })}
                size="xs"
              />
            )}
            {!showRightPanel && (
              <IconButton
                icon={PanelRightOpen}
                label="Show output panel"
                onClick={() => dispatch({ type: 'TOGGLE_RIGHT_PANEL' })}
                size="xs"
              />
            )}
          </div>
        )}
        <div className="absolute right-2 flex items-center gap-1 [-webkit-app-region:no-drag]">
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

      <div className="h-8 shrink-0 border-b border-border bg-surface-alt px-2 flex items-center gap-1.5 overflow-x-auto">
        <span className={stepClass(sourceDone, !sourceDone)}>
          <span className="font-mono">1</span>
          Source
        </span>
        <span className={stepClass(reviewDone, sourceDone && !reviewDone)}>
          <span className="font-mono">2</span>
          Review
          {files.length > 0 && <span className="font-mono text-text-secondary">{files.length}</span>}
        </span>
        <span className={stepClass(outputDone, reviewDone && !outputDone)}>
          <span className="font-mono">3</span>
          Destination
        </span>
        <span className={stepClass(phase === 'complete', outputDone && phase !== 'complete')}>
          <span className="font-mono">4</span>
          Import
          {queuedPaths.length > 0 && <span className="font-mono text-text-secondary">{queuedPaths.length}</span>}
        </span>
        <div className="ml-auto flex items-center gap-1.5 text-[10px] text-text-muted">
          {phase === 'scanning' && <span>Scanning...</span>}
          {phase === 'importing' && <span>Importing...</span>}
          {phase === 'complete' && <span>Done</span>}
          {ftpSyncStatus.state === 'running' && (
            <span className="flex items-center gap-1 rounded bg-blue-500/15 px-2 py-0.5 text-blue-300" title={ftpSyncStatus.message}>
              <span className="h-1.5 w-1.5 rounded-full bg-blue-300 animate-pulse" />
              FTP sync
            </span>
          )}
          {/* Face model background download indicator */}
          {modelDl && modelDl.status === 'downloading' && (
            <span className="flex items-center gap-1 rounded bg-violet-500/15 px-2 py-0.5 text-violet-300" title="Downloading face recognition models in background">
              <svg className="w-2.5 h-2.5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
              </svg>
              Face models {modelDl.percent ?? 0}%
            </span>
          )}
          {modelDl && modelDl.status === 'done' && (
            <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-emerald-300">Face models ready</span>
          )}
          {modelDl && modelDl.status === 'error' && (
            <span className="rounded bg-red-500/15 px-2 py-0.5 text-red-300" title={modelDl.error}>Face models unavailable</span>
          )}
        </div>
      </div>

      {files.length > 0 && (
        <div className="h-8 shrink-0 border-b border-border bg-surface px-2 flex items-center gap-1.5 overflow-x-auto text-[10px]">
          <span className="rounded bg-surface-raised px-2 py-0.5 text-text-secondary">
            {photoCount} photos{videoCount > 0 ? ` / ${videoCount} videos` : ''}
          </span>
          <span className="rounded bg-surface-raised px-2 py-0.5 text-text-muted">{formatSize(totalBytes)}</span>
          {pickedCount > 0 && <span className="rounded bg-yellow-500/15 px-2 py-0.5 text-yellow-300">{pickedCount} picked</span>}
          {queuedPaths.length > 0 && <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-emerald-300">{queuedPaths.length} queued</span>}
          {rejectedCount > 0 && <span className="rounded bg-red-500/15 px-2 py-0.5 text-red-300">{rejectedCount} rejected</span>}
          {protectedCount > 0 && <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-emerald-300">{protectedCount} protected</span>}
        {faceCount > 0 && <span className="rounded bg-violet-500/15 px-2 py-0.5 text-violet-300" title={estimatedFaceCount > 0 ? `${estimatedFaceCount} are estimated fallback detections` : 'Native face detections'}>{faceCount} with faces</span>}
          {faceGroupCount > 0 && <span className="rounded bg-violet-500/15 px-2 py-0.5 text-violet-300">{faceGroupCount} face groups</span>}
          {blurCount > 0 && <span className="rounded bg-orange-500/15 px-2 py-0.5 text-orange-300">{blurCount} blur risk</span>}
          <span className="ml-auto rounded bg-surface-raised px-2 py-0.5 text-text-muted">smart {analyzedCount}/{photoCount}</span>
        </div>
      )}

      <div className="flex flex-1 min-h-0 pb-7">
        {/* Left panel - Source */}
        {showLeftPanel && (
          <div className="w-44 shrink-0 border-r border-border bg-surface-alt overflow-y-auto">
            {left}
          </div>
        )}

        {/* Center panel - Thumbnails */}
        <div className="flex-1 min-w-0 overflow-hidden bg-surface">
          {center}
        </div>

        {/* Right panel - Destination + Settings */}
        {showRightPanel && (
          <div className="w-52 shrink-0 border-l border-border bg-surface-alt overflow-y-auto">
            {right}
          </div>
        )}
      </div>
    </div>
  );
}
