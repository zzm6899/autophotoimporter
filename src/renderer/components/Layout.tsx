import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, CircleHelp, Download, FolderOpen, Gauge, Images, Moon, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Search, Settings, Sun } from 'lucide-react';
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

type WorkflowStepTone = 'done' | 'active' | 'idle' | 'blocked';

function workflowToneClass(tone: WorkflowStepTone): string {
  if (tone === 'done') return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300';
  if (tone === 'active') return 'border-blue-500/35 bg-blue-500/15 text-blue-300';
  if (tone === 'blocked') return 'border-yellow-500/30 bg-yellow-500/10 text-yellow-300';
  return 'border-border bg-surface-raised/70 text-text-muted';
}

function WorkflowTile({
  index,
  label,
  value,
  icon: Icon,
  tone,
}: {
  index: number;
  label: string;
  value: string;
  icon: typeof FolderOpen;
  tone: WorkflowStepTone;
}) {
  return (
    <div className={`min-w-[9.5rem] rounded-md border px-2.5 py-1.5 ${workflowToneClass(tone)}`}>
      <div className="flex items-center gap-2">
        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-black/10 text-current">
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <div className="text-[9px] font-semibold uppercase tracking-wider opacity-75">{index} · {label}</div>
          <div className="truncate text-[11px] font-medium">{value}</div>
        </div>
      </div>
    </div>
  );
}

function HealthPill({ tone, children, title }: { tone: WorkflowStepTone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-medium ${workflowToneClass(tone)}`}>
      {children}
    </span>
  );
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
    selectedPaths,
    phase,
    scanPaused,
    ftpSyncStatus,
    viewMode,
    filter,
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
  const reviewPct = photoCount > 0 ? Math.round((analyzedCount / photoCount) * 100) : 0;
  const reviewLeft = Math.max(0, photoCount - analyzedCount);
  const activeFilter = filter === 'all' ? 'All photos' : filter.replace(/^face:/, 'Face ');
  const importReady = outputDone && (queuedPaths.length > 0 || pickedCount > 0 || files.length > 0);
  const primaryStatus = phase === 'scanning'
    ? scanPaused ? 'Scan paused' : 'Scanning source'
    : phase === 'importing'
      ? 'Import running'
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
            <div className="mt-0.5 text-[9px] font-medium uppercase tracking-wider text-text-muted">V2 review workspace</div>
          </div>
        </div>
        <div className="pointer-events-none absolute inset-x-0 flex justify-center">
          <span className="rounded-full border border-border bg-surface/70 px-3 py-1 text-[10px] text-text-secondary">
            {primaryStatus}
          </span>
        </div>
        <div className="absolute right-2 flex items-center gap-1 [-webkit-app-region:no-drag]">
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

      <div className="shrink-0 border-b border-border bg-surface-alt/80 px-3 py-2">
        <div className="flex items-center gap-2 overflow-x-auto">
          <WorkflowTile
            index={1}
            label="Source"
            value={selectedSource ? selectedSource.split(/[/\\]/).filter(Boolean).pop() ?? selectedSource : 'Choose card or folder'}
            icon={FolderOpen}
            tone={sourceDone ? 'done' : 'active'}
          />
          <WorkflowTile
            index={2}
            label="Review"
            value={reviewDone ? `${files.length} files · ${reviewPct}% AI` : sourceDone ? 'Scanning will fill this lane' : 'Waiting for source'}
            icon={Images}
            tone={reviewDone ? 'done' : sourceDone ? 'active' : 'idle'}
          />
          <WorkflowTile
            index={3}
            label="Output"
            value={destination ? destination.split(/[/\\]/).filter(Boolean).pop() ?? destination : reviewDone ? 'Choose destination' : 'Set later'}
            icon={Download}
            tone={outputDone ? 'done' : reviewDone ? 'active' : 'idle'}
          />
          <WorkflowTile
            index={4}
            label="Import"
            value={queuedPaths.length > 0 ? `${queuedPaths.length} queued` : importReady ? 'Ready when reviewed' : 'Not ready'}
            icon={CheckCircle2}
            tone={phase === 'complete' ? 'done' : importReady ? 'active' : 'idle'}
          />

          <div className="ml-auto flex items-center gap-1.5">
            {files.length > 0 && (
              <>
                <HealthPill tone="idle" title={`Total source size ${formatSize(totalBytes)}`}>
                  {photoCount} photos{videoCount > 0 ? ` / ${videoCount} videos` : ''}
                </HealthPill>
                {selectedPaths.length > 0 && <HealthPill tone="active">{selectedPaths.length} selected</HealthPill>}
                {pickedCount > 0 && <HealthPill tone="blocked">{pickedCount} picked</HealthPill>}
                {queuedPaths.length > 0 && <HealthPill tone="done">{queuedPaths.length} queued</HealthPill>}
                {rejectedCount > 0 && <HealthPill tone="blocked">{rejectedCount} rejected</HealthPill>}
                {protectedCount > 0 && <HealthPill tone="done">{protectedCount} protected</HealthPill>}
                {faceCount > 0 && (
                  <HealthPill tone="active" title={estimatedFaceCount > 0 ? `${estimatedFaceCount} are estimated fallback detections` : 'Native face detections'}>
                    {faceCount} face photos
                  </HealthPill>
                )}
                {faceGroupCount > 0 && <HealthPill tone="active">{faceGroupCount} people/groups</HealthPill>}
                {blurCount > 0 && (
                  <HealthPill tone="blocked">
                    <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                    {blurCount} blur risk
                  </HealthPill>
                )}
                {reviewLeft > 0 && (
                  <HealthPill tone="idle">
                    <Gauge className="h-3 w-3" aria-hidden="true" />
                    AI {analyzedCount}/{photoCount}
                  </HealthPill>
                )}
              </>
            )}
          {ftpSyncStatus.state === 'running' && (
            <HealthPill tone="active" title={ftpSyncStatus.message}>
              <span className="h-1.5 w-1.5 rounded-full bg-blue-300 animate-pulse" />
              FTP sync
            </HealthPill>
          )}
          {/* Face model background download indicator */}
          {modelDl && modelDl.status === 'downloading' && (
            <HealthPill tone="active" title="Downloading face recognition models in background">
              <svg className="w-2.5 h-2.5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
              </svg>
              Face models {modelDl.percent ?? 0}%
            </HealthPill>
          )}
          {modelDl && modelDl.status === 'done' && (
            <HealthPill tone="done">Face models ready</HealthPill>
          )}
          {modelDl && modelDl.status === 'error' && (
            <HealthPill tone="blocked" title={modelDl.error}>Face models unavailable</HealthPill>
          )}
        </div>
      </div>
      </div>

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
