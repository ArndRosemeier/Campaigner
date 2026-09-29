import 'fake-indexeddb/auto';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
import { canvasPath } from '@/app/routes';
import { createCampaign } from '@/db/campaignRepo';
import { saveModule } from '@/db/moduleRepo';
import { createModule, moduleSpineSchema, modulePartSchema, type Id } from '@/domain';
import { flushChatPersist } from '@/features/modules/canvas/chatPersist';
import { useCanvasChatStore } from '@/features/modules/canvas/chatStore';
import { clearDatabase } from '../db/helpers';
import { actDrained, flushAsyncUpdates } from '../helpers/flush';

/**
 * THE ONE CONSOLIDATED ASK (docs/17 row 401): the chat shows ONE problem card and
 * ONE explicit button; the click sends ONE user turn listing ALL problems;
 * nothing is sent before the click; a second click re-sends the same single
 * message (no per-item messages, no duplication).
 */

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn(), toastInfo: vi.fn() }));
vi.mock('@/llm/openrouter', async (importOriginal) => ({ ...(await importOriginal<object>()), chat: vi.fn() }));
vi.mock('@/db/artifactAutoPromote', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  promoteSecondModuleUses: vi.fn(),
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);

let world: { campaignId: Id; moduleId: Id } = { campaignId: '', moduleId: '' };

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
  useCanvasChatStore.setState({ ownerModuleId: null, byModule: {} });
  await flushChatPersist();
  const campaign = await createCampaign({ name: 'Ember', description: '', system: 'dnd5e' });
  const draft = createModule({ campaignId: campaign.id, title: 'Vault', concept: '', levelMin: 1, levelMax: 3, tone: '', sizeDial: 'standard', includePriorModules: false });
  const parts = [
    'Meet [[Ilse]] and [[Marten]]. [[Bridge Ambush]] happens.',
    'Nothing.',
    'Nothing.',
  ];
  await saveModule({
    ...draft,
    createdAt: 2,
    entityKinds: [
      { name: 'Ilse', kind: 'npc', absorbed: [] },
      { name: 'Marten', kind: 'npc', absorbed: [] },
      { name: 'Bridge Ambush', kind: 'encounter', absorbed: [] },
    ],
    spine: moduleSpineSchema.parse({
      premise: 'A premise.',
      themes: [],
      partPlan: parts.map((_, i) => ({ title: `L${String(i + 1)}`, levelBand: String(i + 1), synopsis: '', levelUpTrigger: '' })),
    }),
    parts: parts.map((markdown, planIndex) =>
      modulePartSchema.parse({ planIndex, markdown, status: 'ready', errorMessage: '', edited: false }),
    ),
  });
  world = { campaignId: campaign.id, moduleId: draft.id };
});

describe('the consolidated level ask', () => {
  it('shows ONE card; nothing is sent before the click; ONE click sends ONE turn with ALL five items; a second click re-sends the same single message', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', canvasPath(world.campaignId, world.moduleId));
    render(<RouterProvider router={createAppRouter()} />);
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    if (screen.queryByTestId('canvas-chat') === null) await user.click(await screen.findByTestId('canvas-chat-toggle'));
    const card = await screen.findByTestId('canvas-level-problems');
    // 3 missing levels (Ilse, Marten, Bridge Ambush) + 2 short levels (2 and 3).
    expect(card.querySelectorAll('li')).toHaveLength(5);
    expect(screen.getAllByTestId('canvas-level-problems')).toHaveLength(1);
    expect(chatMock).not.toHaveBeenCalled();
    chatMock.mockImplementation(() =>
      Promise.resolve({ text: 'Understood.', modelUsed: 'test-model', fallback: null }),
    );
    await user.click(screen.getByTestId('canvas-level-problems-ask'));
    await flushAsyncUpdates();
    await actDrained(async () => {
      await flushChatPersist();
    });
    expect(chatMock).toHaveBeenCalledTimes(1);
    const first = JSON.stringify(chatMock.mock.calls[0]?.[0]);
    for (const needle of ['Ilse', 'Marten', 'Bridge Ambush', 'Level 2 names 0', 'Level 3 names 0']) {
      expect(first, needle).toContain(needle);
    }
    // Nothing changed, so the card is still there; a second click sends the
    // SAME single message once more.
    await user.click(await screen.findByTestId('canvas-level-problems-ask'));
    await flushAsyncUpdates();
    await actDrained(async () => {
      await flushChatPersist();
    });
    expect(chatMock).toHaveBeenCalledTimes(2);
    const userTurn = (i: number): string => {
      const messages = chatMock.mock.calls[i]?.[0] as { role: string; content: unknown }[];
      const last = messages.filter((m) => m.role === 'user').at(-1);
      return JSON.stringify(last?.content);
    };
    expect(userTurn(1)).toContain(userTurn(0).slice(0, 200));
    const asks = (userTurn(1).match(/has no level/g) ?? []).length;
    expect(asks).toBe(3);
  }, 60_000);
});
