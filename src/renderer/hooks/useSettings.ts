import { useEffect } from 'react';
import { useAppDispatch } from '../context/ImportContext';

export function useSettings() {
  const dispatch = useAppDispatch();

  useEffect(() => {
    window.electronAPI.getSettings().then((settings) => {
      if (settings.lastDestination) {
        dispatch({ type: 'SET_DESTINATION', path: settings.lastDestination });
      }
      dispatch({ type: 'SET_SKIP_DUPLICATES', value: settings.skipDuplicates });
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

      // Workflow — hydrate from persisted settings. Wrap each in a safe
      // "if defined" check so an older settings.json (pre-workflow) doesn't
      // stomp sane defaults with `undefined`.
      if (typeof settings.separateProtected === 'boolean') {
        dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'separateProtected', value: settings.separateProtected });
      }
      if (typeof settings.protectedFolderName === 'string') {
        dispatch({ type: 'SET_WORKFLOW_STRING', key: 'protectedFolderName', value: settings.protectedFolderName });
      }
      if (typeof settings.backupDestRoot === 'string') {
        dispatch({ type: 'SET_WORKFLOW_STRING', key: 'backupDestRoot', value: settings.backupDestRoot });
      }
      if (typeof settings.ftpDestEnabled === 'boolean') {
        dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'ftpDestEnabled', value: settings.ftpDestEnabled });
      }
      if (settings.ftpDestConfig) {
        dispatch({ type: 'SET_FTP_DEST_CONFIG', config: settings.ftpDestConfig });
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
      if (Array.isArray(settings.selectionSets)) {
        dispatch({ type: 'SET_SELECTION_SETS', sets: settings.selectionSets });
      }
      // Performance settings
      if (typeof settings.gpuFaceAcceleration === 'boolean') {
        dispatch({ type: 'SET_PERFORMANCE_OPTION', key: 'gpuFaceAcceleration', value: settings.gpuFaceAcceleration });
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

      dispatch({ type: 'HYDRATE_LICENSE_STATUS', status: settings.licenseStatus ?? null });
      if (settings.licenseKey) {
        window.electronAPI.activateLicense(settings.licenseKey).then((status) => {
          dispatch({ type: 'SET_LICENSE_STATUS', status });
        }).catch(() => undefined);
      }
    }).catch((err) => {
      console.error('[useSettings] getSettings failed:', err);
      dispatch({ type: 'HYDRATE_LICENSE_STATUS', status: null });
    });
  }, [dispatch]);
}
