import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { patchModule, saveModule } from '@/db/moduleRepo';
import { updateSettings } from '@/db/settingsRepo';
import {
  createModule,
  moduleEntityKindSchema,
  moduleSpineSchema,
  type Campaign,
  type Id,
} from '@/domain';
import { normalizationReplySchema } from '@/domain/entityNormalization';
import {
  MODULE_TONE_BANS,
  MODULE_TONE_GENERIC_BANS,
  parseSpineEntities,
  runParts,
  runSpine,
  toneBansFor,
} from '@/llm/moduleGen';
import { clearDatabase } from '../db/helpers';
import type { ChatResult } from '@/llm/openrouter';

/**
 * The conflict contract after the retirement (08-MODULE-DESIGNER M4-B,
 * superseded; docs/17): the conflict-kind vocabulary, the mutually exclusive
 * `wants` pair, the declared mix and their gates are GONE. What a scene IS —
 * a fight (an encounter) or anything else (an `event`) — is the planner's
 * contract, and whether the story's conflict is real is prompt discipline: a
 * check over prose would need a classifier guessing at a gate, which this repo
 * forbids.
 *
 * What this file holds: the REMOVAL (nothing of the vocabulary is reachable,
 * and a plan whose encounters declare nothing generates cleanly), the
 * LEGACY-ROW tolerance (stored keys are stripped, never a parse failure, no
 * migration), and the SURVIVORS that were never part of the mix machinery —
 * the tone dial's banned resolutions and the finale's rationed satisfaction.
 * The encounter FLOOR has its own suite
 * (`moduleGen-encounter-floor.test.ts`) and is untouched.
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {
    constructor() {
      super('No OpenRouter API key configured');
      this.name = 'MissingApiKeyError';
    }
  },
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
}));

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  runModulePostGeneration: vi.fn(),
}));

vi.mock('@/features/modules/post-generation', () => ({
  runModulePostGeneration: mocks.runModulePostGeneration,
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);

const TEST_MODEL = 'test/fixture-model';

function spineRaw(entities: unknown[]): string {
  return JSON.stringify({
    premise: 'A harbor town raised its bell to warn of the drownings.',
    themes: ['duty'],
    partPlan: [
      { title: 'The Sunken Quarter', levelBand: '1', synopsis: 'Arrival.', levelUpTrigger: 'Found.' },
      { title: 'The Drowned Cathedral', levelBand: '2', synopsis: 'Descent.', levelUpTrigger: 'Falls.' },
    ],
    entities,
  });
}

/** A normalization reply mapping every listed name to itself. */
function normReply(entries: { name: string; kind: string }[]): ChatResult {
  return {
    text: JSON.stringify({
      entities: entries.map((entry) => ({
        name: entry.name,
        canonical: entry.name,
        kind: entry.kind,
      })),
    }),
    modelUsed: 'test-model',
    fallback: null,
  };
}

/** The entity list of a plan that declares KINDS ONLY — no wants, no conflict
 * kind (the shape the retired declaration validation used to reject loudly). */
const PLAIN_ENTITIES = [
  { name: 'Warden Bellamy', kind: 'npc' },
  { name: 'Ember Trial', kind: 'encounter' },
];

describe('the retired mix machinery is unreachable', () => {
  /** The generation path that used to carry the vocabulary, the declaration
   * option and the mix counters. A grep-level pin: an import would otherwise
   * linger and quietly re-open the seam. */
  const SOURCES = [
    'src/domain/module.ts',
    'src/domain/entityNormalization.ts',
    'src/llm/moduleGen.ts',
    'src/features/modules/post-generation.ts',
  ];
  const RETIRED = [
    /conflictKind\s*:/,
    /\bwants\s*:/,
    /ENCOUNTER_CONFLICT_KINDS/,
    /EncounterConflictKind/,
    /encounterMix/,
    /requireEncounterDeclarations/,
    /assertEncounterMix/,
  ];

  it('is not exported by the domain or the generator any more', async () => {
    const domain = await import('@/domain');
    const gen = await import('@/llm/moduleGen');
    expect(Object.keys(domain)).not.toContain('ENCOUNTER_CONFLICT_KINDS');
    for (const gone of ['assertEncounterMix', 'encounterMixReport', 'encounterMixMessage']) {
      expect(Object.keys(gen)).not.toContain(gone);
    }
    // The record shape itself is name + kind + absorbed, nothing else.
    expect(
      Object.keys(moduleEntityKindSchema.parse({ name: 'Ember Trial', kind: 'encounter' })),
    ).toEqual(['name', 'kind', 'absorbed']);
  });

  it('names no conflict-kind / wants / mix identifier in the generation path', () => {
    for (const file of SOURCES) {
      const text = readFileSync(join(process.cwd(), file), 'utf8');
      for (const pattern of RETIRED) {
        expect(text, `${file} still matches ${String(pattern)}`).not.toMatch(pattern);
      }
    }
  });

  it('strips the retired keys from stored records and normalization replies (no migration)', () => {
    // The owner's testing-phase stance: no migration ceremony. These rows are
    // simply READ through a non-strict schema, which drops the removed keys —
    // an existing module is never a parse failure.
    const record = moduleEntityKindSchema.parse({
      name: 'Ember Trial',
      kind: 'encounter',
      wants: ['seize the bell', 'keep the bell silent'],
      conflictKind: 'combat',
    });
    expect(record).toEqual({ name: 'Ember Trial', kind: 'encounter', absorbed: [] });

    const reply = normalizationReplySchema.parse({
      entities: [
        {
          name: 'Ember Trial',
          canonical: 'Ember Trial',
          kind: 'encounter',
          wants: ['a', 'b'],
          conflictKind: 'combat',
        },
      ],
    });
    expect(reply.entities[0]).toEqual({
      name: 'Ember Trial',
      canonical: 'Ember Trial',
      kind: 'encounter',
    });
  });
});

describe('tone dial teeth', () => {
  it('enumerates 2-3 banned resolutions per tone value (outcome bans only)', () => {
    for (const [tone, bans] of Object.entries(MODULE_TONE_BANS)) {
      expect(tone).not.toBe('');
      expect(bans.length).toBeGreaterThanOrEqual(2);
      expect(bans.length).toBeLessThanOrEqual(3);
      for (const ban of bans) {
        expect(typeof ban).toBe('string');
        expect(ban.trim()).not.toBe('');
      }
    }
    expect(MODULE_TONE_GENERIC_BANS.length).toBeGreaterThanOrEqual(2);
  });

  it('matches tones case-insensitively, unknown tones get null (generic bans only)', () => {
    expect(toneBansFor('  HORROR ')).toEqual(MODULE_TONE_BANS.horror);
    expect(toneBansFor('eerie')).toBeNull();
    expect(toneBansFor('')).toBeNull();
  });
});

describe('a plan that declares no kinds and no wants (mocked chat)', () => {
  beforeEach(async () => {
    await clearDatabase();
    await updateSettings({ defaultChatModel: TEST_MODEL });
  });

  afterEach(() => {
    chatMock.mockReset();
  });

  async function seedModule(
    levelMin = 1,
    levelMax = 2,
    tone = '',
  ): Promise<{ campaign: Campaign; moduleId: Id }> {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const saved = await saveModule(
      createModule({
        campaignId: campaign.id,
        title: 'The Drowned Bell',
        concept: 'A harbor bell that rings by itself beneath the water.',
        levelMin,
        levelMax,
        tone,
        sizeDial: 'standard',
      }),
    );
    return { campaign, moduleId: saved.id };
  }

  function spineReply(entities: unknown[]): ChatResult {
    return { text: spineRaw(entities), modelUsed: 'test-model', fallback: null };
  }

  function userPromptOf(callIndex: number): string {
    const messages = chatMock.mock.calls[callIndex]?.[0] ?? [];
    const content = messages.find((message) => message.role === 'user')?.content;
    return typeof content === 'string' ? content : '';
  }

  /** Part prose with wiki-links to the given names (floor-satisfying text). */
  function prose(marker: string, ...names: string[]): ChatResult {
    return {
      text:
        `${marker}: The tide withdraws and the streets shine wet under a pale sun. `.repeat(4) +
        (names.length === 0 ? '' : ` Trials: ${names.map((name) => `[[${name}]]`).join(', ')}.`),
      modelUsed: 'test-model',
      fallback: null,
    };
  }

  function twoPartSpine(moduleId: Id): Promise<unknown> {
    return patchModule(moduleId, {
      spine: moduleSpineSchema.parse({
        premise: 'A harbor town raised its bell.',
        themes: [],
        partPlan: [
          { title: 'The Sunken Quarter', levelBand: '1', synopsis: 'Arrival.', levelUpTrigger: 'Found.' },
          { title: 'The Drowned Cathedral', levelBand: '2', synopsis: 'Descent.', levelUpTrigger: 'Falls.' },
        ],
      }),
      entityKinds: [
        { name: 'Ember Trial', kind: 'encounter', absorbed: [] },
        { name: 'Flood Trial', kind: 'encounter', absorbed: [] },
      ],
    });
  }

  it('spine: an encounter record with no wants and no kind passes the gate untouched', async () => {
    const { campaign, moduleId } = await seedModule();
    chatMock
      .mockResolvedValueOnce(spineReply(PLAIN_ENTITIES))
      .mockResolvedValueOnce(
        normReply([
          { name: 'Warden Bellamy', kind: 'npc' },
          { name: 'Ember Trial', kind: 'encounter' },
        ]),
      );

    const finished = await runSpine(moduleId, campaign);

    // Two calls: the spine and its name normalization. No repair retry — the
    // records declare nothing and nothing is missing.
    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(finished.status).toBe('draft');
    expect(finished.errorMessage).toBe('');
    expect(finished.entityKinds).toEqual([
      { name: 'Warden Bellamy', kind: 'npc', absorbed: [] },
      { name: 'Ember Trial', kind: 'encounter', absorbed: [] },
    ]);

    // The prompt asks for kinds and the floor, and for no declarations.
    const prompt = userPromptOf(0);
    expect(prompt).toContain('encounter floor');
    expect(prompt).not.toContain('mutually exclusive wants');
    expect(prompt).not.toContain('conflict kind');
    expect(prompt).not.toContain('declared mix');
    expect(prompt).not.toContain('"wants"');
    expect(prompt).not.toContain('"conflictKind"');

    // The encounter/event boundary (08 §M4-B, superseded): an encounter IS a
    // fight — battle map + monster roster — and everything else is an event.
    expect(prompt).toContain('locations, NPCs, factions, notes, events, and encounters');
    expect(prompt).toContain('An "encounter" is a FIGHT');
    expect(prompt).toContain('battle map with terrain, and a monster roster with images');
    expect(prompt).toContain('is an "event" instead');
    expect(prompt).toContain('no battle map, no monsters, no roster');

    // The normalization call carries the same boundary: classify by what the
    // party DOES, never by how dangerous the scene sounds.
    const normalizationPrompt = userPromptOf(1);
    expect(normalizationPrompt).toContain('"encounter" = a FIGHT');
    expect(normalizationPrompt).toContain('"event" = a non-combat scene the party plays through');
    expect(normalizationPrompt).toContain('if no fight happens, it is an event');
  }, 20000);

  it('parts: a full run over such a plan ships ready with no repair', async () => {
    const { campaign, moduleId } = await seedModule();
    await twoPartSpine(moduleId);
    chatMock
      .mockResolvedValueOnce(prose('PART-ONE', 'Ember Trial'))
      .mockResolvedValueOnce(prose('PART-TWO', 'Flood Trial'))
      .mockResolvedValueOnce(
        normReply([
          { name: 'Ember Trial', kind: 'encounter' },
          { name: 'Flood Trial', kind: 'encounter' },
        ]),
      );

    const finished = await runParts(moduleId, campaign);

    // Two parts + one normalization: no floor repair, no mix failure.
    expect(chatMock).toHaveBeenCalledTimes(3);
    expect(finished.status).toBe('ready');
    expect(finished.errorMessage).toBe('');

    // The part prompt carries no declaration block any more.
    const prompt = userPromptOf(0);
    expect(prompt).not.toContain('Declared encounters');
    expect(prompt).not.toContain('declared conflict kind');
    expect(prompt).not.toContain('opposed wants');
    // The banned resolutions survived the removal (a scene still must cost
    // someone something).
    expect(prompt).toContain('banned resolution');
    // …and so did the encounter/event boundary: a non-fight is an event, with
    // an illustration and no map, monsters or roster.
    expect(prompt).toContain('A scene that is NOT a fight is an event');
    expect(prompt).toContain('[[Event Name]]');
    expect(prompt).toContain('no battle map, no monsters, no roster, because none is generated for it');
  }, 20000);

  it('part prompt: the finale rations satisfaction, other parts never resolve clean', async () => {
    const { campaign, moduleId } = await seedModule();
    await twoPartSpine(moduleId);

    chatMock.mockResolvedValue(prose('PART', 'Ember Trial'));
    await runParts(moduleId, campaign, { planIndexes: [0] });
    const first = userPromptOf(0);
    expect(first).toContain('no clean resolution');
    expect(first).not.toContain('FINALE');

    chatMock.mockClear();
    chatMock.mockResolvedValue(prose('FINALE-PART', 'Flood Trial'));
    await runParts(moduleId, campaign, { planIndexes: [1] });
    const finale = userPromptOf(0);
    expect(finale).toContain('FINALE');
    expect(finale).toContain('full price');
    expect(finale).not.toContain('no clean resolution');
  }, 20000);

  it('spine repair names the floor only (no wants, no kinds, no mix)', async () => {
    const { campaign, moduleId } = await seedModule();
    chatMock
      .mockResolvedValueOnce(spineReply([{ name: 'Warden Bellamy', kind: 'npc' }]))
      .mockResolvedValueOnce(normReply([{ name: 'Warden Bellamy', kind: 'npc' }]))
      // The repair retry, whose reply finally declares an encounter.
      .mockResolvedValueOnce(spineReply(PLAIN_ENTITIES))
      .mockResolvedValueOnce(
        normReply([
          { name: 'Warden Bellamy', kind: 'npc' },
          { name: 'Ember Trial', kind: 'encounter' },
        ]),
      );

    const finished = await runSpine(moduleId, campaign);

    expect(chatMock).toHaveBeenCalledTimes(4);
    expect(finished.status).toBe('draft');
    expect(finished.entityKinds.map((entry) => entry.kind)).toEqual(['npc', 'encounter']);
    const repair = chatMock.mock.calls[2]?.[0].at(-1)?.content;
    const repairText = typeof repair === 'string' ? repair : '';
    expect(repairText).toContain('declares no encounters');
    // The repair nudge asks for a named encounter, never for a declaration.
    expect(repairText).not.toContain('conflict kind');
    expect(repairText).not.toContain('wants');
  }, 20000);

  it('parseSpineEntities accepts any declared kind list and adds no declaration rule', () => {
    expect(parseSpineEntities(spineRaw(PLAIN_ENTITIES))).toEqual([
      { name: 'Warden Bellamy', kind: 'npc', absorbed: [] },
      { name: 'Ember Trial', kind: 'encounter', absorbed: [] },
    ]);
    // A declaration that used to be REQUIRED is now ordinary input, ignored.
    expect(
      parseSpineEntities(
        spineRaw([{ name: 'Ember Trial', kind: 'encounter', wants: ['a', 'b'], conflictKind: 'combat' }]),
      ),
    ).toEqual([{ name: 'Ember Trial', kind: 'encounter', absorbed: [] }]);
    // A foreign kind is still a loud boundary failure (zod, not a gate).
    expect(() => parseSpineEntities(spineRaw([{ name: 'X', kind: 'plotarc' }]))).toThrow();
  });
});
