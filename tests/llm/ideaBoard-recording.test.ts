import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getSettings, updateSettings } from '@/db/settingsRepo';
import { newIdeaBoard, type IdeaBoard } from '@/domain';
import { refineIdeaBoard } from '@/llm/ideaBoard';
import { chat } from '@/llm/openrouter';
import { clearDatabase } from '../db/helpers';

/**
 * The Idea Board's recents rule (docs/17 row 198): the board is one of the
 * global-model call paths that is NOT the run engine's funnel, and its own
 * `board.model` is a DIFFERENT tier. So the global model is recorded ONLY when
 * the board has no model of its own — otherwise a per-board pick would enter
 * the top bar's "Recently used" (global chat) list, which would lie about what
 * that list means. Real Dexie and the real recording seam; the transport is the
 * only thing mocked.
 */

vi.mock('@/llm/openrouter', () => ({ chat: vi.fn() }));

const chatMock = vi.mocked(chat);

function board(overrides: Partial<IdeaBoard> = {}): IdeaBoard {
  return { ...newIdeaBoard(), document: 'Original text.', ...overrides };
}

function reply(): void {
  chatMock.mockResolvedValue({
    text: JSON.stringify({ reply: 'Tightened.', document: 'Tighter text.' }),
    modelUsed: 'served/model',
    fallback: null,
  });
}

beforeEach(async () => {
  await clearDatabase();
  chatMock.mockReset();
});

describe('the Idea Board records the GLOBAL chat model only when it answers with it (docs/17 row 198)', () => {
  it('records the global model at the front when board.model is empty', async () => {
    await updateSettings({ defaultChatModel: 'global/board', recentChatModels: ['older/model'] });
    reply();

    await refineIdeaBoard(board(), 'tighten this', new AbortController().signal);

    expect((await getSettings()).recentChatModels).toEqual(['global/board', 'older/model']);
  });

  it('leaves the recents untouched when the per-board model answers', async () => {
    await updateSettings({ defaultChatModel: 'global/board', recentChatModels: ['older/model'] });
    reply();

    await refineIdeaBoard(
      board({ model: 'board/own-model' }),
      'tighten this',
      new AbortController().signal,
    );

    expect(chatMock.mock.calls[0]?.[1]?.model).toBe('board/own-model');
    expect((await getSettings()).recentChatModels).toEqual(['older/model']);
  });
});
