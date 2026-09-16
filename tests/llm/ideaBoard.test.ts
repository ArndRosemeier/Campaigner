import { beforeEach, expect, it, vi } from 'vitest';

import type * as SettingsRepo from '@/db/settingsRepo';

vi.mock('@/llm/openrouter', () => ({ chat: vi.fn() }));
vi.mock('@/db/settingsRepo', async (importOriginal) => ({
  ...(await importOriginal<typeof SettingsRepo>()),
  getSettings: vi.fn(),
  // The recents recording these tests are not about is a resolved no-op here;
  // docs/17 row 198 pins the real-DB behaviour in ideaBoard-recording.test.ts.
  recordRecentChatModel: vi.fn(() => Promise.resolve()),
}));

import { getSettings } from '@/db/settingsRepo';
import { defaultSettings, newIdeaBoard, type IdeaBoard } from '@/domain';
import { refineIdeaBoard } from '@/llm/ideaBoard';
import { chat } from '@/llm/openrouter';

/**
 * The Idea Board refinement CONTRACT (`docs/21-IDEA-BOARD.md`): the plain-text
 * boundary around the shared transport. These pins hold the three things that
 * make model output safe to offer as a document — the request is grounded on
 * the owner's own text under a strict JSON contract, an unusable reply is
 * refused BY NAME, and the hygiene scan runs before anything can be accepted.
 */

function board(overrides: Partial<IdeaBoard> = {}): IdeaBoard {
  return { ...newIdeaBoard(), document: 'Original text.', ...overrides };
}

/** Resolves one chat() call as the transport would. */
function replyWith(payload: { reply: string; document: string | null }, modelUsed = 'served/model'): void {
  vi.mocked(chat).mockResolvedValue({
    text: JSON.stringify(payload),
    modelUsed,
    fallback: null,
  });
}

function firstCallOptions(): { model: string; responseFormat: unknown } {
  const call = vi.mocked(chat).mock.calls[0];
  if (call === undefined) throw new Error('the transport was never called');
  const options = call[1];
  if (options.responseFormat === undefined) throw new Error('no responseFormat was sent');
  return { model: options.model, responseFormat: options.responseFormat };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSettings).mockResolvedValue(defaultSettings());
});

it('grounds the request on the owner text under a strict JSON contract', async () => {
  replyWith({ reply: 'Tightened.', document: 'Tighter text.' });
  const result = await refineIdeaBoard(
    board({ messages: [{ id: 'm1', createdAt: 1, role: 'user', text: 'earlier', modelUsed: null }] }),
    '  tighten this  ',
    new AbortController().signal,
  );
  expect(result).toEqual({ reply: 'Tightened.', document: 'Tighter text.', modelUsed: 'served/model' });

  const { model, responseFormat } = firstCallOptions();
  // An unset board model falls back to the Settings default, never to a
  // hardcoded id (a genuine preference default).
  expect(model).toBe(defaultSettings().defaultChatModel);
  // The board's reply schema is EXPRESSIBLE in the strict subset — a schema
  // that could not be is a loud StrictSchemaError, which would leave the
  // transport uncalled and red the assertion above.
  expect(responseFormat).toMatchObject({ kind: 'schema', name: 'idea-board' });
  const schema = (responseFormat as { jsonSchema: Record<string, unknown> }).jsonSchema;
  expect(Object.keys(schema.properties as Record<string, unknown>)).toEqual(['reply', 'document']);

  const messages = vi.mocked(chat).mock.calls[0]?.[0] ?? [];
  const payload = messages.at(-1)?.content;
  if (typeof payload !== 'string') throw new Error('the final user turn is not a string payload');
  expect(JSON.parse(payload)).toEqual({ document: 'Original text.', instruction: 'tighten this' });
  // The transcript rides as history, without the current instruction twice.
  expect(messages.map((message) => message.role)).toEqual(['system', 'user', 'user']);
});

it('honours the board model over the Settings default when one is set', async () => {
  replyWith({ reply: 'ok', document: null }, 'board/model');
  const result = await refineIdeaBoard(
    board({ model: 'board/model' }),
    'what do you think?',
    new AbortController().signal,
  );
  // A discussion turn proposes NOTHING: no document, so nothing to accept.
  expect(result.document).toBeNull();
  expect(firstCallOptions().model).toBe('board/model');
});

it('refuses an empty instruction before the transport is called', async () => {
  await expect(
    refineIdeaBoard(board(), '   ', new AbortController().signal),
  ).rejects.toThrow('Enter a message first');
  expect(chat).not.toHaveBeenCalled();
});

it('refuses a whitespace-only replacement instead of blanking the board', async () => {
  replyWith({ reply: 'Here you go.', document: '   ' });
  await expect(
    refineIdeaBoard(board(), 'rewrite it', new AbortController().signal),
  ).rejects.toThrow('empty document');
});

it('refuses model text carrying escape debris, naming the reason', async () => {
  // The observed `?xx` debris shape (Flussm?fcndung) — half-formed unicode
  // escapes, the class the shared hygiene scan exists to stop from being
  // persisted as reader-visible content (docs/17 row 142).
  replyWith({ reply: 'Rewritten.', document: 'Die Flussm?fcndung bei Halmund' });
  await expect(
    refineIdeaBoard(board(), 'rewrite it', new AbortController().signal),
  ).rejects.toThrow('refused');
});

it('refuses a reply that is not the contracted JSON shape', async () => {
  vi.mocked(chat).mockResolvedValue({
    text: 'Sure! Here is your text.',
    modelUsed: 'served/model',
    fallback: null,
  });
  await expect(
    refineIdeaBoard(board(), 'rewrite it', new AbortController().signal),
  ).rejects.toThrow();
});
