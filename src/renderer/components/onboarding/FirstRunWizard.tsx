import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, FolderOpen, HardDrive, Network, Sparkles, X } from 'lucide-react';
import type { ExperienceMode, SourceKind } from '../../../shared/types';
import { FOLDER_PRESETS } from '../../../shared/types';
import { useAppDispatch } from '../../context/ImportContext';
import { OnboardingStep } from './OnboardingStep';

type WizardStep = 0 | 1 | 2 | 3 | 4 | 5;

const STEPS = ['Welcome', 'Source', 'Destination', 'Folders', 'Automation', 'Finish'];

function ChoiceButton({
  active,
  title,
  description,
  onClick,
}: {
  active: boolean;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
        active
          ? 'border-emerald-500/35 bg-emerald-500/10 text-text'
          : 'border-border bg-surface-alt text-text-secondary hover:border-text-muted hover:text-text'
      }`}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold">{title}</span>
        {active && <Check className="h-3.5 w-3.5 text-emerald-300" aria-hidden="true" />}
      </span>
      <span className="mt-0.5 block text-[10px] leading-snug text-text-muted">{description}</span>
    </button>
  );
}

export function FirstRunWizard() {
  const dispatch = useAppDispatch();
  const [checking, setChecking] = useState(true);
  const [show, setShow] = useState(false);
  const [step, setStep] = useState<WizardStep>(0);
  const [experienceMode, setExperienceMode] = useState<ExperienceMode>('simple');
  const [sourceKind, setSourceKind] = useState<SourceKind>('volume');
  const [destination, setDestination] = useState('');
  const [folderPreset, setFolderPreset] = useState('date-flat');
  const [autoImport, setAutoImport] = useState(false);
  const [openFolderOnComplete, setOpenFolderOnComplete] = useState(true);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.getSettings()
      .then((settings) => {
        if (cancelled) return;
        if (!settings.firstRunWizardSeen) setShow(true);
        setExperienceMode(settings.experienceMode ?? 'simple');
        setDestination(settings.lastDestination ?? '');
        setFolderPreset(settings.folderPreset ?? 'date-flat');
        setAutoImport(settings.autoImport ?? false);
        setOpenFolderOnComplete(settings.openFolderOnComplete ?? true);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const progressPct = useMemo(() => Math.round(((step + 1) / STEPS.length) * 100), [step]);

  const chooseDestination = async () => {
    const folder = await window.electronAPI.selectFolder('Choose your default destination folder');
    if (folder) setDestination(folder);
  };

  const persist = async (seen: boolean) => {
    const pattern = FOLDER_PRESETS[folderPreset]?.pattern ?? FOLDER_PRESETS['date-flat'].pattern;
    dispatch({ type: 'SET_EXPERIENCE_MODE', mode: experienceMode });
    dispatch({ type: 'SET_SOURCE_KIND', kind: sourceKind });
    dispatch({ type: 'SET_FOLDER_PRESET', preset: folderPreset });
    dispatch({ type: 'SET_CUSTOM_PATTERN', pattern });
    dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'autoImport', value: autoImport && !!destination });
    dispatch({ type: 'SET_WORKFLOW_OPTION', key: 'openFolderOnComplete', value: openFolderOnComplete });
    if (destination) {
      dispatch({ type: 'SET_DESTINATION', path: destination });
      dispatch({ type: 'SET_WORKFLOW_STRING', key: 'autoImportDestRoot', value: autoImport ? destination : '' });
    }
    await window.electronAPI.setSettings({
      firstRunWizardSeen: seen,
      autoImportPromptSeen: true,
      experienceMode,
      lastDestination: destination,
      folderPreset,
      customPattern: pattern,
      autoImport: autoImport && !!destination,
      autoImportDestRoot: autoImport && destination ? destination : '',
      openFolderOnComplete,
    });
    setShow(false);
  };

  const skip = () => {
    void window.electronAPI.setSettings({ firstRunWizardSeen: true, autoImportPromptSeen: true });
    setShow(false);
  };

  const next = () => setStep((value) => Math.min(5, value + 1) as WizardStep);
  const prev = () => setStep((value) => Math.max(0, value - 1) as WizardStep);

  if (checking || !show) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 px-4 backdrop-blur-sm">
      <div
        className="w-full max-w-xl rounded-lg border border-border bg-surface p-5 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="keptra-first-run-title"
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">First run</div>
            <div id="keptra-first-run-title" className="mt-0.5 text-sm font-semibold text-text">Set up Keptra in under a minute</div>
          </div>
          <button
            type="button"
            onClick={skip}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface-alt text-text-muted hover:text-text"
            aria-label="Skip first-run setup"
            title="Skip first-run setup"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>

        <div className="mb-4">
          <div className="mb-1 flex items-center justify-between text-[10px] text-text-muted">
            <span>{STEPS[step]}</span>
            <span>{step + 1}/{STEPS.length}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-raised">
            <div className="h-full rounded-full bg-emerald-400 transition-[width] duration-200" style={{ width: `${progressPct}%` }} />
          </div>
        </div>

        {step === 0 && (
          <OnboardingStep
            eyebrow="Welcome"
            title="Cull before import"
            description="Keptra keeps the first pass local: choose a source, review the set, send only the keepers to your destination, then verify the result."
            icon={Sparkles}
          >
            <div className="grid grid-cols-3 gap-2 text-[10px] text-text-secondary">
              {['Choose source', 'Review keepers', 'Import safely'].map((item) => (
                <div key={item} className="rounded-md border border-border bg-surface-alt px-2 py-2">{item}</div>
              ))}
            </div>
          </OnboardingStep>
        )}

        {step === 1 && (
          <OnboardingStep
            eyebrow="Source type"
            title="Start with your everyday workflow"
            description="Simple mode keeps card and folder imports prominent. Pro mode adds FTP, watch folders, diagnostics, and deeper output controls."
            icon={HardDrive}
          >
            <div className="grid gap-2">
              <ChoiceButton
                active={experienceMode === 'simple'}
                title="Simple mode"
                description="Cards, folders, review, destination, import, and summary."
                onClick={() => {
                  setExperienceMode('simple');
                  setSourceKind('volume');
                }}
              />
              <ChoiceButton
                active={experienceMode === 'pro'}
                title="Pro mode"
                description="Adds FTP, watch folders, catalog, diagnostics, metadata, watermarking, and performance tuning."
                onClick={() => setExperienceMode('pro')}
              />
              {experienceMode === 'pro' && (
                <div className="grid grid-cols-2 gap-2">
                  <ChoiceButton
                    active={sourceKind === 'volume'}
                    title="Card or folder"
                    description="Local storage first."
                    onClick={() => setSourceKind('volume')}
                  />
                  <ChoiceButton
                    active={sourceKind === 'ftp'}
                    title="FTP source"
                    description="Camera or remote source."
                    onClick={() => setSourceKind('ftp')}
                  />
                </div>
              )}
            </div>
          </OnboardingStep>
        )}

        {step === 2 && (
          <OnboardingStep
            eyebrow="Destination folder"
            title="Choose where keepers should land"
            description="This becomes the default output folder. You can change it for any import from the output panel."
            icon={FolderOpen}
          >
            <button
              type="button"
              onClick={chooseDestination}
              className="w-full rounded-md border border-border bg-surface-alt px-3 py-2 text-left text-xs text-text-secondary hover:border-text-muted hover:text-text"
            >
              {destination || 'Choose destination folder'}
            </button>
            <p className="text-[10px] text-text-muted">You can skip this and choose a folder later.</p>
          </OnboardingStep>
        )}

        {step === 3 && (
          <OnboardingStep
            eyebrow="Folder organization"
            title="Pick a naming style"
            description="Keptra previews this before import so the folder structure is never a surprise."
            icon={FolderOpen}
          >
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(FOLDER_PRESETS).slice(0, 6).map(([key, preset]) => (
                <ChoiceButton
                  key={key}
                  active={folderPreset === key}
                  title={preset.label}
                  description={preset.pattern}
                  onClick={() => setFolderPreset(key)}
                />
              ))}
            </div>
          </OnboardingStep>
        )}

        {step === 4 && (
          <OnboardingStep
            eyebrow="Automation"
            title="Decide what happens after setup"
            description="Auto-import is useful when every card should go to the same place. Opening the destination helps confirm a finished import."
            icon={Network}
          >
            <div className="grid gap-2">
              <label className={`flex items-start gap-2 rounded-md border border-border bg-surface-alt px-3 py-2 ${destination ? 'cursor-pointer' : 'opacity-55'}`}>
                <input
                  type="checkbox"
                  checked={autoImport && !!destination}
                  disabled={!destination}
                  onChange={(event) => setAutoImport(event.target.checked)}
                />
                <span>
                  <span className="block text-xs font-semibold text-text">Auto-import inserted cards</span>
                  <span className="block text-[10px] text-text-muted">Requires a default destination.</span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-surface-alt px-3 py-2">
                <input
                  type="checkbox"
                  checked={openFolderOnComplete}
                  onChange={(event) => setOpenFolderOnComplete(event.target.checked)}
                />
                <span>
                  <span className="block text-xs font-semibold text-text">Open destination after import</span>
                  <span className="block text-[10px] text-text-muted">Keeps the completion step visible and easy to verify.</span>
                </span>
              </label>
            </div>
          </OnboardingStep>
        )}

        {step === 5 && (
          <OnboardingStep
            eyebrow="Ready"
            title="Your import path is set"
            description="Keptra will keep the simple flow up front and save advanced controls for when you switch to Pro mode."
            icon={Check}
          >
            <div className="grid gap-1 rounded-md border border-border bg-surface-alt px-3 py-2 text-[11px] text-text-secondary">
              <div className="flex justify-between gap-3"><span>Mode</span><span className="text-text">{experienceMode === 'pro' ? 'Pro' : 'Simple'}</span></div>
              <div className="flex justify-between gap-3"><span>Source</span><span className="text-text">{sourceKind === 'ftp' ? 'FTP' : 'Card or folder'}</span></div>
              <div className="flex justify-between gap-3"><span>Destination</span><span className="truncate text-text">{destination || 'Choose later'}</span></div>
              <div className="flex justify-between gap-3"><span>Folders</span><span className="text-text">{FOLDER_PRESETS[folderPreset]?.label ?? folderPreset}</span></div>
            </div>
          </OnboardingStep>
        )}

        <div className="mt-5 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={prev}
            disabled={step === 0}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-alt px-3 py-1.5 text-xs text-text-secondary hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Back
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={skip}
              className="rounded-md px-3 py-1.5 text-xs text-text-muted hover:text-text-secondary"
            >
              Skip
            </button>
            {step < 5 ? (
              <button
                type="button"
                onClick={next}
                className="inline-flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover"
              >
                Next
                <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => { void persist(true); }}
                className="inline-flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover"
              >
                Finish
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
