import { describe, expect, it } from 'vitest';
import {
  isFirstRunWizardActive,
  shouldAutoOpenTutorial,
  signalFirstRunWizardFinished,
  signalFirstRunWizardStarted,
} from '../onboardingFlow';

describe('onboarding coordination', () => {
  it('does not open the spotlight tour while first-run setup is still pending', () => {
    expect(shouldAutoOpenTutorial(false, false)).toBe(false);
  });

  it('opens the spotlight tour for existing users who have not dismissed it', () => {
    expect(shouldAutoOpenTutorial(true, false)).toBe(true);
  });

  it('keeps the spotlight tour closed once onboarding has covered it', () => {
    expect(shouldAutoOpenTutorial(true, true)).toBe(false);
  });

  it('blocks every tutorial entry path while the setup wizard is active', () => {
    signalFirstRunWizardStarted();
    expect(isFirstRunWizardActive()).toBe(true);
    expect(shouldAutoOpenTutorial(true, false)).toBe(false);

    signalFirstRunWizardFinished();
    expect(isFirstRunWizardActive()).toBe(false);
  });
});
