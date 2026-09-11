import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import {
  assembleModulePartsDocument,
  createModule,
  encounterDataSchema,
  modulePartSchema,
  moduleSpineSchema,
  type Id,
} from '@/domain';
import { createCampaign } from '@/db/campaignRepo';
import { getModule, saveModule } from '@/db/moduleRepo';
import { createArtifact } from '@/db/artifactRepo';
import { canvasChatKey, useCanvasChatStore } from '@/features/modules/canvas/chatStore';
import { runSnapshotChatTurn } from '@/features/modules/canvas/snapshotChat';
import { runChatTurn } from '@/features/modules/canvas/chatController';
import { clearDatabase } from '../db/helpers';

/**
 * The canvas chat's REQUEST round trip at the CONTROLLER level (docs/17
 * ledger row 103): a reply that asked for stored details gets exactly one
 * follow-up call, and that follow-up lands as its OWN assistant message with
 * its OWN applied batch — in the preview flow (string splices) AND in the
 * editor flow (CM6 transactions). A request in the follow-up reply is not
 * served and is named LOUDLY (toastError), never silently dropped.
 */

vi.mock('@/llm/openrouter', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chat: vi.fn(),
}));

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastErrorPersistent: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
  toastAction: vi.fn(),
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { toastError } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);

const PART_0 = '## The Gate Bargain\n\nThe party bargains at the gate.\n\nRain hammers the stones.';
const PART_1 = 'The docks breathe fog. Rain hammers the stones.';
const PART_PLAN = [
  { title: 'The Gate Bargain', levelBand: '1' },
  { title: 'Under the Docks', levelBand: '1' },
];
const PARTS_DOCUMENT = assembleModulePartsDocument({
  partPlan: PART_PLAN,
  parts: [
    { planIndex: 0, markdown: PART_0 },
    { planIndex: 1, markdown: PART_1 },
  ],
}).document;

const STORED_ONLY_TREASURE = 'a silver locket with an engraved tide-mark';

let world: { campaignId: Id; moduleId: Id } = { campaignId: '', moduleId: '' };

async function seed(): Promise<void> {
  const campaign = await createCampaign({ name: 'Ember', description: 'The ember war.', system: 'dnd5e' });
  const draft = createModule({
    campaignId: campaign.id,
    title: 'The Drowned Vault',
    concept: 'concept',
    levelMin: 1,
    levelMax: 2,
    tone: '',
    sizeDial: 'standard',
  });
  await saveModule({
    ...draft,
    createdAt: 2,
    spine: moduleSpineSchema.parse({ premise: 'The premise.', themes: [], partPlan: PART_PLAN }),
    parts: [
      modulePartSchema.parse({ planIndex: 0, markdown: PART_0, status: 'ready', errorMessage: '', edited: false }),
      modulePartSchema.parse({ planIndex: 1, markdown: PART_1, status: 'ready', errorMessage: '', edited: false }),
    ],
  });
  await createArtifact({
    campaignId: campaign.id,
    moduleId: draft.id,
    kind: 'encounter',
    name: 'Salt Gate Ambush',
    data: encounterDataSchema.parse({
      difficulty: 'hard',
      levelHint: '3',
      terrain: 'Flooded flagstones.',
      tactics: 'They fight from the ledges.',
      treasure: 'The tide-hoard.',
      monsters: [
        { name: 'Goblin Warrior', count: 4, notes: 'Two per ledge.', treasure: STORED_ONLY_TREASURE, source: { type: 'none' } },
      ],
    }),
  });
  world = { campaignId: campaign.id, moduleId: draft.id };
}

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
  useCanvasChatStore.setState({ ownerModuleId: null, byModule: {} });
  await seed();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function messagesFor(key: string): ReturnType<typeof useCanvasChatStore.getState>['byModule'][string]['messages'] {
  return useCanvasChatStore.getState().module(key).messages;
}

describe('runSnapshotChatTurn — the preview round trip', () => {
  function options(overrides: Partial<Parameters<typeof runSnapshotChatTurn>[0]> = {}) {
    return {
      moduleId: world.moduleId,
      key: canvasChatKey(world.moduleId),
      hasPlannedParts: true,
      doc: PARTS_DOCUMENT,
      modelSelection: null,
      turn: new AbortController(),
      ...overrides,
    };
  }

  it('lands the follow-up as its OWN message and applies BOTH batches in reply order', async () => {
    chatMock
      .mockResolvedValueOnce({
        text: 'Let me check the encounter row.\n<request><name>Salt Gate Ambush</name></request>\n<edit><search>The party bargains at the gate.</search><replace>The party bargains at the flooded gate.</replace></edit>',
        modelUsed: 'first-model',
        fallback: null,
      })
      .mockResolvedValueOnce({
        text: 'Now the roster detail.\n<edit><search>fog</search><replace>mist</replace></edit>',
        modelUsed: 'second-model',
        fallback: null,
      });
    const result = await runSnapshotChatTurn(options(), 'tighten the gate fight');
    expect(chatMock).toHaveBeenCalledTimes(2);
    // The second call carried the STORED row, not a summary of it.
    const secondCall = (chatMock.mock.calls[1]?.[0] ?? [])
      .map((message) => (typeof message.content === 'string' ? message.content : ''))
      .join('\n');
    expect(secondCall).toContain(STORED_ONLY_TREASURE);
    // Both batches landed, in reply order.
    expect(result.docChanged).toBe(true);
    expect(result.doc).toContain('The party bargains at the flooded gate.');
    expect(result.doc).toContain('mist');
    expect(result.doc).not.toContain('The party bargains at the gate.\n');
    // The row carries both (the ONE split-save path).
    const row = await getModule(world.moduleId);
    expect(row?.parts.find((part) => part.planIndex === 0)?.markdown).toContain('The party bargains at the flooded gate.');
    expect(row?.parts.find((part) => part.planIndex === 1)?.markdown).toContain('mist');
    // TWO assistant messages: the reply that asked and the reply after the answer.
    const messages = messagesFor(options().key);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(messages[1]?.raw).toContain('<request><name>Salt Gate Ambush</name></request>');
    expect(messages[1]?.status).toBe('ok');
    expect(messages[1]?.outcomes).toHaveLength(1);
    expect(messages[2]?.raw).toBe('Now the roster detail.\n<edit><search>fog</search><replace>mist</replace></edit>');
    expect(messages[2]?.status).toBe('ok');
    expect(messages[2]?.outcomes).toHaveLength(1);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('names a SECOND request in the follow-up reply LOUDLY (never a third call)', async () => {
    chatMock
      .mockResolvedValueOnce({ text: '<request><name>Salt Gate Ambush</name></request>', modelUsed: 'm', fallback: null })
      .mockResolvedValueOnce({
        text: 'I need another row.\n<request><name>Keeper Ilse</name></request>',
        modelUsed: 'm',
        fallback: null,
      });
    await runSnapshotChatTurn(options(), 'tighten the gate fight');
    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    const [copy] = toastErrorMock.mock.calls[0] ?? [];
    expect(copy).toContain('one details round trip is served per message');
    expect(copy).toContain('«Keeper Ilse»');
    expect(messagesFor(options().key)).toHaveLength(3);
  });

  it('a failed follow-up is a LOUD card and never touches the first reply\'s work', async () => {
    chatMock
      .mockResolvedValueOnce({
        text: 'Checking.\n<request><name>Salt Gate Ambush</name></request>\n<edit><search>fog</search><replace>mist</replace></edit>',
        modelUsed: 'm',
        fallback: null,
      })
      .mockRejectedValueOnce(new Error('upstream 503'));
    const result = await runSnapshotChatTurn(options(), 'tighten the gate fight');
    expect(result.doc).toContain('mist');
    const messages = messagesFor(options().key);
    expect(messages[1]?.status).toBe('ok');
    expect(messages[2]?.status).toBe('failed');
    expect(messages[2]?.error).toContain('upstream 503');
    expect(messages[2]?.error).toContain('follow-up reply');
  });

  it('a stop during the follow-up settles BOTH bubbles as aborted', async () => {
    const turn = new AbortController();
    chatMock.mockImplementationOnce(() =>
      Promise.resolve({ text: '<request><name>Salt Gate Ambush</name></request>', modelUsed: 'm', fallback: null }),
    );
    chatMock.mockImplementationOnce((_messages, config) => {
      config.onToken?.('Looking at the row');
      turn.abort();
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    });
    const result = await runSnapshotChatTurn(options({ turn }), 'tighten the gate fight');
    expect(result.docChanged).toBe(false);
    const messages = messagesFor(options().key);
    expect(messages[1]?.status).toBe('aborted');
    expect(messages[2]?.status).toBe('aborted');
    expect(messages[2]?.text).toBe('Looking at the row');
  });

  it('a reply with NO request produces ONE assistant message and ONE call', async () => {
    chatMock.mockResolvedValue({ text: 'No change needed.', modelUsed: 'm', fallback: null });
    await runSnapshotChatTurn(options(), 'look at the gate scene');
    expect(chatMock).toHaveBeenCalledTimes(1);
    const messages = messagesFor(options().key);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages[1]?.raw).toBe('No change needed.');
  });
});

describe('runChatTurn — the editor round trip', () => {
  function editorOptions() {
    const view = new EditorView({ state: EditorState.create({ doc: PARTS_DOCUMENT }) });
    return {
      moduleId: world.moduleId,
      key: canvasChatKey(world.moduleId),
      hasPlannedParts: true,
      view,
      modelSelection: null,
      turn: new AbortController(),
    };
  }

  it('applies the follow-up batch as a CM6 transaction over the same live doc', async () => {
    const options = editorOptions();
    chatMock
      .mockResolvedValueOnce({
        text: 'Let me check.\n<request><name>Salt Gate Ambush</name></request>',
        modelUsed: 'first-model',
        fallback: null,
      })
      .mockResolvedValueOnce({
        text: 'Done.\n<edit><search>fog</search><replace>mist</replace></edit>',
        modelUsed: 'second-model',
        fallback: null,
      });
    const result = await runChatTurn(options, 'tighten the gate fight');
    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(options.view.state.doc.toString()).toContain('mist');
    expect(result.doc).toContain('mist');
    expect(result.lastApplied).not.toBeNull();
    const messages = messagesFor(options.key);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(messages[2]?.outcomes[0]?.kind).toBe('applied');
    // The row persists through the split-save.
    const row = await getModule(world.moduleId);
    expect(row?.parts.find((part) => part.planIndex === 1)?.markdown).toContain('mist');
    options.view.destroy();
  });

  it("keeps the second reply's provenance separate from the first call's model", async () => {
    chatMock
      .mockResolvedValueOnce({
        text: 'Checking.\n<request><name>Salt Gate Ambush</name></request>',
        modelUsed: 'first-model',
        fallback: null,
      })
      .mockResolvedValueOnce({
        text: 'Edit.\n<edit><search>fog</search><replace>brine</replace></edit>',
        modelUsed: 'second-model',
        fallback: null,
      });
    const options = editorOptions();
    await runChatTurn(options, 'tighten the gate fight');
    // The applied part text records the SECOND call's model (the reply that
    // wrote it) — one provenance id per call, never the first call's id.
    const row = await getModule(world.moduleId);
    expect(row?.parts.find((part) => part.planIndex === 1)?.markdown).toContain('brine');
    expect(row?.parts.find((part) => part.planIndex === 1)?.writerModel).toBe('second-model');
    options.view.destroy();
  });
});
