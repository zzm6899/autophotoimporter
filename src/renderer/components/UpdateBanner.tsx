import { useUpdateNotification } from '../hooks/useUpdateNotification';

function formatDate(value?: string) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-AU');
}

export function UpdateBanner() {
  const { visibleState, dismiss, downloadUpdate, installUpdate, openRelease } = useUpdateNotification();

  if (!['available', 'downloading', 'ready', 'error', 'denied'].includes(visibleState.status)) {
    return null;
  }

  const title =
    visibleState.status === 'denied' ? 'Updates locked' :
    visibleState.status === 'error' ? 'Update check failed' :
    visibleState.status === 'ready' ? 'Update ready' :
    visibleState.status === 'downloading' ? 'Preparing update...' :
    'Update available';

  const body =
    visibleState.status === 'denied' ? (visibleState.message || 'This license is not entitled to updates.') :
    visibleState.status === 'error' ? (visibleState.message || 'The update service could not be reached.') :
    visibleState.status === 'ready' ? (visibleState.message || 'Update downloaded and ready to install.') :
    visibleState.status === 'downloading' ? (visibleState.message || 'Downloading the latest update...') :
    `v${visibleState.latestVersion} is available${visibleState.releaseDate ? ` · ${formatDate(visibleState.releaseDate)}` : ''}.`;

  return (
    <div className="fixed bottom-4 right-4 z-40 max-w-sm w-full animate-in">
      <div className="bg-surface-raised border border-border rounded-lg shadow-lg p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-text">{title}</p>
            <p className="text-xs text-text-secondary mt-1">{body}</p>
            {visibleState.releaseName && visibleState.status === 'available' && (
              <p className="text-[11px] text-text-muted mt-2">{visibleState.releaseName}</p>
            )}
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
        <div className="mt-3 flex items-center gap-2">
          {visibleState.status === 'available' && (
            <button
              onClick={() => { void downloadUpdate(); }}
              className="flex-1 py-1.5 rounded text-xs font-medium bg-accent hover:bg-accent-hover text-white transition-colors"
            >
              Download update
            </button>
          )}
          {visibleState.status === 'ready' && (
            <button
              onClick={() => { void installUpdate(); }}
              className="flex-1 py-1.5 rounded text-xs font-medium bg-accent hover:bg-accent-hover text-white transition-colors"
            >
              Install update
            </button>
          )}
          {visibleState.releaseUrl && (visibleState.status === 'available' || visibleState.status === 'ready') && (
            <button
              onClick={openRelease}
              className="flex-1 py-1.5 rounded text-xs font-medium bg-surface-alt hover:bg-border text-text-secondary transition-colors"
            >
              View release
            </button>
          )}
          {visibleState.status !== 'downloading' && (
            <button
              onClick={dismiss}
              className="flex-1 py-1.5 rounded text-xs font-medium bg-surface-alt hover:bg-border text-text-secondary transition-colors"
            >
              Later
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
