import { useEffect, useState } from 'react';
import { useAppDispatch } from '../context/ImportContext';
import packageJson from '../../../package.json';

const OPEN_PERFORMANCE_EVENT = 'photo-importer:settings-performance';

export function SettingsOptimizationPrompt() {
  const dispatch = useAppDispatch();
  const [show, setShow] = useState(false);
  const [version, setVersion] = useState<string>('');
  const [summary, setSummary] = useState<string>('Checking this PC can tune GPU, CPU, preview cache, and face scan concurrency.');

  useEffect(() => {
    let cancelled = false;

    const checkPromptState = async () => {
      try {
        const [settings, profile] = await Promise.all([
          window.electronAPI.getSettings(),
          window.electronAPI.getDeviceTier?.().catch(() => null),
        ]);
        if (cancelled) return;

        const currentVersion = packageJson.version || 'local';
        setVersion(currentVersion);

        if (profile) {
          setSummary(
            `${profile.cpuCores} CPU threads and ${profile.totalMemGB}GB RAM detected. ` +
            'Run Optimize settings to benchmark DirectML/CPU and apply recommended face scan + preview settings.'
          );
        }

        if (settings.performancePromptSeenVersion !== currentVersion) {
          setShow(true);
        }
      } catch {
        if (!cancelled) setShow(false);
      }
    };

    const timer = window.setTimeout(() => {
      void checkPromptState();
    }, 1200);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  const markSeen = async () => {
    if (version) {
      await window.electronAPI.setSettings({ performancePromptSeenVersion: version });
    }
  };

  const handleOpenSettings = async () => {
    await markSeen();
    setShow(false);
    dispatch({ type: 'SET_VIEW_MODE', mode: 'settings' });
    window.setTimeout(() => {
      window.dispatchEvent(new Event(OPEN_PERFORMANCE_EVENT));
    }, 80);
  };

  const handleLater = async () => {
    await markSeen();
    setShow(false);
  };

  if (!show) return null;

  return (
    <div className="fixed bottom-4 left-4 z-40 w-[360px] max-w-[calc(100vw-2rem)] animate-in">
      <div className="rounded-lg border border-border bg-surface-raised p-4 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-text">Check performance settings</p>
            <p className="mt-1 text-xs leading-relaxed text-text-secondary">
              This launch includes new AI, GPU, and preview controls.
            </p>
          </div>
          <button
            type="button"
            onClick={() => { void handleLater(); }}
            className="shrink-0 rounded p-1 text-text-muted transition-colors hover:text-text"
            aria-label="Dismiss performance setup"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-text-muted">
          {summary}
        </p>
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => { void handleOpenSettings(); }}
            className="flex-1 rounded bg-accent py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover"
          >
            Open optimizer
          </button>
          <button
            type="button"
            onClick={() => { void handleLater(); }}
            className="flex-1 rounded bg-surface-alt py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-border"
          >
            Later
          </button>
        </div>
      </div>
    </div>
  );
}

export { OPEN_PERFORMANCE_EVENT };
