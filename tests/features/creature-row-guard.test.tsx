import 'fake-indexeddb/auto';

import { fireEvent, render, screen, within, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, getArtifact, listRevisions, updateArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createImage } from '@/db/imageRepo';
import { getOrCreateMobArtifact, rosterArtifactIds } from '@/db/mobArtifacts';
import { saveModule } from '@/db/moduleRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { createModule, type Artifact, type Campaign } from '@/domain';
import type * as RunEngineModule from '@/llm/runEngine';
import type * as ToastModule from '@/lib/toast';
import { ArtifactEditor } from '@/features/campaign/components/artifact-editor';
import { useContentRefillRequest } from '@/features/campaign/contentRefillRequest';
import {
  clearCreatureRowAuthoredContent,
  creatureRowAuthoredFields,
  isPollutedCreatureRow,
} from '@/features/campaign/creature-row-guard';
import { alignEntityName, runEntityBatch } from '@/features/modules/entity-batch';
import { useProgressStore } from '@/lib/progress';
import { clearDatabase } from '../db/helpers';
import { actDrained, flushAsyncUpdates } from '../helpers/flush';

/**
 * Bestiary-creature rows are not authoring slots (owner-reported data
 * corruption: the artifact editor's "Generate with AI" handed a rulebook
 * creature's shared `npc` row — name + `monsterChunkId` marker + portrait — to
 * a smith persona, and the prose it wrote described a DIFFERENT NPC, saved
 * onto the row every encounter citing that creature reads).
 *
 * Three refusals are pinned here, each revert-proof (the pin fails without the
 * guard):
 * 1. the editor's AI action is DISABLED on a creature row, whose reason names
 *    the remedy, and an attempted click writes NOTHING (the row is pinned
 *    byte-identical and no refill request is even created);
 * 2. the entity paths refuse to rename/target a creature row LOUDLY — the
 *    batch records a per-entity failure with the reason and never renames,
 *    re-scopes or tags the shared row;
 * 3. authored text already sitting on a creature row is DETECTED and only the
 *    explicit repair clears it — name, aliases, marker, images, stat source and
 *    every other field pinned unchanged, and a legitimate NPC is never touched.
 */

const engineMock = vi.hoisted(() => ({
  startRun: vi.fn(),
  waitForRunStatus: vi.fn(),
}));

// The entity batch's run is stubbed (this suite pins the guard, not the LLM
// pipeline); everything else on the engine singleton stays real — the clone
// keeps the real prototype, so imported feature modules keep working.
vi.mock('@/llm/runEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof RunEngineModule>();
  const prototype = Object.getPrototypeOf(actual.runEngine) as object | null;
  const engine = Object.create(prototype) as typeof actual.runEngine;
  Object.assign(engine, actual.runEngine, { startRun: engineMock.startRun });
  return { ...actual, runEngine: engine, waitForRunStatus: engineMock.waitForRunStatus };
});

vi.mock('@/lib/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof ToastModule>();
  return { ...actual, toastError: vi.fn(), toastSuccess: vi.fn() };
});

const { toastError, toastSuccess } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);
const toastSuccessMock = vi.mocked(toastSuccess);

const CHUNK_ID = '11111111-1111-4111-8111-111111111111';
const CHUNK_ID_2 = '22222222-2222-4222-8222-222222222222';

function blobOf(text: string): Blob {
  return new Blob([text], { type: 'image/png' });
}

/**
 * Mounts the editor the way the workspace does (its header carries router
 * links) inside act and drains — Base UI's ScrollArea schedules a measurement
 * update right after mount, and an undrained one is an act() leak the console
 * guard (docs/08) fails the test on.
 */
async function renderEditor(
  artifact: Artifact,
  campaignId: string,
  campaignArtifacts: readonly Artifact[],
): Promise<RenderResult> {
  return actDrained(() =>
    Promise.resolve(
      render(
        <MemoryRouter>
          <ArtifactEditor
            artifact={artifact}
            campaignId={campaignId}
            campaignArtifacts={campaignArtifacts}
            campaignSystem="dnd5e"
          />
        </MemoryRouter>,
      ),
    ),
  );
}

/** A row read while a tree is mounted (raw awaits there hand the leaked-act
 * window to Dexie's timed queue — docs/08 §Console guard). */
async function readRow(id: string): Promise<string> {
  const row = await actDrained(() => getArtifact(id));
  return JSON.stringify(row);
}

/**
 * Settles a render-based test inside act before it ends: one REAL frame (Base
 * UI's ScrollArea measures layout/`getAnimations()` on a requestAnimationFrame
 * after a mount) plus the standard drain. A bare 0 ms drain can finish before
 * that frame fires, and the update then lands with the act environment already
 * torn down ("The current testing environment is not configured to support
 * act") — which the console guard fails.
 */
async function settleFrame(): Promise<void> {
  await actDrained(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  });
}

async function seedCampaign(): Promise<Campaign> {
  return createCampaign({ name: 'Emberfall', system: 'dnd5e' });
}

/** The creature row exactly as a rulebook citation creates it: name + marker,
 * empty content, no scope beyond the campaign. */
async function seedCreature(
  campaign: Campaign,
  chunkId = CHUNK_ID,
  name = 'Zombie',
): Promise<Artifact> {
  const id = await getOrCreateMobArtifact(campaign.id, chunkId, name);
  const row = await getArtifact(id);
  if (row === undefined) throw new Error('the seeded creature row is missing');
  return row;
}

/**
 * The unguarded write this whole slice exists to stop (runEngine's refill
 * branch: summary + body + the draft's appearance/personality, the model's
 * invented name kept as an alias). Written directly here so the polluted state
 * is reproducible without an LLM.
 */
async function polluteCreatureRow(row: Artifact): Promise<Artifact> {
  if (row.kind !== 'npc') throw new Error('fixture row is not an npc');
  const next = await updateArtifact(
    row.id,
    {
      summary: 'Pell the Merchant keeps the western road.',
      body: '# Pell\nHe trades in stolen relics.',
      aliases: ['Pell the Merchant'],
      data: {
        ...row.data,
        appearance: 'A tall human in a patched coat.',
        personality: 'Smug, endlessly bargaining.',
      },
    },
    { source: 'persona' },
  );
  if (next.campaignId === null) throw new Error('the polluted row lost its campaign scope');
  return next;
}

beforeEach(async () => {
  await clearDatabase();
  engineMock.startRun.mockReset();
  engineMock.waitForRunStatus.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  useContentRefillRequest.getState().clear();
  useProgressStore.getState().reset();
});

describe('the editor refuses to AI-generate onto a bestiary creature row', () => {
  it('disables the AI action with the reason and the remedy, and writes nothing', async () => {
    const campaign = await seedCampaign();
    const creature = await seedCreature(campaign);
    await renderEditor(creature, campaign.id, [creature]);

    const button = screen.getByTestId('generate-artifact-content');
    // Unavailable, and honestly so: the reason rides the disabled control's
    // title (never a silently dead control) and the section's own copy.
    expect(button).toBeDisabled();
    const title = button.getAttribute('title') ?? '';
    expect(title).toContain('bestiary creature');
    expect(title).toContain('every encounter that uses it');
    expect(title).toContain('rulebook stat block');
    expect(title).toContain('portrait');
    // The copy names the REMEDY: the module's own NPC comes from the entity
    // panel's generation, not from this shared creature row.
    expect(screen.getByTestId('creature-row-ai-refusal')).toHaveTextContent(
      "Generate the module's own NPC of this name from the entity panel",
    );
    expect(screen.queryByTestId('creature-row-pollution-report')).toBeNull();

    // The attempt writes NOTHING: no refill hand-off (which is what produced
    // the wrong text) and the row byte-identical, revision included.
    const before = await readRow(creature.id);
    fireEvent.click(button);
    await flushAsyncUpdates();
    expect(useContentRefillRequest.getState().artifactId).toBeNull();
    expect(useContentRefillRequest.getState().kind).toBeNull();
    expect(await readRow(creature.id)).toBe(before);
    expect(toastErrorMock).not.toHaveBeenCalled();
    await settleFrame();
  }, 20_000);

  it('still regenerates a legitimate campaign NPC and a module-owned NPC', async () => {
    const user = userEvent.setup();
    const campaign = await seedCampaign();
    const authored = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Grix',
      summary: 'Goblin alchemist boss.',
      body: '# Grix\nShe brews.',
      data: { appearance: 'Soot-stained.', personality: 'Manic.', statBlock: null },
    });
    const module = createModule({
      campaignId: campaign.id,
      title: 'Ember Crypt',
      concept: 'A drowned crypt.',
      levelMin: 1,
      levelMax: 4,
      sizeDial: 'sketch',
    });
    await saveModule(module);
    const moduleOwned = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'npc',
      name: 'Harbor Warden',
      data: { appearance: '', personality: '', statBlock: null },
    });

    const first = await renderEditor(authored, campaign.id, [authored]);
    const button = screen.getByTestId('generate-artifact-content');
    expect(button).toBeEnabled();
    expect(screen.queryByTestId('creature-row-ai-refusal')).toBeNull();
    await user.click(button);
    expect(button).toHaveTextContent('Overwrite content — confirm?');
    await user.click(button);
    expect(useContentRefillRequest.getState().artifactId).toBe(authored.id);
    expect(useContentRefillRequest.getState().regenerate).toBe(true);
    useContentRefillRequest.getState().clear();
    first.unmount();
    await flushAsyncUpdates();

    await renderEditor(moduleOwned, campaign.id, [moduleOwned]);
    const fresh = screen.getByTestId('generate-artifact-content');
    expect(fresh).toBeEnabled();
    expect(fresh).toHaveTextContent('Generate with AI');
    await user.click(fresh);
    expect(useContentRefillRequest.getState().artifactId).toBe(moduleOwned.id);
    expect(useContentRefillRequest.getState().regenerate).toBe(false);
    useContentRefillRequest.getState().clear();
    await settleFrame();
  }, 20_000);

  it('leaves an encounter row that cites the creature alone (its own surface still works)', async () => {
    const campaign = await seedCampaign();
    const creature = await seedCreature(campaign);
    const encounter = await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Old Undercroft',
      data: {
        difficulty: 'old',
        levelHint: '4',
        monsters: [
          {
            name: 'Zombie',
            count: 2,
            notes: '',
            treasure: '',
            source: { type: 'npc-ref', artifactId: creature.id },
          },
        ],
        terrain: '',
        tactics: '',
        treasure: '',
        mapImageId: null,
        preset: 'standard',
        locationKind: 'dungeon',
        siteShape: 'single',
        budgetAdvisory: '',
        layout: null,
      },
    });
    // The roster entry still resolves to the creature row (battle seeding and
    // the portrait actions read it); nothing in this slice changes that.
    if (encounter.kind !== 'encounter') throw new Error('fixture row is not an encounter');
    expect(rosterArtifactIds(encounter.data.monsters)).toEqual([creature.id]);

    await renderEditor(encounter, campaign.id, [encounter, creature]);
    const section = screen.getByTestId('encounter-ai-section');
    expect(within(section).getByTestId('encounter-regenerate-everything')).toBeEnabled();
    // The creature-row refusal belongs to the smith section, not to encounters.
    expect(screen.queryByTestId('creature-row-ai-refusal')).toBeNull();
    expect(screen.queryByTestId('generate-artifact-content')).toBeNull();
    await settleFrame();
  }, 20_000);
});

describe('the entity paths refuse a creature-row destination', () => {
  it('fails alignEntityName loudly instead of renaming the shared row', async () => {
    const campaign = await seedCampaign();
    const creature = await seedCreature(campaign);
    const before = await getArtifact(creature.id);

    await expect(alignEntityName(creature.id, 'Zombie Lord')).rejects.toThrow(/bestiary creature/);

    const after = await getArtifact(creature.id);
    expect(after?.name).toBe('Zombie');
    expect(after?.aliases).toEqual(before?.aliases);
    expect(after?.currentRevision).toBe(before?.currentRevision);
    expect(await listRevisions(creature.id)).toHaveLength(1);
  }, 20_000);

  it('still aligns a legitimate NPC name (rename + invented name as an alias)', async () => {
    const campaign = await seedCampaign();
    const npc = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Kael Ashbound, Warden of the Gate',
      data: { appearance: '', personality: '', statBlock: null },
    });

    await alignEntityName(npc.id, 'Kael');

    const after = await getArtifact(npc.id);
    expect(after?.name).toBe('Kael');
    expect(after?.aliases).toContain('Kael Ashbound, Warden of the Gate');
  }, 20_000);

  it('records a batch whose run landed on a creature row as a loud failure, writing nothing', async () => {
    const campaign = await seedCampaign();
    const creature = await seedCreature(campaign);
    const module = createModule({
      campaignId: campaign.id,
      title: 'Ember Crypt',
      concept: 'A drowned crypt.',
      levelMin: 1,
      levelMax: 4,
      sizeDial: 'sketch',
    });
    await saveModule(module);
    await seedBuiltInPersonas();
    engineMock.startRun.mockResolvedValue('run-on-creature');
    engineMock.waitForRunStatus.mockResolvedValue({
      status: 'completed',
      resultArtifactId: creature.id,
      errorMessage: '',
    });

    const before = await getArtifact(creature.id);
    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: 'Zombie Lord' }],
    });

    // LOUD (a per-entity failure with the reason + its toast), never a silent
    // rename/re-scope: the row keeps its name, its scope and its revision.
    expect(result.generated).toEqual([]);
    expect(result.produced).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.name).toBe('Zombie Lord');
    expect(result.failed[0]?.message ?? '').toContain('bestiary creature');
    expect(result.failed[0]?.message ?? '').toContain('Zombie');
    expect(toastErrorMock).toHaveBeenCalledTimes(1);

    const after = await getArtifact(creature.id);
    expect(after?.name).toBe('Zombie');
    expect(after?.moduleId).toBeNull();
    expect(after?.tags).toEqual(before?.tags);
    expect(after?.aliases).toEqual(before?.aliases);
    expect(after?.currentRevision).toBe(before?.currentRevision);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  }, 20_000);
});

describe('authored text already on a creature row: detected, reported, and only that cleared', () => {
  it('flags the pollution and clears ONLY the authored text, every other field pinned', async () => {
    const campaign = await seedCampaign();
    const creature = await seedCreature(campaign);
    const portrait = await createImage({
      campaignId: campaign.id,
      blob: blobOf('portrait bytes'),
      mimeType: 'image/png',
      width: 64,
      height: 64,
      source: 'generated',
    });
    await updateArtifact(creature.id, {
      imageIds: [portrait.id],
      coverImageId: portrait.id,
      tags: ['undead'],
    });
    const polluted = await polluteCreatureRow(creature);
    expect(isPollutedCreatureRow(polluted)).toBe(true);
    expect(creatureRowAuthoredFields(polluted)).toEqual([
      'summary',
      'body',
      'appearance',
      'personality',
    ]);

    const result = await clearCreatureRowAuthoredContent(creature.id);

    expect(result.cleared).toEqual(['summary', 'body', 'appearance', 'personality']);
    const after = await getArtifact(creature.id);
    if (after?.kind !== 'npc') throw new Error('the creature row changed kind');
    // Cleared: exactly the authored text, back to the row's birth state.
    expect(after.summary).toBe('');
    expect(after.body).toBe('');
    expect(after.data.appearance).toBe('');
    expect(after.data.personality).toBe('');
    expect(isPollutedCreatureRow(after)).toBe(false);
    // Untouched: the creature's identity and everything the row is FOR.
    expect(after.name).toBe('Zombie');
    expect(after.aliases).toEqual(['Pell the Merchant']);
    expect(after.data.monsterChunkId).toBe(CHUNK_ID);
    expect(after.data.statBlock).toBeNull();
    expect(after.coverImageId).toBe(portrait.id);
    expect(after.imageIds).toEqual([portrait.id]);
    expect(after.tags).toEqual(['undead']);
    expect(after.links).toEqual(polluted.links);
    expect(after.campaignId).toBe(campaign.id);
    expect(after.moduleId).toBeNull();
    expect(after.currentRevision).toBe(polluted.currentRevision + 1);
  }, 20_000);

  it('never flags or touches a legitimate NPC (no marker, authored or module-owned)', async () => {
    const campaign = await seedCampaign();
    const npc = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Grix',
      summary: 'Goblin alchemist boss.',
      body: '# Grix\nShe brews.',
      data: { appearance: 'Soot-stained.', personality: 'Manic.', statBlock: null },
    });

    expect(isPollutedCreatureRow(npc)).toBe(false);
    expect(creatureRowAuthoredFields(npc)).toEqual([]);
    const before = JSON.stringify(await getArtifact(npc.id));
    await expect(clearCreatureRowAuthoredContent(npc.id)).rejects.toThrow(
      /not a bestiary creature/,
    );
    expect(JSON.stringify(await getArtifact(npc.id))).toBe(before);
    expect(await listRevisions(npc.id)).toHaveLength(1);
  }, 20_000);

  it('is idempotent on a clean creature row (honest zero, no write)', async () => {
    const campaign = await seedCampaign();
    const creature = await seedCreature(campaign, CHUNK_ID_2, 'Ghoul');
    const before = JSON.stringify(await getArtifact(creature.id));
    const result = await clearCreatureRowAuthoredContent(creature.id);
    expect(result.cleared).toEqual([]);
    expect(JSON.stringify(await getArtifact(creature.id))).toBe(before);
  }, 20_000);

  it('reports the pollution in the editor and repairs it through the explicit two-step action', async () => {
    const user = userEvent.setup();
    const campaign = await seedCampaign();
    const creature = await seedCreature(campaign);
    const polluted = await polluteCreatureRow(creature);
    await renderEditor(polluted, campaign.id, [polluted]);

    // Loud report: which fields, why it matters, and what clearing keeps.
    const report = screen.getByTestId('creature-row-pollution-report');
    expect(report).toHaveTextContent('summary, body, appearance and personality');
    expect(report).toHaveTextContent('every encounter citing «Zombie» reads that text');
    expect(report).toHaveTextContent(
      'the rulebook stat source, the portrait and every other field stay',
    );
    // The AI action stays unavailable even on a polluted row.
    expect(screen.getByTestId('generate-artifact-content')).toBeDisabled();

    const clear = screen.getByTestId('clear-creature-row-content');
    // Bare (never inside a spanning act): userEvent wraps its own dispatch in
    // act, and a NESTED act resets the act environment on exit, which is what
    // makes an async handler's continuation land outside act. Drain AFTER it.
    await user.click(clear);
    await flushAsyncUpdates();
    expect(clear).toHaveTextContent('Clear the invented text — confirm?');
    // Arming writes nothing.
    const armed = await actDrained(() => getArtifact(creature.id));
    expect(armed?.summary).toBe('Pell the Merchant keeps the western road.');
    expect(armed?.currentRevision).toBe(polluted.currentRevision);

    // Confirming runs an ASYNC repair. `user.click` resolves with the event
    // dispatch, never with the handler's promise (`onClick={() => void
    // repair()}` is fire-and-forget), so the WHOLE cascade — the row write, the
    // handler's own state, the parent's adopt, and the live-query re-fire the
    // write triggers on Dexie's timed queue — is settled inside ONE act window
    // with a real-time drain. Drained only, the tail lands after act exits
    // ("not configured to support act"), which the console guard fails.
    let repaired: Artifact | undefined;
    await user.click(clear);
    await actDrained(async () => {
      // The repair is fire-and-forget from the click's own act, so its
      // continuation is waited for HERE, inside ONE act window: the observable
      // outcome (the toast), the handler's own state, the parent's adopt and
      // the live-query re-fire the write triggers on Dexie's timed queue.
      await vi.waitFor(() => {
        expect(toastSuccessMock).toHaveBeenCalledTimes(1);
      });
      for (let round = 0; round < 30; round += 1) {
        await new Promise((resolve) => {
          setTimeout(resolve, 5);
        });
      }
      repaired = await getArtifact(creature.id);
    });
    expect(repaired?.summary).toBe('');
    expect(repaired?.body).toBe('');
    expect(repaired?.name).toBe('Zombie');
    // Never silent (AGENTS rule 2): the outcome is named, with what survived.
    const message = toastSuccessMock.mock.calls[0]?.[0] ?? '';
    expect(message).toContain('Cleared the authored summary, body, appearance and personality');
    expect(message).toContain('«Zombie»');
    expect(message).toContain('revision history');
    // The AI action is still refused after the repair (the row is still the
    // creature), and the editor kept the repaired row as its saved state — the
    // lingering draft can never autosave the cleared text back.
    expect(screen.getByTestId('generate-artifact-content')).toBeDisabled();
    await settleFrame();
  }, 20_000);
});
