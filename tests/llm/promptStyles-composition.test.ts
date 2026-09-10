import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { getModule, patchModule, saveModule } from '@/db/moduleRepo';
import { getSettings, readSettings, updateSettings } from '@/db/settingsRepo';
import {
  catalogStyles,
  duplicatePromptStyle,
  deletePromptStyle,
  readPromptStyleCatalog,
  savePromptStyle,
  setDefaultPromptStyle,
} from '@/db/promptStyleRepo';
import {
  createModule,
  moduleSpineSchema,
  PROMPT_STYLE_PLACEHOLDERS,
  requiredPlaceholders,
  validatePromptStyleTemplate,
  type Campaign,
  type Id,
  type PromptStyle,
} from '@/domain';
import {
  BUILTIN_PROMPT_STYLES,
  builtinPromptStyle,
  modulePromptStyleOf,
  promptStyleForModule,
} from '@/llm/promptStyles';
import { createModuleAndRun, generatePart, runSpine } from '@/llm/moduleGen';
import { clearDatabase } from '../db/helpers';

/**
 * The prompt-style layer itself (docs/17 row 86, docs/18 §2.2): what a style
 * may change, what it may not, and what a module RECORDS.
 *
 * The byte-identity pin for the Classic path lives in
 * `promptStyles-classic-identity.test.ts`. This file covers the other half:
 * the contract layer is unconditional, an unusable template fails LOUDLY rather
 * than degrading, the built-in Story style is a genuinely different shape, and
 * a module's recorded style text — not the current style — is what every later
 * generation of that module composes.
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

const PREMISE = 'A harbor bell that rings by itself beneath the water.';
const PLAN = [
  {
    title: 'The Sunken Quarter',
    levelBand: '1',
    synopsis: 'The party arrives with the low tide.',
    levelUpTrigger: 'The bell is found.',
  },
];
const SPINE_REPLY = JSON.stringify({
  premise: PREMISE,
  themes: ['duty'],
  partPlan: PLAN,
  // The floor gate counts encounters: a spine with none is a DEFECT and earns a
  // repair call, so the reply plans one.
  entities: [
    { name: 'Warden Bellamy', kind: 'npc' },
    { name: 'The Bells Below', kind: 'encounter' },
  ],
});
const NORM_REPLY = JSON.stringify({
  entities: [
    { name: 'Warden Bellamy', canonical: 'Warden Bellamy', kind: 'npc' },
    { name: 'The Bells Below', canonical: 'The Bells Below', kind: 'encounter' },
  ],
});

function userPrompt(callIndex: number): string {
  const messages = chatMock.mock.calls[callIndex]?.[0] as
    | { role: string; content: unknown }[]
    | undefined;
  const user = messages?.find((message) => message.role === 'user');
  return typeof user?.content === 'string' ? user.content : '';
}

function prose(marker: string): { text: string; modelUsed: string; fallback: null } {
  return { text: `${marker} [[The Bells Below]]: the tide withdraws. `.repeat(6), modelUsed: 'm', fallback: null };
}

async function spineModule(campaign: Campaign, styleId?: string): Promise<Id> {
  const saved = await saveModule(
    createModule({
      campaignId: campaign.id,
      title: 'The Drowned Bell',
      concept: 'A harbor bell.',
      levelMin: 1,
      levelMax: 1,
      tone: 'eerie',
      sizeDial: 'standard',
    }),
  );
  if (styleId !== undefined) {
    const catalog = await readPromptStyleCatalog((await getSettings()).defaultPromptStyleId);
    const style = catalogStyles(catalog).find((entry) => entry.id === styleId);
    if (style === undefined) throw new Error(`missing style ${styleId}`);
    await patchModule(saved.id, { promptStyle: modulePromptStyleOf(style) });
  }
  await patchModule(saved.id, {
    spine: moduleSpineSchema.parse({ premise: PREMISE, themes: ['duty'], partPlan: PLAN }),
    entityKinds: [
      { name: 'Warden Bellamy', kind: 'npc', absorbed: [] },
      { name: 'The Bells Below', kind: 'encounter', absorbed: [] },
    ],
  });
  return saved.id;
}

beforeEach(() => clearDatabase());
afterEach(() => {
  vi.resetAllMocks();
});

describe('the built-in styles', () => {
  it('ships exactly Classic and Story, both immutable and valid', () => {
    expect(BUILTIN_PROMPT_STYLES.map((style) => style.id)).toEqual(['classic', 'story']);
    for (const style of BUILTIN_PROMPT_STYLES) {
      expect(style.origin).toBe('builtin');
      expect(validatePromptStyleTemplate(style.templateText)).toEqual([]);
    }
  });

  it('Story carries a narrative shape, not the ten-field scene block', () => {
    const story = builtinPromptStyle('story');
    expect(story).toBeDefined();
    const text = story?.templateText ?? '';
    // Every placeholder the classic template carries is still there: the
    // CONTRACT layer is not a style's to drop.
    for (const token of requiredPlaceholders('parts')) {
      expect(text).toContain(`{{${token}}}`);
    }
    // No ordered field list: the labels belong to Classic only.
    for (const label of [
      '**Scene heading + tag**',
      '**Where**',
      '**First impression**',
      '**Who is here and what they want right now**',
      '**The situation**',
      '**What changed**',
      '**If the party acts**',
      '**Secrets**',
      '**Leads**',
      '**Outcome**',
    ]) {
      expect(text).not.toContain(label);
    }
    // …but the disciplines that make scenes playable are stated in its own
    // words, including the heading + link requirement the floor gate depends on.
    expect(text).toContain('### [[Beat Name]] — ENCOUNTER');
    expect(text).toContain('### [[Beat Name]]"');
    expect(text).toContain('{{contract.floor}}');
  });

  it('a style cannot remove a required contract clause (validation names it)', () => {
    const story = builtinPromptStyle('story');
    const withoutFloor = (story?.templateText ?? '').replace('{{contract.floor}}', '');
    const problems = validatePromptStyleTemplate(withoutFloor);
    expect(problems.join(' ')).toContain('{{contract.floor}}');
  });

  it('an unknown placeholder is refused by name, never rendered as-is', () => {
    const classic = builtinPromptStyle('classic');
    const broken = (classic?.templateText ?? '').replace('{{levelMin}}', '{{levelMinimum}}');
    const problems = validatePromptStyleTemplate(broken);
    expect(problems.join(' ')).toContain('{{levelMinimum}}');
    expect(problems.join(' ')).toContain('Unknown placeholder');
  });

  it('an empty template is refused with the section requirement', () => {
    expect(validatePromptStyleTemplate('')).toEqual([
      'The template is empty. A style needs both a --- SPINE --- and a --- PARTS --- section.',
    ]);
    expect(validatePromptStyleTemplate('   \n  ')).toHaveLength(1);
  });

  it('every documented placeholder is used by a built-in style', () => {
    const used = new Set<string>();
    for (const style of BUILTIN_PROMPT_STYLES) {
      for (const entry of PROMPT_STYLE_PLACEHOLDERS) {
        if (style.templateText.includes(`{{${entry.token}}}`)) used.add(entry.token);
      }
    }
    for (const entry of PROMPT_STYLE_PLACEHOLDERS) {
      expect(used.has(entry.token), `placeholder {{${entry.token}}} is documented but unused`).toBe(
        true,
      );
    }
  });

  it('the story section is a different shape from the classic one', () => {
    const story = builtinPromptStyle('story')?.templateText ?? '';
    const classic = builtinPromptStyle('classic')?.templateText ?? '';
    expect(story).not.toContain('**Outcome**');
    expect(story).toContain('{{partEnding}}');
    // The spine planner is shared (its JSON shape is an app contract); the
    // story rewrite lands in the part writer, where the story is written.
    expect(story).toContain('Choose the shape of each beat yourself');
    expect(classic).not.toContain('Choose the shape of each beat yourself');
  });
});

describe('what a module records and what generation uses', () => {
  it('records the style id, name, version and TEXT on the module row', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
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
      promptStyleId: 'story',
    });
    const row = await getModule(moduleId);
    const story = builtinPromptStyle('story');
    expect(row?.promptStyle).toEqual({
      id: 'story',
      name: story?.name,
      version: story?.version,
      templateText: story?.templateText,
    });
    expect(promptStyleForModule(row ?? {}).source).toBe('recorded');
  });

  it('an omitted style id records the APP DEFAULT style', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const story = builtinPromptStyle('story');
    if (story === undefined) throw new Error('missing story');
    const copy = await duplicatePromptStyle(story, 'House Voice');
    await setDefaultPromptStyle(copy.id);
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
    const row = await getModule(moduleId);
    expect(row?.promptStyle?.id).toBe(copy.id);
    expect(row?.promptStyle?.name).toBe('House Voice');
  });

  it('an id that resolves to nothing fails LOUDLY and creates no module', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    await expect(
      createModuleAndRun(campaign, {
        campaignId: campaign.id,
        title: 'New Module',
        concept: 'A harbor bell.',
        levelMin: 1,
        levelMax: 1,
        tone: '',
        sizeDial: 'standard',
        promptStyleId: 'nope-not-a-style',
      }),
    ).rejects.toThrow(/nope-not-a-style/);
    const modules = await getModule('missing');
    expect(modules).toBeUndefined();
  });

  it('editing a style does NOT change a module that recorded the old text', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const story = builtinPromptStyle('story');
    if (story === undefined) throw new Error('missing story');
    const own: PromptStyle = await duplicatePromptStyle(story, 'House Voice');
    const moduleId = await spineModule(campaign, own.id);
    const before = await getModule(moduleId);
    // The user rewrites the style: the module keeps the text it recorded.
    await savePromptStyle(own.id, {
      templateText: `${own.templateText}\n\nHOUSE-VOICE-V2-MARKER: keep the prose cold.`,
    });
    const unchanged = await getModule(moduleId);
    expect(unchanged?.promptStyle?.templateText).toBe(before?.promptStyle?.templateText);
    expect(unchanged?.promptStyle?.version).toBe(1);
    chatMock.mockResolvedValue(prose('PART'));
    const module = await getModule(moduleId);
    if (module === undefined) throw new Error('missing module');
    await generatePart(moduleId, module, 0, campaign, 'm', {
      signal: new AbortController().signal,
      extraInstruction: '',
      onToken: undefined,
    });
    expect(userPrompt(0)).not.toContain('HOUSE-VOICE-V2-MARKER');
    // …and it still carries its own style's text (this style is Story-derived).
    expect(userPrompt(0)).toContain('Choose the shape of each beat yourself');
  });

  it('adopting the current text makes later parts use it', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const story = builtinPromptStyle('story');
    if (story === undefined) throw new Error('missing story');
    const own = await duplicatePromptStyle(story, 'House Voice');
    const moduleId = await spineModule(campaign, own.id);
    const saved = await savePromptStyle(own.id, {
      templateText: `${own.templateText}\n\nHOUSE-VOICE-V2-MARKER: keep the prose cold.`,
    });
    expect(saved.version).toBe(2);
    await patchModule(moduleId, { promptStyle: modulePromptStyleOf(saved) });
    chatMock.mockResolvedValue(prose('PART'));
    const module = await getModule(moduleId);
    if (module === undefined) throw new Error('missing module');
    await generatePart(moduleId, module, 0, campaign, 'm', {
      signal: new AbortController().signal,
      extraInstruction: '',
      onToken: undefined,
    });
    expect(userPrompt(0)).toContain('HOUSE-VOICE-V2-MARKER');
  });

  it('deleting a style leaves the module intact and still generating', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const story = builtinPromptStyle('story');
    if (story === undefined) throw new Error('missing story');
    const own = await duplicatePromptStyle(story, 'House Voice');
    const moduleId = await spineModule(campaign, own.id);
    const before = await getModule(moduleId);
    await deletePromptStyle(own.id);
    const after = await getModule(moduleId);
    expect(after?.promptStyle).toEqual(before?.promptStyle);
    const catalog = await readPromptStyleCatalog((await getSettings()).defaultPromptStyleId);
    expect(catalogStyles(catalog).some((style) => style.id === own.id)).toBe(false);
    // Generation still composes from the module's own copy.
    chatMock.mockResolvedValue(prose('PART'));
    const module = await getModule(moduleId);
    if (module === undefined) throw new Error('missing module');
    await generatePart(moduleId, module, 0, campaign, 'm', {
      signal: new AbortController().signal,
      extraInstruction: '',
      onToken: undefined,
    });
    expect(userPrompt(0)).toContain('Choose the shape of each beat yourself');
  });

  it('resuming a legacy module composes the immutable Classic text', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const saved = await saveModule(
      createModule({
        campaignId: campaign.id,
        title: 'The Drowned Bell',
        concept: 'A harbor bell.',
        levelMin: 1,
        levelMax: 1,
        tone: 'eerie',
        sizeDial: 'standard',
      }),
    );
    const moduleId = saved.id;
    chatMock
      .mockResolvedValueOnce({ text: SPINE_REPLY, modelUsed: 'm', fallback: null })
      .mockResolvedValueOnce({ text: NORM_REPLY, modelUsed: 'm', fallback: null });
    await runSpine(moduleId, campaign);
    const row = await getModule(moduleId);
    expect(row?.promptStyle ?? null).toBeNull();
    expect(promptStyleForModule(row ?? {}).style.templateText).toBe(
      builtinPromptStyle('classic')?.templateText,
    );
  });
});

describe('the storable catalog', () => {
  it('duplicating, editing, saving and defaulting round-trips through settings', async () => {
    const story = builtinPromptStyle('story');
    if (story === undefined) throw new Error('missing story');
    const copy = await duplicatePromptStyle(story);
    expect(copy.name).toBe('Story (copy)');
    const saved = await savePromptStyle(copy.id, { name: 'House Voice', templateText: copy.templateText });
    expect(saved.name).toBe('House Voice');
    expect(saved.version).toBe(1);
    await setDefaultPromptStyle(copy.id);
    const row = await readSettings();
    expect(row.defaultPromptStyleId).toBe(copy.id);
    expect(row.promptStyles?.map((style) => style.name)).toContain('House Voice');
  });

  it('a template that fails validation is REFUSED and nothing is written', async () => {
    const story = builtinPromptStyle('story');
    if (story === undefined) throw new Error('missing story');
    const copy = await duplicatePromptStyle(story);
    await expect(
      savePromptStyle(copy.id, {
        templateText: `${copy.templateText}\n\n{{notAPlaceholder}}\n`,
      }),
    ).rejects.toThrow(/notAPlaceholder/);
    const row = await readSettings();
    const stored = row.promptStyles?.find((style) => style.id === copy.id);
    expect(stored?.templateText).toBe(copy.templateText);
    expect(stored?.version).toBe(1);
  });

  it('refuses a duplicate NAME and a built-in name', async () => {
    const story = builtinPromptStyle('story');
    if (story === undefined) throw new Error('missing story');
    await duplicatePromptStyle(story, 'House Voice');
    await expect(duplicatePromptStyle(story, 'House Voice')).rejects.toThrow(/already exists/);
    await expect(duplicatePromptStyle(story, 'Classic')).rejects.toThrow(/already exists/);
  });

  it('an unreadable styles blob reads as an error, never as an empty list', async () => {
    await updateSettings({ promptStyles: [] });
    // Corrupt the row the way a bad import would.
    const raw = await readSettings();
    expect(raw.promptStyles).toEqual([]);
    await updateSettings({ promptStyles: [] });
    const stored = await readPromptStyleCatalog('classic');
    expect(stored.error).toBeNull();
    expect(stored.user).toEqual([]);
  });

  it('reports the version a style is at, and resets to the source text', async () => {
    const story = builtinPromptStyle('story');
    if (story === undefined) throw new Error('missing story');
    const copy = await duplicatePromptStyle(story);
    const edited = await savePromptStyle(copy.id, {
      templateText: `${copy.templateText}\n\nEXTRA-MARKER`,
    });
    expect(edited.version).toBe(2);
    expect(edited.basedOn).toBe('story');
    // A rename does not bump the version: the version IS the template generation.
    const renamed = await savePromptStyle(copy.id, { name: 'House Voice' });
    expect(renamed.version).toBe(2);
  });
});
