import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

import { createCampaign } from '@/db/campaignRepo';
import { createArtifact } from '@/db/artifactRepo';
import { listModuleVersions } from '@/db/moduleVersionRepo';
import { getModule, patchModule, saveModule } from '@/db/moduleRepo';
import { updateSettings } from '@/db/settingsRepo';
import { assembleModulePartsDocument, createModule, modulePartSchema, moduleSpineSchema, newId, type Campaign, type Id, type Module } from '@/domain';
import {
  cancelModuleGen,
  campaignCastContext,
  CAMPAIGN_CAST_NAME_CAP,
  classifyEntityName,
  classifyNewModuleEntityNames,
  createModuleAndRun,
  generateMissingParts,
  moduleGenEvents,
  ModuleBusyError,
  normalizeModuleEntityNames,
  normalizePartMarkdown,
  parseSpine,
  parseSpineEntities,
  PRIOR_MODULE_CHAR_CAP,
  PRIOR_MODULES_TOTAL_CAP,
  PRIOR_PART_CHAR_CAP,
  priorModulesContext,
  rewritePart,
  runParts,
  runSpine,
} from '@/llm/moduleGen';
import { clearDatabase } from '../db/helpers';
import { useProgressStore } from '@/lib/progress';
import type { ChatResult } from '@/llm/openrouter';

/**
 * Module Designer generator (08-MODULE-DESIGNER M4-B) with a mocked chat:
 * spine success/invalid-JSON failure, sequential parts with continuity,
 * failed-part continuation, short-output retry, generateMissingParts,
 * rewritePart, cancel rewinds, the ModuleBusyError guard, and the
 * model-decided entity kinds (08 §M4-C).
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

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { toastError } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);

const TEST_MODEL = 'test/fixture-model';

const VALID_SPINE = {
  premise: 'A harbor town raised its bell to warn of the drownings; now the bell rings by itself.',
  themes: ['duty', 'decay'],
  partPlan: [
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
  ],
  // 08 §M4-C: the model declares each entity's kind when it invents the name.
  // The declared encounters keep the pass-0 spine gate quiet (08 §M4-B): the
  // gate needs named `kind: "encounter"` records and nothing else — the
  // retired wants/conflict-kind declarations are gone.
  entities: [
    { name: 'Warden Bellamy', kind: 'npc' },
    { name: 'The Drowned Cathedral', kind: 'location' },
    { name: 'The Tide Cult', kind: 'faction' },
    { name: 'The Bells Below', kind: 'encounter' },
    { name: 'The Flooded Nave', kind: 'encounter' },
    { name: 'The Wardens Confession', kind: 'encounter' },
  ],
};

/** The normalization reply for the spine's own entities: all map to themselves. */
const SELF_NORMALIZATION = {
  entities: [
    { name: 'Warden Bellamy', canonical: 'Warden Bellamy', kind: 'npc' },
    { name: 'The Drowned Cathedral', canonical: 'The Drowned Cathedral', kind: 'location' },
    { name: 'The Tide Cult', canonical: 'The Tide Cult', kind: 'faction' },
    { name: 'The Bells Below', canonical: 'The Bells Below', kind: 'encounter' },
    { name: 'The Flooded Nave', canonical: 'The Flooded Nave', kind: 'encounter' },
    { name: 'The Wardens Confession', canonical: 'The Wardens Confession', kind: 'encounter' },
  ],
};

/** Module prose well above the 100-char floor, with a findable marker. */
function partMarkdown(marker: string): ChatResult {
  return {
    text: `${marker}: The tide withdraws and the streets shine wet under a pale sun. `.repeat(4),
    modelUsed: 'test-model',
    fallback: null,
  };
}

/** Part prose that wiki-links the given names (for entity-kind flows). */
function partWithNames(marker: string, names: string[]): ChatResult {
  return {
    text: `${partMarkdown(marker).text} Mentioned here: ${names.map((name) => `[[${name}]]`).join(' and ')}.`,
    modelUsed: 'test-model',
    fallback: null,
  };
}

/** A normalization reply mapping every listed name to itself with its kind. */
function normalizationReply(entries: { name: string; kind: string }[]): ChatResult {
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

/** Shorthand for an all-encounter normalization reply. The retired
 * wants/conflict-kind declarations are gone: an encounter record carries its
 * kind, and what the scene IS lives in the prose (08 §M4-B, superseded). */
function encounterReply(...names: string[]): ChatResult {
  return normalizationReply(names.map((name) => ({ name, kind: 'encounter' })));
}

async function seedModule(): Promise<{ campaign: Campaign; moduleId: Id }> {
  const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
  const draft = createModule({
    campaignId: campaign.id,
    title: 'The Drowned Bell',
    concept: 'A harbor bell that rings by itself beneath the water.',
    levelMin: 1,
    levelMax: 3,
    tone: 'eerie',
    sizeDial: 'standard',
  });
  const saved = await saveModule(draft);
  return { campaign, moduleId: saved.id };
}

async function seedSpine(moduleId: Id): Promise<void> {
  await patchModule(moduleId, { spine: moduleSpineSchema.parse(VALID_SPINE) });
}

async function seedReadyPart(
  moduleId: Id,
  planIndex: number,
  markdown: string | ChatResult,
  options: { edited?: boolean } = {},
): Promise<void> {
  const current = await getModule(moduleId);
  if (current === undefined) throw new Error('seed module is missing');
  const prose = typeof markdown === 'string' ? markdown : markdown.text;
  const parts = current.parts.filter((part) => part.planIndex !== planIndex);
  parts.push({
    planIndex,
    markdown: prose,
    status: 'ready',
    errorMessage: '',
    edited: options.edited === true,
  });
  parts.sort((a, b) => a.planIndex - b.planIndex);
  await patchModule(moduleId, { parts });
}

/** Text-only view of a possibly multimodal message. */
function messageText(content: Parameters<typeof chat>[0][number]['content']): string {
  return typeof content === 'string'
    ? content
    : content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
}

/** The user message of the n-th chat call ('' when the call is missing). */
function userPromptOf(callIndex: number): string {
  const messages = chatMock.mock.calls[callIndex]?.[0];
  const content = messages?.find((message) => message.role === 'user')?.content;
  return content === undefined ? '' : messageText(content);
}

/** All user-message content of the n-th chat call, joined — retry nudges are
 * appended as a second user message after the original instruction. */
function userMessagesOf(callIndex: number): string {
  const messages = chatMock.mock.calls[callIndex]?.[0] ?? [];
  return messages
    .filter((message) => message.role === 'user')
    .map((message) => messageText(message.content))
    .join('\n\n');
}

/** Resolves only via the returned resolve — for observing in-flight states. */
function deferredChat(): { promise: Promise<ChatResult>; resolve: (value: string) => void } {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((res) => {
    resolve = res;
  });
  return { promise: promise.then((text) => ({ text, modelUsed: 'test-model', fallback: null })), resolve };
}

/**
 * A chat call that never settles on its own and rejects with AbortError when
 * the moduleGen abort signal fires (mirrors the real client's abort path).
 */
function chatUntilAborted(signal: AbortSignal | undefined): Promise<ChatResult> {
  return new Promise<ChatResult>((_resolve, reject) => {
    const abortError = (): DOMException =>
      new DOMException('The operation was aborted.', 'AbortError');
    if (signal === undefined || signal.aborted) {
      reject(abortError());
      return;
    }
    signal.addEventListener('abort', () => {
      reject(abortError());
    }, { once: true });
  });
}

/** No-op rejection handler: an earlier failing assertion in the same test
 * must not turn the still-pending run into an unhandled rejection. */
function guard<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => undefined);
  return promise;
}

beforeEach(async () => {
  await clearDatabase();
  // The generator reads the model from the settings row on every run.
  await updateSettings({ defaultChatModel: TEST_MODEL });
});

afterEach(() => {
  chatMock.mockReset();
  toastErrorMock.mockReset();
  vi.restoreAllMocks();
});

describe('moduleGen pure helpers', () => {
  it('parseSpine slices the JSON object out of surrounding prose', () => {
    const spine = parseSpine(
      `Here is the spine you asked for:\n${JSON.stringify(VALID_SPINE)}\nLet me know if you want changes.`,
    );
    // The spine schema strips the sibling `entities` record (08 §M4-C).
    expect(spine.premise).toBe(VALID_SPINE.premise);
    expect(spine.themes).toEqual(VALID_SPINE.themes);
    expect(spine.partPlan).toEqual(VALID_SPINE.partPlan);
  });

  it('parseSpine throws loudly when the reply contains no JSON object', () => {
    expect(() => parseSpine('The bell tolls for thee.')).toThrow('no JSON object');
  });

  it('normalizePartMarkdown strips one leading H1 and keeps prose of 100+ chars', () => {
    const body = 'The tide retreats down the spiral stair, leaving salt on every stone. '.repeat(3);
    const stripped = normalizePartMarkdown(`# The Sunken Quarter\n\n${body}`);
    expect(stripped.startsWith('#')).toBe(false);
    expect(stripped).toBe(body.trim());
    // Prose without an H1 passes through untouched.
    expect(normalizePartMarkdown(body)).toBe(body.trim());
  });

  it('normalizePartMarkdown throws below 100 characters', () => {
    expect(() => normalizePartMarkdown('# Title\nToo short.')).toThrow('too short');
  });
});

describe('runSpine', () => {
  it('moves generating → parses the spine → draft with spine saved and error cleared', async () => {
    const { campaign, moduleId } = await seedModule();
    // Start from a failed row to prove the run resets status and message.
    await patchModule(moduleId, { status: 'failed', errorMessage: 'stale error' });
    const deferred = deferredChat();
    chatMock.mockImplementationOnce(() => deferred.promise);
    // fix-01: the spine's entity list is normalized before storage.
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(SELF_NORMALIZATION), modelUsed: 'test-model', fallback: null });

    const pending = guard(runSpine(moduleId, campaign));
    await waitFor(async () => {
      expect((await getModule(moduleId))?.status).toBe('generating');
    });

    deferred.resolve(JSON.stringify(VALID_SPINE));
    const finished = await pending;

    expect(finished.status).toBe('draft');
    expect(finished.errorMessage).toBe('');
    expect(finished.spine?.premise).toBe(VALID_SPINE.premise);
    expect(finished.spine?.partPlan).toHaveLength(3);
    // The normalized, canonical entity kinds land on the module row (fix-01).
    expect(finished.entityKinds).toEqual(
      VALID_SPINE.entities.map((entity) => ({ ...entity, absorbed: [] })),
    );

    expect(chatMock).toHaveBeenCalledTimes(2);
    const firstCall = chatMock.mock.calls[0];
    if (firstCall === undefined) throw new Error('chat was not called');
    const [messages, options] = firstCall;
    // The call used the seeded settings.defaultChatModel and the strict
    // structured-output schema (spine + entity list, one reply).
    expect(options.model).toBe(TEST_MODEL);
    expect(options.responseFormat).toMatchObject({ kind: 'schema', name: 'module-spine' });
    const spineSchema = (options.responseFormat as { jsonSchema?: { properties?: Record<string, unknown> } })
      .jsonSchema;
    expect(Object.keys(spineSchema?.properties ?? {})).toEqual([
      'premise',
      'themes',
      'partPlan',
      'entities',
    ]);
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('Module Architect');
    const userContent = messages.find((message) => message.role === 'user')?.content ?? '';
    expect(userContent).toContain('Module concept: A harbor bell that rings by itself beneath the water.');
    expect(userContent).toContain('Party levels 1–3');
  }, 20000);

  it('retries invalid JSON once, then fails the module loudly (row + toast)', async () => {
    const { campaign, moduleId } = await seedModule();
    chatMock.mockResolvedValue({ text: 'not json at all', modelUsed: 'test-model', fallback: null });

    await expect(runSpine(moduleId, campaign)).rejects.toThrow('no JSON object');

    const after = await getModule(moduleId);
    expect(after?.status).toBe('failed');
    expect(after?.errorMessage).toContain('no JSON object');
    expect(after?.spine).toBeNull();
    expect(chatMock).toHaveBeenCalledTimes(2); // one automatic JSON-fix retry
    expect(userMessagesOf(1)).toContain('Your previous reply was invalid JSON');
    expect(toastErrorMock).toHaveBeenCalledWith('Module generation failed', expect.any(Error));
  }, 20000);

  it('refuses pass 0 for a module that already has parts, without calling chat', async () => {
    const { campaign, moduleId } = await seedModule();
    await seedSpine(moduleId);
    await seedReadyPart(moduleId, 0, partMarkdown('PART-ONE'));

    await expect(runSpine(moduleId, campaign)).rejects.toThrow('Refusing to regenerate a spine');

    expect(chatMock).not.toHaveBeenCalled();
  }, 20000);
});

describe('entity kinds — spine record (08 §M4-C)', () => {
  it('parseSpineEntities reads the model-declared entity list', () => {
    const raw = JSON.stringify(VALID_SPINE);
    expect(parseSpineEntities(raw)).toEqual(
      VALID_SPINE.entities.map((entity) => ({ ...entity, absorbed: [] })),
    );
  });

  it('parseSpineEntities rejects a reply without entities or with a foreign kind', () => {
    const { entities: _entities, ...spineOnly } = VALID_SPINE;
    expect(() => parseSpineEntities(JSON.stringify(spineOnly))).toThrow();
    const foreignKind = JSON.stringify({
      ...VALID_SPINE,
      entities: [{ name: 'The Barque', kind: 'vehicle' }],
    });
    expect(() => parseSpineEntities(foreignKind)).toThrow();
  });

  it('runSpine retries once when the entities list is missing, then succeeds', async () => {
    const { campaign, moduleId } = await seedModule();
    const { entities: _entities, ...spineOnly } = VALID_SPINE;
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(spineOnly), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_SPINE), modelUsed: 'test-model', fallback: null })
      // fix-01: the normalization call that follows the parsed spine.
      .mockResolvedValueOnce({ text: JSON.stringify(SELF_NORMALIZATION), modelUsed: 'test-model', fallback: null });

    const finished = await runSpine(moduleId, campaign);

    expect(chatMock).toHaveBeenCalledTimes(3);
    expect(userMessagesOf(1)).toContain('Your previous reply was invalid JSON');
    expect(finished.status).toBe('draft');
    expect(finished.entityKinds).toEqual(
      VALID_SPINE.entities.map((entity) => ({ ...entity, absorbed: [] })),
    );
  }, 20000);
});

describe('runParts', () => {
  it('generates parts sequentially, feeding part i the current text of part i−1', async () => {
    const { campaign, moduleId } = await seedModule();
    await seedSpine(moduleId);
    chatMock
      .mockResolvedValueOnce(partWithNames('PART-ONE', ['Ember Trial']))
      .mockResolvedValueOnce(partWithNames('PART-TWO', ['Flood Trial']))
      .mockResolvedValueOnce(partWithNames('PART-THREE', ['Bell Trial']))
      // The post-parts normalization pass maps the three encounters (08 §M4-B
      // floor gate counts on these canonicals).
      .mockResolvedValueOnce(encounterReply('Ember Trial', 'Flood Trial', 'Bell Trial'));

    const finished = await runParts(moduleId, campaign);

    expect(finished.status).toBe('ready');
    expect(finished.errorMessage).toBe('');
    expect(finished.parts.map((part) => part.planIndex)).toEqual([0, 1, 2]);
    for (const [index, marker] of ['PART-ONE', 'PART-TWO', 'PART-THREE'].entries()) {
      const part = finished.parts[index];
      expect(part?.status).toBe('ready');
      expect(part?.edited).toBe(false);
      expect(part?.errorMessage).toBe('');
      expect(part?.markdown).toContain(marker);
    }

    expect(chatMock).toHaveBeenCalledTimes(4);
    // Calls happen in plan order, one per part.
    expect(userPromptOf(0)).toContain('Write part 1: "The Sunken Quarter"');
    expect(userPromptOf(1)).toContain('Write part 2: "The Drowned Cathedral"');
    expect(userPromptOf(2)).toContain('Write part 3: "The Bell Tower"');
    // Part 0 has no predecessor; the word target comes from the size dial.
    expect(userPromptOf(0)).not.toContain('Full markdown of the previous part');
    expect(userPromptOf(0)).toContain('800–1500 words');
    // Every part prompt states its encounter share (08 §M4-B REQUIREMENT).
    expect(userPromptOf(0)).toContain('encounter floor for this part');
    // Continuity = the FINAL markdown of the previous part.
    expect(userPromptOf(1)).toContain('Full markdown of the previous part');
    expect(userPromptOf(1)).toContain('PART-ONE');
    expect(userPromptOf(2)).toContain('PART-TWO');
  }, 20000);

  it('repairs a failed part against the floor and still lands the module on ready', async () => {
    const { campaign, moduleId } = await seedModule();
    await seedSpine(moduleId);
    chatMock
      .mockResolvedValueOnce(partWithNames('PART-ONE', ['Ember Trial']))
      .mockRejectedValueOnce(new Error('provider exploded mid-part'))
      .mockResolvedValueOnce(partWithNames('PART-THREE', ['Bell Trial']))
      // First normalization: only the two landed parts name encounters.
      .mockResolvedValueOnce(encounterReply('Ember Trial', 'Bell Trial'))
      // The floor gate's ONE repair rewrite for the failed part.
      .mockResolvedValueOnce(partWithNames('PART-TWO-REPAIRED', ['Flood Trial']))
      // Second normalization after the repair.
      .mockResolvedValueOnce(encounterReply('Ember Trial', 'Flood Trial', 'Bell Trial'));

    const finished = await runParts(moduleId, campaign);

    expect(finished.status).toBe('ready');
    const [one, two, three] = finished.parts;
    expect(one?.status).toBe('ready');
    expect(one?.markdown).toContain('PART-ONE');
    expect(two?.status).toBe('ready');
    expect(two?.markdown).toContain('PART-TWO-REPAIRED');
    expect(three?.status).toBe('ready');
    expect(three?.markdown).toContain('PART-THREE');
    // Bounded repair: 3 part calls + 1 normalization + 1 repair + 1
    // re-normalization — exactly one rewrite for the deficient part.
    expect(chatMock).toHaveBeenCalledTimes(6);
    expect(userMessagesOf(4)).toContain('Encounter floor repair');
    // The immediate predecessor of part 3 is failed, so its prompt carries no
    // continuity section at all (the impl never falls back to an earlier part).
    expect(userPromptOf(2)).not.toContain('Full markdown of the previous part');
    // Part-level failures surface on the part row, not as a module toast.
    expect(toastErrorMock).not.toHaveBeenCalled();
  }, 20000);

  it('retries a <100-char part output once and succeeds', async () => {
    const { campaign, moduleId } = await seedModule();
    await seedSpine(moduleId);
    chatMock
      .mockResolvedValueOnce({ text: 'The bell rings at midnight.', modelUsed: 'test-model', fallback: null }) // 27 chars: too short
      .mockResolvedValueOnce(partWithNames('PART-ONE-RETRY', ['Ember Trial']))
      .mockResolvedValueOnce(encounterReply('Ember Trial'));

    const finished = await runParts(moduleId, campaign, { planIndexes: [0] });

    expect(chatMock).toHaveBeenCalledTimes(3);
    expect(userMessagesOf(1)).toContain('Your previous reply was too short');
    const part = finished.parts.find((entry) => entry.planIndex === 0);
    expect(part?.status).toBe('ready');
    expect(part?.markdown).toContain('PART-ONE-RETRY');
    expect(finished.status).toBe('ready');
  }, 20000);

  it('fails the module loudly when the floor repair also comes up short', async () => {
    const { campaign, moduleId } = await seedModule();
    await seedSpine(moduleId);
    // Every prose call is too short: the initial write AND the floor repair.
    chatMock.mockResolvedValue({ text: 'The bell rings at midnight.', modelUsed: 'test-model', fallback: null });

    const finished = await runParts(moduleId, campaign, { planIndexes: [0] });

    // 2 initial (short + short retry → part failed, no names → no
    // normalization call) + 2 repair (short + short retry → still failed).
    expect(chatMock).toHaveBeenCalledTimes(4);
    const part = finished.parts.find((entry) => entry.planIndex === 0);
    expect(part?.status).toBe('failed');
    expect(part?.errorMessage).toContain('too short');
    expect(part?.markdown).toBe('');
    // The gate fails the module LOUDLY — never ready, parts named.
    expect(finished.status).toBe('failed');
    expect(finished.errorMessage).toContain('Encounter floor not met');
    expect(finished.errorMessage).toContain('The Sunken Quarter');
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Module generation failed: encounter floor not met',
      expect.any(Error),
    );
  }, 20000);
});

describe('generateMissingParts', () => {
  it('only generates the parts that are not ready yet', async () => {
    const { campaign, moduleId } = await seedModule();
    await seedSpine(moduleId);
    await seedReadyPart(moduleId, 0, partWithNames('PART-ONE-ORIGINAL', ['Ember Trial']));
    chatMock
      .mockResolvedValueOnce(partWithNames('PART-TWO', ['Flood Trial']))
      .mockResolvedValueOnce(partWithNames('PART-THREE', ['Bell Trial']))
      .mockResolvedValueOnce(encounterReply('Ember Trial', 'Flood Trial', 'Bell Trial'));

    await generateMissingParts(moduleId, campaign);

    // Part 0 was ready and is never re-called.
    expect(chatMock).toHaveBeenCalledTimes(3);
    expect(userPromptOf(0)).toContain('Write part 2:');
    expect(userPromptOf(0)).not.toContain('Write part 1:');
    expect(userPromptOf(1)).toContain('Write part 3:');
    const after = await getModule(moduleId);
    expect(after?.status).toBe('ready');
    expect(after?.parts.map((part) => part.status)).toEqual(['ready', 'ready', 'ready']);
    expect(after?.parts.find((part) => part.planIndex === 0)?.markdown).toContain(
      'PART-ONE-ORIGINAL',
    );
  }, 20000);

  it('is a no-op when every part is already ready', async () => {
    const { campaign, moduleId } = await seedModule();
    await seedSpine(moduleId);
    await seedReadyPart(moduleId, 0, partMarkdown('PART-ONE'));
    await seedReadyPart(moduleId, 1, partMarkdown('PART-TWO'));
    await seedReadyPart(moduleId, 2, partMarkdown('PART-THREE'));

    await generateMissingParts(moduleId, campaign);

    expect(chatMock).not.toHaveBeenCalled();
    expect((await getModule(moduleId))?.status).toBe('draft');
  }, 20000);
});

describe('rewritePart', () => {
  it('passes the instruction, reuses the predecessor text, overwrites, resets edited', async () => {
    const { campaign, moduleId } = await seedModule();
    await seedSpine(moduleId);
    await seedReadyPart(moduleId, 0, partWithNames('PART-ONE-ORIGINAL', ['Ember Trial']));
    await seedReadyPart(moduleId, 1, partWithNames('PART-TWO-OLD', ['Flood Trial']), { edited: true });
    await seedReadyPart(moduleId, 2, partWithNames('PART-THREE-ORIGINAL', ['Bell Trial']));
    chatMock
      .mockResolvedValueOnce(partWithNames('PART-TWO-NEW', ['Flood Trial']))
      .mockResolvedValueOnce(encounterReply('Ember Trial', 'Flood Trial', 'Bell Trial'));

    await rewritePart(moduleId, campaign, 1, 'Foreshadow the bell tower more heavily.');

    expect(chatMock).toHaveBeenCalledTimes(2);
    const prompt = userPromptOf(0);
    expect(prompt).toContain(
      'Additional instruction from the GM: Foreshadow the bell tower more heavily.',
    );
    // Continuity comes from part 1's predecessor (part 0's current text).
    expect(prompt).toContain('PART-ONE-ORIGINAL');
    const after = await getModule(moduleId);
    expect(after?.status).toBe('ready');
    const one = after?.parts.find((part) => part.planIndex === 0);
    expect(one?.markdown).toContain('PART-ONE-ORIGINAL'); // untouched
    const two = after?.parts.find((part) => part.planIndex === 1);
    expect(two?.status).toBe('ready');
    expect(two?.markdown).toContain('PART-TWO-NEW');
    expect(two?.edited).toBe(false); // hand-edit flag reset by the rewrite
  }, 20000);
});

describe('cancelModuleGen', () => {
  it('rewinds a spine-only module to draft and rejects with AbortError', async () => {
    const { campaign, moduleId } = await seedModule();
    chatMock.mockImplementationOnce((_messages, options) => chatUntilAborted(options.signal));
    const pending = guard(runSpine(moduleId, campaign));
    await waitFor(async () => {
      expect((await getModule(moduleId))?.status).toBe('generating');
    });

    cancelModuleGen(moduleId);

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect((await getModule(moduleId))?.status).toBe('draft');
    // Cancellation is not an error surface: no toast.
    expect(toastErrorMock).not.toHaveBeenCalled();
  }, 20000);

  it('with existing ready parts: module back to ready, in-flight part parked as pending', async () => {
    const { campaign, moduleId } = await seedModule();
    await seedSpine(moduleId);
    await seedReadyPart(moduleId, 0, partMarkdown('PART-ONE-ORIGINAL'));
    chatMock.mockImplementationOnce((_messages, options) => chatUntilAborted(options.signal));
    const pending = guard(runParts(moduleId, campaign, { planIndexes: [1] }));
    await waitFor(async () => {
      const module = await getModule(moduleId);
      expect(module?.parts.find((part) => part.planIndex === 1)?.status).toBe('generating');
    });

    cancelModuleGen(moduleId);

    // The parts run RESOLVES on abort (its Retry buttons must stay usable).
    const after = await pending;
    expect(after.status).toBe('ready');
    const part0 = after.parts.find((part) => part.planIndex === 0);
    expect(part0?.status).toBe('ready');
    expect(part0?.markdown).toContain('PART-ONE-ORIGINAL');
    const part1 = after.parts.find((part) => part.planIndex === 1);
    expect(part1?.status).toBe('pending');
    expect(part1?.errorMessage).toBe('Cancelled');
  }, 20000);
});

describe('stop-all aborts the parts chain (signal.aborted is the source of truth)', () => {
  /**
   * A chat call that hangs until the moduleGen abort signal fires, then
   * rejects with whatever shape the factory builds — stands in for every way
   * the streaming pipeline can surface a user stop (same-realm AbortError,
   * cross-realm AbortError, wrapped transport error, …).
   */
  function chatUntilAbortedWith(
    signal: AbortSignal | undefined,
    makeError: () => Error,
  ): Promise<ChatResult> {
    return new Promise<ChatResult>((_resolve, reject) => {
      if (signal === undefined || signal.aborted) {
        reject(makeError());
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          reject(makeError());
        },
        { once: true },
      );
    });
  }

  it('abort mid-parts stops the chain: later parts never start (call counts)', async () => {
    const { campaign, moduleId } = await seedModule();
    await seedSpine(moduleId);
    chatMock.mockResolvedValueOnce(partMarkdown('PART-ONE'));
    chatMock.mockImplementationOnce((_messages, options) => chatUntilAborted(options.signal));

    const pending = guard(runParts(moduleId, campaign));
    await waitFor(async () => {
      const module = await getModule(moduleId);
      expect(module?.parts.find((part) => part.planIndex === 1)?.status).toBe('generating');
    });

    cancelModuleGen(moduleId);

    // The parts run RESOLVES on abort (its Retry buttons must stay usable).
    const after = await pending;
    // Part 2's chat never started: the chain stopped instead of advancing.
    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(after.status).toBe('ready');
    expect(after.errorMessage).toBe('');
    const part0 = after.parts.find((part) => part.planIndex === 0);
    expect(part0?.status).toBe('ready');
    expect(part0?.markdown).toContain('PART-ONE');
    const part1 = after.parts.find((part) => part.planIndex === 1);
    expect(part1?.status).toBe('pending');
    expect(part1?.errorMessage).toBe('Cancelled');
    expect(after.parts.find((part) => part.planIndex === 2)).toBeUndefined();
    // Cancellation is not an error surface: no failure toast, no errorMessage.
    expect(toastErrorMock).not.toHaveBeenCalled();
    // The dock job is finished: no 'generating' ghost left behind.
    expect(
      useProgressStore.getState().jobs.some((job) => job.id === `module-parts-${moduleId}`),
    ).toBe(false);
  }, 20000);

  const abortShapes: [string, () => Error][] = [
    ['same-realm AbortError', () => new DOMException('The operation was aborted.', 'AbortError')],
    // Cross-realm stand-in: the name matches but the prototype chain does
    // not, so `instanceof DOMException` is false — the probed real abort
    // mid-stream under jsdom (CTOR DOMException, name AbortError).
    [
      'cross-realm AbortError shape',
      () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }),
    ],
    ['plain transport Error', () => new Error('connection reset mid-stream')],
    ['reader-style TypeError', () => new TypeError('Body used already for another stream')],
  ];

  for (const [shapeName, makeError] of abortShapes) {
    it(`stops the chain when the abort surfaces as: ${shapeName}`, async () => {
      const { campaign, moduleId } = await seedModule();
      await seedSpine(moduleId);
      chatMock.mockResolvedValueOnce(partMarkdown('PART-ONE'));
      chatMock.mockImplementationOnce((_messages, options) =>
        chatUntilAbortedWith(options.signal, makeError),
      );

      const pending = guard(runParts(moduleId, campaign));
      await waitFor(async () => {
        const module = await getModule(moduleId);
        expect(module?.parts.find((part) => part.planIndex === 1)?.status).toBe('generating');
      });

      cancelModuleGen(moduleId);

      const after = await pending;
      // Misclassification would continue the chain into part 2 (a third chat
      // call); cancellation stops it regardless of the error shape.
      expect(chatMock).toHaveBeenCalledTimes(2);
      expect(after.status).toBe('ready');
      expect(after.errorMessage).toBe('');
      expect(after.parts.find((part) => part.planIndex === 1)?.status).toBe('pending');
      expect(toastErrorMock).not.toHaveBeenCalled();
      expect(
        useProgressStore.getState().jobs.some((job) => job.id === `module-parts-${moduleId}`),
      ).toBe(false);
    }, 20000);
  }

  it('does not advance past a part that completed after the stop was requested', async () => {
    const { campaign, moduleId } = await seedModule();
    await seedSpine(moduleId);
    chatMock.mockResolvedValueOnce(partMarkdown('PART-ONE'));
    const partTwo = deferredChat();
    chatMock.mockImplementationOnce(() => partTwo.promise);

    const pending = guard(runParts(moduleId, campaign));
    await waitFor(async () => {
      const module = await getModule(moduleId);
      expect(module?.parts.find((part) => part.planIndex === 1)?.status).toBe('generating');
    });

    cancelModuleGen(moduleId);
    // The transport delivers part 2 anyway (late abort delivery) — the loop
    // guard still stops the chain instead of advancing to part 3.
    partTwo.resolve(partMarkdown('PART-TWO').text);

    const after = await pending;
    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(after.status).toBe('ready');
    expect(after.errorMessage).toBe('');
    // Work that already landed stays; nothing new starts.
    expect(after.parts.find((part) => part.planIndex === 1)?.status).toBe('ready');
    expect(after.parts.find((part) => part.planIndex === 2)).toBeUndefined();
    expect(toastErrorMock).not.toHaveBeenCalled();
  }, 20000);

  it('runSpine treats a non-AbortError rejection after abort as cancellation', async () => {
    const { campaign, moduleId } = await seedModule();
    chatMock.mockImplementationOnce((_messages, options) =>
      chatUntilAbortedWith(options.signal, () => new Error('connection reset mid-stream')),
    );

    const pending = guard(runSpine(moduleId, campaign));
    await waitFor(async () => {
      expect((await getModule(moduleId))?.status).toBe('generating');
    });

    cancelModuleGen(moduleId);

    await expect(pending).rejects.toThrow('connection reset mid-stream');
    // Quiet rewind to draft — not a failed row, not a toast.
    expect((await getModule(moduleId))?.status).toBe('draft');
    expect(toastErrorMock).not.toHaveBeenCalled();
  }, 20000);
});

describe('ModuleBusyError', () => {
  it('rejects a second spine run on the same module while one is in flight', async () => {
    const { campaign, moduleId } = await seedModule();
    const deferred = deferredChat();
    chatMock.mockImplementationOnce(() => deferred.promise);
    // fix-01: once the spine lands, the entity normalization call follows.
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(SELF_NORMALIZATION), modelUsed: 'test-model', fallback: null });
    const first = guard(runSpine(moduleId, campaign));
    await waitFor(async () => {
      expect((await getModule(moduleId))?.status).toBe('generating');
    });

    await expect(runSpine(moduleId, campaign)).rejects.toThrow(ModuleBusyError);

    // The rejected start touched nothing: no extra chat call, the in-flight
    // row is still generating, and there is no failure toast.
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect((await getModule(moduleId))?.status).toBe('generating');
    expect(toastErrorMock).not.toHaveBeenCalled();

    // The first run completes normally once its chat resolves.
    deferred.resolve(JSON.stringify(VALID_SPINE));
    const finished = await first;
    expect(finished.status).toBe('draft');
    expect(finished.spine).not.toBeNull();
  }, 20000);
});

describe('entity name normalization (fix-01)', () => {
  it('replaces entityKinds with canonical records and rewrites generated part text', async () => {
    const { campaign, moduleId } = await seedModule();
    await seedSpine(moduleId);
    await seedReadyPart(moduleId, 0, partWithNames('PART-ONE', ['Guard Halmund', 'Halmunds', 'Halmund']));
    await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Halmund',
      summary: 'The guard of the drowned bell.',
    });
    chatMock.mockResolvedValueOnce({ text: JSON.stringify({
        entities: [
          { name: 'Guard Halmund', canonical: 'Halmund', kind: 'npc' },
          { name: 'Halmunds', canonical: 'Halmund', kind: 'npc' },
          { name: 'Halmund', canonical: 'Halmund', kind: 'npc' },
        ],
      }), modelUsed: 'test-model', fallback: null });

    await normalizeModuleEntityNames(moduleId);

    const after = await getModule(moduleId);
    expect(after?.entityNamesNormalized).toBe(true);
    expect(after?.entityNormalizationError).toBe('');
    // REPLACED, not merged: one canonical record carrying the absorbed variants.
    expect(after?.entityKinds).toEqual([
      { name: 'Halmund', kind: 'npc', absorbed: ['Guard Halmund', 'Halmunds'] },
    ]);
    // Generated part: link targets rewritten, display text preserved.
    const part = after?.parts.find((entry) => entry.planIndex === 0);
    expect(part?.markdown).toContain('[[Halmund|Guard Halmund]]');
    expect(part?.markdown).toContain('[[Halmund|Halmunds]]');
    expect(part?.markdown).toContain('[[Halmund]]');
    // The variant names became aliases on the canonical artifact.
    const { listArtifactsByCampaign } = await import('@/db/artifactRepo');
    const artifacts = await listArtifactsByCampaign(campaign.id);
    expect(artifacts[0]?.aliases).toEqual(['Guard Halmund', 'Halmunds']);
    // No hand-edited text involved → no proposals.
    expect(after?.entityRewriteProposals).toBeNull();
  }, 20000);

  it('holds hand-edited parts and the premise as proposals instead of rewriting', async () => {
    const { moduleId } = await seedModule();
    await patchModule(moduleId, {
      spine: moduleSpineSchema.parse({ ...VALID_SPINE, premise: 'The bell tolls for [[Halmund]] and [[Guard Halmund]].' }),
    });
    await seedReadyPart(moduleId, 0, partWithNames('PART-ONE', ['Halmunds']));
    await seedReadyPart(moduleId, 1, partWithNames('PART-TWO', ['Halmunds']), { edited: true });
    chatMock.mockResolvedValueOnce({ text: JSON.stringify({
        entities: [
          { name: 'Guard Halmund', canonical: 'Halmund', kind: 'npc' },
          { name: 'Halmunds', canonical: 'Halmund', kind: 'npc' },
          { name: 'Halmund', canonical: 'Halmund', kind: 'npc' },
        ],
      }), modelUsed: 'test-model', fallback: null });

    await normalizeModuleEntityNames(moduleId);

    const after = await getModule(moduleId);
    // The generated part was rewritten; the premise and the hand-edited part
    // were not.
    expect(after?.parts.find((entry) => entry.planIndex === 0)?.markdown).toContain('[[Halmund|Halmunds]]');
    expect(after?.spine?.premise).toContain('[[Guard Halmund]]');
    expect(after?.parts.find((entry) => entry.planIndex === 1)?.markdown).toContain('[[Halmunds]]');
    expect(after?.parts.find((entry) => entry.planIndex === 1)?.edited).toBe(true);
    expect(after?.entityRewriteProposals).toEqual([
      { planIndex: -1, replacements: [{ from: 'Guard Halmund', to: 'Halmund' }] },
      { planIndex: 1, replacements: [{ from: 'Halmunds', to: 'Halmund' }] },
    ]);
  }, 20000);

  it('records the failure and toasts when the reply is invalid twice; the module stays ready', async () => {
    const { moduleId } = await seedModule();
    await seedSpine(moduleId);
    await seedReadyPart(moduleId, 0, partWithNames('PART-ONE', ['The Undercroft']));
    chatMock.mockResolvedValue({ text: JSON.stringify({ entities: [{ name: 'Ghost', canonical: 'Ghost', kind: 'npc' }] }), modelUsed: 'test-model', fallback: null });

    await normalizeModuleEntityNames(moduleId);

    const after = await getModule(moduleId);
    expect(after?.entityNamesNormalized).toBe(false);
    expect(after?.entityNormalizationError).toContain('omitted the listed name "The Undercroft"');
    expect(chatMock).toHaveBeenCalledTimes(2); // one retry with the violations stated
    expect(userMessagesOf(1)).toContain('Your previous reply was invalid');
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Entity name normalization failed — retry from the entity panel',
      expect.any(Error),
    );
  }, 20000);

  it('classifies a single hand-typed name with kind and canonical verdict', async () => {
    chatMock.mockResolvedValueOnce({ text: JSON.stringify({ entities: [{ name: 'Some Guard', canonical: 'Halmund', kind: 'npc' }] }), modelUsed: 'test-model', fallback: null });

    const verdict = await classifyEntityName('Some Guard', 'Some Guard watches the quay.', 'A haunted keep.', [
      'Halmund',
    ]);

    expect(verdict).toEqual({ kind: 'npc', canonical: 'Halmund' });
    const prompt = userPromptOf(0);
    expect(prompt).toContain('Some Guard watches the quay.');
    expect(prompt).toContain('A haunted keep.');
    expect(prompt).toContain('Halmund'); // the campaign artifact index is included
  }, 20000);

  it('classifyEntityName rejects a contract-violating reply after the retry', async () => {
    // The reply never answers for the requested name — an invalid reply after
    // the one retry must throw, never silently resolve.
    chatMock.mockResolvedValue({ text: JSON.stringify({ entities: [{ name: 'Someone Else', canonical: 'Someone Else', kind: 'npc' }] }), modelUsed: 'test-model', fallback: null });

    await expect(classifyEntityName('Kael', '', '', [])).rejects.toThrow('violated its contract');
    expect(chatMock).toHaveBeenCalledTimes(2);
  }, 20000);

  it('normalization failure plus an encounter shortfall fails the module loudly (both recorded)', async () => {
    const { campaign, moduleId } = await seedModule();
    await seedSpine(moduleId);
    chatMock
      .mockResolvedValueOnce(partWithNames('PART-ONE', ['Kael']))
      .mockResolvedValueOnce(partWithNames('PART-TWO', ['The Undercroft']))
      .mockResolvedValueOnce(partWithNames('PART-THREE', []))
      // The normalization pass fails twice (call + retry) — and the prose
      // names no encounters, so the floor gate cannot pass either.
      .mockRejectedValueOnce(new Error('normalization provider down'))
      .mockRejectedValueOnce(new Error('normalization provider down'))
      // The floor repair rewrites each deficient part once — the provider is
      // still down, so every repair fails on its part row.
      .mockRejectedValueOnce(new Error('normalization provider down'))
      .mockRejectedValueOnce(new Error('normalization provider down'))
      .mockRejectedValueOnce(new Error('normalization provider down'));

    const finished = await runParts(moduleId, campaign);

    // 3 part calls + 1 normalization attempt (a transport error fails the
    // pass outright — only invalid replies retry) + exactly ONE repair
    // attempt per deficient part (3) + 1 re-normalization attempt: the
    // repair is bounded, then the module fails loudly.
    expect(chatMock).toHaveBeenCalledTimes(8);
    expect(finished.status).toBe('failed');
    expect(finished.errorMessage).toContain('Encounter floor not met');
    // Good parts are preserved: the failed repairs restored the pre-repair
    // prose (no rollback of content — the parts stay retryable).
    expect(finished.parts.every((part) => part.status === 'ready')).toBe(true);
    expect(finished.parts[0]?.markdown).toContain('PART-ONE');
    // The normalization failure stays recorded on the row (loud, retryable
    // in the panel) — the floor message says the count used stale kinds.
    const after = await getModule(moduleId);
    expect(after?.entityNamesNormalized).toBe(false);
    expect(after?.entityNormalizationError).toContain('normalization provider down');
    expect(finished.errorMessage).toContain('last recorded kinds');
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Entity name normalization failed — retry from the entity panel',
      expect.any(Error),
    );
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Module generation failed: encounter floor not met',
      expect.any(Error),
    );
  }, 20000);
});

describe('incremental classification of names the text picked up later (08 §M4-C)', () => {
  /** A module whose last pass succeeded: `Kael` recorded, gate open. */
  async function seedNormalizedModule(): Promise<{ campaign: Campaign; moduleId: Id }> {
    const seeded = await seedModule();
    await seedSpine(seeded.moduleId);
    await seedReadyPart(seeded.moduleId, 0, partWithNames('PART-ONE', ['Kael']));
    chatMock.mockResolvedValueOnce(normalizationReply([{ name: 'Kael', kind: 'npc' }]));
    await normalizeModuleEntityNames(seeded.moduleId);
    chatMock.mockClear();
    return seeded;
  }

  it('records ONLY the new names, leaves the recorded ones byte-identical and never calls twice', async () => {
    const { moduleId } = await seedNormalizedModule();
    const before = await getModule(moduleId);
    const recordedKael = before?.entityKinds[0];
    expect(recordedKael?.name).toBe('Kael');
    // A later text change (any event: chat, hand edit, rewrite, restore).
    await seedReadyPart(moduleId, 0, partWithNames('PART-ONE', ['Kael', 'Harbormaster Vex']));
    chatMock.mockResolvedValueOnce(normalizationReply([{ name: 'Harbormaster Vex', kind: 'npc' }]));

    const result = await classifyNewModuleEntityNames(moduleId);

    expect(result).toEqual({ classified: ['Harbormaster Vex'], failed: false });
    const after = await getModule(moduleId);
    // Untouched and not re-keyed (identity is the domain helper's unit pin;
    // a row read re-parses, so compare values here).
    expect(after?.entityKinds[0]).toEqual(recordedKael);
    expect(after?.entityKinds.map((entry) => entry.name)).toEqual(['Kael', 'Harbormaster Vex']);
    expect(after?.entityKinds[1]?.kind).toBe('npc');
    expect(after?.entityNamesNormalized).toBe(true);
    expect(after?.entityNormalizationError).toBe('');
    expect(chatMock).toHaveBeenCalledTimes(1);
    // The pass was asked about the NEW names only; the recorded canonical rode
    // along as the (legal) vocabulary, never as a name to answer for.
    const prompt = userMessagesOf(0);
    expect(prompt).toContain('Harbormaster Vex');
    expect(prompt).toContain('Entity names already recorded for this module');
    expect(prompt).not.toContain('- Kael');

    // Idempotent: a second run has nothing to classify — no call, no write.
    const again = await classifyNewModuleEntityNames(moduleId);
    expect(again).toEqual({ classified: [], failed: false });
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect((await getModule(moduleId))?.entityKinds).toEqual(after?.entityKinds);
  }, 20000);

  it('folds a new variant onto a RECORDED canonical without a duplicate record (held as a proposal)', async () => {
    const { moduleId } = await seedNormalizedModule();
    // The variant arrives in hand-edited text (the one part-text save path
    // stamps `edited: true` — a chat-applied part is exactly this case).
    await seedReadyPart(moduleId, 0, partWithNames('PART-ONE', ['Kael', 'Warden Kael']), {
      edited: true,
    });
    chatMock.mockResolvedValueOnce({
      text: JSON.stringify({
        entities: [{ name: 'Warden Kael', canonical: 'Kael', kind: 'npc' }],
      }),
      modelUsed: 'test-model',
      fallback: null,
    });

    const result = await classifyNewModuleEntityNames(moduleId);

    expect(result).toEqual({ classified: ['Warden Kael'], failed: false });
    const after = await getModule(moduleId);
    // No second record for the variant, and the canonical's record is intact.
    expect(after?.entityKinds.map((entry) => entry.name)).toEqual(['Kael']);
    // The rewrite waits for consent — the edited text is NOT touched.
    expect(after?.entityRewriteProposals).toEqual([
      { planIndex: 0, replacements: [{ from: 'Warden Kael', to: 'Kael' }] },
    ]);
    expect(after?.parts[0]?.markdown).toContain('[[Warden Kael]]');
    expect(after?.entityNamesNormalized).toBe(true);
  }, 20000);

  it('preserves a review the user has not answered and unions the new rewrites', async () => {
    const { moduleId } = await seedNormalizedModule();
    await patchModule(moduleId, {
      entityRewriteProposals: [{ planIndex: -1, replacements: [{ from: 'the Bell', to: 'Bell' }] }],
    });
    await seedReadyPart(moduleId, 0, partWithNames('PART-ONE', ['Kael', 'Warden Kael']), {
      edited: true,
    });
    chatMock.mockResolvedValueOnce({
      text: JSON.stringify({
        entities: [{ name: 'Warden Kael', canonical: 'Kael', kind: 'npc' }],
      }),
      modelUsed: 'test-model',
      fallback: null,
    });

    await classifyNewModuleEntityNames(moduleId);

    expect((await getModule(moduleId))?.entityRewriteProposals).toEqual([
      { planIndex: -1, replacements: [{ from: 'the Bell', to: 'Bell' }] },
      { planIndex: 0, replacements: [{ from: 'Warden Kael', to: 'Kael' }] },
    ]);
  }, 20000);

  it('records the failure, closes the gate and adds NO record when the reply is invalid twice', async () => {
    const { moduleId } = await seedNormalizedModule();
    const before = await getModule(moduleId);
    await seedReadyPart(moduleId, 0, partWithNames('PART-ONE', ['Kael', 'Harbormaster Vex']));
    // Answers for the wrong name — invalid after the one stated retry.
    chatMock.mockResolvedValue({
      text: JSON.stringify({ entities: [{ name: 'Ghost', canonical: 'Ghost', kind: 'npc' }] }),
      modelUsed: 'test-model',
      fallback: null,
    });

    const result = await classifyNewModuleEntityNames(moduleId);

    expect(result).toEqual({ classified: [], failed: true });
    const after = await getModule(moduleId);
    // Nothing guessed: no record for the unverified name, the existing record
    // survives, and the gate is CLOSED with the error recorded (loud).
    expect(after?.entityKinds).toEqual(before?.entityKinds);
    expect(after?.entityNamesNormalized).toBe(false);
    expect(after?.entityNormalizationError).toContain('invented a name');
    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(userMessagesOf(1)).toContain('Your previous reply was invalid');
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Entity name normalization failed — retry from the entity panel',
      expect.any(Error),
    );
  }, 20000);

  it('refuses to run while the row still says the text is not normalized (the full pass owns that)', async () => {
    const { moduleId } = await seedNormalizedModule();
    await patchModule(moduleId, { entityNamesNormalized: false });
    chatMock.mockClear();

    await expect(classifyNewModuleEntityNames(moduleId)).rejects.toThrow(
      'Entity names are not normalized for the current text',
    );
    expect(chatMock).not.toHaveBeenCalled();
  }, 20000);

  it('leaves another module of the same campaign untouched', async () => {
    const { campaign, moduleId } = await seedNormalizedModule();
    const other = await saveModule(
      createModule({
        campaignId: campaign.id,
        title: 'The Other Bell',
        concept: 'A second module in the same campaign.',
        levelMin: 1,
        levelMax: 2,
        sizeDial: 'sketch',
      }),
    );
    await patchModule(other.id, {
      spine: moduleSpineSchema.parse(VALID_SPINE),
      parts: [
        modulePartSchema.parse({
          planIndex: 0,
          markdown: 'The bells of [[Kael]] ring.',
          status: 'ready',
          errorMessage: '',
          edited: false,
        }),
      ],
      entityKinds: [{ name: 'Kael', kind: 'npc', absorbed: [] }],
      entityNamesNormalized: true,
    });
    const otherBefore = await getModule(other.id);
    await seedReadyPart(moduleId, 0, partWithNames('PART-ONE', ['Kael', 'Harbormaster Vex']));
    chatMock.mockResolvedValueOnce(normalizationReply([{ name: 'Harbormaster Vex', kind: 'npc' }]));

    await classifyNewModuleEntityNames(moduleId);

    const otherAfter = await getModule(other.id);
    expect(otherAfter?.entityKinds).toEqual(otherBefore?.entityKinds);
    expect(otherAfter?.parts).toEqual(otherBefore?.parts);
    expect(otherAfter?.entityNamesNormalized).toBe(true);
    expect(otherAfter?.entityRewriteProposals).toBeNull();
    // The classified module keeps its own record set.
    expect((await getModule(moduleId))?.entityKinds.map((entry) => entry.name)).toEqual([
      'Kael',
      'Harbormaster Vex',
    ]);
  }, 20000);

  it('snapshots the pre-change document before it writes — and not at all when there is nothing to do', async () => {
    const { moduleId } = await seedNormalizedModule();
    expect((await listModuleVersions(moduleId)).length).toBeGreaterThan(0);
    const versionsBefore = (await listModuleVersions(moduleId)).length;
    await seedReadyPart(moduleId, 0, partWithNames('PART-ONE', ['Kael', 'Harbormaster Vex']));
    const before = await getModule(moduleId);
    chatMock.mockResolvedValueOnce(normalizationReply([{ name: 'Harbormaster Vex', kind: 'npc' }]));

    await classifyNewModuleEntityNames(moduleId);

    const versions = await listModuleVersions(moduleId);
    expect(versions).toHaveLength(versionsBefore + 1);
    expect(versions[0]?.source).toBe('normalization');
    expect(versions[0]?.label).toBe('Classify new entity names');
    const captured = assembleModulePartsDocument({
      partPlan: before?.spine?.partPlan ?? [],
      parts: before?.parts ?? [],
    }).document;
    expect(versions[0]?.docText).toBe(captured);

    // The no-op run (nothing unclassified) must not add a version row.
    await classifyNewModuleEntityNames(moduleId);
    expect(await listModuleVersions(moduleId)).toHaveLength(versionsBefore + 1);
  }, 20000);
});

describe('prior-module continuity (opt-in, 08 §M4-B)', () => {
  /** A prior module of the same campaign with premise + one written part. */
  async function seedPriorModule(campaignId: Id): Promise<Id> {
    const draft = createModule({
      campaignId,
      title: 'The Salt Ward',
      concept: 'The chapter before this one.',
      levelMin: 1,
      levelMax: 2,
      tone: '',
      sizeDial: 'sketch',
    });
    const saved = await saveModule(draft);
    await patchModule(saved.id, {
      spine: moduleSpineSchema.parse({
        premise: 'The Salt Ward burned on the first night of the tide.',
        themes: ['salt'],
        partPlan: [
          { title: 'The Burning Ward', levelBand: '1', synopsis: 'Fire on the docks.', levelUpTrigger: 'The ward falls.' },
        ],
      }),
      parts: [
        modulePartSchema.parse({
          planIndex: 0,
          markdown: partMarkdown('PRIOR-PART-MARKER').text,
          status: 'ready',
          errorMessage: '',
          edited: false,
        }),
      ],
    });
    return saved.id;
  }

  it('includes prior modules in the spine prompt when opted in, excluding the module itself', async () => {
    const { campaign, moduleId } = await seedModule();
    await patchModule(moduleId, { includePriorModules: true });
    await seedPriorModule(campaign.id);
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_SPINE), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(SELF_NORMALIZATION), modelUsed: 'test-model', fallback: null });

    await runSpine(moduleId, campaign);

    const prompt = userPromptOf(0);
    expect(prompt).toContain('Previous modules of this campaign');
    expect(prompt).toContain('The Salt Ward');
    expect(prompt).toContain('The Salt Ward burned on the first night of the tide.');
    expect(prompt).toContain('PRIOR-PART-MARKER');
    // The module itself is never part of its own prior context.
    expect(prompt).not.toContain('## The Drowned Bell');
  }, 20000);

  it('omits the section when the flag is off (default)', async () => {
    const { campaign, moduleId } = await seedModule();
    await patchModule(moduleId, { includePriorModules: false });
    await seedPriorModule(campaign.id);
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_SPINE), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(SELF_NORMALIZATION), modelUsed: 'test-model', fallback: null });

    await runSpine(moduleId, campaign);

    expect(userPromptOf(0)).not.toContain('Previous modules of this campaign');
  }, 20000);

  it('parts prompts include prior modules when opted in', async () => {
    const { campaign, moduleId } = await seedModule();
    await patchModule(moduleId, { includePriorModules: true });
    await seedSpine(moduleId);
    await seedPriorModule(campaign.id);
    chatMock.mockResolvedValueOnce(partMarkdown('PART-ONE'));

    await runParts(moduleId, campaign, { planIndexes: [0] });

    const prompt = userPromptOf(0);
    expect(prompt).toContain('Previous modules of this campaign');
    expect(prompt).toContain('PRIOR-PART-MARKER');
  }, 20000);
});

describe('priorModulesContext (pure builder)', () => {
  const CAMPAIGN = '00000000-0000-4000-8000-0000000000c9';

  /** A prior module with optional premise and one written part. */
  function priorWith(
    title: string,
    createdAt: number,
    options: { premise?: string; partChars?: number } = {},
  ): Module {
    const draft = createModule({
      campaignId: CAMPAIGN,
      title,
      concept: '',
      levelMin: 1,
      levelMax: 2,
      sizeDial: 'standard',
    });
    const parts =
      options.partChars === undefined
        ? []
        : [
            modulePartSchema.parse({
              planIndex: 0,
              markdown: 'x'.repeat(options.partChars),
              status: 'ready',
              errorMessage: '',
              edited: false,
            }),
          ];
    const spine =
      options.premise === undefined
        ? null
        : moduleSpineSchema.parse({
            premise: options.premise,
            themes: [],
            partPlan: [
              { title: 'Only', levelBand: '1', synopsis: 'Only part.', levelUpTrigger: 'End.' },
            ],
          });
    return { ...draft, createdAt, spine, parts };
  }

  it('returns null when no prior module carries text', () => {
    expect(priorModulesContext([])).toBeNull();
    expect(priorModulesContext([priorWith('Empty', 1), priorWith('Also empty', 2)])).toBeNull();
  });

  it('includes premise-only and parts-only drafts alike', () => {
    const context = priorModulesContext([
      priorWith('Premise Only', 1, { premise: 'A premise without parts.' }),
      priorWith('Parts Only', 2, { partChars: 120 }),
    ]);
    expect(context).toContain('Premise Only');
    expect(context).toContain('A premise without parts.');
    expect(context).toContain('Parts Only');
  });

  it('truncates long part text with a visible marker', () => {
    const context = priorModulesContext([
      priorWith('Big', 1, { premise: 'P', partChars: PRIOR_PART_CHAR_CAP + 500 }),
    ]);
    expect(context).toContain('…[truncated]');
    expect(context).not.toContain('x'.repeat(PRIOR_PART_CHAR_CAP + 500));
  });

  it('caps one module’s whole block when many parts would overflow it', () => {
    const draft = priorWith('Huge', 1);
    const parts = [0, 1, 2].map((planIndex) =>
      modulePartSchema.parse({
        planIndex,
        markdown: 'y'.repeat(PRIOR_PART_CHAR_CAP),
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
    );
    const context = priorModulesContext([{ ...draft, parts }]);
    expect(context).toContain('…[truncated]');
    // The whole block (plus the section header) stays near the per-module cap.
    expect(context?.length).toBeLessThanOrEqual(PRIOR_MODULE_CHAR_CAP + 300);
  });

  it('drops the OLDEST modules first when the total cap overflows', () => {
    const priors = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'].map((title, index) =>
      priorWith(title, index + 1, { partChars: PRIOR_PART_CHAR_CAP }),
    );
    const context = priorModulesContext(priors);
    expect(context).not.toContain('M1');
    expect(context).toContain('M7');
  });

  it('orders kept modules oldest first regardless of input order', () => {
    const context = priorModulesContext([
      priorWith('Beta', 2, { premise: 'Beta premise.' }),
      priorWith('Alpha', 1, { premise: 'Alpha premise.' }),
    ]);
    if (context === null) throw new Error('context missing');
    expect(context.indexOf('Alpha')).toBeLessThan(context.indexOf('Beta'));
  });
});

describe('campaign cast context (auto-promote follow-up reuse)', () => {
  it('lists moduleId-null rows with kinds and skips module-owned rows', async () => {
    const campaignId = newId();
    const shared = await createArtifact({ campaignId, kind: 'npc', name: 'Shared Sage' });
    const owned = await createArtifact({ campaignId, moduleId: newId(), kind: 'location', name: 'Owned Cave' });

    const { listArtifactsByCampaign } = await import('@/db/artifactRepo');
    const cast = campaignCastContext(await listArtifactsByCampaign(campaignId));

    expect(cast).toContain('Shared Sage (npc)');
    expect(cast).not.toContain('Owned Cave');
    expect(shared).toBeDefined();
    expect(owned).toBeDefined();
  });

  it('returns null when nothing is shared yet', async () => {
    const campaignId = newId();
    await createArtifact({ campaignId, moduleId: newId(), kind: 'npc', name: 'Owned Only' });

    const { listArtifactsByCampaign } = await import('@/db/artifactRepo');
    expect(campaignCastContext(await listArtifactsByCampaign(campaignId))).toBeNull();
  });

  it('caps the roster at the 60-name convention', async () => {
    const campaignId = newId();
    for (let index = 0; index < CAMPAIGN_CAST_NAME_CAP + 10; index += 1) {
      await createArtifact({ campaignId, kind: 'npc', name: `Extra ${String(index).padStart(3, '0')}` });
    }

    const { listArtifactsByCampaign } = await import('@/db/artifactRepo');
    const cast = campaignCastContext(await listArtifactsByCampaign(campaignId));

    expect(cast).not.toBeNull();
    expect(cast?.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(CAMPAIGN_CAST_NAME_CAP);
  });

  it('rides the prior-modules section inside the total cap — even with no priors', () => {
    const cast = campaignCastContext([
      { name: 'Shared Sage', kind: 'npc', moduleId: null } as never,
    ]);
    const context = priorModulesContext([], cast);
    expect(context).toContain('Previous modules of this campaign');
    expect(context).toContain('Shared Sage (npc)');
    expect(context === null ? 0 : context.length).toBeLessThanOrEqual(PRIOR_MODULES_TOTAL_CAP + 400);
  });
});

describe('progress dock reporting', () => {
  beforeEach(() => {
    useProgressStore.getState().reset();
  });

  it('runSpine reports an indeterminate outline job and drains it on finish', async () => {    const { campaign, moduleId } = await seedModule();
    const deferred = deferredChat();
    chatMock.mockImplementationOnce(() => deferred.promise);
    // fix-01: the entity normalization call follows the parsed spine.
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(SELF_NORMALIZATION), modelUsed: 'test-model', fallback: null });

    const pending = guard(runSpine(moduleId, campaign));
    await waitFor(() => {
      expect(useProgressStore.getState().jobs).toHaveLength(1);
    });
    // No measurable sub-steps in the outline pass → indeterminate sweep.
    const job = useProgressStore.getState().jobs[0];
    expect(job?.label).toBe('Designing the module outline');
    expect(job?.detail).toContain('premise');
    expect(job?.progress).toBeNull();

    deferred.resolve(JSON.stringify(VALID_SPINE));
    await pending;
    expect(useProgressStore.getState().jobs).toEqual([]);
  }, 20000);

  it('runParts reports per-part progress and drains it on finish', async () => {
    const { campaign, moduleId } = await seedModule();
    await seedSpine(moduleId);
    const first = deferredChat();
    const second = deferredChat();
    chatMock
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockResolvedValueOnce(partMarkdown('PART-THREE'));

    const pending = guard(runParts(moduleId, campaign));
    await waitFor(() => {
      expect(useProgressStore.getState().jobs).toHaveLength(1);
    });
    expect(useProgressStore.getState().jobs[0]).toMatchObject({
      label: 'Writing 3 module parts',
      detail: 'Writing part 1 of 3: The Sunken Quarter',
      progress: 0,
    });

    first.resolve(partMarkdown('PART-ONE').text);
    await waitFor(() => {
      expect(useProgressStore.getState().jobs[0]).toMatchObject({
        detail: 'Writing part 2 of 3: The Drowned Cathedral',
        progress: 1 / 3,
      });
    });

    second.resolve(partMarkdown('PART-TWO').text);
    await pending;
    expect(useProgressStore.getState().jobs).toEqual([]);
  }, 20000);

  it('runSpine keeps the dock alive while the model only thinks (reasoning deltas)', async () => {
    const { campaign, moduleId } = await seedModule();
    // Reasoning deltas never reach onToken — the liveness probe is the only
    // signal while the model works; the dock detail must reflect it.
    const deferred = deferredChat();
    chatMock.mockImplementationOnce((_messages, options) => {
      options.onActivity?.({ elapsedMs: 5000, receivedChars: 0, phase: 'thinking' });
      return deferred.promise;
    });
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(SELF_NORMALIZATION), modelUsed: 'test-model', fallback: null });

    const pending = guard(runSpine(moduleId, campaign));
    await waitFor(() => {
      expect(useProgressStore.getState().jobs).toHaveLength(1);
    });
    await waitFor(() => {
      expect(useProgressStore.getState().jobs[0]?.detail).toContain('the model is thinking');
    });

    deferred.resolve(JSON.stringify(VALID_SPINE));
    await pending;
    expect(useProgressStore.getState().jobs).toEqual([]);
  }, 20000);

  it('runSpine forwards reasoning deltas to the reader as spine-thinking events', async () => {
    const { campaign, moduleId } = await seedModule();
    const seen: string[] = [];
    const unsubscribe = moduleGenEvents.on((event) => {
      if (event.kind === 'spine-thinking') seen.push(event.delta);
    });
    try {
      const deferred = deferredChat();
      chatMock.mockImplementationOnce((_messages, options) => {
        options.onReasoning?.('planning the premise');
        options.onReasoning?.(', sketching parts');
        return deferred.promise;
      });
      chatMock.mockResolvedValueOnce({ text: JSON.stringify(SELF_NORMALIZATION), modelUsed: 'test-model', fallback: null });

      const pending = guard(runSpine(moduleId, campaign));
      await vi.waitFor(() => {
        expect(seen.join('')).toBe('planning the premise, sketching parts');
      });
      deferred.resolve(JSON.stringify(VALID_SPINE));
      await pending;
    } finally {
      unsubscribe();
    }
  }, 20000);

  it('runSpine counts received chars on the dock while the answer streams', async () => {
    const { campaign, moduleId } = await seedModule();
    const deferred = deferredChat();
    chatMock.mockImplementationOnce((_messages, options) => {
      options.onToken?.('{"premise"');
      return deferred.promise;
    });
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(SELF_NORMALIZATION), modelUsed: 'test-model', fallback: null });

    const pending = guard(runSpine(moduleId, campaign));
    await waitFor(() => {
      expect(useProgressStore.getState().jobs[0]?.detail).toContain('10 chars received');
    });

    deferred.resolve(JSON.stringify(VALID_SPINE));
    await pending;
  }, 20000);
});

describe('createModuleAndRun (non-blocking creation)', () => {
  it('creates the row and starts pass 0 without waiting for the spine', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    // The spine call hangs until cancelled — createModuleAndRun must still
    // resolve so the dialog can navigate to the reader (the live surface).
    chatMock.mockImplementationOnce((_messages, options) => chatUntilAborted(options.signal));

    const moduleId = await createModuleAndRun(campaign, {
      campaignId: campaign.id,
      title: 'Started, Not Awaited',
      concept: 'A module whose spine runs in the background.',
      levelMin: 1,
      levelMax: 2,
      tone: '',
      sizeDial: 'sketch',
    });

    const created = await getModule(moduleId);
    expect(created?.title).toBe('Started, Not Awaited');
    await waitFor(async () => {
      expect((await getModule(moduleId))?.status).toBe('generating');
    });

    // Cleanup: abort the in-flight spine; the run rewinds the row to draft.
    cancelModuleGen(moduleId);
    await waitFor(async () => {
      expect((await getModule(moduleId))?.status).toBe('draft');
    });
    expect(chatMock).toHaveBeenCalledTimes(1);
  }, 20000);
});

/**
 * Durable versions (owner-directed simple undo, docs/18 §2.3, docs/17 ledger
 * row 63): EVERY AI pass that can rewrite part text snapshots the whole
 * module document BEFORE it writes — the parts pass at entry (generation,
 * missing-part fill, single-part rewrite/regenerate, the board's staged
 * rewrite, floor repairs) and each entity-name-normalization pass (they are
 * separate AI passes over the text). Byte-exact pre-change text, honest
 * labels; the canvas/chat paths are pinned in canvas-versions.test.tsx.
 */
describe('durable versions — the parts passes snapshot before they write', () => {
  /** The module row's whole document right now (the pre-change expectation). */
  async function rowDocument(moduleId: Id): Promise<string> {
    const row = await getModule(moduleId);
    if (row === undefined) throw new Error('module row missing');
    return assembleModulePartsDocument({
      partPlan: row.spine?.partPlan ?? [],
      parts: row.parts,
    }).document;
  }

  it('a full parts pass snapshots the pre-pass document ONCE, at entry, labelled for the pass', async () => {
    const { campaign, moduleId } = await seedModule();
    await seedSpine(moduleId);
    // A part already on the row (hand-authored here) — the pass overwrites it.
    await seedReadyPart(moduleId, 0, partMarkdown('BEFORE-THE-PASS'));
    const before = await rowDocument(moduleId);
    expect(await listModuleVersions(moduleId)).toHaveLength(0);

    chatMock
      .mockResolvedValueOnce(partWithNames('PART-ONE', ['Ember Trial']))
      .mockResolvedValueOnce(partWithNames('PART-TWO', ['Flood Trial']))
      .mockResolvedValueOnce(partWithNames('PART-THREE', ['Bell Trial']))
      .mockResolvedValueOnce(encounterReply('Ember Trial', 'Flood Trial', 'Bell Trial'));

    const finished = await runParts(moduleId, campaign);
    expect(finished.status).toBe('ready');

    const versions = await listModuleVersions(moduleId);
    const pass = versions.filter((entry) => entry.source === 'generation');
    // ONE snapshot for the pass (not one per part, not one after the write).
    expect(pass).toHaveLength(1);
    expect(pass[0]?.label).toBe('Generate parts');
    // BYTE-EXACT pre-change text: the document as it stood before the first
    // part write (the seeded part still carries its own prose there).
    expect(pass[0]?.docText).toBe(before);
    expect(pass[0]?.docText).toContain('BEFORE-THE-PASS');
    // The pass really changed the text (so this is a pre-change state, not a
    // copy of the post-pass document).
    expect(await rowDocument(moduleId)).not.toBe(before);
    // The in-pass normalization is its own AI pass → its own snapshot.
    expect(versions.some((entry) => entry.source === 'normalization')).toBe(true);
  }, 20000);

  it('a per-part rewrite names the part and the instruction, and captures the pre-rewrite document', async () => {
    const { campaign, moduleId } = await seedModule();
    await seedSpine(moduleId);
    await seedReadyPart(moduleId, 1, partMarkdown('OLD-TWO'));
    const before = await rowDocument(moduleId);

    chatMock
      .mockResolvedValueOnce(partWithNames('NEW-TWO', ['Flood Trial']))
      .mockResolvedValueOnce(encounterReply('Flood Trial'));

    await rewritePart(moduleId, campaign, 1, 'make the flood louder');

    const versions = await listModuleVersions(moduleId);
    const pass = versions.find((entry) => entry.source === 'generation');
    expect(pass?.label).toBe('Rewrite part 2 — The Drowned Cathedral: make the flood louder');
    expect(pass?.docText).toBe(before);
    expect(pass?.docText).toContain('OLD-TWO');
    expect((await getModule(moduleId))?.parts.find((part) => part.planIndex === 1)?.markdown).toContain(
      'NEW-TWO',
    );
  }, 20000);

  it('a standalone normalization pass snapshots before it rewrites part text', async () => {
    const { campaign, moduleId } = await seedModule();
    await seedSpine(moduleId);
    await seedReadyPart(moduleId, 0, partWithNames('PART-ONE', ['Guard Halmund']));
    await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Halmund',
      summary: 'The guard of the drowned bell.',
    });
    const before = await rowDocument(moduleId);
    chatMock.mockResolvedValueOnce({
      text: JSON.stringify({
        entities: [{ name: 'Guard Halmund', canonical: 'Halmund', kind: 'npc' }],
      }),
      modelUsed: 'test-model',
      fallback: null,
    });

    await normalizeModuleEntityNames(moduleId);

    const versions = await listModuleVersions(moduleId);
    expect(versions).toHaveLength(1);
    const [snapshot] = versions;
    expect(snapshot?.source).toBe('normalization');
    expect(snapshot?.label).toBe('Normalize entity names');
    // The pre-rewrite text: the variant link, NOT the rewritten canonical one.
    expect(snapshot?.docText).toBe(before);
    expect(snapshot?.docText).toContain('[[Guard Halmund]]');
    const after = (await getModule(moduleId))?.parts.find((part) => part.planIndex === 0)?.markdown ?? '';
    expect(after).toContain('[[Halmund|Guard Halmund]]');
    expect(after).not.toBe(snapshot?.docText);
  }, 20000);
});
