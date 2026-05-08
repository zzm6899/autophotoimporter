import { useMemo, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Download, FolderOpen, Gauge, Images } from 'lucide-react';
import type { ModelDownloadProgress } from '../../main/preload';
import { useAppState } from '../context/ImportContext';
import { formatSize } from '../utils/formatters';

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

export function WorkflowStepper({ modelDownload }: { modelDownload: ModelDownloadProgress | null }) {
  const {
    selectedSource,
    destination,
    files,
    queuedPaths,
    selectedPaths,
    phase,
    ftpSyncStatus,
    experienceMode,
  } = useAppState();
  const isPro = experienceMode === 'pro';
  const sourceDone = !!selectedSource;
  const reviewDone = files.length > 0;
  const outputDone = !!destination;
  const fileStats = useMemo(() => {
    let photoCount = 0;
    let videoCount = 0;
    let pickedCount = 0;
    let rejectedCount = 0;
    let protectedCount = 0;
    let faceCount = 0;
    let estimatedFaceCount = 0;
    let blurCount = 0;
    let analyzedCount = 0;
    let totalBytes = 0;
    const faceGroupIds = new Set<string>();
    for (const file of files) {
      if (file.type === 'photo') photoCount++;
      else if (file.type === 'video') videoCount++;
      if (file.pick === 'selected') pickedCount++;
      if (file.pick === 'rejected') rejectedCount++;
      if (file.isProtected) protectedCount++;
      if ((file.faceCount ?? 0) > 0) {
        faceCount++;
        if (file.faceDetection === 'estimated') estimatedFaceCount++;
      }
      if (file.faceGroupId) faceGroupIds.add(file.faceGroupId);
      if (file.blurRisk === 'high' || file.blurRisk === 'medium') blurCount++;
      if (typeof file.reviewScore === 'number' || typeof file.subjectSharpnessScore === 'number') analyzedCount++;
      totalBytes += file.size;
    }
    return {
      photoCount,
      videoCount,
      pickedCount,
      rejectedCount,
      protectedCount,
      faceCount,
      estimatedFaceCount,
      faceGroupCount: faceGroupIds.size,
      blurCount,
      analyzedCount,
      totalBytes,
    };
  }, [files]);
  const {
    photoCount,
    videoCount,
    pickedCount,
    rejectedCount,
    protectedCount,
    faceCount,
    estimatedFaceCount,
    faceGroupCount,
    blurCount,
    analyzedCount,
    totalBytes,
  } = fileStats;
  const reviewPct = photoCount > 0 ? Math.round((analyzedCount / photoCount) * 100) : 0;
  const reviewLeft = Math.max(0, photoCount - analyzedCount);
  const importReady = outputDone && (queuedPaths.length > 0 || pickedCount > 0 || files.length > 0);

  return (
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
          value={reviewDone ? (isPro ? `${files.length} files · ${reviewPct}% AI` : `${files.length} files ready`) : sourceDone ? 'Scanning will fill this lane' : 'Waiting for source'}
          icon={Images}
          tone={reviewDone ? 'done' : sourceDone ? 'active' : 'idle'}
        />
        <WorkflowTile
          index={3}
          label="Destination"
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
              {isPro && faceCount > 0 && (
                <HealthPill tone="active" title={estimatedFaceCount > 0 ? `${estimatedFaceCount} are estimated fallback detections` : 'Native face detections'}>
                  {faceCount} face photos
                </HealthPill>
              )}
              {isPro && faceGroupCount > 0 && <HealthPill tone="active">{faceGroupCount} people/groups</HealthPill>}
              {isPro && blurCount > 0 && (
                <HealthPill tone="blocked">
                  <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                  {blurCount} blur risk
                </HealthPill>
              )}
              {isPro && reviewLeft > 0 && (
                <HealthPill tone="idle">
                  <Gauge className="h-3 w-3" aria-hidden="true" />
                  AI {analyzedCount}/{photoCount}
                </HealthPill>
              )}
            </>
          )}
          {isPro && ftpSyncStatus.state === 'running' && (
            <HealthPill tone="active" title={ftpSyncStatus.message}>
              <span className="h-1.5 w-1.5 rounded-full bg-blue-300 animate-pulse" />
              FTP sync
            </HealthPill>
          )}
          {modelDownload && modelDownload.status === 'downloading' && (
            <HealthPill tone="active" title="Downloading face recognition models in background">
              <svg className="w-2.5 h-2.5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
              </svg>
              Face models {modelDownload.percent ?? 0}%
            </HealthPill>
          )}
          {modelDownload && modelDownload.status === 'done' && (
            <HealthPill tone="done">Face models ready</HealthPill>
          )}
          {modelDownload && modelDownload.status === 'error' && (
            <HealthPill tone="blocked" title={modelDownload.error}>Face models unavailable</HealthPill>
          )}
        </div>
      </div>
    </div>
  );
}
