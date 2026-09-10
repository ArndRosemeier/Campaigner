import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { db } from '@/db/db';
import { getModule, patchModule, saveModule } from '@/db/moduleRepo';
import { getSettings, readSettings, updateSettings } from '@/db/settingsRepo';
import {
  PROMPT_STYLE_CLASSIC_ID,
  PROMPT_STYLE_FREESTYLE_ID,
  createModule,
  defaultSettings,
  moduleSchema,
  moduleSpineSchema,
  type Campaign,
  type EntityKind,
  type Id,
  type Module,
} from '@/domain';
import { BUILTIN_PROMPT_STYLES, builtinPromptStyle, promptStyleForModule } from '@/llm/promptStyles';
import { createModuleAndRun, generatePart, runSpine } from '@/llm/moduleGen';
import { clearDatabase } from '../db/helpers';

/**
 * FREESTYLE IS THE PRODUCT DEFAULT (owner request, docs/17 row 88). He
 * generated with it and liked the output better, so a fresh app, a settings row
 * that never stored the field, and the creation path's own default all land on
 * Freestyle.
 *
 * The pins below are deliberately split by LAYER, because the two layers are
 * what the change is about:
 *
 * - the PRODUCT layer — the settings factory and the zod default for an ABSENT
 *   field (the pre-styles-arc row path) — yields `'freestyle'`;
 * - the CREATION layer — a module created with no explicit style choice records
 *   Freestyle on its OWN row;
 * - the PROVENANCE layer — the invariant this change must not break, pinned
 *   here under the new default (see the block comment on the last describe).
 *
 * The dialog's select and the settings card are the UI halves: they read the
 * same values through `readPromptStyleCatalog`, and their pins live in
 * `tests/features/prompt-style-default-ui.test.tsx`.
 *
 * A stored explicit value is DATA and is never rewritten: there is no migration,
 * no version bump and no upgrade normalization here (AGENTS rule 1). What this
 * file asserts is only what a FRESH app is born with and what an ABSENT field
 * resolves to.
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
}));

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const mocks = vi.hoisted(() => ({ runModulePostGeneration: vi.fn() }));
vi.mock('@/features/modules/post-generation', () => ({
  runModulePostGeneration: mocks.runModulePostGeneration,
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);

const FIXTURE_DIR = join(process.cwd(), 'tests', 'fixtures', 'promptStyles');

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

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
  entities: ENTITIES.map((entry) => ({ name: entry.name, canonical: entry.name, kind: entry.kind })),
});

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

/**
 * A module ready for a part prompt, in the pre-styles shape when asked: the
 * `promptStyle` key is ABSENT from the stored row, exactly as every module
 * written before the styles arc is stored.
 *
 * The fixture-shape identity (premise, plan, campaign artifacts, tone, level
 * range) is the SAME as the Classic byte-identity suite's, so the composed part
 * prompt can be compared against `parts-classic-part0.txt` — the acceptance
 * criterion — and not merely against another composition of this test's own.
 */
async function seedPartModule(
  options: { legacyRow?: boolean; withArtifacts?: boolean } = {},
): Promise<{
  campaign: Campaign;
  moduleId: Id;
}> {
  const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
  const saved = await saveModule(
    createModule({
      campaignId: campaign.id,
      title: 'The Drowned Bell',
      concept: 'A harbor bell that rings by itself beneath the water.',
      levelMin: 1,
      levelMax: 3,
      tone: 'eerie',
      sizeDial: 'standard',
    }),
  );
  if (options.legacyRow === true) {
    const legacy: Record<string, unknown> = {
      ...(moduleSchema.parse({ ...saved, promptStyle: undefined }) as unknown as Record<
        string,
        unknown
      >),
    };
    delete legacy.promptStyle;
    await db.modules.put(legacy as unknown as Module);
  }
  // Campaign-scoped shared cast, so the campaign index + cast blocks render.
  if (options.withArtifacts !== false) {
    await createArtifact({
      campaignId: campaign.id,
      kind: 'location',
      name: 'The Salt Ward',
      summary: 'A burned ward on the north bank.',
    });
    await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Harbormaster Ilse' });
  }
  await patchModule(saved.id, {
    spine: moduleSpineSchema.parse({ premise: PREMISE, themes: THEMES, partPlan: PLAN }),
    entityKinds: ENTITIES.map((entry) => ({ ...entry, absorbed: [] })),
  });
  return { campaign, moduleId: saved.id };
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

describe('the product default is Freestyle', () => {
  it('the settings factory yields defaultPromptStyleId: freestyle', () => {
    // REVERT-PROOF: restoring PROMPT_STYLE_CLASSIC_ID in `defaultSettings()`
    // fails this line — this is the value a FRESH app's row is born with.
    expect(defaultSettings().defaultPromptStyleId).toBe(PROMPT_STYLE_FREESTYLE_ID);
    expect(defaultSettings().defaultPromptStyleId).toBe('freestyle');
  });

  it('a settings row written WITHOUT the field reads back as Freestyle', async () => {
    // The pre-styles-arc row: the key is not in Dexie at all, so the zod default
    // on the field is what resolves it. This is the path by which an app whose
    // row predates the styles arc picks up the product default.
    const { defaultPromptStyleId: _unused, ...rowWithoutTheField } = await getSettings();
    await db.settings.put(
      rowWithoutTheField as unknown as Parameters<typeof db.settings.put>[0],
    );
    const raw = (await db.settings.get('settings')) as Record<string, unknown> | undefined;
    expect(raw?.defaultPromptStyleId).toBeUndefined();
    expect((await readSettings()).defaultPromptStyleId).toBe('freestyle');
    expect((await getSettings()).defaultPromptStyleId).toBe('freestyle');
  });

  it('honors an EXPLICITLY stored default and never rewrites it', async () => {
    await updateSettings({ defaultPromptStyleId: PROMPT_STYLE_CLASSIC_ID });
    expect((await getSettings()).defaultPromptStyleId).toBe('classic');
    // …and a later unrelated write carries it forward: no normalization pass,
    // no migration, no version bump (AGENTS rule 1 — a stored value is data).
    await updateSettings({ language: 'de' });
    expect((await getSettings()).defaultPromptStyleId).toBe('classic');
    expect((await db.settings.get('settings'))?.defaultPromptStyleId).toBe('classic');
  });
});

describe('a module created with no explicit style choice', () => {
  it('records Freestyle on its own row', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    // The app default is NOT set by this test: whatever a fresh app resolves to
    // is what creation must record, which is the point of the pin.
    expect((await getSettings()).defaultPromptStyleId).toBe('freestyle');
    chatMock
      .mockResolvedValueOnce({ text: SPINE_REPLY, modelUsed: 'm', fallback: null })
      .mockResolvedValueOnce({ text: NORM_REPLY, modelUsed: 'm', fallback: null });
    const moduleId = await createModuleAndRun(campaign, {
      campaignId: campaign.id,
      title: 'New Module',
      concept: 'A harbor bell.',
      levelMin: 1,
      levelMax: 1,
      tone: '',
      sizeDial: 'standard',
    });
    const freestyle = builtinPromptStyle(PROMPT_STYLE_FREESTYLE_ID);
    const row = await getModule(moduleId);
    // REVERT-PROOF: with the product default back at Classic this records
    // Classic and fails — the row mirrors the existing Freestyle suite's
    // creation pin, with the id supplied by the DEFAULT rather than the dialog.
    expect(row?.promptStyle).toEqual({
      id: 'freestyle',
      name: 'Freestyle',
      version: freestyle?.version,
      templateText: freestyle?.templateText,
    });
    expect(row?.promptStyle?.name).toBe('Freestyle');
    expect(row?.promptStyle?.version).toBe(1);
    expect(
      BUILTIN_PROMPT_STYLES.some((style) => style.id === row?.promptStyle?.id),
    ).toBe(true);
    // `createModuleAndRun` fires the spine pass DETACHED (`moduleGen.ts`), so
    // drain it here: a spine call still in flight when this test ends would land
    // inside the NEXT test's mocked transport.
    await vi.waitFor(
      async () => {
        expect((await getModule(moduleId))?.spine).not.toBeNull();
      },
      { timeout: 5_000 },
    );
  });
});

/**
 * THE PROVENANCE PIN — the risk of this whole change (docs/17 row 88).
 *
 * Every module the owner already has was written under Classic. The app default
 * decides the style of a module ONLY when no style has been recorded for the
 * module being CREATED; for a module that EXISTS the resolution is
 *
 *     the module's RECORDED style → and, with nothing recorded, Classic by
 *     PROVENANCE (it was written with that text).
 *
 * The app default is NOT a rung of that ladder.
 *
 * REVERT-PROOF: making the resolution consult `settings.defaultPromptStyleId`
 * when a module recorded nothing — the "obvious" simplification — turns the
 * legacy rows below into Freestyle parts and fails these tests. Both layers are
 * pinned: the pure resolver, and the REAL `generatePart` / `runSpine` seam over
 * a legacy row put into Dexie with the key ABSENT (the true pre-arc shape), so
 * the guarantee is proved on the path a resume, a repair and a per-part
 * regeneration actually take. Classic's own fixture is the acceptance
 * criterion: the legacy row must compose the byte-identical classic part
 * prompt.
 */
describe('with the app default on Freestyle, provenance still wins', () => {
  it('the resolver never consults the app default', async () => {
    // The app default is Freestyle here — the fresh row, untouched.
    expect((await getSettings()).defaultPromptStyleId).toBe('freestyle');
    const resolved = promptStyleForModule({});
    expect(resolved.source).toBe('legacy-classic');
    expect(resolved.style.id).toBe('classic');
    expect(resolved.style.templateText).toBe(builtinPromptStyle('classic')?.templateText);
  });

  it('a legacy module (no recorded style) composes the byte-identical classic part prompt', async () => {
    expect((await getSettings()).defaultPromptStyleId).toBe('freestyle');
    const { campaign, moduleId } = await seedPartModule({ legacyRow: true });
    const row = await getModule(moduleId);
    // The stored row genuinely lacks the field (this is the pre-arc shape): the
    // repo's parse-on-read materializes it as null, and the key is NOT in Dexie.
    expect((await db.modules.get(moduleId))?.promptStyle ?? null).toBeNull();
    expect(row?.promptStyle ?? null).toBeNull();
    expect(await renderPartPrompt(moduleId, 0, campaign)).toBe(
      fixture('parts-classic-part0.txt'),
    );
  });

  it('a legacy module (no recorded style) composes the byte-identical classic spine prompt', async () => {
    expect((await getSettings()).defaultPromptStyleId).toBe('freestyle');
    // The spine fixture's own shape: a campaign with NO artifacts yet (the
    // campaign index and the shared cast blocks are absent from it).
    const { campaign, moduleId } = await seedPartModule({ legacyRow: true, withArtifacts: false });
    chatMock
      .mockResolvedValueOnce({ text: SPINE_REPLY, modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: NORM_REPLY, modelUsed: 'test-model', fallback: null });
    await runSpine(moduleId, campaign);
    expect(userPrompt(0)).toBe(fixture('spine-classic-default.txt'));
  });

  it('a module that RECORDED Classic still composes Classic', async () => {
    expect((await getSettings()).defaultPromptStyleId).toBe('freestyle');
    const { campaign, moduleId } = await seedPartModule();
    const classic = builtinPromptStyle(PROMPT_STYLE_CLASSIC_ID);
    if (classic === undefined) throw new Error('missing classic');
    await patchModule(moduleId, {
      promptStyle: {
        id: classic.id,
        name: classic.name,
        version: classic.version,
        templateText: classic.templateText,
      },
    });
    const text = await renderPartPrompt(moduleId, 0, campaign);
    expect(text).toBe(fixture('parts-classic-part0.txt'));
    // …and the recorded copy is what a later generation reads, not the default.
    expect(promptStyleForModule((await getModule(moduleId)) ?? {}).source).toBe('recorded');
  });

  it('a module that RECORDED Freestyle keeps Freestyle (the default cannot un-record it)', async () => {
    const { campaign, moduleId } = await seedPartModule();
    const freestyle = builtinPromptStyle(PROMPT_STYLE_FREESTYLE_ID);
    if (freestyle === undefined) throw new Error('missing freestyle');
    await patchModule(moduleId, {
      promptStyle: {
        id: freestyle.id,
        name: freestyle.name,
        version: freestyle.version,
        templateText: freestyle.templateText,
      },
    });
    const text = await renderPartPrompt(moduleId, 0, campaign);
    expect(text).toContain('make this a noteworthy and fun module to play');
    expect(text).not.toBe(fixture('parts-classic-part0.txt'));
  });

  it('changing the app default does not change a module that already exists', async () => {
    const { campaign, moduleId } = await seedPartModule({ legacyRow: true });
    const before = await renderPartPrompt(moduleId, 0, campaign);
    await updateSettings({ defaultPromptStyleId: PROMPT_STYLE_FREESTYLE_ID });
    const after = await renderPartPrompt(moduleId, 0, campaign);
    expect(after).toBe(before);
    expect(after).toBe(fixture('parts-classic-part0.txt'));
  });
});
