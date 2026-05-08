import { formatSize } from '../../utils/formatters';

interface DestinationPreviewProps {
  destination: string | null;
  fileCount: number;
  totalSize: number;
  duplicateCount: number;
  protectedCount: number;
  folderCount: number;
  backupEnabled: boolean;
  checksumEnabled: boolean;
  metadataEnabled: boolean;
  freeBytes: number | null;
  insufficientSpace: boolean;
  spaceWarning: boolean;
}

export function DestinationPreview({
  destination,
  fileCount,
  totalSize,
  duplicateCount,
  protectedCount,
  folderCount,
  backupEnabled,
  checksumEnabled,
  metadataEnabled,
  freeBytes,
  insufficientSpace,
  spaceWarning,
}: DestinationPreviewProps) {
  const destinationName = destination
    ? destination.split(/[/\\]/).filter(Boolean).pop() ?? destination
    : 'Choose destination';
  const freeSpaceLabel = freeBytes == null ? 'Unknown free space' : `${formatSize(freeBytes)} free`;

  return (
    <div className={`rounded-md border px-2 py-2 ${
      insufficientSpace
        ? 'border-red-500/30 bg-red-500/10'
        : spaceWarning
          ? 'border-yellow-500/30 bg-yellow-500/10'
          : 'border-border bg-surface-alt'
    }`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">Destination preview</div>
          <div className="mt-0.5 truncate text-xs font-medium text-text" title={destination ?? ''}>{destinationName}</div>
        </div>
        <span className="shrink-0 rounded border border-border bg-surface px-1.5 py-0.5 text-[9px] text-text-muted">{freeSpaceLabel}</span>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-1 text-[10px] text-text-secondary">
        <div className="rounded bg-surface px-1.5 py-1">{fileCount} file{fileCount === 1 ? '' : 's'}</div>
        <div className="rounded bg-surface px-1.5 py-1">{formatSize(totalSize)}</div>
        <div className="rounded bg-surface px-1.5 py-1">{folderCount || 1} folder{folderCount === 1 ? '' : 's'}</div>
        <div className="rounded bg-surface px-1.5 py-1">{duplicateCount} duplicate{duplicateCount === 1 ? '' : 's'}</div>
      </div>

      <div className="mt-2 flex flex-wrap gap-1">
        {protectedCount > 0 && <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] text-emerald-300">{protectedCount} protected</span>}
        {checksumEnabled && <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] text-emerald-300">checksum</span>}
        {backupEnabled && <span className="rounded-full border border-blue-500/25 bg-blue-500/10 px-1.5 py-0.5 text-[9px] text-blue-300">backup</span>}
        {metadataEnabled && <span className="rounded-full border border-sky-500/25 bg-sky-500/10 px-1.5 py-0.5 text-[9px] text-sky-300">metadata</span>}
      </div>

      {(spaceWarning || insufficientSpace) && (
        <div className={`mt-2 text-[10px] ${insufficientSpace ? 'text-red-300' : 'text-yellow-300'}`}>
          {insufficientSpace
            ? `Not enough free space. Need ${formatSize(totalSize)}.`
            : `Free space is tight for a ${formatSize(totalSize)} import.`}
        </div>
      )}
    </div>
  );
}
