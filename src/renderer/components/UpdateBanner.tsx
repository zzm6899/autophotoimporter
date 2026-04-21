import { useUpdateNotification } from '../hooks/useUpdateNotification';

export function UpdateBanner() {
  const { update, dismiss, openRelease } = useUpdateNotification();

  if (!update) return null;

  return (
    <div className="fixed bottom-4 right-4 z-40 max-w-xs w-full animate-in">
      <div className="bg-surface-raised border border-border rounded-lg shadow-lg p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-text">
              Update available
            </p>
            <p className="text-xs text-text-secondary mt-1">
              v{update.latestVersion} is out — you have v{update.currentVersion}
            </p>
          </div>
          <button
            onClick={dismiss}
            className="shrink-0 p-1 rounded text-text-muted hover:text-text transition-colors"
            aria-label="Dismiss"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>
        <button
          onClick={openRelease}
          className="mt-3 w-full py-1.5 rounded text-xs font-medium bg-accent hover:bg-accent-hover text-white transition-colors"
        >
          View release
        </button>
      </div>
    </div>
  );
}
