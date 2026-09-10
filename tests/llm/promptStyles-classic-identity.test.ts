import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { db } from '@/db/db';
import { getModule, patchModule, saveModule } from '@/db/moduleRepo';
import {
  createModule,
  modulePartSchema,
  moduleSchema,
  moduleSpineSchema,
  type Campaign,
  type EntityKind,
  type Module,
  type Id,
} from '@/domain';
import { BUILTIN_PROMPT_STYLES, promptStyleForModule } from '@/llm/promptStyles';
import { generatePart, runSpine } from '@/llm/moduleGen';
import { clearDatabase } from '../db/helpers';

/**
 * THE BYTE-IDENTITY PIN (docs/17 row 86, docs/18 §2.2).
 *
 * Moving the module instructions out of the code and into a style template must
 * not change ONE BYTE of what the model receives on the default path: every
 * existing module, every resume, every repair and every per-part regeneration
 * keeps composing exactly the prompt it composed before, so existing modules
 * stay coherent and the owner's live campaigns are untouched.
 *
 * The fixtures under `tests/fixtures/promptStyles/` were captured by RENDERING
 * the pre-refactor builders (a temporary harness driving the real `runSpine` +
 * `generatePart` against mocked chat replies, at the commit before the composer
 * landed) — not transcribed by hand, the 89e5d71 method. Each case renders
 * through the real seam and must match its fixture character for character.
 *
 * Which cases: the branches that can change the composed text — the default
 * floor, a disabled floor, an extra (retry) instruction, a tone with a ban
 * list, campaign description present/absent, prior modules + the shared cast,
 * the glossary, the campaign index, continuity from the previous part, the
 * finale wording, and the bare case where every optional block is absent.
 *
 * LEGACY (the case that matters most): a module row written BEFORE styles has no
 * recorded style at all. It was written with Classic — the text that existed
 * when it was written — and it must compose those same bytes, or a resumed
 * legacy module's new parts would not match its existing ones. The legacy row
 * here is put into Dexie with the key ABSENT, which is the real pre-arc shape.
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
}));

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

const mocks = vi.hoisted(() => ({ runModulePostGeneration: vi.fn() }));
vi.mock('@/features/modules/post-generation', () => ({
  runModulePostGeneration: mocks.runModulePostGeneration,
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);

const FIXTURE_DIR = join(process.cwd(), 'tests', 'fixtures', 'promptStyles');

const PREMISE =
  'A harbor town raised its bell to warn of the drownings; now the bell rings by itself.';
const THEMES = ['duty', 'decay'];
const PLAN = [
  {
    title: 'The Sunken Quarter',
    levelBand: '1',
    synopsis: 'The party arrives with the low tide and finds the first bodies.',
    levelUpTrigger: 'The bell is found.',
  },
  {
    title: 'The Drowned Cathedral',
    levelBand: '2',
    synopsis: 'Descent beneath the harbor to the flooded nave.',
    levelUpTrigger: 'The warden falls.',
  },
  {
    title: 'The Bell Tower',
    levelBand: '3',
    synopsis: 'Final confrontation at the top of the leaning tower.',
    levelUpTrigger: 'The cult is broken.',
  },
];
const ENTITIES: { name: string; kind: EntityKind }[] = [
  { name: 'Warden Bellamy', kind: 'npc' },
  { name: 'The Drowned Cathedral', kind: 'location' },
  { name: 'The Tide Cult', kind: 'faction' },
  { name: 'The Bells Below', kind: 'encounter' },
  { name: 'The Flooded Nave', kind: 'encounter' },
  { name: 'The Wardens Confession', kind: 'encounter' },
];
const SPINE_REPLY = JSON.stringify({
  premise: PREMISE,
  themes: THEMES,
  partPlan: PLAN,
  entities: ENTITIES,
});
const NORM_REPLY = JSON.stringify({
  entities: ENTITIES.map((entry) => ({
    name: entry.name,
    canonical: entry.name,
    kind: entry.kind,
  })),
});

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

/** The whole user message of the n-th chat call. */
function userPrompt(callIndex: number): string {
  const messages = chatMock.mock.calls[callIndex]?.[0] as
    | { role: string; content: unknown }[]
    | undefined;
  const user = messages?.find((message) => message.role === 'user');
  return typeof user?.content === 'string' ? user.content : '';
}

function prose(marker: string): { text: string; modelUsed: string; fallback: null } {
  return {
    text: `${marker}: The tide withdraws and the streets shine wet under a pale sun. `.repeat(4),
    modelUsed: 'test-model',
    fallback: null,
  };
}

async function seed(options: {
  floor?: { enabled: boolean; perLevel: number };
  includePriorModules?: boolean;
  description?: string;
  tone?: string;
  /** Write the row WITHOUT a recorded style: the pre-styles shape. */
  legacyRow?: boolean;
} = {}): Promise<{ campaign: Campaign; moduleId: Id }> {
  const campaign = await createCampaign({
    name: 'Emberfall',
    system: 'dnd5e',
    ...(options.description === undefined ? {} : { description: options.description }),
  });
  const draft = createModule({
    campaignId: campaign.id,
    title: 'The Drowned Bell',
    concept: 'A harbor bell that rings by itself beneath the water.',
    levelMin: 1,
    levelMax: 3,
    tone: options.tone ?? 'eerie',
    sizeDial: 'standard',
    ...(options.floor === undefined ? {} : { encounterFloorGuardrail: options.floor }),
    ...(options.includePriorModules === undefined
      ? {}
      : { includePriorModules: options.includePriorModules }),
  });
  const saved = await saveModule(draft);
  if (options.legacyRow === true) {
    // The real pre-arc shape: the key is not in the stored row at all.
    const legacy: Record<string, unknown> = {
      ...(moduleSchema.parse({ ...saved, promptStyle: undefined }) as unknown as Record<
        string,
        unknown
      >),
    };
    delete legacy.promptStyle;
    await db.modules.put(legacy as unknown as Module);
  }
  return { campaign, moduleId: saved.id };
}

async function seedPriorModule(campaignId: Id): Promise<void> {
  const saved = await saveModule(
    createModule({
      campaignId,
      title: 'The Salt Ward',
      concept: 'The chapter before this one.',
      levelMin: 1,
      levelMax: 2,
      tone: '',
      sizeDial: 'sketch',
    }),
  );
  await patchModule(saved.id, {
    spine: moduleSpineSchema.parse({
      premise: 'The Salt Ward burned on the first night of the tide.',
      themes: ['salt'],
      partPlan: [
        {
          title: 'The Burning Ward',
          levelBand: '1',
          synopsis: 'Fire on the docks.',
          levelUpTrigger: 'The ward falls.',
        },
      ],
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        markdown: 'PRIOR-PART-MARKER: The ward burned and the salt came in. '.repeat(6),
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
    ],
  });
}

/** Campaign-scoped shared cast, so the campaign index + cast blocks render. */
async function seedArtifacts(campaignId: Id): Promise<void> {
  await createArtifact({
    campaignId,
    kind: 'location',
    name: 'The Salt Ward',
    summary: 'A burned ward on the north bank.',
  });
  await createArtifact({ campaignId, kind: 'npc', name: 'Harbormaster Ilse' });
}

/** A module ready for a part prompt: spine, glossary, optional prior parts. */
async function seedPartModule(options: {
  floor?: { enabled: boolean; perLevel: number };
  includePriorModules?: boolean;
  priorParts?: number[];
  /**
   * The markdown of each already-written prior part. The part prompt carries
   * the IMMEDIATELY previous part's full text, so a case whose fixture was
   * captured with particular prior text seeds exactly that text — otherwise the
   * comparison would be measuring the test's own prose, not the composer.
   */
  priorMarkdown?: (planIndex: number) => string;
  description?: string;
  tone?: string;
  legacyRow?: boolean;
} = {}): Promise<{ campaign: Campaign; moduleId: Id }> {
  const { campaign, moduleId } = await seed(options);
  await seedArtifacts(campaign.id);
  await patchModule(moduleId, {
    spine: moduleSpineSchema.parse({ premise: PREMISE, themes: THEMES, partPlan: PLAN }),
    entityKinds: ENTITIES.map((entry) => ({ ...entry, absorbed: [] })),
    ...(options.priorParts === undefined
      ? {}
      : {
          parts: options.priorParts.map((planIndex) =>
            modulePartSchema.parse({
              planIndex,
              markdown:
                options.priorMarkdown?.(planIndex) ??
                `PRIOR-PART-${String(planIndex)}: the water rose and the bell rang. `.repeat(6),
              status: 'ready',
              errorMessage: '',
              edited: false,
            }),
          ),
        }),
  });
  return { campaign, moduleId };
}

async function renderPartPrompt(
  moduleId: Id,
  planIndex: number,
  campaign: Campaign,
): Promise<string> {
  chatMock.mockResolvedValue(prose(`PART-${String(planIndex)} [[The Bells Below]]`));
  const module = await getModule(moduleId);
  if (module === undefined) throw new Error('missing module');
  await generatePart(moduleId, module, planIndex, campaign, 'test-model', {
    signal: new AbortController().signal,
    extraInstruction: '',
    onToken: undefined,
  });
  return userPrompt(0);
}

beforeEach(() => clearDatabase());
afterEach(() => {
  vi.resetAllMocks();
});

describe('Classic composes the pre-style prompt byte for byte', () => {
  it('the built-in Classic template is valid and ships both sections', () => {
    const classic = BUILTIN_PROMPT_STYLES.find((style) => style.id === 'classic');
    expect(classic).toBeDefined();
    expect(classic?.templateText).toContain('--- SPINE ---');
    expect(classic?.templateText).toContain('--- PARTS ---');
  });

  it('spine: default floor', async () => {
    const { campaign, moduleId } = await seed();
    chatMock
      .mockResolvedValueOnce({ text: SPINE_REPLY, modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: NORM_REPLY, modelUsed: 'test-model', fallback: null });
    await runSpine(moduleId, campaign);
    expect(userPrompt(0)).toBe(fixture('spine-classic-default.txt'));
  }, 20000);

  it('spine: disabled floor (the clause and its bullet tail)', async () => {
    const { campaign, moduleId } = await seed({ floor: { enabled: false, perLevel: 0 } });
    chatMock
      .mockResolvedValueOnce({ text: SPINE_REPLY, modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: NORM_REPLY, modelUsed: 'test-model', fallback: null });
    await runSpine(moduleId, campaign);
    expect(userPrompt(0)).toBe(fixture('spine-classic-floor-off.txt'));
  }, 20000);

  it('spine: prior modules + shared cast', async () => {
    const { campaign, moduleId } = await seed({ includePriorModules: true });
    await seedArtifacts(campaign.id);
    await seedPriorModule(campaign.id);
    chatMock
      .mockResolvedValueOnce({ text: SPINE_REPLY, modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: NORM_REPLY, modelUsed: 'test-model', fallback: null });
    await runSpine(moduleId, campaign);
    expect(userPrompt(0)).toBe(fixture('spine-classic-priors.txt'));
  }, 20000);

  it('spine: an extra (retry) instruction', async () => {
    const { campaign, moduleId } = await seed();
    chatMock
      .mockResolvedValueOnce({ text: SPINE_REPLY, modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: NORM_REPLY, modelUsed: 'test-model', fallback: null });
    await runSpine(moduleId, campaign, { extraInstruction: 'Tighten the middle part.' });
    expect(userPrompt(0)).toBe(fixture('spine-classic-extra-instruction.txt'));
  }, 20000);

  it('spine: tone bans + campaign description', async () => {
    const { campaign, moduleId } = await seed({
      description: 'A dying harbor town and the bell that will not stop.',
      tone: 'horror',
    });
    chatMock
      .mockResolvedValueOnce({ text: SPINE_REPLY, modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: NORM_REPLY, modelUsed: 'test-model', fallback: null });
    await runSpine(moduleId, campaign);
    expect(userPrompt(0)).toBe(fixture('spine-classic-tone-bans.txt'));
  }, 20000);

  it('parts: part 0 with the glossary and the campaign index', async () => {
    const { campaign, moduleId } = await seedPartModule();
    expect(await renderPartPrompt(moduleId, 0, campaign)).toBe(fixture('parts-classic-part0.txt'));
  }, 20000);

  it('parts: continuity from the previous part', async () => {
    const { campaign, moduleId } = await seedPartModule({ priorParts: [0] });
    expect(await renderPartPrompt(moduleId, 1, campaign)).toBe(fixture('parts-classic-part1.txt'));
  }, 20000);

  it('parts: the finale wording of a closing part', async () => {
    const { campaign, moduleId } = await seedPartModule({
      priorParts: [0, 1],
      // Trimmed: a part written by the run itself lands in the row trimmed
      // (the fixture was captured from a generated part, not a seeded one), and
      // the prompt carries the row's text verbatim.
      priorMarkdown: (planIndex) =>
        planIndex === 1
          ? prose('PART-TWO [[The Flooded Nave]]').text.trim()
          : `PRIOR-PART-0: the water rose and the bell rang. `.repeat(6),
    });
    expect(await renderPartPrompt(moduleId, 2, campaign)).toBe(fixture('parts-classic-finale.txt'));
  }, 20000);

  it('parts: disabled floor drops the whole requirement line', async () => {
    const { campaign, moduleId } = await seedPartModule({
      floor: { enabled: false, perLevel: 0 },
    });
    expect(await renderPartPrompt(moduleId, 0, campaign)).toBe(
      fixture('parts-classic-floor-off.txt'),
    );
  }, 20000);

  it('parts: prior modules in context', async () => {
    const { campaign, moduleId } = await seedPartModule({ includePriorModules: true });
    await seedPriorModule(campaign.id);
    expect(await renderPartPrompt(moduleId, 0, campaign)).toBe(fixture('parts-classic-priors.txt'));
  }, 20000);

  it('parts: every optional block absent (bare prompt)', async () => {
    const { campaign, moduleId } = await seed({
      description: 'A dying harbor town and the bell that will not stop.',
      tone: 'horror',
    });
    await patchModule(moduleId, {
      spine: moduleSpineSchema.parse({ premise: PREMISE, themes: THEMES, partPlan: PLAN }),
    });
    expect(await renderPartPrompt(moduleId, 0, campaign)).toBe(fixture('parts-classic-bare.txt'));
  }, 20000);
});

describe('a LEGACY module row composes the same classic bytes', () => {
  it('the row has no recorded style, and reads as Classic as provenance', async () => {
    const { moduleId } = await seed({ legacyRow: true });
    const row = await getModule(moduleId);
    expect(row).toBeDefined();
    // The stored row genuinely lacks the field (this is the pre-arc shape).
    const raw = (await db.modules.get(moduleId)) as Record<string, unknown> | undefined;
    expect(raw?.promptStyle).toBeUndefined();
    expect(row?.promptStyle ?? null).toBeNull();
    const resolved = promptStyleForModule(row ?? {});
    expect(resolved.source).toBe('legacy-classic');
    expect(resolved.style.templateText).toBe(
      BUILTIN_PROMPT_STYLES.find((style) => style.id === 'classic')?.templateText,
    );
  });

  it('a legacy module composes the byte-identical classic spine prompt', async () => {
    const { campaign, moduleId } = await seed({ legacyRow: true });
    chatMock
      .mockResolvedValueOnce({ text: SPINE_REPLY, modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: NORM_REPLY, modelUsed: 'test-model', fallback: null });
    await runSpine(moduleId, campaign);
    expect(userPrompt(0)).toBe(fixture('spine-classic-default.txt'));
  }, 20000);

  it('a legacy module composes the byte-identical classic part prompt', async () => {
    const { campaign, moduleId } = await seedPartModule({ legacyRow: true });
    expect(await renderPartPrompt(moduleId, 0, campaign)).toBe(fixture('parts-classic-part0.txt'));
  }, 20000);

  it('a module that RECORDED Classic composes the same bytes as a legacy one', async () => {
    const { campaign, moduleId } = await seedPartModule();
    const classic = BUILTIN_PROMPT_STYLES.find((style) => style.id === 'classic');
    expect(classic).toBeDefined();
    await patchModule(moduleId, {
      promptStyle:
        classic === undefined
          ? null
          : {
              id: classic.id,
              name: classic.name,
              version: classic.version,
              templateText: classic.templateText,
            },
    });
    expect(await renderPartPrompt(moduleId, 0, campaign)).toBe(fixture('parts-classic-part0.txt'));
  }, 20000);
});
