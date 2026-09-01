import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

import { createCampaign } from '@/db/campaignRepo';
import { getModule, patchModule, saveModule } from '@/db/moduleRepo';
import { updateSettings } from '@/db/settingsRepo';
import { createModule, moduleSpineSchema, type Campaign, type Id } from '@/domain';
import {
  cancelModuleGen,
  generateMissingParts,
  ModuleBusyError,
  normalizePartMarkdown,
  parseSpine,
  rewritePart,
  runParts,
  runSpine,
} from '@/llm/moduleGen';
import { clearDatabase } from '../db/helpers';

/**
 * Module Designer generator (08-MODULE-DESIGNER M4-B) with a mocked chat:
 * spine success/invalid-JSON failure, sequential parts with continuity,
 * failed-part continuation, short-output retry, generateMissingParts,
 * rewritePart, cancel rewinds, and the ModuleBusyError guard.
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
};

/** Module prose well above the 100-char floor, with a findable marker. */
function partMarkdown(marker: string): string {
  return `${marker}: The tide withdraws and the streets shine wet under a pale sun. `.repeat(4);
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
  markdown: string,
  options: { edited?: boolean } = {},
): Promise<void> {
  const current = await getModule(moduleId);
  if (current === undefined) throw new Error('seed module is missing');
  const parts = current.parts.filter((part) => part.planIndex !== planIndex);
  parts.push({
    planIndex,
    markdown,
    status: 'ready',
    errorMessage: '',
    edited: options.edited === true,
  });
  parts.sort((a, b) => a.planIndex - b.planIndex);
  await patchModule(moduleId, { parts });
}

/** The user message of the n-th chat call ('' when the call is missing). */
function userPromptOf(callIndex: number): string {
  const messages = chatMock.mock.calls[callIndex]?.[0];
  return messages?.find((message) => message.role === 'user')?.content ?? '';
}

/** All user-message content of the n-th chat call, joined — retry nudges are
 * appended as a second user message after the original instruction. */
function userMessagesOf(callIndex: number): string {
  const messages = chatMock.mock.calls[callIndex]?.[0] ?? [];
  return messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content)
    .join('\n\n');
}

/** Resolves only via the returned resolve — for observing in-flight states. */
function deferredChat(): { promise: Promise<string>; resolve: (value: string) => void } {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * A chat call that never settles on its own and rejects with AbortError when
 * the moduleGen abort signal fires (mirrors the real client's abort path).
 */
function chatUntilAborted(signal: AbortSignal | undefined): Promise<string> {
  return new Promise<string>((_resolve, reject) => {
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
    expect(spine).toEqual(VALID_SPINE);
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

    const pending = guard(runSpine(moduleId, campaign));
    await waitFor(async () => {
      expect((await getModule(moduleId))?.status).toBe('generating');
    });

    deferred.resolve(JSON.stringify(VALID_SPINE));
    const finished = await pending;

    expect(finished.status).toBe('draft');
    expect(finished.errorMessage).toBe('');
    expect(finished.spine).toEqual(VALID_SPINE);
    expect(finished.spine?.partPlan).toHaveLength(3);

    expect(chatMock).toHaveBeenCalledTimes(1);
    const firstCall = chatMock.mock.calls[0];
    if (firstCall === undefined) throw new Error('chat was not called');
    const [messages, options] = firstCall;
    // The call used the seeded settings.defaultChatModel and JSON mode.
    expect(options.model).toBe(TEST_MODEL);
    expect(options.responseFormat).toBe('json');
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('Module Architect');
    const userContent = messages.find((message) => message.role === 'user')?.content ?? '';
    expect(userContent).toContain('Module concept: A harbor bell that rings by itself beneath the water.');
    expect(userContent).toContain('Party levels 1–3');
  }, 20000);

  it('retries invalid JSON once, then fails the module loudly (row + toast)', async () => {
    const { campaign, moduleId } = await seedModule();
    chatMock.mockResolvedValue('not json at all');

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

describe('runParts', () => {
  it('generates parts sequentially, feeding part i the current text of part i−1', async () => {
    const { campaign, moduleId } = await seedModule();
    await seedSpine(moduleId);
    chatMock
      .mockResolvedValueOnce(partMarkdown('PART-ONE'))
      .mockResolvedValueOnce(partMarkdown('PART-TWO'))
      .mockResolvedValueOnce(partMarkdown('PART-THREE'));

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

    expect(chatMock).toHaveBeenCalledTimes(3);
    // Calls happen in plan order, one per part.
    expect(userPromptOf(0)).toContain('Write part 1: "The Sunken Quarter"');
    expect(userPromptOf(1)).toContain('Write part 2: "The Drowned Cathedral"');
    expect(userPromptOf(2)).toContain('Write part 3: "The Bell Tower"');
    // Part 0 has no predecessor; the word target comes from the size dial.
    expect(userPromptOf(0)).not.toContain('Full markdown of the previous part');
    expect(userPromptOf(0)).toContain('800–1500 words');
    // Continuity = the FINAL markdown of the previous part.
    expect(userPromptOf(1)).toContain('Full markdown of the previous part');
    expect(userPromptOf(1)).toContain('PART-ONE');
    expect(userPromptOf(2)).toContain('PART-TWO');
  }, 20000);

  it('continues past a failed part and still lands the module on ready', async () => {
    const { campaign, moduleId } = await seedModule();
    await seedSpine(moduleId);
    chatMock
      .mockResolvedValueOnce(partMarkdown('PART-ONE'))
      .mockRejectedValueOnce(new Error('provider exploded mid-part'))
      .mockResolvedValueOnce(partMarkdown('PART-THREE'));

    const finished = await runParts(moduleId, campaign);

    expect(finished.status).toBe('ready');
    const [one, two, three] = finished.parts;
    expect(one?.status).toBe('ready');
    expect(one?.markdown).toContain('PART-ONE');
    expect(two?.status).toBe('failed');
    expect(two?.errorMessage).toBe('provider exploded mid-part');
    expect(two?.markdown).toBe('');
    expect(three?.status).toBe('ready');
    expect(three?.markdown).toContain('PART-THREE');
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
      .mockResolvedValueOnce('The bell rings at midnight.') // 27 chars: too short
      .mockResolvedValueOnce(partMarkdown('PART-ONE-RETRY'));

    const finished = await runParts(moduleId, campaign, { planIndexes: [0] });

    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(userMessagesOf(1)).toContain('Your previous reply was too short');
    const part = finished.parts.find((entry) => entry.planIndex === 0);
    expect(part?.status).toBe('ready');
    expect(part?.markdown).toContain('PART-ONE-RETRY');
    expect(finished.status).toBe('ready');
  }, 20000);

  it('fails the part when the retry is also too short, without sinking the module', async () => {
    const { campaign, moduleId } = await seedModule();
    await seedSpine(moduleId);
    chatMock.mockResolvedValue('The bell rings at midnight.');

    const finished = await runParts(moduleId, campaign, { planIndexes: [0] });

    expect(chatMock).toHaveBeenCalledTimes(2);
    const part = finished.parts.find((entry) => entry.planIndex === 0);
    expect(part?.status).toBe('failed');
    expect(part?.errorMessage).toContain('too short');
    expect(part?.markdown).toBe('');
    expect(finished.status).toBe('ready');
    expect(toastErrorMock).not.toHaveBeenCalled();
  }, 20000);
});

describe('generateMissingParts', () => {
  it('only generates the parts that are not ready yet', async () => {
    const { campaign, moduleId } = await seedModule();
    await seedSpine(moduleId);
    await seedReadyPart(moduleId, 0, partMarkdown('PART-ONE-ORIGINAL'));
    chatMock
      .mockResolvedValueOnce(partMarkdown('PART-TWO'))
      .mockResolvedValueOnce(partMarkdown('PART-THREE'));

    await generateMissingParts(moduleId, campaign);

    // Part 0 was ready and is never re-called.
    expect(chatMock).toHaveBeenCalledTimes(2);
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
    await seedReadyPart(moduleId, 0, partMarkdown('PART-ONE-ORIGINAL'));
    await seedReadyPart(moduleId, 1, partMarkdown('PART-TWO-OLD'), { edited: true });
    chatMock.mockResolvedValueOnce(partMarkdown('PART-TWO-NEW'));

    await rewritePart(moduleId, campaign, 1, 'Foreshadow the bell tower more heavily.');

    expect(chatMock).toHaveBeenCalledTimes(1);
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

describe('ModuleBusyError', () => {
  it('rejects a second spine run on the same module while one is in flight', async () => {
    const { campaign, moduleId } = await seedModule();
    const deferred = deferredChat();
    chatMock.mockImplementationOnce(() => deferred.promise);
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
