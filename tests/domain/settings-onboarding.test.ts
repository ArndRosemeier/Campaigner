import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import {
  defaultSettings,
  onboardingSchema,
  settingsSchema,
  type Onboarding,
  type Settings,
} from '@/domain';
import {
  allStepsResolved,
  firstUnresolvedStepId,
  setOnboardingStatus,
  setOnboardingStep,
  stepStateOf,
  withStepState,
} from '@/features/onboarding/onboardingState';
import { readSettings, saveSettings } from '@/db/settingsRepo';
import { clearDatabase } from '../db/helpers';

/**
 * First-run wizard state (banked onboarding design): the settings field
 * parses for rows written before it existed, missing step entries are
 * 'pending', and the persisted writers merge the whole onboarding object so
 * sibling settings fields survive.
 */

describe('onboarding settings field', () => {
  it('parses an old row without the field into fresh defaults', () => {
    const oldRow = { ...defaultSettings() };
    delete (oldRow as Partial<Settings>).onboarding;
    const parsed = settingsSchema.parse(oldRow);
    expect(parsed.onboarding).toEqual({ status: 'fresh', stepState: [] });
  });

  it('parses an old row without lastModule into null (shortcut hidden)', () => {
    const oldRow = { ...defaultSettings() };
    delete (oldRow as Partial<Settings>).lastModule;
    const parsed = settingsSchema.parse(oldRow);
    expect(parsed.lastModule).toBeNull();
  });

  it('defaults the default settings row to a fresh wizard', () => {
    expect(defaultSettings().onboarding).toEqual({ status: 'fresh', stepState: [] });
  });

  it('rejects an unknown status loudly (no silent fallback)', () => {
    expect(() => onboardingSchema.parse({ status: 'someday', stepState: [] })).toThrow();
  });
});

describe('step state helpers', () => {
  it('reads a missing entry as pending', () => {
    expect(stepStateOf({ status: 'active', stepState: [] }, 'openrouter')).toBe('pending');
  });

  it('replaces an existing entry instead of duplicating it', () => {
    const onboarding: Onboarding = {
      status: 'active',
      stepState: [{ id: 'welcome', state: 'done' }],
    };
    const next = withStepState(onboarding, 'welcome', 'skipped');
    expect(next.stepState).toEqual([{ id: 'welcome', state: 'skipped' }]);
    expect(withStepState(onboarding, 'rulebook', 'done').stepState).toHaveLength(2);
  });

  it('returns the first pending step in display order and completion', () => {
    const onboarding: Onboarding = {
      status: 'active',
      stepState: [
        { id: 'welcome', state: 'done' },
        { id: 'openrouter', state: 'skipped' },
      ],
    };
    expect(firstUnresolvedStepId(onboarding)).toBe('language');
    expect(
      allStepsResolved({
        status: 'active',
        stepState: [{ id: 'welcome', state: 'done' }, { id: 'openrouter', state: 'skipped' }],
      }),
    ).toBe(false);
    expect(
      allStepsResolved({
        status: 'active',
        stepState: [
          { id: 'welcome', state: 'done' },
          { id: 'openrouter', state: 'done' },
          { id: 'language', state: 'skipped' },
          { id: 'rulebook', state: 'done' },
          { id: 'pack', state: 'skipped' },
          { id: 'author', state: 'done' },
        ],
      }),
    ).toBe(true);
  });
});

describe('persisted writers', () => {
  it('setOnboardingStep merges the whole onboarding object without clobbering siblings', async () => {
    await clearDatabase();
    // A pre-existing row with a saved key and a resolved step must keep both.
    await saveSettings({ ...defaultSettings(), openRouterApiKey: 'sk-or-x' });
    await saveSettings({
      ...defaultSettings(),
      openRouterApiKey: 'sk-or-x',
      onboarding: { status: 'active', stepState: [{ id: 'welcome', state: 'done' }] },
    });

    await setOnboardingStep('openrouter', 'done');
    await setOnboardingStatus('complete');

    const settings = await readSettings();
    expect(settings.openRouterApiKey).toBe('sk-or-x');
    expect(settings.onboarding.status).toBe('complete');
    expect(stepStateOf(settings.onboarding, 'welcome')).toBe('done');
    expect(stepStateOf(settings.onboarding, 'openrouter')).toBe('done');
    expect(stepStateOf(settings.onboarding, 'language')).toBe('pending');
  });
});
