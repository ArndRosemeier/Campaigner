import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import {
  createArtifact,
  getArtifact,
  listRevisions,
  updateArtifact,
} from '@/db/artifactRepo';
import { createModule as createModuleRow } from '@/db/moduleRepo';
import { createPersona } from '@/db/personaRepo';
import { getRun } from '@/db/runRepo';
import { runEngine, moduleGroundingSection, type StartRunInput } from '@/llm/runEngine';
import {
  createModule,
  moduleSchema,
  newId,
  type Campaign,
  type Id,
  type Module,
  type Persona,
  type StatBlock,
} from '@/domain';
import { clearDatabase } from '../db/helpers';

/**
 * In-place refill of an existing artifact by a generate persona (the "use
 * the NPC smith to correct this" flow) with CONTEXT PARITY to automatic
 * module generation (docs/08 §M4-C): the draft is grounded in the owning
 * module's document (surrounding paragraphs + premise) exactly like
 * `runEntityBatch`'s briefs, every inapplicable state names itself, and an
 * empty body never ships — at the draft contract (one repair turn) nor at
 * finalize (refuse-and-preserve).
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
}));

vi.mock('@/search', () => ({
  searchRules: vi.fn(),
}));

// The toast seam is mocked so a loud refusal can be pinned at BOTH surfaces it
// must reach (AGENTS rule 2: the run row is one, the toast the other) — never
// `console.error` alone.
vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastErrorPersistent: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { searchRules } = await import('@/search');
const searchMock = vi.mocked(searchRules);
const { toastError } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);

const NPC_DRAFT = {
  name: 'Kael Ashbound',
  summary: 'The warden of the sealed door, refilled.',
  suggestedTags: [],
  body: '# Kael\nNow with actual content.',
  appearance: 'Tall, ash-grey cloak.',
  personality: 'Stoic, tireless.',
  needsStatBlock: false,
};

const NPC_STATBLOCK: StatBlock = {
  system: 'dnd5e',
  level: '3',
  size: 'Small',
  creatureType: 'humanoid (goblinoid)',
  ac: 14,
  acNote: '',
  hp: 22,
  hpFormula: '5d6 + 5',
  speed: '30 ft.',
  abilities: { str: 8, dex: 16, con: 13, int: 14, wis: 10, cha: 12 },
  saves: '',
  skills: '',
  senses: '',
  languages: 'Common, Goblin',
  traits: [],
  actions: [],
  reactions: [],
  legendary: [],
  extras: {},
};

function moduleRow(
  campaignId: Id,
  input: { title: string; premise?: string; parts?: { planIndex: number; markdown: string }[] },
): Module {
  const draft = createModule({
    campaignId,
    title: input.title,
    concept: '',
    levelMin: 1,
    levelMax: 3,
    sizeDial: 'sketch',
  });
  return moduleSchema.parse({
    ...draft,
    spine: {
      premise: input.premise ?? '',
      themes: [],
      partPlan: [{ title: 'Part', levelBand: '1–3', synopsis: '', levelUpTrigger: '' }],
    },
    parts: (input.parts ?? []).map((part) => ({
      planIndex: part.planIndex,
      markdown: part.markdown,
      status: 'ready' as const,
      errorMessage: '',
      edited: false,
    })),
  });
}

async function seed(): Promise<{ campaign: Campaign; moduleId: Id; targetId: Id }> {
  const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
  const module = moduleRow(campaign.id, {
    title: 'Ashen Vault',
    premise: '[[Kael]] guards the sealed door. The cult chants below.',
    parts: [{ planIndex: 0, markdown: 'The vault antechamber. Kael collects the tithe at dusk.' }],
  });
  await createModuleRow(module);
  const target = await createArtifact({
    campaignId: campaign.id,
    moduleId: module.id,
    kind: 'npc',
    name: 'Kael',
    tags: ['module:Ashen Vault'],
    summary: '',
    body: '',
    data: { appearance: '', personality: '', statBlock: NPC_STATBLOCK },
  });
  return { campaign, moduleId: module.id, targetId: target.id };
}

async function seedCampaignOnly(): Promise<{ campaign: Campaign }> {
  const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
  return { campaign };
}

async function seedPersona(): Promise<Persona> {
  return createPersona({
    slug: 'npc-smith-refill',
    name: 'NPC Smith',
    description: 'test',
    systemPrompt: 'You are a test persona. Reply with JSON only.',
    producesKind: 'npc',
    builtIn: true,
  });
}

const INPUT = (
  campaign: Campaign,
  persona: Persona,
  targetArtifactId: Id | undefined,
  autonomy: 'auto' | 'manual' = 'auto',
): StartRunInput => ({
  campaign: {
    id: campaign.id,
    name: campaign.name,
    system: 'dnd5e' as const,
    description: '',
    coverImageId: null,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
  },
  persona,
  autonomy,
  brief: 'Refill this NPC with real content.',
  pinnedChunkIds: [],
  ...(targetArtifactId === undefined ? {} : { targetArtifactId }),
});

function userMessage(callIndex: number): string {
  const call = chatMock.mock.calls[callIndex];
  const messages = call?.[0] ?? [];
  return messages
    .filter((message) => message.role === 'user')
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
    .join('\n');
}

beforeEach(async () => {
  await clearDatabase();
  searchMock.mockReset();
  searchMock.mockResolvedValue([]);
  chatMock.mockReset();
  toastErrorMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('in-place refill parity (module grounding)', () => {
  it('grounds a module-owned refill in its module exactly like automatic module generation', async () => {
    const { campaign, targetId } = await seed();
    const persona = await seedPersona();
    chatMock.mockResolvedValue({
      text: JSON.stringify(NPC_DRAFT),
      modelUsed: 'test-model',
      fallback: null,
    });

    const runId = await runEngine.startRun(INPUT(campaign, persona, targetId));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });

    // Parity pin: the draft prompt carries the module document context
    // (surrounding paragraphs around the artifact's name) and the spine
    // premise — the sources the automatic `runEntityBatch` brief assembles.
    const prompt = userMessage(0);
    expect(prompt).toContain('Where it is mentioned in the module:');
    expect(prompt).toContain('[[Kael]] guards the sealed door');
    expect(prompt).toContain('Kael collects the tithe at dusk');
    expect(prompt).toContain('Module premise for context:');
    expect(prompt).toContain('The cult chants below');
    expect(prompt.indexOf('Task: Refill this NPC')).toBeLessThan(
      prompt.indexOf('Where it is mentioned in the module:'),
    );

    // The retrieve step persisted the grounding with the selection.
    const run = await getRun(runId);
    const retrieveStep = run?.steps.find((step) => step.name === 'retrieve');
    const stored = retrieveStep?.output as {
      moduleGrounding?: { status: string; moduleTitle?: string; contextParagraphs?: string };
      expansionExcerpts?: { entityName: string }[];
    };
    expect(stored.moduleGrounding?.status).toBe('ok');
    expect(stored.moduleGrounding?.moduleTitle).toBe('Ashen Vault');
    expect(stored.moduleGrounding?.contextParagraphs).toContain('[[Kael]] guards the sealed door');
    // Campaign-grounding parity: the detection text included the module
    // context, so the target's own entity was detected (self block).
    expect(stored.expansionExcerpts?.map((block) => block.entityName)).toContain('Kael');

    // The refill wrote INTO the artifact: identity preserved, content new.
    const artifact = await getArtifact(targetId);
    expect(artifact?.id).toBe(targetId);
    expect(artifact?.name).toBe('Kael');
    expect(artifact?.moduleId).not.toBeNull();
    expect(artifact?.tags).toContain('module:Ashen Vault');
    expect(artifact?.summary).toBe(NPC_DRAFT.summary);
    expect(artifact?.body).toBe(NPC_DRAFT.body);
    // The model's invented name became an alias.
    expect(artifact?.aliases).toContain('Kael Ashbound');
    // The draft declined stats (needsStatBlock=false, skipped step) — the
    // existing stat block survives the refill instead of being clobbered.
    if (artifact?.kind !== 'npc') throw new Error('target is not an npc');
    expect(artifact.data.statBlock?.hp).toBe(22);
  }, 30000);

  it('names the degrade in prompt and step notice when the owning module row is gone', async () => {
    const { campaign } = await seedCampaignOnly();
    const persona = await seedPersona();
    // A kept artifact of a deleted module: the row is gone, the claim is not.
    const target = await createArtifact({
      campaignId: campaign.id,
      moduleId: newId(),
      kind: 'npc',
      name: 'Orphan Kael',
      summary: '',
      body: '',
      data: { appearance: '', personality: '', statBlock: null },
    });
    chatMock.mockResolvedValue({
      text: JSON.stringify({ ...NPC_DRAFT, name: 'Orphan Kael' }),
      modelUsed: 'test-model',
      fallback: null,
    });

    const runId = await runEngine.startRun(INPUT(campaign, persona, target.id));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });

    expect(userMessage(0)).toContain('no longer exists');
    const run = await getRun(runId);
    const draftStep = run?.steps.find((step) => step.name === 'draft');
    expect((draftStep?.output as { notice?: string }).notice).toContain(
      'no longer exists — the regeneration ran without its module context',
    );
  }, 30000);

  it('says so when the target is not module-owned and when the module text never mentions it', async () => {
    const { campaign } = await seedCampaignOnly();
    const persona = await seedPersona();
    const campaignScoped = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Freelance Fenwick',
      summary: '',
      body: '',
      data: { appearance: '', personality: '', statBlock: null },
    });
    chatMock.mockResolvedValue({
      text: JSON.stringify({ ...NPC_DRAFT, name: 'Freelance Fenwick' }),
      modelUsed: 'test-model',
      fallback: null,
    });
    const runId = await runEngine.startRun(INPUT(campaign, persona, campaignScoped.id));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });
    expect(userMessage(0)).toContain('not owned by a module');

    // A module-owned target whose name appears nowhere in the module text:
    // the premise still grounds, and the missing mention says so.
    const module = moduleRow(campaign.id, {
      title: 'Unrelated Vault',
      premise: 'Nothing here mentions the target at all.',
    });
    await createModuleRow(module);
    const unmentioned = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'npc',
      name: 'Stranger Sid',
      summary: '',
      body: '',
      data: { appearance: '', personality: '', statBlock: null },
    });
    chatMock.mockResolvedValue({
      text: JSON.stringify({ ...NPC_DRAFT, name: 'Stranger Sid' }),
      modelUsed: 'test-model',
      fallback: null,
    });
    const runId2 = await runEngine.startRun(INPUT(campaign, persona, unmentioned.id));
    await waitFor(async () => {
      expect((await getRun(runId2))?.status).toBe('completed');
    });
    const prompt = userMessage(1);
    expect(prompt).toContain('never mentions this artifact');
    expect(prompt).toContain('Nothing here mentions the target at all.');
  }, 30000);
});

describe('empty-content rejection (loud, at every layer)', () => {
  it('repairs an empty-body draft once by name, then fails the auto run loudly without an artifact', async () => {
    const { campaign } = await seedCampaignOnly();
    const persona = await seedPersona();
    const emptyBody = { ...NPC_DRAFT, body: '   \n\t ' };
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(emptyBody), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(emptyBody), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun(INPUT(campaign, persona, undefined));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('failed');
    });

    // Exactly the one bounded repair turn, with the issue NAMED.
    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(userMessage(1)).toContain('body is empty');
    const run = await getRun(runId);
    expect(run?.failureKind).toBe('invalid-output');
    expect(run?.errorMessage).toContain('body is empty');
    // No artifact materialized.
    const artifacts = await import('@/db/artifactRepo');
    expect(await artifacts.listArtifactsByCampaign(campaign.id)).toHaveLength(0);
  }, 30000);

  it('refuse-and-preserve: an empty refill never clobbers the existing content', async () => {
    const { campaign, targetId } = await seed();
    const persona = await seedPersona();
    // Authored content the refill must not destroy.
    await updateArtifact(targetId, {
      summary: 'Authored summary.',
      body: '# Kael\nHand-written content.',
    });

    chatMock.mockResolvedValue({
      text: JSON.stringify(NPC_DRAFT),
      modelUsed: 'test-model',
      fallback: null,
    });
    // Manual autonomy pauses after the draft — the hole the finalize guard
    // covers is a USER-EDITED draft (edits are not schema-validated).
    const runId = await runEngine.startRun(INPUT(campaign, persona, targetId, 'manual'));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('awaiting_user');
    });
    await runEngine.editStep(
      runId,
      1,
      { parsed: { ...NPC_DRAFT, body: '   ' } },
      INPUT(campaign, persona, targetId, 'manual'),
    );
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('failed');
    });

    const run = await getRun(runId);
    expect(run?.errorMessage).toContain('empty body');
    // The artifact kept its authored content — never clobbered with empty.
    const after = await getArtifact(targetId);
    expect(after?.body).toBe('# Kael\nHand-written content.');
    expect(after?.summary).toBe('Authored summary.');
  }, 30000);
});

/**
 * REFILLING A CAST CREATURE ROW (rewritten, ledger row 106 — the guard is GONE).
 *
 * This block used to pin a REFUSAL at the write chokepoint: a bestiary creature
 * row was a real `npc` artifact carrying the additive `data.monsterChunkId`
 * marker, shared by every citing encounter, and an in-place refill wrote
 * invented prose onto it while `mergeRefillData` PRESERVED the marker — so the
 * row kept the creature's identity and described somebody else, in text every
 * citing encounter shared. The refusal was the right answer to that model.
 *
 * Under the ratified model that row does not exist. An `npc` carrying a
 * `creatureRef` is a CAST CREATURE (docs/11 D3/D4): an AUTHORED row — the
 * owner's Aunt Agatha, *"she will have zombie stats but with prose"* — whose
 * prose is its own and is exactly what a refill is for. So the guard is not
 * relaxed, it is UNNECESSARY, and the protection moved to where it structurally
 * belongs:
 *
 * - `data.creatureRef` is a different field from the one the writer produces
 *   (`mergeRefillData` merges prose and a stat block, never the citation), so
 *   the citation cannot be clobbered even by a draft that tried;
 * - the stats are DERIVED at read time from the library, so a refill must not
 *   author a stat block onto the row — and the `npcDataSchema` refine makes
 *   that impossible to get wrong silently (a citation AND an authored stat
 *   block is a parse error, not a corrupted row).
 *
 * The two tests below are that pair, on a campaign-scoped and on a
 * module-owned row (proving the answer does not depend on the module grounding —
 * the distinction the old guard was blamed for).
 */
describe('creature-row refill guard (the write chokepoint)', () => {
  it('refills a CAST creature row\u2019s prose and cannot touch its citation', async () => {
    const { campaign } = await seedCampaignOnly();
    const persona = await seedPersona();
    const chunkId = newId();
    const creature = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Goblin Warrior',
      aliases: ['Goblin'],
      tags: ['bestiary', 'goblinoid'],
      links: [],
      summary: '',
      body: '',
      data: { appearance: '', personality: '', statBlock: null, creatureRef: { chunkId } },
    });
    const revisionsBefore = await listRevisions(creature.id);
    chatMock.mockResolvedValue({
      text: JSON.stringify({ ...NPC_DRAFT, name: 'Goblin Warrior' }),
      modelUsed: 'test-model',
      fallback: null,
    });

    const runId = await runEngine.startRun(INPUT(campaign, persona, creature.id));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });

    const after = await getArtifact(creature.id);
    // The prose landed: this row is authored, and that is the owner's path.
    expect(after?.name).toBe('Goblin Warrior');
    expect(after?.summary).toBe(NPC_DRAFT.summary);
    expect(after?.body).toBe(NPC_DRAFT.body);
    if (after?.kind !== 'npc') throw new Error('the refill target is not an npc');
    expect(after.data.appearance).toBe(NPC_DRAFT.appearance);
    expect(after.data.personality).toBe(NPC_DRAFT.personality);
    // THE CITATION IS BYTE-IDENTICAL — the field the writer is not given.
    expect(after.data.creatureRef).toEqual({ chunkId });
    // …and no stat block was authored onto it: the numbers come from the
    // library, and writing one here would be the schema conflict below.
    expect(after.data.statBlock).toBeNull();
    // The properties the owner put on the row survive the merge untouched.
    expect(after.aliases).toEqual(['Goblin']);
    expect(after.tags).toEqual(['bestiary', 'goblinoid']);
    expect(after.links).toEqual([]);
    expect(after.moduleId).toBeNull();
    // A revision was written (the refill is a real write, not a silent no-op).
    expect((await listRevisions(creature.id)).length).toBeGreaterThan(revisionsBefore.length);
    expect(toastErrorMock).not.toHaveBeenCalled();
    // …and the write went through the model: a refill is a generation.
    expect(chatMock).toHaveBeenCalled();
  }, 30000);

  it('a module-owned cast row behaves identically — the citation is field-protected, not module-gated', async () => {
    const { campaign, moduleId } = await seed();
    const persona = await seedPersona();
    const chunkId = newId();
    const creature = await createArtifact({
      campaignId: campaign.id,
      moduleId,
      kind: 'npc',
      name: 'Cinder Bat',
      summary: '',
      body: '',
      data: { appearance: '', personality: '', statBlock: null, creatureRef: { chunkId } },
    });
    chatMock.mockResolvedValue({
      text: JSON.stringify({ ...NPC_DRAFT, name: 'Cinder Bat' }),
      modelUsed: 'test-model',
      fallback: null,
    });

    const runId = await runEngine.startRun(INPUT(campaign, persona, creature.id));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });

    const after = await getArtifact(creature.id);
    if (after?.kind !== 'npc') throw new Error('the refill target is not an npc');
    expect(after.name).toBe('Cinder Bat');
    expect(after.summary).toBe(NPC_DRAFT.summary);
    expect(after.moduleId).toBe(moduleId);
    expect(after.data.creatureRef).toEqual({ chunkId });
    expect(after.data.statBlock).toBeNull();
    expect(toastErrorMock).not.toHaveBeenCalled();
  }, 30000);

  it('still refills a legitimate npc row — the npc-ref roster shape (stat block, no chunk marker)', async () => {
    const { campaign } = await seedCampaignOnly();
    const persona = await seedPersona();
    // The shape `materializeMonsterNpc` births for an uncited monster:
    // kind npc, inline stat block, NO `monsterChunkId` marker. It is a real
    // artifact (a roster `npc-ref` points at it), so it refills normally.
    const rosterEntry = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Materialized Marla',
      summary: 'A drafted scene member.',
      body: '',
      data: { appearance: '', personality: '', statBlock: NPC_STATBLOCK },
    });
    chatMock.mockResolvedValue({
      text: JSON.stringify({ ...NPC_DRAFT, name: 'Materialized Marla' }),
      modelUsed: 'test-model',
      fallback: null,
    });

    const runId = await runEngine.startRun(INPUT(campaign, persona, rosterEntry.id));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });

    const after = await getArtifact(rosterEntry.id);
    expect(after?.name).toBe('Materialized Marla');
    expect(after?.summary).toBe(NPC_DRAFT.summary);
    expect(after?.body).toBe(NPC_DRAFT.body);
    if (after?.kind !== 'npc') throw new Error('the refill target is not an npc');
    expect(after.data.appearance).toBe(NPC_DRAFT.appearance);
    expect(after.data.personality).toBe(NPC_DRAFT.personality);
    // The curated stat block survives (the draft skipped its statblock step)
    // and no creature marker was invented.
    expect(after.data.statBlock?.hp).toBe(22);
    expect(after.data.creatureRef).toBeUndefined();
    expect(toastErrorMock).not.toHaveBeenCalled();
  }, 30000);
});

/**
 * The module-grounding section is pure over the stored grounding: every
 * state renders its own explicit wording (or null when not a refill).
 */
describe('moduleGroundingSection', () => {
  it('renders null when the run is not a refill', () => {
    expect(moduleGroundingSection(undefined)).toBeNull();
  });

  it('renders the mention + premise sections with the module title', () => {
    const section = moduleGroundingSection({
      status: 'ok',
      moduleTitle: 'Ashen Vault',
      contextParagraphs: 'Kael guards the door.',
      premise: 'The vault must not open.',
    });
    expect(section).toContain('"Ashen Vault"');
    expect(section).toContain('Kael guards the door.');
    expect(section).toContain('The vault must not open.');
  });

  it('names the no-mention and no-premise degrades instead of rendering empty blocks', () => {
    const section = moduleGroundingSection({
      status: 'ok',
      moduleTitle: 'Ashen Vault',
      contextParagraphs: '',
      premise: '',
    });
    expect(section).toContain('never mentions');
    expect(section).toContain('carries no spine premise');
  });

  it('names the campaign-scoped and missing-module degrades', () => {
    expect(moduleGroundingSection({ status: 'not-module-owned' })).toContain(
      'not owned by a module',
    );
    const missing = moduleGroundingSection({ status: 'module-missing', moduleId: 'abc' });
    expect(missing).toContain('no longer exists');
    expect(missing).toContain('abc');
  });
});
