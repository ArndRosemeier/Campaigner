import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { createArtifact, getArtifact, listArtifactsByCampaign, updateArtifact } from '@/db/artifactRepo';
import { createModule as createModuleRow, getModule, patchModule } from '@/db/moduleRepo';
import { createImage } from '@/db/imageRepo';
import { updateSettings } from '@/db/settingsRepo';
import { createModule, moduleSchema, recordedWritingModel, type Id, type Module, type Persona } from '@/domain';
import { assembleModulePartsDocument } from '@/domain';
import { BUILT_IN_PERSONAS } from '@/llm/personas/builtins';
import { createPersona } from '@/db/personaRepo';
import { runEngine, type StartRunInput } from '@/llm/runEngine';
import { saveWholeModuleDocument } from '@/features/modules/canvas/saveDoc';
import { saveModulePartText } from '@/features/modules/partText';
import { db } from '@/db/db';
import { clearDatabase } from '../db/helpers';

/**
 * PROVENANCE (owner request, docs/17 row 93): "put a very small id below
 * generated texts … indicating which model wrote this. And a small id below
 * images indicating the image model."
 *
 * This file pins the RECORDING half — the value written at every seam — and
 * the two owner decisions that decide what a row may show:
 *
 *   1. text written before the field shows NOTHING (never a settings-derived
 *      guess, never a backfill);
 *   2. a hand edit KEEPS the writing model's id;
 *   3. (the third decision — never in an export — is pinned by
 *      `tests/lib/provenance-export.test.ts`).
 *
 * The load-bearing case is the FALLBACK: the model that served the call is
 * not the model the settings name, so a settings lookup would print a
 * different id than the text in front of the owner.
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
  toastErrorPersistent: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);

const CONFIGURED_MODEL = 'anthropic/claude-sonnet-4.5';
const FALLBACK_MODEL = 'potent/fallback';
const CHAT_MODEL = 'owner/experiment-model';

const VALID_REPORT = { verdict: 'consistent', summary: 'Nothing conflicts.', issues: [] };

/** A generate-persona draft with no stat block, so one chat call writes the
 * artifact's whole text. */
const VALID_DRAFT = {
  name: 'Grix',
  summary: 'A goblin alchemist boss.',
  suggestedTags: ['goblin'],
  body: '# Grix\nShe brews. She throws.',
  appearance: 'Small, soot-stained.',
  personality: 'Manic, cheerful.',
  needsStatBlock: false,
};

async function seedModule(premise: string, parts: { planIndex: number; markdown: string }[]): Promise<Module> {
  const campaign = await createCampaign({ name: 'Provenance', system: 'dnd5e' });
  const draft = createModule({
    campaignId: campaign.id,
    title: 'The Salt Road',
    concept: '',
    levelMin: 1,
    levelMax: 3,
    sizeDial: 'sketch',
  });
  const row = moduleSchema.parse({
    ...draft,
    spine: {
      premise,
      themes: [],
      partPlan: [{ title: 'Part', levelBand: '1–3', synopsis: '', levelUpTrigger: '' }],
    },
    parts: parts.map((part) => ({
      planIndex: part.planIndex,
      markdown: part.markdown,
      status: 'ready' as const,
      errorMessage: '',
      edited: false,
    })),
  });
  await createModuleRow(row);
  return (await getModule(row.id)) ?? row;
}

async function seedReviewRun(): Promise<{ campaignId: Id; persona: Persona; input: StartRunInput }> {
  const campaign = await createCampaign({ name: 'Review Land', system: 'dnd5e' });
  const target = await createArtifact({
    campaignId: campaign.id,
    kind: 'plotarc',
    name: 'The Drowned Bell',
    body: '# Arc',
  });
  const persona = BUILT_IN_PERSONAS.find((entry) => entry.slug === 'continuity-editor');
  if (persona === undefined) throw new Error('continuity-editor persona missing');
  await updateSettings({ defaultChatModel: CONFIGURED_MODEL, fallbackChatModel: FALLBACK_MODEL });
  return {
    campaignId: campaign.id,
    persona,
    input: {
      campaign: { ...campaign },
      persona,
      autonomy: 'auto' as const,
      brief: 'review the arc',
      pinnedChunkIds: [],
      targetArtifactId: target.id,
    },
  };
}

/**
 * A generate persona run (the ordinary "write me an NPC" flow). Manual
 * autonomy so a REPAIRED draft can still be approved — the repair turn is the
 * one that escalates to the fallback tier, and the artifact is created at
 * finalize from the step that ran.
 */
async function seedGenerateRun(): Promise<{ campaignId: Id; input: StartRunInput }> {
  const campaign = await createCampaign({ name: 'Generate Land', system: 'dnd5e' });
  const persona = await createPersona({
    slug: 'provenance-npc-smith',
    name: 'NPC Smith',
    description: 'test',
    systemPrompt: 'You are a test persona. Reply with JSON only.',
    producesKind: 'npc',
    builtIn: true,
  });
  await updateSettings({ defaultChatModel: CONFIGURED_MODEL, fallbackChatModel: FALLBACK_MODEL });
  return {
    campaignId: campaign.id,
    input: {
      campaign: { ...campaign },
      persona,
      autonomy: 'manual' as const,
      brief: 'a goblin alchemist boss for a level 3 party',
      pinnedChunkIds: [],
    },
  };
}

beforeEach(clearDatabase);
afterEach(() => {
  chatMock.mockReset();
  vi.restoreAllMocks();
});

describe('recording the model that served the write', () => {
  it('records the FALLBACK model when an escalation served the text', async () => {
    const { campaignId, input } = await seedGenerateRun();
    // The first reply fails its contract, so the repair turn escalates to the
    // fallback tier — and THAT reply is the text that gets saved.
    chatMock
      .mockResolvedValueOnce({ text: 'not json', modelUsed: CONFIGURED_MODEL, fallback: null })
      .mockResolvedValueOnce({
        text: JSON.stringify(VALID_DRAFT),
        modelUsed: FALLBACK_MODEL,
        fallback: null,
      });

    const runId = await runEngine.startRun(input);
    await waitFor(async () => {
      const run = await db.runs.get(runId);
      expect(run?.status).toBe('awaiting_user');
    });

    // The repair really did escalate — otherwise the claim below is vacuous.
    const models = chatMock.mock.calls.map(([, opts]) => (opts as { model: string }).model);
    expect(models).toEqual([CONFIGURED_MODEL, FALLBACK_MODEL]);

    await runEngine.approve(runId, input);
    await waitFor(async () => {
      const run = await db.runs.get(runId);
      expect(run?.status).toBe('completed');
    });

    const artifact = (await listArtifactsByCampaign(campaignId))[0];
    expect(artifact?.name).toBe(VALID_DRAFT.name);
    // THE pin: the id is the model that served the call. A settings lookup
    // (or any "read the configured model" shortcut) would have written
    // `CONFIGURED_MODEL` and lied about the text in front of the owner.
    expect(artifact?.writerModel).toBe(FALLBACK_MODEL);
    expect(artifact?.writerModel).not.toBe(CONFIGURED_MODEL);
  }, 20000);

  it('records the serving model when the first try answers (no escalation)', async () => {
    const { campaignId, input } = await seedReviewRun();
    chatMock.mockResolvedValue({
      text: JSON.stringify(VALID_REPORT),
      modelUsed: CONFIGURED_MODEL,
      fallback: null,
    });

    const runId = await runEngine.startRun(input);
    await waitFor(async () => {
      const run = await db.runs.get(runId);
      expect(run?.status).toBe('completed');
    });

    const report = (await listArtifactsByCampaign(campaignId)).find((row) => row.kind === 'note');
    expect(report?.writerModel).toBe(CONFIGURED_MODEL);
  }, 20000);
});

describe('legacy rows and the empty-means-not-recorded rule', () => {
  it('a row written before the field parses with an empty id and displays nothing', async () => {
    const campaign = await createCampaign({ name: 'Legacy', system: 'dnd5e' });
    const artifact = await createArtifact({
      campaignId: campaign.id,
      kind: 'location',
      name: 'Old Keep',
      body: 'Written before provenance existed.',
    });
    // Simulate a pre-arc row: the stored object has NO `writerModel` key at
    // all (the additive `.default('')` is what makes it parse).
    const stored = await db.artifacts.get(artifact.id);
    if (stored === undefined) throw new Error('artifact row missing');
    const { writerModel: _dropped, ...legacy } = stored as Record<string, unknown> & { writerModel: string };
    await db.artifacts.put(legacy as typeof stored);

    // Parse-on-read: no Dexie version, no migration — the row reads back.
    const read = await getArtifact(artifact.id);
    expect(read).toBeDefined();
    expect(read?.writerModel).toBe('');
    // Empty means NOT RECORDED: nothing is displayed, and nothing is invented
    // from the settings the campaign happens to have today.
    await updateSettings({ defaultChatModel: CONFIGURED_MODEL });
    expect(recordedWritingModel(read?.writerModel)).toBeNull();
  });

  it('leaves the id empty on rows a model never wrote (stubs, seeds, uploads)', async () => {
    const campaign = await createCampaign({ name: 'Handmade', system: 'dnd5e' });
    const stub = await createArtifact({ campaignId: campaign.id, kind: 'note', name: 'My own note' });
    expect(stub.writerModel).toBe('');
    const image = await createImage({
      campaignId: campaign.id,
      blob: new Blob(['hand-uploaded'], { type: 'image/webp' }),
      mimeType: 'image/webp',
      width: 4,
      height: 4,
      prompt: '',
      model: '',
      source: 'uploaded',
    });
    expect(recordedWritingModel(image.model)).toBeNull();
  });
});

describe('hand edits keep the id; a chat rewrite records the chat model', () => {
  it('a hand edit of a part KEEPS the writing model', async () => {
    const module = await seedModule('A premise written by a model.', [
      { planIndex: 0, markdown: 'Original generated prose, long enough to be a part.' },
    ]);
    const planned = (await getModule(module.id))?.parts[0];
    if (planned === undefined) throw new Error('seeded part missing');
    const spine = (await getModule(module.id))?.spine;
    if (spine === undefined || spine === null) throw new Error('seeded spine missing');
    await patchModule(module.id, {
      spine: { ...spine, writerModel: CONFIGURED_MODEL },
      parts: [{ ...planned, writerModel: CONFIGURED_MODEL }],
    });

    // The reader's hand edit: `saveModulePartText` with NO writerModel.
    await saveModulePartText(module.id, 0, 'The owner rewrote this passage by hand.');
    const after = await getModule(module.id);
    expect(after?.parts[0]?.markdown).toBe('The owner rewrote this passage by hand.');
    expect(after?.parts[0]?.edited).toBe(true);
    // Decision 2: the owner's edits must not erase which model wrote the text.
    expect(after?.parts[0]?.writerModel).toBe(CONFIGURED_MODEL);
    // The premise's id is untouched by a part write, too.
    expect(after?.spine?.writerModel).toBe(CONFIGURED_MODEL);
  });

  it('a chat-applied rewrite records the CHAT model (the last writer)', async () => {
    const module = await seedModule('A premise.', [
      { planIndex: 0, markdown: 'Original generated prose, long enough to be a part.' },
    ]);
    const planned = (await getModule(module.id))?.parts[0];
    if (planned === undefined) throw new Error('seeded part missing');
    await patchModule(module.id, {
      parts: [{ ...planned, writerModel: CONFIGURED_MODEL }],
    });

    const row = await getModule(module.id);
    if (row === undefined) throw new Error('seeded module missing');
    // The canvas chat applies its rewrite by saving the WHOLE parts document
    // (the same call `chatController` makes), so the seam under test is the
    // one the chat really goes through.
    const assembled = assembleModulePartsDocument({
      partPlan: row.spine?.partPlan ?? [],
      parts: [{ planIndex: 0, markdown: 'Rewritten by the chat model.' }],
    });
    await saveWholeModuleDocument({
      moduleId: module.id,
      doc: assembled.document,
      module: row,
      origin: 'ai',
      label: 'Chat: rewrite the opening',
      version: { source: 'chat', label: 'Chat: rewrite the opening' },
      writerModel: CHAT_MODEL,
    });

    const after = await getModule(module.id);
    expect(after?.parts[0]?.markdown).toContain('Rewritten by the chat model.');
    expect(after?.parts[0]?.writerModel).toBe(CHAT_MODEL);
  });

  it('an artifact edit that omits the field keeps it; a persona refill rewrites it', async () => {
    const campaign = await createCampaign({ name: 'Artifacts', system: 'dnd5e' });
    const npc = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Grix',
      summary: 'Model-written.',
      writerModel: CONFIGURED_MODEL,
    });

    // The artifact editor's autosave: a body patch with NO writerModel.
    await updateArtifact(npc.id, { body: 'The owner typed this.' });
    const edited = await getArtifact(npc.id);
    expect(edited?.body).toBe('The owner typed this.');
    expect(edited?.writerModel).toBe(CONFIGURED_MODEL);

    // A model write DOES move it: the last writer owns the row.
    await updateArtifact(npc.id, { body: 'Refilled by a model.', writerModel: FALLBACK_MODEL });
    expect((await getArtifact(npc.id))?.writerModel).toBe(FALLBACK_MODEL);
  });

  it('an attachment/scope write never blanks a recorded id', async () => {
    const campaign = await createCampaign({ name: 'Scoped', system: 'dnd5e' });
    const npc = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Vexra',
      writerModel: CONFIGURED_MODEL,
    });
    // A patch that touches only unrelated fields (the shape the image attach,
    // the rename helper and the encounter reset all use).
    await updateArtifact(npc.id, { tags: ['cult'] });
    expect((await getArtifact(npc.id))?.writerModel).toBe(CONFIGURED_MODEL);
  });
});

describe('recordedWritingModel — the one display rule', () => {
  it('maps only a non-blank value to an id to show', () => {
    expect(recordedWritingModel('anthropic/claude-sonnet-4.5')).toBe('anthropic/claude-sonnet-4.5');
    expect(recordedWritingModel('  spaced/model  ')).toBe('spaced/model');
    expect(recordedWritingModel('')).toBeNull();
    expect(recordedWritingModel('   ')).toBeNull();
    expect(recordedWritingModel(null)).toBeNull();
    expect(recordedWritingModel(undefined)).toBeNull();
  });
});
