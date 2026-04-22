import { useMemo, useEffect, useState } from 'react';
import { useAppState, useAppDispatch } from '../context/ImportContext';
import { useImport } from '../hooks/useImport';
import type { SaveFormat, JobPreset } from '../../shared/types';
import { FOLDER_PRESETS, resolvePattern } from '../../shared/types';
import { formatSize } from '../utils/formatters';

const FORMAT_EXT: Record<string, string> = {
  jpeg: '.jpg',
  tiff: '.tiff',
  heic: '.heic',
};

const converterLabel =
  window.electronAPI.platform === 'darwin'
    ? 'sips'
    : window.electronAPI.platform === 'win32'
      ? 'Windows imaging'
      : 'ImageMagick';

function applyFormat(destPath: string, format: SaveFormat): string {
  if (format === 'original') return destPath;
  const ext = FORMAT_EXT[format];
  const lastDot = destPath.lastIndexOf('.');
  if (lastDot < 0) return destPath + ext;
  return destPath.slice(0, lastDot) + ext;
}

export function DestinationPanel() {
  const {
    destination, skipDuplicates, saveFormat, jpegQuality, folderPreset, customPattern,
    files, phase, selectedSource, selectedPaths, queuedPaths,
    separateProtected, protectedFolderName, backupDestRoot, ftpDestEnabled, ftpDestConfig,
    autoEject, playSoundOnComplete, completeSoundPath, openFolderOnComplete,
    verifyChecksums,
    autoImport, autoImportDestRoot,
    burstGrouping, burstWindowSec,
    normalizeExposure, exposureAnchorPath, exposureMaxStops,
  } = useAppState();
  const dispatch = useAppDispatch();
  const { startImport } = useImport();
  const [freeBytes, setFreeBytes] = useState<number | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [jobPresets, setJobPresets] = useState<JobPreset[]>([]);

  useEffect(() => {
    void window.electronAPI.getSettings().then((s) => setJobPresets(s.jobPresets ?? []));
  }, []);

  const handleChooseDestination = async () => {
    const folder = await window.electronAPI.selectFolder('Select Destination Folder');
    if (folder) {
      dispatch({ type: 'SET_DESTINATION', path: folder });
      window.electronAPI.setSettings({ lastDestination: folder });
    }
  };

  const handleChooseBackup = async () => {
    const folder = await window.electronAPI.selectFolder('Select Backup Destination (optional)');
    if (folder) {
      dispatch({ type: 'SET_WORKFLOW_STRING', key: 'backupDestRoot', value: folder });
      window.electronAPI.setSettings({ backupDestRoot: folder });
    }
  };

  const handleClearBackup = () => {
    dispatch({ type: 'SET_WORKFLOW_STRING', key: 'backupDestRoot', value: '' });
    window.electronAPI.setSettings({ backupDestRoot: '' });
  };

  const handleChooseAutoImportDest = async () => {
    const folder = await window.electronAPI.selectFolder('Select Auto-Import Destination');
    if (folder) {
      dispatch({ type: 'SET_WORKFLOW_STRING', key: 'autoImportDestRoot', value: folder });
      window.electronAPI.setSettings({ autoImportDestRoot: folder });
    }
  };

  const handleChooseCompleteSound = async () => {
    const file = await window.electronAPI.selectFile('Select Completion Sound', [
      { name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'aac', 'ogg', 'flac'] },
      { name: 'All Files', extensions: ['*'] },
    ]);
    if (!file) return;
    dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'playSoundOnComplete', value: true });
    dispatch({ type: 'SET_WORKFLOW_STRING', key: 'completeSoundPath', value: file });
    window.electronAPI.setSettings({ playSoundOnComplete: true, completeSoundPath: file });
  };

  const handleClearCompleteSound = () => {
    dispatch({ type: 'SET_WORKFLOW_STRING', key: 'completeSoundPath', value: '' });
    window.electronAPI.setSettings({ completeSoundPath: '' });
  };

  const handleToggleDuplicates = () => {
    const value = !skipDuplicates;
    dispatch({ type: 'SET_SKIP_DUPLICATES', value });
    window.electronAPI.setSettings({ skipDuplicates: value });
  };

  const handleFolderPreset = (preset: string) => {
    dispatch({ type: 'SET_FOLDER_PRESET', preset });
    window.electronAPI.setSettings({ folderPreset: preset });
  };

  const handleCustomPattern = (pattern: string) => {
    dispatch({ type: 'SET_CUSTOM_PATTERN', pattern });
    window.electronAPI.setSettings({ customPattern: pattern });
  };

  const handleFormatChange = (format: SaveFormat) => {
    dispatch({ type: 'SET_SAVE_FORMAT', format });
    window.electronAPI.setSettings({ saveFormat: format });
  };

  const handleQualityChange = (quality: number) => {
    dispatch({ type: 'SET_JPEG_QUALITY', quality });
    window.electronAPI.setSettings({ jpegQuality: quality });
  };

  const handleWorkflowBool = (
    key: 'separateProtected' | 'autoEject' | 'playSoundOnComplete' | 'openFolderOnComplete'
      | 'autoImport' | 'burstGrouping' | 'normalizeExposure' | 'verifyChecksums' | 'ftpDestEnabled',
    value: boolean,
  ) => {
    dispatch({ type: 'SET_WORKFLOW_OPTION', key, value });
    window.electronAPI.setSettings({ [key]: value } as Record<string, unknown>);
  };

  const handleBurstWindow = (seconds: number) => {
    dispatch({ type: 'SET_BURST_WINDOW', seconds });
    window.electronAPI.setSettings({ burstWindowSec: seconds });
  };

  const handleMaxStops = (stops: number) => {
    dispatch({ type: 'SET_EXPOSURE_MAX_STOPS', stops });
    window.electronAPI.setSettings({ exposureMaxStops: stops });
  };

  const handleFtpDestConfig = (config: Partial<typeof ftpDestConfig>) => {
    const next = { ...ftpDestConfig, ...config };
    dispatch({ type: 'SET_FTP_DEST_CONFIG', config });
    window.electronAPI.setSettings({ ftpDestConfig: next });
  };

  const currentPreset = (name: string): JobPreset => ({
    name,
    destRoot: destination || '',
    backupDestRoot,
    saveFormat,
    jpegQuality,
    folderPreset,
    customPattern,
    skipDuplicates,
    separateProtected,
    protectedFolderName,
  });

  const savePreset = () => {
    const name = window.prompt('Preset name');
    if (!name) return;
    const next = [...jobPresets.filter((p) => p.name !== name), currentPreset(name)];
    setJobPresets(next);
    window.electronAPI.setSettings({ jobPresets: next });
  };

  const applyPreset = (name: string) => {
    const preset = jobPresets.find((p) => p.name === name);
    if (!preset) return;
    if (preset.destRoot) dispatch({ type: 'SET_DESTINATION', path: preset.destRoot });
    dispatch({ type: 'SET_WORKFLOW_STRING', key: 'backupDestRoot', value: preset.backupDestRoot });
    dispatch({ type: 'SET_SAVE_FORMAT', format: preset.saveFormat });
    dispatch({ type: 'SET_JPEG_QUALITY', quality: preset.jpegQuality });
    dispatch({ type: 'SET_FOLDER_PRESET', preset: preset.folderPreset });
    dispatch({ type: 'SET_CUSTOM_PATTERN', pattern: preset.customPattern });
    dispatch({ type: 'SET_SKIP_DUPLICATES', value: preset.skipDuplicates });
    dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'separateProtected', value: preset.separateProtected });
    dispatch({ type: 'SET_WORKFLOW_STRING', key: 'protectedFolderName', value: preset.protectedFolderName });
    window.electronAPI.setSettings({ ...preset, lastDestination: preset.destRoot });
  };

  const deletePreset = () => {
    const name = window.prompt('Delete preset name');
    if (!name) return;
    const next = jobPresets.filter((p) => p.name !== name);
    setJobPresets(next);
    window.electronAPI.setSettings({ jobPresets: next });
  };

  const anchorFile = exposureAnchorPath ? files.find((f) => f.path === exposureAnchorPath) : null;
  const burstCount = useMemo(() => {
    const ids = new Set<string>();
    for (const f of files) if (f.burstId) ids.add(f.burstId);
    return ids.size;
  }, [files]);

  const handleProtectedFolderName = (value: string) => {
    dispatch({ type: 'SET_WORKFLOW_STRING', key: 'protectedFolderName', value });
    window.electronAPI.setSettings({ protectedFolderName: value });
  };

  const duplicateCount = files.filter((f) => f.duplicate).length;
  const pickedCount = files.filter((f) => f.pick === 'selected').length;
  const rejectedCount = files.filter((f) => f.pick === 'rejected').length;
  const protectedCount = files.filter((f) => f.isProtected).length;
  const adjustedCount = files.filter((f) => f.normalizeToAnchor || f.exposureAdjustmentStops).length;
  const hasPicks = pickedCount > 0;
  const hasClickSelection = selectedPaths.length > 0;
  const hasQueue = queuedPaths.length > 0;

  // Selection priority mirrors `useImport.ts`:
  //   1. Click-selection in the grid (selectedPaths)
  //   2. Pick flags (if any)
  //   3. Everything that isn't rejected and (optionally) isn't a duplicate
  const importFiles = useMemo(() => {
    if (hasQueue) {
      const paths = new Set(queuedPaths);
      return files.filter((f) => paths.has(f.path));
    }
    if (hasClickSelection) {
      const paths = new Set(selectedPaths);
      return files.filter((f) => paths.has(f.path));
    }
    if (hasPicks) {
      return files.filter((f) => f.pick === 'selected');
    }
    return skipDuplicates
      ? files.filter((f) => !f.duplicate && f.pick !== 'rejected')
      : files.filter((f) => f.pick !== 'rejected');
  }, [files, hasClickSelection, hasPicks, hasQueue, queuedPaths, skipDuplicates, selectedPaths]);

  const ftpReady = !ftpDestEnabled || (!!ftpDestConfig.host && !!ftpDestConfig.remotePath);
  const canImport = selectedSource && destination && ftpReady && importFiles.length > 0 && (phase === 'ready' || phase === 'scanning');
  const totalSize = importFiles.reduce((sum, f) => sum + f.size, 0);
  const exposureEditCount = importFiles.filter((f) => f.normalizeToAnchor || f.exposureAdjustmentStops).length;
  const backupSameAsPrimary = !!backupDestRoot && !!destination && backupDestRoot === destination;

  // Free-space check on the destination. Re-runs when the destination or
  // the set of files-to-import changes so the warning reflects reality.
  useEffect(() => {
    if (!destination) {
      setFreeBytes(null);
      return;
    }
    let cancelled = false;
    window.electronAPI.getDiskFreeSpace(destination)
      .then((bytes) => { if (!cancelled) setFreeBytes(bytes); })
      .catch(() => { if (!cancelled) setFreeBytes(null); });
    return () => { cancelled = true; };
  }, [destination, importFiles.length]);

  const spaceWarning = freeBytes !== null && totalSize > 0 && totalSize > freeBytes * 0.9;
  const insufficientSpace = freeBytes !== null && totalSize > 0 && totalSize > freeBytes;

  const activePattern = folderPreset === 'custom'
    ? customPattern
    : FOLDER_PRESETS[folderPreset]?.pattern ?? '{YYYY}-{MM}-{DD}/{filename}';

  const folders = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const f of files) {
      if (!f.dateTaken) continue;
      const date = new Date(f.dateTaken);
      let resolved = resolvePattern(activePattern, date, f.name, f.extension);
      resolved = applyFormat(resolved, saveFormat);
      // Apply protected-folder prefix in the preview
      if (f.isProtected && separateProtected) {
        const folder = (protectedFolderName || '_Protected').replace(/^[/\\]+|[/\\]+$/g, '');
        resolved = `${folder}/${resolved}`;
      }
      const slashIdx = resolved.lastIndexOf('/');
      const folder = slashIdx >= 0 ? resolved.slice(0, slashIdx) : '.';
      const fileName = slashIdx >= 0 ? resolved.slice(slashIdx + 1) : resolved;
      if (!map.has(folder)) map.set(folder, []);
      map.get(folder)!.push(fileName);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [files, activePattern, saveFormat, separateProtected, protectedFolderName]);

  return (
    <div className="flex flex-col h-full">
      <div className="px-2.5 py-2">
        <h2 className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Output</h2>
        {destination && (
          <div className="text-[10px] text-text-muted truncate mt-0.5" title={destination}>
            {destination}
          </div>
        )}
      </div>

      {/* Destination folder */}
      <div className="px-2.5 mb-2.5">
        <button
          onClick={handleChooseDestination}
          className="w-full px-2 py-1 text-xs bg-surface-raised hover:bg-border rounded text-text transition-colors text-left cursor-pointer"
        >
          {destination ? (
            <span className="truncate block" title={destination}>{destination.split(/[/\\]/).pop()}</span>
          ) : (
            'Choose Destination...'
          )}
        </button>
      </div>

      <div className="px-2.5 mb-2.5">
        <div className="flex items-center gap-1">
          <select
            value=""
            onChange={(e) => applyPreset(e.target.value)}
            className="min-w-0 flex-1 px-1.5 py-1 text-[11px] bg-surface-raised border border-border rounded text-text-secondary"
            title="Apply job preset"
          >
            <option value="">Job preset...</option>
            {jobPresets.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
          <button
            onClick={savePreset}
            className="px-1.5 py-1 text-[11px] bg-surface-raised hover:bg-border rounded text-text-secondary"
            title="Save current output settings as a preset"
          >
            Save
          </button>
          {jobPresets.length > 0 && (
            <button
              onClick={deletePreset}
              className="px-1.5 py-1 text-[11px] bg-surface-raised hover:bg-border rounded text-text-muted"
              title="Delete a saved preset by name"
            >
              Del
            </button>
          )}
        </div>
      </div>

      {files.length > 0 && (
        <div className="px-2.5 mb-2.5 grid grid-cols-2 gap-1 text-[10px] text-text-muted">
          <div className="bg-surface-raised rounded px-1.5 py-1">Picked <span className="text-yellow-400">{pickedCount}</span></div>
          <div className="bg-surface-raised rounded px-1.5 py-1">Rejected <span className="text-red-400">{rejectedCount}</span></div>
          <div className="bg-surface-raised rounded px-1.5 py-1">Protected <span className="text-emerald-400">{protectedCount}</span></div>
          <div className="bg-surface-raised rounded px-1.5 py-1">Queued <span className="text-emerald-400">{queuedPaths.length}</span></div>
        </div>
      )}

      {/* Settings */}
      <div className="px-2.5 mb-2.5">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={skipDuplicates}
            onChange={handleToggleDuplicates}
          />
          <span className="text-xs text-text">Skip duplicates</span>
        </label>
        <p className="text-[10px] text-text-muted mt-0.5 ml-5">
          Files matching name + size
        </p>
      </div>

      {/* Protected folder split */}
      <div className="px-2.5 mb-2.5">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={separateProtected}
            onChange={(e) => handleWorkflowBool('separateProtected', e.target.checked)}
          />
          <span className="text-xs text-text">Separate protected photos</span>
        </label>
        {separateProtected && (
          <div className="mt-1 ml-5">
            <input
              type="text"
              value={protectedFolderName}
              onChange={(e) => handleProtectedFolderName(e.target.value)}
              placeholder="_Protected"
              className="w-full px-1.5 py-1 text-[11px] font-mono bg-surface-raised border border-border rounded text-text placeholder-text-muted focus:border-text focus:outline-none"
            />
            <p className="text-[10px] text-text-muted mt-0.5">
              Subfolder for read-only/locked files
            </p>
          </div>
        )}
      </div>

      {/* Folder structure */}
      <div className="px-2.5 mb-2.5">
        <h3 className="text-[10px] text-text-secondary mb-1 uppercase tracking-wider">Folder Structure</h3>
        <select
          value={folderPreset}
          onChange={(e) => handleFolderPreset(e.target.value)}
          className="w-full px-1.5 py-1 text-[11px] font-mono bg-surface-raised border border-border rounded text-text focus:border-text focus:outline-none appearance-none cursor-pointer"
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
              className="w-full px-1.5 py-1 text-[11px] font-mono bg-surface-raised border border-border rounded text-text placeholder-text-muted focus:border-text focus:outline-none"
            />
            <p className="text-[9px] text-text-muted mt-0.5">
              {'{YYYY}'} {'{MM}'} {'{DD}'} {'{filename}'} {'{name}'} {'{ext}'}
            </p>
          </div>
        )}
      </div>

      {/* Save format */}
      <div className="px-2.5 mb-2.5">
        <h3 className="text-[10px] text-text-secondary mb-1 uppercase tracking-wider">Save Format</h3>
        <div className="grid grid-cols-2 gap-1">
          {([
            ['original', 'Original'],
            ['jpeg', 'JPEG'],
            ['tiff', 'TIFF'],
            ['heic', 'HEIC'],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              onClick={() => handleFormatChange(value)}
              className={`px-1.5 py-1 text-[11px] rounded transition-colors ${
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
          <div className="mt-1.5">
            <div className="flex items-center justify-between mb-0.5">
              <span className="text-[10px] text-text-secondary">Quality</span>
              <span className="text-[10px] text-text-secondary font-mono">{jpegQuality}%</span>
            </div>
            <input
              type="range"
              min={50}
              max={100}
              value={jpegQuality}
              onChange={(e) => handleQualityChange(Number(e.target.value))}
              className="w-full h-1 bg-surface-raised rounded appearance-none cursor-pointer accent-accent"
            />
          </div>
        )}
        {saveFormat !== 'original' && (
          <p className="text-[10px] text-text-muted mt-1">
            Files will be converted ({converterLabel})
          </p>
        )}
      </div>

      {/* Advanced workflow options — collapsed by default so the panel
          stays calm for casual users */}
      <div className="px-2.5 mb-2.5">
        <button
          onClick={() => setShowAdvanced((v) => !v)}
          className="w-full flex items-center justify-between text-[10px] text-text-secondary uppercase tracking-wider hover:text-text"
        >
          <span>Workflow</span>
          <span className="text-text-muted">{showAdvanced ? '-' : '+'}</span>
        </button>
        {showAdvanced && (
          <div className="mt-1.5 space-y-1.5">
            {/* Backup destination */}
            <div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-text">Backup copy</span>
                {backupDestRoot && (
                  <button
                    onClick={handleClearBackup}
                    className="text-[10px] text-text-muted hover:text-text"
                  >
                    clear
                  </button>
                )}
              </div>
              <button
                onClick={handleChooseBackup}
                className="w-full mt-0.5 px-1.5 py-1 text-[11px] bg-surface-raised hover:bg-border rounded text-text-secondary transition-colors text-left"
                title={backupDestRoot || 'Pick a second folder — each imported file will be copied there too'}
              >
                {backupDestRoot
                  ? <span className="truncate block">{backupDestRoot.split(/[/\\]/).pop()}</span>
                  : 'Choose backup folder...'}
              </button>
            </div>

            {/* Toggles */}
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={autoEject}
                onChange={(e) => handleWorkflowBool('autoEject', e.target.checked)}
              />
              <span className="text-xs text-text">Eject source when done</span>
            </label>

            <div className="pt-1 border-t border-border">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={ftpDestEnabled}
                  onChange={(e) => handleWorkflowBool('ftpDestEnabled', e.target.checked)}
                />
                <span className="text-xs text-text">Also upload to FTP</span>
              </label>
              {ftpDestEnabled && (
                <div className="mt-1 ml-5 space-y-1">
                  <div className="grid grid-cols-[1fr_3.75rem] gap-1">
                    <input
                      value={ftpDestConfig.host}
                      onChange={(e) => handleFtpDestConfig({ host: e.target.value })}
                      placeholder="ftp.example.com"
                      className="min-w-0 px-1.5 py-1 text-[11px] bg-surface-raised border border-border rounded text-text placeholder-text-muted focus:border-text focus:outline-none"
                    />
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      value={ftpDestConfig.port}
                      onChange={(e) => handleFtpDestConfig({ port: Number(e.target.value) || 21 })}
                      className="px-1.5 py-1 text-[11px] bg-surface-raised border border-border rounded text-text focus:border-text focus:outline-none"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-1">
                    <input
                      value={ftpDestConfig.user}
                      onChange={(e) => handleFtpDestConfig({ user: e.target.value })}
                      placeholder="user"
                      className="min-w-0 px-1.5 py-1 text-[11px] bg-surface-raised border border-border rounded text-text placeholder-text-muted focus:border-text focus:outline-none"
                    />
                    <input
                      type="password"
                      value={ftpDestConfig.password}
                      onChange={(e) => handleFtpDestConfig({ password: e.target.value })}
                      placeholder="password"
                      className="min-w-0 px-1.5 py-1 text-[11px] bg-surface-raised border border-border rounded text-text placeholder-text-muted focus:border-text focus:outline-none"
                    />
                  </div>
                  <input
                    value={ftpDestConfig.remotePath}
                    onChange={(e) => handleFtpDestConfig({ remotePath: e.target.value })}
                    placeholder="/PhotoImporter"
                    className="w-full px-1.5 py-1 text-[11px] font-mono bg-surface-raised border border-border rounded text-text placeholder-text-muted focus:border-text focus:outline-none"
                  />
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={ftpDestConfig.secure}
                      onChange={(e) => handleFtpDestConfig({ secure: e.target.checked })}
                    />
                    <span className="text-[11px] text-text-secondary">Use FTPS</span>
                  </label>
                </div>
              )}
            </div>

            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={playSoundOnComplete}
                onChange={(e) => handleWorkflowBool('playSoundOnComplete', e.target.checked)}
              />
              <span className="text-xs text-text">Play sound on complete</span>
            </label>
            {playSoundOnComplete && (
              <div className="ml-5 flex items-center gap-1">
                <button
                  onClick={handleChooseCompleteSound}
                  className="min-w-0 flex-1 px-1.5 py-1 text-[10px] bg-surface-raised hover:bg-border rounded text-text-secondary transition-colors text-left"
                  title={completeSoundPath || 'Choose a custom completion sound'}
                >
                  <span className="truncate block">
                    {completeSoundPath ? completeSoundPath.split(/[/\\]/).pop() : 'Choose custom sound...'}
                  </span>
                </button>
                {completeSoundPath && (
                  <button
                    onClick={handleClearCompleteSound}
                    className="text-[10px] text-text-muted hover:text-text"
                  >
                    clear
                  </button>
                )}
              </div>
            )}
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={openFolderOnComplete}
                onChange={(e) => handleWorkflowBool('openFolderOnComplete', e.target.checked)}
              />
              <span className="text-xs text-text">Open folder on complete</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={verifyChecksums}
                onChange={(e) => handleWorkflowBool('verifyChecksums', e.target.checked)}
              />
              <span className="text-xs text-text">Full checksum verify</span>
            </label>

            {/* Auto-import */}
            <div className="pt-1 border-t border-border">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoImport}
                  onChange={(e) => handleWorkflowBool('autoImport', e.target.checked)}
                />
                <span className="text-xs text-text">Auto-import on card insert</span>
              </label>
              {autoImport && (
                <div className="mt-1 ml-5">
                  <button
                    onClick={handleChooseAutoImportDest}
                    className="w-full px-1.5 py-1 text-[11px] bg-surface-raised hover:bg-border rounded text-text-secondary transition-colors text-left"
                  >
                    {autoImportDestRoot
                      ? <span className="truncate block">{autoImportDestRoot.split(/[/\\]/).pop()}</span>
                      : 'Choose auto-import folder...'}
                  </button>
                  <p className="text-[10px] text-text-muted mt-0.5">
                    When a card with a DCIM folder is inserted, it will import automatically using your saved settings.
                  </p>
                </div>
              )}
            </div>

            {/* Burst grouping */}
            <div className="pt-1 border-t border-border">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={burstGrouping}
                  onChange={(e) => handleWorkflowBool('burstGrouping', e.target.checked)}
                />
                <span className="text-xs text-text">Group burst shots</span>
              </label>
              {burstGrouping && (
                <div className="mt-1 ml-5">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-text-secondary">Window</span>
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
                    {burstCount > 0
                      ? <>Found <span className="text-text">{burstCount}</span> burst{burstCount !== 1 ? 's' : ''} &middot; B = select burst &middot; G = collapse</>
                      : <>B = select burst &middot; G = collapse/expand in the grid</>}
                  </p>
                </div>
              )}
            </div>

            {/* Exposure normalization */}
            <div className="pt-1 border-t border-border">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={normalizeExposure}
                  onChange={(e) => handleWorkflowBool('normalizeExposure', e.target.checked)}
                  disabled={saveFormat === 'original'}
                />
                <span className={`text-xs ${saveFormat === 'original' ? 'text-text-muted' : 'text-text'}`}>
                  Normalize exposure to anchor
                </span>
              </label>
              {saveFormat === 'original' && (
                <p className="text-[10px] text-text-muted mt-0.5 ml-5">
                  Requires a non-original save format (JPEG / TIFF / HEIC) so pixels can be rewritten.
                </p>
              )}
              {normalizeExposure && saveFormat !== 'original' && (
                <div className="mt-1 ml-5 space-y-1">
                  {anchorFile ? (
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-[10px] font-mono text-text truncate" title={anchorFile.path}>
                        {anchorFile.name}
                      </span>
                      <button
                        onClick={() => dispatch({ type: 'SET_EXPOSURE_ANCHOR', path: null })}
                        className="text-[10px] text-text-muted hover:text-text shrink-0"
                      >
                        clear
                      </button>
                    </div>
                  ) : (
                    <p className="text-[10px] text-text-muted">
                      Open a photo in detail view and click "Set as anchor".
                    </p>
                  )}
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-text-secondary">Max adjust</span>
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
                      title="Hard clamp on how far we'll push brightness"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Folder structure preview */}
      {folders.length > 0 && destination && (
        <div className="px-2.5 mb-2.5 flex-1 min-h-0 overflow-y-auto">
          <h3 className="text-[10px] text-text-secondary mb-1 uppercase tracking-wider">Folder Preview</h3>
          <div className="space-y-1.5">
            {folders.map(([folder, fileNames]) => (
              <div key={folder}>
                <div className="text-[10px] text-text-secondary font-mono font-medium">
                  {folder}/
                </div>
                {fileNames.slice(0, 5).map((name) => (
                  <div key={name} className="text-[10px] text-text-muted font-mono pl-2.5 truncate">
                    {name}
                  </div>
                ))}
                {fileNames.length > 5 && (
                  <div className="text-[10px] text-text-muted pl-2.5">
                    +{fileNames.length - 5} more
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Import summary + button */}
      <div className="mt-auto px-2.5 py-2 border-t border-border">
        {files.length > 0 && (
          <div className="mb-2 space-y-1">
            {exposureEditCount > 0 && saveFormat === 'original' && (
              <div className="text-[10px] text-yellow-500">Exposure edits need JPEG/TIFF/HEIC output.</div>
            )}
            {backupSameAsPrimary && (
              <div className="text-[10px] text-red-400">Backup destination matches primary.</div>
            )}
            {backupDestRoot && !backupSameAsPrimary && (
              <div className="text-[10px] text-emerald-500">Backup copy enabled.</div>
            )}
            {ftpDestEnabled && !ftpReady && (
              <div className="text-[10px] text-red-400">FTP output needs host and remote folder.</div>
            )}
            {ftpDestEnabled && ftpReady && (
              <div className="text-[10px] text-emerald-500">FTP upload enabled.</div>
            )}
          </div>
        )}
        {files.length > 0 && (
          <div className="text-[11px] text-text-secondary mb-2">
            {importFiles.length} file{importFiles.length !== 1 ? 's' : ''} &middot; {formatSize(totalSize)}
            {hasQueue && <span className="text-emerald-400/80"> &middot; {queuedPaths.length} queued</span>}
            {!hasQueue && hasClickSelection && <span className="text-blue-400/80"> &middot; {selectedPaths.length} selected</span>}
            {!hasQueue && !hasClickSelection && hasPicks && <span className="text-yellow-400/70"> &middot; {pickedCount} picked</span>}
            {skipDuplicates && duplicateCount > 0 && (
              <span className="text-yellow-500/70"> &middot; {duplicateCount} already imported</span>
            )}
          </div>
        )}
        {freeBytes !== null && totalSize > 0 && (spaceWarning || insufficientSpace) && (
          <div className={`text-[10px] mb-2 ${insufficientSpace ? 'text-red-400' : 'text-yellow-500'}`}>
            {insufficientSpace
              ? `Not enough free space — need ${formatSize(totalSize)}, have ${formatSize(freeBytes)}`
              : `Tight on space — ${formatSize(freeBytes)} free for ${formatSize(totalSize)} import`}
          </div>
        )}
        <button
          onClick={startImport}
          disabled={!canImport || insufficientSpace}
          className={`w-full py-1.5 rounded text-xs font-medium transition-colors ${
            canImport && !insufficientSpace
              ? 'bg-accent hover:bg-accent-hover text-white'
              : 'bg-surface-raised text-text-muted cursor-not-allowed'
          }`}
          title={
            !selectedSource ? 'Select a source volume first'
              : !destination ? 'Choose a destination folder first'
              : !ftpReady ? 'Finish FTP output settings first'
              : importFiles.length === 0 ? 'No files to import'
              : insufficientSpace ? 'Not enough free space on the destination'
              : !canImport ? `Cannot import while ${phase}`
              : undefined
          }
        >
          {!destination && files.length > 0
            ? 'Choose Destination First'
            : `${hasQueue ? 'Import Queue' : 'Import'} ${importFiles.length > 0 ? `${importFiles.length} File${importFiles.length !== 1 ? 's' : ''}` : ''}`
          }
        </button>
        {hasQueue && (
          <button
            onClick={() => dispatch({ type: 'QUEUE_CLEAR' })}
            className="w-full mt-1 py-1 rounded text-[10px] bg-surface-raised hover:bg-border text-text-secondary transition-colors"
            title="Clear import queue"
          >
            Clear Queue
          </button>
        )}
      </div>
    </div>
  );
}
