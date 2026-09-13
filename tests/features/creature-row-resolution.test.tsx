import 'fake-indexeddb/auto';

import type { JSX } from 'react';
import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { sha256Hex } from '@/lib/hash';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { createRulebook } from '@/db/rulebookRepo';
import { publishLibraryCreaturePool, resolveCreatureCitation } from '@/db/creatureRepo';
import { saveModule } from '@/db/moduleRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import {
  createModule,
  moduleSchema,
  ruleChunkSchema,
  statBlockSchema,
  stampNewEntity,
  type AnyArtifact,
  type Artifact,
  type Campaign,
  type Id,
  type Module,
} from '@/domain';
import { WikiMarkdown } from '@/features/campaign/components/wiki-markdown';
import { EntityPanel } from '@/features/modules/entity-panel';
import { batchTargets, runModulePostGeneration } from '@/features/modules/post-generation';
import { useEntityImageQueue } from '@/features/modules/entity-image-queue';
import { useProgressStore } from '@/lib/progress';
import { resolveWikiLink } from '@/lib/wikilinks';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * A bestiary creature row is not a detailed entity (owner-reported, verbatim:
 * "In the module there is a named zombie, and somehow this got an entity with
 * JUST the zombie picture, the global one, and nothing else. And this still
 * counts as a defined entity, so no 'generate x npcs' catches it.").
 *
 * The row is a REAL `npc` artifact (name + `data.monsterChunkId` marker,
 * `db/mobArtifacts.isMobArtifact`) — ONE campaign-scoped row per cited rulebook
 * chunk, shared by every encounter that cites the creature, its portrait cached
 * globally, and battle seeding resolving stats THROUGH it. Because the
 * module-creation pool excludes only `pc` (`domain/artifact.ts`), such a row
 * used to sit IN the pool: `resolveWikiLink` returned it, the entity panel
 * counted the name as DETAILED and the batch never offered it — while the row
 * carries no authored text at all.
 *
 * The pins below hold the one question the module entity view answers — "does
 * this name have an authored, DETAILED entity of its own?" (`detailedEntity`,
 * the ONE verdict read by `use-module-entities` and `post-generation`) — apart
 * from the wiki-link tier rule, which is untouched: the reader still resolves
 * `[[Zombie]]` to a real row (module tier beats campaign tier).
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
  fetchWithHeadersTimeout: vi.fn(),
}));

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { toastError } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);

/**
 * Every render gets a router context: the entity panel's Run battle button
 * navigates (useNavigate), so EntityPanel cannot render outside a Router.
 */
function render(ui: JSX.Element): ReturnType<typeof rtlRender> {
  return rtlRender(ui, { wrapper: MemoryRouter });
}

const CHUNK_ID = '5a4f0c9e-1111-4111-8111-000000000001';

/** A valid npc draft reply — the model's invented name, which the batch then
 * aligns to the exact wiki-link name (keeping the invented one as an alias). */
const NPC_DRAFT = {
  name: 'Zombie of the Ash Gate',
  summary: 'A drowned corpse that walks the tide gate at dusk.',
  suggestedTags: ['undead'],
  body: '# Zombie of the Ash Gate\nIt was a gate warden once.',
  appearance: 'Bloated grey flesh and green tideweed.',
  personality: 'Mindless, relentless.',
  needsStatBlock: true,
};

const NPC_STATBLOCK = {
  system: 'dnd5e',
  level: '1',
  size: 'Medium',
  creatureType: 'Undead',
  ac: 8,
  acNote: '',
  hp: 22,
  hpFormula: '3d8+9',
  speed: '20 ft.',
  abilities: { str: 13, dex: 6, con: 16, int: 3, wis: 6, cha: 5 },
  saves: 'Wis +0',
  skills: '',
  senses: 'darkvision 60 ft., passive Perception 8',
  languages: 'understands Common but cannot speak',
  traits: [{ name: 'Undead Fortitude', text: 'Drops to 1 hp instead of 0 on a failed save.' }],
  actions: [{ name: 'Slam', text: 'Melee Weapon Attack: +3 to hit.' }],
  reactions: [],
  legendary: [],
  extras: {},
};

/** The statblock calls are told apart by their prompt (the batch's own seam),
 * exactly as the entity panel's suite does. */
function respondToBatch(): (messages: unknown[]) => Promise<{
  text: string;
  modelUsed: string;
  fallback: null;
}> {
  return (messages) => {
    const raw = JSON.stringify(messages);
    const text = raw.includes('Fill the StatBlock for')
      ? JSON.stringify(NPC_STATBLOCK)
      : JSON.stringify(NPC_DRAFT);
    return Promise.resolve({ text, modelUsed: 'test-model', fallback: null });
  };
}

const PREMISE = 'The [[Zombie]] shambles out of the flooded undercroft at dusk.';

/** The owner's module: its text names the creature, and the creation pass
 * recorded the name as an npc (so the batch bucket exists). */
function creatureModule(campaignId: Id, overrides?: Partial<Module>): Module {
  const base = createModule({
    campaignId,
    title: 'Ember Crypt',
    concept: 'A drowned crypt under the tide gate.',
    levelMin: 1,
    levelMax: 4,
    sizeDial: 'standard',
  });
  return moduleSchema.parse({
    ...base,
    status: 'ready',
    spine: {
      premise: PREMISE,
      themes: [],
      partPlan: [
        {
          title: 'The Tide Gate',
          levelBand: '1–2',
          synopsis: 'Reach the gate before the tide.',
          levelUpTrigger: 'The gate opens.',
        },
      ],
    },
    entityKinds: [{ name: 'Zombie', kind: 'npc', absorbed: [] }],
    entityNamesNormalized: true,
    ...overrides,
  });
}

/** The creature row as the CAST path creates it (docs/11 D4): name + a
 * `creatureRef` citation + empty authored content, campaign scope, no images.
 * REWRITTEN (ledger row 106): the retired `getOrCreateMobArtifact` created a
 * HIDDEN artifact that stood in for the creature itself; `castCreatureAsNpc`
 * creates a real, visible AUTHORED row that CITES the library instead. */
async function seedCreature(campaignId: Id, name = 'Zombie'): Promise<Artifact> {
  return createArtifact({
    campaignId,
    kind: 'npc',
    name,
    summary: '',
    body: '',
    coverImageId: null,
    data: { appearance: '', personality: '', statBlock: null, creatureRef: { chunkId: CHUNK_ID } },
  });
}

/** A LIBRARY creature of this name — a statblock chunk in the bestiary and
 * nothing else (docs/11 D10). This is the whole of what the owner's bug was
 * about under the ratified model: there is NO artifact to land on, so a
 * mention that names it resolves to a DERIVED creature node. */
async function seedLibraryCreature(name = 'Zombie'): Promise<string> {
  const book = await createRulebook({ title: 'Bestiary', system: 'dnd5e', filename: 'bestiary.pdf' });
  const text = `${name}\nLarge undead, unaligned\nArmor Class 8\nHit Points 22 (3d10 + 6)\nSpeed 20 ft.`;
  const chunk = ruleChunkSchema.parse({
    ...stampNewEntity(),
    bookId: book.id,
    pageStart: 12,
    pageEnd: 12,
    chunkType: 'statblock',
    headingPath: [name],
    text,
    contentHash: await sha256Hex(text),
    statBlock: statBlockSchema.parse({
      system: 'dnd5e',
      level: '1/4',
      size: 'Medium',
      creatureType: 'undead',
      ac: 8,
      acNote: '',
      hp: 22,
      hpFormula: '3d10 + 6',
      speed: '20 ft.',
      abilities: { str: 13, dex: 6, con: 16, int: 3, wis: 6, cha: 5 },
      saves: '',
      skills: '',
      senses: 'darkvision 60 ft.',
      languages: 'understands Common but cannot speak',
      traits: [],
      actions: [],
      reactions: [],
      legendary: [],
      extras: {},
    }),
  });
  await putChunks([chunk]);
  await publishLibraryCreaturePool();
  return chunk.id;
}

/** One authored campaign NPC (the legitimate entity of that name). */
async function seedAuthoredNpc(campaignId: Id, name = 'Zombie'): Promise<Artifact> {
  return createArtifact({
    campaignId,
    kind: 'npc',
    name,
    summary: 'The gate warden who drowned.',
    body: '# Zombie\nHe kept the gate until the tide took him.',
    data: { appearance: 'A tall corpse in a warden coat.', personality: 'Patient.', statBlock: null },
  });
}

/** A module-owned NPC of that name (what the fix's generation lands). */
async function seedModuleNpc(campaignId: Id, moduleId: Id, name = 'Zombie'): Promise<Artifact> {
  return createArtifact({
    campaignId,
    moduleId,
    kind: 'npc',
    name,
    summary: 'This module’s own gate warden.',
    body: '# Zombie\nWritten for this module.',
    data: { appearance: 'Tideweed in his collar.', personality: 'Silent.', statBlock: null },
  });
}

function renderPanel(
  module: Module,
  artifacts: readonly AnyArtifact[],
  campaign: Campaign,
  handlers?: {
    onStub?: (name: string, anchor: { x: number; y: number }) => void;
    onOpenCard?: (artifact: AnyArtifact) => void;
  },
): ReturnType<typeof rtlRender> {
  return render(
    <EntityPanel
      module={module}
      artifacts={artifacts}
      campaign={campaign}
      onStub={handlers?.onStub ?? vi.fn()}
      onOpenCard={handlers?.onOpenCard ?? vi.fn()}
    />,
  );
}

beforeEach(async () => {
  await clearDatabase();
  chatMock.mockReset();
  toastErrorMock.mockReset();
  useProgressStore.getState().reset();
  useEntityImageQueue.getState().reset();
});

afterEach(cleanup);

describe('the module entity view: a creature row is never a DETAILED entity', () => {
  it('shows a library-only creature name as not detailed, offers the batch, and says why the row is bare', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const module = creatureModule(campaign.id);
    await saveModule(module);
    // REWRITTEN (ledger row 106): the fixture used to be a hidden "creature
    // row" ARTIFACT. There is no such artifact any more — the creature lives in
    // the library and NOTHING in the campaign points at it. The verdict must
    // still be "not detailed, this is work": that is the owner's bug
    // ("...this still counts as a defined entity, so no 'generate x npcs'
    // catches it") and it is what makes D10 a fix rather than a rename.
    const chunkId = await seedLibraryCreature();
    const onStub = vi.fn<(name: string, anchor: { x: number; y: number }) => void>();
    const onOpenCard = vi.fn<(artifact: AnyArtifact) => void>();

    renderPanel(module, [], campaign, { onStub, onOpenCard });

    expect(screen.getByText('0 detailed · 1 mentioned')).toBeInTheDocument();
    const row = screen.getByTestId('entity-row');
    expect(row).toHaveTextContent('Zombie');
    expect(row).not.toHaveAttribute('data-resolved');
    expect(screen.getByTestId('batch-npc')).toHaveTextContent('Generate 1 npc');

    // The row says WHY it is bare instead of pretending the library is the
    // module's entity: the marker names the creature the text cites and the
    // remedy.
    const marker = screen.getByTestId('entity-creature-only');
    expect(marker).toHaveAttribute('title', expect.stringContaining('«Zombie»'));
    expect(marker).toHaveAttribute('title', expect.stringContaining('library creature'));
    expect(marker).toHaveAttribute(
      'title',
      expect.stringContaining("generating it here creates this module's own NPC of that name"),
    );
    expect(marker).toHaveAttribute('title', expect.stringContaining('not detailed yet'));

    // A not-detailed row opens the stub popover (the panel's per-entity
    // generation affordance), never a card: there is no artifact to show.
    await user.click(row);
    expect(onStub).toHaveBeenCalledTimes(1);
    expect(onStub.mock.calls[0]?.[0]).toBe('Zombie');
    expect(onOpenCard).not.toHaveBeenCalled();

    // Images attach to an authored artifact, never to the library: the checkbox
    // is off (Base UI: aria-disabled, not [disabled]) and the reason is its
    // accessible NAME, not a hover-only title.
    await user.click(screen.getByTestId('entity-images'));
    const checkbox = screen.getByRole('checkbox', {
      name: 'Detail Zombie first — images attach to its artifact',
    });
    expect(checkbox).toHaveAttribute('aria-disabled', 'true');
    expect(checkbox).toHaveAttribute('title', expect.stringContaining('Detail this entity first'));

    // And the citation the text carries IS resolvable — the name is not merely
    // "unresolved", it is a creature (docs/11 D10).
    const listing = await resolveCreatureCitation({ chunkId, creatureName: 'Zombie' }, 'Zombie');
    expect(listing.chunk?.id).toBe(chunkId);
    await flushAsyncUpdates();
  }, 20_000);

  it('keeps an authored campaign NPC, a module-owned NPC and its npc-ref citation defined', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const module = creatureModule(campaign.id);
    await saveModule(module);
    const authored = await seedAuthoredNpc(campaign.id);
    // The encounter cites that same NPC through an `npc-ref` roster entry —
    // one artifact, two citations (the roster path is untouched by this fix).
    const encounter = await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'The Tide Gate',
      data: {
        difficulty: 'medium',
        levelHint: '2',
        monsters: [
          {
            name: 'Zombie',
            count: 2,
            notes: '',
            treasure: '',
            source: { type: 'npc-ref', artifactId: authored.id },
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
    if (encounter.kind !== 'encounter') throw new Error('fixture row is not an encounter');
        // REWRITTEN (ledger row 106): `rosterArtifactIds` collected the artifacts
    // a roster points at, which is exactly the model that stranded references.
    // The only row-backed participants are `npc-ref` rows now, and the
    // AUTHORED npc is the one they name.
    expect(
      encounter.data.monsters
        .map((entry) => (entry.source.type === 'npc-ref' ? entry.source.artifactId : undefined))
        .filter((id) => id !== undefined),
    ).toEqual([authored.id]);

    renderPanel(module, [authored, encounter], campaign);

    expect(screen.getByText('1 detailed · 1 mentioned')).toBeInTheDocument();
    expect(screen.getByTestId('entity-row')).toHaveAttribute('data-resolved', 'true');
    expect(screen.queryByTestId('batch-npc')).toBeNull();
    expect(screen.queryByTestId('entity-creature-only')).toBeNull();
    // The automation's own target set agrees: nothing to generate.
    expect(batchTargets(module, [authored, encounter], 'npc')).toEqual([]);
    await flushAsyncUpdates();
  }, 20_000);

  it('prefers the module’s own NPC over the creature row and generates no duplicate', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const module = creatureModule(campaign.id);
    await saveModule(module);
    const creature = await seedCreature(campaign.id);
    const moduleOwned = await seedModuleNpc(campaign.id, module.id);
    const pool = [creature, moduleOwned];

    // Display resolution is the tier rule, untouched: the module's own row wins
    // tier 0 over the campaign-scoped creature row.
    const resolution = resolveWikiLink('Zombie', pool, { moduleId: module.id });
    expect(resolution.artifact?.id).toBe(moduleOwned.id);

    renderPanel(module, pool, campaign);

    expect(screen.getByText('1 detailed · 1 mentioned')).toBeInTheDocument();
    expect(screen.getByTestId('entity-row')).toHaveAttribute('data-resolved', 'true');
    expect(screen.queryByTestId('batch-npc')).toBeNull();
    expect(batchTargets(module, pool, 'npc')).toEqual([]);
    await flushAsyncUpdates();
  }, 20_000);

  it('still resolves a creature-backed name for the READER (display resolution unchanged)', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const module = creatureModule(campaign.id);
    await saveModule(module);
    const creature = await seedCreature(campaign.id);

    render(<WikiMarkdown value={PREMISE} artifacts={[creature]} moduleId={module.id} />);

    // The reader's chip resolves to the real creature row — this fix changes the
    // module entity view's verdict, never the reader's linking.
    const chip = screen.getByTestId('wiki-chip');
    expect(chip).toHaveAttribute('data-wiki-name', 'Zombie');
    // The tooltip leads with the byte-exact token and keeps the kind + name
    // (docs/17 row 100) — the token is what the rendered view drops.
    expect(chip).toHaveAttribute('title', '[[Zombie]] — NPC Zombie');
    expect(screen.queryByTestId('wiki-chip-unresolved')).toBeNull();
    await flushAsyncUpdates();
  }, 20_000);
});

describe('the generation the verdict unlocks', () => {
  it('lands a module-owned npc of the exact name for a LIBRARY-only name, and creates no creature row', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const module = creatureModule(campaign.id);
    await saveModule(module);
    await seedBuiltInPersonas();
    // REWRITTEN (ledger row 106): the fixture used to be a campaign-scoped
    // "creature row" artifact, and half of this test pinned that the batch left
    // THAT ROW alone. Under the ratified model the library creature is not a row
    // at all, so the pin becomes the stronger statement it always meant: the
    // batch creates the module's npc and NOTHING for the creature — no cast row
    // (docs/11 D5: only the module GENERATOR may cast) and no artifact citing
    // the library.
    const chunkId = await seedLibraryCreature();
    chatMock.mockImplementation(respondToBatch());

    renderPanel(module, [], campaign);
    await user.click(screen.getByTestId('batch-npc'));

    // The batch is async: wait for the write rather than assuming the click
    // drained it (the old fixture got away with it because the barrier below
    // held the label; nothing about the model guarantees the timing).
    const landed = await waitFor(async () => {
      const rows = (await listArtifactsByCampaign(campaign.id)).filter(
        (artifact) => artifact.name === 'Zombie',
      );
      expect(rows).toHaveLength(1);
      return rows;
    });
    const npc = landed[0];
    if (npc?.kind !== 'npc') throw new Error('no npc of that name landed');
    expect(npc.moduleId).toBe(module.id);
    expect(npc.campaignId).toBe(campaign.id);
    expect(npc.data.creatureRef).toBeUndefined();
    expect(npc.tags).toContain('module:Ember Crypt');
    expect(npc.summary).toBe(NPC_DRAFT.summary);
    expect(npc.body).toBe(NPC_DRAFT.body);
    expect(npc.aliases).toContain(NPC_DRAFT.name);
    expect(toastErrorMock).not.toHaveBeenCalled();

    // The module's own row wins the name, and the verdict is closed.
    const pool = await listArtifactsByCampaign(campaign.id);
    const resolution = resolveWikiLink('Zombie', pool, { moduleId: module.id });
    expect(resolution.artifact?.id).toBe(npc.id);
    expect(batchTargets(module, pool, 'npc')).toEqual([]);

    // NOTHING exists for the library creature itself: the batch may cite it,
    // never materialize it.
    expect(
      pool.filter((artifact) => artifact.kind === 'npc' && artifact.data.creatureRef !== undefined),
    ).toEqual([]);
    // The library row is still there to cite — untouched by the generation.
    expect((await resolveCreatureCitation({ chunkId }, 'Zombie')).chunk?.id).toBe(chunkId);
    await flushAsyncUpdates();
  }, 30_000);

  it('the automation sweep lands it too, and still creates no artifact for the creature', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const module = creatureModule(campaign.id);
    await saveModule(module);
    await seedBuiltInPersonas();
    const chunkId = await seedLibraryCreature();
    chatMock.mockImplementation(respondToBatch());

    await runModulePostGeneration(module.id, campaign, {
      autoGenerateKinds: ['npc'],
      autoImageKinds: [],
      autoGenerateBattlemaps: false,
      autoGenerateMobImages: false,
    });

    const landed = (await listArtifactsByCampaign(campaign.id)).filter(
      (artifact) => artifact.name === 'Zombie',
    );
    expect(landed).toHaveLength(1);
    expect(landed[0]?.moduleId).toBe(module.id);
    expect(landed[0]?.kind).toBe('npc');
    expect(landed[0]?.kind === 'npc' ? landed[0].data.creatureRef : chunkId).toBeUndefined();
    // The sweep materializes the MODULE's entity and nothing else: the library
    // creature is never turned into an artifact by an automation pass (docs/11
    // D5 — the encounter/sweep side may cite, never cast).
    expect(
      (await listArtifactsByCampaign(campaign.id)).filter(
        (artifact) => artifact.kind === 'npc' && artifact.data.creatureRef !== undefined,
      ),
    ).toEqual([]);
    expect((await resolveCreatureCitation({ chunkId }, 'Zombie')).chunk?.id).toBe(chunkId);
    expect(toastErrorMock.mock.calls).toEqual([]);
  }, 30_000);

  /**
   * The CAST path is the OTHER designed outcome at this batch, and the one
   * that must never be counted as a failure (docs/17 row 117: a deliberate
   * outcome is not a failure). When the module RECORDS a bestiary slot for an
   * entity, its npc is cast from the library instead of generated — the batch
   * returns the name in `cast`, never in `failed`, so the reporting seam
   * (`features/modules/entity-batch-report`, docs/17 row 131) is never even
   * reached.
   */
  it('a designed CAST is a SUCCESS: no failure is reported at all, so no count sentence can include it', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const module = creatureModule(campaign.id, {
      entityKinds: [
        { name: 'Zombie', kind: 'npc', absorbed: [], bestiary: { creature: 'Zombie' } },
      ],
    });
    await saveModule(module);
    await seedBuiltInPersonas();
    await seedLibraryCreature();
    chatMock.mockImplementation(respondToBatch());

    renderPanel(module, [], campaign);
    await user.click(screen.getByTestId('batch-npc'));

    const landed = await waitFor(async () => {
      const rows = (await listArtifactsByCampaign(campaign.id)).filter(
        (artifact) => artifact.name === 'Zombie',
      );
      expect(rows).toHaveLength(1);
      return rows;
    });
    // CAST, not generated: the row cites the library creature (docs/11 D4).
    const npc = landed[0];
    if (npc?.kind !== 'npc') throw new Error('no npc of that name landed');
    expect(npc.data.creatureRef).toBeDefined();
    // The cast ran no model call at all — that is what makes it a different
    // path rather than a quieter failure.
    expect(chatMock).not.toHaveBeenCalled();
    // Nothing is reported: no transient toast, and no PERSISTENT one either
    // (the seam raises `toastErrorPersistent`, absent from this file's mock —
    // so a reported failure would surface here as the panel's own
    // 'Batch generation failed' toast instead of passing silently).
    expect(toastErrorMock.mock.calls).toEqual([]);
    await flushAsyncUpdates();
  }, 30_000);
});
