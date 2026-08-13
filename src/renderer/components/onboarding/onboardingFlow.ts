export const FIRST_RUN_WIZARD_STARTED_EVENT = 'keptra:onboarding-wizard-started';
export const FIRST_RUN_WIZARD_FINISHED_EVENT = 'keptra:onboarding-wizard-finished';
export const TUTORIAL_STORAGE_KEY = 'photo-importer:tutorial-dismissed';

let firstRunWizardActive = false;

export function shouldAutoOpenTutorial(firstRunWizardSeen: boolean, tutorialDismissed: boolean): boolean {
  return firstRunWizardSeen && !tutorialDismissed && !firstRunWizardActive;
}

export function isFirstRunWizardActive(): boolean {
  return firstRunWizardActive;
}

export function signalFirstRunWizardStarted(): void {
  firstRunWizardActive = true;
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(FIRST_RUN_WIZARD_STARTED_EVENT));
}

/**
 * The setup wizard already teaches the core source -> review -> import path.
 * Mark the older spotlight tour as covered so a new photographer does not get
 * a second onboarding overlay immediately after setup (or on the next launch).
 */
export function signalFirstRunWizardFinished(): void {
  firstRunWizardActive = false;
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(TUTORIAL_STORAGE_KEY, '1');
  } catch {
    // Settings still records wizard completion; storage can be unavailable in
    // hardened renderer environments without blocking the first-run flow.
  }
  window.dispatchEvent(new Event(FIRST_RUN_WIZARD_FINISHED_EVENT));
}
