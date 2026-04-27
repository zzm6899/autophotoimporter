import { memo, useRef, useEffect, useState } from 'react';
import type { MediaFile } from '../../shared/types';
import { formatFileSize, formatExposure } from '../utils/formatters';
import { buildPreviewExposureFilter, clampStops } from '../../shared/exposure';

function useLazySrc(src: string | undefined, forceActive: boolean) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeSrc, setActiveSrc] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!src) { setActiveSrc(undefined); return; }
    if (forceActive) { setActiveSrc(src); return; }
    const el = containerRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setActiveSrc(src); obs.disconnect(); } },
      { rootMargin: '300px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [src, forceActive]);

  useEffect(() => {
    if (activeSrc && src && activeSrc !== src) setActiveSrc(src);
  }, [src, activeSrc]);

  return { containerRef, activeSrc };
}

interface ThumbnailCardProps {
  index: number;
  file: MediaFile;
  focused?: boolean;
  selected?: boolean;
  queued?: boolean;
  forceLoad?: boolean;
  exposurePreviewStops?: number;
  compact?: boolean;
  frameNumber?: number;
  burstCollapsed?: boolean;
  /** When true (or undefined for non-burst files) the BEST badge is shown. False suppresses it for non-best burst shots. */
  isBurstBest?: boolean;
  onClickCard: (index: number, e: React.MouseEvent) => void;
  onDoubleClickCard: (index: number) => void;
  onBurstToggle: (burstId: string) => void;
}

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

function orientationTransform(orientation?: number) {
  switch (orientation) {
    case 2: return 'scaleX(-1)';
    case 3: return 'rotate(180deg)';
    case 4: return 'scaleY(-1)';
    case 5: return 'rotate(90deg) scaleX(-1)';
    case 6: return 'rotate(90deg)';
    case 7: return 'rotate(270deg) scaleX(-1)';
    case 8: return 'rotate(270deg)';
    default: return undefined;
  }
}

function ThumbnailCardInner({
  index,
  file,
  focused = false,
  selected = false,
  queued = false,
  forceLoad = false,
  exposurePreviewStops = 0,
  compact = false,
  frameNumber,
  burstCollapsed = false,
  isBurstBest = true,
  onClickCard,
  onDoubleClickCard,
  onBurstToggle,
}: ThumbnailCardProps) {
  const isVideo = file.type === 'video';
  const isPicked = file.pick === 'selected';
  const isRejected = file.pick === 'rejected';
  const exposureMarked = !!file.normalizeToAnchor || Math.abs(file.exposureAdjustmentStops ?? 0) >= 0.01;
  const totalPreviewStops = clampStops((file.exposureAdjustmentStops ?? 0) + exposurePreviewStops, 4);
  const previewFilter = buildPreviewExposureFilter(totalPreviewStops);
  const orientation = orientationTransform(file.orientation);
  const { containerRef, activeSrc } = useLazySrc(file.thumbnail, forceLoad || focused || selected);

  return (
    <div
      className={`group relative cursor-pointer transition-all ${
        isRejected ? 'opacity-50' : ''
      } ${file.duplicate && !file.pick ? 'opacity-40' : ''}`}
      onClick={(e) => onClickCard(index, e)}
      onDoubleClick={() => onDoubleClickCard(index)}
    >
      <div className={`relative bg-surface overflow-hidden ${
        selected ? 'ring-2 ring-blue-500' : focused ? 'outline-2 outline-offset-2 outline-blue-500' : ''
      }`}>
        <div ref={containerRef} className="aspect-[4/3] relative flex items-center justify-center">
          {activeSrc ? (
            <img
              src={activeSrc}
              alt={file.name}
              className="w-full h-full object-cover"
              decoding="async"
              loading={focused ? 'eager' : 'lazy'}
              style={{
                imageOrientation: 'none',
                transform: orientation,
                transformOrigin: 'center center',
                filter: previewFilter,
              }}
            />
          ) : (
            <div className="w-full h-full bg-surface-raised animate-pulse flex items-center justify-center">
              {isVideo ? (
                <svg className="w-8 h-8 text-text-faint" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M4.5 4.5a3 3 0 00-3 3v9a3 3 0 003 3h8.25a3 3 0 003-3v-9a3 3 0 00-3-3H4.5zM19.94 18.75l-2.69-2.69V7.94l2.69-2.69c.944-.945 2.56-.276 2.56 1.06v11.38c0 1.336-1.616 2.005-2.56 1.06z" />
                </svg>
              ) : (
                <svg className="w-8 h-8 text-text-faint" viewBox="0 0 24 24" fill="currentColor">
                  <path fillRule="evenodd" d="M1.5 6a2.25 2.25 0 012.25-2.25h16.5A2.25 2.25 0 0122.5 6v12a2.25 2.25 0 01-2.25 2.25H3.75A2.25 2.25 0 011.5 18V6zM3 16.06V18c0 .414.336.75.75.75h16.5A.75.75 0 0021 18v-1.94l-2.69-2.689a1.5 1.5 0 00-2.12 0l-.88.879.97.97a.75.75 0 11-1.06 1.06l-5.16-5.159a1.5 1.5 0 00-2.12 0L3 16.061zm10.125-7.81a1.125 1.125 0 112.25 0 1.125 1.125 0 01-2.25 0z" clipRule="evenodd" />
                </svg>
              )}
            </div>
          )}

          {isPicked && <CornerBrackets />}
          {exposureMarked && activeSrc && (
            <div
              className="absolute inset-0 pointer-events-none z-[8] ring-2 ring-inset ring-orange-400/70 bg-orange-300/10"
              title="Exposure normalization/manual EV adjustment is marked for this photo"
            />
          )}
          {isRejected && <RejectX />}

          {isVideo && (
            <div className="absolute top-1.5 right-1.5 bg-black/70 text-[9px] text-white/80 px-1 py-0.5 rounded font-medium z-20">
              VID
            </div>
          )}

          {file.duplicate && !file.pick && (
            <div className="absolute top-1.5 left-1.5 bg-yellow-600/80 text-[9px] text-white px-1 py-0.5 rounded font-medium z-20">
              IMPORTED
            </div>
          )}

          {(file.isProtected || file.normalizeToAnchor || file.exposureAdjustmentStops) && (
            <div className="absolute top-1.5 left-1.5 flex flex-col gap-0.5 z-20">
              {file.isProtected && (
                <div
                  className="bg-emerald-600/90 text-[9px] text-white px-1 py-0.5 rounded font-medium flex items-center gap-0.5"
                  title="Protected / read-only - prioritized for import"
                >
                  <svg className="w-2.5 h-2.5" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clipRule="evenodd" />
                  </svg>
                  PROTECTED
                </div>
              )}
              {file.normalizeToAnchor && (
                <div
                  className="bg-orange-500/90 text-[9px] text-white px-1 py-0.5 rounded font-medium"
                  title="Exposure will be normalized to the anchor on import"
                >
                  NORM
                </div>
              )}
              {file.exposureAdjustmentStops && (
                <div
                  className="bg-sky-500/90 text-[9px] text-white px-1 py-0.5 rounded font-medium"
                  title="Manual exposure offset"
                >
                  {file.exposureAdjustmentStops > 0 ? '+' : ''}{file.exposureAdjustmentStops.toFixed(1)}EV
                </div>
              )}
            </div>
          )}

          {queued && (
            <div className="absolute top-7 left-1.5 bg-emerald-600/90 text-[9px] text-white px-1 py-0.5 rounded font-medium z-20">
              QUEUED
            </div>
          )}

          {(file.reviewScore || file.blurRisk === 'high' || file.visualGroupId || file.faceCount || file.personCount) && (
            <div className="absolute left-1.5 bottom-1.5 flex gap-0.5 z-20">
              {!!file.faceCount && (
                <span className="bg-emerald-600/90 text-[9px] text-white px-1 py-0.5 rounded font-medium" title={`${file.faceCount} ${file.faceDetection === 'estimated' ? 'estimated ' : ''}face(s) detected`}>
                  {file.faceDetection === 'estimated' ? 'FACE?' : 'FACE'}
                </span>
              )}
              {!!file.personCount && (
                <span className="bg-sky-600/90 text-[9px] text-white px-1 py-0.5 rounded font-medium" title={`${file.personCount} person/body detection(s)`}>
                  PERSON
                </span>
              )}
              {(file.reviewScore ?? 0) >= 70 && isBurstBest && (
                <span className="bg-yellow-500/90 text-[9px] text-black px-1 py-0.5 rounded font-medium" title={file.reviewReasons?.join(', ') || 'Best shot in burst'}>
                  BEST
                </span>
              )}
              {(file.blurRisk === 'high' || file.blurRisk === 'medium') && (
                <span className={`${file.blurRisk === 'high' ? 'bg-red-600/90' : 'bg-orange-500/90'} text-[9px] text-white px-1 py-0.5 rounded font-medium`} title={`${file.blurRisk} blur risk`}>
                  BLUR
                </span>
              )}
              {file.visualGroupId && (
                <span className="bg-blue-600/90 text-[9px] text-white px-1 py-0.5 rounded font-medium" title={`Similar group: ${file.visualGroupSize ?? 0} files`}>
                  SIM
                </span>
              )}
              {file.faceGroupId && (
                <span className="bg-violet-600/90 text-[9px] text-white px-1 py-0.5 rounded font-medium" title={`Similar face group: ${file.faceGroupSize ?? 0} files`}>
                  FACE x{file.faceGroupSize ?? 0}
                </span>
              )}
            </div>
          )}

          {file.rating && file.rating > 0 && (
            <div className="absolute bottom-1.5 right-1.5 flex gap-px bg-black/60 rounded px-1 py-0.5 z-20">
              {Array.from({ length: Math.min(file.rating, 5) }).map((_, i) => (
                <svg key={i} className="w-2 h-2 text-yellow-400" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                </svg>
              ))}
            </div>
          )}

          {compact && frameNumber !== undefined && (
            <div className="absolute bottom-1 left-1 text-[9px] text-neutral-500 dark:text-neutral-400 font-mono z-20">
              {String(frameNumber).padStart(3, '0')}
            </div>
          )}

          {file.burstId && file.burstSize && file.burstSize > 1 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onBurstToggle(file.burstId!);
              }}
              className={`absolute top-1.5 right-1.5 text-[9px] text-white px-1 py-0.5 rounded font-medium z-20 flex items-center gap-0.5 ${
                burstCollapsed
                  ? 'bg-blue-600/90 hover:bg-blue-600 cursor-pointer'
                  : 'bg-blue-500/85 hover:bg-blue-500 cursor-pointer'
              }`}
              title={burstCollapsed
                ? `Burst - ${file.burstSize} shots. Click to expand (G)`
                : `Burst shot ${file.burstIndex} of ${file.burstSize}. Click to collapse (G)`}
            >
              {burstCollapsed ? `x${file.burstSize}` : `${file.burstIndex}/${file.burstSize}`}
            </button>
          )}

          {file.burstId && typeof file.sharpnessScore === 'number' && !file.reviewScore && (
            <div
              className="absolute bottom-1.5 left-1.5 bg-black/60 text-[9px] text-white/80 px-1 py-0.5 rounded font-mono z-20"
              title="Sharpness score used for burst keeper selection"
            >
              S {file.sharpnessScore}
            </div>
          )}

          {burstCollapsed && (
            <>
              <div className="absolute -top-0.5 -right-0.5 -bottom-0.5 -left-0.5 border border-border/60 rounded-sm -z-10 translate-x-0.5 translate-y-0.5" />
              <div className="absolute -top-1 -right-1 -bottom-1 -left-1 border border-border/40 rounded-sm -z-20 translate-x-1 translate-y-1" />
            </>
          )}
        </div>
      </div>

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

export const ThumbnailCard = memo(ThumbnailCardInner, (prev, next) => {
  const a = prev.file;
  const b = next.file;
  return (
    prev.index === next.index &&
    a.path === b.path &&
    a.thumbnail === b.thumbnail &&
    a.pick === b.pick &&
    a.duplicate === b.duplicate &&
    a.isProtected === b.isProtected &&
    a.rating === b.rating &&
    a.normalizeToAnchor === b.normalizeToAnchor &&
    a.exposureAdjustmentStops === b.exposureAdjustmentStops &&
    a.burstId === b.burstId &&
    a.burstIndex === b.burstIndex &&
    a.burstSize === b.burstSize &&
    a.reviewScore === b.reviewScore &&
    a.subjectSharpnessScore === b.subjectSharpnessScore &&
    a.faceCount === b.faceCount &&
    a.faceDetection === b.faceDetection &&
    a.faceSignature === b.faceSignature &&
    a.faceGroupId === b.faceGroupId &&
    a.faceGroupSize === b.faceGroupSize &&
    a.blurRisk === b.blurRisk &&
    a.visualGroupId === b.visualGroupId &&
    a.visualGroupSize === b.visualGroupSize &&
    prev.onClickCard === next.onClickCard &&
    prev.onDoubleClickCard === next.onDoubleClickCard &&
    prev.onBurstToggle === next.onBurstToggle &&
    prev.focused === next.focused &&
    prev.selected === next.selected &&
    prev.queued === next.queued &&
    prev.forceLoad === next.forceLoad &&
    prev.exposurePreviewStops === next.exposurePreviewStops &&
    prev.compact === next.compact &&
    prev.frameNumber === next.frameNumber &&
    prev.burstCollapsed === next.burstCollapsed &&
    prev.isBurstBest === next.isBurstBest
  );
});
