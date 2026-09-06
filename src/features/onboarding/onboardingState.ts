import type {
  Onboarding,
  OnboardingStatus,
  OnboardingStepEntry,
  OnboardingStepId,
  OnboardingStepState,
  Settings,
} from '@/domain';
import { ONBOARDING_STEP_IDS } from '@/domain';

import { readSettings, updateSettings } from '@/db/settingsRepo';

/**
 * Pure state semantics + the two persisted writers for the first-run wizard
 * (settings row field `onboarding`, see /src/domain/settings.ts). Storage is
 * a list of per-step entries: an id absent from the list is 'pending', and
 * `setOnboardingStep` always rewrites the WHOLE `onboarding` object because
 * `updateSettings` merges one level deep — a partial patch would clobber
 * `stepState`.
 */

export function onboardingOf(settings: Settings): Onboarding {
  return settings.onboarding;
}

/** Missing entries are 'pending' (the old-rows convention). */
export function stepStateOf(onboarding: Onboarding, id: OnboardingStepId): OnboardingStepState {
  return onboarding.stepState.find((entry) => entry.id === id)?.state ?? 'pending';
}

/** Pure: returns `onboarding` with one step's state set (entry replaced, order kept). */
export function withStepState(
  onboarding: Onboarding,
  id: OnboardingStepId,
  state: OnboardingStepState,
): Onboarding {
  const entries: OnboardingStepEntry[] = onboarding.stepState.some((entry) => entry.id === id)
    ? onboarding.stepState.map((entry) => (entry.id === id ? { id, state } : entry))
    : [...onboarding.stepState, { id, state }];
  return { ...onboarding, stepState: entries };
}

/** First step in display order that is neither done nor skipped. */
export function firstUnresolvedStepId(onboarding: Onboarding): OnboardingStepId | null {
  for (const id of ONBOARDING_STEP_IDS) {
    const state = stepStateOf(onboarding, id);
    if (state === 'pending') return id;
  }
  return null;
}

/** True when every step is resolved (the "Finish" gate). */
export function allStepsResolved(onboarding: Onboarding): boolean {
  return firstUnresolvedStepId(onboarding) === null;
}

/** Persists one step's state (read-modify-write of the whole onboarding object). */
export async function setOnboardingStep(
  id: OnboardingStepId,
  state: OnboardingStepState,
): Promise<void> {
  await updateSettings({
    onboarding: withStepState(await readOnboarding(), id, state),
  });
}

/** Persists the wizard status ('active' on open, 'dismissed', 'complete'). */
export async function setOnboardingStatus(status: OnboardingStatus): Promise<void> {
  await updateSettings({ onboarding: { ...(await readOnboarding()), status } });
}

async function readOnboarding(): Promise<Onboarding> {
  return (await readSettings()).onboarding;
}
