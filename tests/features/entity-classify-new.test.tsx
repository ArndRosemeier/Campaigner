import 'fake-indexeddb/auto';

import { act, cleanup, render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { getModule, patchModule, saveModule } from '@/db/moduleRepo';
import { useProgressStore } from '@/lib/progress';
import { createModule, modulePartSchema, moduleSpineSchema, type Id, type Module } from '@/domain';
import { assembleModulePartsDocument } from '@/domain/modulePartsDocument';
import { EntityPanel } from '@/features/modules/entity-panel';
import { canvasChatKey, useCanvasChatStore } from '@/features/modules/canvas/chatStore';
import { runSnapshotChatTurn } from '@/features/modules/canvas/snapshotChat';
import { saveModulePartText } from '@/features/modules/partText';
import { cancelModuleGen, runParts } from '@/llm/moduleGen';
import { clearDatabase } from '../db/helpers';
import { actDrained, flushAsyncUpdates } from '../helpers/flush';

/**
 * Names the module text picks up AFTER the last pass (08 §M4-C; docs/17 row
 * 64). The batch toolbar's buckets read the RECORDS the generator wrote, so a
 * new wiki-link name — a chat apply, a hand edit, a rewrite, a version restore
 * — had no record and therefore no button, and the owner's "Generate N npcs"
 * toolbar quietly lost the new entities.
 *
 * The panel's FRESH read of the module text is the ONE observation point: it
 * names the unrecorded names and offers the classification run, which rides
 * the SAME normalization machinery as the creation-time pass. These tests
 * drive REAL text-changing seams (the preview chat turn's split-save, the one
 * part-text save path, a parts run cancelled before its own pass) and prove
 * the end state: records for the new names, the kind's button back, no
 * duplicate records, no guessed kinds, and the fix-01 consent rule intact for
 * hand-edited text.
 */

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock('@/llm/openrouter', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chat: vi.fn(),
}));

vi.mock('@/db/artifactAutoPromote', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  promoteSecondModuleUses: vi.fn(),
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { toastError, toastSuccess } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);
const toastSuccessMock = vi.mocked(toastSuccess);

const PART_PLAN = [
  { title: 'The Sunken Quarter', levelBand: '1', synopsis: '', levelUpTrigger: '' },
  { title: 'The Drowned Cathedral', levelBand: '2', synopsis: '', levelUpTrigger: '' },
];

const PART_0_TEXT =
  'Rain hammers the stones. [[Kael]] watches the gate and counts the boats.';
const PART_1_TEXT = 'The docks breathe fog, and nothing moves.';

const SPINE_PREMISE = 'A harbor town whose bell rings by itself beneath the water.';

const WHOLE_DOC = assembleModulePartsDocument({
  partPlan: PART_PLAN,
  parts: [
    { planIndex: 0, markdown: PART_0_TEXT },
    { planIndex: 1, markdown: PART_1_TEXT },
  ],
}).document;

/** The recorded npc the generator knew about: unresolved, so it has a button. */
const KAEL_RECORD = { name: 'Kael', kind: 'npc' as const, absorbed: [], wants: [], conflictKind: null };

let world: { campaignId: Id; moduleId: Id; campaign: Awaited<ReturnType<typeof createCampaign>> };

function moduleFixture(campaignId: Id): Module {
  const base = createModule({
    campaignId,
    title: 'Ember Crypt',
    concept: 'A crypt guarding an old seal.',
    levelMin: 1,
    levelMax: 2,
    sizeDial: 'standard',
  });
  return {
    ...base,
    spine: moduleSpineSchema.parse({
      premise: SPINE_PREMISE,
      themes: [],
      partPlan: PART_PLAN,
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        markdown: PART_0_TEXT,
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
      modulePartSchema.parse({
        planIndex: 1,
        markdown: PART_1_TEXT,
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
    ],
    status: 'ready',
    // A module whose creation-time pass succeeded: records exist, gate open.
    entityKinds: [KAEL_RECORD],
    entityNamesNormalized: true,
  };
}

/** The normalization reply for a self-mapped name. */
function normalizationReply(names: { name: string; kind: string }[]): {
  text: string;
  modelUsed: string;
  fallback: null;
} {
  return {
    text: JSON.stringify({
      entities: names.map((entry) => ({
        name: entry.name,
        canonical: entry.name,
        kind: entry.kind,
      })),
    }),
    modelUsed: 'test-model',
    fallback: null,
  };
}

function render(
  ui: Parameters<typeof rtlRender>[0],
  options?: Parameters<typeof rtlRender>[1],
): ReturnType<typeof rtlRender> {
  return rtlRender(ui, { ...options, wrapper: options?.wrapper ?? MemoryRouter });
}

/** Renders the panel for the module row as it stands in the database NOW. */
async function renderFreshPanel(): Promise<{ module: Module; rerender: () => Promise<void> }> {
  const row = await getModule(world.moduleId);
  if (row === undefined) throw new Error('module row vanished');
  const view = render(
    <EntityPanel
      module={row}
      artifacts={[]}
      campaign={world.campaign}
      onStub={vi.fn()}
      onOpenCard={vi.fn()}
    />,
  );
  const rerender = async (): Promise<void> => {
    const fresh = await getModule(world.moduleId);
    if (fresh === undefined) throw new Error('module row vanished');
    act(() => {
      view.rerender(
        <EntityPanel
          module={fresh}
          artifacts={[]}
          campaign={world.campaign}
          onStub={vi.fn()}
          onOpenCard={vi.fn()}
        />,
      );
    });
  };
  return { module: row, rerender };
}

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
  useProgressStore.getState().reset();
  useCanvasChatStore.setState({ ownerModuleId: null, byModule: {} });
  const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
  const module = await saveModule(moduleFixture(campaign.id));
  world = { campaignId: campaign.id, moduleId: module.id, campaign };
});

afterEach(cleanup);

describe('names the module text picked up later (08 §M4-C record gate)', () => {
  it('a CHAT-introduced name has no record and no button until it is classified from the fresh read', async () => {
    const user = userEvent.setup();
    // The chat reply introduces a name no pass has seen, through the real
    // preview-chat save seam (apply -> split-save -> one part-text write).
    chatMock.mockResolvedValueOnce({
      text: 'A harbormaster joins the watch.\n<edit><search>counts the boats.</search><replace>counts the boats with [[Harbormaster Vex]].</replace></edit>',
      modelUsed: 'test-model',
      fallback: null,
    });
    await actDrained(async () => {
      await runSnapshotChatTurn(
        {
          moduleId: world.moduleId,
          key: canvasChatKey(world.moduleId),
          hasPlannedParts: true,
          doc: WHOLE_DOC,
          modelSelection: null,
          turn: new AbortController(),
        },
        'add a harbormaster to the gate',
      );
    });
    await flushAsyncUpdates();

    const row = await getModule(world.moduleId);
    expect(row?.parts[0]?.markdown).toContain('[[Harbormaster Vex]]');
    expect(row?.parts[0]?.edited).toBe(true);
    // The owner's state: the text names it, nothing recorded it.
    expect(row?.entityKinds.map((entry) => entry.name)).toEqual(['Kael']);

    const panel = await renderFreshPanel();

    // The recorded name keeps its button and the new one is NOT in any bucket
    // (no guessed kind, no silent inclusion).
    expect(screen.getByTestId('batch-npc')).toHaveTextContent('Generate 1 npc');
    expect(screen.getAllByTestId(/batch-/)).toHaveLength(1);
    expect(screen.getByTestId('entity-classify-new')).toHaveTextContent('Classify 1 new name');
    expect(screen.getByTestId('entity-classify-hint')).toHaveTextContent(
      '1 unresolved name has no recorded type yet',
    );

    chatMock.mockResolvedValueOnce(normalizationReply([{ name: 'Harbormaster Vex', kind: 'npc' }]));
    await user.click(screen.getByTestId('entity-classify-new'));
    await waitFor(async () => {
      expect((await getModule(world.moduleId))?.entityKinds.map((entry) => entry.name)).toEqual([
        'Kael',
        'Harbormaster Vex',
      ]);
    });
    expect(toastSuccessMock).toHaveBeenCalledWith('Classified 1 new entity name');
    expect(chatMock).toHaveBeenCalledTimes(2); // the chat turn + the one pass

    await panel.rerender();
    expect(screen.getByTestId('batch-npc')).toHaveTextContent('Generate 2 npc');
    expect(screen.queryByTestId('entity-classify-new')).not.toBeInTheDocument();
  }, 20000);

  it('a MANUAL part edit (the one part-text save path) is observed the same way — no chat involved', async () => {
    const user = userEvent.setup();
    await saveModulePartText(
      world.moduleId,
      0,
      `${PART_0_TEXT} [[Harbormaster Vex]] waits by the winch.`,
    );
    const row = await getModule(world.moduleId);
    expect(row?.parts[0]?.edited).toBe(true);
    expect(row?.entityKinds.map((entry) => entry.name)).toEqual(['Kael']);

    const panel = await renderFreshPanel();
    expect(screen.getByTestId('entity-classify-new')).toHaveTextContent('Classify 1 new name');
    expect(screen.getByTestId('batch-npc')).toHaveTextContent('Generate 1 npc');

    chatMock.mockResolvedValueOnce(normalizationReply([{ name: 'Harbormaster Vex', kind: 'npc' }]));
    await user.click(screen.getByTestId('entity-classify-new'));
    await waitFor(async () => {
      expect((await getModule(world.moduleId))?.entityKinds).toHaveLength(2);
    });

    await panel.rerender();
    expect(screen.getByTestId('batch-npc')).toHaveTextContent('Generate 2 npc');
    // The hand-edited text itself is untouched (the verdict mapped it to
    // itself, so there is nothing to rewrite and no proposal to review).
    expect((await getModule(world.moduleId))?.parts[0]?.markdown).toContain('[[Harbormaster Vex]]');
    expect(screen.queryByTestId('entity-proposals-banner')).not.toBeInTheDocument();
  }, 20000);

  it('a GENERATION path whose own pass never ran (cancelled run) is observed the same way', async () => {
    const user = userEvent.setup();
    // An empty module (records + gate from an earlier pass) whose parts run is
    // cancelled during the second part: part 1 is engine-written text with a
    // new name, and the run's normalization pass never happens.
    await patchModule(world.moduleId, { parts: [], status: 'draft' });
    let partCall = 0;
    chatMock.mockImplementation((_messages, options) => {
      partCall += 1;
      if (partCall === 1) {
        return Promise.resolve({
          text: `${'The tide withdraws and the sellswords count the boats. '.repeat(4)}[[Harbormaster Vex]] holds the winch.`,
          modelUsed: 'test-model',
          fallback: null,
        });
      }
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    });
    const running = runParts(world.moduleId, world.campaign);
    await waitFor(async () => {
      const row = await getModule(world.moduleId);
      expect(row?.parts.find((part) => part.planIndex === 0)?.markdown).toContain(
        '[[Harbormaster Vex]]',
      );
    });
    cancelModuleGen(world.moduleId);
    await actDrained(async () => {
      await running;
    });
    await flushAsyncUpdates();

    const row = await getModule(world.moduleId);
    expect(row?.parts[0]?.edited).toBe(false); // engine text, never hand-edited
    expect(row?.entityNamesNormalized).toBe(true); // the earlier pass's flag
    expect(row?.entityKinds.map((entry) => entry.name)).toEqual(['Kael']);

    const panel = await renderFreshPanel();
    // The owner's regression in its purest form: the text names an entity, no
    // record exists, so the toolbar has NO button at all.
    expect(screen.queryAllByTestId(/batch-/)).toHaveLength(0);
    expect(screen.getByTestId('entity-classify-new')).toHaveTextContent('Classify 1 new name');

    chatMock.mockResolvedValueOnce(normalizationReply([{ name: 'Harbormaster Vex', kind: 'npc' }]));
    await user.click(screen.getByTestId('entity-classify-new'));
    await waitFor(async () => {
      expect((await getModule(world.moduleId))?.entityKinds).toHaveLength(2);
    });

    await panel.rerender();
    expect(screen.getByTestId('batch-npc')).toHaveTextContent('Generate 1 npc');
    expect(screen.queryByTestId('entity-classify-new')).not.toBeInTheDocument();
  }, 20000);

  it('a failing classification is loud, records nothing and closes the batch gate', async () => {
    const user = userEvent.setup();
    await saveModulePartText(world.moduleId, 0, `${PART_0_TEXT} [[Harbormaster Vex]] waits.`);
    const panel = await renderFreshPanel();
    // The reply never answers for the listed name — invalid after the retry.
    chatMock.mockResolvedValue({
      text: JSON.stringify({ entities: [{ name: 'Ghost', canonical: 'Ghost', kind: 'npc' }] }),
      modelUsed: 'test-model',
      fallback: null,
    });

    await user.click(screen.getByTestId('entity-classify-new'));
    await waitFor(async () => {
      expect((await getModule(world.moduleId))?.entityNamesNormalized).toBe(false);
    });

    const row = await getModule(world.moduleId);
    // No guessed record: the unverified name is NOT batchable and was not
    // silently dropped — the error is on the row and toasted.
    expect(row?.entityKinds.map((entry) => entry.name)).toEqual(['Kael']);
    expect(row?.entityNormalizationError).toContain('invented a name');
    expect(chatMock).toHaveBeenCalledTimes(2); // one call + the stated retry
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Entity name normalization failed — retry from the entity panel',
      expect.any(Error),
    );

    await panel.rerender();
    expect(screen.getByTestId('entity-normalize-error')).toHaveTextContent('invented a name');
    expect(screen.getByTestId('entity-normalize-retry')).toBeInTheDocument();
    // The gate is closed: the batch button is disabled with the visible
    // reason and no classify affordance offers a guess.
    expect(screen.getByTestId('batch-npc')).toBeDisabled();
    expect(screen.queryByTestId('entity-classify-new')).not.toBeInTheDocument();
    expect(screen.getByTestId('batch-gate-reason')).toHaveTextContent(
      'Entity name normalization failed',
    );
  }, 20000);

  it('is idempotent: a repeated click classifies nothing twice and a re-render never calls the model', async () => {
    const user = userEvent.setup();
    await saveModulePartText(world.moduleId, 0, `${PART_0_TEXT} [[Harbormaster Vex]] waits.`);
    const panel = await renderFreshPanel();

    // A plain re-render observes the same text and dispatches nothing.
    await panel.rerender();
    expect(chatMock).not.toHaveBeenCalled();

    chatMock.mockResolvedValueOnce(normalizationReply([{ name: 'Harbormaster Vex', kind: 'npc' }]));
    await user.click(screen.getByTestId('entity-classify-new'));
    await waitFor(async () => {
      expect((await getModule(world.moduleId))?.entityKinds).toHaveLength(2);
    });
    const once = await getModule(world.moduleId);
    expect(chatMock).toHaveBeenCalledTimes(1);

    // The stale prop still shows the affordance: a second click is a no-op —
    // no model call, no duplicate record, no duplicate proposal.
    await user.click(screen.getByTestId('entity-classify-new'));
    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith('No new entity names to classify');
    });
    expect(chatMock).toHaveBeenCalledTimes(1);
    const twice = await getModule(world.moduleId);
    expect(twice?.entityKinds).toEqual(once?.entityKinds);
    expect(twice?.entityRewriteProposals).toBeNull();

    await panel.rerender();
    expect(screen.getByTestId('batch-npc')).toHaveTextContent('Generate 2 npc');
    expect(screen.queryByTestId('entity-classify-new')).not.toBeInTheDocument();
  }, 20000);

  it('folds a chat-introduced VARIANT onto the recorded entity: no second record, and the rewrite waits for consent', async () => {
    const user = userEvent.setup();
    chatMock.mockResolvedValueOnce({
      text: 'A title lands.\n<edit><search>[[Kael]] watches the gate</search><replace>[[Warden Kael]] watches the gate</replace></edit>',
      modelUsed: 'test-model',
      fallback: null,
    });
    await actDrained(async () => {
      await runSnapshotChatTurn(
        {
          moduleId: world.moduleId,
          key: canvasChatKey(world.moduleId),
          hasPlannedParts: true,
          doc: WHOLE_DOC,
          modelSelection: null,
          turn: new AbortController(),
        },
        'give Kael his title',
      );
    });
    await flushAsyncUpdates();
    expect((await getModule(world.moduleId))?.parts[0]?.markdown).toContain('[[Warden Kael]]');

    const panel = await renderFreshPanel();
    expect(screen.getByTestId('entity-classify-new')).toHaveTextContent('Classify 1 new name');

    chatMock.mockResolvedValueOnce({
      text: JSON.stringify({
        entities: [{ name: 'Warden Kael', canonical: 'Kael', kind: 'npc' }],
      }),
      modelUsed: 'test-model',
      fallback: null,
    });
    await user.click(screen.getByTestId('entity-classify-new'));
    await waitFor(async () => {
      expect((await getModule(world.moduleId))?.entityRewriteProposals).not.toBeNull();
    });

    const row = await getModule(world.moduleId);
    // ONE record for the canonical — the variant never becomes a second one.
    expect(row?.entityKinds.map((entry) => entry.name)).toEqual(['Kael']);
    // The chat-applied part is hand-edited text: the rewrite is HELD for the
    // review dialog, and the text is untouched until the user consents.
    expect(row?.entityRewriteProposals).toEqual([
      { planIndex: 0, replacements: [{ from: 'Warden Kael', to: 'Kael' }] },
    ]);
    expect(row?.parts[0]?.markdown).toContain('[[Warden Kael]]');

    await panel.rerender();
    expect(screen.getByTestId('entity-proposals-banner')).toBeInTheDocument();
    await user.click(screen.getByTestId('entity-proposals-review'));
    await user.click(within(screen.getByTestId('entity-proposals-dialog')).getByTestId('entity-proposals-apply'));
    await waitFor(async () => {
      expect((await getModule(world.moduleId))?.parts[0]?.markdown).toContain('[[Kael|Warden Kael]]');
    });

    await panel.rerender();
    expect(screen.queryByTestId('entity-classify-new')).not.toBeInTheDocument();
    expect(screen.getByTestId('batch-npc')).toHaveTextContent('Generate 1 npc');
  }, 20000);

  it('pins the record gate: a name with no record has no button, and classifying it unlocks exactly that kind', async () => {
    const user = userEvent.setup();
    // 'The Tide Bell' is typed in the text with no record — the invariant the
    // fix-01 work pinned, now paired with the visible way out.
    await saveModulePartText(world.moduleId, 0, `${PART_0_TEXT} [[The Tide Bell]] tolls.`);
    const panel = await renderFreshPanel();

    expect(screen.queryByTestId('batch-note')).not.toBeInTheDocument();
    expect(screen.getAllByTestId(/batch-/)).toHaveLength(1); // npc only
    expect(screen.getByTestId('entity-classify-new')).toHaveTextContent('Classify 1 new name');

    chatMock.mockResolvedValueOnce(normalizationReply([{ name: 'The Tide Bell', kind: 'note' }]));
    await user.click(screen.getByTestId('entity-classify-new'));
    await waitFor(async () => {
      expect((await getModule(world.moduleId))?.entityKinds).toHaveLength(2);
    });

    await panel.rerender();
    // The RECORD is what unlocks the button — nothing else.
    expect(screen.getByTestId('batch-note')).toHaveTextContent('Generate 1 note');
    expect(screen.getByTestId('batch-npc')).toHaveTextContent('Generate 1 npc');
  }, 20000);
});
