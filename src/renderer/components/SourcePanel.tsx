import { useState, useCallback } from 'react';
import { useAppState, useAppDispatch } from '../context/ImportContext';
import { useFileScanner } from '../hooks/useFileScanner';
import { VolumeItem } from './VolumeItem';
import { FtpPanel } from './FtpPanel';
import { formatSize } from '../utils/formatters';

const isMac = typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin';
const MOD = isMac ? '\u2318' : 'Ctrl';

export function SourcePanel() {
  const { volumes, selectedSource, files, phase, sourceKind, scanPaused, volumeImportQueue } = useAppState();
  const dispatch = useAppDispatch();
  const { startScan, pauseScan, resumeScan } = useFileScanner();

  const [dragOver, setDragOver] = useState(false);

  const handleSelectVolume = (volumePath: string) => {
    dispatch({ type: 'SELECT_SOURCE', path: volumePath });
    startScan(volumePath);
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const items = Array.from(e.dataTransfer.files);
    if (items.length === 0) return;
    const folderPath = (items[0] as { path?: string }).path;
    if (!folderPath) return;
    dispatch({ type: 'SET_SOURCE_KIND', kind: 'volume' });
    dispatch({ type: 'SELECT_SOURCE', path: folderPath });
    startScan(folderPath);
  }, [dispatch, startScan]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  const handleImportAllCards = () => {
    const dcimVolumes = [...volumes]
      .filter((v) => v.hasDcim)
      .sort((a, b) => Number(b.hasDcim ?? false) - Number(a.hasDcim ?? false));
    if (dcimVolumes.length === 0) return;
    dispatch({ type: 'SET_VOLUME_IMPORT_QUEUE', paths: dcimVolumes.map((v) => v.path) });
    dispatch({ type: 'SELECT_SOURCE', path: dcimVolumes[0].path });
    startScan(dcimVolumes[0].path);
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
    <div
      className={`flex flex-col h-full transition-colors ${dragOver ? 'bg-accent/10 ring-1 ring-inset ring-accent/40' : ''}`}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
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
              <div className="px-2.5 pb-1.5 space-y-1">
                <span className="text-[10px] text-text-secondary">Detected Devices</span>
                {volumes.filter((v) => v.hasDcim).length >= 2 ? (
                  <button
                    onClick={handleImportAllCards}
                    disabled={phase === 'importing' || (phase === 'scanning' && volumeImportQueue.length > 0)}
                    className="block w-full rounded bg-emerald-600/15 px-2 py-1.5 text-left text-[11px] font-medium text-emerald-300 hover:bg-emerald-600/25 disabled:opacity-40 transition-colors"
                    title={`Import all ${volumes.filter((v) => v.hasDcim).length} cards sequentially, one after another.`}
                  >
                    {volumeImportQueue.length > 1
                      ? `Importing ${volumeImportQueue.length} cards…`
                      : `Import every SD card (${volumes.filter((v) => v.hasDcim).length})`}
                  </button>
                ) : (
                  <span className="text-[9px] text-text-muted">DCIM first</span>
                )}
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

          {/* Choose folder / drop zone */}
          <div className="px-2.5 py-1.5 space-y-1.5">
            <button
              onClick={handleChooseFolder}
              className="w-full px-2 py-1 text-xs bg-surface-raised hover:bg-border rounded text-text transition-colors text-left cursor-pointer"
            >
              Choose Folder…
            </button>
            {!selectedSource && (
              <div className={`flex flex-col items-center justify-center gap-1 rounded border border-dashed py-4 transition-colors ${
                dragOver ? 'border-accent/60 bg-accent/10 text-accent' : 'border-border text-text-muted'
              }`}>
                <svg className="w-5 h-5 opacity-50" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                </svg>
                <span className="text-[10px]">Drop folder here</span>
              </div>
            )}
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
            {phase === 'scanning' && (
              <button
                onClick={() => scanPaused ? resumeScan() : pauseScan()}
                className="text-[10px] text-text-secondary hover:text-text transition-colors"
              >
                {scanPaused ? 'Resume' : 'Pause'}
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
          <div className={`w-3 h-3 border-[1.5px] border-text-muted border-t-text rounded-full ${scanPaused ? '' : 'animate-spin'}`} />
          <span className="text-[10px] text-text-muted">{scanPaused ? 'Scan paused' : 'Scanning...'}</span>
          <button
            onClick={() => scanPaused ? resumeScan() : pauseScan()}
            className="ml-auto text-[10px] text-text-secondary hover:text-text"
          >
            {scanPaused ? 'Resume' : 'Pause'}
          </button>
        </div>
      )}

      {/* Help section — onboarding when empty, shortcuts when files loaded */}
      <div className="mt-auto px-2.5 py-2 border-t border-border">
        {files.length === 0 ? (
          <>
            <h3 className="text-[10px] text-text-muted uppercase tracking-wider mb-1.5">How it works</h3>
            <div className="space-y-1.5 text-[10px] text-text-muted">
              <div className="flex gap-2">
                <span className="text-text-secondary font-medium shrink-0">1.</span>
                <span>Insert an SD card or choose a folder — photos are scanned automatically.</span>
              </div>
              <div className="flex gap-2">
                <span className="text-text-secondary font-medium shrink-0">2.</span>
                <span>AI review runs in the background: blur detection, face recognition, and keeper scoring.</span>
              </div>
              <div className="flex gap-2">
                <span className="text-text-secondary font-medium shrink-0">3.</span>
                <span>Pick keepers with <kbd className="bg-surface-raised px-0.5 rounded">P</kbd>, reject with <kbd className="bg-surface-raised px-0.5 rounded">X</kbd>, then set a destination and import.</span>
              </div>
              <div className="flex gap-2">
                <span className="text-text-secondary font-medium shrink-0">4.</span>
                <span>Use <strong className="text-text-secondary">Safe Cull</strong> or <strong className="text-text-secondary">Best Shot</strong> to let AI pre-select for you.</span>
              </div>
            </div>
          </>
        ) : (
          <>
            <h3 className="text-[10px] text-text-muted uppercase tracking-wider mb-1">Quick Help</h3>
            <div className="space-y-0.5 text-[10px] text-text-muted">
              <div className="flex justify-between">
                <span>Open photo</span>
                <span className="text-text-secondary">Double-click</span>
              </div>
              <div className="flex justify-between">
                <span>Pick / Reject / Clear</span>
                <span className="text-text-secondary">P / X / U</span>
              </div>
              <div className="flex justify-between">
                <span>Star rating</span>
                <span className="text-text-secondary">1 – 5</span>
              </div>
              <div className="flex justify-between">
                <span>Range select</span>
                <span className="text-text-secondary">Shift+Click</span>
              </div>
              <div className="flex justify-between">
                <span>Select all</span>
                <span className="text-text-secondary">{MOD}+A</span>
              </div>
              <div className="flex justify-between">
                <span>Navigate</span>
                <span className="text-text-secondary">Arrows</span>
              </div>
              <div className="flex justify-between">
                <span>Deselect / Back</span>
                <span className="text-text-secondary">Esc</span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
