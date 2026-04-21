import { useAppState, useAppDispatch } from '../context/ImportContext';
import { useFileScanner } from '../hooks/useFileScanner';
import { VolumeItem } from './VolumeItem';
import { FtpPanel } from './FtpPanel';
import { formatSize } from '../utils/formatters';

const isMac = typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin';
const MOD = isMac ? '\u2318' : 'Ctrl';

export function SourcePanel() {
  const { volumes, selectedSource, files, phase, sourceKind } = useAppState();
  const dispatch = useAppDispatch();
  const { startScan } = useFileScanner();

  const handleSelectVolume = (volumePath: string) => {
    dispatch({ type: 'SELECT_SOURCE', path: volumePath });
    startScan(volumePath);
  };

  const handleChooseFolder = async () => {
    const folder = await window.electronAPI.selectFolder('Select Source Folder');
    if (folder) {
      dispatch({ type: 'SELECT_SOURCE', path: folder });
      startScan(folder);
    }
  };

  const photoCount = files.filter((f) => f.type === 'photo').length;
  const videoCount = files.filter((f) => f.type === 'video').length;
  const pickedCount = files.filter((f) => f.pick === 'selected').length;
  const rejectedCount = files.filter((f) => f.pick === 'rejected').length;
  const duplicateCount = files.filter((f) => f.duplicate).length;
  const protectedCount = files.filter((f) => f.isProtected).length;
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);

  return (
    <div className="flex flex-col h-full">
      <div className="px-2.5 py-2 flex items-center justify-between">
        <h2 className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Source</h2>
        <div className="flex items-center gap-px bg-surface border border-border rounded overflow-hidden">
          <button
            onClick={() => dispatch({ type: 'SET_SOURCE_KIND', kind: 'volume' })}
            className={`px-1.5 py-0.5 text-[10px] transition-colors ${
              sourceKind === 'volume'
                ? 'bg-surface-raised text-text'
                : 'text-text-muted hover:text-text'
            }`}
            title="Import from a local drive / SD card"
          >
            Drive
          </button>
          <button
            onClick={() => dispatch({ type: 'SET_SOURCE_KIND', kind: 'ftp' })}
            className={`px-1.5 py-0.5 text-[10px] transition-colors ${
              sourceKind === 'ftp'
                ? 'bg-surface-raised text-text'
                : 'text-text-muted hover:text-text'
            }`}
            title="Import from a camera or server via FTP"
          >
            FTP
          </button>
        </div>
      </div>

      {sourceKind === 'volume' && (
        <>
          {/* Detected volumes */}
          {volumes.length > 0 && (
            <div className="border-b border-border">
              <div className="px-2.5 pb-0.5 flex items-center justify-between">
                <span className="text-[10px] text-text-secondary">Detected Devices</span>
                <span className="text-[9px] text-text-muted">DCIM first</span>
              </div>
              {[...volumes]
                .sort((a, b) => Number(b.hasDcim ?? false) - Number(a.hasDcim ?? false))
                .map((volume) => (
                  <VolumeItem
                    key={volume.path}
                    volume={volume}
                    isSelected={selectedSource === volume.path}
                    onSelect={handleSelectVolume}
                  />
                ))}
            </div>
          )}

          {/* Choose folder button */}
          <div className="px-2.5 py-1.5">
            <button
              onClick={handleChooseFolder}
              className="w-full px-2 py-1 text-xs bg-surface-raised hover:bg-border rounded text-text transition-colors text-left cursor-pointer"
            >
              Choose Folder...
            </button>
          </div>
        </>
      )}

      {sourceKind === 'ftp' && <FtpPanel />}

      {/* Selected source */}
      {selectedSource && (
        <div className="px-2.5 pt-1 pb-2 border-b border-border">
          <div className="text-[10px] text-text-muted truncate" title={selectedSource}>
            {selectedSource}
          </div>
          <div className="mt-1 flex items-center gap-2">
            {phase === 'ready' && (
              <button
                onClick={() => startScan()}
                className="text-[10px] text-text-secondary hover:text-text transition-colors"
              >
                Rescan
              </button>
            )}
            {/* Eject is best-effort. Only show for removable volumes that
                are actually in the detected list (Choose Folder... sources
                can't be ejected) */}
            {(() => {
              const vol = volumes.find((v) => v.path === selectedSource);
              if (!vol?.isRemovable) return null;
              return (
                <button
                  onClick={async () => {
                    const res = await window.electronAPI.ejectVolume(selectedSource);
                    if (!res.ok) {
                      // Soft fail: surface the reason but don't crash the UI.
                      alert(`Couldn't eject: ${res.error ?? 'unknown error'}`);
                    }
                  }}
                  className="text-[10px] text-text-secondary hover:text-text transition-colors"
                  title="Safely eject this volume"
                >
                  Eject
                </button>
              );
            })()}
          </div>
        </div>
      )}

      {/* File stats */}
      {files.length > 0 && (
        <div className="px-2.5 py-2 space-y-1.5">
          <h3 className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Library</h3>
          <div className="space-y-0.5 text-[11px]">
            <div className="flex justify-between">
              <span className="text-text-secondary">Photos</span>
              <span className="text-text font-mono">{photoCount}</span>
            </div>
            {videoCount > 0 && (
              <div className="flex justify-between">
                <span className="text-text-secondary">Videos</span>
                <span className="text-text font-mono">{videoCount}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-text-secondary">Total size</span>
              <span className="text-text font-mono">{formatSize(totalSize)}</span>
            </div>
          </div>

          {(pickedCount > 0 || rejectedCount > 0 || duplicateCount > 0 || protectedCount > 0) && (
            <div className="pt-1.5 border-t border-border space-y-0.5 text-[11px]">
              {protectedCount > 0 && (
                <div className="flex justify-between">
                  <span className="text-text-secondary">Protected</span>
                  <span className="text-emerald-400 font-mono">{protectedCount}</span>
                </div>
              )}
              {pickedCount > 0 && (
                <div className="flex justify-between">
                  <span className="text-text-secondary">Selected</span>
                  <span className="text-yellow-400 font-mono">{pickedCount}</span>
                </div>
              )}
              {rejectedCount > 0 && (
                <div className="flex justify-between">
                  <span className="text-text-secondary">Rejected</span>
                  <span className="text-red-400 font-mono">{rejectedCount}</span>
                </div>
              )}
              {duplicateCount > 0 && (
                <div className="flex justify-between">
                  <span className="text-text-secondary">Duplicates</span>
                  <span className="text-text-muted font-mono">{duplicateCount}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Scanning indicator */}
      {phase === 'scanning' && (
        <div className="px-2.5 py-2 flex items-center gap-1.5">
          <div className="w-3 h-3 border-[1.5px] border-text-muted border-t-text rounded-full animate-spin" />
          <span className="text-[10px] text-text-muted">Scanning...</span>
        </div>
      )}

      {/* Keyboard shortcuts */}
      {files.length > 0 && (
        <div className="mt-auto px-2.5 py-2 border-t border-border">
          <h3 className="text-[10px] text-text-muted uppercase tracking-wider mb-1">Shortcuts</h3>
          <div className="space-y-0.5 text-[10px] text-text-muted">
            <div className="flex justify-between">
              <span>Click</span>
              <span className="text-text-secondary">Focus</span>
            </div>
            <div className="flex justify-between">
              <span>Double-click</span>
              <span className="text-text-secondary">Detail view</span>
            </div>
            <div className="flex justify-between">
              <span>{MOD}+Click</span>
              <span className="text-text-secondary">Toggle select</span>
            </div>
            <div className="flex justify-between">
              <span>Shift+Click</span>
              <span className="text-text-secondary">Range select</span>
            </div>
            <div className="flex justify-between">
              <span>{MOD}+A</span>
              <span className="text-text-secondary">Select all</span>
            </div>
            <div className="flex justify-between">
              <span>P / X / U</span>
              <span className="text-text-secondary">Pick / Reject / Clear</span>
            </div>
            <div className="flex justify-between">
              <span>1 – 5</span>
              <span className="text-text-secondary">Star rating</span>
            </div>
            <div className="flex justify-between">
              <span>Arrows</span>
              <span className="text-text-secondary">Navigate</span>
            </div>
            <div className="flex justify-between">
              <span>Esc</span>
              <span className="text-text-secondary">Deselect / Back</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
