import { useState } from 'react';
import { useAppState, useAppDispatch } from '../context/ImportContext';
import type { SaveFormat } from '../../shared/types';
import { FOLDER_PRESETS } from '../../shared/types';

interface SettingsPageProps {
  onClose: () => void;
  /** When true, renders as a full-page view instead of a modal overlay */
  inline?: boolean;
}

export function SettingsPage({ onClose, inline = false }: SettingsPageProps) {
  const {
    theme,
    skipDuplicates,
    saveFormat,
    jpegQuality,
    folderPreset,
    customPattern,
    separateProtected,
    protectedFolderName,
    backupDestRoot,
    ftpDestEnabled,
    ftpDestConfig,
    autoEject,
    playSoundOnComplete,
    completeSoundPath,
    openFolderOnComplete,
    verifyChecksums,
    selectedSource,
    destination,
    autoImport,
    autoImportDestRoot,
    burstGrouping,
    burstWindowSec,
    normalizeExposure,
    exposureMaxStops,
    selectionSets,
  } = useAppState();
  const dispatch = useAppDispatch();
  const [postImportStatus, setPostImportStatus] = useState<string | null>(null);

  const set = <K extends string>(key: K, value: unknown) => {
    void window.electronAPI.setSettings({ [key]: value } as Record<string, unknown>);
  };

  const handleTheme = (t: 'light' | 'dark') => {
    dispatch({ type: 'SET_THEME', theme: t });
    set('theme', t);
  };

  const handleFolderPreset = (preset: string) => {
    dispatch({ type: 'SET_FOLDER_PRESET', preset });
    set('folderPreset', preset);
  };

  const handleCustomPattern = (pattern: string) => {
    dispatch({ type: 'SET_CUSTOM_PATTERN', pattern });
    set('customPattern', pattern);
  };

  const handleFormat = (format: SaveFormat) => {
    dispatch({ type: 'SET_SAVE_FORMAT', format });
    set('saveFormat', format);
  };

  const handleQuality = (quality: number) => {
    dispatch({ type: 'SET_JPEG_QUALITY', quality });
    set('jpegQuality', quality);
  };

  const handleSkipDuplicates = (value: boolean) => {
    dispatch({ type: 'SET_SKIP_DUPLICATES', value });
    set('skipDuplicates', value);
  };

  const handleWorkflowBool = (
    key: 'separateProtected' | 'autoEject' | 'playSoundOnComplete' | 'openFolderOnComplete'
      | 'autoImport' | 'burstGrouping' | 'normalizeExposure' | 'verifyChecksums',
    value: boolean,
  ) => {
    dispatch({ type: 'SET_WORKFLOW_OPTION', key, value });
    set(key, value);
  };

  const handleWorkflowString = (
    key: 'protectedFolderName' | 'backupDestRoot' | 'autoImportDestRoot' | 'completeSoundPath',
    value: string,
  ) => {
    dispatch({ type: 'SET_WORKFLOW_STRING', key, value });
    set(key, value);
  };

  const handleBurstWindow = (seconds: number) => {
    dispatch({ type: 'SET_BURST_WINDOW', seconds });
    set('burstWindowSec', seconds);
  };

  const handleMaxStops = (stops: number) => {
    dispatch({ type: 'SET_EXPOSURE_MAX_STOPS', stops });
    set('exposureMaxStops', stops);
  };

  const handleChooseBackup = async () => {
    const folder = await window.electronAPI.selectFolder('Select Backup Destination (optional)');
    if (folder) handleWorkflowString('backupDestRoot', folder);
  };

  const handleChooseAutoImportDest = async () => {
    const folder = await window.electronAPI.selectFolder('Select Auto-Import Destination');
    if (folder) handleWorkflowString('autoImportDestRoot', folder);
  };

  const handleFtpDestEnabled = (value: boolean) => {
    dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'ftpDestEnabled', value });
    set('ftpDestEnabled', value);
  };

  const handleFtpDestConfig = (config: Partial<typeof ftpDestConfig>) => {
    const next = { ...ftpDestConfig, ...config };
    dispatch({ type: 'SET_FTP_DEST_CONFIG', config });
    set('ftpDestConfig', next);
  };

  const handleChooseCompleteSound = async () => {
    const file = await window.electronAPI.selectFile('Select Completion Sound', [
      { name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'aac', 'ogg', 'flac'] },
      { name: 'All Files', extensions: ['*'] },
    ]);
    if (file) {
      handleWorkflowBool('playSoundOnComplete', true);
      handleWorkflowString('completeSoundPath', file);
    }
  };

  const playCompleteSound = () => {
    try {
      const soundSrc = completeSoundPath
        ? `file:///${completeSoundPath.replace(/\\/g, '/').replace(/^\/+/, '')}`
        : 'data:audio/wav;base64,UklGRjIAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQ4AAACAhIuQlJmbm5qYlJCMiA==';
      void new Audio(encodeURI(soundSrc)).play().catch(() => undefined);
    } catch { /* ignore */ }
  };

  const handleEjectCurrentSource = async () => {
    if (!selectedSource) return;
    setPostImportStatus('Ejecting source...');
    const result = await window.electronAPI.ejectVolume(selectedSource);
    setPostImportStatus(result.ok ? 'Source ejected.' : `Eject failed: ${result.error || 'volume may be busy'}`);
  };

  const handleOpenCurrentDestination = async () => {
    if (!destination) return;
    try {
      await window.electronAPI.openPath(destination);
      setPostImportStatus('Destination opened.');
    } catch (err) {
      setPostImportStatus(err instanceof Error ? err.message : 'Could not open destination.');
    }
  };

  const handleApplySelectionSet = (name: string) => {
    dispatch({ type: 'SELECTION_SET_APPLY', name });
    setPostImportStatus(`Applied selection set: ${name}`);
  };

  const handleDeleteSelectionSet = (name: string) => {
    const next = selectionSets.filter((s) => s.name !== name);
    dispatch({ type: 'SET_SELECTION_SETS', sets: next });
    set('selectionSets', next);
  };

  // Shared inner content (header + scrollable body)
  const inner = (
    <div className={`bg-surface border border-border ${inline ? 'flex flex-col h-full' : 'rounded-xl shadow-2xl w-[520px] max-h-[80vh] flex flex-col overflow-hidden'}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <h2 className="text-sm font-semibold text-text">Settings</h2>
        <button
          onClick={onClose}
          className="p-1 rounded text-text-muted hover:text-text hover:bg-surface-raised transition-colors"
          title={inline ? 'Back to grid (Esc)' : 'Close (Esc)'}
        >
          {inline ? (
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z" clipRule="evenodd" />
            </svg>
          ) : (
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          )}
        </button>
      </div>

      {/* Scrollable body */}
      <div className={`overflow-y-auto flex-1 space-y-5 ${inline ? 'px-6 py-4' : 'px-4 py-3'}`}>

          {/* Fast workflow */}
          <section>
            <h3 className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider mb-2">Fast Workflow</h3>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => window.dispatchEvent(new Event('photo-importer:tutorial'))}
                className="px-3 py-2 rounded bg-surface-raised hover:bg-border text-left"
              >
                <div className="text-xs text-text">Quick tutorial</div>
                <div className="text-[10px] text-text-muted mt-0.5">Source, cull, queue, import</div>
              </button>
              <button
                onClick={onClose}
                className="px-3 py-2 rounded bg-surface-raised hover:bg-border text-left"
              >
                <div className="text-xs text-text">Back to culling</div>
                <div className="text-[10px] text-text-muted mt-0.5">P pick, X reject, Shift+B best</div>
              </button>
            </div>
            <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-1 text-[10px] text-text-muted">
              <div className="bg-surface-alt border border-border rounded px-2 py-1" title="Keep review analysis local and pauseable from the toolbar.">Pause review</div>
              <div className="bg-surface-alt border border-border rounded px-2 py-1" title="Stop background preview generation when the laptop feels busy.">Stop loading</div>
              <div className="bg-surface-alt border border-border rounded px-2 py-1" title="Conservative burst/duplicate culling that never rejects protected, starred, or picked files.">Safe cull</div>
              <div className="bg-surface-alt border border-border rounded px-2 py-1" title="Copy and paste manual EV offsets across a batch.">Copy EV</div>
            </div>
            <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-1 text-[10px] text-text-muted">
              <div className="bg-surface-alt border border-border rounded px-2 py-1">Arrow keys move</div>
              <div className="bg-surface-alt border border-border rounded px-2 py-1">0-5 rate</div>
              <div className="bg-surface-alt border border-border rounded px-2 py-1">Space original</div>
              <div className="bg-surface-alt border border-border rounded px-2 py-1">[ ] exposure</div>
            </div>
          </section>

          {/* Appearance */}
          <section>
            <h3 className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider mb-2">Appearance</h3>
            <div className="flex gap-2">
              {(['light', 'dark'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => handleTheme(t)}
                  className={`px-3 py-1 text-xs rounded transition-colors ${
                    theme === t ? 'bg-accent text-white' : 'bg-surface-raised text-text-secondary hover:text-text'
                  }`}
                >
                  {t === 'light' ? '☀ Light' : '☾ Dark'}
                </button>
              ))}
            </div>
          </section>

          {/* Import */}
          <section>
            <h3 className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider mb-2">Import</h3>
            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={skipDuplicates}
                  onChange={(e) => handleSkipDuplicates(e.target.checked)}
                />
                <span className="text-xs text-text">Skip duplicates</span>
                <span className="text-[10px] text-text-muted">(match by name + size)</span>
              </label>
            </div>
          </section>

          {/* Folder structure */}
          <section>
            <h3 className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider mb-2">Folder Structure</h3>
            <select
              value={folderPreset}
              onChange={(e) => handleFolderPreset(e.target.value)}
              className="w-full px-2 py-1 text-xs font-mono bg-surface-raised border border-border rounded text-text focus:border-text focus:outline-none appearance-none cursor-pointer"
            >
              {Object.entries(FOLDER_PRESETS).map(([key, { label }]) => (
                <option key={key} value={key}>{label}</option>
              ))}
              <option value="custom">Custom</option>
            </select>
            {folderPreset === 'custom' && (
              <div className="mt-1.5">
                <input
                  type="text"
                  value={customPattern}
                  onChange={(e) => handleCustomPattern(e.target.value)}
                  placeholder="{YYYY}-{MM}-{DD}/{filename}"
                  className="w-full px-2 py-1 text-xs font-mono bg-surface-raised border border-border rounded text-text placeholder-text-muted focus:border-text focus:outline-none"
                />
                <p className="text-[10px] text-text-muted mt-0.5">
                  {'{YYYY}'} {'{MM}'} {'{DD}'} {'{filename}'} {'{name}'} {'{ext}'}
                </p>
              </div>
            )}
          </section>

          {/* Save format */}
          <section>
            <h3 className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider mb-2">Save Format</h3>
            <div className="grid grid-cols-4 gap-1">
              {([
                ['original', 'Original'],
                ['jpeg', 'JPEG'],
                ['tiff', 'TIFF'],
                ['heic', 'HEIC'],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => handleFormat(value)}
                  className={`px-1.5 py-1 text-xs rounded transition-colors ${
                    saveFormat === value
                      ? 'bg-accent text-white'
                      : 'bg-surface-raised text-text-secondary hover:text-text hover:bg-accent/10'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {saveFormat === 'jpeg' && (
              <div className="mt-2">
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-[10px] text-text-secondary">JPEG Quality</span>
                  <span className="text-[10px] text-text-secondary font-mono">{jpegQuality}%</span>
                </div>
                <input
                  type="range"
                  min={50}
                  max={100}
                  value={jpegQuality}
                  onChange={(e) => handleQuality(Number(e.target.value))}
                  className="w-full h-1 bg-surface-raised rounded appearance-none cursor-pointer accent-accent"
                />
              </div>
            )}
          </section>

          {/* Protected files */}
          <section>
            <h3 className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider mb-2">Protected Files</h3>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={separateProtected}
                onChange={(e) => handleWorkflowBool('separateProtected', e.target.checked)}
              />
              <span className="text-xs text-text">Separate protected photos into their own subfolder</span>
            </label>
            {separateProtected && (
              <div className="mt-1.5 ml-5">
                <input
                  type="text"
                  value={protectedFolderName}
                  onChange={(e) => handleWorkflowString('protectedFolderName', e.target.value)}
                  placeholder="_Protected"
                  className="w-full px-2 py-1 text-xs font-mono bg-surface-raised border border-border rounded text-text placeholder-text-muted focus:border-text focus:outline-none"
                />
              </div>
            )}
          </section>

          {/* Selection sets */}
          {selectionSets.length > 0 && (
            <section>
              <h3 className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider mb-2">Selection Sets</h3>
              <div className="space-y-1">
                {selectionSets.map((setItem) => (
                  <div key={setItem.name} className="flex items-center gap-2 text-xs">
                    <button
                      onClick={() => handleApplySelectionSet(setItem.name)}
                      className="min-w-0 flex-1 px-2 py-1 bg-surface-raised hover:bg-border rounded text-text-secondary text-left truncate"
                      title={`${setItem.paths.length} file(s)`}
                    >
                      {setItem.name}
                    </button>
                    <span className="text-[10px] text-text-muted font-mono">{setItem.paths.length}</span>
                    <button
                      onClick={() => handleDeleteSelectionSet(setItem.name)}
                      className="text-[10px] text-text-muted hover:text-red-300"
                    >
                      delete
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Backup */}
          <section>
            <h3 className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider mb-2">Backup Copy</h3>
            <div className="flex items-center gap-2">
              <button
                onClick={handleChooseBackup}
                className="flex-1 px-2 py-1 text-xs bg-surface-raised hover:bg-border rounded text-text-secondary transition-colors text-left truncate"
                title={backupDestRoot || 'Pick a second destination — each imported file will be mirrored there'}
              >
                {backupDestRoot
                  ? <span className="truncate">{backupDestRoot}</span>
                  : 'Choose backup folder...'}
              </button>
              {backupDestRoot && (
                <button
                  onClick={() => handleWorkflowString('backupDestRoot', '')}
                  className="text-[10px] text-text-muted hover:text-text shrink-0"
                >
                  clear
                </button>
              )}
            </div>
          </section>

          {/* Post-import actions */}
          <section>
            <h3 className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider mb-2">After Import</h3>
            <div className="space-y-1.5">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoEject}
                  onChange={(e) => handleWorkflowBool('autoEject', e.target.checked)}
                />
                <span className="text-xs text-text">Eject source when done</span>
              </label>
              <div className="ml-5">
                <button
                  onClick={handleEjectCurrentSource}
                  disabled={!selectedSource}
                  className="px-2 py-1 text-[10px] bg-surface-raised hover:bg-border rounded text-text-secondary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Eject current source
                </button>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={playSoundOnComplete}
                  onChange={(e) => handleWorkflowBool('playSoundOnComplete', e.target.checked)}
                />
                <span className="text-xs text-text">Play sound on complete</span>
              </label>
              <div className="ml-5 flex items-center gap-1.5">
                <button
                  onClick={handleChooseCompleteSound}
                  className="min-w-0 flex-1 px-2 py-1 text-[10px] bg-surface-raised hover:bg-border rounded text-text-secondary transition-colors text-left truncate"
                  title={completeSoundPath || 'Choose a custom completion sound'}
                >
                  {completeSoundPath ? completeSoundPath.split(/[/\\]/).pop() : 'Choose sound...'}
                </button>
                <button
                  onClick={playCompleteSound}
                  className="px-2 py-1 text-[10px] bg-surface-raised hover:bg-border rounded text-text-secondary transition-colors"
                >
                  Test
                </button>
                {completeSoundPath && (
                  <button
                    onClick={() => handleWorkflowString('completeSoundPath', '')}
                    className="text-[10px] text-text-muted hover:text-text"
                  >
                    clear
                  </button>
                )}
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={openFolderOnComplete}
                  onChange={(e) => handleWorkflowBool('openFolderOnComplete', e.target.checked)}
                />
                <span className="text-xs text-text">Open destination folder on complete</span>
              </label>
              <div className="ml-5">
                <button
                  onClick={handleOpenCurrentDestination}
                  disabled={!destination}
                  className="px-2 py-1 text-[10px] bg-surface-raised hover:bg-border rounded text-text-secondary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Open current destination
                </button>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={verifyChecksums}
                  onChange={(e) => handleWorkflowBool('verifyChecksums', e.target.checked)}
                />
                <span className="text-xs text-text">Full checksum verification</span>
              </label>
              {postImportStatus && (
                <p className="ml-5 text-[10px] text-text-muted">{postImportStatus}</p>
              )}
            </div>
          </section>

          {/* FTP output */}
          <section>
            <h3 className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider mb-2">FTP Output</h3>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={ftpDestEnabled}
                onChange={(e) => handleFtpDestEnabled(e.target.checked)}
              />
              <span className="text-xs text-text">Also upload imported files to FTP/FTPS</span>
            </label>
            {ftpDestEnabled && (
              <div className="mt-2 ml-5 space-y-1.5">
                <div className="grid grid-cols-[1fr_4.5rem] gap-1.5">
                  <input
                    value={ftpDestConfig.host}
                    onChange={(e) => handleFtpDestConfig({ host: e.target.value })}
                    placeholder="ftp.example.com"
                    className="min-w-0 px-2 py-1 text-xs bg-surface-raised border border-border rounded text-text placeholder-text-muted focus:border-text focus:outline-none"
                  />
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={ftpDestConfig.port}
                    onChange={(e) => handleFtpDestConfig({ port: Number(e.target.value) || 21 })}
                    className="px-2 py-1 text-xs bg-surface-raised border border-border rounded text-text focus:border-text focus:outline-none"
                  />
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <input
                    value={ftpDestConfig.user}
                    onChange={(e) => handleFtpDestConfig({ user: e.target.value })}
                    placeholder="user"
                    className="min-w-0 px-2 py-1 text-xs bg-surface-raised border border-border rounded text-text placeholder-text-muted focus:border-text focus:outline-none"
                  />
                  <input
                    type="password"
                    value={ftpDestConfig.password}
                    onChange={(e) => handleFtpDestConfig({ password: e.target.value })}
                    placeholder="password"
                    className="min-w-0 px-2 py-1 text-xs bg-surface-raised border border-border rounded text-text placeholder-text-muted focus:border-text focus:outline-none"
                  />
                </div>
                <input
                  value={ftpDestConfig.remotePath}
                  onChange={(e) => handleFtpDestConfig({ remotePath: e.target.value })}
                  placeholder="/PhotoImporter"
                  className="w-full px-2 py-1 text-xs font-mono bg-surface-raised border border-border rounded text-text placeholder-text-muted focus:border-text focus:outline-none"
                />
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={ftpDestConfig.secure}
                    onChange={(e) => handleFtpDestConfig({ secure: e.target.checked })}
                  />
                  <span className="text-xs text-text">Use FTPS</span>
                </label>
              </div>
            )}
          </section>

          {/* Auto-import */}
          <section>
            <h3 className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider mb-2">Auto-Import</h3>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={autoImport}
                onChange={(e) => handleWorkflowBool('autoImport', e.target.checked)}
              />
              <span className="text-xs text-text">Auto-import on card insert</span>
            </label>
            {autoImport && (
              <div className="mt-1.5 ml-5">
                <button
                  onClick={handleChooseAutoImportDest}
                  className="w-full px-2 py-1 text-xs bg-surface-raised hover:bg-border rounded text-text-secondary transition-colors text-left truncate"
                >
                  {autoImportDestRoot || 'Choose auto-import folder...'}
                </button>
                <p className="text-[10px] text-text-muted mt-0.5">
                  When a DCIM card is inserted, it imports automatically using your saved settings.
                </p>
              </div>
            )}
          </section>

          {/* Burst grouping */}
          <section>
            <h3 className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider mb-2">Burst Shots</h3>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={burstGrouping}
                onChange={(e) => handleWorkflowBool('burstGrouping', e.target.checked)}
              />
              <span className="text-xs text-text">Group burst shots</span>
            </label>
            {burstGrouping && (
              <div className="mt-2 ml-5">
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-[10px] text-text-secondary">Burst window</span>
                  <span className="text-[10px] text-text-secondary font-mono">{burstWindowSec.toFixed(2)}s</span>
                </div>
                <input
                  type="range"
                  min={0.5}
                  max={5}
                  step={0.25}
                  value={burstWindowSec}
                  onChange={(e) => handleBurstWindow(Number(e.target.value))}
                  className="w-full h-1 bg-surface-raised rounded appearance-none cursor-pointer accent-accent"
                  title="Max gap between consecutive shots to count as one burst"
                />
                <p className="text-[10px] text-text-muted mt-0.5">
                  B = select burst · G = collapse/expand in the grid
                </p>
              </div>
            )}
          </section>

          {/* Exposure normalization */}
          <section>
            <h3 className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider mb-2">Exposure</h3>
            <label className={`flex items-center gap-2 ${saveFormat === 'original' ? 'opacity-50' : 'cursor-pointer'}`}>
              <input
                type="checkbox"
                checked={normalizeExposure}
                onChange={(e) => handleWorkflowBool('normalizeExposure', e.target.checked)}
                disabled={saveFormat === 'original'}
              />
              <span className="text-xs text-text">Normalize exposure to anchor</span>
            </label>
            {saveFormat === 'original' && (
              <p className="text-[10px] text-text-muted mt-0.5 ml-5">
                Requires a non-original save format (JPEG / TIFF / HEIC).
              </p>
            )}
            {normalizeExposure && saveFormat !== 'original' && (
              <div className="mt-2 ml-5">
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-[10px] text-text-secondary">Max adjustment</span>
                  <span className="text-[10px] text-text-secondary font-mono">±{exposureMaxStops.toFixed(2)} stops</span>
                </div>
                <input
                  type="range"
                  min={0.33}
                  max={4}
                  step={0.33}
                  value={exposureMaxStops}
                  onChange={(e) => handleMaxStops(Number(e.target.value))}
                  className="w-full h-1 bg-surface-raised rounded appearance-none cursor-pointer accent-accent"
                />
              </div>
            )}
          </section>

        </div>
      </div>
  );

  if (inline) {
    return <div className="h-full flex flex-col overflow-hidden">{inner}</div>;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {inner}
    </div>
  );
}
