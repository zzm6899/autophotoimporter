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

function getEffectiveExpiryDate(status: { expiresAt?: string; entitlement?: { activationExpiresAt?: string; expiresAt?: string } } | null | undefined) {
  return status?.expiresAt ?? status?.entitlement?.activationExpiresAt ?? status?.entitlement?.expiresAt;
}

function getEffectiveActivationDate(status: { activatedAt?: string; entitlement?: { activatedAt?: string } } | null | undefined) {
  return status?.activatedAt ?? status?.entitlement?.activatedAt;
}

export function LicenseOverlay() {
  const { licenseHydrated, licenseStatus, licensePromptOpen } = useAppState();
  const dispatch = useAppDispatch();
  const [licenseInput, setLicenseInput] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
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
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) dispatch({ type: 'CLOSE_LICENSE_PROMPT' });
      }}
    >
      <div className="w-full max-w-xl overflow-hidden rounded-xl border border-border bg-surface shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-text">Activate Photo Importer</h2>
            <p className="mt-1 text-xs text-text-muted">
              You can keep browsing the app without a license, but importing stays disabled until activation.
            </p>
          </div>
          <button
            onClick={() => dispatch({ type: 'CLOSE_LICENSE_PROMPT' })}
            disabled={busy}
            className="shrink-0 rounded p-1 text-text-muted transition-colors hover:bg-surface-raised hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
            title="Close and continue in browse mode"
          >
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>
        <div className="space-y-4 p-5">
          <div className="grid grid-cols-3 gap-2 text-[11px]">
            <div className="rounded border border-border bg-surface-alt px-3 py-2">
              <div className="text-text-muted">Without license</div>
              <div className="mt-1 text-text">Browsing and review only</div>
            </div>
            <div className="rounded border border-border bg-surface-alt px-3 py-2">
              <div className="text-text-muted">With license</div>
              <div className="mt-1 text-emerald-300">Full access</div>
            </div>
            <div className="rounded border border-border bg-surface-alt px-3 py-2">
              <div className="text-text-muted">Seat model</div>
              <div className="mt-1 text-text">Per device</div>
            </div>
          </div>
          <div className="rounded border border-border bg-surface-alt px-3 py-3 text-[11px] text-text-muted">
            <div className="font-medium text-text">How licensing works</div>
            <div className="mt-1">
              Each activated machine uses one device seat. Seat counts are managed in the hosted admin panel, and this app checks the current machine automatically after activation.
            </div>
          </div>
          <textarea
            rows={4}
            value={licenseInput}
            onChange={(e) => setLicenseInput(e.target.value)}
            placeholder="Paste your license key or activation code"
            className="w-full resize-y rounded border border-border bg-surface-raised px-3 py-2 font-mono text-xs text-text placeholder-text-muted focus:border-text focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={activate}
              disabled={busy || !licenseInput.trim()}
              className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Checking...' : 'Activate License'}
            </button>
            <button
              onClick={() => dispatch({ type: 'CLOSE_LICENSE_PROMPT' })}
              disabled={busy}
              className="rounded bg-surface-raised px-4 py-2 text-sm text-text-secondary hover:bg-border disabled:cursor-not-allowed disabled:opacity-40"
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
                Activated: <span className="text-text">{formatDisplayDate(getEffectiveActivationDate(licenseStatus))}</span>
              </div>
              <div className="rounded border border-border bg-surface-alt px-3 py-2">
                Expires: <span className="text-text">{formatDisplayDate(getEffectiveExpiryDate(licenseStatus))}</span>
              </div>
              <div className="rounded border border-border bg-surface-alt px-3 py-2">
                Seats: <span className="text-text">{licenseStatus.deviceSlotsUsed ?? 0}/{licenseStatus.deviceSlotsTotal ?? licenseStatus.entitlement.maxDevices ?? 'unlimited'}</span>
              </div>
              <div className="rounded border border-border bg-surface-alt px-3 py-2">
                Device: <span className="text-text">{licenseStatus.deviceName || 'Current machine'}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
