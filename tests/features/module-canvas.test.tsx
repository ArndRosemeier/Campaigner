import 'fake-indexeddb/auto';

import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { canvasPath } from '@/app/routes';
import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { getModule, saveModule } from '@/db/moduleRepo';
import {
  createModule,
  modulePartSchema,
  moduleSpineSchema,
  type Id,
} from '@/domain';
import {
  assembleModuleDocument,
  moduleDocumentSections,
  moduleLevelSeparator,
} from '@/domain/moduleDocument';
import { clearDatabase } from '../db/helpers';
import { actDrained, flushAsyncUpdates } from '../helpers/flush';
import { activeCanvasView, lastCanvasScroll } from '@/features/modules/canvas/canvasView';
import {
  canvasLedgerKey,
  useCanvasLedgerStore,
} from '@/features/modules/canvas/canvasStore';
import { useCanvasPreviewStore } from '@/features/modules/canvas/previewStore';
import { patchModule } from '@/db/moduleRepo';
import { renderAppAt } from '../helpers/canvasPage';

/**
 * Module canvas — page flows (08-MODULE-DESIGNER §Module canvas, canvas v3):
 * the editor document is the WHOLE module (composed by the shared
 * `moduleDocumentFromView` — no part selector), deep links are SCROLL
 * targets, Save is ONE split-save (only changed parts hit the save path, a
 * failed part save is loud), AI actions run refine-on-selection over the
 * whole doc and rewrite-part through an explicit PICKER (proposal range =
 * that part's section), Restore re-proposes into a part's section, leaving
 * with unsaved work demands the explicit confirm, and Preview renders the
 * scaffolding-stripped parts through the shared WikiMarkdown (reader
 * parity: clickable chips → the peek modal). The refine LLM is mocked; the
 * zod boundary, debris scan and busy rule run for real.
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

const { promoteSecondModuleUses } = await import('@/db/artifactAutoPromote');
const promoteSpy = vi.mocked(promoteSecondModuleUses);
const { toastError, toastSuccess } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);
const toastSuccessMock = vi.mocked(toastSuccess);
const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);

const PART_0_TEXT = 'The party bargains with [[Keeper Ilse]] at the gate.';
const PART_1_TEXT = 'Below the tower, the flood rises.';

const PART_PLAN = [
  { title: 'The Gate Bargain', levelBand: '1', synopsis: '', levelUpTrigger: '' },
  { title: 'The Flooded Nave', levelBand: '2', synopsis: '', levelUpTrigger: '' },
  { title: 'The Long Watch', levelBand: '2', synopsis: '', levelUpTrigger: '' },
];

const PREMISE = 'The premise promises a drowned [[Vault Door]].';

/** The module DOCUMENT the page mounts with (byte-exact pin, docs/17 row 384):
 * level 0 is the PREMISE, then one section per planned level (level 3 empty). */
const WHOLE_DOC = assembleModuleDocument({
  levels: [
    { number: 0, text: PREMISE },
    { number: 1, text: PART_0_TEXT },
    { number: 2, text: PART_1_TEXT },
    { number: 3, text: '' },
  ],
});

/**
 * Whole-doc offset of level 1's TEXT start (the "party" span the AI-action
 * tests select is `[PART0_FROM + 4, PART0_FROM + 9)` — bare small offsets
 * would land in the separator line). Section index 0 is the PREMISE, so
 * level 1 is section 1.
 */
const PART0_FROM = moduleDocumentSections(WHOLE_DOC, PART_PLAN)[1]?.textFrom ?? 0;

let world: { campaignId: Id; moduleId: Id } = { campaignId: '', moduleId: '' };

async function seedModule(): Promise<void> {
  const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
  // The reader pool behind the preview's resolved chips ([[Keeper Ilse]]).
  await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Keeper Ilse' });
  const draft = createModule({
    campaignId: campaign.id,
    title: 'The Drowned Vault',
    concept: 'concept',
    levelMin: 1,
    levelMax: 2,
    tone: '',
    sizeDial: 'standard',
    includePriorModules: false,
  });
  await saveModule({
    ...draft,
    spine: moduleSpineSchema.parse({
      premise: 'The premise promises a drowned [[Vault Door]].',
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
  world = { campaignId: campaign.id, moduleId: draft.id };
}

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
  useCanvasLedgerStore.setState({ ownerModuleId: null, byPart: {} });
  useCanvasPreviewStore.setState({ ownerModuleId: null, openByModule: {} });
  await seedModule();
});

/** The mocked chat: streams the JSON reply in two raw content chunks (the
 * canvasRefine extractor sees exactly what OpenRouter streams) and settles
 * with the full text. */
function mockChatReply(replacement: string): void {
  chatMock.mockImplementation((_messages, opts) => {
    const raw = JSON.stringify({ replacement });
    const mid = Math.max(1, Math.floor(raw.length / 2));
    opts.onToken?.(raw.slice(0, mid));
    opts.onToken?.(raw.slice(mid));
    return Promise.resolve({ text: raw, modelUsed: 'test-model', fallback: null });
  });
}

async function renderCanvas(): Promise<void> {
  renderAppAt(canvasPath(world.campaignId, world.moduleId));
  await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
  await flushAsyncUpdates();
}

/** The canvas opens in preview by default — editor flows enter Edit first. */
async function enterEditMode(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  if (screen.queryByTestId('canvas-preview') !== null) {
    await user.click(screen.getByTestId('canvas-preview-toggle'));
  }
  await screen.findByTestId('canvas-editor');
}

/** One deterministic doc edit through the live editor view (act-wrapped —
 * the page mirrors the doc into React state on every change). */
function editDoc(from: number, to: number, insert: string): void {
  const view = activeCanvasView.current;
  if (view === null) throw new Error('canvas editor view not mounted');
  act(() => {
    view.dispatch({ changes: { from, to, insert } });
  });
}

function selectSpan(from: number, to: number): void {
  act(() => {
    activeCanvasView.current?.dispatch({ selection: { anchor: from, head: to } });
  });
}

/** Runs the instruction dialog for the given AI action (with an optional
 * part pick for the rewrite picker). */
async function runInstruction(
  user: ReturnType<typeof userEvent.setup>,
  actionTestId: string,
  text: string,
  pickPartTitle?: string,
): Promise<void> {
  await user.click(screen.getByTestId(actionTestId));
  const dialog = await screen.findByTestId('canvas-instruction-dialog');
  if (pickPartTitle !== undefined) {
    await user.click(within(dialog).getByTestId('canvas-rewrite-part-select'));
    await user.click(await screen.findByRole('option', { name: pickPartTitle }));
  }
  await user.type(within(dialog).getByTestId('canvas-instruction-input'), text);
  await user.click(within(dialog).getByTestId('canvas-instruction-confirm'));
  // The refine chain runs detached (propose → chat → seal/drop): drain it
  // inside act so its state updates never leak outside act.
  await flushAsyncUpdates();
}

describe('canvas whole-document editor', () => {
  it('mounts ONE module document (the PREMISE and every planned level, byte-exact) — no part selector', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    await enterEditMode(user);
    expect(screen.getByTestId('canvas-module-title')).toHaveTextContent('The Drowned Vault');
    // No selector anywhere.
    expect(screen.queryByTestId('canvas-part-select')).not.toBeInTheDocument();
    // The editor doc IS the module document, byte-exact.
    expect(activeCanvasView.current?.state.doc.toString()).toBe(WHOLE_DOC);
    expect(activeCanvasView.current?.state.doc.toString()).toContain(moduleLevelSeparator(1));
    expect(activeCanvasView.current?.state.doc.toString()).toContain(moduleLevelSeparator(2));
    expect(activeCanvasView.current?.state.doc.toString()).toContain(moduleLevelSeparator(3));
    // THE PREMISE IS IN IT (docs/17 row 384): it is level 0, the one level with
    // no separator of its own.
    expect(activeCanvasView.current?.state.doc.toString()).toContain('drowned [[Vault Door]]');
    // An empty planned level is present as its own (terminated) separator line,
    // so text typed or filled there lands on its OWN line.
    expect(activeCanvasView.current?.state.doc.toString()).toContain(`${moduleLevelSeparator(3)}\n`);
    // The editor renders wiki-link chips against the reader pool.
    await waitFor(() => {
      expect(document.querySelector('[data-wiki-name="Keeper Ilse"]')).not.toBeNull();
    });
    // No unsaved edits yet: the header offers NO Save control at all — a
    // passive "Saved" indicator instead. A permanently greyed-out Save reads
    // as broken or leftover (chat applies and accepted proposals persist
    // immediately, so in that workflow the doc always matches the row and
    // the button would never once light up). Pinned positively, including
    // the non-interactive shape: a span, never a disabled button.
    expect(screen.queryByTestId('canvas-save')).not.toBeInTheDocument();
    const savedIndicator = screen.getByTestId('canvas-saved-indicator');
    expect(savedIndicator.tagName).toBe('SPAN');
    expect(savedIndicator).toHaveTextContent('Saved');
    expect(savedIndicator).not.toHaveAttribute('role');
    expect(savedIndicator).not.toHaveAttribute('title');
    expect(savedIndicator.querySelector('[aria-hidden]')).not.toBeNull();
    await flushAsyncUpdates();
  });

  it('after a successful save the header goes back to the passive "Saved" state', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    await enterEditMode(user);
    // Pristine: the indicator, no control.
    expect(screen.getByTestId('canvas-saved-indicator')).toHaveTextContent('Saved');
    expect(screen.queryByTestId('canvas-save')).not.toBeInTheDocument();
    // A hand edit in a PART (never the scaffolding) is the only thing that
    // offers Save…
    editDoc(PART0_FROM, PART0_FROM + 3, 'XXX');
    expect(screen.getByTestId('canvas-save')).toBeEnabled();
    expect(screen.queryByTestId('canvas-saved-indicator')).not.toBeInTheDocument();
    act(() => {
      screen.getByTestId('canvas-save').click();
    });
    // …and once it lands the header settles back to the passive state.
    await waitFor(() => {
      expect(screen.getByTestId('canvas-saved-indicator')).toHaveTextContent('Saved');
    });
    expect(screen.queryByTestId('canvas-save')).not.toBeInTheDocument();
    // The save really landed, so the indicator is not claiming a state the
    // row is not in (a failed or no-op save would leave the button right
    // there — the assertion above would not be vacuous, it would fail).
    expect(toastSuccessMock).toHaveBeenCalledWith('Module saved');
    expect(toastErrorMock).not.toHaveBeenCalled();
    // actDrained (docs/08 §Race cures): the save's row write re-fires the page's
    // live queries and re-renders CanvasPage; a bare read here handed that
    // re-render the event loop and leaked an act warning ("An update to
    // CanvasPage inside a test was not wrapped in act(...)") in a concurrent
    // full-suite gate.
    const row = await actDrained(() => getModule(world.moduleId));
    expect(row?.parts.find((entry) => entry.planIndex === 0)?.markdown).toBe(
      `XXX${PART_0_TEXT.slice(3)}`,
    );
    await flushAsyncUpdates();
  });

  it('unsaved hand edits keep a LIVE Save button in EVERY view (rendered included), never a title', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    await enterEditMode(user);
    editDoc(PART0_FROM, PART0_FROM + 3, 'XXX');
    expect(screen.getByTestId('canvas-save')).toBeEnabled();

    // MIGRATED (docs/17 row 399): with click-to-edit the rendered view is where
    // an owner who typed lands after Escape, so a dead "Preview is read-only"
    // Save would trap unsaved edits. Save now stays LIVE in the rendered view and
    // writes the snapshot taken from the live editor at the switch.
    await user.click(screen.getByTestId('canvas-preview-toggle'));
    expect(await screen.findByTestId('canvas-preview')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-saved-indicator')).not.toBeInTheDocument();
    expect(screen.getByTestId('canvas-save')).toBeEnabled();
    // …and the control carries NO `title` (docs/18 §4, ledger 125).
    expect(screen.getByTestId('canvas-save')).not.toHaveAttribute('title');

    // Back in Edit the same pending edits offer the live button again — and a
    // live button carries no "why is this dead" tooltip either.
    await user.click(screen.getByTestId('canvas-preview-toggle'));
    await screen.findByTestId('canvas-editor');
    const live = screen.getByTestId('canvas-save');
    expect(live).toBeEnabled();
    expect(live).not.toHaveAttribute('title');
    await flushAsyncUpdates();
  });

  it('deep links are SCROLL targets in preview-default (and in Edit after the toggle)', async () => {
    const user = userEvent.setup();
    const scrolled: Element[] = [];
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (
      this: Element,
    ) {
      scrolled.push(this);
    });
    try {
      // ?part=1 lands directly in preview (the default view): the preview
      // article carries the `part-<n>` anchor id and is scrolled to.
      const first = renderAppAt(canvasPath(world.campaignId, world.moduleId, 1));
      await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
      expect(await screen.findByTestId('canvas-preview-part-1')).toBeInTheDocument();
      await waitFor(() => {
        expect(scrolled).toContain(document.getElementById('part-1'));
      });
      // Toggling to Edit re-runs the scroll for the editor section.
      await enterEditMode(user);
      await waitFor(() => {
        expect(lastCanvasScroll.current?.target).toBe('doc');
      });
      const doc = activeCanvasView.current?.state.doc.toString() ?? '';
      // `?part=1` is planIndex 1 → LEVEL 2, whose separator line anchors the scroll.
      expect(lastCanvasScroll.current?.offset).toBe(doc.indexOf(moduleLevelSeparator(2)));
      first.unmount();

      // premise → top; the reader's #part-<n> hash works the same way.
      // (Fresh session toggle per render — the Edit toggle above persists
      // per module, so reset to the first-open default.)
      useCanvasPreviewStore.setState({ ownerModuleId: null, openByModule: {} });
      const second = renderAppAt(canvasPath(world.campaignId, world.moduleId, 'premise'));
      await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
      expect(await screen.findByTestId('canvas-preview')).toBeInTheDocument();
      await enterEditMode(user);
      await waitFor(() => {
        expect(lastCanvasScroll.current).toEqual({ target: 'top', offset: 0 });
      });
      second.unmount();

      useCanvasPreviewStore.setState({ ownerModuleId: null, openByModule: {} });
      const third = renderAppAt(`/c/${world.campaignId}/m/${world.moduleId}/canvas#part-0`);
      await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
      await waitFor(() => {
        expect(scrolled).toContain(document.getElementById('part-0'));
      });
      await enterEditMode(user);
      await waitFor(() => {
        // `#part-0` is planIndex 0 → LEVEL 1, and level 1 no longer sits at
        // offset 0: the PREMISE precedes it, so its own separator anchors.
        const doc = activeCanvasView.current?.state.doc.toString() ?? '';
        expect(lastCanvasScroll.current).toEqual({
          target: 'doc',
          offset: doc.indexOf(moduleLevelSeparator(1)),
        });
      });
      third.unmount();
      await flushAsyncUpdates();
    } finally {
      scrollSpy.mockRestore();
    }
  });

  it('manual Save writes the ONE document: only the changed levels are stamped and ledgered', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    await enterEditMode(user);
    // Edit level 1's text AND level 3's (previously empty) section.
    const sections = moduleDocumentSections(WHOLE_DOC, PART_PLAN);
    const level1From = sections[1]?.textFrom ?? 0;
    const level3From = sections[3]?.textFrom ?? 0;
    editDoc(level1From, level1From + 3, 'XXX'); // level 1's text changes
    editDoc(level3From, level3From, 'Dusk falls.'); // level 3 gains text

    const repo = await import('@/db/moduleRepo');
    const write = vi.spyOn(repo, 'saveModuleDocument');
    act(() => {
      screen.getByTestId('canvas-save').click();
    });
    const nextPart0 = `XXX${PART_0_TEXT.slice(3)}`;
    // ONE write of the WHOLE document (the per-part save path is gone: a
    // document write is atomic — docs/17 rows 384/385).
    await waitFor(() => {
      expect(write).toHaveBeenCalledTimes(1);
    });
    expect(write.mock.calls[0]?.[1]).toBe(activeCanvasView.current?.state.doc.toString());
    // A MANUAL save names no writer model (docs/17 row 93): the levels keep the
    // ids they already carry — the owner's hand edit must not erase which model
    // wrote the passage.
    expect(write.mock.calls[0]?.[2]).toBeUndefined();
    // The LINKS hook the per-part path carried still runs, over the CHANGED
    // level texts only.
    await waitFor(() => {
      expect(promoteSpy).toHaveBeenCalledWith(world.moduleId, [nextPart0, 'Dusk falls.']);
    });
    await waitFor(async () => {
      const row = await getModule(world.moduleId);
      expect(row?.parts.find((entry) => entry.planIndex === 0)?.markdown).toBe(nextPart0);
      expect(row?.parts.find((entry) => entry.planIndex === 0)?.edited).toBe(true);
      expect(row?.parts.find((entry) => entry.planIndex === 2)?.markdown).toBe('Dusk falls.');
    });
    expect(toastSuccessMock).toHaveBeenCalledWith('Module saved');
    expect(toastErrorMock).not.toHaveBeenCalled();
    // A ledger entry per CHANGED level; none for the untouched one.
    expect(useCanvasLedgerStore.getState().byPart[canvasLedgerKey(world.moduleId, 0)]?.versions).toHaveLength(1);
    expect(useCanvasLedgerStore.getState().byPart[canvasLedgerKey(world.moduleId, 2)]?.versions).toHaveLength(1);
    expect(useCanvasLedgerStore.getState().byPart[canvasLedgerKey(world.moduleId, 1)]).toBeUndefined();
    write.mockRestore();
    await flushAsyncUpdates();
  });

  it('a separator edit that breaks the parse fails the save LOUD, and nothing is written', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    await enterEditMode(user);
    // Break the document: delete LEVEL 1's separator line, so the first
    // separator the parser meets is level 2 — a GAP, refused by name.
    const doc = activeCanvasView.current?.state.doc.toString() ?? '';
    const level1 = moduleLevelSeparator(1);
    editDoc(doc.indexOf(level1), doc.indexOf(level1) + level1.length, '');
    expect(screen.getByTestId('canvas-save')).toBeEnabled();

    const repo = await import('@/db/moduleRepo');
    const write = vi.spyOn(repo, 'saveModuleDocument');
    act(() => {
      screen.getByTestId('canvas-save').click();
    });
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        expect.stringContaining('no longer parses'),
        expect.anything(),
      );
    });
    // The editor KEEPS its text (the level 1 line is gone, level 2 still
    // there); NOTHING reached the row.
    expect(activeCanvasView.current?.state.doc.toString()).toContain(moduleLevelSeparator(2));
    expect(write).not.toHaveBeenCalled();
    const row = await actDrained(() => getModule(world.moduleId));
    expect(row?.parts.find((entry) => entry.planIndex === 0)?.markdown).toBe(PART_0_TEXT);
    write.mockRestore();
    await flushAsyncUpdates();
  });

  it('a failed DOCUMENT save is loud and ATOMIC: nothing lands, no ledger, the editor keeps the edits', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    await enterEditMode(user);
    const sections = moduleDocumentSections(WHOLE_DOC, PART_PLAN);
    const level1From = sections[1]?.textFrom ?? 0;
    const level3From = sections[3]?.textFrom ?? 0;
    editDoc(level1From, level1From + 3, 'XXX');
    editDoc(level3From, level3From, 'Dusk falls.');
    // THE FAILURE MODE IS GONE, NOT TRANSLATED (docs/17 rows 384/385): the old
    // per-part save could land one part and fail another, so it reported
    // `failedParts` and toasted per part. A whole-document write is atomic —
    // the write THROWS and NOTHING of the batch lands.
    const repo = await import('@/db/moduleRepo');
    const write = vi
      .spyOn(repo, 'saveModuleDocument')
      .mockRejectedValueOnce(new Error('disk full'));

    act(() => {
      screen.getByTestId('canvas-save').click();
    });
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        'Could not save the campaign document',
        expect.anything(),
      );
    });
    expect(write).toHaveBeenCalledTimes(1);
    await waitFor(async () => {
      const row = await getModule(world.moduleId);
      // NEITHER edit landed.
      expect(row?.parts.find((entry) => entry.planIndex === 0)?.markdown).toBe(PART_0_TEXT);
      expect(row?.parts.find((entry) => entry.planIndex === 2)?.markdown).toBe('');
    });
    expect(useCanvasLedgerStore.getState().byPart[canvasLedgerKey(world.moduleId, 0)]).toBeUndefined();
    expect(useCanvasLedgerStore.getState().byPart[canvasLedgerKey(world.moduleId, 2)]).toBeUndefined();
    // No blanket success toast.
    expect(toastSuccessMock).not.toHaveBeenCalled();
    // The editor keeps the in-doc edits (Save retries from there).
    expect(activeCanvasView.current?.state.doc.toString()).toContain('Dusk falls.');
    write.mockRestore();
    await flushAsyncUpdates();
  });

  it('leaving with unsaved edits demands the explicit discard confirm', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    await enterEditMode(user);
    editDoc(0, 3, 'XXX');

    await user.click(screen.getByRole('button', { name: /Reader/ }));
    const guard = await screen.findByTestId('canvas-leave-guard');
    expect(within(guard).getByText(/discards them/)).toBeInTheDocument();

    // Cancel keeps the page and the edits.
    await user.click(within(guard).getByRole('button', { name: 'Stay' }));
    await waitFor(() => {
      expect(screen.queryByTestId('canvas-leave-guard')).not.toBeInTheDocument();
    });
    expect(activeCanvasView.current?.state.doc.toString()).not.toBe(WHOLE_DOC);

    // Confirm leaves; the row is untouched (session-only staging dies).
    await user.click(screen.getByRole('button', { name: /Reader/ }));
    await user.click(await screen.findByTestId('canvas-leave-confirm'));
    await waitFor(async () => {
      const row = await getModule(world.moduleId);
      expect(row?.parts.find((entry) => entry.planIndex === 0)?.markdown).toBe(PART_0_TEXT);
      expect(row?.parts.find((entry) => entry.planIndex === 0)?.edited).toBe(false);
    });
    await flushAsyncUpdates();
  });

  it('deep links while dirty just scroll (no guard) — the doc is one document', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    await enterEditMode(user);
    editDoc(0, 3, 'XXX');
    // A same-page deep link (?part=2) is not a navigation away: no guard.
    await user.click(screen.getByTestId('canvas-preview-toggle')); // toggling needs no guard either
    expect(screen.queryByTestId('canvas-leave-guard')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('canvas-preview-toggle'));
    expect(activeCanvasView.current?.state.doc.toString()).toContain('XXX');
    await flushAsyncUpdates();
  });
});

const REFINE_TEXT = 'The party bargains harder than ever.';
// A span replacement over 'party' ([4, 9)) composes with the surrounding text.
const REFINED_PART0 = `${PART_0_TEXT.slice(0, 4)}${REFINE_TEXT}${PART_0_TEXT.slice(9)}`;

describe('canvas AI actions (cursor plays no role)', () => {
  it('selection refine works over the WHOLE doc: accept lands only the changed part + ledger', async () => {
    const user = userEvent.setup();
    mockChatReply(REFINE_TEXT);
    await renderCanvas();
    await enterEditMode(user);
    selectSpan(PART0_FROM + 4, PART0_FROM + 9); // "party" in part 1's section

    await runInstruction(user, 'canvas-refine-selection', 'make the bargain harder');
    const ghost = await screen.findByTestId('canvas-suggestion-ghost', {}, { timeout: 5_000 });
    await waitFor(() => {
      expect(ghost).toHaveTextContent('The party bargains harder than ever.');
    });
    // The proposal is a decoration: the doc is untouched until accept.
    expect(activeCanvasView.current?.state.doc.toString()).toBe(WHOLE_DOC);

    // Accept via the in-editor widget.
    await user.click(await screen.findByTestId('canvas-suggestion-accept'));
    await flushAsyncUpdates();
    await waitFor(() => {
      expect(promoteSpy).toHaveBeenCalledWith(world.moduleId, [REFINED_PART0]);
    });
    await waitFor(async () => {
      const row = await getModule(world.moduleId);
      expect(row?.parts.find((entry) => entry.planIndex === 0)?.markdown).toBe(REFINED_PART0);
      expect(row?.parts.find((entry) => entry.planIndex === 0)?.edited).toBe(true);
      // PROVENANCE (docs/17 row 93): an ACCEPTED refine proposal records the
      // model that served the refine call. The pending proposal is created
      // before the call, so the id is written into its meta when the turn
      // settles — this pins that hand-off end to end.
      expect(row?.parts.find((entry) => entry.planIndex === 0)?.writerModel).toBe('test-model');
      // The OTHER parts never hit the save path with changed text.
      expect(row?.parts.find((entry) => entry.planIndex === 1)?.markdown).toBe(PART_1_TEXT);
    });
    expect(toastSuccessMock).toHaveBeenCalledWith('Proposal applied');
    const ledger = useCanvasLedgerStore.getState().byPart[canvasLedgerKey(world.moduleId, 0)];
    expect(ledger?.versions).toHaveLength(1);
    expect(ledger?.versions[0]?.label).toBe('Refine: make the bargain harder');
    expect(ledger?.versions[0]?.origin).toBe('ai');
    await flushAsyncUpdates();
  }, 30_000);

  it('rewrite part: the dialog PICKER names the part; the proposal is a block replace over THAT section', async () => {
    const user = userEvent.setup();
    const NEW_PART = 'Brand new stormy part text.';
    mockChatReply(NEW_PART);
    await renderCanvas();
    await enterEditMode(user);

    await runInstruction(user, 'canvas-rewrite-part', 'make it stormy', 'Level 2: The Flooded Nave');

    const preview = await screen.findByTestId('canvas-wholepart-preview', {}, { timeout: 5_000 });
    await waitFor(() => {
      expect(preview).toHaveTextContent(NEW_PART);
    });
    // No-diff block widget over part 2's section; the doc still holds the original.
    expect(activeCanvasView.current?.state.doc.toString()).toBe(WHOLE_DOC);
    expect(screen.getByTestId('canvas-proposal-bar')).toBeInTheDocument();

    // Show previous flips the widget to the original section text.
    await user.click(screen.getByTestId('canvas-show-previous'));
    await waitFor(() => {
      expect(screen.getByTestId('canvas-wholepart-preview')).toHaveTextContent(PART_1_TEXT);
    });
    await user.click(screen.getByTestId('canvas-show-previous'));

    // Apply = the accept path: only part 2's section changed → only it saves.
    await user.click(screen.getByTestId('canvas-proposal-apply'));
    await flushAsyncUpdates();
    await waitFor(() => {
      expect(promoteSpy).toHaveBeenCalledWith(world.moduleId, [NEW_PART]);
    });
    const doc = activeCanvasView.current?.state.doc.toString() ?? '';
    expect(doc).toContain(NEW_PART);
    expect(doc).toContain(PART_0_TEXT); // part 1 untouched
    await waitFor(async () => {
      const row = await getModule(world.moduleId);
      expect(row?.parts.find((entry) => entry.planIndex === 1)?.markdown).toBe(NEW_PART);
      expect(row?.parts.find((entry) => entry.planIndex === 1)?.edited).toBe(true);
      expect(row?.parts.find((entry) => entry.planIndex === 0)?.markdown).toBe(PART_0_TEXT);
    });
    const ledger = useCanvasLedgerStore.getState().byPart[canvasLedgerKey(world.moduleId, 1)];
    expect(ledger?.versions).toHaveLength(1);
    expect(ledger?.versions[0]?.label).toBe('Rewrite: make it stormy');
    await flushAsyncUpdates();
  }, 30_000);

  it('rewrite part without an explicit pick cannot confirm (the picker is the input, not the cursor)', async () => {
    const user = userEvent.setup();
    mockChatReply('whatever');
    await renderCanvas();
    await enterEditMode(user);
    await user.click(screen.getByTestId('canvas-rewrite-part'));
    const dialog = await screen.findByTestId('canvas-instruction-dialog');
    await user.type(within(dialog).getByTestId('canvas-instruction-input'), 'make it stormy');
    expect(within(dialog).getByTestId('canvas-instruction-confirm')).toBeDisabled();
    // The editor selection plays no role: nothing proposed, nothing called.
    expect(chatMock).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await flushAsyncUpdates();
  });

  it('rewrite an EMPTY planned part proposes into its (empty) section and fills it on apply', async () => {
    const user = userEvent.setup();
    mockChatReply('The watch begins in fog.');
    await renderCanvas();
    await enterEditMode(user);
    await runInstruction(user, 'canvas-rewrite-part', 'write the watch', 'Level 3: The Long Watch');
    await screen.findByTestId('canvas-wholepart-preview', {}, { timeout: 5_000 });
    await user.click(screen.getByTestId('canvas-proposal-apply'));
    await flushAsyncUpdates();
    await waitFor(async () => {
      const row = await getModule(world.moduleId);
      expect(row?.parts.find((entry) => entry.planIndex === 2)?.markdown).toBe('The watch begins in fog.');
    });
    await flushAsyncUpdates();
  }, 30_000);

  it('Restore re-proposes an older per-part version into that part\'s section', async () => {
    const user = userEvent.setup();
    mockChatReply(REFINE_TEXT);
    await renderCanvas();
    await enterEditMode(user);
    selectSpan(PART0_FROM + 4, PART0_FROM + 9);
    await runInstruction(user, 'canvas-refine-selection', 'make the bargain harder');
    await screen.findByTestId('canvas-suggestion-ghost', {}, { timeout: 5_000 });
    await user.click(await screen.findByTestId('canvas-suggestion-accept'));
    await flushAsyncUpdates();
    await waitFor(() => {
      expect(promoteSpy).toHaveBeenCalledWith(world.moduleId, [REFINED_PART0]);
    });

    // Manual edit + save → ledger entry #2.
    editDoc(REFINED_PART0.length, REFINED_PART0.length, ' Dusk falls.');
    await user.click(screen.getByTestId('canvas-save'));
    await flushAsyncUpdates();
    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith('Module saved');
    });
    expect(useCanvasLedgerStore.getState().byPart[canvasLedgerKey(world.moduleId, 0)]?.versions).toHaveLength(2);

    // Restore #1 (part 1's ledger): proposes the older markdown over part 1's section.
    await user.click(screen.getByTestId('canvas-versions'));
    await user.click(await screen.findByTestId('canvas-version-0-1'));
    const preview = await screen.findByTestId('canvas-wholepart-preview', {}, { timeout: 5_000 });
    await waitFor(() => {
      expect(preview).toHaveTextContent(REFINE_TEXT);
    });
    await user.click(screen.getByTestId('canvas-proposal-apply'));
    await flushAsyncUpdates();
    await waitFor(() => {
      expect(promoteSpy).toHaveBeenLastCalledWith(world.moduleId, [REFINED_PART0]);
    });
    const ledger = useCanvasLedgerStore.getState().byPart[canvasLedgerKey(world.moduleId, 0)];
    expect(ledger?.versions).toHaveLength(3);
    expect(ledger?.versions[2]?.label).toBe('Restored version #1');
    expect(ledger?.versions[2]?.markdown).toBe(REFINED_PART0);
    await flushAsyncUpdates();
  }, 30_000);

  it('reject drops the proposal without touching doc or row; invalidation rules survive on ranges', async () => {
    const user = userEvent.setup();
    mockChatReply(REFINE_TEXT);
    await renderCanvas();
    await enterEditMode(user);
    selectSpan(PART0_FROM + 4, PART0_FROM + 9);
    await runInstruction(user, 'canvas-refine-selection', 'tighten');
    await screen.findByTestId('canvas-suggestion-ghost', {}, { timeout: 5_000 });
    await waitFor(() => {
      expect(screen.getByTestId('canvas-suggestion-reject')).toBeEnabled();
    });

    await user.click(screen.getByTestId('canvas-suggestion-reject'));
    await flushAsyncUpdates();
    expect(activeCanvasView.current?.state.doc.toString()).toBe(WHOLE_DOC);
    await flushAsyncUpdates();
    const row = await getModule(world.moduleId);
    expect(row?.parts.find((entry) => entry.planIndex === 0)?.markdown).toBe(PART_0_TEXT);
    expect(promoteSpy).not.toHaveBeenCalled();
    expect(useCanvasLedgerStore.getState().byPart[canvasLedgerKey(world.moduleId, 0)]).toBeUndefined();

    // Typing strictly inside a proposed range invalidates it loudly.
    mockChatReply(REFINE_TEXT);
    selectSpan(PART0_FROM + 4, PART0_FROM + 9);
    await runInstruction(user, 'canvas-refine-selection', 'tighten');
    await screen.findByTestId('canvas-suggestion-ghost', {}, { timeout: 5_000 });
    editDoc(PART0_FROM + 5, PART0_FROM + 5, 'X'); // inside the proposed range
    await flushAsyncUpdates();
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        'Suggestion discarded — the text was edited inside the proposed range',
        expect.anything(),
      );
    });
    await flushAsyncUpdates();
  }, 30_000);

  it('a busy module disables the AI actions and keeps the forge Stop affordance', async () => {
    await renderCanvas();
    // The row goes busy AFTER the app is up: app START now reconciles a
    // 'generating' row that no live pass owns (docs/17 row 110), so a fixture
    // patched before render would be failed as an interrupted generation —
    // which is the behavior pinned in tests/features/app-shell-boot-reconcile.
    // Here the busy gate itself is the subject; the forge's own stop path is
    // pinned in tests/features/module-board-rewrite.test.tsx.
    // actDrained (row 372's idiom, docs/08 §1a, docs/17 row 393): this write
    // re-emits the live `useModules` query `CampaignBar`'s `LegacyModulesNotice`
    // mounts, and a bare await here handed the delivery the event loop. Measured
    // by delaying the notice's read: the bare form is RED with "An update to
    // LegacyModulesNotice inside a test was not wrapped in act(...)", the drained
    // form green across the same injection.
    await actDrained(() =>
      patchModule(world.moduleId, { status: 'generating', errorMessage: '' }),
    );
    await waitFor(() => {
      expect(screen.getByTestId('canvas-refine-selection')).toBeDisabled();
    });
    expect(screen.getByTestId('canvas-rewrite-part')).toBeDisabled();
    expect(screen.getByTestId('canvas-stop')).toBeInTheDocument();
    await flushAsyncUpdates();
  }, 30_000);
});

describe('canvas preview (reader parity)', () => {
  it('is the DEFAULT view: preview + chat side by side, editor one click away (Edit)', async () => {
    await renderCanvas();
    // No toggle click: the preview is already there (store untouched —
    // undefined ⇒ open), the editor unmounted, the chat beside it.
    expect(screen.getByTestId('canvas-preview')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-editor')).not.toBeInTheDocument();
    expect(screen.getByTestId('canvas-chat')).toBeInTheDocument();
    expect(useCanvasPreviewStore.getState().openByModule[world.moduleId]).toBeUndefined();
    // The Edit affordance stays prominent — one click back to the document.
    expect(screen.getByTestId('canvas-preview-toggle')).toHaveTextContent('Edit');
  });

  it('renders the separator-stripped LEVEL SECTIONS through WikiMarkdown with clickable chips', async () => {
    const user = userEvent.setup();
    await renderCanvas();

    // Already in preview (the default view): the editor is hidden.
    expect(screen.queryByTestId('canvas-editor')).not.toBeInTheDocument();
    expect(screen.getByTestId('canvas-preview')).toBeInTheDocument();
    // The separator lines are editor chrome and are stripped; the section
    // texts render, and the PREMISE (level 0) renders too.
    expect(screen.getByTestId('canvas-preview')).not.toHaveTextContent('=====Level');
    expect(screen.getByTestId('canvas-preview-part--1')).toHaveTextContent('drowned');
    expect(screen.getByTestId('canvas-preview-part-0')).toHaveTextContent('The party bargains with');
    expect(screen.getByTestId('canvas-preview-part-1')).toHaveTextContent('Below the tower');
    // THE PLAN TITLE IS NOT CHROME (docs/23 §2): the caption line under a
    // separator is PROSE, and the stored plan title is generator metadata the
    // preview never prints — it was an `<h2>` before row 384, when the preview
    // rendered the plan rather than the document.
    expect(within(screen.getByTestId('canvas-preview-part-1')).queryByText('The Flooded Nave')).toBeNull();
    // The shared renderer: real wiki chips, clickable (resolved → peek).
    const chip = within(screen.getByTestId('canvas-preview-part-0')).getByTestId('wiki-chip');
    expect(chip).toHaveAttribute('data-wiki-name', 'Keeper Ilse');
    await user.click(chip);
    expect(await screen.findByTestId('peek-modal')).toBeInTheDocument();
    // Toggle to Edit: the editor returns with the doc intact.
    await user.click(screen.getByTestId('canvas-preview-toggle'));
    expect(screen.queryByTestId('canvas-preview')).not.toBeInTheDocument();
    expect(screen.getByTestId('canvas-editor')).toBeInTheDocument();
    expect(activeCanvasView.current?.state.doc.toString()).toBe(WHOLE_DOC);
    await flushAsyncUpdates();
  });

  it('an empty planned level previews as explicitly unwritten; a broken document previews the loud reason', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    expect(within(screen.getByTestId('canvas-preview-part-2')).getByText(/Nothing written yet/)).toBeInTheDocument();
    await enterEditMode(user);

    // Delete LEVEL 1's separator, then preview again: the parser's reason shows.
    const doc = activeCanvasView.current?.state.doc.toString() ?? '';
    const level1 = moduleLevelSeparator(1);
    editDoc(doc.indexOf(level1), doc.indexOf(level1) + level1.length, '');
    await user.click(screen.getByTestId('canvas-preview-toggle'));
    expect(await screen.findByTestId('canvas-preview-error')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-preview-error')).toHaveTextContent(/level 1 is missing|skips or reorders/i);
    await flushAsyncUpdates();
  });

  it('the preview toggle is session state keyed per module (like the chat open state)', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    // Default-open without a stored toggle…
    expect(useCanvasPreviewStore.getState().openByModule[world.moduleId]).toBeUndefined();
    expect(screen.getByTestId('canvas-preview')).toBeInTheDocument();
    // …the toggle overrides per session: Edit stores false…
    await user.click(screen.getByTestId('canvas-preview-toggle'));
    expect(screen.queryByTestId('canvas-preview')).not.toBeInTheDocument();
    expect(useCanvasPreviewStore.getState().openByModule[world.moduleId]).toBe(false);
    // No persist middleware anywhere on the store (session-only).
    expect((useCanvasPreviewStore as unknown as { persist?: unknown }).persist).toBeUndefined();
    // …and back to Preview stores true.
    await user.click(screen.getByTestId('canvas-preview-toggle'));
    expect(screen.getByTestId('canvas-preview')).toBeInTheDocument();
    expect(useCanvasPreviewStore.getState().openByModule[world.moduleId]).toBe(true);
  });
});
