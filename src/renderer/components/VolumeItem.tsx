import type { Volume } from '../../shared/types';
import { formatSize } from '../utils/formatters';

interface VolumeItemProps {
  volume: Volume;
  isSelected: boolean;
  onSelect: (path: string) => void;
  disabled?: boolean;
}

export function VolumeItem({ volume, isSelected, onSelect, disabled = false }: VolumeItemProps) {
  return (
    <button
      onClick={() => onSelect(volume.path)}
      disabled={disabled}
      className={`w-full text-left px-2.5 py-1.5 flex items-start gap-2 transition-colors ${
        disabled
          ? 'cursor-not-allowed opacity-50 text-text-muted'
          : isSelected
          ? 'bg-surface-raised text-text'
          : 'hover:bg-surface-raised/50 text-text'
      }`}
      title={disabled ? 'Wait for the current scan/import to finish before changing source.' : undefined}
    >
      <svg className="w-4 h-4 mt-px shrink-0 text-text-secondary" viewBox="0 0 20 20" fill="currentColor">
        <path d="M2 4.75C2 3.784 2.784 3 3.75 3h12.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0116.25 17H3.75A1.75 1.75 0 012 15.25V4.75z" />
      </svg>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium truncate">{volume.name}</div>
        {volume.totalSize && (
          <div className="text-[10px] text-text-secondary">
            {volume.freeSpace ? formatSize(volume.freeSpace) : '?'} free of {formatSize(volume.totalSize)}
          </div>
        )}
      </div>
    </button>
  );
}
