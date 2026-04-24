import { useAppDispatch, useAppState } from '../context/ImportContext';

export function LicenseBanner() {
  const { licenseHydrated, licenseStatus, licensePromptOpen, licenseBannerDismissed } = useAppState();
  const dispatch = useAppDispatch();

  if (!licenseHydrated || licenseStatus?.valid || licensePromptOpen || licenseBannerDismissed) {
    return null;
  }

  return (
    <div className="shrink-0 border-b border-amber-500/25 bg-amber-500/10 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <div className="space-y-0.5">
          <div className="font-medium text-amber-200">
            Browse mode only. Importing is disabled until a Full access license is activated.
          </div>
          <div className="text-[10px] text-amber-100/80">
            Device seats are checked automatically after activation, so you can move between machines without guessing what is in use.
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => dispatch({ type: 'OPEN_LICENSE_PROMPT' })}
            className="rounded bg-amber-300 px-2.5 py-1 text-[11px] font-medium text-black transition-colors hover:bg-amber-200"
          >
            Activate License
          </button>
          <button
            onClick={() => dispatch({ type: 'DISMISS_LICENSE_BANNER' })}
            className="rounded bg-surface-raised px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:bg-border"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
