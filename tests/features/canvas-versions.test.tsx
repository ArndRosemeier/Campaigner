import 'fake-indexeddb/auto';

import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
import { canvasPath } from '@/app/routes';
import { createCampaign } from '@/db/campaignRepo';
import { getModule, saveModule } from '@/db/moduleRepo';
import { listModuleVersions, snapshotModuleVersion } from '@/db/moduleVersionRepo';
import {
  assembleModulePartsDocument,
  createModule,
  MODULE_VERSION_CAP,
  modulePartSchema,
  moduleSpineSchema,
  splitPartsDocument,
  type Id,
} from '@/domain';
import { activeCanvasView } from '@/features/modules/canvas/canvasView';
import { flushChatPersist } from '@/features/modules/canvas/chatPersist';
import { canvasChatKey, useCanvasChatStore } from '@/features/modules/canvas/chatStore';
import { useCanvasLedgerStore } from '@/features/modules/canvas/canvasStore';
import { useCanvasPreviewStore } from '@/features/modules/canvas/previewStore';
import type * as PartTextModule from '@/features/modules/partText';
import { clearDatabase } from '../db/helpers';
import { actDrained, flushAsyncUpdates } from '../helpers/flush';

/**
 * The canvas Versions menu (08-MODULE-DESIGNER §Module canvas versions, docs/18
 * §2.3, docs/17 ledger row 63): the OWNER-VISIBLE simple undo. DURABLE
 * whole-document snapshots taken BEFORE each AI change — listed newest-first
 * with honest labels, restorable, all-cleatable for ONE module, and still there
 * after a reload (the whole point; the session-only per-part ledger stays
 * separate and labelled as such). Both chat apply modes are driven for real
 * (editor + preview snapshot) through the real controller, split-save seam and
 * Dexie; only the LLM and the toasts are mocked.
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

vi.mock('@/features/modules/partText', async (importOriginal) => {
  const original = await importOriginal<typeof PartTextModule>();
  return {
    ...original,
    saveModulePartText: vi.fn(original.saveModulePartText),
  };
});

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { toastError, toastSuccess, toastInfo } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);
const toastSuccessMock = vi.mocked(toastSuccess);
const toastInfoMock = vi.mocked(toastInfo);

const PART_0_TEXT = 'The party bargains with [[Keeper Ilse]] at the gate.\n\nRain hammers the stones.';
const PART_1_TEXT = 'The docks breathe fog.\n\nMist climbs the stairs.';

const PART_PLAN = [
  { title: 'The Gate Bargain', levelBand: '1', synopsis: '', levelUpTrigger: '' },
  { title: 'Under the Docks', levelBand: '1', synopsis: '', levelUpTrigger: '' },
  { title: 'The Long Watch', levelBand: '2', synopsis: '', levelUpTrigger: '' },
];

/** The WHOLE-module doc the seeded row holds (byte-exact pin). */
const WHOLE_DOC = assembleModulePartsDocument({
  partPlan: PART_PLAN,
  parts: [
    { planIndex: 0, markdown: PART_0_TEXT },
    { planIndex: 1, markdown: PART_1_TEXT },
  ],
}).document;

/** A reply that APPLIES one edit to part 1 (the pre-change text is WHOLE_DOC). */
const APPLY_REPLY =
  'Making it rainier.\n<edit><search>Rain hammers the stones.</search><replace>Rain drowns every word.</replace></edit>';

/** A SECOND, distinct applied edit (the first reply's search is spent). */
const APPLY_REPLY_TWO =
  'Lowering the fog.\n<edit><search>Mist climbs the stairs.</search><replace>Mist swallows the stairs.</replace></edit>';

let world: { campaignId: Id; moduleId: Id; otherModuleId: Id } = {
  campaignId: '',
  moduleId: '',
  otherModuleId: '',
};

function renderAppAt(path: string): ReturnType<typeof render> {
  window.history.replaceState(null, '', path);
  return render(<RouterProvider router={createAppRouter()} />);
}

async function seedOneModule(campaignId: Id, title: string, createdAt: number): Promise<Id> {
  const draft = createModule({
    campaignId,
    title,
    concept: 'concept',
    levelMin: 1,
    levelMax: 2,
    tone: '',
    sizeDial: 'standard',
    includePriorModules: false,
  });
  await saveModule({
    ...draft,
    createdAt,
    spine: moduleSpineSchema.parse({
      premise: 'A drowned vault premise.',
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
  return draft.id;
}

async function seedWorld(): Promise<void> {
  const campaign = await createCampaign({
    name: 'Ember',
    description: 'The ember war.',
    system: 'dnd5e',
  });
  const moduleId = await seedOneModule(campaign.id, 'The Drowned Vault', 2);
  // A SECOND module: its durable stack must survive the first one's clear.
  const otherModuleId = await seedOneModule(campaign.id, 'The Second Vault', 3);
  world = { campaignId: campaign.id, moduleId, otherModuleId };
}

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
  useCanvasLedgerStore.setState({ ownerModuleId: null, byPart: {} });
  useCanvasChatStore.setState({ ownerModuleId: null, byModule: {} });
  useCanvasPreviewStore.setState({ ownerModuleId: null, openByModule: {} });
  await flushChatPersist();
  await seedWorld();
});

function mockChatReply(raw: string): void {
  chatMock.mockImplementation(() =>
    Promise.resolve({ text: raw, modelUsed: 'test-model', fallback: null }),
  );
}

/** Mounts the canvas and lands in EDIT mode (the default view is preview). */
async function renderCanvasEditor(
  user: ReturnType<typeof userEvent.setup>,
): Promise<ReturnType<typeof render>> {
  const view = renderAppAt(canvasPath(world.campaignId, world.moduleId));
  await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
  if (screen.queryByTestId('canvas-chat') === null) {
    await user.click(await screen.findByTestId('canvas-chat-toggle'));
  }
  if (screen.queryByTestId('canvas-preview') !== null) {
    await user.click(screen.getByTestId('canvas-preview-toggle'));
  }
  await screen.findByTestId('canvas-editor');
  await flushAsyncUpdates();
  return view;
}

/** The default view: chat + live preview (no editor mounted). */
async function renderCanvasPreview(): Promise<void> {
  renderAppAt(canvasPath(world.campaignId, world.moduleId));
  await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
  expect(await screen.findByTestId('canvas-chat')).toBeInTheDocument();
  await flushAsyncUpdates();
}

/** The mocked chat for the canvasRefine contract (JSON replacement). */
function mockChatReplyJson(replacement: string): void {
  chatMock.mockImplementation((_messages, options) => {
    const raw = JSON.stringify({ replacement });
    options.onToken?.(raw);
    return Promise.resolve({ text: raw, modelUsed: 'test-model', fallback: null });
  });
}

function selectSpan(from: number, to: number): void {
  act(() => {
    activeCanvasView.current?.dispatch({ selection: { anchor: from, head: to } });
  });
}

/** Runs the canvas instruction dialog for one AI action. */
async function runInstruction(
  user: ReturnType<typeof userEvent.setup>,
  actionTestId: string,
  text: string,
): Promise<void> {
  await user.click(screen.getByTestId(actionTestId));
  const dialog = await screen.findByTestId('canvas-instruction-dialog');
  await user.type(within(dialog).getByTestId('canvas-instruction-input'), text);
  await user.click(within(dialog).getByTestId('canvas-instruction-confirm'));
  await flushAsyncUpdates();
}

async function sendChat(user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> {
  const input = screen.getByTestId('canvas-chat-input');
  await user.type(input, text);
  await user.click(screen.getByTestId('canvas-chat-send'));
  await flushAsyncUpdates();
}

/** A hand edit at the given whole-doc range (CM6 dispatch — manual typing). */
function editDoc(from: number, to: number, insert: string): void {
  const view = activeCanvasView.current;
  if (view === null) throw new Error('canvas editor view not mounted');
  act(() => {
    view.dispatch({ changes: { from, to, insert } });
  });
}

async function versions(moduleId: Id = world.moduleId) {
  return actDrained(() => listModuleVersions(moduleId));
}

async function partText(moduleId: Id, planIndex: number): Promise<string> {
  const row = await actDrained(() => getModule(moduleId));
  return row?.parts.find((part) => part.planIndex === planIndex)?.markdown ?? '';
}

async function rowDocument(moduleId: Id): Promise<string> {
  const row = await actDrained(() => getModule(moduleId));
  if (row === undefined) throw new Error('module row missing');
  return assembleModulePartsDocument({
    partPlan: row.spine?.partPlan ?? [],
    parts: row.parts,
  }).document;
}

async function openVersionsMenu(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByTestId('canvas-versions'));
  return screen.findByTestId('canvas-saved-versions-label');
}

describe('durable versions — snapshot BEFORE every AI change', () => {
  it('editor-chat apply snapshots the byte-exact WHOLE document as it stood before the batch', async () => {
    const user = userEvent.setup();
    await renderCanvasEditor(user);
    expect(await versions()).toHaveLength(0);

    mockChatReply(APPLY_REPLY);
    await sendChat(user, 'make the rain heavier');

    const saved = await versions();
    expect(saved).toHaveLength(1);
    // BYTE-EXACT pre-change text: the whole document, not the changed part.
    expect(saved[0]?.docText).toBe(WHOLE_DOC);
    expect(saved[0]?.source).toBe('chat');
    expect(saved[0]?.label).toBe('Chat: make the rain heavier');
    // The change itself landed (so the snapshot is genuinely a pre-change state).
    expect(await partText(world.moduleId, 0)).toContain('Rain drowns every word.');
    expect(await rowDocument(world.moduleId)).not.toBe(WHOLE_DOC);
    await flushAsyncUpdates();
  }, 30_000);

  it('preview-snapshot chat apply (no CM history) snapshots the pre-change document too', async () => {
    const user = userEvent.setup();
    await renderCanvasPreview();
    expect(await versions()).toHaveLength(0);

    mockChatReply(APPLY_REPLY);
    await sendChat(user, 'make the rain heavier');

    const saved = await versions();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.docText).toBe(WHOLE_DOC);
    expect(saved[0]?.source).toBe('chat');
    expect(saved[0]?.label).toBe('Chat: make the rain heavier');
    expect(await partText(world.moduleId, 0)).toContain('Rain drowns every word.');
    await flushAsyncUpdates();
  }, 30_000);

  it('an accepted Refine proposal snapshots the pre-change document (source: refine)', async () => {
    const user = userEvent.setup();
    await renderCanvasEditor(user);
    const sections = splitPartsDocument(WHOLE_DOC, PART_PLAN);
    const part0From = sections[0]?.textFrom ?? 0;
    // The refine reply is the canvasRefine JSON contract (plain replacement).
    mockChatReplyJson('The party bargains harder than ever.');
    selectSpan(part0From + 4, part0From + 9); // "party" in part 1
    await runInstruction(user, 'canvas-refine-selection', 'make the bargain harder');
    await user.click(await screen.findByTestId('canvas-suggestion-accept'));
    await flushAsyncUpdates();

    const saved = await versions();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.source).toBe('refine');
    expect(saved[0]?.label).toBe('Refine: make the bargain harder');
    // BYTE-EXACT pre-change text — the whole document, taken before the write.
    expect(saved[0]?.docText).toBe(WHOLE_DOC);
    expect(toastSuccessMock).toHaveBeenCalledWith('Proposal applied');
    await flushAsyncUpdates();
  }, 30_000);

  it('a manual hand edit + Save never snapshots (CM6 undo covers hand typing)', async () => {
    const user = userEvent.setup();
    await renderCanvasEditor(user);
    editDoc(0, 3, 'The');
    act(() => {
      screen.getByTestId('canvas-save').click();
    });
    await flushAsyncUpdates();

    expect(await versions()).toHaveLength(0);
    // The hand edit really landed (a no-op save would make the assertion empty).
    expect(await partText(world.moduleId, 0)).toContain('The party bargains');
    await flushAsyncUpdates();
  }, 30_000);
});

describe('the Versions menu tells the truth about what each entry is', () => {
  it('lists durable versions newest-first with source + label + timestamp, states the retention, and keeps the session list labelled session-only', async () => {
    const user = userEvent.setup();
    await renderCanvasEditor(user);

    mockChatReply(APPLY_REPLY);
    await sendChat(user, 'make the rain heavier');
    mockChatReply(APPLY_REPLY_TWO);
    await sendChat(user, 'and lower the fog');

    const saved = await versions();
    expect(saved).toHaveLength(2);

    const label = await openVersionsMenu(user);
    // The retention is stated, never a silent cap.
    expect(label).toHaveTextContent(
      `Saved versions — the whole document as it was BEFORE each AI change (keeping the most recent ${String(MODULE_VERSION_CAP)})`,
    );
    expect(label).toHaveTextContent('BEFORE each AI change');
    // Honest per-entry labels: the change the snapshot precedes, its kind, and
    // when it was taken — newest first.
    const entries = screen.getAllByTestId(/^canvas-saved-version-/);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveTextContent('Chat: and lower the fog');
    expect(entries[1]).toHaveTextContent('Chat: make the rain heavier');
    expect(entries[0]).toHaveTextContent('Chat ·');
    // The DURABLE section never claims to be session state…
    expect(screen.getByTestId('canvas-saved-versions-label').textContent).not.toContain('session');
    // …and the SESSION list is still explicitly session-only (never mistakable
    // for the durable stack: no two conflicting ideas of what an entry is).
    expect(screen.getByText('Session versions — this session only, die on reload')).toBeInTheDocument();
    await flushAsyncUpdates();
  }, 30_000);

  it('says so honestly when nothing has been snapshotted yet', async () => {
    const user = userEvent.setup();
    await renderCanvasEditor(user);
    await openVersionsMenu(user);
    expect(screen.getByTestId('canvas-saved-versions-empty')).toHaveTextContent(
      'No saved versions yet',
    );
    // Nothing to clear: the destructive item is disabled, not a broken promise.
    expect(screen.getByTestId('canvas-versions-clear')).toHaveAttribute('aria-disabled', 'true');
    await flushAsyncUpdates();
  }, 30_000);
});

describe('restore — byte-identical text, and the restore itself is undoable', () => {
  it('restores the snapshot through the SAME proposal/save path and snapshots the pre-restore state', async () => {
    const user = userEvent.setup();
    await renderCanvasEditor(user);
    mockChatReply(APPLY_REPLY);
    await sendChat(user, 'make the rain heavier');

    const saved = await versions();
    expect(saved).toHaveLength(1);
    const target = saved[0];
    if (target === undefined) throw new Error('snapshot missing');
    const postChatDoc = await rowDocument(world.moduleId);
    expect(postChatDoc).not.toBe(WHOLE_DOC);

    // The menu entry offers the restore; accepting it is the existing AI
    // proposal path (Apply), never a side-door row write.
    await openVersionsMenu(user);
    await user.click(screen.getByTestId(`canvas-saved-version-${target.id}`));
    await flushAsyncUpdates();
    expect(screen.getByTestId('canvas-proposal-apply')).toBeInTheDocument();
    expect(activeCanvasView.current?.state.doc.toString()).toBe(postChatDoc);

    act(() => {
      screen.getByTestId('canvas-proposal-apply').click();
    });
    await flushAsyncUpdates();

    // Byte-identical: the editor AND the row now hold exactly the snapshot.
    expect(activeCanvasView.current?.state.doc.toString()).toBe(WHOLE_DOC);
    expect(await rowDocument(world.moduleId)).toBe(WHOLE_DOC);
    expect(await partText(world.moduleId, 0)).toBe(PART_0_TEXT);
    expect(toastSuccessMock).toHaveBeenCalledWith('Version restored');

    // The restore was itself snapshotted: the pre-restore text is on top of
    // the stack, so a wrong restore is recoverable.
    const after = await versions();
    expect(after).toHaveLength(2);
    expect(after[0]?.source).toBe('restore');
    expect(after[0]?.label).toContain('Restore from');
    expect(after[0]?.docText).toBe(postChatDoc);
    expect(after[1]?.docText).toBe(WHOLE_DOC);
    await flushAsyncUpdates();
  }, 30_000);

  it('refuses loudly (and writes nothing) when the editor is not mounted in preview', async () => {
    const user = userEvent.setup();
    await renderCanvasPreview();
    mockChatReply(APPLY_REPLY);
    await sendChat(user, 'make the rain heavier');
    const before = await versions();
    expect(before).toHaveLength(1);

    await openVersionsMenu(user);
    const target = before[0];
    if (target === undefined) throw new Error('snapshot missing');
    await user.click(screen.getByTestId(`canvas-saved-version-${target.id}`));
    await flushAsyncUpdates();

    expect(toastInfoMock).toHaveBeenCalledWith(
      'Switch back to Edit to restore a saved version — the editor is not mounted in preview.',
    );
    // Nothing proposed, nothing written, no extra snapshot.
    expect(await rowDocument(world.moduleId)).not.toBe(WHOLE_DOC);
    expect(await versions()).toHaveLength(1);
    await flushAsyncUpdates();
  }, 30_000);

  it('refuses a version whose part plan no longer matches instead of proposing a broken scaffold', async () => {
    const user = userEvent.setup();
    await renderCanvasEditor(user);
    // A version captured under a DIFFERENT plan (hand-built: the same module
    // id, labels that contradict today's plan).
    await actDrained(() =>
      snapshotModuleVersion(world.moduleId, 'generation', 'Generate parts'),
    );
    const [saved] = await versions();
    if (saved === undefined) throw new Error('snapshot missing');
    const { db } = await import('@/db/db');
    await actDrained(() =>
      db.moduleVersions.update(saved.id, {
        docText: '[Part 1 of 9 — Somewhere Else]\n\nold text',
      }),
    );

    await openVersionsMenu(user);
    await user.click(screen.getByTestId(`canvas-saved-version-${saved.id}`));
    await flushAsyncUpdates();

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Could not restore that version — it was saved for a different part plan, so its part labels no longer match this module.',
      expect.anything(),
    );
    // No proposal was raised and the document is untouched.
    expect(screen.queryByTestId('canvas-proposal-apply')).not.toBeInTheDocument();
    expect(activeCanvasView.current?.state.doc.toString()).toBe(WHOLE_DOC);
    expect(await rowDocument(world.moduleId)).toBe(WHOLE_DOC);
    await flushAsyncUpdates();
  }, 30_000);
});

describe('clear all previous versions', () => {
  it('deletes nothing until confirmed, then empties THIS module only and leaves the document alone', async () => {
    const user = userEvent.setup();
    await renderCanvasEditor(user);
    mockChatReply(APPLY_REPLY);
    await sendChat(user, 'make the rain heavier');
    mockChatReply(APPLY_REPLY_TWO);
    await sendChat(user, 'and lower the fog');
    // A second module's stack (untouched by this module's clear).
    await actDrained(() => snapshotModuleVersion(world.otherModuleId, 'generation', 'Generate parts'));

    const before = await versions();
    expect(before).toHaveLength(2);
    const rowDocBefore = await rowDocument(world.moduleId);

    await openVersionsMenu(user);
    await user.click(screen.getByTestId('canvas-versions-clear'));
    const dialog = await screen.findByTestId('canvas-versions-clear-dialog');
    // Destructive-confirmed, and the copy says exactly what goes and what stays.
    const copy = screen.getByTestId('canvas-versions-clear-description').textContent;
    expect(copy).toContain('all 2 saved versions of THIS module');
    expect(copy).toContain('NOT cleared');
    expect(copy).toContain('DOCUMENT TEXT');
    expect(copy).toContain('no version is saved first');

    // Nothing deleted until the confirm — cancel keeps the stack.
    expect(await versions()).toHaveLength(2);
    await user.click(within(dialog).getByTestId('canvas-versions-clear-cancel'));
    await flushAsyncUpdates();
    expect(await versions()).toHaveLength(2);

    await openVersionsMenu(user);
    await user.click(screen.getByTestId('canvas-versions-clear'));
    await screen.findByTestId('canvas-versions-clear-dialog');
    await user.click(screen.getByTestId('canvas-versions-clear-confirm'));
    await flushAsyncUpdates();

    expect(await versions()).toHaveLength(0);
    // Second module's history survived (module-keyed sweep)…
    expect(await versions(world.otherModuleId)).toHaveLength(1);
    // …the document text is untouched (a version clear is not an undo)…
    expect(await rowDocument(world.moduleId)).toBe(rowDocBefore);
    // …the clear created no snapshot of its own…
    expect(await versions()).toHaveLength(0);
    // …and the success toast is loud and exact.
    expect(toastSuccessMock).toHaveBeenCalledWith(
      'Cleared 2 saved versions for this module — the document text was not changed',
    );
    expect(toastErrorMock).not.toHaveBeenCalled();
    await flushAsyncUpdates();
  }, 30_000);
});

describe('persistence — the whole point', () => {
  it('still lists the versions after a reload-equivalent remount (while the session ledger goes back to empty)', async () => {
    const user = userEvent.setup();
    const { unmount } = await renderCanvasEditor(user);
    mockChatReply(APPLY_REPLY);
    await sendChat(user, 'make the rain heavier');
    const saved = await versions();
    expect(saved).toHaveLength(1);
    const target = saved[0];
    if (target === undefined) throw new Error('snapshot missing');
    expect(
      useCanvasLedgerStore.getState().byPart[`${world.moduleId}#0`]?.versions,
    ).toHaveLength(1);

    // Reload-equivalent: unmount, drop every session store, remount.
    unmount();
    useCanvasLedgerStore.setState({ ownerModuleId: null, byPart: {} });
    useCanvasChatStore.setState({ ownerModuleId: null, byModule: {} });
    useCanvasPreviewStore.setState({ ownerModuleId: null, openByModule: {} });
    await actDrained(() => flushChatPersist(canvasChatKey(world.moduleId)));
    renderAppAt(canvasPath(world.campaignId, world.moduleId));
    await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
    await flushAsyncUpdates();

    await openVersionsMenu(user);
    const entries = screen.getAllByTestId(/^canvas-saved-version-/);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toHaveTextContent('Chat: make the rain heavier');
    expect(entries[0]).toHaveAttribute('data-testid', `canvas-saved-version-${target.id}`);
    // The session ledger is honestly empty again — and its section says WHY.
    expect(screen.getByTestId('canvas-versions-empty')).toBeInTheDocument();
    expect(
      screen.getByText('Session versions — this session only, die on reload'),
    ).toBeInTheDocument();
    await flushAsyncUpdates();
  }, 30_000);
});
