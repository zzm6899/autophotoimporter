import { useEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  ArrowLeft,
  CreditCard,
  Database,
  FolderClock,
  HeartPulse,
  KeyRound,
  SlidersHorizontal,
  Stethoscope,
  SunMoon,
  Wand2,
  X,
} from 'lucide-react';
import { useAppState, useAppDispatch } from '../context/ImportContext';
import type { AppDiagnosticsSnapshot, AppSettings, CullConfidence, KeeperQuota, SaveFormat, KeybindMap, MacFirstRunDoctor, MetadataExportFlags, WatermarkMode, WatermarkPosition } from '../../shared/types';
import { DEFAULT_KEYBINDS, FOLDER_PRESETS } from '../../shared/types';
import { formatWhiteBalanceKelvin, kelvinToWhiteBalanceTemperature, WHITE_BALANCE_MAX_KELVIN, WHITE_BALANCE_MIN_KELVIN, whiteBalanceTemperatureToKelvin } from '../../shared/exposure';
import { playCompletionSound } from '../utils/completionSound';
import { useUpdateNotification } from '../hooks/useUpdateNotification';
import { OPEN_PERFORMANCE_EVENT } from './SettingsOptimizationPrompt';
import { ImportResumeView } from './ImportResumeView';
import { WatchFoldersPanel } from './WatchFoldersPanel';
import { CatalogPanel } from './CatalogPanel';
import { ImportHealthDashboard } from './ImportHealthDashboard';
import { ActionButton, IconButton, SectionHeader, StatusPill } from './ui';

interface SettingsPageProps {
  onClose: () => void;
  /** When true, renders as a full-page view instead of a modal overlay */
  inline?: boolean;
}

const KEYBIND_ITEMS: Array<{ action: keyof KeybindMap; label: string; hint: string }> = [
  { action: 'pick', label: 'Pick', hint: 'keep current photo' },
  { action: 'reject', label: 'Reject', hint: 'mark for deletion' },
  { action: 'unflag', label: 'Unflag', hint: 'clear pick / reject' },
  { action: 'nextPhoto', label: 'Next photo', hint: 'move right' },
  { action: 'prevPhoto', label: 'Previous photo', hint: 'move left' },
  { action: 'rateOne', label: '1 star', hint: 'apply rating' },
  { action: 'rateTwo', label: '2 stars', hint: 'apply rating' },
  { action: 'rateThree', label: '3 stars', hint: 'apply rating' },
  { action: 'rateFour', label: '4 stars', hint: 'apply rating' },
  { action: 'rateFive', label: '5 stars', hint: 'apply rating' },
  { action: 'clearRating', label: 'Clear rating', hint: 'remove stars' },
  { action: 'compareMode', label: 'Compare mode', hint: 'toggle split view' },
  { action: 'burstSelect', label: 'Burst select', hint: 'select burst' },
  { action: 'burstCollapse', label: 'Collapse burst', hint: 'hide similar shots' },
  { action: 'queuePhoto', label: 'Queue photo', hint: 'send to import queue' },
  { action: 'jumpUnreviewed', label: 'Jump unreviewed', hint: 'next untouched photo' },
  { action: 'batchRejectBurst', label: 'Reject burst', hint: 'bulk reject group' },
];

const METADATA_EXPORT_ITEMS: Array<{ flag: keyof MetadataExportFlags; label: string; hint: string }> = [
  { flag: 'keywords', label: 'Keywords', hint: 'tags / categories' },
  { flag: 'title', label: 'Title', hint: 'headline field' },
  { flag: 'caption', label: 'Caption', hint: 'description / notes' },
  { flag: 'creator', label: 'Creator', hint: 'photographer / author' },
  { flag: 'copyright', label: 'Copyright', hint: 'ownership notice' },
  { flag: 'rating', label: 'Rating', hint: 'XMP star rating' },
  { flag: 'pickLabel', label: 'Pick label', hint: 'pick / reject flag' },
  { flag: 'stripGps', label: 'Strip GPS', hint: 'privacy-safe export' },
];

function keyDisplayName(key: string): string {
  if (key === 'ArrowRight') return '→';
  if (key === 'ArrowLeft') return '←';
  if (key === 'ArrowUp') return '↑';
  if (key === 'ArrowDown') return '↓';
  if (key === 'Tab') return 'Tab';
  if (key === ' ') return 'Space';
  return key;
}

const SETTINGS_TOPICS = [
  { id: 'health', label: 'Health' },
  { id: 'general', label: 'General' },
  { id: 'workflow', label: 'Workflow' },
  { id: 'catalog', label: 'Catalog' },
  { id: 'editing', label: 'Editing' },
  { id: 'account', label: 'Account' },
  { id: 'diagnostics', label: 'Diagnostics' },
] as const;

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

type SettingsTopic = typeof SETTINGS_TOPICS[number]['id'];

const SETTINGS_TOPIC_ICONS: Record<SettingsTopic, LucideIcon> = {
  health: HeartPulse,
  general: SlidersHorizontal,
  workflow: FolderClock,
  catalog: Database,
  editing: Wand2,
  account: KeyRound,
  diagnostics: Stethoscope,
};

function isSafeCheckoutUrl(value?: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['checkout.stripe.com', 'keptra.z2hs.au'].includes(url.hostname);
  } catch {
    return false;
  }
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
    ftpConfig,
    ftpDestEnabled,
    ftpDestConfig,
    ftpSyncSettings,
    autoEject,
    playSoundOnComplete,
    completeSoundPath,
    openFolderOnComplete,
    verifyChecksums,
    selectedSource,
    phase,
    destination,
    autoImport,
    autoImportDestRoot,
    burstGrouping,
    burstWindowSec,
    normalizeExposure,
    exposureMaxStops,
    exposureAdjustmentStep,
    metadataKeywords,
    metadataTitle,
    metadataCaption,
    metadataCreator,
    metadataCopyright,
    watermarkEnabled,
    watermarkMode,
    watermarkText,
    watermarkImagePath,
    watermarkOpacity,
    watermarkPositionLandscape,
    watermarkPositionPortrait,
    watermarkScale,
    autoStraighten,
    selectionSets,
    licenseStatus,
    gpuFaceAcceleration,
    gpuDeviceId = -1,
    rawPreviewCache,
    cpuOptimization,
    rawPreviewQuality,
    reviewFaceAnalysis,
    reviewFaceMatching,
    reviewPersonDetection,
    reviewVisualDuplicates,
    perfTier,
    fastKeeperMode,
    cullConfidence,
    groupPhotoEveryoneGood,
    keeperQuota,
    previewConcurrency,
    faceConcurrency,
    keybinds,
    metadataExport,
    whiteBalanceTemperature,
    whiteBalanceTint,
  } = useAppState();
  const dispatch = useAppDispatch();
  const { updateState, checkNow, downloadUpdate, installUpdate, openRelease } = useUpdateNotification();
  const [postImportStatus, setPostImportStatus] = useState<string | null>(null);
  const [licenseInput, setLicenseInput] = useState('');
  const [licenseBusy, setLicenseBusy] = useState(false);
  const [licenseFeedback, setLicenseFeedback] = useState<string | null>(null);
  const [gpuStatus, setGpuStatus] = useState<boolean | null>(null);
  const [gpus, setGpus] = useState<Array<{ id: number; name: string; adapterCompatibility?: string; videoMemoryMB?: number }>>([]);
  const [executionProvider, setExecutionProvider] = useState<string | null>(null);
  const [faceCacheClearing, setFaceCacheClearing] = useState(false);
  const [trialBusy, setTrialBusy] = useState(false);
  const [trialFeedback, setTrialFeedback] = useState<string | null>(null);
  const [trialEmailInput, setTrialEmailInput] = useState('');
  const [trialNameInput, setTrialNameInput] = useState('');
  const [showTrialForm, setShowTrialForm] = useState(false);
  const [showBuyForm, setShowBuyForm] = useState(false);
  const [buyPlan, setBuyPlan] = useState<'monthly' | 'yearly' | 'lifetime'>('lifetime');
  const [buyBusy, setBuyBusy] = useState(false);
  const [buyFeedback, setBuyFeedback] = useState<string | null>(null);
  const [buyNameInput, setBuyNameInput] = useState('');
  const [buyEmailInput, setBuyEmailInput] = useState('');
  const [activeTopic, setActiveTopic] = useState<SettingsTopic>('general');
  const settingsBodyRef = useRef<HTMLDivElement | null>(null);
  const performanceSectionRef = useRef<HTMLDivElement | null>(null);
  const [gpuLoadStreams, setGpuLoadStreams] = useState(8);

  const BASE_URL = 'https://keptra.z2hs.au';
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagResult, setDiagResult] = useState<string | null>(null);
  const [diagnosticsSnapshot, setDiagnosticsSnapshot] = useState<AppDiagnosticsSnapshot | null>(null);
  const [updateRepairBusy, setUpdateRepairBusy] = useState(false);
  const [macDoctor, setMacDoctor] = useState<MacFirstRunDoctor | null>(null);
  const activationCode = licenseStatus?.activationCode?.trim() || '';
  const wbTemperature = whiteBalanceTemperature ?? 0;
  const wbTint = whiteBalanceTint ?? 0;
  const wbKelvin = whiteBalanceTemperatureToKelvin(wbTemperature);

  const formatDisplayDate = (value?: string) => {
    if (!value) return 'Never';
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const [year, month, day] = value.split('-');
      return `${day}-${month}-${year}`;
    }
    return value;
  };

  const formatVersionDate = (value?: string) => {
    if (!value) return 'Unknown';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat('en-AU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(date);
  };

  const getDaysUntilExpiry = (value?: string) => {
    if (!value) return null;
    const expiry = new Date(`${value}T23:59:59`);
    if (Number.isNaN(expiry.getTime())) return null;
    const now = new Date();
    const diff = expiry.getTime() - now.getTime();
    return Math.ceil(diff / (1000 * 60 * 60 * 24));
  };

  const effectiveActivatedAt = licenseStatus?.activatedAt ?? licenseStatus?.entitlement?.activatedAt;
  const effectiveExpiresAt = licenseStatus?.expiresAt ?? licenseStatus?.entitlement?.activationExpiresAt ?? licenseStatus?.entitlement?.expiresAt;

  const openLicenseManagement = async () => {
    const code = activationCode;
    const url = code
      ? `${BASE_URL}/manage-license?code=${encodeURIComponent(code)}`
      : `${BASE_URL}/manage-license`;
    await window.electronAPI.openExternal(url);
  };

  useEffect(() => {
    // Poll GPU status — ONNX warms up 5s after startup, so retry a few times
    const fetchGpuStatus = async () => {
      try {
        const [gpu, ep] = await Promise.all([
          window.electronAPI.isGpuAvailable?.() ?? Promise.resolve(null),
          window.electronAPI.getExecutionProvider?.() ?? Promise.resolve({ ep: null, models: [] }),
        ]);
        setGpuStatus(gpu);
        if (ep?.models?.length) {
          setExecutionProvider(ep.models.map((m) => `${m.model}:${m.provider}${m.deviceId !== undefined ? `#${m.deviceId}` : ''}${m.avgInferenceMs ? ` ${m.avgInferenceMs.toFixed(0)}ms` : ''}`).join(' · '));
        } else if (ep?.ep) {
          setExecutionProvider(ep.ep);
        }
        // If not yet determined, retry after 3s (ONNX may still be loading)
        if (gpu === null) setTimeout(fetchGpuStatus, 3000);
      } catch { /* ignore */ }
    };
    void fetchGpuStatus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.getSettings()
      .then((settings) => {
        if (!cancelled && typeof settings.gpuStressStreams === 'number') {
          setGpuLoadStreams(Math.max(1, Math.min(32, Math.round(settings.gpuStressStreams))));
        }
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    window.electronAPI.listGpus?.().then((items) => setGpus(items ?? [])).catch(() => setGpus([]));
  }, []);

  useEffect(() => {
    setLicenseInput(licenseStatus?.activationCode ?? licenseStatus?.key ?? '');
    if (licenseStatus?.valid) setLicenseFeedback(null);
  }, [licenseStatus?.activationCode, licenseStatus?.key, licenseStatus?.valid]);

  useEffect(() => {
    const openPerformance = () => {
      setActiveTopic('workflow');
      window.setTimeout(() => {
        performanceSectionRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }, 80);
    };
    window.addEventListener(OPEN_PERFORMANCE_EVENT, openPerformance);
    return () => window.removeEventListener(OPEN_PERFORMANCE_EVENT, openPerformance);
  }, []);

  useEffect(() => {
    settingsBodyRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, [activeTopic]);

  useEffect(() => {
    if (activeTopic !== 'diagnostics') return;
    void refreshDiagnosticsSnapshot().catch(() => undefined);
  }, [activeTopic]);

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
      | 'autoImport' | 'burstGrouping' | 'normalizeExposure' | 'verifyChecksums'
      | 'watermarkEnabled' | 'autoStraighten',
    value: boolean,
  ) => {
    dispatch({ type: 'SET_WORKFLOW_OPTION', key, value });
    set(key, value);
  };

  const handleWorkflowString = (
    key: 'protectedFolderName' | 'backupDestRoot' | 'autoImportDestRoot' | 'completeSoundPath' | 'watermarkImagePath',
    value: string,
  ) => {
    dispatch({ type: 'SET_WORKFLOW_STRING', key, value });
    set(key, value);
  };

  const handleMetadataString = (
    key: 'metadataKeywords' | 'metadataTitle' | 'metadataCaption' | 'metadataCreator' | 'metadataCopyright' | 'watermarkText' | 'watermarkImagePath',
    value: string,
  ) => {
    dispatch({ type: 'SET_WORKFLOW_STRING', key, value });
    set(key, value);
  };

  const handleWatermarkNumber = (key: 'watermarkOpacity' | 'watermarkScale', value: number) => {
    dispatch({ type: 'SET_WATERMARK_NUMBER', key, value });
    set(key, value);
  };

  const handleWatermarkPosition = (orientation: 'landscape' | 'portrait', position: WatermarkPosition) => {
    dispatch({ type: 'SET_WATERMARK_POSITION', orientation, position });
    void window.electronAPI.setSettings({
      [orientation === 'portrait' ? 'watermarkPositionPortrait' : 'watermarkPositionLandscape']: position,
    });
  };

  const handleWatermarkMode = (mode: WatermarkMode) => {
    dispatch({ type: 'SET_WATERMARK_MODE', mode });
    set('watermarkMode', mode);
  };

  const handleExposureAdjustmentStep = (step: number) => {
    dispatch({ type: 'SET_EXPOSURE_ADJUSTMENT_STEP', step });
    set('exposureAdjustmentStep', step);
  };

  const handleBurstWindow = (seconds: number) => {
    dispatch({ type: 'SET_BURST_WINDOW', seconds });
    set('burstWindowSec', seconds);
  };

  const handlePerformanceOption = (key: 'gpuFaceAcceleration' | 'rawPreviewCache' | 'cpuOptimization', value: boolean) => {
    dispatch({ type: 'SET_PERFORMANCE_OPTION', key, value });
    void window.electronAPI.setSettings({ [key]: value });
  };
  const handleReviewPerformanceOption = (
    key: 'reviewFaceAnalysis' | 'reviewFaceMatching' | 'reviewPersonDetection' | 'reviewVisualDuplicates',
    value: boolean,
  ) => {
    dispatch({ type: 'SET_REVIEW_PERFORMANCE_OPTION', key, value });
    const patch: Partial<AppSettings> = { [key]: value };
    if (key === 'reviewFaceAnalysis' && !value) {
      patch.reviewFaceMatching = false;
      patch.reviewPersonDetection = false;
      dispatch({ type: 'SET_REVIEW_PERFORMANCE_OPTION', key: 'reviewFaceMatching', value: false });
      dispatch({ type: 'SET_REVIEW_PERFORMANCE_OPTION', key: 'reviewPersonDetection', value: false });
    }
    void window.electronAPI.setSettings(patch);
  };
  const handleGpuDevice = async (deviceId: number) => {
    const next = Number.isFinite(deviceId) ? Math.max(-1, Math.round(deviceId)) : -1;
    dispatch({ type: 'SET_GPU_DEVICE_ID', deviceId: next });
    await window.electronAPI.setSettings({ gpuDeviceId: next });
    setDiagResult(next >= 0 ? `DirectML will use GPU adapter ${next} after the face engine reloads.` : 'DirectML will use the Windows default GPU after reload.');
  };
  const handleWhiteBalance = (temperature: number, tint: number) => {
    dispatch({ type: 'SET_WHITE_BALANCE', temperature, tint });
    window.electronAPI.setSettings({ whiteBalanceTemperature: temperature, whiteBalanceTint: tint });
  };
  const handleRawPreviewQuality = (quality: number) => {
    dispatch({ type: 'SET_RAW_PREVIEW_QUALITY', quality });
    void window.electronAPI.setSettings({ rawPreviewQuality: quality });
  };
  const handlePerfTier = (tier: 'auto' | 'low' | 'balanced' | 'high') => {
    const nextPreviewConcurrency =
      tier === 'low' ? 1 :
        tier === 'balanced' ? 2 :
          tier === 'high' ? Math.max(3, previewConcurrency) :
            previewConcurrency;
    const nextFaceConcurrency =
      tier === 'low' ? 1 :
        tier === 'balanced' ? Math.max(2, faceConcurrency) :
          tier === 'high' ? Math.max(4, faceConcurrency) :
            faceConcurrency;
    const nextCpuOptimization =
      tier === 'auto' ? cpuOptimization :
        tier === 'high' ? false : true;
    const nextRawPreviewQuality =
      tier === 'low' ? Math.min(rawPreviewQuality, 60) :
        tier === 'balanced' ? Math.max(65, Math.min(rawPreviewQuality, 75)) :
          tier === 'high' ? Math.max(rawPreviewQuality, 82) :
            rawPreviewQuality;
    const nextReviewFaceAnalysis = tier === 'auto' ? reviewFaceAnalysis : tier !== 'low';
    const nextReviewFaceMatching = tier === 'auto' ? reviewFaceMatching : tier !== 'low';
    const nextReviewPersonDetection = tier === 'auto' ? reviewPersonDetection : tier !== 'low';
    const nextReviewVisualDuplicates = tier === 'auto' ? reviewVisualDuplicates : tier !== 'low';
    dispatch({ type: 'SET_PERF_TIER', tier });
    void window.electronAPI.setSettings({
      perfTier: tier,
      previewConcurrency: nextPreviewConcurrency,
      faceConcurrency: nextFaceConcurrency,
      cpuOptimization: nextCpuOptimization,
      rawPreviewQuality: nextRawPreviewQuality,
      reviewFaceAnalysis: nextReviewFaceAnalysis,
      reviewFaceMatching: nextReviewFaceMatching,
      reviewPersonDetection: nextReviewPersonDetection,
      reviewVisualDuplicates: nextReviewVisualDuplicates,
    });
    void window.electronAPI.setFaceAnalysisConcurrency?.(nextFaceConcurrency);
  };
  const handleFastKeeperMode = (enabled: boolean) => {
    dispatch({ type: 'SET_FAST_KEEPER_MODE', enabled });
    void window.electronAPI.setSettings({ fastKeeperMode: enabled });
  };
  const handleCullConfidence = (confidence: CullConfidence) => {
    dispatch({ type: 'SET_CULL_CONFIDENCE', confidence });
    void window.electronAPI.setSettings({ cullConfidence: confidence });
  };
  const handleGroupPhotoEveryoneGood = (enabled: boolean) => {
    dispatch({ type: 'SET_GROUP_PHOTO_EVERYONE_GOOD', enabled });
    void window.electronAPI.setSettings({ groupPhotoEveryoneGood: enabled });
  };
  const handleKeeperQuota = (quota: KeeperQuota) => {
    dispatch({ type: 'SET_KEEPER_QUOTA', quota });
    void window.electronAPI.setSettings({ keeperQuota: quota });
  };

  // ── Keybind handlers ─────────────────────────────────────────────────────
  const [rebindingAction, setRebindingAction] = useState<keyof typeof keybinds | null>(null);
  const rebindCaptureRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (rebindingAction) {
      rebindCaptureRef.current?.focus();
    }
  }, [rebindingAction]);

  const handleStartRebind = (action: keyof typeof keybinds) => {
    setRebindingAction(action);
  };

  const handleKeyCapture = (e: React.KeyboardEvent, action: keyof typeof keybinds) => {
    e.preventDefault();
    e.stopPropagation();
    // Ignore modifier-only presses
    if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return;
    const duplicate = Object.entries(keybinds).find(([otherAction, key]) =>
      otherAction !== action && key === e.key,
    );
    if (duplicate) {
      setDiagResult(`Key "${e.key}" is already assigned. Clear or change that shortcut first.`);
      setRebindingAction(null);
      return;
    }
    dispatch({ type: 'SET_KEYBIND', action, key: e.key });
    void window.electronAPI.setSettings({ keybinds: { ...keybinds, [action]: e.key } });
    setDiagResult(null);
    setRebindingAction(null);
  };

  const handleResetKeybinds = () => {
    dispatch({ type: 'RESET_KEYBINDS' });
    void window.electronAPI.setSettings({ keybinds: DEFAULT_KEYBINDS });
    setRebindingAction(null);
  };

  // ── Metadata export handlers ─────────────────────────────────────────────
  const handleMetadataExport = (flag: keyof typeof metadataExport, value: boolean) => {
    dispatch({ type: 'SET_METADATA_EXPORT', flags: { [flag]: value } });
    void window.electronAPI.setSettings({ metadataExport: { ...metadataExport, [flag]: value } });
  };

  const handleFastRawIngest = () => {
    dispatch({ type: 'SET_SAVE_FORMAT', format: 'original' });
    dispatch({ type: 'SET_SKIP_DUPLICATES', value: false });
    dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'verifyChecksums', value: false });
    dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'ftpDestEnabled', value: false });
    dispatch({ type: 'SET_WORKFLOW_STRING', key: 'backupDestRoot', value: '' });
    dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'normalizeExposure', value: false });
    dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'autoStraighten', value: false });
    dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'watermarkEnabled', value: false });
    dispatch({ type: 'SET_METADATA_EXPORT', flags: FAST_RAW_METADATA_EXPORT });
    void window.electronAPI.setSettings({
      saveFormat: 'original',
      skipDuplicates: false,
      verifyChecksums: false,
      ftpDestEnabled: false,
      backupDestRoot: '',
      normalizeExposure: false,
      autoStraighten: false,
      watermarkEnabled: false,
      metadataExport: FAST_RAW_METADATA_EXPORT,
    });
  };

  const handleFaceConcurrency = (concurrency: number) => {
    const next = Math.max(1, Math.min(32, Math.round(concurrency)));
    dispatch({ type: 'SET_FACE_CONCURRENCY', concurrency: next });
    void window.electronAPI.setSettings({ faceConcurrency: next });
    void window.electronAPI.setFaceAnalysisConcurrency?.(next);
  };

  const handleGpuLoadStreams = (streams: number) => {
    const next = Math.max(1, Math.min(32, Math.round(streams)));
    setGpuLoadStreams(next);
    void window.electronAPI.setSettings({ gpuStressStreams: next });
  };

  const handlePreviewConcurrency = (concurrency: number) => {
    const next = Math.max(1, Math.min(12, Math.round(concurrency)));
    dispatch({ type: 'SET_PREVIEW_CONCURRENCY', concurrency: next });
    void window.electronAPI.setSettings({ previewConcurrency: next });
  };

  const handleOptimizeForDevice = async () => {
    setDiagnosing(true);
    setDiagResult('Checking this device...');
    try {
      const [profile, diag] = await Promise.all([
        window.electronAPI.getDeviceTier?.(),
        window.electronAPI.diagnoseFaceEngine?.(),
      ]);
      if (!profile) {
        setDiagResult('Could not read device profile.');
        return;
      }

      const dmlModels = diag?.models?.filter((m) => m.provider === 'dml') ?? [];
      const dmlActive = dmlModels.some((m) => m.model === 'detector' || m.model === 'embedder');
      const avgDmlMs = dmlModels.length
        ? dmlModels.reduce((sum, model) => sum + (model.avgInferenceMs ?? model.dmlAvgInferenceMs ?? 0), 0) / dmlModels.length
        : undefined;
      const cpuCores = profile.cpuCores;
      const faceTarget = dmlActive
        ? avgDmlMs !== undefined && avgDmlMs < 8
          ? 24
          : avgDmlMs !== undefined && avgDmlMs < 16
            ? 16
            : avgDmlMs !== undefined && avgDmlMs < 45
              ? 12
              : Math.min(8, Math.max(4, Math.floor(cpuCores / 2)))
        : profile.tier === 'high'
          ? Math.min(8, Math.max(3, Math.floor(cpuCores / 4)))
          : profile.tier === 'balanced'
            ? 2
            : 1;
      const previewTarget = profile.tier === 'high'
        ? Math.min(8, Math.max(profile.previewConcurrency, 4))
        : profile.previewConcurrency;
      const rawQualityTarget = dmlActive && profile.tier === 'high'
        ? Math.max(80, profile.rawPreviewQuality)
        : profile.rawPreviewQuality;
      const gpuStressStreamsTarget = dmlActive
        ? avgDmlMs !== undefined && avgDmlMs < 5
          ? 16
          : 8
        : 4;
      const cpuOptimizationTarget = !dmlActive && profile.cpuOptimization;
      const fastKeeperTarget = profile.tier === 'low' && !dmlActive;
      const reviewFaceAnalysisTarget = !fastKeeperTarget;
      const reviewFaceMatchingTarget = !fastKeeperTarget;
      const reviewPersonDetectionTarget = !fastKeeperTarget;
      const reviewVisualDuplicatesTarget = !fastKeeperTarget;
      const spec = `${profile.cpuCores} CPU threads, ${profile.totalMemGB}GB RAM, ${dmlActive ? `DirectML ${avgDmlMs !== undefined ? `${avgDmlMs.toFixed(1)}ms avg` : `(${dmlModels.map((m) => m.model).join('/')})`}` : 'CPU face analysis'}`;
      const summary = `Recommended for ${spec}: face scans ${faceTarget}, GPU load streams ${gpuStressStreamsTarget}, preview workers ${previewTarget}, RAW quality ${rawQualityTarget}%, ${cpuOptimizationTarget ? 'CPU optimization on' : 'CPU optimization off'}, ${fastKeeperTarget ? 'Fast Keeper on, expensive review stages off' : 'full AI review on'}.`;
      setDiagResult(summary);

      if (!window.confirm(`${summary}\n\nApply these settings now?`)) return;

      dispatch({ type: 'SET_PERF_TIER', tier: profile.tier });
      dispatch({ type: 'SET_PREVIEW_CONCURRENCY', concurrency: previewTarget });
      dispatch({ type: 'SET_FACE_CONCURRENCY', concurrency: faceTarget });
      dispatch({ type: 'SET_RAW_PREVIEW_QUALITY', quality: rawQualityTarget });
      dispatch({ type: 'SET_FAST_KEEPER_MODE', enabled: fastKeeperTarget });
      dispatch({ type: 'SET_PERFORMANCE_OPTION', key: 'cpuOptimization', value: cpuOptimizationTarget });
      dispatch({ type: 'SET_PERFORMANCE_OPTION', key: 'gpuFaceAcceleration', value: dmlActive || !!diag?.gpuAvailable });
      dispatch({ type: 'SET_REVIEW_PERFORMANCE_OPTION', key: 'reviewFaceAnalysis', value: reviewFaceAnalysisTarget });
      dispatch({ type: 'SET_REVIEW_PERFORMANCE_OPTION', key: 'reviewFaceMatching', value: reviewFaceMatchingTarget });
      dispatch({ type: 'SET_REVIEW_PERFORMANCE_OPTION', key: 'reviewPersonDetection', value: reviewPersonDetectionTarget });
      dispatch({ type: 'SET_REVIEW_PERFORMANCE_OPTION', key: 'reviewVisualDuplicates', value: reviewVisualDuplicatesTarget });
      setGpuLoadStreams(gpuStressStreamsTarget);
      await window.electronAPI.setSettings({
        perfTier: profile.tier,
        previewConcurrency: previewTarget,
        faceConcurrency: faceTarget,
        gpuStressStreams: gpuStressStreamsTarget,
        rawPreviewQuality: rawQualityTarget,
        fastKeeperMode: fastKeeperTarget,
        cpuOptimization: cpuOptimizationTarget,
        gpuFaceAcceleration: dmlActive || !!diag?.gpuAvailable,
        reviewFaceAnalysis: reviewFaceAnalysisTarget,
        reviewFaceMatching: reviewFaceMatchingTarget,
        reviewPersonDetection: reviewPersonDetectionTarget,
        reviewVisualDuplicates: reviewVisualDuplicatesTarget,
      });
      await window.electronAPI.setFaceAnalysisConcurrency?.(faceTarget);
      setDiagResult(`${summary} Applied.`);
    } catch (e) {
      setDiagResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDiagnosing(false);
    }
  };

  const handleDiagnose = async () => {
    setDiagnosing(true);
    setDiagResult(null);
    try {
      const r = await window.electronAPI.diagnoseFaceEngine?.();
      if (r) {
        setDiagResult(
          `${r.models?.length
            ? r.models.map((m) => `${m.model}:${m.provider}${m.deviceId !== undefined ? `#${m.deviceId}` : ''}${m.avgInferenceMs ? ` ${m.avgInferenceMs.toFixed(0)}ms` : ''}`).join(' | ')
            : `EP: ${r.ep ?? 'unknown'}`} | GPU: ${r.gpuAvailable ? 'yes' : 'no'} | ` +
          `Detector check: ${r.avgInferenceMs.toFixed(0)}ms | Session load: ${r.sessionLoadMs}ms`
        );
      }
    } catch (e) {
      setDiagResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDiagnosing(false);
    }
  };

  const handleExportDiagnostics = async () => {
    setDiagnosing(true);
    setDiagResult('Exporting diagnostics...');
    try {
      const dir = await window.electronAPI.exportDiagnostics();
      setDiagResult(`Diagnostics exported: ${dir}`);
      await window.electronAPI.openPath(dir);
    } catch (e) {
      setDiagResult(`Diagnostics export error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDiagnosing(false);
    }
  };

  const refreshDiagnosticsSnapshot = async () => {
    const snapshot = await window.electronAPI.getDiagnosticsSnapshot();
    setDiagnosticsSnapshot(snapshot);
    return snapshot;
  };

  const handleCopyDiagnostics = async () => {
    try {
      const snapshot = diagnosticsSnapshot ?? await refreshDiagnosticsSnapshot();
      await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2));
      setDiagResult('Diagnostics copied to clipboard.');
    } catch (e) {
      setDiagResult(`Could not copy diagnostics: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleRepairUpdates = async () => {
    setUpdateRepairBusy(true);
    setDiagResult('Repairing update cache and checking endpoints...');
    try {
      const result = await window.electronAPI.repairUpdates();
      setDiagnosticsSnapshot(result.diagnostics);
      setDiagResult(`${result.message} Cleared ${result.cleared.length} update cache item${result.cleared.length === 1 ? '' : 's'}.`);
    } catch (e) {
      setDiagResult(`Repair updates failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setUpdateRepairBusy(false);
    }
  };

  const handleMacFirstRunDoctor = async () => {
    setDiagnosing(true);
    setDiagResult('Running macOS first-run doctor...');
    try {
      const result = await window.electronAPI.runMacFirstRunDoctor();
      setMacDoctor(result);
      const failed = result.checks.filter((check) => !check.ok).length;
      setDiagResult(`${result.supported ? 'macOS' : 'Current platform'} doctor: ${result.checks.length - failed}/${result.checks.length} checks passed.`);
    } catch (e) {
      setDiagResult(`macOS doctor error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDiagnosing(false);
    }
  };

  const handleRunBenchmarkSmoke = async () => {
    setDiagnosing(true);
    setDiagResult('Running smoke benchmark...');
    try {
      const result = await window.electronAPI.runBenchmarkSmoke();
      if (result.ok) {
        setDiagResult(`Smoke benchmark wrote ${result.records} records for ${result.files} fixtures (${result.bytes} bytes): ${result.outPath}`);
      } else {
        setDiagResult(`Smoke benchmark failed: ${result.error ?? 'unknown error'}`);
      }
    } catch (e) {
      setDiagResult(`Smoke benchmark error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDiagnosing(false);
    }
  };

  const handleOpenBenchmarkOutput = async () => {
    try {
      const dir = await window.electronAPI.openBenchmarkOutput();
      setDiagResult(`Benchmark output opened: ${dir}`);
    } catch (e) {
      setDiagResult(`Could not open benchmark output: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleGpuStressTest = async () => {
    setDiagnosing(true);
    setDiagResult(`Running an 8 second DirectML load test with ${gpuLoadStreams} streams. Watch Task Manager > GPU > Compute.`);
    try {
      const r = await window.electronAPI.stressTestFaceGpu?.(8000, gpuLoadStreams);
      if (!r) return;
      const active = r.models
        ?.filter((m) => m.provider === 'dml')
        .map((m) => `${m.model}${m.deviceId !== undefined ? `#${m.deviceId}` : ''}`)
        .join('/');
      setDiagResult(
        `Load test ${r.ep ?? 'unknown'}${active ? ` (${active})` : ''}, ${r.streams} streams: ${r.totalRuns} runs in ${(r.durationMs / 1000).toFixed(1)}s, ` +
        `${r.runsPerSecond}/s. Detector ${r.detectorAvgMs.toFixed(2)}ms, embedder ${r.embedderAvgMs.toFixed(2)}ms. ` +
        'If Task Manager is quiet, switch the graph to Compute_0/Compute_1 or CUDA/DirectML.'
      );
    } catch (e) {
      setDiagResult(`Load test error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDiagnosing(false);
    }
  };

  const handleClearFaceCache = async () => {
    setFaceCacheClearing(true);
    try {
      await window.electronAPI.clearFaceCache();
      // Reset face data in the renderer overlay so files re-enter the candidate
      // list and get re-analyzed from scratch against the now-empty cache.
      dispatch({ type: 'CLEAR_FACE_DATA' });
      window.dispatchEvent(new Event('photo-importer:resume-ai'));
    } finally {
      setFaceCacheClearing(false);
    }
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

  const handleFtpSourceConfig = (config: Partial<typeof ftpConfig>) => {
    const next = { ...ftpConfig, ...config };
    dispatch({ type: 'SET_FTP_CONFIG', config });
    set('ftpConfig', next);
  };

  const handleFtpSyncSettings = (patch: Partial<typeof ftpSyncSettings>) => {
    const next = { ...ftpSyncSettings, ...patch };
    dispatch({ type: 'SET_FTP_SYNC_SETTINGS', settings: patch });
    set('ftpSync', next);
  };

  const handleChooseFtpSyncDest = async () => {
    const folder = await window.electronAPI.selectFolder('Select FTP Sync Destination');
    if (folder) handleFtpSyncSettings({ localDestRoot: folder });
  };

  const handleRunFtpWorkflowNow = async () => {
    const result = await window.electronAPI.runFtpSync();
    dispatch({ type: 'SET_FTP_SYNC_STATUS', status: result.status });
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
    playCompletionSound(completeSoundPath);
  };

  const handleChooseWatermarkImage = async () => {
    const file = await window.electronAPI.selectFile('Choose Watermark Image', [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
      { name: 'All Files', extensions: ['*'] },
    ]);
    if (!file) return;
    handleWorkflowBool('watermarkEnabled', true);
    handleWatermarkMode('image');
    handleWorkflowString('watermarkImagePath', file);
  };

  const handleEjectCurrentSource = async () => {
    if (!selectedSource || phase === 'scanning' || phase === 'importing') return;
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

  const handleActivateLicense = async () => {
    setLicenseBusy(true);
    try {
      const status = await window.electronAPI.activateLicense(licenseInput);
      if (status.valid) {
        dispatch({ type: 'SET_LICENSE_STATUS', status });
        setLicenseFeedback(null);
        setLicenseInput(status.activationCode ?? status.key ?? '');
      } else {
        setLicenseFeedback(status.message);
      }
    } catch {
      setLicenseFeedback('Could not activate license. Check your connection and try again.');
    } finally {
      setLicenseBusy(false);
    }
  };

  const handleClearLicense = async () => {
    setLicenseBusy(true);
    try {
      const status = await window.electronAPI.clearLicense();
      dispatch({ type: 'SET_LICENSE_STATUS', status });
      setLicenseInput('');
      setLicenseFeedback(null);
    } catch {
      setLicenseFeedback('Could not clear license. Try again.');
    } finally {
      setLicenseBusy(false);
    }
  };

  const expiryDaysRemaining = getDaysUntilExpiry(effectiveExpiresAt);
  const isTimedLicense = Boolean(effectiveExpiresAt);
  const showExpiryWarning = isTimedLicense && expiryDaysRemaining != null && expiryDaysRemaining <= 14;
  const activeTopicMeta = SETTINGS_TOPICS.find((topic) => topic.id === activeTopic) ?? SETTINGS_TOPICS[0];
  const settingsSummary = [
    {
      label: 'Account',
      value: licenseStatus?.valid ? 'Active' : 'Needs activation',
      tone: licenseStatus?.valid ? 'success' : 'warning',
    },
    {
      label: 'Destination',
      value: destination ? 'Ready' : 'Not set',
      tone: destination ? 'success' : 'warning',
    },
    {
      label: 'Updates',
      value: updateState.status === 'available' ? 'Available' : updateState.status === 'ready' ? 'Ready' : updateState.currentVersion,
      tone: updateState.status === 'error' || updateState.status === 'denied'
        ? 'danger'
        : updateState.status === 'available' || updateState.status === 'ready'
          ? 'warning'
          : 'neutral',
    },
    {
      label: 'Ingest',
      value: verifyChecksums || backupDestRoot || ftpDestEnabled || normalizeExposure || saveFormat !== 'original'
        ? 'Quality checks'
        : 'Fast raw',
      tone: verifyChecksums || backupDestRoot || ftpDestEnabled || normalizeExposure || saveFormat !== 'original'
        ? 'primary'
        : 'success',
    },
  ] as const;

  const handleRequestTrial = async () => {
    const name = trialNameInput.trim();
    const email = trialEmailInput.trim();
    if (!name || !email) {
      setTrialFeedback('Please enter your name and email address.');
      return;
    }
    setTrialBusy(true);
    setTrialFeedback(null);
    try {
      const resp = await fetch('https://keptra.z2hs.au/api/v1/trial/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email }),
      });
      const data = await resp.json() as { ok?: boolean; activationCode?: string; expiresLabel?: string; error?: string };
      if (!resp.ok || !data.ok) {
        setTrialFeedback(data.error ?? 'Could not start trial. Please try again.');
        return;
      }
      // Auto-activate the returned code
      const status = await window.electronAPI.activateLicense(data.activationCode ?? '');
      if (status.valid) {
        dispatch({ type: 'SET_LICENSE_STATUS', status });
        setLicenseFeedback(null);
        setShowTrialForm(false);
        setTrialEmailInput('');
        setTrialNameInput('');
      } else {
        // Key was issued but activation failed — tell user to check email
        setTrialFeedback(`Trial issued! Check ${email} for your license key.`);
      }
    } catch {
      setTrialFeedback('Network error — check your connection and try again.');
    } finally {
      setTrialBusy(false);
    }
  };

  const handleBuy = async () => {
    const name = buyNameInput.trim();
    const email = buyEmailInput.trim();
    if (!name || !email) { setBuyFeedback('Name and email required.'); return; }
    setBuyBusy(true);
    setBuyFeedback(null);
    try {
      const resp = await fetch(`${BASE_URL}/api/v1/checkout/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: buyPlan, name, email }),
      });
      const data = await resp.json() as { url?: string; error?: string };
      if (!resp.ok || !data.url) {
        setBuyFeedback(data.error ?? 'Could not create checkout. Try again.');
        return;
      }
      if (!isSafeCheckoutUrl(data.url)) {
        setBuyFeedback('Checkout link failed security checks. Please contact support.');
        return;
      }
      // Open Stripe Checkout in the system browser
      await window.electronAPI.openExternal(data.url);
      setBuyFeedback('Checkout opened in your browser. Your license key will be emailed once payment is confirmed.');
    } catch {
      setBuyFeedback('Network error — check your connection.');
    } finally {
      setBuyBusy(false);
    }
  };

  const watermarkPreviewUrl = watermarkImagePath
    ? `file://${watermarkImagePath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')}`
    : '';
  const watermarkPreviewLabel = watermarkMode === 'image'
    ? (watermarkImagePath ? watermarkImagePath.split(/[/\\]/).pop() : 'No image selected')
    : (watermarkText.trim() || 'Watermark');

  // Shared inner content (header + scrollable body)
  const inner = (
    <div className={`bg-surface border border-border ${inline ? 'flex flex-col h-full' : 'rounded-xl shadow-2xl w-[520px] max-h-[80vh] flex flex-col overflow-hidden'}`}>
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border shrink-0">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <SunMoon className="h-4 w-4 text-accent" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-text">Settings</h2>
          </div>
          <p className="mt-0.5 truncate text-[10px] text-text-muted">
            {activeTopicMeta.label} controls
          </p>
        </div>
        <div className="flex items-center gap-2">
          {inline && (
            <span className="hidden rounded border border-border bg-surface-alt px-2 py-1 text-[10px] text-text-muted sm:inline">
              Ctrl/Cmd+K opens every command
            </span>
          )}
          <IconButton
            icon={inline ? ArrowLeft : X}
            label={inline ? 'Back to review (Esc)' : 'Close settings (Esc)'}
            onClick={onClose}
          />
        </div>
      </div>

      {/* Scrollable body */}
      <div ref={settingsBodyRef} className={`overflow-y-auto flex-1 space-y-4 ${inline ? 'px-5 py-3' : 'px-4 py-3'}`}>
          <div className="sticky top-0 z-10 -mx-1 border-b border-border bg-surface/95 px-1 pb-3 backdrop-blur">
            <div className="flex gap-1 overflow-x-auto">
              {SETTINGS_TOPICS.map((topic) => {
                const TopicIcon = SETTINGS_TOPIC_ICONS[topic.id];
                return (
                  <button
                    key={topic.id}
                    type="button"
                    onClick={() => setActiveTopic(topic.id)}
                    className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] transition-colors ${
                      activeTopic === topic.id
                        ? 'bg-accent text-white shadow-sm'
                        : 'bg-surface-raised text-text-secondary hover:text-text'
                    }`}
                  >
                    <TopicIcon className="h-3.5 w-3.5" aria-hidden="true" />
                    {topic.label}
                  </button>
                );
              })}
            </div>
          </div>

          <section className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {settingsSummary.map((item) => (
              <div key={item.label} className="rounded border border-border bg-surface-alt px-3 py-2">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">{item.label}</div>
                <StatusPill tone={item.tone}>{item.value}</StatusPill>
              </div>
            ))}
          </section>

          {activeTopic === 'health' && (
            <ImportHealthDashboard />
          )}

          {/* Appearance */}
          {activeTopic === 'general' && (
          <section>
            <SectionHeader icon={SlidersHorizontal} title="Appearance" />
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
          )}

          {/* Import */}
          {activeTopic === 'general' && (
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
          )}

          {/* License — compact */}
          {activeTopic === 'account' && (
          <section>
            <SectionHeader icon={CreditCard} title="License" />
            {licenseStatus?.valid ? (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-emerald-300 font-medium">✓ Active</span>
                  {licenseStatus.entitlement?.name && (
                    <span className="text-[10px] text-text-muted">{licenseStatus.entitlement.name}</span>
                  )}
                  {licenseStatus.deviceSlotsUsed != null && (
                    <span className="text-[10px] text-text-muted ml-auto">{licenseStatus.deviceSlotsUsed}/{licenseStatus.deviceSlotsTotal ?? licenseStatus.entitlement?.maxDevices ?? '∞'} seats</span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-1 text-[10px] text-text-muted">
                  <div className="bg-surface-alt border border-border rounded px-2 py-1">
                    Activated: <span className="text-text-secondary">{formatDisplayDate(effectiveActivatedAt)}</span>
                  </div>
                  <div className="bg-surface-alt border border-border rounded px-2 py-1">
                    Expires: <span className="text-text-secondary">{formatDisplayDate(effectiveExpiresAt)}</span>
                  </div>
                </div>
                <div className="text-[10px] text-text-muted">
                  Type: <span className="text-text-secondary">{isTimedLicense ? 'Timed' : 'Lifetime'}</span>
                </div>
                {showExpiryWarning && (
                  <div className="rounded border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[10px] text-amber-100">
                    {expiryDaysRemaining != null && expiryDaysRemaining > 0
                      ? `Your license expires in ${expiryDaysRemaining} day${expiryDaysRemaining === 1 ? '' : 's'}. Renew or upgrade before it lapses.`
                      : 'Your license has reached its expiry date. Renew or upgrade to keep using Pro features.'}
                  </div>
                )}
                {activationCode && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-text-muted">Code:</span>
                    <code className="text-[10px] font-mono text-text-secondary bg-surface-raised px-1.5 py-0.5 rounded truncate max-w-[160px]">
                      {activationCode}
                    </code>
                    <button
                      onClick={() => { void openLicenseManagement(); }}
                      className="text-[10px] text-text-muted hover:text-text ml-auto"
                    >
                      Manage
                    </button>
                    <button
                      onClick={handleClearLicense}
                      disabled={licenseBusy}
                      className="text-[10px] text-text-muted hover:text-text"
                      title="Remove the saved license from this app. This does not revoke it on the server."
                    >
                      Clear local
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                {/* CTA buttons */}
                {!showBuyForm && !showTrialForm && (
                  <div className="flex items-center gap-2 mb-1">
                    <button
                      onClick={() => { setShowBuyForm(true); setBuyFeedback(null); }}
                      className="px-3 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent-hover font-medium"
                    >
                      Buy license
                    </button>
                    <button
                      onClick={() => { setShowTrialForm(true); setTrialFeedback(null); }}
                      className="px-3 py-1.5 text-xs rounded bg-surface-raised border border-border text-text-secondary hover:text-text"
                    >
                      Try free for 14 days
                    </button>
                    <button
                      onClick={() => { void openLicenseManagement(); }}
                      className="text-[10px] text-text-muted hover:text-text ml-auto"
                    >
                      Manage existing
                    </button>
                  </div>
                )}

                {/* Buy form */}
                {showBuyForm && (
                  <div className="space-y-1.5 p-2.5 rounded-lg bg-surface-raised border border-border">
                    <p className="text-[10px] text-text-muted font-medium">Choose a plan</p>
                    <div className="grid grid-cols-3 gap-1">
                      {(['monthly', 'yearly', 'lifetime'] as const).map((p) => (
                        <button
                          key={p}
                          onClick={() => setBuyPlan(p)}
                          className={`px-2 py-1.5 text-[10px] rounded border capitalize ${buyPlan === p ? 'border-accent bg-accent/10 text-text' : 'border-border text-text-muted hover:text-text'}`}
                        >
                          {p === 'monthly' ? 'Monthly' : p === 'yearly' ? 'Yearly' : 'Lifetime'}
                        </button>
                      ))}
                    </div>
                    <input
                      type="text"
                      value={buyNameInput}
                      onChange={(e) => setBuyNameInput(e.target.value)}
                      placeholder="Your name"
                      className="w-full px-2 py-1 text-xs bg-surface border border-border rounded text-text placeholder-text-muted focus:border-text focus:outline-none"
                    />
                    <input
                      type="email"
                      value={buyEmailInput}
                      onChange={(e) => setBuyEmailInput(e.target.value)}
                      placeholder="Email address"
                      className="w-full px-2 py-1 text-xs bg-surface border border-border rounded text-text placeholder-text-muted focus:border-text focus:outline-none"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleBuy}
                        disabled={buyBusy || !buyNameInput.trim() || !buyEmailInput.trim()}
                        className="px-3 py-1 text-xs rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-50"
                      >
                        {buyBusy ? 'Opening…' : 'Continue to payment →'}
                      </button>
                      <button onClick={() => { setShowBuyForm(false); setBuyFeedback(null); }} className="text-[10px] text-text-muted hover:text-text">Cancel</button>
                    </div>
                    {buyFeedback && <p className="text-[10px] text-text-muted">{buyFeedback}</p>}
                  </div>
                )}

                {/* Trial form */}
                {showTrialForm && (
                  <div className="space-y-1.5 p-2.5 rounded-lg bg-surface-raised border border-border">
                    <p className="text-[10px] text-text-muted">14-day free trial — no payment needed. License key emailed instantly.</p>
                    <input
                      type="text"
                      value={trialNameInput}
                      onChange={(e) => setTrialNameInput(e.target.value)}
                      placeholder="Your name"
                      className="w-full px-2 py-1 text-xs bg-surface border border-border rounded text-text placeholder-text-muted focus:border-text focus:outline-none"
                    />
                    <input
                      type="email"
                      value={trialEmailInput}
                      onChange={(e) => setTrialEmailInput(e.target.value)}
                      placeholder="Email address"
                      className="w-full px-2 py-1 text-xs bg-surface border border-border rounded text-text placeholder-text-muted focus:border-text focus:outline-none"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleRequestTrial}
                        disabled={trialBusy || !trialNameInput.trim() || !trialEmailInput.trim()}
                        className="px-3 py-1 text-xs rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-50"
                      >
                        {trialBusy ? 'Sending…' : 'Start trial'}
                      </button>
                      <button onClick={() => { setShowTrialForm(false); setTrialFeedback(null); }} className="text-[10px] text-text-muted hover:text-text">Cancel</button>
                    </div>
                    {trialFeedback && <p className="text-[10px] text-text-muted">{trialFeedback}</p>}
                  </div>
                )}

                {/* Existing key entry */}
                <div className="space-y-1.5">
                  <input
                    type="text"
                    value={licenseInput}
                    onChange={(e) => setLicenseInput(e.target.value)}
                    placeholder="Paste license key or activation code"
                    className="w-full px-2 py-1 text-xs font-mono bg-surface-raised border border-border rounded text-text placeholder-text-muted focus:border-text focus:outline-none"
                  />
                  <div className="flex items-center gap-2">
                    <button onClick={handleActivateLicense} disabled={licenseBusy || !licenseInput.trim()} className="px-3 py-1 text-xs rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-50">
                      {licenseBusy ? 'Checking…' : 'Activate'}
                    </button>
                    <button onClick={() => dispatch({ type: 'OPEN_LICENSE_PROMPT' })} className="text-[10px] text-text-muted hover:text-text">More options</button>
                  </div>
                  {(licenseFeedback ?? licenseStatus?.message) && (
                    <p className="text-[10px] text-text-muted">{licenseFeedback ?? licenseStatus?.message}</p>
                  )}
                </div>
              </div>
            )}
          </section>
          )}

          {activeTopic === 'general' && (
          <>
          {/* Version / updates */}
          <section>
            <h3 className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider mb-2">Version</h3>
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-1 text-[10px] text-text-muted">
                <div className="bg-surface-alt border border-border rounded px-2 py-1">
                  Installed: <span className="text-text-secondary">{updateState.currentVersion}</span>
                </div>
                <div className="bg-surface-alt border border-border rounded px-2 py-1">
                  Last checked: <span className="text-text-secondary">{formatVersionDate(updateState.lastCheckedAt)}</span>
                </div>
                <div className="bg-surface-alt border border-border rounded px-2 py-1">
                  Latest: <span className="text-text-secondary">{updateState.status === 'checking' ? 'Checking...' : updateState.latestVersion || 'Unknown'}</span>
                </div>
                <div className="bg-surface-alt border border-border rounded px-2 py-1">
                  Status: <span className="text-text-secondary">{updateState.status}</span>
                </div>
              </div>
              {updateState.message && (
                <p className={`text-[10px] ${updateState.status === 'error' || updateState.status === 'denied' ? 'text-red-300' : 'text-text-muted'}`}>
                  {updateState.message}
                </p>
              )}
              {updateState.status === 'available' && updateState.latestVersion && (
                <div className="rounded border border-emerald-500/25 bg-emerald-500/8 px-3 py-2 text-[10px] text-emerald-200">
                  <div className="font-medium text-emerald-100">New installer ready</div>
                  <div className="mt-1">Keptra {updateState.latestVersion} is available. Use the installer button below to replace your current {updateState.currentVersion} build.</div>
                </div>
              )}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { void checkNow(); }}
                  className="px-3 py-1 text-xs rounded bg-surface-raised text-text-secondary hover:bg-border"
                >
                  Check now
                </button>
                {updateState.status === 'available' && (
                  <button
                    onClick={() => { void downloadUpdate(); }}
                    className="px-3 py-1 text-xs rounded bg-accent text-white hover:bg-accent-hover"
                  >
                    Download installer
                  </button>
                )}
                {updateState.status === 'ready' && (
                  <button
                    onClick={() => { void installUpdate(); }}
                    className="px-3 py-1 text-xs rounded bg-accent text-white hover:bg-accent-hover"
                  >
                    Install update
                  </button>
                )}
                {updateState.releaseUrl && (
                  <button
                    onClick={openRelease}
                    className="px-3 py-1 text-xs rounded bg-surface-raised text-text-secondary hover:bg-border"
                  >
                    Release notes
                  </button>
                )}
              </div>
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
            {saveFormat === 'original' && (
              <p className="mt-1.5 text-[10px] text-text-muted">
                Original copies the source bytes unchanged. Even JPEG exposure or white-balance edits require exporting a new JPEG, TIFF, or HEIC.
              </p>
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
          </>
          )}

          {/* Selection sets */}
          {activeTopic === 'editing' && selectionSets.length > 0 && (
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

          {activeTopic === 'diagnostics' && (
          <>
          <section>
            <SectionHeader icon={Activity} title="Diagnostics" description="Runtime state, update repair, and support bundles." />
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-1 text-[10px] text-text-muted">
                <div className="rounded border border-border bg-surface-alt px-2 py-1">
                  App: <span className="text-text-secondary">{diagnosticsSnapshot?.appVersion ?? updateState.currentVersion}</span>
                </div>
                <div className="rounded border border-border bg-surface-alt px-2 py-1">
                  License: <span className={diagnosticsSnapshot?.license.valid ? 'text-emerald-300' : 'text-yellow-300'}>
                    {diagnosticsSnapshot?.license.valid ? 'active' : 'not active'}
                  </span>
                </div>
                <div className="rounded border border-border bg-surface-alt px-2 py-1">
                  Update: <span className="text-text-secondary">{diagnosticsSnapshot?.update.status ?? updateState.status}</span>
                </div>
                <div className="rounded border border-border bg-surface-alt px-2 py-1">
                  Latest: <span className="text-text-secondary">{diagnosticsSnapshot?.update.latestVersion ?? updateState.latestVersion ?? 'unknown'}</span>
                </div>
              </div>
              {diagnosticsSnapshot && (
                <div className="space-y-1 rounded border border-border bg-surface-alt px-2 py-2 text-[10px] text-text-muted">
                  <div className="truncate" title={diagnosticsSnapshot.settingsPath}>Settings: <span className="font-mono text-text-secondary">{diagnosticsSnapshot.settingsPath}</span></div>
                  <div className="truncate" title={diagnosticsSnapshot.updateMetadataPath}>Update metadata: <span className="font-mono text-text-secondary">{diagnosticsSnapshot.updateMetadataPath}</span></div>
                  <div>Stored license key: <span className="text-text-secondary">{diagnosticsSnapshot.license.hasStoredKey ? 'yes' : 'no'}</span></div>
                  <div>Activation code: <span className="text-text-secondary">{diagnosticsSnapshot.license.hasActivationCode ? diagnosticsSnapshot.license.activationCode ?? 'saved' : 'none'}</span></div>
                  {diagnosticsSnapshot.update.message && (
                    <div className="text-yellow-300">Update note: {diagnosticsSnapshot.update.message}</div>
                  )}
                  <div className="pt-1">
                    {diagnosticsSnapshot.endpoints.map((endpoint) => (
                      <div key={endpoint.url} className="truncate" title={endpoint.url}>
                        {endpoint.role}: <span className="font-mono text-text-secondary">{endpoint.url}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <ActionButton
                  icon={Stethoscope}
                  onClick={() => { void refreshDiagnosticsSnapshot(); }}
                  tone="ghost"
                >
                  Refresh
                </ActionButton>
                <ActionButton
                  icon={Database}
                  onClick={handleCopyDiagnostics}
                  tone="ghost"
                >
                  Copy diagnostics
                </ActionButton>
                <ActionButton
                  icon={HeartPulse}
                  onClick={handleRepairUpdates}
                  disabled={updateRepairBusy}
                  tone="primary"
                >
                  {updateRepairBusy ? 'Repairing...' : 'Repair updates'}
                </ActionButton>
                <ActionButton
                  icon={FolderClock}
                  onClick={handleExportDiagnostics}
                  disabled={diagnosing}
                  tone="ghost"
                >
                  Export bundle
                </ActionButton>
              </div>
              {diagResult && <p className="text-[10px] text-text-muted">{diagResult}</p>}
            </div>
          </section>
          </>
          )}

          {activeTopic === 'catalog' && (
          <CatalogPanel />
          )}

          {activeTopic === 'workflow' && (
          <>
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
                  disabled={!selectedSource || phase === 'scanning' || phase === 'importing'}
                  className="px-2 py-1 text-[10px] bg-surface-raised hover:bg-border rounded text-text-secondary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  title={phase === 'scanning' || phase === 'importing' ? 'Wait for the current scan/import before ejecting this source.' : 'Safely eject the current source'}
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
              <div className="rounded border border-emerald-500/25 bg-emerald-500/10 px-2 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[10px] font-medium text-emerald-300">Fast raw ingest</div>
                  <button
                    type="button"
                    onClick={handleFastRawIngest}
                    className="shrink-0 rounded border border-emerald-500/30 bg-emerald-500/15 px-2 py-1 text-[10px] text-emerald-200 hover:bg-emerald-500/25"
                    title="Copy originals only and disable checksum verification, backup/FTP mirror, conversion, metadata sidecars, duplicate checks, straighten, and watermark."
                  >
                    Apply
                  </button>
                </div>
                <p className="mt-0.5 text-[10px] text-text-muted">
                  For the fastest card copy, use Original and turn off checksum verification, backup/FTP mirroring, conversion, metadata sidecars, and duplicate checks when the job does not need them.
                </p>
              </div>
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
                  placeholder="/Keptra"
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

          <section>
            <h3 className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider mb-2">FTP Workflow</h3>
            <div className="space-y-2">
              <div className="rounded border border-border bg-surface-alt px-3 py-2">
                <div className="text-[10px] text-text-secondary uppercase tracking-wider mb-2">Source</div>
                <div className="grid grid-cols-[1fr_4.5rem] gap-1.5">
                  <input
                    value={ftpConfig.host}
                    onChange={(e) => handleFtpSourceConfig({ host: e.target.value })}
                    placeholder="ftp.example.com"
                    className="min-w-0 px-2 py-1 text-xs bg-surface-raised border border-border rounded text-text placeholder-text-muted focus:border-text focus:outline-none"
                  />
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={ftpConfig.port}
                    onChange={(e) => handleFtpSourceConfig({ port: Number(e.target.value) || 21 })}
                    className="px-2 py-1 text-xs bg-surface-raised border border-border rounded text-text focus:border-text focus:outline-none"
                  />
                </div>
                <div className="grid grid-cols-2 gap-1.5 mt-1.5">
                  <input
                    value={ftpConfig.user}
                    onChange={(e) => handleFtpSourceConfig({ user: e.target.value })}
                    placeholder="user"
                    className="min-w-0 px-2 py-1 text-xs bg-surface-raised border border-border rounded text-text placeholder-text-muted focus:border-text focus:outline-none"
                  />
                  <input
                    type="password"
                    value={ftpConfig.password}
                    onChange={(e) => handleFtpSourceConfig({ password: e.target.value })}
                    placeholder="password"
                    className="min-w-0 px-2 py-1 text-xs bg-surface-raised border border-border rounded text-text placeholder-text-muted focus:border-text focus:outline-none"
                  />
                </div>
                <input
                  value={ftpConfig.remotePath}
                  onChange={(e) => handleFtpSourceConfig({ remotePath: e.target.value })}
                  placeholder="/DCIM"
                  className="w-full mt-1.5 px-2 py-1 text-xs font-mono bg-surface-raised border border-border rounded text-text placeholder-text-muted focus:border-text focus:outline-none"
                />
                <label className="flex items-center gap-2 cursor-pointer mt-1.5">
                  <input
                    type="checkbox"
                    checked={ftpConfig.secure}
                    onChange={(e) => handleFtpSourceConfig({ secure: e.target.checked })}
                  />
                  <span className="text-xs text-text">Use FTPS</span>
                </label>
              </div>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={ftpSyncSettings.enabled}
                  onChange={(e) => handleFtpSyncSettings({ enabled: e.target.checked })}
                />
                <span className="text-xs text-text">Enable automated FTP workflow</span>
              </label>

              <div className="flex items-center gap-2">
                <button
                  onClick={handleChooseFtpSyncDest}
                  className="min-w-0 flex-1 px-2 py-1 text-xs bg-surface-raised hover:bg-border rounded text-text-secondary transition-colors text-left truncate"
                  title={ftpSyncSettings.localDestRoot || 'Choose local sync destination'}
                >
                  {ftpSyncSettings.localDestRoot || 'Choose local sync destination...'}
                </button>
                {ftpSyncSettings.localDestRoot && (
                  <button
                    onClick={() => handleFtpSyncSettings({ localDestRoot: '' })}
                    className="text-[10px] text-text-muted hover:text-text"
                  >
                    clear
                  </button>
                )}
              </div>

              <div className="grid grid-cols-[1fr_5rem] gap-1.5 items-end">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={ftpSyncSettings.runOnLaunch}
                    onChange={(e) => handleFtpSyncSettings({ runOnLaunch: e.target.checked })}
                  />
                  <span className="text-xs text-text">Run on launch and repeat</span>
                </label>
                <label className="block">
                  <span className="text-[10px] text-text-secondary">Minutes</span>
                  <input
                    type="number"
                    min={5}
                    max={720}
                    value={ftpSyncSettings.intervalMinutes}
                    onChange={(e) => handleFtpSyncSettings({ intervalMinutes: Math.max(5, Number(e.target.value) || 15) })}
                    className="w-full px-2 py-1 text-xs bg-surface-raised border border-border rounded text-text focus:border-text focus:outline-none"
                  />
                </label>
              </div>

              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={ftpSyncSettings.reuploadToFtpDest}
                  onChange={(e) => handleFtpSyncSettings({ reuploadToFtpDest: e.target.checked })}
                />
                <span className="text-xs text-text">
                  Re-upload imported files to FTP output
                  <span className="block mt-0.5 text-[10px] text-text-muted">
                    Uses the FTP Output section above after the local import finishes.
                  </span>
                </span>
              </label>

              <div className="flex justify-end">
                <button
                  onClick={handleRunFtpWorkflowNow}
                  className="px-2 py-1 text-[10px] bg-surface-raised hover:bg-border rounded text-text-secondary transition-colors"
                >
                  Run now
                </button>
              </div>
            </div>
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

          <WatchFoldersPanel />

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
          </>
          )}

          {activeTopic === 'editing' && (
          <>
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
                Original output is a byte-for-byte copy. Choose JPEG, TIFF, or HEIC to write exposure changes into new files.
              </p>
            )}
            {normalizeExposure && saveFormat !== 'original' && (
              <div className="mt-2 ml-5 space-y-3">
                <div>
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
                <div>
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-[10px] text-text-secondary">Manual EV step</span>
                    <span className="text-[10px] text-text-secondary font-mono">{exposureAdjustmentStep.toFixed(2)} EV</span>
                  </div>
                  <input
                    type="range"
                    min={0.1}
                    max={1}
                    step={0.05}
                    value={exposureAdjustmentStep}
                    onChange={(e) => handleExposureAdjustmentStep(Number(e.target.value))}
                    className="w-full h-1 bg-surface-raised rounded appearance-none cursor-pointer accent-accent"
                  />
                  <p className="mt-0.5 text-[10px] text-text-muted">
                    Used by the `[` and `]` quick exposure nudges in the grid. Custom EV entry is still available.
                  </p>
                </div>
              </div>
            )}
          </section>

          <section>
            <h3 className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider mb-2">White Balance</h3>
            <div className={`space-y-2 ${saveFormat === 'original' ? 'opacity-55' : ''}`}>
              <div>
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-[10px] text-text-secondary">Temperature</span>
                  <span className="text-[10px] text-text-secondary font-mono">{formatWhiteBalanceKelvin(wbTemperature)}</span>
                </div>
                <input
                  type="range"
                  min={WHITE_BALANCE_MIN_KELVIN}
                  max={WHITE_BALANCE_MAX_KELVIN}
                  step={50}
                  value={wbKelvin}
                  disabled={saveFormat === 'original'}
                  onChange={(e) => handleWhiteBalance(kelvinToWhiteBalanceTemperature(Number(e.target.value)), wbTint)}
                  className="w-full h-1 bg-surface-raised rounded appearance-none cursor-pointer accent-cyan-300 disabled:cursor-not-allowed"
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-[10px] text-text-secondary">Tint</span>
                  <span className="text-[10px] text-text-secondary font-mono">{wbTint > 0 ? '+' : ''}{wbTint}</span>
                </div>
                <input
                  type="range"
                  min={-100}
                  max={100}
                  step={5}
                  value={wbTint}
                  disabled={saveFormat === 'original'}
                  onChange={(e) => handleWhiteBalance(wbTemperature, Number(e.target.value))}
                  className="w-full h-1 bg-surface-raised rounded appearance-none cursor-pointer accent-cyan-300 disabled:cursor-not-allowed"
                />
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={saveFormat === 'original'}
                  onClick={() => handleWhiteBalance(0, 0)}
                  className="rounded border border-surface-border px-2 py-1 text-[10px] text-text-secondary transition-colors hover:border-text-secondary hover:text-text disabled:opacity-50"
                >
                  Reset WB
                </button>
                <span className="text-[10px] text-text-muted">
                  {saveFormat === 'original'
                    ? 'Kelvin WB preview/export needs JPEG, TIFF, or HEIC output.'
                    : 'Applies as bulk Kelvin-style WB to converted outputs and previews.'}
                </span>
              </div>
            </div>
          </section>

          <section>
            <h3 className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider mb-2">Metadata</h3>
            <div className="space-y-2">
              <textarea
                rows={3}
                value={metadataKeywords}
                onChange={(e) => handleMetadataString('metadataKeywords', e.target.value)}
                placeholder="Keywords, separated by commas or new lines"
                className="w-full resize-y rounded border border-border bg-surface-raised px-2 py-1 text-xs text-text placeholder-text-muted focus:border-text focus:outline-none"
              />
              <input
                value={metadataTitle}
                onChange={(e) => handleMetadataString('metadataTitle', e.target.value)}
                placeholder="Title / headline"
                className="w-full rounded border border-border bg-surface-raised px-2 py-1 text-xs text-text placeholder-text-muted focus:border-text focus:outline-none"
              />
              <textarea
                rows={2}
                value={metadataCaption}
                onChange={(e) => handleMetadataString('metadataCaption', e.target.value)}
                placeholder="Caption / description"
                className="w-full resize-y rounded border border-border bg-surface-raised px-2 py-1 text-xs text-text placeholder-text-muted focus:border-text focus:outline-none"
              />
              <div className="grid grid-cols-2 gap-1.5">
                <input
                  value={metadataCreator}
                  onChange={(e) => handleMetadataString('metadataCreator', e.target.value)}
                  placeholder="Creator / photographer"
                  className="w-full rounded border border-border bg-surface-raised px-2 py-1 text-xs text-text placeholder-text-muted focus:border-text focus:outline-none"
                />
                <input
                  value={metadataCopyright}
                  onChange={(e) => handleMetadataString('metadataCopyright', e.target.value)}
                  placeholder="Copyright notice"
                  className="w-full rounded border border-border bg-surface-raised px-2 py-1 text-xs text-text placeholder-text-muted focus:border-text focus:outline-none"
                />
              </div>
              <p className="text-[10px] text-text-muted">
                Applied in bulk as XMP sidecars next to imported files, including RAW originals.
              </p>
            </div>
          </section>

          <section>
            <div className="flex items-center justify-between gap-3 mb-2">
              <div>
                <h3 className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Shortcuts & Export</h3>
                <p className="text-[10px] text-text-muted mt-1">Keep culling keys and import metadata reachable without scrolling to the bottom.</p>
              </div>
              <button
                type="button"
                onClick={handleResetKeybinds}
                className="shrink-0 rounded border border-surface-border px-2 py-1 text-[10px] text-text-secondary transition-colors hover:border-text-secondary hover:text-text"
              >
                Reset keybinds
              </button>
            </div>
            <div className="grid gap-3 xl:grid-cols-[1.4fr_1fr]">
              <div className="rounded-xl border border-border bg-surface-alt/60 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div>
                    <h4 className="text-xs font-medium text-text">Keybinds</h4>
                    <p className="text-[10px] text-text-muted">Select a key badge, then press the replacement key. `Esc` cancels.</p>
                  </div>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {KEYBIND_ITEMS.map(({ action, label, hint }) => {
                    const isRebinding = rebindingAction === action;
                    const currentKey = keybinds[action] || DEFAULT_KEYBINDS[action];
                    const displayKey = keyDisplayName(currentKey);
                    const conflict = KEYBIND_ITEMS.find((item) =>
                      item.action !== action &&
                      (keybinds[item.action] || DEFAULT_KEYBINDS[item.action]) === currentKey
                    );

                    return (
                      <div key={action} className={`flex items-center justify-between gap-2 rounded-lg border bg-surface px-2.5 py-2 ${conflict ? 'border-yellow-500/50' : 'border-border'}`}>
                        <div className="min-w-0">
                          <div className="truncate text-[11px] font-medium text-text">{label}</div>
                          <div className="truncate text-[10px] text-text-muted">{hint}</div>
                          {conflict && (
                            <div className="mt-0.5 truncate text-[10px] text-yellow-300">
                              Also used by {conflict.label}
                            </div>
                          )}
                        </div>
                        {isRebinding ? (
                          <button
                            ref={rebindCaptureRef}
                            type="button"
                            onKeyDown={(e) => {
                              if (e.key === 'Escape') {
                                e.preventDefault();
                                setRebindingAction(null);
                                return;
                              }
                              handleKeyCapture(e, action);
                            }}
                            onBlur={() => setRebindingAction((current) => (current === action ? null : current))}
                            className="min-w-[88px] rounded border border-accent bg-accent/15 px-2 py-1 text-center text-[10px] font-mono text-accent outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40"
                          >
                            press key
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleStartRebind(action)}
                            className="min-w-[72px] rounded border border-surface-border bg-surface-raised px-2 py-1 text-center text-[10px] font-mono text-text-secondary transition-colors hover:border-accent hover:text-accent"
                          >
                            {displayKey}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-xl border border-border bg-surface-alt/60 p-3">
                <h4 className="text-xs font-medium text-text">Metadata written on import</h4>
                <p className="mb-2 mt-1 text-[10px] text-text-muted">Choose which metadata fields are embedded into imported files.</p>
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                  {METADATA_EXPORT_ITEMS.map(({ flag, label, hint }) => (
                    <label key={flag} className="flex items-start gap-2 rounded-lg border border-border bg-surface px-2.5 py-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={metadataExport[flag]}
                        onChange={(e) => handleMetadataExport(flag, e.target.checked)}
                        className="mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className="block text-[11px] font-medium text-text">{label}</span>
                        <span className="block text-[10px] text-text-muted">{hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section>
            <h3 className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider mb-2">Watermark & Straighten</h3>
            <div className="space-y-2">
              <label className={`flex items-center gap-2 ${saveFormat === 'original' ? 'opacity-50' : 'cursor-pointer'}`}>
                <input
                  type="checkbox"
                  checked={autoStraighten}
                  onChange={(e) => handleWorkflowBool('autoStraighten', e.target.checked)}
                  disabled={saveFormat === 'original'}
                />
                <span className="text-xs text-text">Auto-upright RAW/JPEG outputs from EXIF orientation</span>
              </label>
              <label className={`flex items-center gap-2 ${saveFormat === 'original' ? 'opacity-50' : 'cursor-pointer'}`}>
                <input
                  type="checkbox"
                  checked={watermarkEnabled}
                  onChange={(e) => handleWorkflowBool('watermarkEnabled', e.target.checked)}
                  disabled={saveFormat === 'original'}
                />
                <span className="text-xs text-text">Add watermark overlay to converted outputs</span>
              </label>
              {saveFormat === 'original' && (
                <p className="text-[10px] text-text-muted ml-5">
                  Watermarking and straighten/upright transforms require JPEG / TIFF / HEIC output.
                </p>
              )}
              {watermarkEnabled && saveFormat !== 'original' && (
                <div className="ml-5 space-y-2">
                  <div className="grid grid-cols-2 gap-1">
                    {(['text', 'image'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => handleWatermarkMode(mode)}
                        className={`rounded border px-2 py-1 text-xs transition-colors ${
                          watermarkMode === mode
                            ? 'border-accent bg-accent/10 text-text'
                            : 'border-border bg-surface-raised text-text-secondary hover:text-text'
                        }`}
                      >
                        {mode === 'text' ? 'Text watermark' : 'Image watermark'}
                      </button>
                    ))}
                  </div>
                  {watermarkMode === 'text' ? (
                    <input
                      value={watermarkText}
                      onChange={(e) => handleMetadataString('watermarkText', e.target.value)}
                      placeholder="Watermark text"
                      className="w-full rounded border border-border bg-surface-raised px-2 py-1 text-xs text-text placeholder-text-muted focus:border-text focus:outline-none"
                    />
                  ) : (
                    <div className="space-y-2 rounded-lg border border-border bg-surface-alt px-3 py-2">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={handleChooseWatermarkImage}
                          className="flex-1 rounded bg-surface-raised px-2 py-1 text-left text-xs text-text-secondary transition-colors hover:bg-border"
                        >
                          {watermarkImagePath ? watermarkImagePath.split(/[/\\]/).pop() : 'Choose watermark image...'}
                        </button>
                        {watermarkImagePath && (
                          <button
                            type="button"
                            onClick={() => handleWorkflowString('watermarkImagePath', '')}
                            className="text-[10px] text-text-muted hover:text-text"
                          >
                            clear
                          </button>
                        )}
                      </div>
                      <p className="text-[10px] text-text-muted">
                        PNG works best for logos with transparency.
                      </p>
                    </div>
                  )}
                  <div>
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-[10px] text-text-secondary">Opacity</span>
                      <span className="text-[10px] text-text-secondary font-mono">{Math.round(watermarkOpacity * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min={0.1}
                      max={0.9}
                      step={0.05}
                      value={watermarkOpacity}
                      onChange={(e) => handleWatermarkNumber('watermarkOpacity', Number(e.target.value))}
                      className="w-full h-1 bg-surface-raised rounded appearance-none cursor-pointer accent-accent"
                    />
                  </div>
                  <div className="grid gap-2 md:grid-cols-2">
                    {([
                      ['landscape', 'Landscape frame', watermarkPositionLandscape],
                      ['portrait', 'Portrait frame', watermarkPositionPortrait],
                    ] as const).map(([orientation, label, value]) => (
                      <div key={orientation} className="rounded-lg border border-border bg-surface-alt px-3 py-2">
                        <div className="mb-2 flex items-center justify-between">
                          <span className="text-[10px] text-text-secondary">{label}</span>
                          <select
                            value={value}
                            onChange={(e) => handleWatermarkPosition(orientation, e.target.value as WatermarkPosition)}
                            className="rounded border border-border bg-surface-raised px-2 py-1 text-[10px] text-text focus:border-text focus:outline-none"
                          >
                            <option value="bottom-right">Bottom right</option>
                            <option value="bottom-left">Bottom left</option>
                            <option value="top-right">Top right</option>
                            <option value="top-left">Top left</option>
                            <option value="center">Center</option>
                          </select>
                        </div>
                        <div className={`relative overflow-hidden rounded-md border border-border bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.16),_transparent_40%),linear-gradient(135deg,_rgba(15,23,42,0.95),_rgba(51,65,85,0.85))] ${orientation === 'landscape' ? 'aspect-[16/10]' : 'mx-auto aspect-[4/5] max-w-[150px]'}`}>
                          {watermarkMode === 'image' && watermarkPreviewUrl ? (
                            <img
                              src={watermarkPreviewUrl}
                              alt="Watermark preview"
                              className={`pointer-events-none absolute max-h-[30%] max-w-[34%] object-contain ${value === 'top-left' ? 'left-[8%] top-[8%]' : value === 'top-right' ? 'right-[8%] top-[8%]' : value === 'bottom-left' ? 'left-[8%] bottom-[8%]' : value === 'center' ? 'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2' : 'right-[8%] bottom-[8%]'}`}
                              style={{ opacity: watermarkOpacity }}
                            />
                          ) : (
                            <div
                              className={`pointer-events-none absolute rounded bg-white/90 px-2 py-1 text-[10px] font-semibold tracking-[0.2em] text-slate-900 shadow ${value === 'top-left' ? 'left-[8%] top-[8%]' : value === 'top-right' ? 'right-[8%] top-[8%]' : value === 'bottom-left' ? 'left-[8%] bottom-[8%]' : value === 'center' ? 'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2' : 'right-[8%] bottom-[8%]'}`}
                              style={{ opacity: watermarkOpacity }}
                            >
                              {watermarkPreviewLabel}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-[10px] text-text-secondary">Size</span>
                      <span className="text-[10px] text-text-secondary font-mono">{(watermarkScale * 100).toFixed(1)}%</span>
                    </div>
                    <input
                      type="range"
                      min={0.02}
                      max={0.1}
                      step={0.005}
                      value={watermarkScale}
                      onChange={(e) => handleWatermarkNumber('watermarkScale', Number(e.target.value))}
                      className="w-full h-1 bg-surface-raised rounded appearance-none cursor-pointer accent-accent"
                    />
                  </div>
                </div>
              )}
            </div>
          </section>
          </>
          )}

          {activeTopic === 'workflow' && (
          <section>
            <div className="mb-3">
              <ImportResumeView tone="settings" />
            </div>

            <h3 className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider mb-2">Auto-cull decisions</h3>
            <div className="mb-3 rounded border border-border bg-surface-alt px-2 py-2">
              <div className="mb-2">
                <span className="text-[10px] text-text-secondary block mb-1">Cull confidence</span>
                <div className="flex flex-wrap gap-1">
                  {(['conservative', 'balanced', 'aggressive'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => handleCullConfidence(mode)}
                      className={`px-2 py-0.5 text-[10px] rounded border transition-colors ${cullConfidence === mode ? 'bg-accent text-white border-accent' : 'bg-surface-raised border-surface-border text-text-secondary hover:text-text'}`}
                      title={
                        mode === 'conservative'
                          ? 'Only reject obvious losers.'
                          : mode === 'aggressive'
                            ? 'Reject more burst duplicates automatically.'
                            : 'Balanced automatic review.'
                      }
                    >
                      {mode.charAt(0).toUpperCase() + mode.slice(1)}
                    </button>
                  ))}
                </div>
              </div>

              <label className="flex items-center gap-2 cursor-pointer mb-2">
                <input
                  type="checkbox"
                  checked={groupPhotoEveryoneGood}
                  onChange={(e) => handleGroupPhotoEveryoneGood(e.target.checked)}
                />
                <span className="text-xs text-text">Group photo: everyone good</span>
              </label>
              <p className="text-[10px] text-text-muted mb-2 ml-5">
                Prefers frames with the most usable faces/people and treats blink or missing-face risk as a stronger reject reason.
              </p>

              <div>
                <span className="text-[10px] text-text-secondary block mb-1">Keeper quota per burst</span>
                <select
                  value={keeperQuota}
                  onChange={(e) => handleKeeperQuota(e.target.value as KeeperQuota)}
                  className="w-full rounded border border-border bg-surface-raised px-2 py-1 text-[11px] text-text focus:border-text focus:outline-none"
                >
                  <option value="best-1">Keep 1 best</option>
                  <option value="top-2">Keep top 2</option>
                  <option value="all-rated">Keep all rated/protected</option>
                  <option value="smile-and-sharp">Keep best smile + sharpest</option>
                </select>
              </div>
            </div>

            <div ref={performanceSectionRef} className="scroll-mt-16">
            <h3 className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider mb-2">Performance</h3>

            {/* Fast Keeper Mode */}
            <label className="flex items-center gap-2 cursor-pointer mb-2">
              <input
                type="checkbox"
                checked={fastKeeperMode}
                onChange={(e) => handleFastKeeperMode(e.target.checked)}
              />
              <span className="text-xs text-text">Fast Keeper Mode</span>
            </label>
            {fastKeeperMode && (
              <p className="text-[10px] text-text-muted mb-2 ml-5">
                Skips face detection — scores photos by sharpness &amp; exposure only. Much faster for large batches.
              </p>
            )}

            <div className="mb-2 rounded border border-border bg-surface-alt px-2 py-2">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">Review workload</p>
                  <p className="text-[10px] text-text-muted">Turn off expensive analysis stages for slower CPUs, old laptops, and huge cards.</p>
                </div>
                <button
                  type="button"
                  onClick={() => handlePerfTier('low')}
                  className="shrink-0 rounded border border-yellow-500/30 bg-yellow-500/10 px-2 py-1 text-[10px] text-yellow-300 hover:bg-yellow-500/20"
                  title="Sets low tier, one worker, Fast Keeper mode, lower RAW preview quality, and disables optional review analysis."
                >
                  Low-end speed
                </button>
              </div>
              <label className="mb-1 flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={reviewFaceAnalysis}
                  onChange={(e) => handleReviewPerformanceOption('reviewFaceAnalysis', e.target.checked)}
                />
                <span className="text-xs text-text">Native face scan</span>
              </label>
              <p className="mb-2 ml-5 text-[10px] text-text-muted">Runs ONNX face detection for face boxes, face filters, and face quality hints.</p>

              <label className={`mb-1 flex items-center gap-2 ${reviewFaceAnalysis ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}>
                <input
                  type="checkbox"
                  checked={reviewFaceAnalysis && reviewFaceMatching}
                  disabled={!reviewFaceAnalysis}
                  onChange={(e) => handleReviewPerformanceOption('reviewFaceMatching', e.target.checked)}
                />
                <span className="text-xs text-text">Similar-face matching and gallery</span>
              </label>
              <p className="mb-2 ml-5 text-[10px] text-text-muted">Generates face embeddings for Face groups and Face gallery. Turn off for the biggest speed gain on crowded event photos.</p>

              <label className={`mb-1 flex items-center gap-2 ${reviewFaceAnalysis ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}>
                <input
                  type="checkbox"
                  checked={reviewFaceAnalysis && reviewPersonDetection}
                  disabled={!reviewFaceAnalysis}
                  onChange={(e) => handleReviewPerformanceOption('reviewPersonDetection', e.target.checked)}
                />
                <span className="text-xs text-text">Person/body detection</span>
              </label>
              <p className="mb-2 ml-5 text-[10px] text-text-muted">Helps event/group-photo scoring, but adds another model pass. Disable for basic keeper picking.</p>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={reviewVisualDuplicates}
                  onChange={(e) => handleReviewPerformanceOption('reviewVisualDuplicates', e.target.checked)}
                />
                <span className="text-xs text-text">Visual duplicate hashing</span>
              </label>
              <p className="mt-1 ml-5 text-[10px] text-text-muted">Enables Similar photos / near-duplicate stacks. Disable if you only need fast manual review.</p>
            </div>

            {/* Device tier */}
            <div className="mb-2">
              <span className="text-[10px] text-text-secondary block mb-1">Processing tier</span>
              <div className="flex gap-1">
                {(['auto', 'low', 'balanced', 'high'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => handlePerfTier(t)}
                    className={`px-2 py-0.5 text-[10px] rounded border transition-colors ${perfTier === t ? 'bg-accent text-white border-accent' : 'bg-surface-raised border-surface-border text-text-secondary hover:text-text'}`}
                  >
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {/* RAW preview quality */}
            <div className="mb-2">
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-[10px] text-text-secondary">RAW preview quality</span>
                <span className="text-[10px] text-text-secondary font-mono">{rawPreviewQuality}%</span>
              </div>
              <input
                type="range"
                min={40}
                max={95}
                step={5}
                value={rawPreviewQuality}
                onChange={(e) => handleRawPreviewQuality(Number(e.target.value))}
                className="w-full h-1 bg-surface-raised rounded appearance-none cursor-pointer accent-accent"
              />
            </div>

            {/* CPU optimization */}
            <label className="flex items-center gap-2 cursor-pointer mb-1">
              <input
                type="checkbox"
                checked={cpuOptimization}
                onChange={(e) => handlePerformanceOption('cpuOptimization', e.target.checked)}
              />
              <span className="text-xs text-text">CPU optimization mode</span>
            </label>

            {/* GPU acceleration */}
            <label className="flex items-center gap-2 cursor-pointer mb-1">
              <input
                type="checkbox"
                checked={gpuFaceAcceleration}
                onChange={(e) => handlePerformanceOption('gpuFaceAcceleration', e.target.checked)}
              />
              <span className="text-xs text-text">GPU face acceleration (DirectML)</span>
            </label>
            {gpuStatus !== null && (
              <p className="text-[10px] text-text-muted ml-5 mb-1">
                {gpuStatus ? `Active (${executionProvider ?? 'GPU'})` : (executionProvider ? `CPU fallback (${executionProvider})` : 'Not available on this machine — using CPU')}
              </p>
            )}
            <div className="mb-2 ml-5">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-[10px] text-text-secondary">DirectML GPU adapter</span>
                <span className="text-[10px] font-mono text-text-muted">{gpuDeviceId >= 0 ? `#${gpuDeviceId}` : 'Auto'}</span>
              </div>
              <select
                value={gpuDeviceId}
                onChange={(e) => { void handleGpuDevice(Number(e.target.value)); }}
                disabled={!gpuFaceAcceleration}
                className="w-full rounded border border-border bg-surface-raised px-2 py-1 text-[11px] text-text focus:border-text focus:outline-none disabled:opacity-50"
                title="DirectML adapter index. Auto uses Windows/driver default."
              >
                <option value={-1}>Auto - Windows default GPU</option>
                {gpus.map((gpu) => (
                  <option key={gpu.id} value={gpu.id}>
                    #{gpu.id} {gpu.name}{gpu.videoMemoryMB ? ` (${Math.round(gpu.videoMemoryMB / 1024)}GB)` : ''}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[10px] text-text-muted">
                On dual-GPU laptops, pick the discrete GPU, then run Diagnose GPU. Adapter numbering follows Windows display order.
              </p>
            </div>

            <div className="mb-2 rounded border border-border bg-surface-alt px-2 py-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  onClick={handleOptimizeForDevice}
                  disabled={diagnosing}
                  className="text-[10px] text-text-secondary border border-surface-border rounded px-2 py-1 hover:text-text hover:border-text-secondary transition-colors disabled:opacity-50"
                >
                  {diagnosing ? 'Testing device...' : 'Optimize settings'}
                </button>
                <button
                  onClick={handleDiagnose}
                  disabled={diagnosing}
                  className="text-[10px] text-text-secondary border border-surface-border rounded px-2 py-1 hover:text-text hover:border-text-secondary transition-colors disabled:opacity-50"
                >
                  {diagnosing ? 'Running benchmark...' : 'Diagnose GPU'}
                </button>
                <button
                  onClick={handleGpuStressTest}
                  disabled={diagnosing}
                  className="text-[10px] text-text-secondary border border-surface-border rounded px-2 py-1 hover:text-text hover:border-text-secondary transition-colors disabled:opacity-50"
                  title="Runs detector/embedder continuously for 8 seconds so GPU Compute usage is easier to see."
                >
                  {diagnosing ? 'Testing...' : 'GPU load test'}
                </button>
                <button
                  onClick={handleExportDiagnostics}
                  disabled={diagnosing}
                  className="text-[10px] text-text-secondary border border-surface-border rounded px-2 py-1 hover:text-text hover:border-text-secondary transition-colors disabled:opacity-50"
                >
                  {diagnosing ? 'Working...' : 'Export diagnostics'}
                </button>
                <button
                  onClick={handleMacFirstRunDoctor}
                  disabled={diagnosing}
                  className="text-[10px] text-text-secondary border border-surface-border rounded px-2 py-1 hover:text-text hover:border-text-secondary transition-colors disabled:opacity-50"
                >
                  {diagnosing ? 'Checking...' : 'Mac doctor'}
                </button>
                <button
                  onClick={handleRunBenchmarkSmoke}
                  disabled={diagnosing}
                  className="text-[10px] text-text-secondary border border-surface-border rounded px-2 py-1 hover:text-text hover:border-text-secondary transition-colors disabled:opacity-50"
                >
                  {diagnosing ? 'Working...' : 'Run smoke bench'}
                </button>
                <button
                  onClick={handleOpenBenchmarkOutput}
                  disabled={diagnosing}
                  className="text-[10px] text-text-secondary border border-surface-border rounded px-2 py-1 hover:text-text hover:border-text-secondary transition-colors disabled:opacity-50"
                >
                  Open bench output
                </button>
              </div>
              <p className="mt-1 text-[10px] text-text-muted">
                Tests the face engine, reads this PC's CPU/RAM profile, and exports logs, provider details, recent import ledgers, settings, and cache/benchmark summaries for support.
              </p>
              {diagResult && (
                <p className="text-[10px] text-text-muted mt-1 font-mono leading-snug">{diagResult}</p>
              )}
              {macDoctor && (
                <div className="mt-1 space-y-0.5">
                  {macDoctor.checks.map((check) => (
                    <div key={check.id} className="flex items-start justify-between gap-2 text-[10px]">
                      <span className={check.ok ? 'text-emerald-400' : 'text-yellow-400'}>{check.ok ? 'OK' : 'Check'}</span>
                      <span className="min-w-0 flex-1 text-text-muted">
                        {check.label}: {check.detail}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* GPU stress-test streams */}
            <div className="mb-2">
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-[10px] text-text-secondary">GPU load streams</span>
                <span className="text-[10px] text-text-secondary font-mono">{gpuLoadStreams}</span>
              </div>
              <input
                type="range"
                min={1}
                max={32}
                step={1}
                value={gpuLoadStreams}
                onChange={(e) => handleGpuLoadStreams(Number(e.target.value))}
                className="w-full h-1 bg-surface-raised rounded appearance-none cursor-pointer accent-accent"
              />
              <div className="mt-1 flex gap-1">
                {[2, 4, 8, 12, 16, 24, 32].map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => handleGpuLoadStreams(value)}
                    className={`rounded border px-1.5 py-0.5 text-[9px] transition-colors ${gpuLoadStreams === value ? 'border-accent bg-accent/20 text-accent' : 'border-border text-text-muted hover:text-text'}`}
                    title={`Use ${value} parallel detector/embedder loops in the GPU load test`}
                  >
                    {value}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-text-muted mt-0.5">
                Raises only the diagnostic load test intensity. Real culling also waits on JPEG/RAW decode, crops, cache, disk, and CPU person checks, so 100% GPU is not always the fastest setting.
              </p>
            </div>

            {/* RAW preview cache */}
            <label className="flex items-center gap-2 cursor-pointer mb-2">
              <input
                type="checkbox"
                checked={rawPreviewCache}
                onChange={(e) => handlePerformanceOption('rawPreviewCache', e.target.checked)}
              />
              <span className="text-xs text-text">Cache RAW previews</span>
            </label>

            {/* Preview concurrency */}
            <div className="mb-2">
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-[10px] text-text-secondary">Preview workers</span>
                <span className="text-[10px] text-text-secondary font-mono">{previewConcurrency}</span>
              </div>
              <input
                type="range"
                min={1}
                max={12}
                step={1}
                value={previewConcurrency}
                onChange={(e) => handlePreviewConcurrency(Number(e.target.value))}
                className="w-full h-1 bg-surface-raised rounded appearance-none cursor-pointer accent-accent"
              />
              <p className="text-[10px] text-text-muted mt-0.5">Controls thumbnail/full-preview prefetch. Higher helps fast SSDs and big CPUs.</p>
            </div>

            {/* Face analysis concurrency */}
            <div className="mb-2">
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-[10px] text-text-secondary">Simultaneous face scans</span>
                <span className="text-[10px] text-text-secondary font-mono">{faceConcurrency}</span>
              </div>
              <input
                type="range"
                min={1}
                max={32}
                step={1}
                value={faceConcurrency}
                onChange={(e) => handleFaceConcurrency(Number(e.target.value))}
                className="w-full h-1 bg-surface-raised rounded appearance-none cursor-pointer accent-accent"
              />
              <div className="mt-1 flex gap-1">
                {[1, 4, 8, 12, 16, 24, 32].map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => handleFaceConcurrency(value)}
                    className={`rounded border px-1.5 py-0.5 text-[9px] transition-colors ${faceConcurrency === value ? 'border-accent bg-accent/20 text-accent' : 'border-border text-text-muted hover:text-text'}`}
                    title={`${value} simultaneous face analysis job${value === 1 ? '' : 's'}`}
                  >
                    {value}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-text-muted mt-0.5">
                Higher can push GPUs harder on large batches. Fast DirectML runs often like 16-24; use 32 only for stress testing if the UI stays smooth.
              </p>
            </div>

            {/* Clear face cache */}
            <button
              onClick={handleClearFaceCache}
              disabled={faceCacheClearing}
              className="text-[10px] text-text-secondary border border-surface-border rounded px-2 py-1 hover:text-text hover:border-text-secondary transition-colors disabled:opacity-50"
            >
              {faceCacheClearing ? 'Clearing…' : 'Clear face cache'}
            </button>
            <p className="text-[10px] text-text-muted mt-0.5">
              Forces re-analysis of all photos on next import. Use after swapping lenses or changing detection settings.
            </p>

            <div className="mt-2 rounded border border-border bg-surface-alt px-2 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">Performance help</p>
              <p className="mt-1 text-[10px] text-text-muted">
                Use Optimize settings first. RTX-class GPUs usually prefer 8-16 face scans; very fast systems can try 24. Laptops or older CPUs should stay at 1-4 or enable Fast Keeper Mode for huge imports.
              </p>
            </div>
            </div>
          </section>
          )}

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
