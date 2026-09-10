import 'fake-indexeddb/auto';

import { fireEvent, render, screen, waitFor, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, getArtifact, listRevisions, updateArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createImage } from '@/db/imageRepo';
import { getOrCreateMobArtifact, spawnMobArtifactIntoModule } from '@/db/mobArtifacts';
import { saveModule } from '@/db/moduleRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { createModule, moduleTagFor, type Artifact, type Campaign } from '@/domain';
import type * as RunEngineModule from '@/llm/runEngine';
import type * as ToastModule from '@/lib/toast';
import { ArtifactEditor } from '@/features/campaign/components/artifact-editor';
import {
  clearCreatureRowAuthoredContent,
  creatureRowAuthoredWriteFields,
  CreatureRowAuthoredWriteError,
  isPollutedCreatureRow,
  updateArtifactRefusingCreatureRowAuthored,
} from '@/features/campaign/creature-row-guard';
import { useProgressStore } from '@/lib/progress';
import { clearDatabase } from '../db/helpers';
import { actDrained, flushAsyncUpdates } from '../helpers/flush';

/**
 * THE HAND DOOR of the bestiary-creature arc (docs/17 rows 81/82/84 shut the
 * AI action, the entity paths and the refill WRITE): the artifact editor's own
 * autosave and form writes could still persist authored text onto a creature
 * row — a real `npc` artifact carrying `data.monsterChunkId`, ONE campaign row
 * per cited rulebook chunk, shared by every encounter that cites the creature.
 *
 * Four things are pinned here, each revert-proof:
 * 1. the authored inputs (name, aliases, summary, body, appearance,
 *    personality) are READ-ONLY on such a row, with the reason in place — and
 *    fully editable on an ordinary NPC (green both ways);
 * 2. a programmatic authored edit that reaches the draft through the autosave
 *    funnel is refused LOUDLY, the row is byte-identical (field-by-field plus
 *    the revision list) and the draft is put back on the row's real values;
 * 3. the write boundary itself refuses every authored change — and passes
 *    images, cover and gallery through, so the portrait stays editable and a
 *    cover change made in the editor's own Images section still saves;
 * 4. the pollution REPAIR still works through that same boundary: reducing the
 *    four authored fields to blank is the row's birth state (allowed), while
 *    writing content into them is refused — no repair-only bypass flag.
 *
 * The constructive exit is pinned too: with module context the editor runs the
 * existing per-entity generation chain and opens the module's own NPC of that
 * name; with none it names the route and pretends nothing.
 */

const engineMock = vi.hoisted(() => ({
  startRun: vi.fn(),
  waitForRunStatus: vi.fn(),
}));

// The entity batch's run is stubbed (this suite pins the guard and the wiring,
// not the LLM pipeline); everything else on the engine singleton stays real —
// the clone keeps the real prototype, so imported feature modules keep working.
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

function blobOf(text: string): Blob {
  return new Blob([text], { type: 'image/png' });
}

/**
 * Mounts the editor the way the workspace does (its header carries router
 * links) inside act and drains — Base UI's ScrollArea schedules a measurement
 * update right after mount, and an undrained one is an act() leak the console
 * guard (docs/08) fails the test on. The location probe is how the
 * constructive action's navigation is pinned.
 */
async function renderEditor(
  artifact: Artifact,
  campaignId: string,
  campaignArtifacts: readonly Artifact[],
): Promise<RenderResult> {
  return actDrained(() =>
    Promise.resolve(
      render(
        <MemoryRouter initialEntries={[`/c/${campaignId}/a/${artifact.id}`]}>
          <LocationProbe />
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

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}</span>;
}

/** A row read while a tree is mounted (raw awaits there hand the leaked-act
 * window to Dexie's timed queue — docs/08 §Console guard). */
async function readRow(id: string): Promise<string> {
  const row = await actDrained(() => getArtifact(id));
  return JSON.stringify(row);
}

/** Settles a render-based test inside act before it ends: one REAL frame (Base
 * UI's ScrollArea measures layout/`getAnimations()` on a requestAnimationFrame
 * after a mount) plus the standard drain. */
async function settleFrame(): Promise<void> {
  await actDrained(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  });
}

/** The autosave window (800 ms debounce) plus slack, wrapped in act. */
async function sleep(ms: number): Promise<void> {
  await actDrained(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  });
}

async function seedCampaign(): Promise<Campaign> {
  return createCampaign({ name: 'Emberfall', system: 'dnd5e' });
}

/** The creature row exactly as a rulebook citation creates it: name + marker,
 * empty content, no scope beyond the campaign. */
async function seedCreature(campaign: Campaign, name = 'Zombie'): Promise<Artifact> {
  const id = await getOrCreateMobArtifact(campaign.id, CHUNK_ID, name);
  const row = await getArtifact(id);
  if (row === undefined) throw new Error('the seeded creature row is missing');
  return row;
}

async function seedModule(campaign: Campaign, title = 'Ember Crypt') {
  const module = createModule({
    campaignId: campaign.id,
    title,
    concept: 'A drowned crypt.',
    levelMin: 1,
    levelMax: 4,
    sizeDial: 'sketch',
  });
  await saveModule(module);
  return module;
}

/** The unguarded write the AI half of this arc exists to stop, reproduced by
 * hand so the polluted state exists without an LLM. */
async function polluteCreatureRow(row: Artifact): Promise<Artifact> {
  if (row.kind !== 'npc') throw new Error('fixture row is not an npc');
  const next = await updateArtifact(row.id, {
    summary: 'Pell the Merchant keeps the western road.',
    body: '# Pell\nHe trades in stolen relics.',
    aliases: ['Pell the Merchant'],
    data: {
      ...row.data,
      appearance: 'A tall human in a patched coat.',
      personality: 'Smug, endlessly bargaining.',
    },
  });
  if (next.campaignId === null) throw new Error('the polluted row lost its campaign scope');
  return next;
}

beforeEach(async () => {
  await clearDatabase();
  engineMock.startRun.mockReset();
  engineMock.waitForRunStatus.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  useProgressStore.getState().reset();
});

describe('the editor refuses HAND-authored text on a bestiary creature row', () => {
  it('refuses an authored edit that reaches the autosave funnel: loud, byte-identical, no revision', async () => {
    const campaign = await seedCampaign();
    const creature = await seedCreature(campaign);
    await renderEditor(creature, campaign.id, [creature]);

    const before = await readRow(creature.id);
    const revisionsBefore = (await actDrained(() => listRevisions(creature.id))).length;
    expect(revisionsBefore).toBe(1);

    // The read-only attribute stops a USER; this drives the funnel the way any
    // other programmatic route would, so the refusal is pinned at the WRITE and
    // not merely at the input.
    const summary = screen.getByTestId('artifact-summary');
    fireEvent.change(summary, { target: { value: 'Pell the Merchant keeps the western road.' } });
    await sleep(1100);

    // LOUD: a visible error naming the row (AGENTS rules 1/2), never a silent
    // drop and never a "skipped" result a caller could ignore.
    expect(toastErrorMock).toHaveBeenCalled();
    const [title, error] = toastErrorMock.mock.calls[0] ?? [];
    expect(String(title)).toContain('Refused to save authored text');
    expect(String(title)).toContain('«Zombie»');
    expect(error).toBeInstanceOf(CreatureRowAuthoredWriteError);

    // BYTE-IDENTICAL, revision included — the refusal happens before any write.
    expect(await readRow(creature.id)).toBe(before);
    expect((await actDrained(() => listRevisions(creature.id))).length).toBe(revisionsBefore);

    // The draft was put back on the row's real values, so the surface cannot
    // keep showing an edit the row never accepted.
    expect(screen.getByTestId<HTMLInputElement>('artifact-summary').value).toBe('');
    await settleFrame();
  }, 20_000);

  it('refuses every authored field at the write boundary, before any revision is written', async () => {
    const campaign = await seedCampaign();
    const creature = await seedCreature(campaign);
    if (creature.kind !== 'npc') throw new Error('fixture row is not an npc');
    const before = await readRow(creature.id);

    const authoring = {
      name: 'Pell the Merchant',
      aliases: ['Pell'],
      summary: 'Pell the Merchant keeps the western road.',
      body: '# Pell',
      data: { ...creature.data, appearance: 'Tall.', personality: 'Smug.' },
    };
    // The change detector is the ONE rule: it sees all six authored fields.
    expect(creatureRowAuthoredWriteFields(creature, authoring)).toEqual([
      'name',
      'aliases',
      'summary',
      'body',
      'appearance',
      'personality',
    ]);

    const refusal = await actDrained(() =>
      updateArtifactRefusingCreatureRowAuthored(creature.id, authoring).then(
        () => null,
        (error: unknown) => error,
      ),
    );
    expect(refusal).toBeInstanceOf(CreatureRowAuthoredWriteError);
    if (!(refusal instanceof CreatureRowAuthoredWriteError)) throw new Error('unreachable');
    expect(refusal.fields).toEqual([
      'name',
      'aliases',
      'summary',
      'body',
      'appearance',
      'personality',
    ]);
    expect(refusal.message).toContain('bestiary creature');
    expect(refusal.message).toContain('name, aliases, summary, body, appearance and personality');
    // The refusal carries the untouched row so the caller needs no second read.
    expect(JSON.stringify(refusal.row)).toBe(before);

    expect(await readRow(creature.id)).toBe(before);
    expect((await actDrained(() => listRevisions(creature.id))).length).toBe(1);
  }, 20_000);

  it('leaves a legitimate NPC fully writable through the same boundary (non-regression)', async () => {
    const campaign = await seedCampaign();
    const npc = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Grix',
      data: { appearance: '', personality: '', statBlock: null },
    });
    if (npc.kind !== 'npc') throw new Error('fixture row is not an npc');

    const next = await actDrained(() =>
      updateArtifactRefusingCreatureRowAuthored(npc.id, {
        name: 'Grix the Brewer',
        summary: 'Goblin alchemist boss.',
        data: { ...npc.data, appearance: 'Soot-stained.' },
      }),
    );
    expect(next.name).toBe('Grix the Brewer');
    expect(next.summary).toBe('Goblin alchemist boss.');
    expect((await getArtifact(npc.id))?.currentRevision).toBe(2);
  }, 20_000);
});

describe('the authored inputs are read-only on a creature row', () => {
  it('renders name, aliases, summary, body and the npc fields read-only, with the reason in place', async () => {
    const campaign = await seedCampaign();
    const creature = await seedCreature(campaign);
    await renderEditor(creature, campaign.id, [creature]);

    const name = screen.getByTestId<HTMLInputElement>('artifact-name');
    const summary = screen.getByTestId<HTMLInputElement>('artifact-summary');
    const aliases = screen.getByTestId<HTMLInputElement>('alias-input');
    const body = screen.getByTestId<HTMLTextAreaElement>('artifact-body');
    const appearance = screen.getByTestId<HTMLTextAreaElement>('npc-appearance');
    const personality = screen.getByTestId<HTMLTextAreaElement>('npc-personality');

    for (const field of [name, summary, aliases, body, appearance, personality]) {
      expect(field.readOnly).toBe(true);
    }
    // The reason rides the field itself (never a silently dead control) and
    // names the remedy, from the ONE copy source.
    expect(name.getAttribute('title') ?? '').toContain('Read-only name');
    expect(name.getAttribute('title') ?? '').toContain('bestiary creature');
    expect(body.getAttribute('title') ?? '').toContain('Read-only body');
    expect(personality.getAttribute('title') ?? '').toContain('Read-only personality');

    // The reason is IN PLACE, and it says what is still possible.
    const notice = screen.getByTestId('creature-row-readonly-copy');
    expect(notice).toHaveTextContent('bestiary creature');
    expect(notice).toHaveTextContent('read-only here');
    expect(notice).toHaveTextContent('images stay editable');
    expect(notice).toHaveTextContent("Generate the module's own NPC of this name");

    // Behaviorally read-only: a real typing attempt changes nothing.
    const user = userEvent.setup();
    await actDrained(async () => {
      await user.type(name, 'Pell');
    });
    expect(name.value).toBe('Zombie');
    await settleFrame();
  }, 20_000);

  it('leaves an ordinary NPC editable, with no notice (green both ways)', async () => {
    const campaign = await seedCampaign();
    const npc = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Grix',
      data: { appearance: 'Soot-stained.', personality: 'Manic.', statBlock: null },
    });
    await renderEditor(npc, campaign.id, [npc]);

    for (const testId of [
      'artifact-name',
      'artifact-summary',
      'alias-input',
      'artifact-body',
      'npc-appearance',
      'npc-personality',
    ]) {
      const field = screen.getByTestId<HTMLInputElement | HTMLTextAreaElement>(testId);
      expect(field.readOnly).toBe(false);
    }
    expect(screen.queryByTestId('creature-row-authoring-notice')).toBeNull();
    expect(screen.queryByTestId('creature-row-create-own-npc')).toBeNull();

    const user = userEvent.setup();
    const name = screen.getByTestId<HTMLInputElement>('artifact-name');
    await actDrained(async () => {
      await user.clear(name);
      await user.type(name, 'Grix the Brewer');
    });
    expect(name.value).toBe('Grix the Brewer');
    await sleep(1100);
    expect((await getArtifact(npc.id))?.name).toBe('Grix the Brewer');
    await settleFrame();
  }, 20_000);
});

describe('images and the portrait stay editable on a creature row', () => {
  it('sets a gallery image as the cover through the editor, authored fields untouched', async () => {
    const campaign = await seedCampaign();
    const creature = await seedCreature(campaign);
    const first = await createImage({
      campaignId: campaign.id,
      blob: blobOf('first bytes'),
      mimeType: 'image/png',
      width: 64,
      height: 64,
      source: 'generated',
    });
    const second = await createImage({
      campaignId: campaign.id,
      blob: blobOf('second bytes'),
      mimeType: 'image/png',
      width: 128,
      height: 96,
      source: 'generated',
    });
    await actDrained(() =>
      updateArtifact(creature.id, { imageIds: [first.id, second.id], coverImageId: first.id }),
    );
    const row = await getArtifact(creature.id);
    if (row === undefined) throw new Error('the creature row is missing');
    const authoredBefore = JSON.stringify({
      name: row.name,
      aliases: row.aliases,
      summary: row.summary,
      body: row.body,
      data: row.data,
    });

    await renderEditor(row, campaign.id, [row]);
    expect(screen.getByTestId('images-section')).toBeInTheDocument();

    // The gallery thumbs come from a Dexie live query, so wait for its first
    // result before driving the lightbox.
    await waitFor(
      () => {
        expect(screen.getByLabelText('Open image 128×96')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    // The gallery thumb of the SECOND image (128×96), then its lightbox action.
    fireEvent.click(screen.getByLabelText('Open image 128×96'));
    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: 'Set as cover' })).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Set as cover' }));
    await waitFor(
      () => {
        expect(toastSuccessMock).toHaveBeenCalledWith('Cover image set');
      },
      { timeout: 3000 },
    );

    const after = await getArtifact(creature.id);
    // The cover change SAVED — this row's whole purpose is the shared portrait.
    expect(after?.coverImageId).toBe(second.id);
    expect(after?.imageIds).toEqual([first.id, second.id]);
    // And it touched no authored field.
    if (after === undefined) throw new Error('the creature row vanished');
    expect(
      JSON.stringify({
        name: after.name,
        aliases: after.aliases,
        summary: after.summary,
        body: after.body,
        data: after.data,
      }),
    ).toBe(authoredBefore);
    await settleFrame();
  }, 20_000);

  it('passes an image-only patch through the guarded boundary (what ImagesSection writes)', async () => {
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
    if (creature.kind !== 'npc') throw new Error('fixture row is not an npc');

    // Exactly the patch shapes the image section uses, plus the creature's own
    // structured stat source: none of it is authored text.
    expect(
      creatureRowAuthoredWriteFields(creature, {
        imageIds: [portrait.id],
        coverImageId: portrait.id,
        tags: ['undead'],
        data: { ...creature.data, statBlock: null },
      }),
    ).toEqual([]);

    const next = await actDrained(() =>
      updateArtifactRefusingCreatureRowAuthored(creature.id, {
        imageIds: [portrait.id],
        coverImageId: portrait.id,
      }),
    );
    expect(next.coverImageId).toBe(portrait.id);
    expect(next.imageIds).toEqual([portrait.id]);
  }, 20_000);
});

describe('the pollution repair still works through the same guarded boundary', () => {
  it('clears exactly the four authored fields, and nothing else', async () => {
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
    await actDrained(() =>
      updateArtifact(creature.id, {
        imageIds: [portrait.id],
        coverImageId: portrait.id,
        tags: ['undead'],
      }),
    );
    const fresh = await getArtifact(creature.id);
    if (fresh === undefined) throw new Error('the creature row is missing');
    const polluted = await polluteCreatureRow(fresh);
    expect(isPollutedCreatureRow(polluted)).toBe(true);

    // The repair's own patch is NOT an authored change: reducing the four
    // fields to blank is the row's birth state, so no bypass flag is needed.
    if (polluted.kind !== 'npc') throw new Error('fixture row is not an npc');
    expect(
      creatureRowAuthoredWriteFields(polluted, {
        summary: '',
        body: '',
        data: { ...polluted.data, appearance: '', personality: '' },
      }),
    ).toEqual([]);

    const result = await actDrained(() => clearCreatureRowAuthoredContent(creature.id));
    expect(result.cleared).toEqual(['summary', 'body', 'appearance', 'personality']);

    const after = await getArtifact(creature.id);
    if (after?.kind !== 'npc') throw new Error('the creature row changed kind');
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
    expect(after.moduleId).toBe(polluted.moduleId);
    expect(after.currentRevision).toBe(polluted.currentRevision + 1);
    // The cleared text stays restorable (the written revision carries it).
    expect((await actDrained(() => listRevisions(creature.id))).length).toBe(
      polluted.currentRevision + 1,
    );
  }, 20_000);
});

describe('the constructive exit', () => {
  it('creates this module’s own NPC of that name and opens it', async () => {
    const campaign = await seedCampaign();
    const module = await seedModule(campaign);
    const spawned = await spawnMobArtifactIntoModule(
      campaign.id,
      CHUNK_ID,
      'Zombie',
      module.id,
      module.title,
    );
    const creature = await getArtifact(spawned.artifactId);
    if (creature === undefined) throw new Error('the spawned creature row is missing');
    expect(creature.moduleId).toBe(module.id);
    const before = JSON.stringify(creature);

    // The model's invented row, standing in for what the run produces.
    const invented = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Zombie of the Drowned Crypt',
    });
    await seedBuiltInPersonas();
    engineMock.startRun.mockResolvedValue('run-own-npc');
    engineMock.waitForRunStatus.mockResolvedValue({
      status: 'completed',
      resultArtifactId: invented.id,
      errorMessage: '',
    });

    await renderEditor(creature, campaign.id, [creature]);
    const button = screen.getByTestId('creature-row-create-own-npc');
    expect(button).toHaveTextContent("Create this module's own NPC «Zombie»");

    fireEvent.click(button);
    await waitFor(
      () => {
        expect(screen.getByTestId('location').textContent).toBe(
          `/c/${campaign.id}/a/${invented.id}`,
        );
      },
      { timeout: 5000 },
    );

    // A module-owned `npc` of that EXACT name — the entity panel's generation
    // chain, not a new creation seam — and the editor opened it.
    const generated = await getArtifact(invented.id);
    expect(generated?.kind).toBe('npc');
    expect(generated?.name).toBe('Zombie');
    expect(generated?.moduleId).toBe(module.id);
    expect(generated?.tags).toContain(moduleTagFor(module.title));
    // NOT a bestiary creature row: the module's own authored NPC.
    expect(generated?.kind === 'npc' && generated.data.monsterChunkId !== undefined).toBe(false);
    expect(generated?.aliases).toContain('Zombie of the Drowned Crypt');
    expect(toastSuccessMock).toHaveBeenCalledWith(
      expect.stringContaining("Created this module's own NPC «Zombie»"),
    );

    // The shared creature row was not part of that write.
    expect(JSON.stringify(await getArtifact(creature.id))).toBe(before);
    await settleFrame();
  }, 20_000);

  it('says where such an NPC is created, and destroys nothing, with no module context', async () => {
    const campaign = await seedCampaign();
    const creature = await seedCreature(campaign);
    const before = await readRow(creature.id);

    await renderEditor(creature, campaign.id, [creature]);

    // No pretense: there is no action that claims to have generated anything.
    expect(screen.queryByTestId('creature-row-create-own-npc')).toBeNull();
    const honest = screen.getByTestId('creature-row-no-module-context');
    expect(honest).toHaveTextContent('belongs to no module');
    expect(honest).toHaveTextContent('Modules → the module → its entity panel');
    expect(honest).toHaveTextContent("creates the module's own NPC of this name");

    const openModules = screen.getByTestId('creature-row-open-modules');
    fireEvent.click(openModules);
    await flushAsyncUpdates();
    // A stated navigation, not an action that pretends to have done something.
    expect(screen.getByTestId('location').textContent).toBe(`/c/${campaign.id}/modules`);
    expect(engineMock.startRun).not.toHaveBeenCalled();
    expect(await readRow(creature.id)).toBe(before);
    await settleFrame();
  }, 20_000);
});
