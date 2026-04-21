import type { MediaFile } from '../../shared/types';
import { formatFileSize, formatExposure, isPortrait } from '../utils/formatters';

interface ThumbnailCardProps {
  file: MediaFile;
  focused?: boolean;
  selected?: boolean;
  compact?: boolean;
  frameNumber?: number;
  /**
   * True when this card represents the leader of a collapsed burst. The card
   * renders a "+N" stack affordance instead of the normal burst index badge.
   */
  burstCollapsed?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  onDoubleClick?: () => void;
  onBurstToggle?: (burstId: string) => void;
}

// Subtle corner brackets (thin pick marks)
function CornerBrackets() {
  return (
    <div className="absolute inset-0 pointer-events-none z-10">
      <div className="absolute top-1 left-1 w-3 h-3 border-t-[2px] border-l-[2px] border-yellow-400/80 rounded-tl-sm" />
      <div className="absolute top-1 right-1 w-3 h-3 border-t-[2px] border-r-[2px] border-yellow-400/80 rounded-tr-sm" />
      <div className="absolute bottom-1 left-1 w-3 h-3 border-b-[2px] border-l-[2px] border-yellow-400/80 rounded-bl-sm" />
      <div className="absolute bottom-1 right-1 w-3 h-3 border-b-[2px] border-r-[2px] border-yellow-400/80 rounded-br-sm" />
    </div>
  );
}

// Thin full-frame reject cross
function RejectX() {
  return (
    <div className="absolute inset-0 pointer-events-none z-10">
      <svg className="w-full h-full" viewBox="0 0 100 75" preserveAspectRatio="none">
        <line x1="10" y1="8" x2="90" y2="67" stroke="#dc2626" strokeWidth="1.5" strokeLinecap="round" strokeOpacity="0.7" />
        <line x1="90" y1="8" x2="10" y2="67" stroke="#dc2626" strokeWidth="1.5" strokeLinecap="round" strokeOpacity="0.7" />
      </svg>
    </div>
  );
}

export function ThumbnailCard({
  file,
  focused = false,
  selected = false,
  compact = false,
  frameNumber,
  burstCollapsed = false,
  onClick,
  onDoubleClick,
  onBurstToggle,
}: ThumbnailCardProps) {
  const isVideo = file.type === 'video';
  const portrait = isPortrait(file.orientation);
  const isPicked = file.pick === 'selected';
  const isRejected = file.pick === 'rejected';

  return (
    <div
      className={`group relative cursor-pointer transition-all ${
        isRejected ? 'opacity-50' : ''
      } ${file.duplicate && !file.pick ? 'opacity-40' : ''}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {/* Frame */}
      <div className={`relative bg-surface overflow-hidden ${
        selected ? 'ring-2 ring-blue-500' : focused ? 'outline-2 outline-offset-2 outline-blue-500' : ''
      }`}>
        {/* Image */}
        <div className="aspect-[4/3] relative flex items-center justify-center">
          {file.thumbnail ? (
            <img
              src={file.thumbnail}
              alt={file.name}
              className={`w-full h-full object-cover ${portrait ? '-rotate-90 scale-[1.35]' : ''}`}
              style={{ imageOrientation: 'none' }}
              loading="lazy"
              decoding="async"
            />
          ) : isVideo ? (
            <svg className="w-10 h-10 text-text-faint" viewBox="0 0 24 24" fill="currentColor">
              <path d="M4.5 4.5a3 3 0 00-3 3v9a3 3 0 003 3h8.25a3 3 0 003-3v-9a3 3 0 00-3-3H4.5zM19.94 18.75l-2.69-2.69V7.94l2.69-2.69c.944-.945 2.56-.276 2.56 1.06v11.38c0 1.336-1.616 2.005-2.56 1.06z" />
            </svg>
          ) : (
            <svg className="w-10 h-10 text-text-faint" viewBox="0 0 24 24" fill="currentColor">
              <path fillRule="evenodd" d="M1.5 6a2.25 2.25 0 012.25-2.25h16.5A2.25 2.25 0 0122.5 6v12a2.25 2.25 0 01-2.25 2.25H3.75A2.25 2.25 0 011.5 18V6zM3 16.06V18c0 .414.336.75.75.75h16.5A.75.75 0 0021 18v-1.94l-2.69-2.689a1.5 1.5 0 00-2.12 0l-.88.879.97.97a.75.75 0 11-1.06 1.06l-5.16-5.159a1.5 1.5 0 00-2.12 0L3 16.061zm10.125-7.81a1.125 1.125 0 112.25 0 1.125 1.125 0 01-2.25 0z" clipRule="evenodd" />
            </svg>
          )}

          {/* Pick: yellow corner brackets */}
          {isPicked && <CornerBrackets />}

          {/* Reject: red X */}
          {isRejected && <RejectX />}

          {/* Video badge */}
          {isVideo && (
            <div className="absolute top-1.5 right-1.5 bg-black/70 text-[9px] text-white/80 px-1 py-0.5 rounded font-medium z-20">
              VID
            </div>
          )}

          {/* Imported badge */}
          {file.duplicate && !file.pick && (
            <div className="absolute top-1.5 left-1.5 bg-yellow-600/80 text-[9px] text-white px-1 py-0.5 rounded font-medium z-20">
              IMPORTED
            </div>
          )}

          {/* In-camera protected / read-only lock */}
          {file.isProtected && (
            <div
              className="absolute top-1.5 left-1.5 bg-emerald-600/90 text-[9px] text-white px-1 py-0.5 rounded font-medium z-20 flex items-center gap-0.5"
              title="Protected / read-only — prioritized for import"
            >
              <svg className="w-2.5 h-2.5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clipRule="evenodd" />
              </svg>
              PROTECTED
            </div>
          )}

          {/* Star rating (top-right, under VID badge space) */}
          {file.rating && file.rating > 0 && (
            <div className="absolute bottom-1.5 right-1.5 flex gap-px bg-black/60 rounded px-1 py-0.5 z-20">
              {Array.from({ length: Math.min(file.rating, 5) }).map((_, i) => (
                <svg key={i} className="w-2 h-2 text-yellow-400" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                </svg>
              ))}
            </div>
          )}

          {/* Frame number (compact/filmstrip mode) */}
          {compact && frameNumber !== undefined && (
            <div className="absolute bottom-1 left-1 text-[9px] text-neutral-500 dark:text-neutral-400 font-mono z-20">
              {String(frameNumber).padStart(3, '0')}
            </div>
          )}

          {/* Burst badge: shows position within the burst, or the total
              count when the burst is collapsed. Clicking toggles collapse. */}
          {file.burstId && file.burstSize && file.burstSize > 1 && (
            <button
              type="button"
              onClick={(e) => {
                if (onBurstToggle) {
                  e.stopPropagation();
                  onBurstToggle(file.burstId!);
                }
              }}
              className={`absolute top-1.5 right-1.5 text-[9px] text-white px-1 py-0.5 rounded font-medium z-20 flex items-center gap-0.5 ${
                burstCollapsed
                  ? 'bg-blue-600/90 hover:bg-blue-600 cursor-pointer'
                  : 'bg-blue-500/85 hover:bg-blue-500 cursor-pointer'
              }`}
              title={burstCollapsed
                ? `Burst — ${file.burstSize} shots. Click to expand (G)`
                : `Burst shot ${file.burstIndex} of ${file.burstSize}. Click to collapse (G)`}
            >
              <svg className="w-2.5 h-2.5" viewBox="0 0 20 20" fill="currentColor">
                {burstCollapsed ? (
                  <path fillRule="evenodd" d="M3 4a1 1 0 000 2h14a1 1 0 100-2H3zm0 5a1 1 0 000 2h14a1 1 0 100-2H3zm0 5a1 1 0 100 2h14a1 1 0 100-2H3z" clipRule="evenodd" />
                ) : (
                  <>
                    <path d="M10 12a2 2 0 100-4 2 2 0 000 4z" />
                    <path fillRule="evenodd" d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clipRule="evenodd" />
                  </>
                )}
              </svg>
              {burstCollapsed ? `×${file.burstSize}` : `${file.burstIndex}/${file.burstSize}`}
            </button>
          )}

          {/* Stacked-shadow affordance for collapsed bursts */}
          {burstCollapsed && (
            <>
              <div className="absolute -top-0.5 -right-0.5 -bottom-0.5 -left-0.5 border border-border/60 rounded-sm -z-10 translate-x-0.5 translate-y-0.5" />
              <div className="absolute -top-1 -right-1 -bottom-1 -left-1 border border-border/40 rounded-sm -z-20 translate-x-1 translate-y-1" />
            </>
          )}
        </div>
      </div>

      {/* File info — hidden in compact/filmstrip mode */}
      {!compact && (
        <div className="mt-1 flex items-center justify-between px-0.5">
          <span className="text-[10px] text-text-secondary font-mono truncate">{file.name}</span>
          <span className="text-[9px] text-text-muted font-mono shrink-0 ml-1">
            {formatExposure(file) || formatFileSize(file.size)}
          </span>
        </div>
      )}
    </div>
  );
}
