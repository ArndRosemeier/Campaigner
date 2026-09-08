import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { getModule, patchModule, saveModule } from '@/db/moduleRepo';
import { updateSettings } from '@/db/settingsRepo';
import {
  createModule,
  moduleSpineSchema,
  type Campaign,
  type Id,
  type ModuleEntityKind,
} from '@/domain';
import { canonicalEntityRecords, validateNormalizationReply } from '@/domain/entityNormalization';
import {
  assertEncounterMix,
  encounterMixMessage,
  encounterMixReport,
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
 * Structural conflict requirements (08-MODULE-DESIGNER M4-B): incompatible
 * wants + declared conflict kinds on encounter records, the declared mix
 * gate, part-writer enforcement (wants/kind/no-clean-resolution), and tone
 * dial teeth (banned resolutions, never register/mood).
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

const COMBAT = { name: 'Ember Trial', kind: 'encounter', wants: ['seize the bell', 'keep the bell silent'], conflictKind: 'combat' };
const HAZARD = { name: 'Flood Trial', kind: 'encounter', wants: ['cross the drowned nave', 'hold the waters back'], conflictKind: 'hazard' };
const SOCIAL = { name: 'Bell Trial', kind: 'encounter', wants: ['name the guilty warden', 'protect the wardens name'], conflictKind: 'social' };

describe('parseSpineEntities declarations', () => {
  it('parses encounter records carrying wants + kind', () => {
    expect(parseSpineEntities(spineRaw([COMBAT]))).toEqual([
      { ...COMBAT, absorbed: [] },
    ]);
  });

  it('parses non-encounters without declarations (defaults, never required)', () => {
    expect(parseSpineEntities(spineRaw([{ name: 'Kael', kind: 'npc' }]))).toEqual([
      { name: 'Kael', kind: 'npc', absorbed: [], wants: [], conflictKind: null },
    ]);
  });

  it.each([
    ['missing wants', { name: 'Ember Trial', kind: 'encounter', conflictKind: 'combat' }],
    ['one want', { ...COMBAT, wants: ['seize the bell'] }],
    ['three wants', { ...COMBAT, wants: ['a', 'b', 'c'] }],
    ['blank wants', { ...COMBAT, wants: ['seize the bell', '  '] }],
    ['missing kind', { ...COMBAT, conflictKind: null }],
    ['foreign kind', { ...COMBAT, conflictKind: 'negotiation' }],
  ])('rejects an encounter with %s (loud, never defaulted)', (_label, entity) => {
    // Shape violations throw at the zod boundary; declaration gaps throw
    // the declaration error — both loud, both on the retry-once path.
    expect(() => parseSpineEntities(spineRaw([entity]))).toThrow(/declaration|too big|invalid option/i);
  });
});

describe('encounterMixReport / assertEncounterMix', () => {
  const record = (name: string, conflictKind: ModuleEntityKind['conflictKind']): ModuleEntityKind => ({
    name,
    kind: 'encounter',
    absorbed: [],
    wants: ['a', 'b'],
    conflictKind,
  });

  it('passes on combat + hazard-or-chase + social declarations', () => {
    const kinds = [record('A', 'combat'), record('B', 'hazard'), record('C', 'social')];
    expect(encounterMixReport(kinds).missing).toEqual([]);
    expect(() => { assertEncounterMix(kinds); }).not.toThrow();
  });

  it('counts chase as hazard-or-chase', () => {
    const kinds = [record('A', 'combat'), record('B', 'chase'), record('C', 'social')];
    expect(encounterMixReport(kinds).missing).toEqual([]);
  });

  it('puzzle/exploration never satisfy the mix', () => {
    const kinds = [record('A', 'puzzle'), record('B', 'exploration')];
    expect(encounterMixReport(kinds).missing).toEqual(['combat', 'hazard-or-chase', 'social']);
    expect(() => { assertEncounterMix(kinds); }).toThrow(/combat.*hazard-or-chase.*social/);
  });

  it('names the missing groups', () => {
    const kinds = [record('A', 'combat'), record('B', 'combat')];
    expect(() => { assertEncounterMix(kinds); }).toThrow(/hazard-or-chase/);
    expect(() => { assertEncounterMix(kinds); }).toThrow(/social/);
  });

  it('fails LOUD on undeclared kinds (never a default)', () => {
    const kinds = [record('A', 'combat'), record('Mystery', null)];
    const report = encounterMixReport(kinds);
    expect(report.undeclared).toEqual(['Mystery']);
    expect(() => { assertEncounterMix(kinds); }).toThrow(/no declared conflict kind.*Mystery/);
    expect(encounterMixMessage(report)).toContain('Mystery');
  });

  it('ignores non-encounter records', () => {
    const kinds: ModuleEntityKind[] = [
      { name: 'Kael', kind: 'npc', absorbed: [], wants: [], conflictKind: null },
    ];
    expect(encounterMixReport(kinds).total).toBe(0);
  });
});

describe('canonicalEntityRecords declarations', () => {
  it('keeps the verdicts own declarations on the canonical record', () => {
    const records = canonicalEntityRecords([
      { name: 'Ember Trial', canonical: 'Ember Trial', kind: 'encounter', wants: ['a', 'b'], conflictKind: 'combat' },
    ]);
    expect(records).toEqual([
      { name: 'Ember Trial', kind: 'encounter', absorbed: [], wants: ['a', 'b'], conflictKind: 'combat' },
    ]);
  });

  it('carries planner declarations over name-only verdicts (spine path)', () => {
    const records = canonicalEntityRecords(
      [{ name: 'Ember Trial', canonical: 'Ember Trial', kind: 'encounter' }],
      [{ name: 'Ember Trial', kind: 'encounter', absorbed: [], wants: ['a', 'b'], conflictKind: 'combat' }],
    );
    expect(records[0]?.wants).toEqual(['a', 'b']);
    expect(records[0]?.conflictKind).toBe('combat');
  });

  it('matches carry-over through absorbed variants and prefers fresh verdicts', () => {
    const records = canonicalEntityRecords(
      [{ name: 'The Ember', canonical: 'Ember Trial', kind: 'encounter', wants: ['x', 'y'], conflictKind: 'chase' }],
      [{ name: 'Ember Trial', kind: 'encounter', absorbed: ['The Ember'], wants: ['stale', 'stale'], conflictKind: 'combat' }],
    );
    expect(records[0]?.wants).toEqual(['x', 'y']);
    expect(records[0]?.conflictKind).toBe('chase');
  });

  it('leaves records without any declaration source empty (gate fails loud downstream)', () => {
    const records = canonicalEntityRecords([
      { name: 'Ember Trial', canonical: 'Ember Trial', kind: 'encounter' },
    ]);
    expect(records[0]?.wants).toEqual([]);
    expect(records[0]?.conflictKind).toBeNull();
  });
});

describe('validateNormalizationReply encounter declarations', () => {
  it('is opt-in: name-only encounter verdicts pass by default (spine path)', () => {
    const violations = validateNormalizationReply(
      ['Ember Trial'],
      [{ name: 'Ember Trial', canonical: 'Ember Trial', kind: 'encounter' }],
      [],
    );
    expect(violations).toEqual([]);
  });

  it('requires wants + kind for encounters when enabled (post-parts path)', () => {
    const missing = validateNormalizationReply(
      ['Ember Trial'],
      [{ name: 'Ember Trial', canonical: 'Ember Trial', kind: 'encounter' }],
      [],
      { requireEncounterDeclarations: true },
    );
    expect(missing.some((v) => v.includes('2 wants') || v.includes('wants'))).toBe(true);
    expect(missing.some((v) => v.includes('conflict kind'))).toBe(true);
    const declared = validateNormalizationReply(
      ['Ember Trial'],
      [{ name: 'Ember Trial', canonical: 'Ember Trial', kind: 'encounter', wants: ['a', 'b'], conflictKind: 'combat' }],
      [],
      { requireEncounterDeclarations: true },
    );
    expect(declared).toEqual([]);
    // Non-encounters are never asked for declarations.
    const npc = validateNormalizationReply(
      ['Kael'],
      [{ name: 'Kael', canonical: 'Kael', kind: 'npc' }],
      [],
      { requireEncounterDeclarations: true },
    );
    expect(npc).toEqual([]);
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

describe('structural conflict gates (mocked chat)', () => {
  beforeEach(async () => {
    await clearDatabase();
    await updateSettings({ defaultChatModel: TEST_MODEL });
  });

  afterEach(() => {
    chatMock.mockReset();
  });

  async function seedModule(levelMin = 1, levelMax = 2, tone = ''): Promise<{ campaign: Campaign; moduleId: Id }> {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const saved = await saveModule(createModule({
      campaignId: campaign.id,
      title: 'The Drowned Bell',
      concept: 'A harbor bell that rings by itself beneath the water.',
      levelMin,
      levelMax,
      tone,
      sizeDial: 'standard',
    }));
    return { campaign, moduleId: saved.id };
  }

  function spineReply(entities: unknown[]): ChatResult {
    return { text: spineRaw(entities), modelUsed: 'test-model', fallback: null };
  }

  function normReply(entries: { name: string; kind: string }[]): ChatResult {
    return {
      text: JSON.stringify({
        entities: entries.map((entry) => ({ name: entry.name, canonical: entry.name, kind: entry.kind })),
      }),
      modelUsed: 'test-model',
      fallback: null,
    };
  }

  function userPromptOf(callIndex: number): string {
    const messages = chatMock.mock.calls[callIndex]?.[0] ?? [];
    const content = messages.find((message) => message.role === 'user')?.content;
    return typeof content === 'string' ? content : '';
  }

  it('spine gate: well-formed declarations with a broken mix → one repair naming the mix, then draft', async () => {
    const { campaign, moduleId } = await seedModule();
    const brokenMix = [
      { ...COMBAT },
      { name: 'Second Skirmish', kind: 'encounter', wants: ['hold the gate', 'storm the gate'], conflictKind: 'combat' },
    ];
    chatMock
      .mockResolvedValueOnce(spineReply(brokenMix))
      .mockResolvedValueOnce(normReply([
        { name: 'Ember Trial', kind: 'encounter' },
        { name: 'Second Skirmish', kind: 'encounter' },
      ]))
      .mockResolvedValueOnce(spineReply([{ name: 'Warden Bellamy', kind: 'npc' }, COMBAT, HAZARD, SOCIAL]))
      .mockResolvedValueOnce(normReply([
        { name: 'Warden Bellamy', kind: 'npc' },
        { name: 'Ember Trial', kind: 'encounter' },
        { name: 'Flood Trial', kind: 'encounter' },
        { name: 'Bell Trial', kind: 'encounter' },
      ]));

    const finished = await runSpine(moduleId, campaign);

    expect(chatMock).toHaveBeenCalledTimes(4); // exactly one repair retry
    expect(finished.status).toBe('draft');
    expect(finished.entityKinds.filter((entry) => entry.kind === 'encounter')).toHaveLength(3);
    // The repair nudge names the mix defect (authored kinds, honestly counted).
    const repairPrompt = chatMock.mock.calls[2]?.[0].at(-1)?.content;
    expect(typeof repairPrompt === 'string' && repairPrompt).toContain('hazard-or-chase');
  }, 20000);

  it('spine gate: mix still broken after the repair → loud spine failure', async () => {
    const { campaign, moduleId } = await seedModule();
    const brokenMix = [
      { ...COMBAT },
      { name: 'Second Skirmish', kind: 'encounter', wants: ['hold the gate', 'storm the gate'], conflictKind: 'combat' },
    ];
    chatMock
      .mockResolvedValueOnce(spineReply(brokenMix))
      .mockResolvedValueOnce(normReply([
        { name: 'Ember Trial', kind: 'encounter' },
        { name: 'Second Skirmish', kind: 'encounter' },
      ]))
      .mockResolvedValueOnce(spineReply(brokenMix))
      .mockResolvedValueOnce(normReply([
        { name: 'Ember Trial', kind: 'encounter' },
        { name: 'Second Skirmish', kind: 'encounter' },
      ]));

    await expect(runSpine(moduleId, campaign)).rejects.toThrow(/mix not met/);

    expect((await getModule(moduleId))?.status).toBe('failed');
    expect(chatMock).toHaveBeenCalledTimes(4); // exactly one repair retry
  }, 20000);

  it('spine prompt carries incompatible-wants, declarations, and the tone bans', async () => {
    const { campaign, moduleId } = await seedModule(1, 2, 'horror');
    chatMock
      .mockResolvedValueOnce(spineReply([{ name: 'Warden Bellamy', kind: 'npc' }, COMBAT, HAZARD, SOCIAL]))
      .mockResolvedValueOnce(normReply([
        { name: 'Warden Bellamy', kind: 'npc' },
        { name: 'Ember Trial', kind: 'encounter' },
        { name: 'Flood Trial', kind: 'encounter' },
        { name: 'Bell Trial', kind: 'encounter' },
      ]));

    await runSpine(moduleId, campaign);

    const prompt = userPromptOf(0);
    expect(prompt).toContain('mutually exclusive wants');
    expect(prompt).toContain('conflict kind');
    expect(prompt).toContain('the mix is gated from these declarations');
    // Generic bans always render; the module tone's bans render on match.
    for (const ban of MODULE_TONE_GENERIC_BANS) expect(prompt).toContain(ban);
    for (const ban of MODULE_TONE_BANS.horror ?? []) expect(prompt).toContain(ban);
  }, 20000);

  it('part prompt carries declared wants/kind plus no-clean-resolution (finale rationed)', async () => {
    const { campaign, moduleId } = await seedModule();
    const saved = await getModule(moduleId);
    if (saved === undefined) throw new Error('seed module is missing');
    await patchModule(moduleId, {
      spine: moduleSpineSchema.parse({
        premise: 'A harbor town raised its bell.',
        themes: [],
        partPlan: [
          { title: 'The Sunken Quarter', levelBand: '1', synopsis: 'Arrival.', levelUpTrigger: 'Found.' },
          { title: 'The Drowned Cathedral', levelBand: '2', synopsis: 'Descent.', levelUpTrigger: 'Falls.' },
        ],
      }),
      // Planner declarations the prose must honor.
      entityKinds: [
        { name: 'Ember Trial', kind: 'encounter', absorbed: [], wants: ['seize the bell', 'keep the bell silent'], conflictKind: 'combat' },
        { name: 'Bell Trial', kind: 'encounter', absorbed: [], wants: ['name the guilty warden', 'protect the wardens name'], conflictKind: 'social' },
      ],
    });
    const prose = (marker: string): ChatResult => ({
      text: `${marker}: The tide withdraws and the streets shine wet under a pale sun. `.repeat(4),
      modelUsed: 'test-model',
      fallback: null,
    });
    chatMock.mockResolvedValue(prose('PART'));

    // Non-finale part: declarations + no-clean-resolution.
    await runParts(moduleId, campaign, { planIndexes: [0] });
    const first = userPromptOf(0);
    expect(first).toContain('seize the bell');
    expect(first).toContain('keep the bell silent');
    expect(first).toContain('no clean resolution');
    expect(first).not.toContain('FINALE');

    // Finale part: satisfaction allowed at full price, never rationed away.
    chatMock.mockClear();
    chatMock.mockResolvedValue(prose('FINALE-PART'));
    await runParts(moduleId, campaign, { planIndexes: [1] });
    const finale = userPromptOf(0);
    expect(finale).toContain('FINALE');
    expect(finale).toContain('full price');
    expect(finale).not.toContain('no clean resolution');
  }, 20000);

  it('parts gate: floor met but mix drifted → loud mix failure naming the defect', async () => {
    const { campaign, moduleId } = await seedModule();
    await patchModule(moduleId, {
      spine: moduleSpineSchema.parse({
        premise: 'A harbor town raised its bell.',
        themes: [],
        partPlan: [
          { title: 'The Sunken Quarter', levelBand: '1', synopsis: 'Arrival.', levelUpTrigger: 'Found.' },
          { title: 'The Drowned Cathedral', levelBand: '2', synopsis: 'Descent.', levelUpTrigger: 'Falls.' },
        ],
      }),
    });
    const prose = (marker: string, ...names: string[]): ChatResult => ({
      text: `${marker}: The tide withdraws and the streets shine wet under a pale sun. `.repeat(4) +
        (names.length === 0 ? '' : ` Trials: ${names.map((name) => `[[${name}]]`).join(', ')}.`),
      modelUsed: 'test-model',
      fallback: null,
    });
    chatMock
      .mockResolvedValueOnce(prose('PART-ONE', 'Ember Trial'))
      .mockResolvedValueOnce(prose('PART-TWO', 'Second Skirmish'))
      // Post-parts verdicts declare two combats — the prose drifted from the
      // planned mix (social/hazard never made the text).
      .mockResolvedValueOnce({
        text: JSON.stringify({
          entities: [
            { name: 'Ember Trial', canonical: 'Ember Trial', kind: 'encounter', wants: ['seize the bell', 'keep the bell silent'], conflictKind: 'combat' },
            { name: 'Second Skirmish', canonical: 'Second Skirmish', kind: 'encounter', wants: ['hold the gate', 'storm the gate'], conflictKind: 'combat' },
          ],
        }),
        modelUsed: 'test-model',
        fallback: null,
      });

    const finished = await runParts(moduleId, campaign);

    // Bands are met (1 encounter each) but the declared mix is combat-only:
    // loud, never ready, defect named.
    expect(finished.status).toBe('failed');
    expect(finished.errorMessage).toContain('mix not met');
    expect(finished.errorMessage).toContain('hazard-or-chase');
  }, 20000);
});
