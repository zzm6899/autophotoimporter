import { useEffect } from 'react';
import { useAppDispatch } from '../context/ImportContext';

export function useSettings() {
  const dispatch = useAppDispatch();

  useEffect(() => {
    window.electronAPI.getSettings().then((settings) => {
      if (settings.lastDestination) {
        dispatch({ type: 'SET_DESTINATION', path: settings.lastDestination });
      }
      if (typeof settings.skipDuplicates === 'boolean') {
        dispatch({ type: 'SET_SKIP_DUPLICATES', value: settings.skipDuplicates });
      }
      if (settings.saveFormat) {
        dispatch({ type: 'SET_SAVE_FORMAT', format: settings.saveFormat });
      }
      if (typeof settings.jpegQuality === 'number') {
        dispatch({ type: 'SET_JPEG_QUALITY', quality: settings.jpegQuality });
      }
      if (settings.folderPreset) {
        dispatch({ type: 'SET_FOLDER_PRESET', preset: settings.folderPreset });
      }
      if (settings.customPattern) {
        dispatch({ type: 'SET_CUSTOM_PATTERN', pattern: settings.customPattern });
      }
      if (settings.theme) {
        dispatch({ type: 'SET_THEME', theme: settings.theme });
      }

      // Workflow
      if (typeof settings.separateProtected === 'boolean') {
        dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'separateProtected', value: settings.separateProtected });
      }
      if (typeof settings.protectedFolderName === 'string') {
        dispatch({ type: 'SET_WORKFLOW_STRING', key: 'protectedFolderName', value: settings.protectedFolderName });
      }
      if (typeof settings.backupDestRoot === 'string') {
        dispatch({ type: 'SET_WORKFLOW_STRING', key: 'backupDestRoot', value: settings.backupDestRoot });
      }
      if (settings.ftpConfig) {
        dispatch({ type: 'SET_FTP_CONFIG', config: settings.ftpConfig });
      }
      if (typeof settings.ftpDestEnabled === 'boolean') {
        dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'ftpDestEnabled', value: settings.ftpDestEnabled });
      }
      if (settings.ftpDestConfig) {
        dispatch({ type: 'SET_FTP_DEST_CONFIG', config: settings.ftpDestConfig });
      }
      if (settings.ftpSync) {
        dispatch({ type: 'SET_FTP_SYNC_SETTINGS', settings: settings.ftpSync });
      }
      if (typeof settings.autoEject === 'boolean') {
        dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'autoEject', value: settings.autoEject });
      }
      if (typeof settings.playSoundOnComplete === 'boolean') {
        dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'playSoundOnComplete', value: settings.playSoundOnComplete });
      }
      if (typeof settings.completeSoundPath === 'string') {
        dispatch({ type: 'SET_WORKFLOW_STRING', key: 'completeSoundPath', value: settings.completeSoundPath });
      }
      if (typeof settings.openFolderOnComplete === 'boolean') {
        dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'openFolderOnComplete', value: settings.openFolderOnComplete });
      }
      if (typeof settings.verifyChecksums === 'boolean') {
        dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'verifyChecksums', value: settings.verifyChecksums });
      }
      if (settings.sourceProfile) {
        dispatch({ type: 'SET_SOURCE_PROFILE', profile: settings.sourceProfile });
      }
      if (settings.defaultConflictPolicy) {
        dispatch({ type: 'SET_CONFLICT_POLICY', policy: settings.defaultConflictPolicy });
      }
      if (typeof settings.conflictFolderName === 'string') {
        dispatch({ type: 'SET_WORKFLOW_STRING', key: 'conflictFolderName', value: settings.conflictFolderName });
      }
      if (typeof settings.lastSessionId === 'string') {
        dispatch({ type: 'SET_WORKFLOW_STRING', key: 'lastSessionId', value: settings.lastSessionId });
      }
      if (typeof settings.autoImport === 'boolean') {
        dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'autoImport', value: settings.autoImport });
      }
      if (typeof settings.autoImportDestRoot === 'string') {
        dispatch({ type: 'SET_WORKFLOW_STRING', key: 'autoImportDestRoot', value: settings.autoImportDestRoot });
      }
      if (typeof settings.burstGrouping === 'boolean') {
        dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'burstGrouping', value: settings.burstGrouping });
      }
      if (typeof settings.burstWindowSec === 'number') {
        dispatch({ type: 'SET_BURST_WINDOW', seconds: settings.burstWindowSec });
      }
      if (typeof settings.normalizeExposure === 'boolean') {
        dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'normalizeExposure', value: settings.normalizeExposure });
      }
      if (typeof settings.exposureMaxStops === 'number') {
        dispatch({ type: 'SET_EXPOSURE_MAX_STOPS', stops: settings.exposureMaxStops });
      }
      if (typeof settings.exposureAdjustmentStep === 'number') {
        dispatch({ type: 'SET_EXPOSURE_ADJUSTMENT_STEP', step: settings.exposureAdjustmentStep });
      }
      if (typeof settings.whiteBalanceTemperature === 'number' || typeof settings.whiteBalanceTint === 'number') {
        dispatch({
          type: 'SET_WHITE_BALANCE',
          temperature: settings.whiteBalanceTemperature ?? 0,
          tint: settings.whiteBalanceTint ?? 0,
        });
      }
      if (settings.eventMode) {
        dispatch({ type: 'SET_EVENT_MODE', mode: settings.eventMode });
      }
      if (settings.cullConfidence) {
        dispatch({ type: 'SET_CULL_CONFIDENCE', confidence: settings.cullConfidence });
      }
      if (typeof settings.groupPhotoEveryoneGood === 'boolean') {
        dispatch({ type: 'SET_GROUP_PHOTO_EVERYONE_GOOD', enabled: settings.groupPhotoEveryoneGood });
      }
      if (settings.keeperQuota) {
        dispatch({ type: 'SET_KEEPER_QUOTA', quota: settings.keeperQuota });
      }
      if (typeof settings.metadataKeywords === 'string') {
        dispatch({ type: 'SET_WORKFLOW_STRING', key: 'metadataKeywords', value: settings.metadataKeywords });
      }
      if (typeof settings.metadataTitle === 'string') {
        dispatch({ type: 'SET_WORKFLOW_STRING', key: 'metadataTitle', value: settings.metadataTitle });
      }
      if (typeof settings.metadataCaption === 'string') {
        dispatch({ type: 'SET_WORKFLOW_STRING', key: 'metadataCaption', value: settings.metadataCaption });
      }
      if (typeof settings.metadataCreator === 'string') {
        dispatch({ type: 'SET_WORKFLOW_STRING', key: 'metadataCreator', value: settings.metadataCreator });
      }
      if (typeof settings.metadataCopyright === 'string') {
        dispatch({ type: 'SET_WORKFLOW_STRING', key: 'metadataCopyright', value: settings.metadataCopyright });
      }
      if (typeof settings.watermarkEnabled === 'boolean') {
        dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'watermarkEnabled', value: settings.watermarkEnabled });
      }
      if (settings.watermarkMode) {
        dispatch({ type: 'SET_WATERMARK_MODE', mode: settings.watermarkMode });
      }
      if (typeof settings.watermarkText === 'string') {
        dispatch({ type: 'SET_WORKFLOW_STRING', key: 'watermarkText', value: settings.watermarkText });
      }
      if (typeof settings.watermarkImagePath === 'string') {
        dispatch({ type: 'SET_WORKFLOW_STRING', key: 'watermarkImagePath', value: settings.watermarkImagePath });
      }
      if (typeof settings.watermarkOpacity === 'number') {
        dispatch({ type: 'SET_WATERMARK_NUMBER', key: 'watermarkOpacity', value: settings.watermarkOpacity });
      }
      if (typeof settings.watermarkScale === 'number') {
        dispatch({ type: 'SET_WATERMARK_NUMBER', key: 'watermarkScale', value: settings.watermarkScale });
      }
      if (settings.watermarkPositionLandscape) {
        dispatch({ type: 'SET_WATERMARK_POSITION', orientation: 'landscape', position: settings.watermarkPositionLandscape });
      }
      if (settings.watermarkPositionPortrait) {
        dispatch({ type: 'SET_WATERMARK_POSITION', orientation: 'portrait', position: settings.watermarkPositionPortrait });
      }
      if (typeof settings.autoStraighten === 'boolean') {
        dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'autoStraighten', value: settings.autoStraighten });
      }
      if (Array.isArray(settings.selectionSets)) {
        dispatch({ type: 'SET_SELECTION_SETS', sets: settings.selectionSets });
      }
      // Performance settings
      if (typeof settings.gpuFaceAcceleration === 'boolean') {
        dispatch({ type: 'SET_PERFORMANCE_OPTION', key: 'gpuFaceAcceleration', value: settings.gpuFaceAcceleration });
      }
      if (typeof settings.gpuDeviceId === 'number') {
        dispatch({ type: 'SET_GPU_DEVICE_ID', deviceId: settings.gpuDeviceId });
      }
      if (typeof settings.rawPreviewCache === 'boolean') {
        dispatch({ type: 'SET_PERFORMANCE_OPTION', key: 'rawPreviewCache', value: settings.rawPreviewCache });
      }
      if (typeof settings.cpuOptimization === 'boolean') {
        dispatch({ type: 'SET_PERFORMANCE_OPTION', key: 'cpuOptimization', value: settings.cpuOptimization });
      }
      if (typeof settings.rawPreviewQuality === 'number') {
        dispatch({ type: 'SET_RAW_PREVIEW_QUALITY', quality: settings.rawPreviewQuality });
      }
      if (settings.perfTier) {
        dispatch({ type: 'SET_PERF_TIER', tier: settings.perfTier });
      }
      if (typeof settings.fastKeeperMode === 'boolean') {
        dispatch({ type: 'SET_FAST_KEEPER_MODE', enabled: settings.fastKeeperMode });
      }
      if (typeof settings.previewConcurrency === 'number' && settings.previewConcurrency > 0) {
        dispatch({ type: 'SET_PREVIEW_CONCURRENCY', concurrency: settings.previewConcurrency });
      } else {
        window.electronAPI.getDeviceTier?.().then((p) => {
          dispatch({ type: 'SET_PREVIEW_CONCURRENCY', concurrency: p.previewConcurrency });
        }).catch(() => undefined);
      }
      if (typeof settings.faceConcurrency === 'number' && settings.faceConcurrency > 0) {
        dispatch({ type: 'SET_FACE_CONCURRENCY', concurrency: settings.faceConcurrency });
      }

      // Keybinds
      if (settings.keybinds && typeof settings.keybinds === 'object') {
        dispatch({ type: 'SET_KEYBINDS', keybinds: settings.keybinds });
      }
      // Metadata export flags
      if (settings.metadataExport && typeof settings.metadataExport === 'object') {
        dispatch({ type: 'SET_METADATA_EXPORT', flags: settings.metadataExport });
      }
      if (settings.viewOverlayPreferences && typeof settings.viewOverlayPreferences === 'object') {
        dispatch({
          type: 'SET_VIEW_OVERLAY_PREFERENCES',
          preferences: settings.viewOverlayPreferences,
        });
      }

      dispatch({ type: 'HYDRATE_LICENSE_STATUS', status: settings.licenseStatus ?? null });
      const savedLicenseInput = settings.licenseActivationCode || settings.licenseKey;
      if (savedLicenseInput) {
        window.electronAPI.activateLicense(savedLicenseInput).then((status) => {
          dispatch({ type: 'SET_LICENSE_STATUS', status });
        }).catch(() => undefined);
      }
    }).catch((err) => {
      console.error('[useSettings] getSettings failed:', err);
      dispatch({ type: 'HYDRATE_LICENSE_STATUS', status: null });
    });
  }, [dispatch]);
}
