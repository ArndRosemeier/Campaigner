import 'fake-indexeddb/auto';

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
import { ROUTES, modulePath } from '@/app/routes';
import { DEFAULT_THEME, useThemeStore } from '@/app/theme/theme';
import { createCampaign } from '@/db/campaignRepo';
import { listPersonas } from '@/db/personaRepo';
import { createRun, getRun } from '@/db/runRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { getModule, saveModule } from '@/db/moduleRepo';
import { defaultSettings, modulePartSchema, moduleSpineSchema } from '@/domain';
import { createModule } from '@/domain';
import { saveSettings } from '@/db/settingsRepo';
import { INTERRUPTED_MODULE_GEN_MESSAGE } from '@/llm/moduleGenReconcile';
import { clearDatabase } from '../db/helpers';
import { actDrained, flushAsyncUpdates } from '../helpers/flush';

/**
 * WHAT THE SHELL OWNS AT START (docs/17 row 110, docs/18 §2.2/§4).
 *
 * Two measured defects lived in `AppShell`:
 *
 * 1. `failRunningRuns()`, `seedBuiltInPersonas()` and `ensurePersistentStorage()`
 *    were called from the RENDER BODY. Every re-render (the theme toggle, the
 *    help dialog, any store change) re-ran them — and `failRunningRuns` marks
 *    every `status: 'running'` row failed, so a live run could be failed by an
 *    unrelated UI change. It is a START action; it now runs in a mount effect.
 * 2. Nothing reconciled MODULE rows, so a tab that was reloaded/discarded mid
 *    generation left a module 'generating' forever: a permanent spinner, a Stop
 *    button that did nothing, every retry affordance gated behind `!busy`, and
 *    "Stop all" counting it as stopped. Start now reconciles those rows loudly.
 *
 * The reload cases that make this matter most get NO `visibilitychange` at all
 * (a discarded tab reloads), which is why start is the load-bearing moment and
 * the visibility path is only the second chance.
 */

async function seedSettledOnboarding(): Promise<void> {
  await saveSettings({
    ...defaultSettings(),
    onboarding: { status: 'complete' as const, stepState: [] },
  });
}

function renderAppAt(path: string): void {
  window.history.replaceState(null, '', path);
  render(<RouterProvider router={createAppRouter()} />);
}

async function seedRunningRun(): Promise<string> {
  const campaign = await createCampaign({ name: 'Boot', system: 'dnd5e' });
  const persona = (await listPersonas())[0];
  if (persona === undefined) throw new Error('no built-in persona seeded');
  const run = await createRun({
    campaignId: campaign.id,
    personaId: persona.id,
    autonomy: 'auto',
    userBrief: 'Detail the gate warden',
  });
  return run.id;
}

/** A module row in exactly the state a reloaded tab leaves behind. */
async function seedInterruptedModule(): Promise<{ campaignId: string; moduleId: string }> {
  const campaign = await createCampaign({ name: 'Interrupted', system: 'dnd5e' });
  const draft = createModule({
    campaignId: campaign.id,
    title: 'The Drowned Vault',
    concept: 'A vault under the mill.',
    levelMin: 1,
    levelMax: 2,
    tone: '',
    sizeDial: 'sketch',
  });
  const saved = await saveModule({
    ...draft,
    status: 'generating',
    spine: moduleSpineSchema.parse({
      premise: 'The premise promises a drowned [[Vault Door]].',
      themes: [],
      partPlan: [{ title: 'The Mill', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        markdown: '',
        status: 'generating',
        errorMessage: '',
        edited: false,
      }),
    ],
  });
  return { campaignId: campaign.id, moduleId: saved.id };
}

beforeEach(async () => {
  useThemeStore.setState({ theme: DEFAULT_THEME });
  await clearDatabase();
  await seedBuiltInPersonas();
  await seedSettledOnboarding();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('app shell: start-time reconciliation is a mount effect, never a render', () => {
  it('does not fail a live run when the shell re-renders', async () => {
    const user = userEvent.setup();
    renderAppAt(ROUTES.campaignPicker);
    // The mount reconcile has run (and found nothing): from here on, a run that
    // starts in this page is LIVE work, not a leftover from a previous page.
    await screen.findByRole('link', { name: 'Campaigner' });
    const runId = await actDrained(() => seedRunningRun());

    // Two unrelated re-renders of the shell (the theme toggle is a store write,
    // which is all any of them are).
    await user.click(await screen.findByRole('button', { name: 'Switch to light theme' }));
    await user.click(await screen.findByRole('button', { name: 'Switch to dark theme' }));
    await flushAsyncUpdates();

    expect(useThemeStore.getState().theme).toBe('dark');
    // The live run is untouched: only APP START may reconcile.
    const live = await actDrained(() => getRun(runId));
    expect(live?.status).toBe('running');
    expect(live?.errorMessage).toBe('');
  }, 20_000);

  it("still fails a run a previous page left 'running' — loudly, at start", async () => {
    const runId = await seedRunningRun();

    renderAppAt(ROUTES.campaignPicker);

    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('failed');
      expect(run?.errorMessage).toBe('Interrupted by reload');
      expect(run?.failureKind).toBe('cancelled');
    });
    await flushAsyncUpdates();
  }, 20_000);

  it("reconciles a module a reloaded tab left 'generating', and the reader's recovery control works", async () => {
    const { campaignId, moduleId } = await seedInterruptedModule();

    renderAppAt(modulePath(campaignId, moduleId));

    // The owner-visible outcome, on the reader he was staring at: a named
    // failure — never a spinner that stays forever.
    const banner = await screen.findByTestId('module-failed-banner', {}, { timeout: 10_000 });
    expect(banner).toHaveTextContent('Module generation encountered an error.');
    expect(banner).toHaveTextContent(/the page that was writing it is gone/u);
    // …and the recovery the message names is on screen and ENABLED (before the
    // fix every one of these was gated behind `!busy`) — as is the Stop control,
    // which now has nothing left to stop and is gone rather than a no-op.
    expect(await screen.findByTestId('resume-module-generation')).toBeEnabled();
    expect(screen.queryByTestId('module-stop')).not.toBeInTheDocument();
    expect(screen.getByTestId('generate-missing')).toBeEnabled();

    const row = await actDrained(() => getModule(moduleId));
    expect(row?.status).toBe('failed');
    expect(row?.errorMessage).toBe(INTERRUPTED_MODULE_GEN_MESSAGE);
    // The unfinished part slot rewound, which is what makes the resume path
    // write exactly the parts that were lost.
    expect(row?.parts[0]?.status).toBe('pending');
  }, 20_000);

  it('leaves a module alone when a live pass owns it (the same guard, through the UI)', async () => {
    const { campaignId, moduleId } = await seedInterruptedModule();
    // A live forge in THIS page is the page-local registry the guard reads; the
    // engine itself is exercised in tests/llm/moduleGenReconcile.test.ts.
    const moduleGen = await import('@/llm/moduleGen');
    const spy = vi.spyOn(moduleGen, 'hasLiveModuleGen').mockReturnValue(true);

    renderAppAt(modulePath(campaignId, moduleId));
    await screen.findByTestId('module-failed-banner', {}, { timeout: 10_000 }).catch(() => undefined);

    expect((await actDrained(() => getModule(moduleId)))?.status).toBe('generating');
    expect(spy).toHaveBeenCalled();
    await flushAsyncUpdates();
  }, 20_000);
});
