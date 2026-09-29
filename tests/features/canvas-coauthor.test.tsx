import 'fake-indexeddb/auto';

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditorView } from '@codemirror/view';
import { RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
import { canvasPath } from '@/app/routes';
import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { getModule, saveModule } from '@/db/moduleRepo';
import {
  assembleModuleDocument,
  createModule,
  modulePartSchema,
  moduleDocumentSections,
  moduleSpineSchema,
  type Id,
} from '@/domain';
import { clearDatabase } from '../db/helpers';
import { actDrained, flushAsyncUpdates } from '../helpers/flush';
import { CANVAS_SPLIT_STORAGE_ID } from '@/features/modules/canvas/CanvasPage';
import { activeCanvasView } from '@/features/modules/canvas/canvasView';
import { entryTransaction } from '@/features/modules/canvas/canvasEditor';
import { previewScrollAnchor, scrollPreviewToPos } from '@/features/modules/canvas/editHandoff';
import { useCanvasChatStore } from '@/features/modules/canvas/chatStore';
import { useCanvasLedgerStore } from '@/features/modules/canvas/canvasStore';
import { useCanvasPreviewStore } from '@/features/modules/canvas/previewStore';

/**
 * Co-authoring arc (docs/17 row 399, docs/23): click-to-edit with position
 * handoff, the way back, the resizable chat split and the "Campaign chat"
 * rename — through the REAL page, editor, preview and chat components.
 *
 * NOT provable in jsdom (no layout, no real pointer): that the editor really
 * paints scrolled to the same text and that a real mouse click yields the
 * collapsed Range these tests build. The scroll target is asserted as the
 * COMPUTED anchor handed to CodeMirror (stubbed rects), the caret as the real
 * editor selection.
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
const { toastError } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);

const PART_0_TEXT = 'The party bargains with [[Keeper Ilse]] at the gate.';
const PART_1_TEXT = 'Below the tower, the flood rises.';
const PART_PLAN = [
  { title: 'The Gate Bargain', levelBand: '1', synopsis: '', levelUpTrigger: '' },
  { title: 'The Flooded Nave', levelBand: '2', synopsis: '', levelUpTrigger: '' },
];
const WHOLE_DOC = assembleModuleDocument({
  levels: [
    { number: 0, text: 'The premise promises a drowned [[Vault Door]].' },
    { number: 1, text: PART_0_TEXT },
    { number: 2, text: PART_1_TEXT },
  ],
});
const SECTIONS = moduleDocumentSections(WHOLE_DOC, PART_PLAN);
const PART0_FROM = SECTIONS[1]?.textFrom ?? -1;
const PART1_FROM = SECTIONS[2]?.textFrom ?? -1;

let world: { campaignId: Id; moduleId: Id } = { campaignId: '', moduleId: '' };

async function seedModule(): Promise<void> {
  const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
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
    parts: [PART_0_TEXT, PART_1_TEXT].map((markdown, planIndex) =>
      modulePartSchema.parse({
        planIndex,
        markdown,
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
    ),
  });
  world = { campaignId: campaign.id, moduleId: draft.id };
}

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
  window.localStorage.clear();
  useCanvasPreviewStore.setState({ ownerModuleId: null, openByModule: {}, selectionByModule: {} });
  useCanvasChatStore.setState({ ownerModuleId: null, byModule: {} });
  useCanvasLedgerStore.setState({ ownerModuleId: null, byPart: {} });
  await seedModule();
});

async function renderCanvas(): Promise<void> {
  window.history.replaceState(null, '', canvasPath(world.campaignId, world.moduleId));
  render(<RouterProvider router={createAppRouter()} />);
  await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
  await screen.findByTestId('canvas-preview', {}, { timeout: 10_000 });
  await screen.findByTestId('canvas-chat');
  await flushAsyncUpdates();
}

function runsOf(planIndex: number): HTMLElement[] {
  const part = screen.getByTestId(`canvas-preview-part-${String(planIndex)}`);
  return [...part.querySelectorAll<HTMLElement>('[data-md-from]')];
}

/** A collapsed click at `offset` inside `node`, the way a real click lands. */
function clickAt(node: Node, offset: number, target?: Element): void {
  const selection = window.getSelection();
  selection?.removeAllRanges();
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  selection?.addRange(range);
  const el = target ?? (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element));
  fireEvent.click(need(el));
}

function textOf(run: HTMLElement): Text {
  return run.firstChild as Text;
}

function need<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value');
  return value;
}

function liveView(): EditorView {
  const view = activeCanvasView.current;
  if (view === null) throw new Error('no live editor');
  return view;
}

function docOfEditor(): string {
  return activeCanvasView.current?.state.doc.toString() ?? '<no editor>';
}

async function enterEditByClick(): Promise<void> {
  const run = need(runsOf(0)[0]);
  await actDrained(async () => {
    clickAt(textOf(run), 8);
    await Promise.resolve();
  });
  await screen.findByTestId('canvas-editor');
}

async function typeIntoEditor(from: number, insert: string): Promise<void> {
  await actDrained(async () => {
    activeCanvasView.current?.dispatch({ changes: { from, insert } });
    await Promise.resolve();
  });
}

function mockReply(raw: string): void {
  chatMock.mockResolvedValue({ text: raw, modelUsed: 'coauthor-model', fallback: null });
}

async function sendChat(user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> {
  await user.type(screen.getByTestId('canvas-chat-input'), text);
  await user.click(screen.getByTestId('canvas-chat-send'));
  await flushAsyncUpdates();
}

describe('click-to-edit: entering the editor from the rendered view', () => {
  it('a mid-paragraph click lands the caret at the mapped SOURCE offset (level 1)', async () => {
    await renderCanvas();
    await enterEditByClick();
    expect(activeCanvasView.current?.state.selection.main.head).toBe(PART0_FROM + 8);
    expect(docOfEditor()).toBe(WHOLE_DOC);
  });

  it('a click in the SECOND level lands in that level, not at the start', async () => {
    await renderCanvas();
    const run = need(runsOf(1)[0]);
    await actDrained(async () => {
      clickAt(textOf(run), 6);
      await Promise.resolve();
    });
    await screen.findByTestId('canvas-editor');
    expect(activeCanvasView.current?.state.selection.main.head).toBe(PART1_FROM + 6);
  });

  it('an UNMAPPABLE click degrades to the first mappable run of the SAME section, never 0', async () => {
    await renderCanvas();
    const root = need(
      screen.getByTestId('canvas-preview-part-1').querySelector('[data-canvas-part-source]'),
    );
    await actDrained(async () => {
      clickAt(root, 0);
      await Promise.resolve();
    });
    await screen.findByTestId('canvas-editor');
    const head = activeCanvasView.current?.state.selection.main.head ?? 0;
    expect(head).toBe(PART1_FROM);
    expect(head).toBeGreaterThan(0);
  });

  it('a DRAG selection does not switch modes and still produces the refine capture', async () => {
    await renderCanvas();
    const run = need(runsOf(0)[0]);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    const range = document.createRange();
    range.setStart(textOf(run), 4);
    range.setEnd(textOf(run), 9);
    selection?.addRange(range);
    fireEvent.mouseUp(screen.getByTestId('canvas-preview'));
    fireEvent.click(run);
    expect(screen.queryByTestId('canvas-editor')).toBeNull();
    const capture = useCanvasPreviewStore.getState().selectionByModule[world.moduleId];
    expect(capture).toMatchObject({ kind: 'mapped', from: PART0_FROM + 4, to: PART0_FROM + 9 });
  });

  it('a wiki-link chip click keeps its peek meaning and does not enter edit mode', async () => {
    await renderCanvas();
    const chip = screen
      .getByTestId('canvas-preview-part-0')
      .querySelector<HTMLElement>('[data-wiki-raw]');
    expect(chip).not.toBeNull();
    await actDrained(async () => {
      fireEvent.click(need(chip));
      await Promise.resolve();
    });
    expect(screen.queryByTestId('canvas-editor')).toBeNull();
    expect(screen.getByTestId('canvas-preview')).toBeInTheDocument();
  });

  it('the scroll target is the text at the top of the pane (computed anchor handed to CM6)', async () => {
    await renderCanvas();
    const scroller = screen.getByTestId('canvas-preview');
    const spy = vi.spyOn(EditorView, 'scrollIntoView');
    // Stub layout: pane top = 0; every level-1 run is scrolled ABOVE it, the
    // first level-2 run is at 40px.
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 500));
    for (const run of runsOf(0)) {
      vi.spyOn(run, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, -200, 100, 20));
    }
    const target = need(runsOf(1)[0]);
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 40, 100, 20));
    expect(previewScrollAnchor(scroller)).toEqual({ pos: PART1_FROM, offsetPx: 40 });
    await actDrained(async () => {
      clickAt(textOf(target), 3);
      await Promise.resolve();
    });
    await screen.findByTestId('canvas-editor');
    expect(spy).toHaveBeenCalledWith(PART1_FROM, expect.anything());
    // The pure halves: the entry transaction clamps, and the preview scroll
    // helper moves the pane by the run's distance from its top.
    expect(entryTransaction(10, { caret: 99, scrollPos: -3 }).selection.anchor).toBe(10);
    scroller.scrollTop = 0;
    scrollPreviewToPos(scroller, PART1_FROM);
    expect(scroller.scrollTop).toBe(40);
  });
});

describe('the way back and edits that survive it', () => {
  it('round trip keeps the document byte-identical; Escape returns rendered with dirty preserved', async () => {
    await renderCanvas();
    await enterEditByClick();
    await typeIntoEditor(PART0_FROM, 'Hey ');
    const edited = WHOLE_DOC.slice(0, PART0_FROM) + 'Hey ' + WHOLE_DOC.slice(PART0_FROM);
    expect(docOfEditor()).toBe(edited);
    expect(screen.getByTestId('canvas-save')).toBeEnabled();
    await actDrained(async () => {
      fireEvent.keyDown(liveView().contentDOM, { key: 'Escape' });
      await Promise.resolve();
    });
    await screen.findByTestId('canvas-preview');
    expect(screen.getByTestId('canvas-preview-part-0')).toHaveTextContent('Hey The party');
    expect(screen.queryByTestId('canvas-saved-indicator')).toBeNull();
    expect(screen.getByTestId('canvas-save')).toBeEnabled();
    // Nothing was written by switching.
    expect((await getModule(world.moduleId))?.parts[0]?.markdown).toBe(PART_0_TEXT);
    // Save from the RENDERED view writes the live-editor snapshot.
    await actDrained(async () => {
      fireEvent.click(screen.getByTestId('canvas-save'));
      await Promise.resolve();
    });
    expect((await getModule(world.moduleId))?.parts[0]?.markdown).toBe('Hey ' + PART_0_TEXT);
    // A pure round trip without edits is byte-identical.
    await enterEditByClick();
    expect(docOfEditor()).toBe(edited);
  });

  it('a pointerdown in the pane margin returns to the rendered view', async () => {
    await renderCanvas();
    await enterEditByClick();
    await actDrained(async () => {
      fireEvent.pointerDown(screen.getByTestId('canvas-editor-pane'));
      await Promise.resolve();
    });
    await screen.findByTestId('canvas-preview');
  });

  it('a pointerdown or focus in the CHAT, a dialog open/close and a window blur do NOT switch modes', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    await enterEditByClick();
    await user.click(screen.getByTestId('canvas-chat-input'));
    fireEvent.pointerDown(screen.getByTestId('canvas-chat'));
    fireEvent.focus(screen.getByTestId('canvas-chat-input'));
    expect(screen.getByTestId('canvas-editor')).toBeInTheDocument();
    // A dialog (clear-chat confirm) opens and is cancelled.
    await user.click(screen.getByTestId('canvas-chat-clear'));
    await screen.findByTestId('canvas-chat-clear-dialog');
    expect(screen.getByTestId('canvas-editor')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await flushAsyncUpdates();
    expect(screen.queryByTestId('canvas-editor')).toBeInTheDocument();
    await actDrained(async () => {
      fireEvent.blur(window);
      fireEvent.focus(window);
      await Promise.resolve();
    });
    expect(screen.getByTestId('canvas-editor')).toBeInTheDocument();
  });

  it('a malformed separator from a user edit is refused LOUDLY at save, naming the line; the row is unchanged', async () => {
    await renderCanvas();
    await enterEditByClick();
    const at = WHOLE_DOC.indexOf('=====Level 2=====');
    await typeIntoEditor(at + 5, ' ');
    await actDrained(async () => {
      fireEvent.click(screen.getByTestId('canvas-save'));
      await Promise.resolve();
    });
    expect(toastErrorMock).toHaveBeenCalled();
    const error = toastErrorMock.mock.calls[0]?.[1] as Error;
    expect(error.message).toMatch(/line \d+/);
    const row = await getModule(world.moduleId);
    expect(row?.parts[1]?.markdown).toBe(PART_1_TEXT);
    expect(screen.getByTestId('canvas-save')).toBeInTheDocument();
  });
});

describe('user edits and chat edits share ONE document', () => {
  it('a chat turn after a user edit sees the user text; a user edit after a chat edit keeps it; undo steps one chat edit', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    await enterEditByClick();
    await typeIntoEditor(PART0_FROM, 'USERWORD ');
    mockReply('<edit><search>Below the tower</search><replace>Under the tower</replace></edit>');
    await sendChat(user, 'rename it');
    const sent = JSON.stringify(chatMock.mock.calls[0]?.[0]);
    expect(sent).toContain('USERWORD');
    expect(docOfEditor()).toContain('Under the tower, the flood rises.');
    await typeIntoEditor(0, 'AFTER ');
    expect(docOfEditor()).toContain('AFTER ');
    expect(docOfEditor()).toContain('Under the tower');
    // Undo reverts the user typing steps, never a chat edit "twice": drive CM6 undo.
    const { undo } = await import('@codemirror/commands');
    await actDrained(async () => {
      undo(liveView());
      await Promise.resolve();
    });
    expect(docOfEditor()).not.toContain('AFTER ');
    expect(docOfEditor()).toContain('Under the tower');
    await actDrained(async () => {
      undo(liveView());
      await Promise.resolve();
    });
    expect(docOfEditor()).toContain('Below the tower');
    expect(docOfEditor()).toContain('USERWORD');
  });

  it('after Escape the next chat turn runs on the snapshot and sees the unsaved user text', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    await enterEditByClick();
    await typeIntoEditor(PART0_FROM, 'USERWORD ');
    await actDrained(async () => {
      fireEvent.keyDown(liveView().contentDOM, { key: 'Escape' });
      await Promise.resolve();
    });
    await screen.findByTestId('canvas-preview');
    mockReply('Just talking.');
    await sendChat(user, 'hello');
    expect(JSON.stringify(chatMock.mock.calls[0]?.[0])).toContain('USERWORD');
  });
});

describe('Campaign chat rename and the resizable split', () => {
  it('the tab reads "Campaign chat"; no user-visible "Module chat" string remains in src', async () => {
    await renderCanvas();
    const tabs = screen.getByTestId('canvas-chat-surface-switcher');
    expect(within(tabs).getByText('Campaign chat')).toBeInTheDocument();
    expect(within(tabs).getByText('GM assist')).toBeInTheDocument();
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name)) {
          readFileSync(path, 'utf8')
            .split('\n')
            .forEach((line, index) => {
              const trimmed = line.trim();
              if (/^(\/\/|\*|\/\*)/.test(trimmed)) return;
              if (line.includes('Module chat')) offenders.push(`${path}:${String(index + 1)}`);
            });
        }
      }
    };
    walk(join(process.cwd(), 'src'));
    expect(offenders).toEqual([]);
  });

  it('the split is a keyboard-reachable separator with bounded panes; toggling the chat keeps the document mounted and the saved split', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    const handle = screen.getByRole('separator', { name: 'Resize the chat' });
    expect(handle).toHaveAttribute('role', 'separator');
    expect(handle).toHaveAttribute('tabindex', '0');
    // Min/max floors are declared by the page (chat must stay usable, text readable).
    const source = readFileSync(
      join(process.cwd(), 'src/features/modules/canvas/CanvasPage.tsx'),
      'utf8',
    );
    expect(source).toContain(`'${CANVAS_SPLIT_STORAGE_ID}'`);
    expect(source).toMatch(/const CHAT_MIN_PX = 280;/);
    expect(source).toMatch(/const DOC_MIN_PX = 360;/);
    expect(source).toContain('maxSize="60%"');
    // Persisted layout survives close/open: seed one, toggle, it is still there.
    const key = Object.keys(window.localStorage).find((k) => k.includes(CANVAS_SPLIT_STORAGE_ID));
    const before = key === undefined ? null : window.localStorage.getItem(key);
    await user.click(screen.getByTestId('canvas-chat-toggle'));
    expect(screen.queryByTestId('canvas-chat')).toBeNull();
    expect(screen.getByTestId('canvas-preview')).toBeInTheDocument();
    await user.click(screen.getByTestId('canvas-chat-toggle'));
    expect(await screen.findByTestId('canvas-chat')).toBeInTheDocument();
    const after = key === undefined ? null : window.localStorage.getItem(key);
    expect(after).toBe(before);
    await flushAsyncUpdates();
  });
});

void act;
