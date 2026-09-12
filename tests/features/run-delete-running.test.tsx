import 'fake-indexeddb/auto';

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact } from '@/db/artifactRepo';
import { createCampaign, deleteCampaign, removeAllGeneratedContent } from '@/db/campaignRepo';
import { deleteCampaignWorkspace } from '@/db/maintenance';
import { createPersona } from '@/db/personaRepo';
import { createRun, deleteRun, getRun, listRunsByCampaign, updateRun } from '@/db/runRepo';
import { saveSettings } from '@/db/settingsRepo';
import { defaultSettings, newId, type Campaign, type Id, type Persona } from '@/domain';
import { PersonaPanel } from '@/features/campaign/components/persona-panel';
import { toastError } from '@/lib/toast';
import type * as toastModule from '@/lib/toast';
import { chat } from '@/llm/openrouter';
import { runEngine } from '@/llm/runEngine';
import { clearDatabase } from '../db/helpers';

/**
 * Deleting a RUN while it is still generating (docs/17 row 116).
 *
 * The owner's gesture is the Runs tab's delete button, and it does not ask the
 * run's status: the row goes while the step in flight is still holding an
 * `await` on a model reply. Without a stop, that step's next write meets a row
 * that no longer exists — `runRepo.updateRun` throws `NotFoundError`
 * (`src/db/runRepo.ts:50`), the pipeline's catch wraps it
 * (`src/llm/runEngine.ts:2215`) and `fail` toasts the owner's own delete back at
 * him as `Encounter step "brief" failed: PersonaRun not found: <uuid>`
 * (docs/17 rows 97/115, whose sightings are exactly this sentence).
 *
 * Every pin here FORCES the ordering instead of racing a clock (docs/08 §own
 * the promise, not the clock): the brief's reply is a promise the test resolves
 * BY HAND, so "the write lands after the delete" is a statement in the test body
 * and no timer, load or widened timeout decides it.
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
}));

vi.mock('@/lib/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof toastModule>();
  return { ...actual, toastError: vi.fn(), toastSuccess: vi.fn() };
});

const chatMock = vi.mocked(chat);
const toastErrorMock = vi.mocked(toastError);

const STATBLOCK = {
  system: 'dnd5e',
  level: '1',
  size: 'Medium',
  creatureType: 'humanoid',
  ac: 12,
  acNote: '',
  hp: 7,
  hpFormula: '2d6',
  speed: '30 ft.',
  abilities: { str: 10, dex: 12, con: 10, int: 10, wis: 10, cha: 10 },
  saves: '',
  skills: '',
  senses: '',
  languages: '',
  traits: [],
  actions: [],
  reactions: [],
  legendary: [],
  extras: {},
};

const BRIEF = {
  name: 'Ignored regeneration name',
  summary: 'Skeletons in the crypt.',
  body: '# Crypt\nRoom prose.',
  difficulty: 'medium',
  levelHint: '3',
  terrain: '',
  tactics: '',
  treasure: '',
  theme: 'crypt',
  styleNotes: '',
  negative: '',
  monsters: [{ name: 'Skeleton', count: 1, notes: '', statBlock: STATBLOCK }],
  rooms: [
    { name: 'Entry', description: '', size: 'medium', monsterIndexes: [0], adjacentRoomIndexes: [] },
  ],
  entryRoomIndex: 0,
};

/** The toasted messages, in order — asserted as text so a RED run prints the
 * sighting's own sentence instead of a bare "called 1 times". */
function toastedMessages(): string[] {
  return toastErrorMock.mock.calls.map((call) => call[0]);
}

/** Let every already-queued continuation run (no sleeps: `setTimeout(0)`
 * chains only yield the microtask/macrotask queue). */
async function drain(turns = 20): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => {
      window.setTimeout(resolve, 0);
    });
  }
}

/** A reply handed to the test: it can be released (the step's result lands) or
 * killed (the step dies on its own — the contrast pin's shape). */
interface ParkedReply {
  release: () => void;
  kill: (error: Error) => void;
}

async function seedPersona(): Promise<Persona> {
  return createPersona({
    slug: 'encounter-cartographer',
    name: 'Encounter Cartographer',
    description: '',
    systemPrompt: '',
    mode: 'encounter',
    producesKind: 'encounter',
    builtIn: true,
  });
}

/**
 * A campaign with ONE encounter and an encounter run that is genuinely LIVE and
 * parked inside its brief model call (the exact state a delete meets). The
 * filter is the campaign's own name, carried by the Cartographer prompt
 * (`Campaign: <name>`), so only THIS test's run can park here.
 */
async function seedParkedEncounterRun(campaignName: string): Promise<{
  campaign: Campaign;
  encounterId: Id;
  runId: Id;
  parked: ParkedReply;
}> {
  const campaign = await createCampaign({ name: campaignName, system: 'dnd5e' });
  const persona = await seedPersona();
  await saveSettings({ ...defaultSettings(), openRouterApiKey: 'key', imagesEnabled: true });
  const encounter = await createArtifact({
    campaignId: campaign.id,
    kind: 'encounter',
    name: 'Crypt of the delete',
    data: {
      difficulty: '',
      levelHint: '',
      monsters: [{ name: 'Skeleton', count: 1, notes: '', treasure: '', source: { type: 'none' } }],
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: null,
      layout: null,
      preset: 'standard',
      locationKind: 'other',
      siteShape: 'single',
      budgetAdvisory: '',
    },
  });
  let parked: ParkedReply | undefined;
  chatMock.mockImplementation((messages: unknown) => {
    const reply = { text: JSON.stringify(BRIEF), modelUsed: 'test-model', fallback: null };
    if (!JSON.stringify(messages).includes(campaign.name)) return Promise.resolve(reply);
    return new Promise((resolve, reject) => {
      parked = {
        release: () => {
          resolve(reply);
        },
        kill: (error: Error) => {
          reject(error);
        },
      };
    });
  });
  const runId = await runEngine.startRun({
    campaign,
    persona,
    autonomy: 'auto',
    brief: `Generate a room layout and battlemap for "${encounter.name}".`,
    pinnedChunkIds: [],
    targetArtifactId: encounter.id,
    encounterMapAspect: defaultSettings().encounterMapAspect,
    unattended: true,
  });
  await waitFor(
    () => {
      expect(parked).toBeDefined();
    },
    { timeout: 10000 },
  );
  const row = await getRun(runId);
  if (row?.status !== 'running') throw new Error(`the run is not generating: ${String(row?.status)}`);
  if (parked === undefined) throw new Error("this run's brief reply never parked on the test's hand");
  return { campaign, encounterId: encounter.id, runId, parked };
}

/** The Runs tab's own delete affordance, found the way the owner's eye finds it. */
async function deleteFromRunsTab(user: ReturnType<typeof userEvent.setup>, runId: Id): Promise<void> {
  const row = await getRun(runId);
  if (row === undefined) throw new Error('the run row never appeared');
  await user.click(await screen.findByRole('tab', { name: 'Runs' }));
  await user.click(
    await screen.findByRole('button', {
      name: `Delete run ${new Date(row.updatedAt).toLocaleString()}`,
    }),
  );
}

beforeEach(clearDatabase);

afterEach(() => {
  chatMock.mockReset();
  toastErrorMock.mockReset();
  vi.restoreAllMocks();
});

describe('deleting a running run', () => {
  it('stops the run BEFORE its row goes: no failure toast, no failed row, and the row is gone (forcing pin)', async () => {
    const user = userEvent.setup();
    const { campaign, runId, parked } = await seedParkedEncounterRun('Delete a running run');

    render(
      <MemoryRouter>
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );
    await deleteFromRunsTab(user, runId);

    // The gesture completes with the row actually gone.
    await waitFor(async () => {
      expect(await getRun(runId)).toBeUndefined();
    });

    // NOW the model answers — the step that was in flight when the owner
    // deleted the run. Its write must land on a run that was STOPPED, never on
    // a delete the engine reports as a failure.
    parked.release();
    await drain();

    expect(toastedMessages()).toEqual([]);
    expect(await getRun(runId)).toBeUndefined();
    expect((await listRunsByCampaign(campaign.id)).length).toBe(0);
  }, 30000);

  it('a campaign wipe stops the runs whose rows it is about to delete (clear workspace)', async () => {
    const { campaign, runId, parked } = await seedParkedEncounterRun('Wipe a running run');

    const cleared = await deleteCampaignWorkspace(campaign.id);
    expect(cleared.runs).toBe(1);

    parked.release();
    await drain();

    expect(toastedMessages()).toEqual([]);
    expect(await getRun(runId)).toBeUndefined();
  }, 30000);

  /**
   * Every path that deletes a campaign's run rows, driven the same way: a run
   * parked mid-brief, the wipe, then the reply. `deleteCampaign` and
   * `removeAllGeneratedContent` are the campaign-level equivalents of the Runs
   * tab's delete (docs/17 row 116) — the same vanished row, the same toast.
   */
  it.each([
    ['deleteCampaign', async (campaignId: string) => deleteCampaign(campaignId)],
    ['removeAllGeneratedContent', async (campaignId: string) => removeAllGeneratedContent(campaignId)],
    ['deleteCampaignWorkspace', async (campaignId: string) => deleteCampaignWorkspace(campaignId)],
  ] satisfies [string, (campaignId: string) => Promise<unknown>][])(
    '%s stops the runs whose rows it is about to delete',
    async (wipeName, wipe) => {
      const { campaign, runId, parked } = await seedParkedEncounterRun(`Wipe via ${wipeName}`);

      await wipe(campaign.id);
      parked.release();
      await drain();

      expect(toastedMessages()).toEqual([]);
      expect(await getRun(runId)).toBeUndefined();
      expect(await listRunsByCampaign(campaign.id)).toEqual([]);
    },
    30000,
  );

  it('a row that SAYS running — no pipeline in this page — is still stopped on its way out', async () => {
    // A stale row (a reload that has not reconciled yet) or one another tab is
    // driving: the engine's own registry cannot see it, so the ROW decides.
    const campaign = await createCampaign({ name: 'Stale running row', system: 'dnd5e' });
    const run = await createRun({
      campaignId: campaign.id,
      personaId: newId(),
      autonomy: 'manual',
      userBrief: 'a row nothing is driving',
      pinnedChunkIds: [],
    });
    await updateRun(run.id, { status: 'running' });
    const cancelSpy = vi.spyOn(runEngine, 'cancel');

    const stopped = await runEngine.stopRunsBeforeDelete([run.id]);
    expect(stopped).toEqual([run.id]);
    expect(cancelSpy).toHaveBeenCalledWith(run.id);
    expect((await getRun(run.id))?.status).toBe('cancelled');

    await deleteRun(run.id);
    expect(await getRun(run.id)).toBeUndefined();
    expect(toastedMessages()).toEqual([]);
  }, 30000);

  it('deleting a FINISHED run is unchanged: no stop, no failure toast, the row goes', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Delete a failed run', system: 'dnd5e' });
    await seedPersona();
    const run = await createRun({
      campaignId: campaign.id,
      personaId: newId(),
      autonomy: 'manual',
      userBrief: 'a run that already failed',
      pinnedChunkIds: [],
    });
    await updateRun(run.id, { status: 'failed', errorMessage: 'Provider died' });
    const cancelSpy = vi.spyOn(runEngine, 'cancel');

    render(
      <MemoryRouter>
        <PersonaPanel campaign={campaign} hasApiKey />
      </MemoryRouter>,
    );
    await deleteFromRunsTab(user, run.id);

    await waitFor(async () => {
      expect(await getRun(run.id)).toBeUndefined();
    });
    // A row that is not generating is not stopped: nothing about a finished run
    // is rewritten on its way out.
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(toastedMessages()).toEqual([]);
  }, 30000);

  it('a step that dies on its own — no stop and no delete in play — STILL toasts and STILL writes its failed row (contrast pin)', async () => {
    const { campaign, runId, parked } = await seedParkedEncounterRun('Genuine failure, nothing deleted');

    // Nobody stopped anything and nobody deleted anything: the step's own model
    // call dies. This is the guard against curing the delete seam by making
    // `fail` quieter (AGENTS rule 1) — and it must stay GREEN through the fix.
    parked.kill(new Error('provider died on its own'));

    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('failed');
    });
    expect(toastedMessages().length).toBe(1);
    expect(toastedMessages()[0]).toContain('provider died on its own');
    const failed = await getRun(runId);
    expect(failed?.status).toBe('failed');
    expect(failed?.errorMessage).toContain('provider died on its own');
    expect((await listRunsByCampaign(campaign.id)).length).toBe(1);
  }, 30000);
});
