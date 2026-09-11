import 'fake-indexeddb/auto';

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
import { canvasPath } from '@/app/routes';
import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { getModule, saveModule } from '@/db/moduleRepo';
import { listModuleVersions } from '@/db/moduleVersionRepo';
import { createModule, modulePartSchema, moduleSpineSchema, type Id } from '@/domain';
import { assembleModulePartsDocument, splitPartsDocument } from '@/domain/modulePartsDocument';
import { activeCanvasView } from '@/features/modules/canvas/canvasView';
import { useCanvasPreviewStore } from '@/features/modules/canvas/previewStore';
import { CROSS_PART_SELECTION_REASON } from '@/features/modules/canvas/CanvasPreview';
import { SOURCE_MAP_REFUSALS } from '@/features/campaign/components/wiki-markdown';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * The canvas AI actions IN THE PREVIEW (docs/17 row 102).
 *
 * The owner's report: "In the module chat, 'refine selection' and 'rewrite
 * part' does not seem to work at all … I would like to make those work again,
 * in the nicely rendered version." The canvas OPENS in that rendered version,
 * and both actions were natively disabled there — so the two most useful chat
 * actions were dead in the view the owner actually works in.
 *
 * What these pins hold:
 * - both actions RUN with the preview open, and they land through the SAME
 *   seam the preview chat uses (split-save + a durable pre-change version),
 *   so the document, the preview and the saved parts all move together;
 * - "Refine selection" takes its span from the RENDERED text: a DOM selection
 *   is mapped back to exact SOURCE offsets, the dialog SHOWS those bytes
 *   before anything runs, and a span that cannot be mapped byte-exactly is
 *   refused BY NAME with nothing written and no AI call;
 * - the model is grounded on markdown SOURCE (the `[[…]]` token, not the chip
 *   label), and the reply lands verbatim;
 * - the old "switch to Edit" copy is gone from the app source.
 *
 * NOT provable here (jsdom has no layout and no real input): that a selection
 * made with a REAL mouse produces these Ranges, and that the highlight paints.
 * The tests build the Ranges a mouse selection produces and drive the pane's
 * own handlers, so the code path is the production one.
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

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { toastError, toastSuccess, toastInfo } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);
const toastSuccessMock = vi.mocked(toastSuccess);
const toastInfoMock = vi.mocked(toastInfo);

const PART_0_TEXT = 'The party bargains with [[Keeper Ilse]] at the gate.';
const PART_1_TEXT = 'Below the tower, the flood rises.';

const PART_PLAN = [
  { title: 'The Gate Bargain', levelBand: '1', synopsis: '', levelUpTrigger: '' },
  { title: 'The Flooded Nave', levelBand: '2', synopsis: '', levelUpTrigger: '' },
];

/** The WHOLE-module editor doc the page mounts with (byte-exact pin). */
const WHOLE_DOC = assembleModulePartsDocument({
  partPlan: PART_PLAN,
  parts: [
    { planIndex: 0, markdown: PART_0_TEXT },
    { planIndex: 1, markdown: PART_1_TEXT },
  ],
}).document;

/** Part 0's text starts here in the whole doc ("party" is [FROM+4, FROM+9)). */
const PART0_FROM = splitPartsDocument(WHOLE_DOC, PART_PLAN)[0]?.textFrom ?? 0;

let world: { campaignId: Id; moduleId: Id } = { campaignId: '', moduleId: '' };

function renderAppAt(path: string): ReturnType<typeof render> {
  window.history.replaceState(null, '', path);
  return render(<RouterProvider router={createAppRouter()} />);
}

async function seedModule(): Promise<void> {
  const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
  // The reader pool behind the preview's RESOLVED wiki chips ([[Keeper Ilse]]).
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
  useCanvasPreviewStore.setState({ ownerModuleId: null, openByModule: {}, selectionByModule: {} });
  await seedModule();
});

/** The mocked chat: streams the JSON reply in two raw content chunks (what the
 * canvasRefine extractor sees from OpenRouter) and settles with the full text. */
function mockChatReply(replacement: string): void {
  chatMock.mockImplementation((_messages, opts) => {
    const raw = JSON.stringify({ replacement });
    const mid = Math.max(1, Math.floor(raw.length / 2));
    opts.onToken?.(raw.slice(0, mid));
    opts.onToken?.(raw.slice(mid));
    return Promise.resolve({ text: raw, modelUsed: 'test-model', fallback: null });
  });
}

/** The canvas opens in preview by default — that IS the state under test. */
async function renderPreview(): Promise<void> {
  renderAppAt(canvasPath(world.campaignId, world.moduleId));
  await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
  await screen.findByTestId('canvas-preview', {}, { timeout: 10_000 });
  await flushAsyncUpdates();
}

/** The mapping root of a preview part (the div carrying the source runs). */
function sourceRoot(planIndex: number): HTMLElement {
  const part = screen.getByTestId(`canvas-preview-part-${String(planIndex)}`);
  const root = part.querySelector<HTMLElement>('[data-canvas-part-source]');
  if (root === null) throw new Error(`preview part ${String(planIndex)} has no source root`);
  return root;
}

/** The source runs (`data-md-from`/`data-md-to` spans) of a preview part. */
function sourceRuns(planIndex: number): HTMLElement[] {
  return Array.from(sourceRoot(planIndex).querySelectorAll<HTMLElement>('[data-md-from]'));
}

/** One source run by position, failing loudly when it is not there. */
function runAt(planIndex: number, index: number): HTMLElement {
  const run = sourceRuns(planIndex)[index];
  if (run === undefined) throw new Error(`part ${String(planIndex)} has no run ${String(index)}`);
  return run;
}

function textNodeOf(element: HTMLElement): Text {
  const node = element.firstChild;
  if (node?.nodeType !== Node.TEXT_NODE) {
    throw new Error('the source run has no leading text node');
  }
  return node as Text;
}

/**
 * A rendered point for a PART-RELATIVE source offset: the text node whose
 * character it is, or the run element at a piece boundary (a chip edge) — the
 * same shapes a real drag over that text produces. Walks the run's pieces the
 * way the mapping does (text nodes; a chip counts as its `data-wiki-raw`
 * token), never geometry (jsdom has none).
 */
function pointOf(planIndex: number, sourceOffset: number): { node: Node; offset: number } {
  const run = sourceRuns(planIndex).find(
    (candidate) =>
      Number(candidate.dataset.mdFrom) <= sourceOffset &&
      sourceOffset <= Number(candidate.dataset.mdTo),
  );
  if (run === undefined) {
    throw new Error(`no source run covers offset ${String(sourceOffset)} in part ${String(planIndex)}`);
  }
  const target = sourceOffset - Number(run.dataset.mdFrom);
  const children = Array.from(run.childNodes);
  let consumed = 0;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child === undefined) break;
    const width =
      child.nodeType === Node.TEXT_NODE
        ? (child.nodeValue ?? '').length
        : (((child as HTMLElement).dataset.wikiRaw ?? '').length);
    if (target < consumed + width) {
      // Strictly inside this piece: a text node offset, or (inside a chip) the
      // chip's own start boundary.
      if (child.nodeType === Node.TEXT_NODE) return { node: child, offset: target - consumed };
      return { node: run, offset: index };
    }
    if (target === consumed + width) {
      // Exactly at this piece's end: the boundary before the NEXT piece (the
      // element-level shape a drag between two words produces).
      return { node: run, offset: index + 1 };
    }
    consumed += width;
  }
  return { node: run, offset: children.length };
}

/** A DOM Range over PART-RELATIVE source offsets `[from, to)` of a preview part. */
function previewRange(planIndex: number, from: number, to: number): Range {
  const start = pointOf(planIndex, from);
  const end = pointOf(planIndex, to);
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

/**
 * Selects source offsets in the preview the way the owner does: the browser
 * selection is set, then the pane's own mouse-release handler runs (jsdom does
 * not emit `selectionchange` for programmatic ranges, and this is the same
 * code path a real drag release takes).
 */
function selectInPreview(planIndex: number, from: number, to: number): void {
  const selection = window.getSelection();
  if (selection === null) throw new Error('jsdom has no Selection');
  selection.removeAllRanges();
  selection.addRange(previewRange(planIndex, from, to));
  fireEvent.mouseUp(screen.getByTestId('canvas-preview'));
}

/** Opens an AI action's dialog in the preview and returns it. */
async function openDialog(
  user: ReturnType<typeof userEvent.setup>,
  actionTestId: string,
): Promise<HTMLElement> {
  await user.click(screen.getByTestId(actionTestId));
  return await screen.findByTestId('canvas-instruction-dialog');
}

async function confirmDialog(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  instruction: string,
): Promise<void> {
  await user.type(within(dialog).getByTestId('canvas-instruction-input'), instruction);
  await user.click(within(dialog).getByTestId('canvas-instruction-confirm'));
  await flushAsyncUpdates();
}

describe('canvas AI actions in the PREVIEW (docs/17 row 102)', () => {
  it('refine selection: the dialog shows the EXACT source span, and confirming lands in the preview AND the document', async () => {
    const user = userEvent.setup();
    mockChatReply('band');
    await renderPreview();
    // Part 0 renders as source runs around the resolved chip.
    expect(sourceRuns(0).length).toBeGreaterThan(0);

    selectInPreview(0, 4, 9); // "party" in part 0's SOURCE
    const dialog = await openDialog(user, 'canvas-refine-selection');
    // The half that makes a rendered selection safe: the SOURCE bytes the
    // action will replace are on screen before anything can run.
    expect(within(dialog).getByTestId('canvas-instruction-source').textContent).toBe('party');
    // A ranged action still needs an instruction: confirm is held until both
    // halves exist, and only then does it run.
    expect(within(dialog).getByTestId('canvas-instruction-confirm')).toBeDisabled();
    await user.type(within(dialog).getByTestId('canvas-instruction-input'), 'call them a band');
    expect(within(dialog).getByTestId('canvas-instruction-confirm')).toBeEnabled();
    await user.click(within(dialog).getByTestId('canvas-instruction-confirm'));
    await flushAsyncUpdates();

    // The preview re-renders from the applied snapshot — and the rendered text
    // is the source text character for character, whitespace included: the
    // wash is a decoration inside ONE parse, never a re-parse of markdown
    // slices (which dropped the whitespace at every seam).
    await waitFor(() => {
      expect(screen.getByTestId('canvas-preview-part-0')).toHaveTextContent(
        'The band bargains with Keeper Ilse at the gate.',
      );
    });
    const wash = within(screen.getByTestId('canvas-preview-part-0')).getByTestId(
      'replacement-highlight',
    );
    expect(wash.textContent).toBe('band');
    // The document (the parts rows) holds the spliced markdown, byte-exact:
    // only the selected span moved, the chip token is untouched.
    const expectedPart0 = `${PART_0_TEXT.slice(0, 4)}band${PART_0_TEXT.slice(9)}`;
    await waitFor(async () => {
      const row = await getModule(world.moduleId);
      expect(row?.parts.find((part) => part.planIndex === 0)?.markdown).toBe(expectedPart0);
      expect(row?.parts.find((part) => part.planIndex === 1)?.markdown).toBe(PART_1_TEXT);
      expect(row?.parts.find((part) => part.planIndex === 0)?.writerModel).toBe('test-model');
    });
    // The durable pre-change snapshot (the undo) is the ORIGINAL document.
    const versions = await listModuleVersions(world.moduleId);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.source).toBe('refine');
    expect(versions[0]?.docText).toBe(WHOLE_DOC);
    expect(toastSuccessMock).toHaveBeenCalledWith('Refinement applied');
    expect(toastErrorMock).not.toHaveBeenCalled();

    // Returning to Edit shows the SAME document — the two views never diverge.
    await user.click(screen.getByTestId('canvas-preview-toggle'));
    await screen.findByTestId('canvas-editor', {}, { timeout: 10_000 });
    const doc = activeCanvasView.current?.state.doc.toString() ?? '';
    expect(doc).toContain(expectedPart0);
    expect(doc).not.toContain(PART_0_TEXT);
    await flushAsyncUpdates();
  }, 30_000);

  it('refine selection with nothing selected: the dialog names the reason, cannot run, and calls no model', async () => {
    const user = userEvent.setup();
    mockChatReply('band');
    await renderPreview();
    // A click on the header button collapses the browser selection — the very
    // state the owner is in most of the time.
    window.getSelection()?.removeAllRanges();

    const dialog = await openDialog(user, 'canvas-refine-selection');
    expect(within(dialog).getByTestId('canvas-instruction-refusal')).toHaveTextContent(
      'Select the text to refine first, then run Refine selection.',
    );
    expect(within(dialog).queryByTestId('canvas-instruction-source')).not.toBeInTheDocument();

    // The instruction can be typed, but confirm is held: no range, no action.
    await user.type(within(dialog).getByTestId('canvas-instruction-input'), 'make it stormy');
    expect(within(dialog).getByTestId('canvas-instruction-confirm')).toBeDisabled();
    expect(chatMock).not.toHaveBeenCalled();
    await flushAsyncUpdates();
  }, 30_000);

  it('a selection inside a wiki chip is refused with the chip reason — the label is never used as the span', async () => {
    const user = userEvent.setup();
    mockChatReply('band');
    await renderPreview();

    // Inside the chip's rendered LABEL ("Keeper…"), not its token.
    const chip = sourceRoot(0).querySelector<HTMLElement>('[data-wiki-raw]');
    if (chip === null) throw new Error('the part has no wiki chip');
    const inner = chip.querySelector('span, button > *');
    const label = (inner ?? chip).firstChild;
    if (label === null) throw new Error('the chip renders no text');
    const range = document.createRange();
    range.setStart(label, 0);
    range.setEnd(label, Math.min(3, (label.nodeValue ?? '').length));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.mouseUp(screen.getByTestId('canvas-preview'));

    const dialog = await openDialog(user, 'canvas-refine-selection');
    expect(within(dialog).getByTestId('canvas-instruction-refusal')).toHaveTextContent(
      SOURCE_MAP_REFUSALS.insideChip,
    );
    await user.type(within(dialog).getByTestId('canvas-instruction-input'), 'make it stormy');
    expect(within(dialog).getByTestId('canvas-instruction-confirm')).toBeDisabled();
    expect(chatMock).not.toHaveBeenCalled();
    await flushAsyncUpdates();
  }, 30_000);

  it('a selection across two parts is refused with the cross-part reason', async () => {
    const user = userEvent.setup();
    mockChatReply('band');
    await renderPreview();

    const range = document.createRange();
    range.setStart(textNodeOf(runAt(0, 0)), 4);
    range.setEnd(textNodeOf(runAt(1, 0)), 5);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.mouseUp(screen.getByTestId('canvas-preview'));

    const dialog = await openDialog(user, 'canvas-refine-selection');
    expect(within(dialog).getByTestId('canvas-instruction-refusal')).toHaveTextContent(
      CROSS_PART_SELECTION_REASON,
    );
    await user.type(within(dialog).getByTestId('canvas-instruction-input'), 'make it stormy');
    expect(within(dialog).getByTestId('canvas-instruction-confirm')).toBeDisabled();
    expect(chatMock).not.toHaveBeenCalled();
    await flushAsyncUpdates();
  }, 30_000);

  it('a capture from an OLDER document (stale) is refused by name and cannot run', async () => {
    const user = userEvent.setup();
    mockChatReply('band');
    await renderPreview();
    // What a chat turn landing after the selection leaves behind: a capture
    // measured in a document that is no longer the one on screen.
    useCanvasPreviewStore
      .getState()
      .setSelection(world.moduleId, {
        kind: 'mapped',
        planIndex: 0,
        from: PART0_FROM + 4,
        to: PART0_FROM + 9,
        doc: 'an older snapshot',
      });

    const dialog = await openDialog(user, 'canvas-refine-selection');
    expect(within(dialog).getByTestId('canvas-instruction-refusal')).toHaveTextContent(
      'The document changed since that selection was made — select the text again.',
    );
    await user.type(within(dialog).getByTestId('canvas-instruction-input'), 'make it stormy');
    expect(within(dialog).getByTestId('canvas-instruction-confirm')).toBeDisabled();
    expect(chatMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalled();
    await flushAsyncUpdates();
  }, 30_000);

  it('rewrite part: the dialog shows the picked part\'s exact source, and the apply lands in the preview AND the document', async () => {
    const user = userEvent.setup();
    const NEW_PART = 'Below the tower, the flood is a wall of black water.';
    mockChatReply(NEW_PART);
    await renderPreview();

    const dialog = await openDialog(user, 'canvas-rewrite-part');
    // Before a part is picked there is nothing to replace, and that is stated.
    expect(within(dialog).getByTestId('canvas-instruction-refusal')).toHaveTextContent(
      'Pick the part to rewrite first.',
    );
    await user.click(within(dialog).getByTestId('canvas-rewrite-part-select'));
    await user.click(await screen.findByRole('option', { name: 'Part 2: The Flooded Nave' }));
    // The picked part's WHOLE source text, byte-exact, is the confirmation the
    // owner reads — no selection is involved anywhere in this action.
    expect(within(dialog).getByTestId('canvas-instruction-source').textContent).toBe(PART_1_TEXT);

    await confirmDialog(user, dialog, 'make the flood a wall');

    await waitFor(() => {
      expect(screen.getByTestId('canvas-preview-part-1')).toHaveTextContent(NEW_PART);
    });
    // Part 0 is untouched in the preview and in the rows.
    expect(screen.getByTestId('canvas-preview-part-0')).toHaveTextContent(
      'The party bargains with Keeper Ilse at the gate.',
    );
    await waitFor(async () => {
      const row = await getModule(world.moduleId);
      expect(row?.parts.find((part) => part.planIndex === 1)?.markdown).toBe(NEW_PART);
      expect(row?.parts.find((part) => part.planIndex === 0)?.markdown).toBe(PART_0_TEXT);
    });
    const versions = await listModuleVersions(world.moduleId);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.source).toBe('rewrite');
    expect(versions[0]?.docText).toBe(WHOLE_DOC);
    expect(toastSuccessMock).toHaveBeenCalledWith('Rewrite applied');

    await user.click(screen.getByTestId('canvas-preview-toggle'));
    await screen.findByTestId('canvas-editor', {}, { timeout: 10_000 });
    const doc = activeCanvasView.current?.state.doc.toString() ?? '';
    expect(doc).toContain(NEW_PART);
    expect(doc).toContain(PART_0_TEXT);
    expect(doc).not.toContain(PART_1_TEXT);
    await flushAsyncUpdates();
  }, 30_000);

  it('the model is grounded on the SOURCE markdown — the [[…]] token, never the chip label', async () => {
    const user = userEvent.setup();
    mockChatReply('band');
    await renderPreview();
    // Cover the chip: the resolved chip renders the LABEL "Keeper Ilse" while
    // the source there is the token `[[Keeper Ilse]]`.
    selectInPreview(0, 4, PART_0_TEXT.length);

    const dialog = await openDialog(user, 'canvas-refine-selection');
    expect(within(dialog).getByTestId('canvas-instruction-source').textContent).toBe(
      PART_0_TEXT.slice(4),
    );
    await confirmDialog(user, dialog, 'call them a band');

    const messages = chatMock.mock.calls[0]?.[0] ?? [];
    const sent = messages
      .map((message) => (typeof message.content === 'string' ? message.content : ''))
      .join('\n');
    expect(sent).toContain('[[Keeper Ilse]] at the gate.');
    // The reply lands in the document VERBATIM — tokens are neither protected
    // nor restored, exactly as in Edit (docs/17 row 102).
    const expectedPart0 = `${PART_0_TEXT.slice(0, 4)}band`;
    await waitFor(async () => {
      const row = await getModule(world.moduleId);
      expect(row?.parts.find((part) => part.planIndex === 0)?.markdown).toBe(expectedPart0);
    });
    expect(toastErrorMock).not.toHaveBeenCalled();
    await flushAsyncUpdates();
  }, 30_000);

  it('Stop while a preview refine is in flight writes nothing (and the preview says it is working)', async () => {
    const user = userEvent.setup();
    let aborted = false;
    chatMock.mockImplementation((_messages, opts) => {
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    });
    await renderPreview();
    selectInPreview(0, 4, 9);
    const dialog = await openDialog(user, 'canvas-refine-selection');
    await user.type(within(dialog).getByTestId('canvas-instruction-input'), 'call them a band');
    await user.click(within(dialog).getByTestId('canvas-instruction-confirm'));

    // The wait is visible in the view the owner is looking at.
    expect(await screen.findByTestId('canvas-preview-proposing')).toBeInTheDocument();
    await user.click(screen.getByTestId('canvas-stop-proposal'));
    await flushAsyncUpdates();

    expect(aborted).toBe(true);
    expect(await listModuleVersions(world.moduleId)).toHaveLength(0);
    const row = await getModule(world.moduleId);
    expect(row?.parts.find((part) => part.planIndex === 0)?.markdown).toBe(PART_0_TEXT);
    expect(screen.getByTestId('canvas-preview-part-0')).toHaveTextContent(
      'The party bargains with Keeper Ilse at the gate.',
    );
    // A stop is not an error and not a success: nothing is claimed.
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalled();
    await flushAsyncUpdates();
  }, 30_000);

  it('the preview is not a gate: the old "switch to Edit" copy is gone from the source', () => {
    const src = resolve(import.meta.dirname, '..', '..', 'src');
    const files = sourceFiles(src);
    // Non-vacuity: this really walked the source tree (and the scan below can
    // only pass because it reads files at all).
    expect(files.length).toBeGreaterThan(50);
    const contents = files.map((file) => readFileSync(file, 'utf8'));
    expect(contents.join('\n')).toContain('Refine selection');
    for (const body of contents) {
      expect(body).not.toContain('Refine and Rewrite work on the editor');
    }
    // The gate itself is gone too: the two actions are gated on `aiBlocked`
    // alone (the honest shared gate), never on the view.
    const canvas = readFileSync(
      resolve(src, 'features', 'modules', 'canvas', 'CanvasPage.tsx'),
      'utf8',
    );
    expect(canvas).not.toContain('aiBlocked || previewOpen');
    expect(toastInfoMock).not.toHaveBeenCalled();
  });
});

/** Every .ts/.tsx file under `dir` (a small explicit walk — no glob dep). */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found;
}
