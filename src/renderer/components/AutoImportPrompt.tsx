import { useEffect, useState } from 'react';
import { useAppDispatch } from '../context/ImportContext';

/**
 * First-run prompt for auto-import. Fires once — the first time the app is
 * launched after this feature ships, or the first time after the user clears
 * settings. Gate is the persisted `autoImportPromptSeen` flag, not a state
 * variable, so it survives restarts.
 *
 * Design goal: lightweight intro, not a wizard. The user can opt in (which
 * then makes them pick a destination folder), opt out permanently, or
 * dismiss and revisit from the workflow panel later.
 */
export function AutoImportPrompt() {
  const dispatch = useAppDispatch();
  const [show, setShow] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    window.electronAPI.getSettings().then((settings) => {
      if (!settings.autoImportPromptSeen) setShow(true);
      setChecking(false);
    }).catch(() => setChecking(false));
  }, []);

  const markSeen = () => {
    window.electronAPI.setSettings({ autoImportPromptSeen: true });
    setShow(false);
  };

  const handleEnable = async () => {
    const folder = await window.electronAPI.selectFolder('Choose an auto-import destination folder');
    if (!folder) return; // user cancelled the folder picker — leave the prompt up
    dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'autoImport', value: true });
    dispatch({ type: 'SET_WORKFLOW_STRING', key: 'autoImportDestRoot', value: folder });
    await window.electronAPI.setSettings({
      autoImport: true,
      autoImportDestRoot: folder,
      autoImportPromptSeen: true,
    });
    setShow(false);
  };

  const handleNoThanks = () => {
    dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'autoImport', value: false });
    window.electronAPI.setSettings({ autoImport: false, autoImportPromptSeen: true });
    setShow(false);
  };

  const handleRemindLater = () => {
    // Don't flip autoImportPromptSeen — they'll see this again next launch
    setShow(false);
  };

  if (checking || !show) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="relative bg-surface border border-border rounded-lg shadow-2xl p-5 max-w-sm w-full mx-4">
        <h2 className="text-sm font-semibold text-text mb-1">Auto-import when you plug in a card?</h2>
        <p className="text-xs text-text-secondary leading-relaxed mb-3">
          We can kick off the import the moment a camera card is inserted, using your saved folder
          structure and format settings. Great if you import the same way every shoot.
        </p>
        <p className="text-[11px] text-text-muted mb-4">
          You can change this anytime from the Output panel.
        </p>
        <div className="flex flex-col gap-1.5">
          <button
            onClick={handleEnable}
            className="w-full py-1.5 text-xs font-medium bg-accent hover:bg-accent-hover text-white rounded transition-colors"
          >
            Yes — choose a folder
          </button>
          <button
            onClick={handleNoThanks}
            className="w-full py-1.5 text-xs text-text-secondary hover:text-text bg-surface-raised hover:bg-border rounded transition-colors"
          >
            No thanks
          </button>
          <button
            onClick={handleRemindLater}
            className="w-full py-1 text-[11px] text-text-muted hover:text-text transition-colors"
          >
            Remind me later
          </button>
        </div>
        {/* Dismiss with the X doesn't mark as seen — intentional, so users
            who close it accidentally can still opt in later */}
        <button
          onClick={handleRemindLater}
          className="absolute top-2 right-2 p-1 text-text-muted hover:text-text"
          aria-label="Dismiss"
        >
          <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M4.28 3.22a.75.75 0 00-1.06 1.06L8.94 10l-5.72 5.72a.75.75 0 101.06 1.06L10 11.06l5.72 5.72a.75.75 0 101.06-1.06L11.06 10l5.72-5.72a.75.75 0 00-1.06-1.06L10 8.94 4.28 3.22z" clipRule="evenodd" />
          </svg>
        </button>
      </div>
    </div>
  );
}
