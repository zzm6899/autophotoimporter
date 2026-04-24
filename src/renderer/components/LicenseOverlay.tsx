import { useEffect, useState } from 'react';
import { useAppDispatch, useAppState } from '../context/ImportContext';

function formatDisplayDate(value?: string) {
  if (!value) return 'Never';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-');
    return `${day}-${month}-${year}`;
  }
  return value;
}

export function LicenseOverlay() {
  const { licenseHydrated, licenseStatus, licensePromptOpen } = useAppState();
  const dispatch = useAppDispatch();
  const [licenseInput, setLicenseInput] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Show the short activation code once validated, not the full stored key
    if (licenseStatus?.activationCode) setLicenseInput(licenseStatus.activationCode);
    else if (licenseStatus?.key) setLicenseInput(licenseStatus.key);
    if (licenseStatus?.valid) setFeedback(null);
  }, [licenseStatus?.activationCode, licenseStatus?.key, licenseStatus?.valid]);

  if (!licenseHydrated || licenseStatus?.valid || !licensePromptOpen) return null;

  const activate = async () => {
    setBusy(true);
    try {
      const status = await window.electronAPI.activateLicense(licenseInput);
      if (status.valid) {
        dispatch({ type: 'SET_LICENSE_STATUS', status });
        setFeedback(null);
        dispatch({ type: 'CLOSE_LICENSE_PROMPT' });
      } else {
        dispatch({ type: 'SET_LICENSE_STATUS', status });
        setFeedback(status.message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) dispatch({ type: 'CLOSE_LICENSE_PROMPT' });
      }}
    >
      <div className="w-full max-w-xl bg-surface border border-border rounded-xl shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-start justify-between gap-3">
          <div>
          <h2 className="text-base font-semibold text-text">Activate Photo Importer</h2>
          <p className="text-xs text-text-muted mt-1">
            You can keep browsing the app without a license, but importing stays disabled until activation.
          </p>
          </div>
          <button
            onClick={() => dispatch({ type: 'CLOSE_LICENSE_PROMPT' })}
            disabled={busy}
            className="shrink-0 p-1 rounded text-text-muted hover:text-text hover:bg-surface-raised transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title="Close and continue in browse mode"
          >
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-3 gap-2 text-[11px]">
            <div className="rounded border border-border bg-surface-alt px-3 py-2">
              <div className="text-text-muted">Without license</div>
              <div className="text-text mt-1">Browsing and review only</div>
            </div>
            <div className="rounded border border-border bg-surface-alt px-3 py-2">
              <div className="text-text-muted">With license</div>
              <div className="text-emerald-300 mt-1">Full access</div>
            </div>
            <div className="rounded border border-border bg-surface-alt px-3 py-2">
              <div className="text-text-muted">Date format</div>
              <div className="text-text mt-1">DD-MM-YYYY</div>
            </div>
          </div>
          <textarea
            rows={4}
            value={licenseInput}
            onChange={(e) => setLicenseInput(e.target.value)}
            placeholder="Paste your license key"
            className="w-full resize-y px-3 py-2 text-xs font-mono bg-surface-raised border border-border rounded text-text placeholder-text-muted focus:border-text focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={activate}
              disabled={busy || !licenseInput.trim()}
              className="px-4 py-2 rounded bg-accent text-white text-sm font-medium hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy ? 'Checking...' : 'Activate License'}
            </button>
            <button
              onClick={() => dispatch({ type: 'CLOSE_LICENSE_PROMPT' })}
              disabled={busy}
              className="px-4 py-2 rounded bg-surface-raised text-text-secondary text-sm hover:bg-border disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Continue Without License
            </button>
            {(feedback || licenseStatus?.message) && (
              <span className="text-xs text-text-muted">{feedback || licenseStatus?.message}</span>
            )}
          </div>
          {licenseStatus?.entitlement && (
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div className="rounded border border-border bg-surface-alt px-3 py-2">
                Owner: <span className="text-text">{licenseStatus.entitlement.name}</span>
              </div>
              <div className="rounded border border-border bg-surface-alt px-3 py-2">
                Tier: <span className="text-text">{licenseStatus.entitlement.tier || 'Full access'}</span>
              </div>
              <div className="rounded border border-border bg-surface-alt px-3 py-2">
                Issued: <span className="text-text">{formatDisplayDate(licenseStatus.entitlement.issuedAt)}</span>
              </div>
              <div className="rounded border border-border bg-surface-alt px-3 py-2">
                Expires: <span className="text-text">{formatDisplayDate(licenseStatus.entitlement.expiresAt)}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
