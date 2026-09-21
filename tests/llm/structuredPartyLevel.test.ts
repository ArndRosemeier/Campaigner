import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { listModulesByCampaign, saveModule } from '@/db/moduleRepo';
import { getRun, listRunsByCampaign } from '@/db/runRepo';
import { createPackBook, finalizePackBook } from '@/db/rulebookRepo';
import { saveSettings } from '@/db/settingsRepo';
import {
  createModule,
  createPersona,
  defaultSettings,
  encounterDataSchema,
  modulePartSchema,
  moduleSpineSchema,
  ruleChunkSchema,
  stampNewEntity,
  statBlockSchema,
  type Id,
  type Module,
  type Persona,
  type RuleChunk,
} from '@/domain';
import { encounterGeneratorBriefSchema } from '@/llm/schemas';
import { buildEntityBrief } from '@/features/modules/persona-request';
import { sha256Hex } from '@/lib/hash';
import { runEngine, type StartRunInput } from '@/llm/runEngine';
import { chat } from '@/llm/openrouter';
import {
  encounterBudgetFor,
  encounterPartyLevel,
  fillGradeStockingFor,
  PARTY_SIZE,
  partLevelForMention,
  partLevelMentionFor,
  partyLevelLine,
} from '@/llm/roomBudget';
import { clearDatabase } from '../db/helpers';
import { useProgressStore } from '@/lib/progress';

/**
 * Structured level context (docs/11, amended by docs/17 row 291): every module
 * part has an explicit level and every table seats a party of 4 — the Smith
 * draft and the Cartographer brief carry one structured line ("party of 4
 * adventurers at level N") resolved from the referencing part, and budgets key
 * off N. The PART IS THE LEVEL: when no part mentions the encounter the ONLY
 * other source is the owner-set structured `partyLevel`, and an unset one
 * makes the run REFUSE — there is no free-text chain underneath any more.
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
}));

vi.mock('@/search', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as object), searchRules: vi.fn() };
});

const chatMock = vi.mocked(chat);
const { searchRules } = await import('@/search');
const searchRulesMock = vi.mocked(searchRules);

const INLINE_STATBLOCK = {
  system: 'dnd5e', level: '1', size: 'Medium', creatureType: 'humanoid', ac: 12,
  acNote: '', hp: 7, hpFormula: '2d6', speed: '30 ft.',
  abilities: { str: 10, dex: 12, con: 10, int: 10, wis: 10, cha: 10 },
  saves: '', skills: '', senses: '', languages: '', traits: [], actions: [], reactions: [], legendary: [], extras: {},
};

const VALID_BRIEF = {
  name: 'Ash Gate Ambush',
  summary: 'Cultists guard a ruined gate.',
  body: '# Ash Gate\nA room-by-room battle.',
  difficulty: 'hard',
  terrain: 'broken pillars',
  tactics: 'fall back through the gate',
  treasure: 'obsidian key',
  theme: 'ash-choked temple',
  styleNotes: 'inked fantasy map, volcanic stone',
  negative: 'text, labels, tokens',
  monsters: [{ name: 'Ash Cultist', count: 2, notes: '', treasure: '', statBlock: INLINE_STATBLOCK }],
  rooms: [
    { name: 'Entry', description: 'Broken doors', size: 'medium', monsterIndexes: [0], adjacentRoomIndexes: [], key: '', keyTreasure: '' },
  ],
  entryRoomIndex: 0,
};

function cartographer(): Persona {
  return createPersona({
    slug: 'encounter-cartographer-test',
    name: 'Encounter Cartographer',
    description: '',
    systemPrompt: 'Return encounter JSON.',
    mode: 'encounter',
    producesKind: 'encounter',
    builtIn: true,
  });
}

/** Two-part module: part 0 is level 2, part 1 is level 3. */
async function seedModule(campaignId: Id): Promise<Module> {
  const draft = createModule({
    campaignId,
    title: 'The Ash Descent',
    concept: 'concept',
    levelMin: 2,
    levelMax: 3,
    tone: '',
    sizeDial: 'standard',
  });
  await saveModule({
    ...draft,
    spine: moduleSpineSchema.parse({
      premise: 'Ash premise.',
      themes: [],
      partPlan: [
        { title: 'Cinder Gate', levelBand: '2', synopsis: '', levelUpTrigger: '' },
        { title: 'Ember Halls', levelBand: '3', synopsis: '', levelUpTrigger: '' },
      ],
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        markdown: 'The party reaches the gate. [[Gate Ambush]] waits beyond the doors.',
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
      modulePartSchema.parse({
        planIndex: 1,
        markdown: 'Deep inside, [[Undercroft Feast]] fills the hall with chanting.',
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
    ],
  });
  const modules = await listModulesByCampaign(campaignId);
  const module = modules.find((row) => row.title === 'The Ash Descent');
  if (module === undefined) throw new Error('seeded module missing');
  return module;
}

async function seedEncounterTarget(
  campaignId: Id,
  moduleId: Id,
  name: string,
  partyLevel: number,
): Promise<Id> {
  const target = await createArtifact({
    campaignId,
    moduleId,
    kind: 'encounter',
    name,
    summary: 'summary.',
    body: 'prose.',
    links: [],
    data: {
      difficulty: 'old', levelHint: '',
      partyLevel,
      monsters: [],
      terrain: '', tactics: '', treasure: '',
      mapImageId: null, preset: 'standard', locationKind: 'other',
      siteShape: 'single', budgetAdvisory: '', layout: null,
      fillGrade: 80,
    },
  });
  return target.id;
}

/** A dnd5e pack book with two creatures, one level 3 and one level 5, so the
 *  prompt window's ORDER reveals which target level the window resolved. */
async function seedRosterBook(): Promise<void> {
  const book = await createPackBook({ title: 'Ordering Pack', system: 'dnd5e', filename: 'pack.zip' });
  await finalizePackBook(book.id, {
    sourceId: 'foundry-pf2e',
    license: 'Community Use Policy',
    entriesImported: 2,
    entriesSkipped: 0,
    entriesFailed: 0,
  });
  const chunk = async (name: string, level: string): Promise<RuleChunk> => {
    const text = `${name}, humanoid.`;
    return ruleChunkSchema.parse({
      ...stampNewEntity(),
      bookId: book.id,
      pageStart: 1,
      pageEnd: 1,
      chunkType: 'statblock',
      headingPath: [name],
      text,
      statBlock: statBlockSchema.parse({
        system: 'dnd5e',
        level,
        size: 'Small',
        creatureType: 'humanoid',
        ac: 12,
        acNote: '',
        hp: 7,
        hpFormula: '2d6',
        speed: '30 ft.',
        abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
        saves: '',
        skills: '',
        senses: '',
        languages: '',
        traits: [],
        actions: [],
        reactions: [],
        legendary: [],
        extras: {},
      }),
      contentHash: await sha256Hex(text),
    });
  };
  await putChunks([await chunk('Near Three', '3'), await chunk('Far Five', '5')]);
}

async function briefPrompt(): Promise<string> {
  await waitFor(() => {
    expect(chatMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
  const content =
    chatMock.mock.calls[0]?.[0].find((message) => message.role === 'user')?.content ?? '';
  return typeof content === 'string' ? content : JSON.stringify(content);
}

function stockingOrThrow(fillGrade: number, level: number): string {
  const stocking = fillGradeStockingFor(fillGrade, level, encounterBudgetFor('system', 'dnd5e'));
  if (stocking === null) throw new Error(`no stocking numbers for level ${String(level)}`);
  return stocking;
}

beforeEach(async () => {
  await clearDatabase();
  useProgressStore.getState().reset();
  chatMock.mockReset();
  searchRulesMock.mockReset();
  searchRulesMock.mockResolvedValue([]);
  chatMock.mockResolvedValue({ text: JSON.stringify(VALID_BRIEF), modelUsed: 'test-model', fallback: null });
  await saveSettings({ ...defaultSettings(), openRouterApiKey: 'test-key' });
});

describe('partLevelForMention', () => {
  it('resolves the containing part exact level', async () => {
    const { id: campaignId } = await createCampaign({ name: 'C', system: 'dnd5e' });
    const module = await seedModule(campaignId);
    expect(partLevelForMention(module, 'Undercroft Feast')).toBe(3);
    expect(partLevelForMention(module, 'Gate Ambush')).toBe(2);
  });

  it('first mention wins for a twice-mentioned encounter', async () => {
    const { id: campaignId } = await createCampaign({ name: 'C', system: 'dnd5e' });
    const module = await seedModule(campaignId);
    await saveModule({
      ...module,
      parts: [
        modulePartSchema.parse({
          planIndex: 0,
          markdown: 'A rumor of [[Undercroft Feast]] reaches the gate.',
          status: 'ready',
          errorMessage: '',
          edited: false,
        }),
        ...(module.parts.filter((part) => part.planIndex === 1)),
      ],
    });
    const reloaded = (await listModulesByCampaign(campaignId)).find((row) => row.id === module.id);
    if (reloaded === undefined) throw new Error('module missing');
    expect(partLevelForMention(reloaded, 'Undercroft Feast')).toBe(2);
  });

  it('parses a multi-level band to its low end, never loudly', async () => {
    const { id: campaignId } = await createCampaign({ name: 'C', system: 'dnd5e' });
    const module = await seedModule(campaignId);
    await saveModule({
      ...module,
      spine: moduleSpineSchema.parse({
        premise: 'Ash premise.',
        themes: [],
        partPlan: [
          { title: 'Cinder Gate', levelBand: '2', synopsis: '', levelUpTrigger: '' },
          { title: 'Ember Halls', levelBand: '3-4', synopsis: '', levelUpTrigger: '' },
        ],
      }),
    });
    const reloaded = (await listModulesByCampaign(campaignId)).find((row) => row.id === module.id);
    if (reloaded === undefined) throw new Error('module missing');
    expect(partLevelForMention(reloaded, 'Undercroft Feast')).toBe(3);
  });

  it('returns undefined with no mention, no digits, or a blank name', async () => {
    const { id: campaignId } = await createCampaign({ name: 'C', system: 'dnd5e' });
    const module = await seedModule(campaignId);
    // Never mentioned anywhere in the parts.
    expect(partLevelForMention(module, 'Unmentioned Lair')).toBeUndefined();
    // A premise-only mention carries no levelBand, so it does not count.
    await saveModule({
      ...module,
      spine: moduleSpineSchema.parse({
        premise: 'Whispers of [[Premise Ghost]] haunt the road.',
        themes: [],
        partPlan: [
          { title: 'Cinder Gate', levelBand: '2', synopsis: '', levelUpTrigger: '' },
          { title: 'Ember Halls', levelBand: '3', synopsis: '', levelUpTrigger: '' },
        ],
      }),
    });
    const reloaded = (await listModulesByCampaign(campaignId)).find((row) => row.id === module.id);
    if (reloaded === undefined) throw new Error('module missing');
    expect(partLevelForMention(reloaded, 'Premise Ghost')).toBeUndefined();
    expect(partLevelForMention(reloaded, '   ')).toBeUndefined();
  });
});

describe('structured party line', () => {
  it('the party size is the constant 4', () => {
    expect(PARTY_SIZE).toBe(4);
  });

  it('partyLevelLine renders the exact structured line', () => {
    expect(partyLevelLine(3)).toBe('Party of 4 adventurers at level 3.');
  });

  it('the Smith brief carries the line for a part-mentioned encounter', async () => {
    const { id: campaignId } = await createCampaign({ name: 'C', system: 'dnd5e' });
    const module = await seedModule(campaignId);
    const brief = buildEntityBrief(
      'Undercroft Feast',
      'Deep inside, [[Undercroft Feast]] fills the hall.',
      module.spine?.premise ?? '',
      partLevelForMention(module, 'Undercroft Feast'),
    );
    expect(brief).toContain('Party of 4 adventurers at level 3.');
  });

  it('the Smith brief stays byte-identical without a structured level', () => {
    const without = buildEntityBrief('The Gray Nun', 'context', 'premise', undefined);
    expect(buildEntityBrief('The Gray Nun', 'context', 'premise', undefined)).toBe(without);
    expect(without).not.toContain('Party of');
  });
});

describe('Cartographer brief structured level', () => {
  it('carries the part level line and keys stocking off the part level', async () => {
    const campaign = await createCampaign({ name: 'Map Campaign', system: 'dnd5e' });
    const persona = cartographer();
    const { db } = await import('@/db');
    await db.personas.put(persona);
    const module = await seedModule(campaign.id);
    // Mentioned in the level-3 part, but the free-text hint says 5: the
    // structured level must win for both the line and the numbers.
    const targetId = await seedEncounterTarget(campaign.id, module.id, 'Undercroft Feast', 5);
    const runInput: StartRunInput = {
      campaign,
      persona,
      autonomy: 'manual',
      brief: 'A feast-hall fight',
      pinnedChunkIds: [],
      encounterMapAspect: '4:3',
      targetArtifactId: targetId,
    };
    await runEngine.startRun(runInput);
    const prompt = await briefPrompt();
    expect(prompt).toContain('Party of 4 adventurers at level 3.');
    expect(prompt).toContain(stockingOrThrow(80, 3));
    expect(prompt).not.toContain(stockingOrThrow(80, 5));
  });

  it('first mention wins at brief time for a twice-mentioned encounter', async () => {
    const campaign = await createCampaign({ name: 'Map Campaign', system: 'dnd5e' });
    const persona = cartographer();
    const { db } = await import('@/db');
    await db.personas.put(persona);
    const module = await seedModule(campaign.id);
    await saveModule({
      ...module,
      parts: [
        modulePartSchema.parse({
          planIndex: 0,
          markdown: 'A rumor of [[Undercroft Feast]] reaches the gate.',
          status: 'ready',
          errorMessage: '',
          edited: false,
        }),
        ...(module.parts.filter((part) => part.planIndex === 1)),
      ],
    });
    const targetId = await seedEncounterTarget(campaign.id, module.id, 'Undercroft Feast', 5);
    const runInput: StartRunInput = {
      campaign,
      persona,
      autonomy: 'manual',
      brief: 'A feast-hall fight',
      pinnedChunkIds: [],
      encounterMapAspect: '4:3',
      targetArtifactId: targetId,
    };
    await runEngine.startRun(runInput);
    const prompt = await briefPrompt();
    expect(prompt).toContain('Party of 4 adventurers at level 2.');
  });

  it('no mention falls to the OWNER-SET structured level, never a stored string (docs/17 row 291)', async () => {
    const campaign = await createCampaign({ name: 'Map Campaign', system: 'dnd5e' });
    const persona = cartographer();
    const { db } = await import('@/db');
    await db.personas.put(persona);
    const module = await seedModule(campaign.id);
    const targetId = await seedEncounterTarget(campaign.id, module.id, 'Unmentioned Lair', 5);
    const runInput: StartRunInput = {
      campaign,
      persona,
      autonomy: 'manual',
      brief: 'A lair fight',
      pinnedChunkIds: [],
      encounterMapAspect: '4:3',
      targetArtifactId: targetId,
    };
    await runEngine.startRun(runInput);
    const prompt = await briefPrompt();
    // The owner's STRUCTURED level (the row's `partyLevel`) is what sizes the
    // fight AND what the model is told. The pre-291 behaviour read a stored
    // model string through `/(\d+)/` here and rendered no structured line at
    // all — that old test pinned the DEFECT and is deliberately replaced.
    expect(prompt).toContain('Party of 4 adventurers at level 5.');
    expect(prompt).toContain(stockingOrThrow(80, 5));
  });

  it('no mention and no owner-set level REFUSES loudly (docs/17 row 291)', async () => {
    const campaign = await createCampaign({ name: 'Map Campaign', system: 'dnd5e' });
    const persona = cartographer();
    const { db } = await import('@/db');
    await db.personas.put(persona);
    const module = await seedModule(campaign.id);
    // No part mentions it, `partyLevel` is unset, and the deprecated stored
    // string is deliberately a NUMBER ("9"): nothing may read it, so the run
    // must refuse rather than size the fight at 9.
    const target = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'encounter',
      name: 'Unmentioned Lair',
      summary: 'summary.',
      body: 'prose.',
      links: [],
      data: {
        // The DEPRECATED stored string, deliberately a number ("9"): nothing
        // may read it for a level, and there is NO owner-set `partyLevel`, so
        // the run must refuse rather than size the fight at 9.
        difficulty: 'old', levelHint: '9',
        monsters: [],
        terrain: '', tactics: '', treasure: '',
        mapImageId: null, preset: 'standard', locationKind: 'other',
        siteShape: 'single', budgetAdvisory: '', layout: null,
        fillGrade: 80,
      },
    });
    const runInput: StartRunInput = {
      campaign,
      persona,
      // `auto`: an unattended run has no checkpoint to hold the failure at, so
      // the refusal lands on the run row's `errorMessage` (AGENTS rule 2).
      autonomy: 'auto',
      brief: 'A lair fight',
      pinnedChunkIds: [],
      encounterMapAspect: '4:3',
      targetArtifactId: target.id,
    };
    const runId = await runEngine.startRun(runInput);
    // The refusal lands on the run row's OWN error surface (AGENTS rule 2) —
    // never a silent, unsized generation, and never level 9.
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('failed');
    });
    const runs = await listRunsByCampaign(campaign.id);
    const failed = runs.find((row) => row.id === runId);
    expect(failed?.errorMessage).toContain('No party level is resolvable for "Unmentioned Lair"');
    expect(failed?.errorMessage).toContain('A fight is sized at the EXACT level');
  });

  it('the roster WINDOW and the brief AGREE on the party level (part level beats the owner-set level)', async () => {
    const campaign = await createCampaign({ name: 'Map Campaign', system: 'dnd5e' });
    const persona = cartographer();
    const { db } = await import('@/db');
    await db.personas.put(persona);
    await seedRosterBook();
    const module = await seedModule(campaign.id);
    // Mentioned in the level-3 part, owner-set field says 5 (the divergence
    // fixture the policy arc folded): BOTH resolvers must read 3.
    const targetId = await seedEncounterTarget(campaign.id, module.id, 'Undercroft Feast', 5);
    expect(encounterPartyLevel(module, 'Undercroft Feast', 5)).toBe(3);
    const runInput: StartRunInput = {
      campaign,
      persona,
      autonomy: 'manual',
      brief: 'A feast-hall fight',
      pinnedChunkIds: [],
      encounterMapAspect: '4:3',
      targetArtifactId: targetId,
    };
    await runEngine.startRun(runInput);
    const prompt = await briefPrompt();
    // The brief keys off the part level…
    expect(prompt).toContain('Party of 4 adventurers at level 3.');
    expect(prompt).toContain(stockingOrThrow(80, 3));
    // …and so does the roster window: the level-3 creature is NEARER than the
    // level-5 one. Under the old hint-first window resolver the order was the
    // reverse, which is exactly the two-resolver divergence this pins shut.
    expect(prompt).toContain('Near Three (3');
    expect(prompt).toContain('Far Five (5');
    expect(prompt.indexOf('Near Three')).toBeLessThan(prompt.indexOf('Far Five'));
  });

  it("states the module's recorded difficulty in the prompt the model sees (docs/17 row 190)", async () => {
    const campaign = await createCampaign({ name: 'Map Campaign', system: 'dnd5e' });
    const persona = cartographer();
    const { db } = await import('@/db');
    await db.personas.put(persona);
    const module = await seedModule(campaign.id);
    // The module ROW carries the owner's choice; the run resolves it once from
    // the owning module (never from the dialog, never per call site).
    await saveModule({ ...module, difficulty: 'much-harder' });
    const targetId = await seedEncounterTarget(campaign.id, module.id, 'Undercroft Feast', 3);
    const runInput: StartRunInput = {
      campaign,
      persona,
      autonomy: 'manual',
      brief: 'A feast-hall fight',
      pinnedChunkIds: [],
      encounterMapAspect: '4:3',
      targetArtifactId: targetId,
    };
    await runEngine.startRun(runInput);
    const prompt = await briefPrompt();
    // The clause names the owner's step AND the scaled band the deterministic
    // check actually uses (the same multiplier, through the ONE budget seam).
    expect(prompt).toContain('MODULE DIFFICULTY');
    expect(prompt).toContain('Much harder');
    expect(prompt).toContain('(targetLevel + 2) × 2');
    // The stocking numbers the brief states are the SCALED ones: at part level
    // 3 the standard 80% share would be 4.0 levels, doubled here to 8.
    expect(prompt).toContain('roughly 8 creature-levels');
  });

  it('the mentioning part is NAMED with its exact level — the read-only source the editor shows', async () => {
    const { id: campaignId } = await createCampaign({ name: 'C', system: 'dnd5e' });
    const module = await seedModule(campaignId);
    // ONE read carries BOTH facts the form needs, and it is the SAME pick the
    // run sizes the fight from: the level half is `partLevelForMention`.
    expect(partLevelMentionFor(module, 'Undercroft Feast')).toEqual({
      partTitle: 'Ember Halls',
      level: 3,
    });
    expect(partLevelMentionFor(module, 'Unmentioned Lair')).toBeUndefined();
  });

  it("stamps a target-less room from the PART's exact level, not the row's owner-set one", async () => {
    const campaign = await createCampaign({ name: 'Map Campaign', system: 'dnd5e' });
    const persona = cartographer();
    const { db } = await import('@/db');
    await db.personas.put(persona);
    const module = await seedModule(campaign.id);
    // The row's owner-set field says 5; the part that mentions the encounter is
    // banded 3. The PART wins in EVERY sizing path, and the room-stamping path
    // is the one asserted here (the brief line and the stocking numbers are
    // asserted above, and the roster window's order just below).
    const targetId = await seedEncounterTarget(campaign.id, module.id, 'Undercroft Feast', 5);
    const runInput: StartRunInput = {
      campaign,
      persona,
      autonomy: 'manual',
      brief: 'A feast-hall fight',
      pinnedChunkIds: [],
      encounterMapAspect: '4:3',
      targetArtifactId: targetId,
    };
    const runId = await runEngine.startRun(runInput);
    await waitFor(async () => {
      expect((await getRun(runId))?.steps[0]?.status).toBe('done');
    });
    const output = (await getRun(runId))?.steps[0]?.output as
      | { parsed: { rooms: { targetLevel?: number }[] } }
      | undefined;
    // The single-room brief carries no `targetLevel`, so the stamp is the ONLY
    // source of this number.
    expect(output?.parsed.rooms[0]?.targetLevel).toBe(3);
  });

  it('an OLD row with a stored levelHint loads with no error state and is never a level', () => {
    // The deprecated key ROUND-TRIPS (no migration, no error state)…
    const legacy = encounterDataSchema.parse({
      difficulty: 'old',
      levelHint: '9',
      monsters: [],
      terrain: '',
      tactics: '',
      treasure: '',
    });
    expect(legacy.levelHint).toBe('9');
    expect(legacy.partyLevel).toBeUndefined();
    // …and it is NOT a level: no mentioning part and no owner-set value means
    // the seam resolves NOTHING (the run then refuses loudly, docs/17 row 291).
    expect(encounterPartyLevel(undefined, 'Legacy Lair', legacy.partyLevel)).toBeUndefined();
  });

  it('the MODEL no longer writes a level: the reply contract drops the field entirely', () => {
    // Both spellings a reply could carry are stripped by the boundary, so a
    // model that still answers a level cannot reach the run through the reply.
    const parsed = encounterGeneratorBriefSchema.parse({
      ...VALID_BRIEF,
      levelHint: '9',
      partyLevel: 9,
    });
    expect('levelHint' in parsed).toBe(false);
    expect('partyLevel' in parsed).toBe(false);
  });

  it('both prompts build the line from the shared constant', async () => {
    const { id: campaignId } = await createCampaign({ name: 'C', system: 'dnd5e' });
    const module = await seedModule(campaignId);
    const smith = buildEntityBrief(
      'Undercroft Feast',
      'ctx',
      'premise',
      partLevelForMention(module, 'Undercroft Feast'),
    );
    expect(smith).toContain(`Party of ${String(PARTY_SIZE)} adventurers at level 3.`);
    expect(partyLevelLine(3)).toContain(String(PARTY_SIZE));
  });
});
