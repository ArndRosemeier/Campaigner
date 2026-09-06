import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import { countCampaigns } from '@/db/campaignRepo';
import { countRulebooks } from '@/db/rulebookRepo';
import { countModules } from '@/db/moduleRepo';
import { readSettings } from '@/db/settingsRepo';
import { WIZARD_STEPS } from '@/features/onboarding/onboardingContent';
import { onboardingOf, stepStateOf } from '@/features/onboarding/onboardingState';
import { defaultSettings } from '@/domain';
import type {
  Onboarding,
  OnboardingStepId,
  OnboardingStepState,
  Settings,
} from '@/domain';

/**
 * Live inputs for the setup wizard: the settings row plus the three counts
 * its detection signals read (key presence is on the settings row). A step's
 * EFFECTIVE state is persisted state OR a fired detection signal — so a user
 * who saved their key before opening the wizard sees the step already done,
 * and the dialog persists the transition (pending → done) once.
 */
export interface StepProgress {
  id: OnboardingStepId;
  persisted: OnboardingStepState;
  /** Effective display state: persisted state, upgraded to 'done' when the
      detection signal fires on a pending step. */
  effective: OnboardingStepState;
  /** Live sub-progress for the 'author' step (campaign / module created). */
  authorProgress?: { campaign: boolean; module: boolean } | undefined;
}

export interface OnboardingProgress {
  /** undefined while the settings row loads. */
  settings: Settings | undefined;
  onboarding: Onboarding;
  steps: StepProgress[];
  /** True when a detection signal fired on a pending step this render — the
      dialog persists these transitions in an effect. */
  pendingPersist: { id: OnboardingStepId; state: OnboardingStepState }[];
}

export function useOnboardingProgress(): OnboardingProgress {
  const settings = useLiveQuery(() => readSettings(), [], undefined);
  const campaignsCount = useLiveQuery(() => countCampaigns(), [], 0);
  const rulebooksCount = useLiveQuery(() => countRulebooks(), [], 0);
  const modulesCount = useLiveQuery(() => countModules(), [], 0);

  return useMemo<OnboardingProgress>(() => {
    const onboarding = onboardingOf(settings ?? defaultSettings());
    const counts = {
      campaigns: campaignsCount,
      rulebooks: rulebooksCount,
      modules: modulesCount,
    };
    const languageSet = (settings?.language ?? 'en') !== 'en';
    const keySaved = (settings?.openRouterApiKey ?? '') !== '';

    const detected: Partial<Record<OnboardingStepId, boolean>> = {
      openrouter: keySaved,
      language: languageSet,
      rulebook: counts.rulebooks > 0,
      author: counts.campaigns > 0 && counts.modules > 0,
    };

    const pendingPersist: { id: OnboardingStepId; state: OnboardingStepState }[] = [];
    const steps: StepProgress[] = WIZARD_STEPS.map((step) => {
      const persisted = stepStateOf(onboarding, step.id);
      const fired = detected[step.id] === true;
      const effective: OnboardingStepState =
        persisted === 'pending' && fired ? 'done' : persisted;
      if (effective !== persisted) pendingPersist.push({ id: step.id, state: effective });
      return {
        id: step.id,
        persisted,
        effective,
        authorProgress:
          step.id === 'author'
            ? { campaign: counts.campaigns > 0, module: counts.modules > 0 }
            : undefined,
      };
    });

    return { settings, onboarding, steps, pendingPersist };
  }, [settings, campaignsCount, rulebooksCount, modulesCount]);
}

/** Convenience for callers that need one step's progress snapshot. */
export function stepById(progress: OnboardingProgress, id: OnboardingStepId): StepProgress {
  const step = progress.steps.find((entry) => entry.id === id);
  if (step === undefined) throw new Error(`No wizard progress for step: ${id}`);
  return step;
}
