import 'fake-indexeddb/auto';

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { canvasPath } from '@/app/routes';
import { createCampaign } from '@/db/campaignRepo';
import { createArtifact } from '@/db/artifactRepo';
import { db } from '@/db/db';
import { getModule, saveModule } from '@/db/moduleRepo';
import { listModuleVersions, clearModuleVersions } from '@/db/moduleVersionRepo';
import {
  assembleModuleDocument,
  createModule,
  modulePartSchema,
  moduleSpineSchema,
  npcDataSchema,
  type Id,
  type ModuleChatRetryUndo,
} from '@/domain';
import { clearDatabase } from '../db/helpers';
import { actDrained, flushAsyncUpdates } from '../helpers/flush';
import { activeCanvasView } from '@/features/modules/canvas/canvasView';
import { useCanvasChatStore } from '@/features/modules/canvas/chatStore';
import { useCanvasLedgerStore } from '@/features/modules/canvas/canvasStore';
import {
  RETRY_STALE_REASON,
  RETRY_VERSION_GONE_REASON,
  chatRetryLabel,
  chatRetryPlan,
  type ChatRetryTarget,
} from '@/features/modules/canvas/chatRetry';
import { openSidebar, renderAppAt, sendChat } from '../helpers/canvasPage';

/**
 * THE CHAT RETRY (docs/17 row 408, 08-MODULE-DESIGNER §Module canvas chat): the
 * Retry control on the LAST answer, and the honest semantics behind it —
 * UNDO THAT ANSWER, THEN ASK AGAIN.
 *
 * The owner's request, verbatim: *"Ok, i would like to have a retry button in
 * the AI chat for the last answer the LLM gave."* The pins below are the honest
 * half of that: the document returns to its pre-answer bytes (asserted as TEXT,
 * never a flag), the old answer is GONE while the instruction it answered is
 * KEPT, exactly ONE new answer appears, the pre-restore snapshot the retry
 * itself takes still exists (the retry is undoable), a document that moved since
 * the answer REFUSES loudly and writes nothing, an answer that changed nothing
 * writes nothing, and the label SAYS what the click undoes.
 *
 * The whole page runs for real (the turn pipeline, the apply seam, the split
 * save, the durable version stack, the chat store); only the LLM and the
 * artifact-change seam are mocked.
 */

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock('@/llm/openrouter', async (importOriginal) =>
  (await import('../helpers/openrouterMock')).openrouterMock(importOriginal, { chat: vi.fn() }),
);

vi.mock('@/db/artifactAutoPromote', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  promoteSecondModuleUses: vi.fn(),
}));

vi.mock('@/features/modules/change-artifact', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  changeArtifact: vi.fn(),
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { toastError } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);
const { changeArtifact } = await import('@/features/modules/change-artifact');
const changeArtifactMock = vi.mocked(changeArtifact);

const PART_0_TEXT =
  'The party bargains with [[Keeper Ilse]] at the gate.\n\nRain hammers the stones.\n\n[[Keeper Ilse]] watches.';
const PART_1_TEXT = 'The docks breathe fog.\n\nMist climbs the stairs.';
const SPINE_PREMISE = 'The premise that must not be edited by the chat.';

const PART_PLAN = [
  { title: 'The Gate Bargain', levelBand: '1', synopsis: '', levelUpTrigger: '' },
  { title: 'Under the Docks', levelBand: '1', synopsis: '', levelUpTrigger: '' },
];

/** The module DOCUMENT the page mounts with: level 0 is the PREMISE, then one
 * section per planned level. */
const WHOLE_DOC = assembleModuleDocument({
  levels: [
    { number: 0, text: SPINE_PREMISE },
    { number: 1, text: PART_0_TEXT },
    { number: 2, text: PART_1_TEXT },
  ],
});

const RAIN_EDIT =
  'Making it rainier.\n<edit><search>Rain hammers the stones.</search><replace>Rain drowns every word.</replace></edit>';
const AFTER_RAIN = WHOLE_DOC.replace('Rain hammers the stones.', 'Rain drowns every word.');
const SLEET_EDIT =
  'Making it colder.\n<edit><search>Rain hammers the stones.</search><replace>Sleet scours the stones.</replace></edit>';
const AFTER_SLEET = WHOLE_DOC.replace('Rain hammers the stones.', 'Sleet scours the stones.');
const HAIL_EDIT =
  'Making it violent.\n<edit><search>Rain hammers the stones.</search><replace>Hail splits the stones.</replace></edit>';
const AFTER_HAIL = WHOLE_DOC.replace('Rain hammers the stones.', 'Hail splits the stones.');

let world: { campaignId: Id; moduleId: Id; npcId: Id } = {
  campaignId: '',
  moduleId: '',
  npcId: '',
};

async function seedModule(): Promise<void> {
  const campaign = await createCampaign({
    name: 'Ember',
    description: 'The ember war.',
    system: 'dnd5e',
  });
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
  });
  // The row the `<change>` half resolves against (the artifact-change pin).
  const npc = await createArtifact({
    campaignId: campaign.id,
    moduleId: draft.id,
    kind: 'npc',
    name: 'Keeper Ilse',
    data: npcDataSchema.parse({ appearance: 'Salt-crusted coat.', personality: 'Patient.', statBlock: null }),
  });
  world = { campaignId: campaign.id, moduleId: draft.id, npcId: npc.id };
}

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
  changeArtifactMock.mockReset();
  useCanvasLedgerStore.setState({ ownerModuleId: null, byPart: {} });
  useCanvasChatStore.setState({ ownerModuleId: null, byModule: {} });
  await seedModule();
});

/** Queues one streamed reply per raw string, in order. */
function mockChatReplies(replies: readonly string[]): void {
  for (const raw of replies) {
    chatMock.mockImplementationOnce((_messages, opts) => {
      const mid = Math.max(1, Math.floor(raw.length / 2));
      opts.onToken?.(raw.slice(0, mid));
      opts.onToken?.(raw.slice(mid));
      return Promise.resolve({ text: raw, modelUsed: 'test-model', fallback: null });
    });
  }
}

/** Queues one transport failure (the failed-answer pin). */
function mockChatFailure(message: string): void {
  chatMock.mockImplementationOnce(() => Promise.reject(new Error(message)));
}

async function clickRetry(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByTestId('canvas-chat-retry'));
  await flushAsyncUpdates();
}

function messageRoles(): string[] {
  return (
    useCanvasChatStore.getState().module(world.moduleId).messages.map((message) => message.role)
  );
}

function documentText(): string {
  return activeCanvasView.current?.state.doc.toString() ?? '';
}

function retryReason(): string | null {
  return screen.queryByTestId('canvas-chat-retry-reason')?.textContent ?? null;
}

/** A minimal retry target carrying only what the PLAN reads — the label is the
 * honesty surface, so it is pinned directly as well as through the page. */
function targetWith(undo: ModuleChatRetryUndo | null): ChatRetryTarget {
  return {
    key: 'k',
    instruction: 'make the rain heavier',
    messageIds: ['m1', 'm2'],
    lastAnswer: {
      id: 'm2',
      role: 'assistant',
      text: '',
      raw: null,
      status: 'ok',
      error: null,
      outcomes: [],
      createdAt: 1,
    },
    undo,
  };
}

function undoRecord(overrides: Partial<ModuleChatRetryUndo>): ModuleChatRetryUndo {
  return {
    documentChanged: true,
    snapshotId: 'v1',
    afterFingerprint: '1:aa:bb',
    irreversible: [],
    keptStatements: [],
    ...overrides,
  };
}

describe('the retry LABEL says exactly what the click does (docs/17 row 408)', () => {
  it('names the undo when the document changed, and nothing when it did not', () => {
    expect(chatRetryLabel(chatRetryPlan(targetWith(undoRecord({}))))).toBe(
      'Retry (undoes the changes this answer made)',
    );
    // A record-only answer has a retry target but NO document to put back.
    expect(
      chatRetryLabel(
        chatRetryPlan(targetWith(undoRecord({ documentChanged: false, snapshotId: null }))),
      ),
    ).toBe('Retry');
    expect(chatRetryLabel(chatRetryPlan(targetWith(null)))).toBe('Retry');
  });

  it('NAMES the level statements that stay applied, capped at two', () => {
    expect(
      chatRetryLabel(
        chatRetryPlan(targetWith(undoRecord({ keptStatements: ['«Marten» level 3'] }))),
      ),
    ).toBe('Retry (undoes the changes this answer made; «Marten» level 3 stays applied)');
    expect(
      chatRetryLabel(
        chatRetryPlan(
          targetWith(
            undoRecord({
              keptStatements: ['«A» level 1', '«B» level 2', '«C» level 3', '«D» level 4'],
            }),
          ),
        ),
      ),
    ).toBe(
      'Retry (undoes the changes this answer made; «A» level 1, «B» level 2 and 2 more stay applied)',
    );
    // A statements-only answer: no undo claim, but the kept record is named.
    expect(
      chatRetryLabel(
        chatRetryPlan(
          targetWith(
            undoRecord({ documentChanged: false, snapshotId: null, keptStatements: ['«A» level 1'] }),
          ),
        ),
      ),
    ).toBe('Retry («A» level 1 stays applied)');
  });

  it('REFUSES an answer whose non-document change a retry cannot undo, naming it', () => {
    const plan = chatRetryPlan(targetWith(undoRecord({ irreversible: ['«Keeper Ilse»'] })));
    expect(plan.refusal).toContain('«Keeper Ilse»');
    expect(plan.refusal).toContain('a retry can only undo the campaign DOCUMENT');
    expect(plan.undoesDocument).toBe(false);
  });
});

describe('canvas chat retry (docs/17 row 408)', () => {
  it('UNDOES the answer’s document changes, keeps the instruction, and leaves exactly one new answer', async () => {
    const user = userEvent.setup();
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await openSidebar(user);
    mockChatReplies([RAIN_EDIT, SLEET_EDIT]);

    await sendChat(user, 'make the rain heavier');
    // The first answer's edit is IN the document and on the row.
    expect(documentText()).toBe(AFTER_RAIN);
    expect((await getModule(world.moduleId))?.parts[0]?.markdown).toContain(
      'Rain drowns every word.',
    );
    // The turn took the durable pre-answer snapshot.
    const afterFirst = await listModuleVersions(world.moduleId);
    expect(afterFirst.map((version) => version.docText)).toEqual([WHOLE_DOC]);
    // The control says what it will do — the answer DID change the document.
    expect(screen.getByTestId('canvas-chat-retry').textContent).toContain(
      'undoes the changes this answer made',
    );

    await clickRetry(user);

    // THE DOCUMENT IS PRE-ANSWER BYTES + the NEW answer: the old edit is gone,
    // asserted as text, so a "restore" that left the old edit applied is RED.
    expect(documentText()).toBe(AFTER_SLEET);
    expect(documentText()).not.toContain('Rain drowns every word.');
    expect((await getModule(world.moduleId))?.parts[0]?.markdown).toContain(
      'Sleet scours the stones.',
    );
    expect((await getModule(world.moduleId))?.parts[0]?.markdown).not.toContain(
      'Rain drowns every word.',
    );
    // The instruction is KEPT, verbatim, and there is exactly ONE answer: no
    // accumulated pile, no orphaned question.
    expect(messageRoles()).toEqual(['user', 'assistant']);
    expect(screen.getByTestId('canvas-chat-messages').textContent).toContain(
      'make the rain heavier',
    );
    // The new answer carries its OWN outcome card (the old one is gone).
    const cards = within(screen.getByTestId('canvas-chat')).getAllByTestId('canvas-chat-outcome');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.textContent).toContain('Sleet scours the stones.');
    // THE RETRY IS ITSELF UNDOABLE: the pre-restore snapshot it took (the text
    // the first answer had left) is on the durable stack, and the re-run took
    // its own pre-change snapshot of the restored document.
    const after = await listModuleVersions(world.moduleId);
    expect(after.map((version) => version.docText)).toContain(AFTER_RAIN);
    expect(after.filter((version) => version.docText === WHOLE_DOC)).toHaveLength(2);
  }, 30_000);

  it('a FAILED answer is retried with nothing to undo: no snapshot, a fresh attempt', async () => {
    const user = userEvent.setup();
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await openSidebar(user);
    mockChatFailure('the model fell over');
    await sendChat(user, 'make the rain heavier');

    expect(documentText()).toBe(WHOLE_DOC);
    expect(await listModuleVersions(world.moduleId)).toHaveLength(0);
    expect(screen.getByTestId('canvas-chat-error-card')).toBeInTheDocument();
    // A failed answer changed nothing: the label makes NO undo claim.
    expect(screen.getByTestId('canvas-chat-retry').textContent).toBe('Retry');

    mockChatReplies([RAIN_EDIT]);
    await clickRetry(user);

    expect(documentText()).toBe(AFTER_RAIN);
    expect(messageRoles()).toEqual(['user', 'assistant']);
    expect(screen.queryByTestId('canvas-chat-error-card')).not.toBeInTheDocument();
    // The fresh attempt took its OWN pre-change snapshot, and the retry wrote
    // no undo snapshot of its own (there was nothing to undo).
    expect((await listModuleVersions(world.moduleId)).map((version) => version.docText)).toEqual([
      WHOLE_DOC,
    ]);
  }, 30_000);

  it('a NO-EDIT answer is retried with nothing written: the document and the version stack are untouched', async () => {
    const user = userEvent.setup();
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await openSidebar(user);
    mockChatReplies(['The rain is already heavy enough — no change needed.', RAIN_EDIT]);
    await sendChat(user, 'make the rain heavier');

    expect(documentText()).toBe(WHOLE_DOC);
    expect(await listModuleVersions(world.moduleId)).toHaveLength(0);
    expect(screen.getByTestId('canvas-chat-retry').textContent).toBe('Retry');

    const versionsBefore = await listModuleVersions(world.moduleId);
    const ledgerBefore = useCanvasLedgerStore.getState().byPart;

    await clickRetry(user);

    // The re-run applies its own edit; the UNDO wrote nothing at all: exactly
    // ONE version row exists (the re-run's own pre-change snapshot), and the
    // session ledger grew only by the re-run's entry.
    expect(documentText()).toBe(AFTER_RAIN);
    expect(messageRoles()).toEqual(['user', 'assistant']);
    expect((await listModuleVersions(world.moduleId)).map((version) => version.docText)).toEqual([
      WHOLE_DOC,
    ]);
    expect(versionsBefore).toHaveLength(0);
    const ledgersAfter = useCanvasLedgerStore.getState().byPart;
    const entries = Object.values(ledgersAfter).flatMap((ledger) => ledger.versions);
    expect(Object.values(ledgerBefore).flatMap((ledger) => ledger.versions)).toHaveLength(0);
    expect(entries).toHaveLength(1);
  }, 30_000);

  it('the control exists ONLY on the LAST answer: a second-to-last answer has none', async () => {
    const user = userEvent.setup();
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await openSidebar(user);
    mockChatReplies([RAIN_EDIT, SLEET_EDIT]);
    await sendChat(user, 'make the rain heavier');
    await sendChat(user, 'now make it colder');

    const controls = screen.getAllByTestId('canvas-chat-retry');
    expect(controls).toHaveLength(1);
    const bubbles = screen.getAllByTestId('canvas-chat-assistant-message');
    expect(bubbles).toHaveLength(2);
    const firstAnswer = bubbles[0];
    const lastAnswer = bubbles[1];
    if (firstAnswer === undefined || lastAnswer === undefined) {
      throw new Error('expected two assistant bubbles');
    }
    expect(within(lastAnswer).getByTestId('canvas-chat-retry')).toBeInTheDocument();
    expect(within(firstAnswer).queryByTestId('canvas-chat-retry')).toBeNull();
  }, 30_000);

  it('a STALE retry is refused loudly and writes nothing', async () => {
    const user = userEvent.setup();
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await openSidebar(user);
    mockChatReplies([RAIN_EDIT]);
    await sendChat(user, 'make the rain heavier');
    const versionsBefore = await listModuleVersions(world.moduleId);
    const callsBefore = chatMock.mock.calls.length;

    // The document MOVES after the answer — a hand edit, the case the owner
    // named ("edited by hand"): restoring the pre-answer snapshot now would
    // overwrite newer work.
    const view = activeCanvasView.current;
    if (view === null) throw new Error('editor view missing');
    await actDrained(() => {
      view.dispatch({ changes: { from: 0, to: 0, insert: 'A hand-written line.\n\n' } });
      return Promise.resolve();
    });
    const handEdited = documentText();
    expect(handEdited).toContain('A hand-written line.');

    await clickRetry(user);

    expect(toastErrorMock).toHaveBeenCalledWith(RETRY_STALE_REASON, expect.anything());
    // Nothing was written, nothing was re-asked, and the answer is still there.
    expect((await listModuleVersions(world.moduleId)).length).toBe(versionsBefore.length);
    expect(chatMock.mock.calls.length).toBe(callsBefore);
    expect(messageRoles()).toEqual(['user', 'assistant']);
    expect(documentText()).toBe(handEdited);
  }, 30_000);

  it('a retry whose saved version is GONE is refused loudly and writes nothing', async () => {
    const user = userEvent.setup();
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await openSidebar(user);
    mockChatReplies([RAIN_EDIT]);
    await sendChat(user, 'make the rain heavier');
    const callsBefore = chatMock.mock.calls.length;

    // The owner cleared the saved versions: the text a retry would restore is
    // gone, so a retry cannot honestly undo anything.
    await clearModuleVersions(world.moduleId);
    await clickRetry(user);

    expect(toastErrorMock).toHaveBeenCalledWith(RETRY_VERSION_GONE_REASON, expect.anything());
    expect(chatMock.mock.calls.length).toBe(callsBefore);
    expect(messageRoles()).toEqual(['user', 'assistant']);
    // The answer's own edit still stands — nothing was undone and nothing was
    // re-asked over it.
    expect(documentText()).toBe(AFTER_RAIN);
  }, 30_000);

  it('retrying TWICE keeps one instruction and one answer, and writes one snapshot per write', async () => {
    const user = userEvent.setup();
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await openSidebar(user);
    mockChatReplies([RAIN_EDIT, SLEET_EDIT, HAIL_EDIT]);
    await sendChat(user, 'make the rain heavier');

    await clickRetry(user);
    expect(documentText()).toBe(AFTER_SLEET);
    await clickRetry(user);

    // ONE instruction, ONE answer — the thread never accumulates.
    expect(messageRoles()).toEqual(['user', 'assistant']);
    expect(documentText()).toBe(AFTER_HAIL);
    // The version stack holds EXACTLY one row per write performed: the first
    // answer's pre-change snapshot, then a pre-restore + a re-run pre-change
    // per retry (2 × 2) — five rows, no more. An implementation that
    // snapshotted twice per undo (or re-saved an unchanged document) is RED
    // here rather than merely larger.
    const versions = await listModuleVersions(world.moduleId);
    expect(versions).toHaveLength(5);
    expect(versions.map((version) => version.docText)).toEqual([
      WHOLE_DOC, // the second retry's re-run, taken over the restored document
      AFTER_SLEET, // the second retry's pre-restore snapshot
      WHOLE_DOC, // the first retry's re-run
      AFTER_RAIN, // the first retry's pre-restore snapshot
      WHOLE_DOC, // the first answer's pre-change snapshot
    ]);
  }, 30_000);

  it('an answer that ALSO changed a stored artifact is refused, naming what a retry cannot undo', async () => {
    const user = userEvent.setup();
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await openSidebar(user);
    changeArtifactMock.mockResolvedValue({
      status: 'changed',
      artifactId: world.npcId,
      kind: 'npc',
      operation: 'entity-redesign',
    });
    mockChatReplies([
      'Rewriting her.\n<change><name>Keeper Ilse</name><instruction>make her crueler</instruction></change>',
      // The change round trip calls the model ONCE more with the results.
      'Keeper Ilse is crueler now.',
    ]);
    await sendChat(user, 'make Keeper Ilse crueler');

    // The retry is GATED OFF — and the reason names the row and the way out.
    const control = screen.getByTestId('canvas-chat-retry');
    expect(control).toBeDisabled();
    expect(retryReason()).toContain('«Keeper Ilse»');
    expect(retryReason()).toContain('a retry can only undo the campaign DOCUMENT');

    // Clicking it changes nothing and asks nothing.
    const callsBefore = chatMock.mock.calls.length;
    const rolesBefore = messageRoles();
    await clickRetry(user);
    expect(chatMock.mock.calls.length).toBe(callsBefore);
    expect(messageRoles()).toEqual(rolesBefore);
  }, 30_000);

  it('the label says the level statements stay applied when the answer stated one', async () => {
    const user = userEvent.setup();
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await openSidebar(user);
    mockChatReplies([
      [
        'Stating her level.',
        '<state_level level="3" entity="npc"><name>Marten</name></state_level>',
        '<edit><search>Rain hammers the stones.</search><replace>Rain drowns every word.</replace></edit>',
      ].join('\n'),
      SLEET_EDIT,
    ]);
    await sendChat(user, 'make the rain heavier and set Marten to level 3');

    const control = screen.getByTestId('canvas-chat-retry');
    expect(control.textContent).toContain('undoes the changes this answer made');
    // The statement is NAMED IN THE LABEL — the visible surface, never a
    // `title` on a wrapped control (the blocked-control scan forbids that).
    expect(control.textContent).toContain('«Marten» level 3 stays applied');

    // The retry still runs (a statement is not a blocker) and undoes only the
    // DOCUMENT half.
    await clickRetry(user);
    expect(documentText()).toBe(AFTER_SLEET);
    const row = await db.modules.get(world.moduleId);
    if (row === undefined) throw new Error('module row missing after the retry');
    expect(row.document).toBe(AFTER_SLEET);
    expect(row.entityKinds.find((entry) => entry.name === 'Marten')?.levelHint).toBe(3);
  }, 30_000);

  it('retries on the GM-ASSIST surface through the SAME code path (one store, one pipeline)', async () => {
    const user = userEvent.setup();
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await openSidebar(user);
    await user.click(screen.getByTestId('canvas-chat-surface-gm-assist'));
    mockChatReplies([RAIN_EDIT, SLEET_EDIT]);

    await sendChat(user, 'the party refused the Keeper’s offer');
    expect(documentText()).toBe(AFTER_RAIN);
    expect(
      useCanvasChatStore.getState().module(`${world.moduleId}#gm-assist`).messages,
    ).toHaveLength(2);

    await clickRetry(user);

    expect(documentText()).toBe(AFTER_SLEET);
    // The GM-assist thread is session-only, but it never accumulates either.
    expect(
      useCanvasChatStore.getState().module(`${world.moduleId}#gm-assist`).messages.map((m) => m.role),
    ).toEqual(['user', 'assistant']);
    // The CAMPAIGN chat's thread (the other conversation) was not touched.
    expect(useCanvasChatStore.getState().module(world.moduleId).messages).toHaveLength(0);
    expect((await getModule(world.moduleId))?.parts[0]?.markdown).toContain(
      'Sleet scours the stones.',
    );
  }, 30_000);

  it('retries from the PREVIEW surface over the preview snapshot (the second view)', async () => {
    const user = userEvent.setup();
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    // The canvas OPENS in preview: no toggle — this is the preview surface.
    expect(await screen.findByTestId('canvas-preview')).toBeInTheDocument();
    mockChatReplies([RAIN_EDIT, SLEET_EDIT]);

    await sendChat(user, 'make the rain heavier');
    await waitFor(() => {
      expect(screen.getByTestId('canvas-preview').textContent).toContain(
        'Rain drowns every word.',
      );
    });
    await clickRetry(user);

    await waitFor(() => {
      expect(screen.getByTestId('canvas-preview').textContent).toContain(
        'Sleet scours the stones.',
      );
    });
    expect(screen.getByTestId('canvas-preview').textContent).not.toContain(
      'Rain drowns every word.',
    );
    expect((await getModule(world.moduleId))?.parts[0]?.markdown).toContain(
      'Sleet scours the stones.',
    );
    expect(messageRoles()).toEqual(['user', 'assistant']);
  }, 30_000);
});
