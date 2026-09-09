import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { listModulesByCampaign, saveModule } from '@/db/moduleRepo';
import { saveSettings } from '@/db/settingsRepo';
import {
  createModule,
  createPersona,
  defaultSettings,
  modulePartSchema,
  moduleSpineSchema,
  type Id,
  type Module,
  type Persona,
} from '@/domain';
import { buildEntityBrief } from '@/features/modules/persona-request';
import { runEngine, type StartRunInput } from '@/llm/runEngine';
import { chat } from '@/llm/openrouter';
import {
  fillGradeStockingFor,
  PARTY_SIZE,
  partLevelForMention,
  partyLevelLine,
} from '@/llm/roomBudget';
import { clearDatabase } from '../db/helpers';
import { useProgressStore } from '@/lib/progress';

/**
 * Structured level context (docs/11): every module part has an explicit
 * level and every table seats a party of 4 — the Smith draft and the
 * Cartographer brief carry one structured line ("party of 4 adventurers at
 * level N") resolved from the referencing part, and budgets key off N with
 * the free-text chain underneath as fallback.
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
  levelHint: '4',
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
  levelHint: string,
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
      difficulty: 'old', levelHint,
      monsters: [],
      terrain: '', tactics: '', treasure: '',
      mapImageId: null, preset: 'standard', locationKind: 'other',
      siteShape: 'single', budgetAdvisory: '', layout: null,
      fillGrade: 80,
    },
  });
  return target.id;
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
  const stocking = fillGradeStockingFor(fillGrade, level, 'dnd5e');
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
    const targetId = await seedEncounterTarget(campaign.id, module.id, 'Undercroft Feast', '5');
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
    const targetId = await seedEncounterTarget(campaign.id, module.id, 'Undercroft Feast', '5');
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

  it('no mention falls back byte-identical to the levelHint chain', async () => {
    const campaign = await createCampaign({ name: 'Map Campaign', system: 'dnd5e' });
    const persona = cartographer();
    const { db } = await import('@/db');
    await db.personas.put(persona);
    const module = await seedModule(campaign.id);
    const targetId = await seedEncounterTarget(campaign.id, module.id, 'Unmentioned Lair', '5');
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
    expect(prompt).not.toContain('Party of');
    // The parsed levelHint drives, exactly as today.
    expect(prompt).toContain(stockingOrThrow(80, 5));
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
