import { useMemo, useEffect, useState } from 'react';
import { useAppState, useAppDispatch } from '../context/ImportContext';
import { useImport } from '../hooks/useImport';
import { ImportResumeView } from './ImportResumeView';
import type { AppSettings, EventMode, SaveFormat, JobPreset, ImportConfig, ImportPreflight, ImportBenchmarkResult, ImportConflictPolicy, MetadataExportFlags, SourceProfile } from '../../shared/types';
import { DEFAULT_METADATA_EXPORT, EVENT_MODE_PRESETS, FOLDER_PRESETS, eventModeKeywords, resolvePattern } from '../../shared/types';
import { formatSize } from '../utils/formatters';
import { formatWhiteBalanceKelvin, kelvinToWhiteBalanceTemperature, WHITE_BALANCE_MAX_KELVIN, WHITE_BALANCE_MIN_KELVIN, whiteBalanceTemperatureToKelvin } from '../../shared/exposure';
import { getSecondPassReasons, needsSecondPass } from '../../shared/review-lane';

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

const isMeaningfulSceneLabel = (label?: string | null) => {
  const normalized = label?.trim().toLowerCase();
  return !!normalized && normalized !== 'scene' && normalized !== 'general';
};

function applyFormat(destPath: string, format: SaveFormat): string {
  if (format === 'original') return destPath;
  const ext = FORMAT_EXT[format];
  const lastDot = destPath.lastIndexOf('.');
  if (lastDot < 0) return destPath + ext;
  return destPath.slice(0, lastDot) + ext;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'under 1s';
  const rounded = Math.max(1, Math.round(seconds));
  if (rounded < 60) return `${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  if (minutes < 60) return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  return minuteRemainder > 0 ? `${hours}h ${minuteRemainder}m` : `${hours}h`;
}

function sourceSpeedMbps(profile: SourceProfile): number {
  if (profile === 'ssd') return 350;
  if (profile === 'usb') return 90;
  if (profile === 'nas') return 45;
  return 120;
}

const FAST_RAW_METADATA_EXPORT: MetadataExportFlags = {
  keywords: false,
  title: false,
  caption: false,
  creator: false,
  copyright: false,
  rating: false,
  pickLabel: false,
  stripGps: false,
};

type SpeedProfileId = 'fast-ingest' | 'balanced-review' | 'deep-ai';
type OutputPanelMode = 'import' | 'speed' | 'rules';

const SPEED_PROFILES: Array<{
  id: SpeedProfileId;
  label: string;
  description: string;
  settings: Partial<AppSettings>;
}> = [
  {
    id: 'fast-ingest',
    label: 'Fast ingest',
    description: 'Original copy, no checksums, no duplicate checks, no sidecars, no backup/FTP, low preview load, AI review off.',
    settings: {
      sourceProfile: 'usb',
      saveFormat: 'original',
      skipDuplicates: false,
      verifyChecksums: false,
      backupDestRoot: '',
      ftpDestEnabled: false,
      normalizeExposure: false,
      autoStraighten: false,
      watermarkEnabled: false,
      metadataExport: FAST_RAW_METADATA_EXPORT,
      fastKeeperMode: true,
      autoSpeedMode: true,
      perfTier: 'low',
      cpuOptimization: true,
      previewConcurrency: 1,
      faceConcurrency: 1,
      rawPreviewQuality: 55,
      reviewFaceAnalysis: false,
      reviewFaceMatching: false,
      reviewPersonDetection: false,
      reviewVisualDuplicates: false,
    },
  },
  {
    id: 'balanced-review',
    label: 'Balanced review',
    description: 'Keeps face/group review on with moderate preview load, duplicate checks on, and heavy import mirrors off.',
    settings: {
      sourceProfile: 'auto',
      saveFormat: 'original',
      skipDuplicates: true,
      verifyChecksums: false,
      backupDestRoot: '',
      ftpDestEnabled: false,
      metadataExport: DEFAULT_METADATA_EXPORT,
      fastKeeperMode: false,
      autoSpeedMode: true,
      perfTier: 'balanced',
      cpuOptimization: true,
      previewConcurrency: 2,
      faceConcurrency: 2,
      rawPreviewQuality: 70,
      reviewFaceAnalysis: true,
      reviewFaceMatching: true,
      reviewPersonDetection: true,
      reviewVisualDuplicates: true,
    },
  },
  {
    id: 'deep-ai',
    label: 'Deep AI scan',
    description: 'Full face/person/duplicate analysis, sharper previews, duplicate checks and checksum verification on.',
    settings: {
      sourceProfile: 'ssd',
      saveFormat: 'original',
      skipDuplicates: true,
      verifyChecksums: true,
      backupDestRoot: '',
      ftpDestEnabled: false,
      metadataExport: DEFAULT_METADATA_EXPORT,
      fastKeeperMode: false,
      autoSpeedMode: false,
      perfTier: 'high',
      cpuOptimization: false,
      previewConcurrency: 4,
      faceConcurrency: 4,
      rawPreviewQuality: 84,
      reviewFaceAnalysis: true,
      reviewFaceMatching: true,
      reviewPersonDetection: true,
      reviewVisualDuplicates: true,
    },
  },
];

export function DestinationPanel() {
  const {
    destination, skipDuplicates, saveFormat, jpegQuality, folderPreset, customPattern,
    files, phase, importProgress, importResult, selectedSource, selectedPaths, queuedPaths,
    separateProtected, protectedFolderName, backupDestRoot, ftpDestEnabled, ftpDestConfig,
    metadataKeywords, metadataTitle, metadataCaption, metadataCreator, metadataCopyright,
    watermarkEnabled, watermarkMode, watermarkText, watermarkImagePath, watermarkOpacity, watermarkPositionLandscape, watermarkPositionPortrait, watermarkScale,
    autoStraighten,
    whiteBalanceTemperature, whiteBalanceTint, eventMode, metadataExport,
    verifyChecksums,
    sourceProfile, conflictPolicy, conflictFolderName,
    previewConcurrency, faceConcurrency, rawPreviewQuality,
    reviewFaceAnalysis, reviewFaceMatching, reviewPersonDetection, reviewVisualDuplicates,
    fastKeeperMode, autoSpeedMode,
    licenseStatus,
  } = useAppState();
  const dispatch = useAppDispatch();
  const { startImport } = useImport();
  const [freeBytes, setFreeBytes] = useState<number | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showTransforms, setShowTransforms] = useState(false);
  const [outputMode, setOutputMode] = useState<OutputPanelMode>('import');
  const [jobPresets, setJobPresets] = useState<JobPreset[]>([]);
  const [selectedPresetName, setSelectedPresetName] = useState('');
  const [preflight, setPreflight] = useState<ImportPreflight | null>(null);
  const [preflightOpen, setPreflightOpen] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [benchmarkOpen, setBenchmarkOpen] = useState(false);
  const [benchmarkBusy, setBenchmarkBusy] = useState(false);
  const [realBenchmark, setRealBenchmark] = useState<ImportBenchmarkResult | null>(null);

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
    key: 'separateProtected' | 'ftpDestEnabled',
    value: boolean,
  ) => {
    dispatch({ type: 'SET_WORKFLOW_OPTION', key, value });
    window.electronAPI.setSettings({ [key]: value } as Record<string, unknown>);
  };

  const handleExportLightroomHandoff = async () => {
    if (handoffBusy || files.length === 0) return;
    const existingDir = importResult?.lightroomHandoff?.outputDir;
    if (existingDir) {
      void window.electronAPI.openPath(existingDir);
      return;
    }
    setHandoffBusy(true);
    try {
      const handoff = await window.electronAPI.exportLightroomHandoff(files);
      if (handoff?.outputDir) void window.electronAPI.openPath(handoff.outputDir);
    } finally {
      setHandoffBusy(false);
    }
  };

  const handleSourceProfile = (profile: SourceProfile) => {
    const profileSettings = profile === 'ssd'
      ? { previewConcurrency: Math.max(4, previewConcurrency), faceConcurrency: Math.max(2, faceConcurrency), rawPreviewQuality: Math.max(78, rawPreviewQuality) }
      : profile === 'usb'
        ? { previewConcurrency: 1, faceConcurrency: 1, rawPreviewQuality: Math.min(rawPreviewQuality, 65) }
        : profile === 'nas'
          ? { previewConcurrency: 1, faceConcurrency: 1, rawPreviewQuality: Math.min(rawPreviewQuality, 68), rawPreviewCache: true }
          : {};
    dispatch({ type: 'SET_SOURCE_PROFILE', profile });
    window.electronAPI.setSettings({ sourceProfile: profile, ...profileSettings });
    if ('faceConcurrency' in profileSettings && typeof profileSettings.faceConcurrency === 'number') {
      void window.electronAPI.setFaceAnalysisConcurrency(profileSettings.faceConcurrency);
    }
  };

  const applySpeedProfile = (profileId: SpeedProfileId) => {
    const profile = SPEED_PROFILES.find((item) => item.id === profileId);
    if (!profile) return;
    const settings = profile.settings;

    if (settings.perfTier) dispatch({ type: 'SET_PERF_TIER', tier: settings.perfTier });
    if (settings.sourceProfile) dispatch({ type: 'SET_SOURCE_PROFILE', profile: settings.sourceProfile });
    if (settings.saveFormat) dispatch({ type: 'SET_SAVE_FORMAT', format: settings.saveFormat });
    if (typeof settings.skipDuplicates === 'boolean') dispatch({ type: 'SET_SKIP_DUPLICATES', value: settings.skipDuplicates });
    if (typeof settings.verifyChecksums === 'boolean') dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'verifyChecksums', value: settings.verifyChecksums });
    if (typeof settings.ftpDestEnabled === 'boolean') dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'ftpDestEnabled', value: settings.ftpDestEnabled });
    if (typeof settings.backupDestRoot === 'string') dispatch({ type: 'SET_WORKFLOW_STRING', key: 'backupDestRoot', value: settings.backupDestRoot });
    if (typeof settings.normalizeExposure === 'boolean') dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'normalizeExposure', value: settings.normalizeExposure });
    if (typeof settings.autoStraighten === 'boolean') dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'autoStraighten', value: settings.autoStraighten });
    if (typeof settings.watermarkEnabled === 'boolean') dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'watermarkEnabled', value: settings.watermarkEnabled });
    if (settings.metadataExport) dispatch({ type: 'SET_METADATA_EXPORT', flags: settings.metadataExport });
    if (typeof settings.fastKeeperMode === 'boolean') dispatch({ type: 'SET_FAST_KEEPER_MODE', enabled: settings.fastKeeperMode });
    if (typeof settings.autoSpeedMode === 'boolean') dispatch({ type: 'SET_AUTO_SPEED_MODE', enabled: settings.autoSpeedMode });
    if (typeof settings.cpuOptimization === 'boolean') dispatch({ type: 'SET_PERFORMANCE_OPTION', key: 'cpuOptimization', value: settings.cpuOptimization });
    if (typeof settings.previewConcurrency === 'number') dispatch({ type: 'SET_PREVIEW_CONCURRENCY', concurrency: settings.previewConcurrency });
    if (typeof settings.faceConcurrency === 'number') dispatch({ type: 'SET_FACE_CONCURRENCY', concurrency: settings.faceConcurrency });
    if (typeof settings.rawPreviewQuality === 'number') dispatch({ type: 'SET_RAW_PREVIEW_QUALITY', quality: settings.rawPreviewQuality });
    if (typeof settings.reviewFaceAnalysis === 'boolean') dispatch({ type: 'SET_REVIEW_PERFORMANCE_OPTION', key: 'reviewFaceAnalysis', value: settings.reviewFaceAnalysis });
    if (typeof settings.reviewFaceMatching === 'boolean') dispatch({ type: 'SET_REVIEW_PERFORMANCE_OPTION', key: 'reviewFaceMatching', value: settings.reviewFaceMatching });
    if (typeof settings.reviewPersonDetection === 'boolean') dispatch({ type: 'SET_REVIEW_PERFORMANCE_OPTION', key: 'reviewPersonDetection', value: settings.reviewPersonDetection });
    if (typeof settings.reviewVisualDuplicates === 'boolean') dispatch({ type: 'SET_REVIEW_PERFORMANCE_OPTION', key: 'reviewVisualDuplicates', value: settings.reviewVisualDuplicates });

    setRealBenchmark(null);
    void window.electronAPI.setSettings(settings);
    if (typeof settings.faceConcurrency === 'number') {
      void window.electronAPI.setFaceAnalysisConcurrency?.(settings.faceConcurrency);
    }
  };

  const handleConflictPolicy = (policy: ImportConflictPolicy) => {
    dispatch({ type: 'SET_CONFLICT_POLICY', policy });
    window.electronAPI.setSettings({ defaultConflictPolicy: policy });
  };

  const handleConflictFolderName = (value: string) => {
    dispatch({ type: 'SET_WORKFLOW_STRING', key: 'conflictFolderName', value });
    window.electronAPI.setSettings({ conflictFolderName: value });
  };

  const handleWhiteBalance = (temperature: number, tint: number) => {
    dispatch({ type: 'SET_WHITE_BALANCE', temperature, tint });
    window.electronAPI.setSettings({ whiteBalanceTemperature: temperature, whiteBalanceTint: tint });
  };

  const handleOpenDestination = () => {
    if (destination) void window.electronAPI.openPath(destination);
  };

  const handleEventMode = (mode: EventMode) => {
    dispatch({ type: 'SET_EVENT_MODE', mode });
    window.electronAPI.setSettings({ eventMode: mode });
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
    eventMode,
  });

  const savePreset = () => {
    const name = window.prompt('Preset name');
    if (!name) return;
    const next = [...jobPresets.filter((p) => p.name !== name), currentPreset(name)];
    setJobPresets(next);
    setSelectedPresetName(name);
    window.electronAPI.setSettings({ jobPresets: next });
  };

  const applyPreset = (name: string) => {
    const preset = jobPresets.find((p) => p.name === name);
    if (!preset) return;
    setSelectedPresetName(name);
    if (preset.destRoot) dispatch({ type: 'SET_DESTINATION', path: preset.destRoot });
    dispatch({ type: 'SET_WORKFLOW_STRING', key: 'backupDestRoot', value: preset.backupDestRoot });
    dispatch({ type: 'SET_SAVE_FORMAT', format: preset.saveFormat });
    dispatch({ type: 'SET_JPEG_QUALITY', quality: preset.jpegQuality });
    dispatch({ type: 'SET_FOLDER_PRESET', preset: preset.folderPreset });
    dispatch({ type: 'SET_CUSTOM_PATTERN', pattern: preset.customPattern });
    dispatch({ type: 'SET_SKIP_DUPLICATES', value: preset.skipDuplicates });
    dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'separateProtected', value: preset.separateProtected });
    dispatch({ type: 'SET_WORKFLOW_STRING', key: 'protectedFolderName', value: preset.protectedFolderName });
    if (preset.eventMode) dispatch({ type: 'SET_EVENT_MODE', mode: preset.eventMode });
    window.electronAPI.setSettings({
      ...preset,
      ...(preset.destRoot ? { lastDestination: preset.destRoot } : {}),
    });
  };

  const deletePreset = () => {
    const name = selectedPresetName || jobPresets[0]?.name;
    if (!name) return;
    if (!window.confirm(`Delete preset "${name}"?`)) return;
    const next = jobPresets.filter((p) => p.name !== name);
    setJobPresets(next);
    setSelectedPresetName('');
    window.electronAPI.setSettings({ jobPresets: next });
  };

  const handleProtectedFolderName = (value: string) => {
    dispatch({ type: 'SET_WORKFLOW_STRING', key: 'protectedFolderName', value });
    window.electronAPI.setSettings({ protectedFolderName: value });
  };

  const duplicateCount = files.filter((f) => f.duplicate).length;
  const pickedCount = files.filter((f) => f.pick === 'selected').length;
  const rejectedCount = files.filter((f) => f.pick === 'rejected').length;
  const protectedCount = files.filter((f) => f.isProtected).length;
  const adjustedCount = files.filter((f) => f.normalizeToAnchor || f.exposureAdjustmentStops).length;
  const wbTemperature = whiteBalanceTemperature ?? 0;
  const wbTint = whiteBalanceTint ?? 0;
  const wbKelvin = whiteBalanceTemperatureToKelvin(wbTemperature);
  const hasWhiteBalance = Math.abs(wbTemperature) >= 0.5 || Math.abs(wbTint) >= 0.5;
  const hasPicks = pickedCount > 0;
  const hasClickSelection = selectedPaths.length > 0;
  const hasQueue = queuedPaths.length > 0;
  const queueActionsDisabled = phase === 'scanning' || phase === 'importing';
  const hasRenderableWatermark = watermarkEnabled && (
    (watermarkMode === 'image' && watermarkImagePath.trim()) ||
    (watermarkMode !== 'image' && watermarkText.trim())
  );

  // Selection priority mirrors `useImport.ts`:
  //   1. Explicit import override (used by Import Visible)
  //   2. Click-selection in the grid (selectedPaths)
  //   3. Queue
  //   4. Pick flags (if any)
  //   5. Everything that isn't rejected and (optionally) isn't a duplicate
  const importFiles = useMemo(() => {
    if (hasClickSelection) {
      const paths = new Set(selectedPaths);
      return files.filter((f) => paths.has(f.path));
    }
    if (hasQueue) {
      const paths = new Set(queuedPaths);
      return files.filter((f) => paths.has(f.path));
    }
    if (hasPicks) {
      return files.filter((f) => f.pick === 'selected');
    }
    return skipDuplicates
      ? files.filter((f) => !f.duplicate && f.pick !== 'rejected')
      : files.filter((f) => f.pick !== 'rejected');
  }, [files, hasClickSelection, hasPicks, hasQueue, queuedPaths, skipDuplicates, selectedPaths]);

  const buildImportConfig = (dryRun = false): ImportConfig | null => {
    if (!selectedSource || !destination) return null;
    return {
      sourcePath: selectedSource,
      destRoot: destination,
      skipDuplicates,
      saveFormat,
      jpegQuality,
      conflictPolicy,
      conflictFolderName,
      selectedPaths: importFiles.map((file) => file.path),
      separateProtected,
      protectedFolderName,
      backupDestRoot: backupDestRoot || undefined,
      ftpDestEnabled,
      ftpDestConfig: ftpDestEnabled ? ftpDestConfig : undefined,
      verifyChecksums,
      metadataExportFlags: metadataExport,
      metadata: metadataKeywords.trim() || metadataTitle.trim() || metadataCaption.trim() || metadataCreator.trim() || metadataCopyright.trim()
        ? {
            keywords: metadataKeywords.split(/[\n,;]+/).map((value) => value.trim()).filter(Boolean),
            title: metadataTitle.trim() || undefined,
            caption: metadataCaption.trim() || undefined,
            creator: metadataCreator.trim() || undefined,
            copyright: metadataCopyright.trim() || undefined,
          }
        : undefined,
      watermark: hasRenderableWatermark
        ? {
            enabled: true,
            mode: watermarkMode,
            text: watermarkMode === 'text' ? watermarkText.trim() : undefined,
            imagePath: watermarkMode === 'image' ? watermarkImagePath.trim() : undefined,
            opacity: watermarkOpacity,
            positionLandscape: watermarkPositionLandscape,
            positionPortrait: watermarkPositionPortrait,
            scale: watermarkScale,
          }
        : undefined,
      autoStraighten,
      whiteBalance: hasWhiteBalance
        ? {
            temperature: wbTemperature,
            tint: wbTint,
          }
        : undefined,
      dryRun,
    };
  };

  const ftpReady = !ftpDestEnabled || (!!ftpDestConfig.host && !!ftpDestConfig.remotePath);
  const licenseValid = !!licenseStatus?.valid;
  const canImport = licenseValid && selectedSource && destination && ftpReady && importFiles.length > 0 && phase === 'ready';
  const totalSize = importFiles.reduce((sum, f) => sum + f.size, 0);
  const exposureEditCount = importFiles.filter((f) => f.normalizeToAnchor || f.exposureAdjustmentStops).length;
  const queuedRejectedCount = importFiles.filter((f) => f.pick === 'rejected').length;
  const lowConfidenceCount = importFiles.filter((f) =>
    f.type === 'photo' &&
    (f.pick === 'selected' || queuedPaths.includes(f.path)) &&
    (f.blurRisk === 'high' || (typeof f.reviewScore === 'number' && f.reviewScore < 58) || !f.reviewScore),
  ).length;
  const sceneLabels = [...new Set(importFiles
    .map((f) => f.sceneBucket)
    .filter(isMeaningfulSceneLabel) as string[])].sort();
  const sceneCount = sceneLabels.length;
  const sceneSummary = sceneLabels.length <= 2
    ? sceneLabels.join(', ')
    : `${sceneLabels.slice(0, 2).join(', ')} +${sceneLabels.length - 2}`;
  const locationCount = new Set(importFiles.map((f) => f.locationName).filter(Boolean)).size;
  const metadataCount = metadataKeywords.split(/[\n,;]+/).map((value) => value.trim()).filter(Boolean).length;
  const activeEventMode = EVENT_MODE_PRESETS[eventMode] ?? EVENT_MODE_PRESETS.general;
  const activeEventKeywords = eventModeKeywords(eventMode);
  const normalizeLocalPath = (value: string | null | undefined) => String(value || '').replace(/[\\/]$/, '').toLowerCase();
  const normalizedSource = normalizeLocalPath(selectedSource);
  const normalizedDestination = normalizeLocalPath(destination);
  const normalizedBackup = normalizeLocalPath(backupDestRoot);
  const backupSameAsPrimary = !!normalizedBackup && !!normalizedDestination && normalizedBackup === normalizedDestination;
  const destinationSameAsSource = !!normalizedSource && !!normalizedDestination && normalizedDestination === normalizedSource;
  const backupSameAsSource = !!normalizedSource && !!normalizedBackup && normalizedBackup === normalizedSource;
  const outputPathBlocked = backupSameAsPrimary || destinationSameAsSource || backupSameAsSource;
  const metadataFieldLabels = [
    metadataExport.keywords !== false && (metadataCount > 0 || activeEventKeywords.length > 0) ? `keywords (${metadataCount + activeEventKeywords.length})` : null,
    metadataExport.title !== false && metadataTitle.trim() ? 'title' : null,
    metadataExport.caption !== false && metadataCaption.trim() ? 'caption' : null,
    metadataExport.creator !== false && metadataCreator.trim() ? 'creator' : null,
    metadataExport.copyright !== false && metadataCopyright.trim() ? 'copyright' : null,
    locationCount > 0 ? 'GPS/location' : null,
    sceneCount > 0 ? 'scene buckets' : null,
  ].filter(Boolean) as string[];
  const importBenchmark = useMemo(() => {
    const baseSpeed = sourceSpeedMbps(sourceProfile);
    const activeSlowdowns: Array<{ label: string; multiplier: number }> = [];
    const conversionActive = saveFormat !== 'original' || exposureEditCount > 0 || hasWhiteBalance || hasRenderableWatermark || autoStraighten;
    const sidecarsActive = metadataFieldLabels.length > 0;
    if (skipDuplicates) activeSlowdowns.push({ label: 'duplicate checks', multiplier: 0.88 });
    if (verifyChecksums) activeSlowdowns.push({ label: 'checksum verification', multiplier: 0.72 });
    if (backupDestRoot) activeSlowdowns.push({ label: 'backup copy', multiplier: 0.55 });
    if (ftpDestEnabled) activeSlowdowns.push({ label: 'FTP upload', multiplier: 0.45 });
    if (conversionActive) activeSlowdowns.push({ label: saveFormat === 'original' ? 'output edits need conversion' : `${saveFormat.toUpperCase()} conversion`, multiplier: 0.34 });
    if (sidecarsActive) activeSlowdowns.push({ label: 'metadata sidecars', multiplier: 0.92 });
    const multiplier = activeSlowdowns.reduce((value, item) => value * item.multiplier, 1);
    const keptraSpeed = Math.max(4, baseSpeed * multiplier);
    const rawSeconds = totalSize > 0 ? totalSize / (baseSpeed * 1024 * 1024) : 0;
    const keptraSeconds = totalSize > 0 ? (totalSize / (keptraSpeed * 1024 * 1024)) + importFiles.length * 0.025 : 0;
    const actualSpeed = importResult?.durationMs && importResult.totalBytes > 0
      ? (importResult.totalBytes / (1024 * 1024)) / (importResult.durationMs / 1000)
      : null;
    return {
      baseSpeed,
      keptraSpeed,
      rawSeconds,
      keptraSeconds,
      activeSlowdowns,
      actualSpeed,
    };
  }, [
    autoStraighten,
    backupDestRoot,
    exposureEditCount,
    ftpDestEnabled,
    hasRenderableWatermark,
    hasWhiteBalance,
    importFiles.length,
    importResult,
    metadataFieldLabels.length,
    saveFormat,
    skipDuplicates,
    sourceProfile,
    totalSize,
    verifyChecksums,
  ]);

  const activeSpeedProfileId: SpeedProfileId = fastKeeperMode || !reviewFaceAnalysis
    ? 'fast-ingest'
    : verifyChecksums && reviewFaceMatching && reviewPersonDetection && reviewVisualDuplicates && faceConcurrency >= 4
      ? 'deep-ai'
      : 'balanced-review';
  const activeReviewSummary = [
    reviewFaceAnalysis ? 'face AI on' : 'face AI off',
    reviewFaceMatching ? 'matching on' : 'matching off',
    reviewPersonDetection ? 'people on' : 'people off',
    reviewVisualDuplicates ? 'dupes on' : 'dupes off',
    fastKeeperMode ? 'fast keeper' : 'AI keeper',
    autoSpeedMode ? 'auto speed' : 'fixed speed',
  ].join(' · ');
  const measuredBenchmarkRatio = realBenchmark?.ok && realBenchmark.rawCopyEtaSeconds > 0 && importBenchmark.keptraSeconds > 0
    ? importBenchmark.keptraSeconds / realBenchmark.rawCopyEtaSeconds
    : null;
  const measuredBenchmarkDeltaSeconds = realBenchmark?.ok && measuredBenchmarkRatio !== null
    ? Math.max(0, importBenchmark.keptraSeconds - realBenchmark.rawCopyEtaSeconds)
    : 0;

  const handleRunImportBenchmark = async () => {
    if (!destination || importFiles.length === 0 || benchmarkBusy) {
      setBenchmarkOpen(true);
      return;
    }
    setBenchmarkOpen(true);
    setBenchmarkBusy(true);
    setRealBenchmark(null);
    try {
      const result = await window.electronAPI.runImportBenchmark({
        destRoot: destination,
        totalBytes: totalSize,
        fileCount: importFiles.length,
      });
      setRealBenchmark(result);
    } catch (error) {
      setRealBenchmark({
        ok: false,
        destRoot: destination,
        sampleBytes: 0,
        wallMs: 0,
        measuredMbps: 0,
        rawCopyEtaSeconds: 0,
        error: error instanceof Error ? error.message : 'Import benchmark failed.',
      });
    } finally {
      setBenchmarkBusy(false);
    }
  };

  const refreshPreflight = async (dryRun = false) => {
    const config = buildImportConfig(dryRun);
    if (!config) return;
    const result = await window.electronAPI.preflightImport(config);
    setPreflight(result);
    setPreflightOpen(true);
  };

  const handlePreviewImport = async () => {
    await refreshPreflight(true);
  };
  const importScopeLabel = hasClickSelection
    ? 'Selection'
    : hasQueue
      ? 'Queue'
      : hasPicks
        ? 'Picks'
        : 'Files';

  const secondPassFiles = files.filter(needsSecondPass);
  const secondPassPaths = secondPassFiles.map((file) => file.path);
  const secondPassReasonCounts = secondPassFiles.reduce((counts, file) => {
    for (const reason of getSecondPassReasons(file)) {
      counts[reason] = (counts[reason] ?? 0) + 1;
    }
    return counts;
  }, {} as Record<string, number>);
  const resolveSecondPass = (pick: 'selected' | 'rejected') => {
    if (secondPassPaths.length === 0) return;
    dispatch({ type: 'RESOLVE_SECOND_PASS', filePaths: secondPassPaths, pick });
    dispatch({ type: 'SET_FILTER', filter: 'review-needed' });
  };
  const openSecondPassLane = () => {
    dispatch({ type: 'SET_FILTER', filter: 'review-needed' });
    dispatch({ type: 'SET_VIEW_MODE', mode: 'split' });
  };

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
    for (const f of importFiles) {
      if (!f.dateTaken) continue;
      const date = new Date(f.dateTaken);
      let resolved = resolvePattern(activePattern, date, f.name, f.extension, f.rating);
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
  }, [importFiles, activePattern, saveFormat, separateProtected, protectedFolderName]);

  return (
    <div className="flex flex-col h-full">
      <div className="px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Output Inspector</h2>
          <span className="rounded border border-border bg-surface px-1.5 py-0.5 text-[9px] font-medium text-text-muted">V2</span>
        </div>
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
          aria-label={destination ? `Change destination folder, currently ${destination}` : 'Choose destination folder'}
        >
          {destination ? (
            <span className="truncate block" title={destination}>{destination.split(/[/\\]/).pop()}</span>
          ) : (
            'Choose Destination...'
          )}
        </button>
      </div>

      <div className="px-2.5 mb-2.5">
        <div className="grid grid-cols-3 gap-1 rounded-md border border-border bg-surface p-1">
          {([
            ['import', 'Import'],
            ['speed', 'Speed'],
            ['rules', 'Rules'],
          ] as const).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              onClick={() => setOutputMode(mode)}
              className={`rounded px-2 py-1 text-[10px] font-medium transition-colors ${
                outputMode === mode
                  ? 'bg-accent text-white'
                  : 'text-text-muted hover:bg-surface-raised hover:text-text-secondary'
              }`}
              title={
                mode === 'import'
                  ? 'Destination, import set, format, and final import checks.'
                  : mode === 'speed'
                    ? 'Performance profiles, benchmark, and active speed slowdowns.'
                    : 'Naming, conflict, backup, FTP, metadata, and advanced workflow rules.'
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {outputMode === 'rules' && (
      <div className="px-2.5 mb-2.5">
        <div className="flex items-center gap-1">
          <select
            value={selectedPresetName}
            onChange={(e) => {
              if (!e.target.value) {
                setSelectedPresetName('');
                return;
              }
              applyPreset(e.target.value);
            }}
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
              title={selectedPresetName ? `Delete preset "${selectedPresetName}"` : `Delete preset "${jobPresets[0]?.name}"`}
            >
              Del
            </button>
          )}
        </div>
      </div>
      )}

      {outputMode === 'import' && files.length > 0 && (
        <div className="px-2.5 mb-2.5 grid grid-cols-2 gap-1 text-[10px] text-text-muted">
          <div className="bg-surface-raised rounded px-1.5 py-1">Picked <span className="text-yellow-400">{pickedCount}</span></div>
          <div className="bg-surface-raised rounded px-1.5 py-1">Rejected <span className="text-red-400">{rejectedCount}</span></div>
          <div className="bg-surface-raised rounded px-1.5 py-1">Protected <span className="text-emerald-400">{protectedCount}</span></div>
          <div className="bg-surface-raised rounded px-1.5 py-1">Queued <span className="text-emerald-400">{queuedPaths.length}</span></div>
        </div>
      )}

      {outputMode === 'import' && files.length > 0 && (
        <div className="px-2.5 mb-2.5">
          <div className={`rounded border px-2 py-2 ${
            secondPassFiles.length > 0
              ? 'border-yellow-500/30 bg-yellow-500/10'
              : 'border-emerald-500/25 bg-emerald-500/10'
          }`}>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <h3 className="text-[10px] text-text-secondary uppercase tracking-wider">Second pass</h3>
              <span className={`font-mono text-[10px] ${secondPassFiles.length > 0 ? 'text-yellow-300' : 'text-emerald-300'}`}>
                {secondPassFiles.length}
              </span>
            </div>
            {secondPassFiles.length > 0 ? (
              <>
                <div className="mb-1.5 flex flex-wrap gap-1">
                  {[
                    ['blur-risk', 'Blur'],
                    ['low-confidence-keeper', 'Low keeper'],
                    ['unreviewed', 'Unreviewed'],
                    ['near-duplicate', 'Near dupes'],
                    ['unmarked', 'Unmarked'],
                  ].map(([key, label]) => (
                    secondPassReasonCounts[key] ? (
                      <span key={key} className="rounded bg-surface-raised px-1.5 py-0.5 text-[9px] text-text-secondary">
                        {label} {secondPassReasonCounts[key]}
                      </span>
                    ) : null
                  ))}
                </div>
                <div className="grid grid-cols-3 gap-1">
                  <button
                    type="button"
                    onClick={openSecondPassLane}
                    className="rounded bg-surface-raised px-1.5 py-1 text-[10px] text-text-secondary transition-colors hover:text-text"
                  >
                    Open
                  </button>
                  <button
                    type="button"
                    onClick={() => resolveSecondPass('selected')}
                    className="rounded bg-emerald-600/15 px-1.5 py-1 text-[10px] text-emerald-300 transition-colors hover:bg-emerald-600/25"
                    title={`Mark all ${secondPassFiles.length} second-pass file${secondPassFiles.length === 1 ? '' : 's'} as selected.`}
                  >
                    Pick All
                  </button>
                  <button
                    type="button"
                    onClick={() => resolveSecondPass('rejected')}
                    className="rounded bg-red-600/15 px-1.5 py-1 text-[10px] text-red-300 transition-colors hover:bg-red-600/25"
                    title={`Mark all ${secondPassFiles.length} second-pass file${secondPassFiles.length === 1 ? '' : 's'} as rejected.`}
                  >
                    Reject All
                  </button>
                </div>
              </>
            ) : (
              <p className="text-[10px] text-emerald-300">Clear</p>
            )}
          </div>
        </div>
      )}

      {outputMode === 'import' && (
      <div className="px-2.5 mb-2.5">
        <div className="rounded border border-border bg-surface-alt px-2 py-2">
          <div className="flex items-center justify-between gap-2 mb-1">
            <h3 className="text-[10px] text-text-secondary uppercase tracking-wider">Session type</h3>
            <span className="text-[9px] text-text-muted">Lightroom XMP</span>
          </div>
          <select
            value={eventMode}
            onChange={(e) => handleEventMode(e.target.value as EventMode)}
            className="w-full px-1.5 py-1 text-[11px] bg-surface-raised border border-border rounded text-text focus:border-text focus:outline-none appearance-none cursor-pointer"
            title={activeEventMode.help}
          >
            {Object.entries(EVENT_MODE_PRESETS).map(([key, preset]) => (
              <option key={key} value={key}>{preset.label}</option>
            ))}
          </select>
          <p className="text-[10px] text-text-muted mt-1">{activeEventMode.description}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {activeEventKeywords.slice(0, 5).map((keyword) => (
              <span key={keyword} className="rounded bg-surface-raised px-1.5 py-0.5 text-[9px] text-text-secondary">
                {keyword}
              </span>
            ))}
          </div>
        </div>
      </div>
      )}

      {phase === 'importing' && (
        <div className="mx-2.5 mb-2.5 rounded border border-accent/30 bg-accent/10 px-2 py-1.5">
          <div className="flex items-center justify-between gap-2 text-[10px] text-text-secondary">
            <span>Importing</span>
            <span className="font-mono text-text">
              {importProgress ? `${importProgress.currentIndex}/${importProgress.totalFiles}` : 'Preparing'}
            </span>
          </div>
          <div className="mt-1 h-1 rounded bg-surface-raised overflow-hidden">
            <div
              className="h-full bg-accent transition-[width] duration-300"
              style={{
                width: importProgress && importProgress.totalFiles > 0
                  ? `${Math.round((importProgress.currentIndex / importProgress.totalFiles) * 100)}%`
                  : '0%',
              }}
            />
          </div>
          <div className="mt-1 text-[10px] text-text-muted truncate" title={importProgress?.currentFile}>
            {importProgress?.currentFile ?? 'Scanning card...'}
          </div>
        </div>
      )}

      {outputMode === 'rules' && (
        <div className="px-2.5 mb-2.5">
          <ImportResumeView />
        </div>
      )}

      {outputMode === 'speed' && (
        <div className="px-2.5 mb-2.5">
          <div className="rounded border border-border bg-surface-alt px-2 py-2">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <h3 className="text-[10px] text-text-secondary uppercase tracking-wider">Speed profile</h3>
              <span className="text-[9px] text-text-muted">{previewConcurrency} preview · {faceConcurrency} face</span>
            </div>
            <div className="grid grid-cols-3 gap-1">
              {SPEED_PROFILES.map((profile) => {
                const active = activeSpeedProfileId === profile.id;
                return (
                  <button
                    key={profile.id}
                    type="button"
                    onClick={() => applySpeedProfile(profile.id)}
                    className={`rounded px-1.5 py-1 text-[10px] transition-colors ${
                      active
                        ? 'bg-accent text-white'
                        : 'bg-surface-raised text-text-secondary hover:bg-accent/10 hover:text-text'
                    }`}
                    title={profile.description}
                  >
                    {profile.label}
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 text-[10px] text-text-muted">
              {activeReviewSummary}
            </p>
            <div className="mt-2 rounded border border-border bg-surface px-2 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[10px] font-medium text-text-secondary">Import health</div>
                <button
                  type="button"
                  onClick={() => { void handleRunImportBenchmark(); }}
                  disabled={!destination || importFiles.length === 0 || benchmarkBusy}
                  className="rounded bg-surface-raised px-2 py-0.5 text-[10px] text-blue-300 hover:bg-blue-500/10 disabled:cursor-not-allowed disabled:opacity-40"
                  title="Measure real copy speed to this destination."
                >
                  {benchmarkBusy ? 'Measuring' : 'Measure'}
                </button>
              </div>
              <div className="mt-1 text-[10px] text-text-muted">
                {importBenchmark.activeSlowdowns.length > 0
                  ? `Slowdowns on: ${importBenchmark.activeSlowdowns.map((item) => item.label).join(', ')}.`
                  : 'Fast path active: raw copy, no checksum, no sidecars, no conversion, no backup or FTP.'}
              </div>
              {importBenchmark.activeSlowdowns.length > 0 && (
                <button
                  type="button"
                  onClick={() => applySpeedProfile('fast-ingest')}
                  className="mt-1 rounded border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-300 hover:bg-emerald-500/20"
                >
                  Make fastest
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Settings */}
      {outputMode === 'import' && (
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
      )}

      {/* Protected folder split */}
      {outputMode === 'rules' && (
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
      )}

      {/* Folder structure */}
      {outputMode === 'rules' && (
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
              {'{YYYY}'} {'{MM}'} {'{DD}'} {'{filename}'} {'{name}'} {'{ext}'} {'{rating}'}
            </p>
          </div>
        )}
      </div>
      )}

      {/* Save format */}
      {outputMode === 'import' && (
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
        {saveFormat === 'original' && (
          <p className="text-[10px] text-text-muted mt-1">
            Fastest and safest: copies source bytes unchanged, even for JPEGs. Pixel edits need JPEG/TIFF/HEIC output.
          </p>
        )}
      </div>
      )}

      {/* Output edits */}
      {outputMode === 'import' && (
      <div className="px-2.5 mb-2.5">
        <button
          type="button"
          onClick={() => setShowTransforms((value) => !value)}
          className="w-full flex items-center justify-between gap-2 text-[10px] text-text-secondary uppercase tracking-wider hover:text-text"
        >
          <span>Output edits</span>
          <span className={hasWhiteBalance ? 'text-cyan-300 normal-case font-mono' : 'text-text-muted normal-case'}>
            {hasWhiteBalance
              ? `${formatWhiteBalanceKelvin(wbTemperature)} ${wbTint > 0 ? '+' : ''}${wbTint}`
              : 'Off'} {showTransforms ? '-' : '+'}
          </span>
        </button>
        {showTransforms && (
          <div className={`mt-1.5 space-y-2 rounded border border-border bg-surface-alt px-2 py-2 ${saveFormat === 'original' ? 'opacity-60' : ''}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-text">Bulk white balance</span>
              <button
                type="button"
                onClick={() => handleWhiteBalance(0, 0)}
                disabled={!hasWhiteBalance}
                className="px-1.5 py-0.5 text-[10px] rounded bg-surface-raised hover:bg-border text-text-secondary disabled:opacity-50"
              >
                Reset
              </button>
            </div>
            <div>
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-[10px] text-text-secondary">Temperature</span>
                <span className="text-[10px] text-text-secondary font-mono">{formatWhiteBalanceKelvin(wbTemperature)}</span>
              </div>
              <div className="grid grid-cols-[2.4rem_1fr_2.6rem] items-center gap-1 text-[9px] text-text-muted">
                <span>Cool</span>
                <input
                  type="range"
                  min={WHITE_BALANCE_MIN_KELVIN}
                  max={WHITE_BALANCE_MAX_KELVIN}
                  step={50}
                  value={wbKelvin}
                  disabled={saveFormat === 'original'}
                  onChange={(e) => handleWhiteBalance(kelvinToWhiteBalanceTemperature(Number(e.target.value)), wbTint)}
                  className="min-w-0 h-1 bg-surface-raised rounded appearance-none cursor-pointer accent-accent disabled:cursor-not-allowed"
                />
                <span className="text-right">Warm</span>
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-[10px] text-text-secondary">Tint</span>
                <span className="text-[10px] text-text-secondary font-mono">{wbTint > 0 ? '+' : ''}{wbTint}</span>
              </div>
              <div className="grid grid-cols-[2.4rem_1fr_3.4rem] items-center gap-1 text-[9px] text-text-muted">
                <span>Green</span>
                <input
                  type="range"
                  min={-100}
                  max={100}
                  step={5}
                  value={wbTint}
                  disabled={saveFormat === 'original'}
                  onChange={(e) => handleWhiteBalance(wbTemperature, Number(e.target.value))}
                  className="min-w-0 h-1 bg-surface-raised rounded appearance-none cursor-pointer accent-accent disabled:cursor-not-allowed"
                />
                <span className="text-right">Magenta</span>
              </div>
            </div>
            <p className="text-[10px] text-text-muted">
              {saveFormat === 'original'
                ? 'Choose JPEG/TIFF/HEIC to apply output edits.'
                : 'Applied during import export.'}
            </p>
          </div>
        )}
      </div>
      )}

      {/* Advanced workflow options — collapsed by default so the panel
          stays calm for casual users */}
      {outputMode === 'rules' && (
      <div className="px-2.5 mb-2.5">
        <button
          onClick={() => setShowAdvanced((v) => !v)}
          className="w-full flex items-center justify-between text-[10px] text-text-secondary uppercase tracking-wider hover:text-text"
        >
          <span>Workflow</span>
          <span className="text-text-muted">{showAdvanced ? '-' : '+'}</span>
        </button>
        {showAdvanced && (
          <>
            <div className="mt-1.5 space-y-1.5">
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-text">Source profile</span>
                  <span className="text-[10px] text-text-muted">tunes preview + AI load</span>
                </div>
                <select
                  value={sourceProfile}
                  onChange={(e) => handleSourceProfile(e.target.value as SourceProfile)}
                  className="mt-0.5 w-full px-1.5 py-1 text-[11px] bg-surface-raised border border-border rounded text-text focus:border-text focus:outline-none appearance-none cursor-pointer"
                >
                  <option value="auto">Auto</option>
                  <option value="ssd">Local SSD</option>
                  <option value="usb">USB card / external drive</option>
                  <option value="nas">NAS / network share</option>
                </select>
              </div>

              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-text">File conflicts</span>
                  <span className="text-[10px] text-text-muted">when names already exist</span>
                </div>
                <select
                  value={conflictPolicy}
                  onChange={(e) => handleConflictPolicy(e.target.value as ImportConflictPolicy)}
                  className="mt-0.5 w-full px-1.5 py-1 text-[11px] bg-surface-raised border border-border rounded text-text focus:border-text focus:outline-none appearance-none cursor-pointer"
                >
                  <option value="skip">Skip existing files</option>
                  <option value="rename">Rename new copies</option>
                  <option value="overwrite">Overwrite destination</option>
                  <option value="conflicts-folder">Move to conflicts folder</option>
                </select>
                {conflictPolicy === 'conflicts-folder' && (
                  <input
                    value={conflictFolderName}
                    onChange={(e) => handleConflictFolderName(e.target.value)}
                    placeholder="_Conflicts"
                    className="mt-1 w-full px-1.5 py-1 text-[11px] font-mono bg-surface-raised border border-border rounded text-text placeholder-text-muted focus:border-text focus:outline-none"
                  />
                )}
              </div>

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

              {/* Current-import FTP output */}
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
                    placeholder="/Keptra"
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

            <div className="pt-1 border-t border-border rounded bg-surface-alt px-2 py-2">
              <div className="mb-2 rounded border border-emerald-500/25 bg-emerald-500/10 px-2 py-1.5">
                <div className="text-[10px] font-medium text-emerald-300">Fast raw ingest</div>
                <div className="mt-0.5 text-[10px] text-text-muted">
                  For maximum copy speed, use Original and leave backup, FTP, checksum verification, conversion, metadata, and duplicate checks off unless this job needs them.
                </div>
              </div>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-[11px] text-text">Automation and post-import</div>
                  <div className="text-[10px] text-text-muted">FTP workflow, auto-import, sounds, burst grouping, and exposure defaults live in Settings.</div>
                </div>
                <button
                  onClick={() => dispatch({ type: 'SET_VIEW_MODE', mode: 'settings' })}
                  className="shrink-0 px-2 py-1 text-[10px] bg-surface-raised hover:bg-border rounded text-text-secondary"
                >
                  Open settings
                </button>
              </div>
            </div>
          </>
        )}
      </div>
      )}

      {/* Folder structure preview */}
      {outputMode === 'rules' && folders.length > 0 && destination && (
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
            {(hasRenderableWatermark || autoStraighten) && saveFormat === 'original' && (
              <div className="text-[10px] text-yellow-500">Watermark and auto-straighten need JPEG/TIFF/HEIC output.</div>
            )}
            {hasWhiteBalance && saveFormat === 'original' && (
              <div className="text-[10px] text-yellow-500">White balance needs JPEG/TIFF/HEIC output.</div>
            )}
            {backupSameAsPrimary && (
              <div className="text-[10px] text-red-400">Backup destination matches primary.</div>
            )}
            {destinationSameAsSource && (
              <div className="text-[10px] text-red-400">Destination matches source. Choose a different output folder before importing.</div>
            )}
            {backupSameAsSource && (
              <div className="text-[10px] text-red-400">Backup destination matches source. Choose a different backup folder.</div>
            )}
            {backupDestRoot && !backupSameAsPrimary && (
              <div className="text-[10px] text-emerald-500">Backup copy enabled for this import.</div>
            )}
            {ftpDestEnabled && !ftpReady && (
              <div className="text-[10px] text-red-400">FTP output needs host and remote folder.</div>
            )}
            {ftpDestEnabled && ftpReady && (
              <div className="text-[10px] text-emerald-500">FTP upload enabled.</div>
            )}
            {queuedRejectedCount > 0 && (
              <div className="text-[10px] text-yellow-500">QA: {queuedRejectedCount} rejected photo{queuedRejectedCount === 1 ? '' : 's'} still in this import set.</div>
            )}
            {lowConfidenceCount > 0 && (
              <div className="text-[10px] text-yellow-500">QA: {lowConfidenceCount} queued keeper{lowConfidenceCount === 1 ? '' : 's'} may need a quick check before import.</div>
            )}
            {!licenseValid && (
              <div className="text-[10px] text-red-400">Importing is locked until a valid Full access license is activated.</div>
            )}
          </div>
        )}
        {files.length > 0 && (
          <div className="text-[11px] text-text-secondary mb-2">
            {importFiles.length} file{importFiles.length !== 1 ? 's' : ''} &middot; {formatSize(totalSize)}
            {hasClickSelection && <span className="text-blue-400/80"> &middot; {selectedPaths.length} selected</span>}
            {!hasClickSelection && hasQueue && <span className="text-emerald-400/80"> &middot; {queuedPaths.length} queued</span>}
            {!hasQueue && !hasClickSelection && hasPicks && <span className="text-yellow-400/70"> &middot; {pickedCount} picked</span>}
            {skipDuplicates && duplicateCount > 0 && (
              <span className="text-yellow-500/70"> &middot; {duplicateCount} already imported</span>
            )}
            {(metadataCount > 0 || metadataTitle.trim() || metadataCaption.trim()) && (
              <span className="text-sky-300/80"> &middot; metadata</span>
            )}
            {eventMode !== 'general' && (
              <span className="text-violet-300/80"> &middot; {activeEventMode.label}</span>
            )}
            {sceneCount > 0 && (
              <span className="text-blue-300/80" title={sceneLabels.join(', ')}> &middot; Scene groups: {sceneSummary}</span>
            )}
            {locationCount > 0 && (
              <span className="text-cyan-300/80"> &middot; GPS tags</span>
            )}
            {hasRenderableWatermark && saveFormat !== 'original' && (
              <span className="text-orange-300/80"> &middot; watermark</span>
            )}
            {autoStraighten && saveFormat !== 'original' && (
              <span className="text-emerald-300/80"> &middot; upright</span>
            )}
            {hasWhiteBalance && saveFormat !== 'original' && (
              <span className="text-cyan-300/80"> &middot; WB</span>
            )}
            {verifyChecksums && (
              <span className="text-emerald-300/80"> &middot; verify after copy</span>
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
        {benchmarkOpen && files.length > 0 && (
          <div className="mb-2 rounded border border-blue-500/20 bg-blue-500/10 px-2 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[10px] font-medium text-blue-200">Import benchmark</div>
              <button
                onClick={() => setBenchmarkOpen(false)}
                className="text-[10px] text-text-muted hover:text-text"
              >
                Hide
              </button>
            </div>
            <div className="mt-1 grid grid-cols-2 gap-1 text-[10px] text-text-secondary">
              <div>OS-style copy <span className="text-text">{Math.round(importBenchmark.baseSpeed)} MB/s</span></div>
              <div>ETA <span className="text-text">{formatDuration(importBenchmark.rawSeconds)}</span></div>
              <div>Keptra current <span className="text-blue-200">{Math.round(importBenchmark.keptraSpeed)} MB/s</span></div>
              <div>ETA <span className="text-blue-200">{formatDuration(importBenchmark.keptraSeconds)}</span></div>
            </div>
            {importBenchmark.actualSpeed !== null && (
              <div className="mt-1 text-[10px] text-emerald-300">
                Last import measured about {Math.round(importBenchmark.actualSpeed)} MB/s on this machine.
              </div>
            )}
            {benchmarkBusy && (
              <div className="mt-1 text-[10px] text-blue-200">
                Copying a small sample to the destination...
              </div>
            )}
            {realBenchmark && (
              <div className={`mt-1 text-[10px] ${realBenchmark.ok ? 'text-emerald-300' : 'text-red-400'}`}>
                {realBenchmark.ok
                  ? `Measured destination copy: ${Math.round(realBenchmark.measuredMbps)} MB/s using ${formatSize(realBenchmark.sampleBytes)} in ${formatDuration(realBenchmark.wallMs / 1000)}. Raw ETA ${formatDuration(realBenchmark.rawCopyEtaSeconds)}.`
                  : `Measured copy failed: ${realBenchmark.error || 'Could not write benchmark sample.'}`}
              </div>
            )}
            {measuredBenchmarkRatio !== null && (
              <div className={`mt-1 text-[10px] ${measuredBenchmarkRatio <= 1.25 ? 'text-emerald-300' : measuredBenchmarkRatio <= 2 ? 'text-yellow-300' : 'text-orange-300'}`}>
                Current settings are about {measuredBenchmarkRatio.toFixed(1)}x raw-copy time
                {measuredBenchmarkDeltaSeconds > 0 ? ` (+${formatDuration(measuredBenchmarkDeltaSeconds)})` : ''}.
              </div>
            )}
            <div className="mt-1 text-[10px] text-text-muted">
              {importBenchmark.activeSlowdowns.length > 0
                ? `Active slowdowns: ${importBenchmark.activeSlowdowns.map((item) => item.label).join(', ')}.`
                : 'Fast raw ingest path: checksum, duplicate checks, sidecars, conversion, FTP, and backup are off.'}
            </div>
            {importBenchmark.activeSlowdowns.length > 0 && (
              <button
                type="button"
                onClick={() => applySpeedProfile('fast-ingest')}
                className="mt-1 rounded border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-300 hover:bg-emerald-500/20"
                title="Switch to Original, disable checksum/duplicates/sidecars/backup/FTP/conversion, and lower review processing load."
              >
                Apply Fast ingest profile
              </button>
            )}
          </div>
        )}
        {preflightOpen && preflight && (
          <div className="mb-2 rounded border border-border bg-surface-alt px-2 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[10px] font-medium text-text">Preflight</div>
              <button
                onClick={() => setPreflightOpen(false)}
                className="text-[10px] text-text-muted hover:text-text"
              >
                Hide
              </button>
            </div>
            <div className="mt-1 grid grid-cols-2 gap-1 text-[10px] text-text-secondary">
              <div>Will import <span className="text-emerald-400">{preflight.willImport}</span></div>
              <div>Duplicates <span className="text-yellow-400">{preflight.duplicates}</span></div>
              <div>Conflicts <span className={preflight.conflicts ? 'text-red-400' : 'text-text-muted'}>{preflight.conflicts}</span></div>
              <div>Review flags <span className={preflight.lowConfidence ? 'text-yellow-400' : 'text-text-muted'}>{preflight.lowConfidence}</span></div>
            </div>
            <div className="mt-1 text-[10px] text-text-muted">
              Conflict policy: {preflight.conflictPolicy === 'conflicts-folder' ? `conflicts folder (${preflight.conflictFolderName || '_Conflicts'})` : preflight.conflictPolicy}.{' '}
              {preflight.backupEnabled && 'Backup enabled. '}
              {preflight.ftpEnabled && 'FTP upload enabled. '}
              {preflight.checksumEnabled && 'Post-copy verification enabled. '}
              {preflight.metadataEnabled && 'XMP metadata enabled. '}
              {preflight.watermarkEnabled && 'Watermark enabled. '}
              {preflight.recoveryAvailable && 'Recovery ledger available. '}
              {preflight.dryRun && 'Dry-run preview only.'}
            </div>
            {preflight.sessionWarnings.length > 0 && (
              <div className="mt-1 space-y-0.5">
                {preflight.sessionWarnings.slice(0, 4).map((warning) => (
                  <div key={warning} className="text-[10px] text-yellow-500">{warning}</div>
                ))}
              </div>
            )}
            {metadataFieldLabels.length > 0 && (
              <div className="mt-1 text-[10px] text-sky-300/80">
                Metadata: {metadataFieldLabels.join(', ')}
              </div>
            )}
            {preflight.items.some((item) => item.status !== 'will-import' || (item.warnings?.length ?? 0) > 0) && (
              <div className="mt-1 max-h-20 overflow-y-auto space-y-0.5">
                {preflight.items
                  .filter((item) => item.status !== 'will-import' || (item.warnings?.length ?? 0) > 0)
                  .slice(0, 8)
                  .map((item) => (
                    <div key={item.sourcePath} className="truncate text-[10px] text-text-muted" title={`${item.name}: ${item.reason || item.warnings?.join(', ') || item.status}`}>
                      <span className={item.status === 'will-import' ? 'text-yellow-400' : item.status === 'duplicate' ? 'text-text-muted' : 'text-red-400'}>
                        {item.status}
                      </span>
                      {' '}{item.name}
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}
        <div className="mb-1 grid grid-cols-3 gap-1">
          <button
            onClick={() => { void handlePreviewImport(); }}
            disabled={!destination || importFiles.length === 0}
            className="py-1 rounded text-[10px] bg-surface-raised hover:bg-border text-text-secondary disabled:text-text-muted disabled:cursor-not-allowed"
            title="Preview the exact import plan without copying files."
            aria-label="Preview the import plan without copying files"
          >
            Check Plan
          </button>
          <button
            onClick={() => { void handleRunImportBenchmark(); }}
            disabled={!destination || importFiles.length === 0 || benchmarkBusy}
            className="py-1 rounded text-[10px] bg-surface-raised hover:bg-blue-500/10 text-blue-300 disabled:text-text-muted disabled:cursor-not-allowed"
            title="Copy a small temporary sample into the destination to measure real raw disk speed, then compare it with current Keptra settings."
            aria-label="Run import speed benchmark"
          >
            {benchmarkBusy ? 'Measuring' : 'Benchmark'}
          </button>
          <button
            onClick={() => { void handleExportLightroomHandoff(); }}
            disabled={files.length === 0 || handoffBusy}
            className="py-1 rounded text-[10px] bg-surface-raised hover:bg-blue-500/10 text-blue-300 disabled:text-text-muted disabled:cursor-not-allowed"
            title="Export selected, rejected, protected, second-pass, and catalog-match helper manifests for Lightroom."
            aria-label="Export Lightroom handoff helpers for the current session"
          >
            {handoffBusy ? 'Exporting' : 'LR Handoff'}
          </button>
        </div>
        <button
          onClick={() => { void startImport(); }}
          disabled={!canImport || insufficientSpace || outputPathBlocked}
          className={`w-full py-1.5 rounded text-xs font-medium transition-colors ${
            canImport && !insufficientSpace && !outputPathBlocked
              ? 'bg-accent hover:bg-accent-hover text-white'
              : 'bg-surface-raised text-text-muted cursor-not-allowed'
          }`}
          title={
            !selectedSource ? 'Select a source volume first'
              : !destination ? 'Choose a destination folder first'
              : !licenseValid ? 'Activate a valid license first'
              : !ftpReady ? 'Finish FTP output settings first'
              : importFiles.length === 0 ? 'No files to import'
              : insufficientSpace ? 'Not enough free space on the destination'
              : destinationSameAsSource ? 'Destination cannot be the source folder'
              : backupSameAsPrimary ? 'Backup destination cannot match the primary destination'
              : backupSameAsSource ? 'Backup destination cannot be the source folder'
              : !canImport ? `Cannot import while ${phase}`
              : undefined
          }
        >
          {!destination && files.length > 0
            ? 'Choose Destination First'
            : `Import ${importScopeLabel} ${importFiles.length > 0 ? `${importFiles.length} File${importFiles.length !== 1 ? 's' : ''}` : ''}`
          }
        </button>
        {hasQueue && (
          <button
            onClick={() => {
              if (!queueActionsDisabled) dispatch({ type: 'QUEUE_CLEAR' });
            }}
            disabled={queueActionsDisabled}
            className="w-full mt-1 py-1 rounded text-[10px] bg-surface-raised hover:bg-border text-text-secondary transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-surface-raised"
            title={queueActionsDisabled ? 'Wait for the current scan/import before changing the queue.' : 'Clear import queue'}
          >
            Clear Queue
          </button>
        )}
        {phase === 'complete' && importResult && destination && (
          <div className="mt-2 grid grid-cols-2 gap-1">
            <button
              onClick={handleOpenDestination}
              className="py-1 rounded text-[10px] bg-surface-raised hover:bg-border text-text-secondary transition-colors"
              title="Open the output folder for this completed import."
            >
              Open Folder
            </button>
            <button
              onClick={() => { void handleExportLightroomHandoff(); }}
              className="py-1 rounded text-[10px] bg-surface-raised hover:bg-border text-text-secondary transition-colors"
              disabled={handoffBusy}
              title="Open or export Keptra collection helper manifests for Lightroom Classic."
            >
              {handoffBusy ? 'Exporting' : 'Lightroom Handoff'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
