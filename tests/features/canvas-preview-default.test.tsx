import 'fake-indexeddb/auto';

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
import { canvasPath } from '@/app/routes';
import { createCampaign } from '@/db/campaignRepo';
import { getModule, saveModule } from '@/db/moduleRepo';
import {
  createModule,
  modulePartSchema,
  moduleSpineSchema,
  type Id,
} from '@/domain';
import { ModulePartsDocumentError } from '@/domain/modulePartsDocument';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';
import { activeCanvasView } from '@/features/modules/canvas/canvasView';
import {
  canvasLedgerKey,
  useCanvasLedgerStore,
} from '@/features/modules/canvas/canvasStore';
import { useCanvasChatStore } from '@/features/modules/canvas/chatStore';
import { useCanvasPreviewStore } from '@/features/modules/canvas/previewStore';
import type * as PartTextModule from '@/features/modules/partText';
import { applyChatCommandsToSnapshot } from '@/features/modules/canvas/snapshotChat';
import {
  assembleModulePartsDocument,
  splitPartsDocument,
} from '@/domain/modulePartsDocument';
import { WikiMarkdown } from '@/features/campaign/components/wiki-markdown';

/**
 * Canvas preview-default arc (08-MODULE-DESIGNER §Module canvas): the canvas
 * opens as chat + rendered preview side by side (preview open by default,
 * full-width, chat live inside it), and the last chat replacement
 * highlights in both surfaces. The LLM is mocked — the snapshot turn
 * controller, the shared ladder, the split-save seam and both highlight
 * paths run for real.
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

const PART_0_TEXT = 'The party bargains with [[Keeper Ilse]] at the gate.\n\nRain hammers the stones.';
const PART_1_TEXT = 'The docks breathe fog.\n\nMist climbs the stairs.';

const PART_PLAN = [
  { title: 'The Gate Bargain', levelBand: '1', synopsis: '', levelUpTrigger: '' },
  { title: 'Under the Docks', levelBand: '1', synopsis: '', levelUpTrigger: '' },
  { title: 'The Long Watch', levelBand: '2', synopsis: '', levelUpTrigger: '' },
];

/** The WHOLE-module snapshot the preview renders from (canvas v3). */
const WHOLE_DOC = assembleModulePartsDocument({
  partPlan: PART_PLAN,
  parts: [
    { planIndex: 0, markdown: PART_0_TEXT },
    { planIndex: 1, markdown: PART_1_TEXT },
  ],
}).document;

let world: { campaignId: Id; moduleId: Id } = { campaignId: '', moduleId: '' };

function renderAppAt(path: string): ReturnType<typeof render> {
  window.history.replaceState(null, '', path);
  return render(<RouterProvider router={createAppRouter()} />);
}

async function seedModule(): Promise<void> {
  const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
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
      premise: 'The premise promises a drowned vault.',
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
  useCanvasChatStore.setState({ ownerModuleId: null, byModule: {} });
  useCanvasPreviewStore.setState({ ownerModuleId: null, openByModule: {} });
  await seedModule();
});

/** The mocked chat: streams the raw reply in two deltas and settles. */
function mockChatReply(raw: string): void {
  chatMock.mockImplementation((_messages, opts) => {
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

/** Types an instruction and sends it; drains the detached chat chain. */
async function sendChat(
  user: ReturnType<typeof userEvent.setup>,
  text: string,
): Promise<void> {
  const input = screen.getByTestId('canvas-chat-input');
  await user.type(input, text);
  await user.click(screen.getByTestId('canvas-chat-send'));
  await flushAsyncUpdates();
}

describe('preview default + full width + live chat', () => {
  it('opens as chat + rendered preview side by side, with a live send', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    expect(screen.getByTestId('canvas-preview')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-editor')).not.toBeInTheDocument();
    expect(screen.getByTestId('canvas-chat')).toBeInTheDocument();
    // The send is live in preview (not a dead panel): typing arms it.
    await user.type(screen.getByTestId('canvas-chat-input'), 'make it rain');
    expect(screen.getByTestId('canvas-chat-send')).toBeEnabled();
    await flushAsyncUpdates();
  });

  it('the preview fills its pane — no centered narrow measure', async () => {
    await renderCanvas();
    const preview = screen.getByTestId('canvas-preview');
    expect(preview.querySelector('.max-w-3xl')).toBeNull();
    await flushAsyncUpdates();
  });

  it('every chip in the CANVAS PREVIEW shows the token it was written from', async () => {
    await renderCanvas();
    const preview = screen.getByTestId('canvas-preview');
    // Part 0's text is `... bargains with [[Keeper Ilse]] at the gate.` — the
    // preview renders through the SAME `WikiMarkdown`, so the carrier arrives
    // here with no per-surface wiring (docs/17 row 100).
    const chip = within(preview).getByTestId('wiki-chip-unresolved');
    expect(chip).toHaveAttribute('data-wiki-name', 'Keeper Ilse');
    expect(chip).toHaveAttribute('data-wiki-raw', '[[Keeper Ilse]]');
    expect(chip).toHaveAttribute(
      'title',
      '[[Keeper Ilse]] — Keeper Ilse — not detailed yet',
    );
    await flushAsyncUpdates();
  });

  it('chat send in preview applies to the snapshot + persists via split-save + re-renders, and return-to-Edit shows it', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    mockChatReply(
      'Making it rainier.\n<edit><search>Rain hammers the stones.</search><replace>Rain drowns every word.</replace></edit>',
    );
    await sendChat(user, 'make the rain heavier');

    // Outcome card: applied, naming the target part, before→after intact.
    const panel = screen.getByTestId('canvas-chat');
    const card = await within(panel).findByTestId('canvas-chat-outcome');
    expect(card).toHaveAttribute('data-kind', 'applied');
    expect(within(card).getByTestId('canvas-chat-outcome-part').textContent).toContain(
      'Part 1 — The Gate Bargain',
    );
    expect(card.textContent).toContain('Rain hammers the stones.');
    expect(card.textContent).toContain('Rain drowns every word.');
    // The preview re-rendered with the new text…
    expect(screen.getByTestId('canvas-preview-part-0')).toHaveTextContent('Rain drowns every word.');
    // …and the batch persisted through the split-save (only that part).
    const row = await getModule(world.moduleId);
    expect(row?.parts.find((part) => part.planIndex === 0)?.markdown).toBe(
      PART_0_TEXT.replace('Rain hammers the stones.', 'Rain drowns every word.'),
    );
    expect(row?.parts.find((part) => part.planIndex === 0)?.edited).toBe(true);
    expect(row?.parts.find((part) => part.planIndex === 1)?.markdown).toBe(PART_1_TEXT);
    const ledger = useCanvasLedgerStore.getState().byPart[canvasLedgerKey(world.moduleId, 0)];
    expect(ledger?.versions).toHaveLength(1);
    expect(ledger?.versions[0]?.origin).toBe('ai');
    // Return-to-Edit mounts the latest snapshot through the mountDoc path.
    await user.click(screen.getByTestId('canvas-preview-toggle'));
    expect(await screen.findByTestId('canvas-editor')).toBeInTheDocument();
    expect(activeCanvasView.current?.state.doc.toString()).toBe(
      WHOLE_DOC.replace('Rain hammers the stones.', 'Rain drowns every word.'),
    );
    await flushAsyncUpdates();
  });

  it('a scaffolding-broken snapshot fails the send LOUDLY (no editor to fall back on)', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    // Break the scaffolding in Edit, then carry the broken snapshot back.
    await user.click(screen.getByTestId('canvas-preview-toggle'));
    await screen.findByTestId('canvas-editor');
    const doc = activeCanvasView.current?.state.doc.toString() ?? '';
    const firstDelimiter = doc.indexOf('\n\n==========\n\n');
    act(() => {
      activeCanvasView.current?.dispatch({
        changes: { from: firstDelimiter, to: firstDelimiter + '\n\n==========\n\n'.length, insert: '\n\n' },
      });
    });
    await user.click(screen.getByTestId('canvas-preview-toggle'));
    expect(await screen.findByTestId('canvas-preview-error')).toBeInTheDocument();

    mockChatReply(
      '<edit><search>Rain hammers the stones.</search><replace>Rain drowns every word.</replace></edit>',
    );
    await sendChat(user, 'make the rain heavier');
    const panel = screen.getByTestId('canvas-chat');
    const errorCard = await within(panel).findByTestId('canvas-chat-error-card');
    expect(within(errorCard).getByTestId('canvas-chat-error-text').textContent).toMatch(/separator/i);
    // Nothing persisted.
    const row = await getModule(world.moduleId);
    expect(row?.parts.find((part) => part.planIndex === 0)?.markdown).toBe(PART_0_TEXT);
    await flushAsyncUpdates();
  });
});

describe('last-replacement highlight, both surfaces', () => {
  it('appears in the preview after a chat apply — the LAST command wins', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    mockChatReply(
      'Making it rainier.\n<edit><search>Rain hammers the stones.</search><replace>Rain drowns every word.</replace></edit>',
    );
    await sendChat(user, 'make the rain heavier');
    const first = await within(screen.getByTestId('canvas-preview')).findByTestId(
      'replacement-highlight',
    );
    expect(first).toHaveTextContent('Rain drowns every word.');

    // A second apply replaces the mark (single range, no history).
    mockChatReply(
      '<edit><search>Mist climbs the stairs.</search><replace>Mist floods the stairwell.</replace></edit>',
    );
    await sendChat(user, 'flood the stairwell');
    const marks = await within(screen.getByTestId('canvas-preview')).findAllByTestId(
      'replacement-highlight',
    );
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent('Mist floods the stairwell.');
    await flushAsyncUpdates();
  });

  it('the preview wash sits inline over exactly the replaced words, and the part still reads as its source', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    mockChatReply(
      'Making it rainier.\n<edit><search>Rain hammers the stones.</search><replace>Rain drowns every word.</replace></edit>',
    );
    await sendChat(user, 'make the rain heavier');
    // The wash must paint AND must not move the text: it is an inline span
    // over the replaced characters inside the paragraph (docs/17 row 102 —
    // the slice-per-paragraph version this replaced dropped every whitespace
    // character at a slice boundary, because CommonMark trims the first and
    // last whitespace of a paragraph and each slice was its own document).
    const article = screen.getByTestId('canvas-preview-part-0');
    const wash = await within(article).findByTestId('replacement-highlight');
    expect(wash.tagName).toBe('SPAN');
    expect(wash).toHaveTextContent('Rain drowns every word.');
    expect(wash.closest('p')).not.toBeNull();
    // The unaffected part carries no wash.
    expect(
      within(screen.getByTestId('canvas-preview-part-1')).queryByTestId('replacement-highlight'),
    ).toBeNull();
    await flushAsyncUpdates();
  });

  it('a preview send then toggle to Edit carries the CM mark', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    mockChatReply(
      'Making it rainier.\n<edit><search>Rain hammers the stones.</search><replace>Rain drowns every word.</replace></edit>',
    );
    await sendChat(user, 'make the rain heavier');
    // The preview wash is up (the snapshot path set the highlight)…
    const wash = await within(screen.getByTestId('canvas-preview')).findByTestId(
      'replacement-highlight',
    );
    expect(wash).toHaveTextContent('Rain drowns every word.');
    // …and returning to Edit remounts the same snapshot WITH the CM mark.
    await user.click(screen.getByTestId('canvas-preview-toggle'));
    await screen.findByTestId('canvas-editor');
    const mark = await screen.findByTestId('canvas-last-replacement');
    expect(mark).toHaveTextContent('Rain drowns every word.');
    await flushAsyncUpdates();
  });

  it('appears in the editor as a background mark and clears on hand edit', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    await user.click(screen.getByTestId('canvas-preview-toggle'));
    await screen.findByTestId('canvas-editor');
    mockChatReply(
      'Making it rainier.\n<edit><search>Rain hammers the stones.</search><replace>Rain drowns every word.</replace></edit>',
    );
    const input = screen.getByTestId('canvas-chat-input');
    await user.type(input, 'make the rain heavier');
    await user.click(screen.getByTestId('canvas-chat-send'));
    await flushAsyncUpdates();

    const mark = await screen.findByTestId('canvas-last-replacement');
    expect(mark).toHaveTextContent('Rain drowns every word.');
    // Any hand edit clears the mark (identity gate — never a stale mark).
    act(() => {
      const view = activeCanvasView.current;
      if (view === null) throw new Error('editor view missing');
      view.dispatch({ changes: { from: view.state.doc.length, to: view.state.doc.length, insert: '\n' } });
    });
    await waitFor(() => {
      expect(screen.queryByTestId('canvas-last-replacement')).not.toBeInTheDocument();
    });
    await flushAsyncUpdates();
  });

  it('an editor failed-reply Report-to-LLM marks the retry replacement', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    await user.click(screen.getByTestId('canvas-preview-toggle'));
    await screen.findByTestId('canvas-editor');
    // A malformed reply fails the turn (failed card, nothing applied)…
    mockChatReply('Trying.\n<edit><search>Rain hammers the stones.</search>');
    const input = screen.getByTestId('canvas-chat-input');
    await user.type(input, 'make it rain');
    await user.click(screen.getByTestId('canvas-chat-send'));
    await flushAsyncUpdates();
    // …and the Report-to-LLM retry applies AND marks like every chat apply.
    mockChatReply(
      'Retrying.\n<edit><search>Rain hammers the stones.</search><replace>Rain drowns every word.</replace></edit>',
    );
    await user.click(screen.getByTestId('canvas-chat-report-error'));
    await flushAsyncUpdates();
    const panel = screen.getByTestId('canvas-chat');
    const card = await within(panel).findByTestId('canvas-chat-outcome');
    expect(card).toHaveAttribute('data-kind', 'applied');
    const mark = await screen.findByTestId('canvas-last-replacement');
    expect(mark).toHaveTextContent('Rain drowns every word.');
    await flushAsyncUpdates();
  });

  it('an empty-part fill highlights the filled section text', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    mockChatReply(
      '<edit><search>[Part 3 of 3 — The Long Watch]</search><replace>[Part 3 of 3 — The Long Watch]\n\nThe watch begins in fog.</replace></edit>',
    );
    await sendChat(user, 'write the last part');
    const mark = await within(screen.getByTestId('canvas-preview')).findByTestId(
      'replacement-highlight',
    );
    expect(mark).toHaveTextContent('The watch begins in fog.');
    const row = await getModule(world.moduleId);
    expect(row?.parts.find((part) => part.planIndex === 2)?.markdown).toBe('The watch begins in fog.');
    await flushAsyncUpdates();
  });
});

describe('WikiMarkdown highlight contract', () => {
  const VALUE = 'The party bargains with [[Keeper Ilse]] at the gate.\n\nRain hammers the stones.';

  it('is byte-identical without the highlight prop', () => {
    const plain = render(<WikiMarkdown value={VALUE} artifacts={[]} />);
    const absent = render(<WikiMarkdown value={VALUE} artifacts={[]} highlight={undefined} />);
    expect(absent.container.innerHTML).toBe(plain.container.innerHTML);
    plain.unmount();
    absent.unmount();
  });

  it('washes exactly the highlighted slice, inline, leaving every other character in place', () => {
    const from = VALUE.indexOf('Rain hammers the stones.');
    const rendered = render(
      <WikiMarkdown value={VALUE} artifacts={[]} highlight={{ from, to: from + 'Rain hammers the stones.'.length }} />,
    );
    const mark = rendered.container.querySelector('[data-testid="replacement-highlight"]');
    expect(mark).not.toBeNull();
    // Inline by contract: it is a decoration INSIDE one parse of one string,
    // so the rendered text is the source text character for character — the
    // whitespace at the wash's boundaries included (the block-level wrapper
    // around separately parsed slices could not do that: MEASURED, it
    // rendered "onetwothree" for "one two three" with [4,7) washed).
    expect(mark?.tagName).toBe('SPAN');
    expect(mark?.textContent).toBe('Rain hammers the stones.');
    // React renders a newline between block elements: the ONLY difference
    // from the source is that block separator, never a character of text.
    expect(rendered.container.textContent).toBe(
      'The party bargains with Keeper Ilse at the gate.\nRain hammers the stones.',
    );
    rendered.unmount();
  });

  it('parses ONE string: a wash never re-chunks the surrounding markdown', () => {
    // The wash's edges fall INSIDE one paragraph, around emphasis and across
    // a blank line — none of it may split, trim or re-order the text.
    const VALUE2 = 'One **two** three four.\n\nSecond para.';
    const from = VALUE2.indexOf('two');
    const rendered = render(
      <WikiMarkdown value={VALUE2} artifacts={[]} highlight={{ from, to: from + 3 }} />,
    );
    expect(rendered.container.textContent).toBe('One two three four.\nSecond para.');
    const mark = rendered.container.querySelector('[data-testid="replacement-highlight"]');
    expect(mark?.textContent).toBe('two');
    // A replacement that spans the emphasis and the blank line washes every
    // covered RUN — one wash per run (the `two` inside `**`, the text after
    // it, the second paragraph), never a second parse of a slice.
    const wide = render(
      <WikiMarkdown value={VALUE2} artifacts={[]} highlight={{ from: 4, to: VALUE2.length }} />,
    );
    expect(wide.container.textContent).toBe('One two three four.\nSecond para.');
    expect(wide.container.querySelectorAll('[data-testid="replacement-highlight"]')).toHaveLength(3);
    rendered.unmount();
    wide.unmount();
  });

  it('keeps the whitespace around a wash that sits inside one run (the measured defect)', () => {
    // MEASURED against the old slice-per-paragraph render: this exact case
    // rendered "onetwothree", because CommonMark trims the initial and final
    // whitespace of a paragraph and each slice was parsed as its own document.
    const spaced = render(
      <WikiMarkdown value="one two three" artifacts={[]} highlight={{ from: 4, to: 7 }} />,
    );
    expect(spaced.container.textContent).toBe('one two three');
    const mark = spaced.container.querySelector('[data-testid="replacement-highlight"]');
    expect(mark?.textContent).toBe('two');
    spaced.unmount();
  });
});

describe('applyChatCommandsToSnapshot (pure string units)', () => {
  const PLAN = [{ title: 'Open Part' }, { title: 'Other Part' }];
  const DOC = assembleModulePartsDocument({
    partPlan: PLAN,
    parts: [
      { planIndex: 0, markdown: 'Rain here.\nRain there.' },
      { planIndex: 1, markdown: 'Fog elsewhere.' },
    ],
  }).document;

  it('splices a replacement and reports the post-apply range for the highlight', () => {
    const result = applyChatCommandsToSnapshot({
      commands: [{ search: 'Rain here.', replace: 'Longer rainy opening.', all: false }],
      partPlan: PLAN,
      doc: DOC,
    });
    expect(result.docChanged).toBe(true);
    expect(result.doc).toBe(DOC.replace('Rain here.', 'Longer rainy opening.'));
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.kind).toBe('applied');
    // The highlight range covers the NEW text in the NEW doc.
    expect(result.lastApplied).not.toBeNull();
    const range = result.lastApplied;
    if (range === null) throw new Error('highlight range missing');
    expect(result.doc.slice(range.from, range.to)).toBe('Longer rainy opening.');
  });

  it('re-resolves per command (earlier commands never shift later ranges) and keeps the LAST range', () => {
    const result = applyChatCommandsToSnapshot({
      commands: [
        { search: 'Rain here.', replace: 'Longer rainy opening.', all: false },
        { search: 'Rain there.', replace: 'Closing rain.', all: false },
      ],
      partPlan: PLAN,
      doc: DOC,
    });
    expect(result.outcomes.every((outcome) => outcome.kind === 'applied')).toBe(true);
    expect(result.doc).toBe(
      DOC.replace('Rain here.', 'Longer rainy opening.').replace('Rain there.', 'Closing rain.'),
    );
    const range = result.lastApplied;
    if (range === null) throw new Error('highlight range missing');
    expect(result.doc.slice(range.from, range.to)).toBe('Closing rain.');
  });

  it('a command in another part splices inside that section; scaffolding untouched', () => {
    const result = applyChatCommandsToSnapshot({
      commands: [{ search: 'Fog elsewhere.', replace: 'Mist elsewhere.', all: false }],
      partPlan: PLAN,
      doc: DOC,
    });
    expect(result.doc).toBe(DOC.replace('Fog elsewhere.', 'Mist elsewhere.'));
    expect(result.doc).toContain('[Part 1 of 2 — Open Part]');
    expect(result.doc).toContain('==========');
  });

  it('zero matches fail loud with the closest candidate; the doc is untouched', () => {
    const result = applyChatCommandsToSnapshot({
      commands: [{ search: 'Rain hammer the stones today.', replace: 'x', all: false }],
      partPlan: PLAN,
      doc: DOC,
    });
    expect(result.outcomes[0]?.kind).toBe('failed');
    expect(result.doc).toBe(DOC);
    expect(result.docChanged).toBe(false);
    expect(result.lastApplied).toBeNull();
  });

  it('multiple matches without all fail loud with the total count', () => {
    const result = applyChatCommandsToSnapshot({
      commands: [{ search: 'Rain', replace: 'Mist', all: false }],
      partPlan: PLAN,
      doc: DOC,
    });
    expect(result.outcomes[0]?.kind).toBe('failed');
    expect(result.outcomes[0]?.reason).toContain('matches');
    expect(result.doc).toBe(DOC);
  });

  it('an empty-part label-anchor fill writes the remainder and highlights it', () => {
    const withEmpty = assembleModulePartsDocument({
      partPlan: PLAN,
      parts: [{ planIndex: 0, markdown: 'Rain here.' }],
    }).document;
    const result = applyChatCommandsToSnapshot({
      commands: [
        {
          search: '[Part 2 of 2 — Other Part]',
          replace: '[Part 2 of 2 — Other Part]\n\nFog rolls in.',
          all: false,
        },
      ],
      partPlan: PLAN,
      doc: withEmpty,
    });
    expect(result.outcomes[0]?.kind).toBe('applied');
    expect(result.doc).toContain('Fog rolls in.');
    const range = result.lastApplied;
    if (range === null) throw new Error('highlight range missing');
    expect(result.doc.slice(range.from, range.to)).toBe('Fog rolls in.');
  });

  it('a scaffolding-broken snapshot throws ModulePartsDocumentError (loud send path)', () => {
    const broken = DOC.replace('\n\n==========\n\n', '\n\n');
    expect(() =>
      applyChatCommandsToSnapshot({
        commands: [{ search: 'Rain', replace: 'Mist', all: false }],
        partPlan: PLAN,
        doc: broken,
      }),
    ).toThrow(ModulePartsDocumentError);
  });

  it('agrees with the editor path section-for-section (split parity)', () => {
    // Both paths split the same snapshot — the section texts are the ladder input.
    const sections = splitPartsDocument(DOC, PLAN);
    expect(sections.map((section) => section.text)).toEqual([
      'Rain here.\nRain there.',
      'Fog elsewhere.',
    ]);
  });
});
