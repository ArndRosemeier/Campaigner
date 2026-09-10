import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { getModule, patchModule, saveModule } from '@/db/moduleRepo';
import {
  createModule,
  defaultEncounterFloorGuardrail,
  encounterFloorGuardrailFor,
  encounterFloorGuardrailSchema,
  moduleSchema,
  moduleSpineSchema,
  type Campaign,
  type EncounterFloorGuardrail,
  type Id,
  type Module,
  type ModuleEntityKind,
} from '@/domain';
import {
  assertEncounterFloor,
  countModuleEncounters,
  encounterFloorMessage,
  runParts,
  runSpine,
} from '@/llm/moduleGen';
import { clearDatabase } from '../db/helpers';

/**
 * The editable encounter floor (08-MODULE-DESIGNER M4-B, amended; docs/17): the
 * ONE source of truth for the floor clause AND the floor gate.
 *
 * The GOLDEN half is the regression contract: the fixture files under
 * `tests/fixtures/encounterGuardrails/` were captured by RENDERING the
 * pre-change prompt builders at commit 89e5d71 (a temporary worktree at HEAD,
 * driving the real `runSpine` + `runParts` against mocked chat replies) — not
 * transcribed by hand. Under the default floor every rendered string and every
 * failure message must stay byte-identical to those files.
 *
 * The CUSTOM half pins the new behavior: a raised `perLevel` multiplies the
 * requirement AND says so in the prompt and the message, a disabled floor
 * removes the clause and the gate, the boundary refuses bad numbers loudly, and
 * the floor a later pass reads is the MODULE's own recorded one.
 *
 * Floor-only by design: the declared-mix gate and the conflict-kind vocabulary
 * are a separate seam, and nothing here configures, asserts or touches them.
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

const FIXTURE_DIR = join(process.cwd(), 'tests', 'fixtures', 'encounterGuardrails');

function golden(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

/** Anchored equality: the golden text must appear BYTE-EXACT, and the anchor
 * tells us it is the same region of the prompt (not a coincidence elsewhere). */
function expectEmbedded(haystack: string, goldenText: string): void {
  const at = haystack.indexOf(goldenText);
  expect(at, 'golden text not found byte-exact in the rendered prompt').toBeGreaterThanOrEqual(0);
}

const SPINE_PLAN = [
  {
    title: 'The Sunken Quarter',
    levelBand: '1',
    synopsis: 'Arrival.',
    levelUpTrigger: 'Found.',
  },
  {
    title: 'The Drowned Cathedral',
    levelBand: '2',
    synopsis: 'Descent.',
    levelUpTrigger: 'Falls.',
  },
];

const MIX_SPINE = [
  {
    name: 'Ember Trial',
    kind: 'encounter',
    wants: ['seize the bell', 'keep the bell silent'],
    conflictKind: 'combat',
  },
  {
    name: 'Flood Trial',
    kind: 'encounter',
    wants: ['cross the drowned nave', 'hold the waters back'],
    conflictKind: 'hazard',
  },
  {
    name: 'Bell Trial',
    kind: 'encounter',
    wants: ['name the guilty warden', 'protect the wardens name'],
    conflictKind: 'social',
  },
];

function spineReply(entities: unknown[]): string {
  return JSON.stringify({
    premise: 'A harbor town raised its bell to warn of the drownings.',
    themes: ['duty'],
    partPlan: SPINE_PLAN,
    entities,
  });
}

function normReply(entities: { name: string; kind: string }[]): string {
  return JSON.stringify({
    entities: entities.map((entry) => ({ ...entry, canonical: entry.name })),
  });
}

/** The campaign + module the golden capture used (levels 1-2, tone eerie). */
async function seedModule(
  options: { floor?: EncounterFloorGuardrail } = {},
): Promise<{ campaign: Campaign; moduleId: Id }> {
  const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
  const draft = createModule({
    campaignId: campaign.id,
    title: 'The Drowned Bell',
    concept: 'A harbor bell that rings by itself beneath the water.',
    levelMin: 1,
    levelMax: 2,
    tone: 'eerie',
    sizeDial: 'standard',
    ...(options.floor === undefined ? {} : { encounterFloorGuardrail: options.floor }),
  });
  const saved = await saveModule(draft);
  return { campaign, moduleId: saved.id };
}

/** The spine reply the mocked chat returns first, then the normalization reply. */
function queueSpineReplies(): void {
  chatMock
    .mockResolvedValueOnce({
      text: spineReply(MIX_SPINE),
      modelUsed: 'test-model',
      fallback: null,
    })
    .mockResolvedValueOnce({
      text: normReply(MIX_SPINE.map((entry) => ({ name: entry.name, kind: entry.kind }))),
      modelUsed: 'test-model',
      fallback: null,
    });
}

/** The first user message of the nth chat call (the rendered prompt). */
function promptText(call = 0): string {
  const messages = chatMock.mock.calls[call]?.[0] as
    | { role: string; content: unknown }[]
    | undefined;
  const user = messages?.find((message) => message.role === 'user');
  return typeof user?.content === 'string' ? user.content : '';
}

/** Prompt text of a call whose content contains an anchor. */
function promptContaining(anchor: string): string {
  for (const call of chatMock.mock.calls) {
    const messages = call[0] as { role: string; content: unknown }[];
    const user = messages.find((message) => message.role === 'user');
    const text = typeof user?.content === 'string' ? user.content : '';
    if (text.includes(anchor)) return text;
  }
  return '';
}

const encounter = (
  name: string,
  conflictKind: ModuleEntityKind['conflictKind'],
): ModuleEntityKind => ({
  name,
  kind: 'encounter',
  absorbed: [],
  wants: ['a', 'b'],
  conflictKind,
});

/** An in-memory module with a 2-part plan and given part marks (no DB). */
function floorModule(options: {
  floor?: EncounterFloorGuardrail | undefined;
  parts?: { planIndex: number; names: string[] }[];
  entityKinds?: ModuleEntityKind[];
}): Module {
  const base = createModule({
    campaignId: '123e4567-e89b-42d3-a456-426614174000',
    title: 'Floor Test',
    concept: 'concept',
    levelMin: 1,
    levelMax: 2,
    sizeDial: 'standard',
    ...(options.floor === undefined ? {} : { encounterFloorGuardrail: options.floor }),
  });
  return {
    ...base,
    spine: moduleSpineSchema.parse({
      premise: 'A quiet premise.',
      themes: [],
      partPlan: SPINE_PLAN,
    }),
    parts: (options.parts ?? []).map((part) => ({
      planIndex: part.planIndex,
      markdown: `Trials: ${part.names.map((name) => `[[${name}]]`).join(', ')}.`,
      status: 'ready' as const,
      errorMessage: '',
      edited: false,
    })),
    entityKinds: options.entityKinds ?? [],
  };
}

beforeEach(() => clearDatabase());
afterEach(() => {
  // resetAllMocks (not just clearAllMocks): a `mockResolvedValue` default set in
  // one test must not leak a prose reply into the next test's spine call.
  vi.resetAllMocks();
});

describe('floor schema (the boundary refuses invalid numbers loudly)', () => {
  it('rejects a negative or fractional count', () => {
    expect(() => encounterFloorGuardrailSchema.parse({ enabled: true, perLevel: -1 })).toThrow();
    expect(() => encounterFloorGuardrailSchema.parse({ enabled: true, perLevel: 1.5 })).toThrow();
  });

  it('rejects an enabled floor with perLevel 0, and accepts a disabled one', () => {
    expect(() => encounterFloorGuardrailSchema.parse({ enabled: true, perLevel: 0 })).toThrow(
      /perLevel must be >= 1/,
    );
    expect(encounterFloorGuardrailSchema.parse({ enabled: false, perLevel: 0 })).toEqual({
      enabled: false,
      perLevel: 0,
    });
  });

  it('materializes the defaults around a partial object', () => {
    expect(encounterFloorGuardrailSchema.parse({})).toEqual({ enabled: true, perLevel: 1 });
    expect(encounterFloorGuardrailSchema.parse({ perLevel: 3 })).toEqual({
      enabled: true,
      perLevel: 3,
    });
  });

  it('the default reproduces today exactly', () => {
    expect(defaultEncounterFloorGuardrail()).toEqual({ enabled: true, perLevel: 1 });
  });
});

describe('golden: the default floor renders today, byte for byte', () => {
  it('spine prompt keeps the exact pre-change wording', async () => {
    const { campaign, moduleId } = await seedModule();
    queueSpineReplies();

    await runSpine(moduleId, campaign);

    expectEmbedded(promptText(0), golden('spine-guardrail-default.txt'));
  }, 20_000);

  it('parts prompt keeps the exact pre-change wording', async () => {
    const { campaign, moduleId } = await seedModule();
    await patchModule(moduleId, {
      spine: moduleSpineSchema.parse({
        premise: 'A harbor town raised its bell to warn of the drownings.',
        themes: ['duty'],
        partPlan: SPINE_PLAN,
      }),
    });
    chatMock.mockResolvedValue({
      text: `${'The tide withdraws. '.repeat(20)}\n`,
      modelUsed: 'test-model',
      fallback: null,
    });

    await runParts(moduleId, campaign);

    const full = promptContaining('Writing instructions:');
    // The fixture is the TRUE pre-change bytes, quirk included (the stray blank
    // line before the honor-the-declarations bullet is what HEAD rendered).
    expectEmbedded(
      full.slice(full.indexOf('Writing instructions:')),
      golden('parts-guardrail-default.txt'),
    );
  }, 20_000);

  it('the floor failure message keeps the exact pre-change wording', () => {
    const module = floorModule({});
    expect(encounterFloorMessage(countModuleEncounters(module))).toBe(
      golden('floor-message-default.txt'),
    );
  });
});

describe('custom floor: the number drives the prompt AND the gate', () => {
  it('perLevel 2 doubles the requirement and says so in the prompt and the message', async () => {
    const { campaign, moduleId } = await seedModule({ floor: { enabled: true, perLevel: 2 } });
    queueSpineReplies();

    await runSpine(moduleId, campaign);

    const prompt = promptText(0);
    expect(prompt).toContain('name at least two distinct encounters per level');
    expect(prompt).toContain('at least 4 distinct encounters across the module');

    // The counter: 2 levels x 2 = 4 total, and each band needs 2.
    const module = floorModule({
      floor: { enabled: true, perLevel: 2 },
      parts: [{ planIndex: 0, names: ['Ember Trial'] }],
      entityKinds: [encounter('Ember Trial', 'combat')],
    });
    const report = countModuleEncounters(module);
    expect(report.required).toBe(4);
    expect(report.perPart.map((entry) => entry.required)).toEqual([2, 2]);
    expect(encounterFloorMessage(report)).toBe(
      'Encounter floor not met: the module needs 4 distinct named encounters for its level range ' +
        'but the document names 1. Deficient parts: "The Sunken Quarter" (band 1): needs 2, names 1; ' +
        '"The Drowned Cathedral" (band 2): needs 2, names 0.',
    );
  }, 20_000);

  it('the per-part prompt asks for this part share of the configured floor', async () => {
    const { campaign, moduleId } = await seedModule({ floor: { enabled: true, perLevel: 2 } });
    await patchModule(moduleId, {
      spine: moduleSpineSchema.parse({
        premise: 'A harbor town raised its bell to warn of the drownings.',
        themes: ['duty'],
        partPlan: SPINE_PLAN,
      }),
    });
    chatMock.mockResolvedValue({
      text: 'The tide withdraws.\n',
      modelUsed: 'test-model',
      fallback: null,
    });

    await runParts(moduleId, campaign);

    expect(promptContaining('Writing instructions:')).toContain(
      'REQUIREMENT — encounter floor for this part (levels 1: 1 level(s)): name at least 2 distinct encounter(s)',
    );
  }, 20_000);

  it('a disabled floor removes the clause from the prompt and the gate from the count', async () => {
    const { campaign, moduleId } = await seedModule({ floor: { enabled: false, perLevel: 0 } });
    queueSpineReplies();

    await runSpine(moduleId, campaign);

    const prompt = promptText(0);
    expect(prompt).not.toContain('REQUIREMENT — encounter floor');
    // The declaration rules that shared the bullet survive a disabled floor.
    expect(prompt).toContain('Every planned encounter declares its conflict STRUCTURALLY');

    // The gate: no required total, no deficient band, and the assertion passes
    // for an encounter-free module.
    const module = floorModule({
      floor: { enabled: false, perLevel: 0 },
      parts: [{ planIndex: 0, names: [] }],
    });
    const report = countModuleEncounters(module);
    expect(report.required).toBe(0);
    expect(report.deficient).toEqual([]);
    expect(() => {
      assertEncounterFloor(module);
    }).not.toThrow();
  }, 20_000);

  it('a disabled floor asks for no encounters in the parts prompt', async () => {
    const { campaign, moduleId } = await seedModule({ floor: { enabled: false, perLevel: 0 } });
    await patchModule(moduleId, {
      spine: moduleSpineSchema.parse({
        premise: 'A harbor town raised its bell to warn of the drownings.',
        themes: ['duty'],
        partPlan: SPINE_PLAN,
      }),
    });
    chatMock.mockResolvedValue({
      text: 'The tide withdraws.\n',
      modelUsed: 'test-model',
      fallback: null,
    });

    await runParts(moduleId, campaign);

    expect(promptContaining('Writing instructions:')).not.toContain(
      'REQUIREMENT — encounter floor for this part',
    );
  }, 20_000);
});

describe('the floor lives on the MODULE row, not in the dialog', () => {
  it('records the chosen floor at creation and resolves it back from the row', async () => {
    const { moduleId } = await seedModule({ floor: { enabled: true, perLevel: 2 } });
    const saved = await getModule(moduleId);
    expect(saved).not.toBeNull();
    expect(saved?.encounterFloorGuardrail).toEqual({ enabled: true, perLevel: 2 });
    // No explicit config passed: the resolver reads the ROW.
    expect(encounterFloorGuardrailFor(saved ?? {})).toEqual({ enabled: true, perLevel: 2 });
    expect(
      countModuleEncounters(floorModule({ floor: saved?.encounterFloorGuardrail ?? undefined }))
        .required,
    ).toBe(4);
  });

  it('a module created without a choice records null and behaves as today', async () => {
    const { moduleId } = await seedModule();
    const saved = await getModule(moduleId);
    expect(saved).not.toBeNull();
    expect(saved?.encounterFloorGuardrail).toBeNull();
    // Absent means today's default floor, byte-for-byte (the golden suite above).
    expect(encounterFloorGuardrailFor(saved ?? {})).toEqual(defaultEncounterFloorGuardrail());
    expect(countModuleEncounters(floorModule({})).required).toBe(2);
  });

  it('a later pass reads the module current floor, so a rewrite uses the module rules', async () => {
    const { moduleId } = await seedModule({ floor: { enabled: true, perLevel: 1 } });
    expect(
      countModuleEncounters(floorModule({ floor: { enabled: true, perLevel: 1 } })).required,
    ).toBe(2);

    await patchModule(moduleId, { encounterFloorGuardrail: { enabled: false, perLevel: 0 } });
    const changed = await getModule(moduleId);
    expect(changed).not.toBeNull();
    expect(changed?.encounterFloorGuardrail).toEqual({ enabled: false, perLevel: 0 });
    // The gate built on the row's own value now demands nothing.
    expect(
      countModuleEncounters(floorModule({ floor: changed?.encounterFloorGuardrail ?? undefined }))
        .required,
    ).toBe(0);
  });
});

describe('recorded automation intent', () => {
  it('records exactly the automation the creation run used', () => {
    const module = createModule({
      campaignId: '123e4567-e89b-42d3-a456-426614174000',
      title: 'Intent Test',
      concept: 'concept',
      levelMin: 1,
      levelMax: 2,
      sizeDial: 'standard',
      autoGenerateKinds: ['npc', 'location'],
      autoImageKinds: ['npc'],
      autoGenerateBattlemaps: true,
      autoGenerateMobImages: true,
    });
    expect(module.automationIntent).toEqual({
      autoGenerateKinds: ['npc', 'location'],
      autoImageKinds: ['npc'],
      autoGenerateBattlemaps: true,
      autoGenerateMobImages: true,
    });
    // The intent mirrors the row's own automation fields, exactly.
    expect(module.automationIntent?.autoGenerateKinds).toEqual(module.autoGenerateKinds);
    expect(module.automationIntent?.autoImageKinds).toEqual(module.autoImageKinds);
    expect(module.automationIntent?.autoGenerateBattlemaps).toBe(module.autoGenerateBattlemaps);
    expect(module.automationIntent?.autoGenerateMobImages).toBe(module.autoGenerateMobImages);
  });

  it('records the omitted case as nothing asked for, never as unknown', () => {
    const module = createModule({
      campaignId: '123e4567-e89b-42d3-a456-426614174000',
      title: 'Intent Defaults',
      concept: 'concept',
      levelMin: 1,
      levelMax: 2,
      sizeDial: 'standard',
    });
    expect(module.automationIntent).toEqual({
      autoGenerateKinds: [],
      autoImageKinds: [],
      autoGenerateBattlemaps: false,
      autoGenerateMobImages: false,
    });
  });

  it('a legacy row stays inert: no intent, no floor, and no stored deviation flag', () => {
    const legacy = moduleSchema.parse({
      id: '123e4567-e89b-42d3-a456-426614174000',
      campaignId: '123e4567-e89b-42d3-a456-426614174001',
      title: 'Legacy',
      concept: 'concept',
      levelMin: 1,
      levelMax: 2,
      sizeDial: 'standard',
      tone: '',
      spine: null,
      parts: [],
      entityKinds: [],
      status: 'draft',
      errorMessage: '',
      createdAt: 1,
      updatedAt: 1,
    });
    expect(legacy.automationIntent).toBeNull();
    expect(legacy.encounterFloorGuardrail).toBeNull();
    // The legacy automation fields keep their own defaults, untouched.
    expect(legacy.autoGenerateKinds).toEqual([]);
    expect(legacy.autoGenerateBattlemaps).toBe(false);
    // Deviation is DERIVED by a later surface - nothing caches a verdict.
    expect(Object.keys(legacy)).not.toContain('hasProblems');
    expect(Object.keys(legacy)).not.toContain('deviates');
  });
});
