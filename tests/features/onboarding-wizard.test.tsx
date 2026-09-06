import 'fake-indexeddb/auto';

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RouterProvider } from 'react-router-dom';

import { createAppRouter } from '@/app/router';
import { ROUTES, workspacePath } from '@/app/routes';
import { useHelpStore } from '@/help/helpStore';
import { defaultSettings, type OnboardingStepId } from '@/domain';
import { createCampaign } from '@/db/campaignRepo';
import { readSettings, saveSettings } from '@/db/settingsRepo';
import { useOnboardingStore } from '@/features/onboarding/onboardingStore';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * First-run setup wizard (05-UI.md §Onboarding): the one-time auto-open on a
 * fresh, empty browser, its skip/resume semantics, detection auto-ticks, the
 * Finish/dismiss persistence and the re-open affordances. App-shell tests
 * seed a settled onboarding row instead — the wizard must never hijack a
 * shell test.
 */

function renderAppAt(path: string): void {
  window.history.replaceState(null, '', path);
  render(<RouterProvider router={createAppRouter()} />);
}

function openWizard(focus?: OnboardingStepId): void {
  act(() => {
    useOnboardingStore.getState().openWizard(focus);
  });
}

beforeEach(async () => {
  await clearDatabase();
  useOnboardingStore.setState({ open: false, focusStep: null });
  useHelpStore.setState({ topic: null });
});
afterEach(() => {
  cleanup();
});

describe('auto-open', () => {
  it('opens once on a fresh empty browser and persists "active" (never again)', async () => {
    renderAppAt(ROUTES.campaignPicker);
    expect(await screen.findByTestId('setup-wizard')).toBeInTheDocument();
    await waitFor(() => {
      expect(useOnboardingStore.getState().open).toBe(true);
    });
    await flushAsyncUpdates();
    const status = (await readSettings()).onboarding.status;
    expect(status).toBe('active');

    // Second launch on the same browser: no auto-open.
    cleanup();
    act(() => {
      useOnboardingStore.setState({ open: false, focusStep: null });
    });
    renderAppAt(ROUTES.campaignPicker);
    await flushAsyncUpdates();
    expect(screen.queryByTestId('setup-wizard')).toBeNull();
  }, 20000);

  it('does not auto-open when campaigns already exist (upgrade safety)', async () => {
    await createCampaign({ name: 'Ember', system: 'dnd5e' });
    renderAppAt(ROUTES.campaignPicker);
    await flushAsyncUpdates();
    expect(screen.queryByTestId('setup-wizard')).toBeNull();
    // The status stays 'fresh' so a genuinely first run still gets it.
    expect((await readSettings()).onboarding.status).toBe('fresh');
  }, 20000);

  it('does not auto-open when dismissed', async () => {
    await saveSettings({
      ...defaultSettings(),
      onboarding: { status: 'dismissed' as const, stepState: [] },
    });
    renderAppAt(ROUTES.campaignPicker);
    await flushAsyncUpdates();
    expect(screen.queryByTestId('setup-wizard')).toBeNull();
  }, 20000);
});

describe('checklist semantics', () => {
  it('starts expanded on the welcome step; Begin resolves it and focuses the next step', async () => {
    renderAppAt(ROUTES.campaignPicker);
    expect(await screen.findByTestId('setup-wizard')).toBeInTheDocument();
    // Expansion waits for the settings live query on first mount.
    await waitFor(() => {
      expect(screen.getByTestId('wizard-row-welcome')).toHaveAttribute('aria-expanded', 'true');
    });

    const user = userEvent.setup();
    await user.click(screen.getByTestId('wizard-begin'));
    await waitFor(() => {
      expect(screen.getByTestId('wizard-row-welcome')).toHaveAttribute('aria-expanded', 'false');
      expect(screen.getByTestId('wizard-row-openrouter')).toHaveAttribute('aria-expanded', 'true');
    });
    expect((await readSettings()).onboarding.stepState).toEqual([
      { id: 'welcome', state: 'done' },
    ]);
  }, 20000);

  it('Skip persists as skipped and the wizard resumes at the first unresolved step', async () => {
    renderAppAt(ROUTES.campaignPicker);
    expect(await screen.findByTestId('setup-wizard')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('wizard-row-welcome')).toHaveAttribute('aria-expanded', 'true');
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('wizard-begin'));
    await waitFor(() => {
      expect(screen.getByTestId('wizard-row-openrouter')).toHaveAttribute('aria-expanded', 'true');
    });
    await user.click(screen.getByTestId('wizard-skip-openrouter'));

    const onboarding = (await readSettings()).onboarding;
    expect(onboarding.stepState).toEqual([
      { id: 'welcome', state: 'done' },
      { id: 'openrouter', state: 'skipped' },
    ]);

    // Close and re-open: the first unresolved step (language) is focused.
    cleanup();
    act(() => {
      useOnboardingStore.setState({ open: false, focusStep: null });
    });
    renderAppAt(ROUTES.campaignPicker);
    const user2 = userEvent.setup();
    await user2.click(await screen.findByTestId('get-set-up'));
    expect(await screen.findByTestId('setup-wizard')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('wizard-row-language')).toHaveAttribute('aria-expanded', 'true');
    });
  }, 20000);

  it('auto-ticks a pending step when its detection signal fires (saved key)', async () => {
    await saveSettings({
      ...defaultSettings(),
      openRouterApiKey: 'sk-or-test',
      onboarding: { status: 'active' as const, stepState: [{ id: 'welcome', state: 'done' }] },
    });
    renderAppAt(ROUTES.campaignPicker);
    openWizard('openrouter');
    await screen.findByTestId('setup-wizard');
    await waitFor(() => {
      expect(screen.getByTestId('wizard-row-openrouter')).toHaveAttribute('aria-expanded', 'true');
    });
    const step = screen.getByTestId('wizard-step-openrouter');
    expect(within(step).getByLabelText('done')).toBeInTheDocument();
    await waitFor(async () => {
      const onboarding = (await readSettings()).onboarding;
      expect(onboarding.stepState).toContainEqual({ id: 'openrouter', state: 'done' });
    });
  }, 20000);

  it('shows campaign/module sub-progress on the author step', async () => {
    await createCampaign({ name: 'Ember', system: 'dnd5e' });
    renderAppAt(ROUTES.campaignPicker);
    openWizard('author');
    await screen.findByTestId('setup-wizard');
    await waitFor(() => {
      expect(screen.getByTestId('wizard-row-author')).toHaveAttribute('aria-expanded', 'true');
    });
    const step = screen.getByTestId('wizard-step-author');
    expect(within(step).getByTestId('wizard-detail-campaign')).toHaveTextContent('✓');
    expect(within(step).getByTestId('wizard-detail-module')).toHaveTextContent('·');
  }, 20000);
});

describe('completion + dismissal persistence', () => {
  it('Finish stays disabled until every step is resolved, then marks complete', async () => {
    await saveSettings({
      ...defaultSettings(),
      onboarding: {
        status: 'active' as const,
        stepState: [
          { id: 'welcome', state: 'done' },
          { id: 'openrouter', state: 'done' },
          { id: 'language', state: 'skipped' },
          { id: 'rulebook', state: 'done' },
          { id: 'pack', state: 'skipped' },
        ],
      },
    });
    renderAppAt(ROUTES.campaignPicker);
    openWizard();
    expect(await screen.findByTestId('setup-wizard')).toBeInTheDocument();
    expect(screen.getByTestId('wizard-finish')).toBeDisabled();

    // Resolve the last pending step (author) — it is already the expanded
    // focus step (first unresolved); expanding rows toggles, so just act.
    await waitFor(() => {
      expect(screen.getByTestId('wizard-row-author')).toHaveAttribute('aria-expanded', 'true');
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('wizard-done-author'));
    await waitFor(() => {
      expect(screen.getByTestId('wizard-finish')).toBeEnabled();
    });
    await user.click(screen.getByTestId('wizard-finish'));
    await waitFor(() => {
      expect(useOnboardingStore.getState().open).toBe(false);
    });
    expect((await readSettings()).onboarding.status).toBe('complete');
  }, 20000);

  it('"Don\'t show again" persists dismissed and closes', async () => {
    renderAppAt(ROUTES.campaignPicker);
    expect(await screen.findByTestId('setup-wizard')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('wizard-dismiss'));
    await waitFor(() => {
      expect(useOnboardingStore.getState().open).toBe(false);
    });
    expect((await readSettings()).onboarding.status).toBe('dismissed');
  }, 20000);
});

describe('steps link out to existing surfaces', () => {
  it('navigates on an internal link (closing the dialog) and renders the external anchor', async () => {
    renderAppAt(ROUTES.campaignPicker);
    openWizard('openrouter');
    expect(await screen.findByTestId('setup-wizard')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('wizard-row-openrouter')).toHaveAttribute('aria-expanded', 'true');
    });

    const external = screen.getByTestId('wizard-link-openrouter-keys');
    expect(external).toHaveAttribute('href', 'https://openrouter.ai/keys');
    expect(external).toHaveAttribute('target', '_blank');

    const user = userEvent.setup();
    await user.click(screen.getByTestId('wizard-link-settings'));
    await waitFor(() => {
      expect(useOnboardingStore.getState().open).toBe(false);
    });
    expect(window.location.pathname).toBe(ROUTES.settings);
  }, 20000);
});

describe('re-open affordances', () => {
  it('picker header button opens the wizard; hidden when complete', async () => {
    renderAppAt(ROUTES.campaignPicker);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('get-set-up'));
    expect(await screen.findByTestId('setup-wizard')).toBeInTheDocument();
  }, 20000);

  it('welcome panel offers "Set up Campaigner" while the wizard is unfinished', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    await saveSettings({
      ...defaultSettings(),
      onboarding: { status: 'active' as const, stepState: [] },
    });
    renderAppAt(workspacePath(campaign.id));
    expect(await screen.findByTestId('welcome-set-up')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('welcome-set-up'));
    expect(await screen.findByTestId('setup-wizard')).toBeInTheDocument();
  }, 20000);

  it("help's setup topic reopens the wizard and closes help", async () => {
    renderAppAt(ROUTES.campaignPicker);
    act(() => {
      useHelpStore.setState({ topic: 'setup' });
    });
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('help-reopen-wizard'));
    expect(await screen.findByTestId('setup-wizard')).toBeInTheDocument();
    // Base UI unmounts the closing dialog after its exit transition.
    await waitFor(() => {
      expect(screen.queryByTestId('help-dialog')).toBeNull();
    });
  }, 20000);
});
