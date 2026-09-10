import 'fake-indexeddb/auto';

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
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
  assembleModulePartsDocument,
  splitPartsDocument,
} from '@/domain/modulePartsDocument';
import { clearDatabase } from '../db/helpers';
import { actDrained, flushAsyncUpdates } from '../helpers/flush';
import { activeCanvasView, lastCanvasScroll } from '@/features/modules/canvas/canvasView';
import {
  canvasLedgerKey,
  useCanvasLedgerStore,
} from '@/features/modules/canvas/canvasStore';
import { useCanvasPreviewStore } from '@/features/modules/canvas/previewStore';
import type * as PartTextModule from '@/features/modules/partText';
import { patchModule } from '@/db/moduleRepo';

/**
 * Module canvas — page flows (08-MODULE-DESIGNER §Module canvas, canvas v3):
 * the editor document is the WHOLE module (assembled by the shared
 * assembleModulePartsDocument — no part selector), deep links are SCROLL
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

const { promoteSecondModuleUses } = await import('@/db/artifactAutoPromote');
const promoteSpy = vi.mocked(promoteSecondModuleUses);
const { toastError, toastSuccess } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);
const toastSuccessMock = vi.mocked(toastSuccess);
const { saveModulePartText } = await import('@/features/modules/partText');
const savePartMock = vi.mocked(saveModulePartText);
const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);

const PART_0_TEXT = 'The party bargains with [[Keeper Ilse]] at the gate.';
const PART_1_TEXT = 'Below the tower, the flood rises.';

const PART_PLAN = [
  { title: 'The Gate Bargain', levelBand: '1', synopsis: '', levelUpTrigger: '' },
  { title: 'The Flooded Nave', levelBand: '2', synopsis: '', levelUpTrigger: '' },
  { title: 'The Long Watch', levelBand: '2', synopsis: '', levelUpTrigger: '' },
];

/** The WHOLE-module editor doc the page mounts with (byte-exact pin). */
const WHOLE_DOC = assembleModulePartsDocument({
  partPlan: PART_PLAN,
  parts: [
    { planIndex: 0, markdown: PART_0_TEXT },
    { planIndex: 1, markdown: PART_1_TEXT },
  ],
}).document;

/**
 * Whole-doc offset of part 1's TEXT start (the "party" span the AI-action
 * tests select is `[PART0_FROM + 4, PART0_FROM + 9)` — bare small offsets
 * would land in the `[Part 1 of 3 …]` scaffold label line).
 */
const PART0_FROM = splitPartsDocument(WHOLE_DOC, PART_PLAN)[0]?.textFrom ?? 0;

let world: { campaignId: Id; moduleId: Id } = { campaignId: '', moduleId: '' };

function renderAppAt(path: string): ReturnType<typeof render> {
  window.history.replaceState(null, '', path);
  return render(<RouterProvider router={createAppRouter()} />);
}

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
  it('mounts ONE whole-module document (all planned parts, scaffolding, byte-exact) — no part selector', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    await enterEditMode(user);
    expect(screen.getByTestId('canvas-module-title')).toHaveTextContent('The Drowned Vault');
    // No selector anywhere.
    expect(screen.queryByTestId('canvas-part-select')).not.toBeInTheDocument();
    // The editor doc IS the assembled whole-module document (byte-exact).
    expect(activeCanvasView.current?.state.doc.toString()).toBe(WHOLE_DOC);
    expect(activeCanvasView.current?.state.doc.toString()).toContain('==========');
    expect(activeCanvasView.current?.state.doc.toString()).toContain('[Part 1 of 3 — The Gate Bargain]');
    expect(activeCanvasView.current?.state.doc.toString()).toContain('[Part 3 of 3 — The Long Watch]');
    // The module's own premise stays OUT of the editor document.
    expect(activeCanvasView.current?.state.doc.toString()).not.toContain('drowned [[Vault Door]]');
    // An empty planned part still renders as a labeled empty section.
    expect(activeCanvasView.current?.state.doc.toString()).toContain('[Part 3 of 3 — The Long Watch]\n');
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

  it('unsaved hand edits keep the Save button in EVERY view, and a blocked Save states its reason in title', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    await enterEditMode(user);
    editDoc(PART0_FROM, PART0_FROM + 3, 'XXX');
    expect(screen.getByTestId('canvas-save')).toBeEnabled();

    // Preview only UNMOUNTS the editor — the hand edits are still unsaved, so
    // the button stays (disabled) and says why instead of vanishing or going
    // silently dead.
    await user.click(screen.getByTestId('canvas-preview-toggle'));
    expect(await screen.findByTestId('canvas-preview')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-saved-indicator')).not.toBeInTheDocument();
    const blocked = screen.getByTestId('canvas-save');
    expect(blocked).toBeDisabled();
    expect(blocked).toHaveAttribute(
      'title',
      'Preview is read-only. Switch to Edit (the header toggle) to save your edits.',
    );

    // Back in Edit the same pending edits offer the live button again — and a
    // live button carries no "why is this dead" tooltip.
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
      const label2 = '[Part 2 of 3 — The Flooded Nave]';
      expect(lastCanvasScroll.current?.offset).toBe(doc.indexOf(`\n\n==========\n\n${label2}\n`) + '\n\n==========\n\n'.length);
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
        expect(lastCanvasScroll.current).toEqual({ target: 'doc', offset: 0 });
      });
      third.unmount();
      await flushAsyncUpdates();
    } finally {
      scrollSpy.mockRestore();
    }
  });

  it('manual Save is a split-save: only the parts whose text changed hit the save path', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    await enterEditMode(user);
    // Edit part 1's text AND part 3's (previously empty) section.
    const sections = splitPartsDocument(WHOLE_DOC, PART_PLAN);
    const part0From = sections[0]?.textFrom ?? 0;
    const part2From = sections[2]?.textFrom ?? 0;
    editDoc(part0From, part0From + 3, 'XXX'); // part 1 text changes
    editDoc(part2From, part2From, 'Dusk falls.'); // part 3 gains text

    act(() => {
      screen.getByTestId('canvas-save').click();
    });
    const nextPart0 = `XXX${PART_0_TEXT.slice(3)}`;
    await waitFor(() => {
      expect(savePartMock).toHaveBeenCalledTimes(2);
    });
    // Per-part saves with per-part text — only the two CHANGED parts.
    expect(savePartMock).toHaveBeenCalledWith(world.moduleId, 0, nextPart0);
    expect(savePartMock).toHaveBeenCalledWith(world.moduleId, 2, 'Dusk falls.');
    await waitFor(() => {
      expect(promoteSpy).toHaveBeenCalled();
    });
    await waitFor(async () => {
      const row = await getModule(world.moduleId);
      expect(row?.parts.find((entry) => entry.planIndex === 0)?.markdown).toBe(nextPart0);
      expect(row?.parts.find((entry) => entry.planIndex === 0)?.edited).toBe(true);
      expect(row?.parts.find((entry) => entry.planIndex === 2)?.markdown).toBe('Dusk falls.');
    });
    expect(toastSuccessMock).toHaveBeenCalledWith('Module saved');
    expect(toastErrorMock).not.toHaveBeenCalled();
    // A per-part ledger entry per changed part.
    expect(useCanvasLedgerStore.getState().byPart[canvasLedgerKey(world.moduleId, 0)]?.versions).toHaveLength(1);
    expect(useCanvasLedgerStore.getState().byPart[canvasLedgerKey(world.moduleId, 2)]?.versions).toHaveLength(1);
    expect(useCanvasLedgerStore.getState().byPart[canvasLedgerKey(world.moduleId, 1)]).toBeUndefined();
    await flushAsyncUpdates();
  });

  it('an unchanged empty section saves nothing; scaffolding edits that break the parse fail the save LOUD', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    await enterEditMode(user);
    // Break the scaffolding: remove the first delimiter line.
    const doc = activeCanvasView.current?.state.doc.toString() ?? '';
    const firstDelimiter = doc.indexOf('\n\n==========\n\n');
    editDoc(firstDelimiter, firstDelimiter + '\n\n==========\n\n'.length, '\n\n');
    expect(screen.getByTestId('canvas-save')).toBeEnabled();

    act(() => {
      screen.getByTestId('canvas-save').click();
    });
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        expect.stringContaining('scaffolding no longer parses'),
        expect.anything(),
      );
    });
    // The editor KEEPS the text (first delimiter gone, second still there —
    // the doc no longer parses); the row is untouched.
    expect(activeCanvasView.current?.state.doc.toString()).toContain(
      'at the gate.\n\n[Part 2 of 3 — The Flooded Nave]',
    );
    const row = await getModule(world.moduleId);
    expect(row?.parts.find((entry) => entry.planIndex === 0)?.markdown).toBe(PART_0_TEXT);
    expect(savePartMock).not.toHaveBeenCalled();
    await flushAsyncUpdates();
  });

  it('a failed part save is loud per part: toast names the part, the other part lands, ledger reflects reality', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    await enterEditMode(user);
    const sections = splitPartsDocument(WHOLE_DOC, PART_PLAN);
    const part0From = sections[0]?.textFrom ?? 0;
    const part2From = sections[2]?.textFrom ?? 0;
    editDoc(part0From, part0From + 3, 'XXX');
    editDoc(part2From, part2From, 'Dusk falls.');
    // First call (part 0) fails, second (part 3) succeeds.
    savePartMock.mockImplementationOnce(() => Promise.reject(new Error('disk full')));

    act(() => {
      screen.getByTestId('canvas-save').click();
    });
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        expect.stringContaining('The Gate Bargain'),
        expect.anything(),
      );
    });
    await waitFor(async () => {
      const row = await getModule(world.moduleId);
      expect(row?.parts.find((entry) => entry.planIndex === 2)?.markdown).toBe('Dusk falls.');
      expect(row?.parts.find((entry) => entry.planIndex === 0)?.markdown).toBe(PART_0_TEXT);
    });
    // The ledger reflects what actually landed.
    expect(useCanvasLedgerStore.getState().byPart[canvasLedgerKey(world.moduleId, 0)]).toBeUndefined();
    expect(useCanvasLedgerStore.getState().byPart[canvasLedgerKey(world.moduleId, 2)]?.versions).toHaveLength(1);
    // No blanket success toast when a part failed.
    expect(toastSuccessMock).not.toHaveBeenCalled();
    // The editor keeps the in-doc edits (Save retries from there).
    expect(activeCanvasView.current?.state.doc.toString()).toContain('Dusk falls.');
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

    await runInstruction(user, 'canvas-rewrite-part', 'make it stormy', 'Part 2: The Flooded Nave');

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
    await runInstruction(user, 'canvas-rewrite-part', 'write the watch', 'Part 3: The Long Watch');
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
    await patchModule(world.moduleId, { status: 'generating', errorMessage: '' });
    await renderCanvas();
    expect(screen.getByTestId('canvas-refine-selection')).toBeDisabled();
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

  it('renders the scaffolding-stripped parts through WikiMarkdown with clickable chips', async () => {
    const user = userEvent.setup();
    await renderCanvas();

    // Already in preview (the default view): the editor is hidden.
    expect(screen.queryByTestId('canvas-editor')).not.toBeInTheDocument();
    expect(screen.getByTestId('canvas-preview')).toBeInTheDocument();
    // Scaffolding stripped: no delimiter/label chrome, but the part texts render.
    expect(screen.getByTestId('canvas-preview')).not.toHaveTextContent('[Part 1 of 3');
    expect(screen.getByTestId('canvas-preview-part-0')).toHaveTextContent('The party bargains with');
    expect(screen.getByTestId('canvas-preview-part-0')).not.toHaveTextContent('==========');
    expect(screen.getByTestId('canvas-preview-part-1')).toHaveTextContent('Below the tower');
    // Reader headings: the part titles.
    expect(within(screen.getByTestId('canvas-preview-part-1')).getByText('The Flooded Nave')).toBeInTheDocument();
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

  it('an empty planned part previews as explicitly unwritten; a broken scaffolding previews the loud reason', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    expect(within(screen.getByTestId('canvas-preview-part-2')).getByText(/Nothing written yet/)).toBeInTheDocument();
    await enterEditMode(user);

    // Break the scaffolding, then preview again: the splitter's reason shows.
    const doc = activeCanvasView.current?.state.doc.toString() ?? '';
    const firstDelimiter = doc.indexOf('\n\n==========\n\n');
    editDoc(firstDelimiter, firstDelimiter + '\n\n==========\n\n'.length, '\n\n');
    await user.click(screen.getByTestId('canvas-preview-toggle'));
    expect(await screen.findByTestId('canvas-preview-error')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-preview-error')).toHaveTextContent(/separator/i);
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
