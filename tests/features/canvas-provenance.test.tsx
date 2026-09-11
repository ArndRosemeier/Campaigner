import 'fake-indexeddb/auto';

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
import { canvasPath } from '@/app/routes';
import { createCampaign } from '@/db/campaignRepo';
import { getModule, saveModule } from '@/db/moduleRepo';
import { createModule, modulePartSchema, moduleSpineSchema, type Id } from '@/domain';
import { assembleModulePartsDocument, splitPartsDocument } from '@/domain/modulePartsDocument';
import { activeCanvasView } from '@/features/modules/canvas/canvasView';
import { useCanvasLedgerStore } from '@/features/modules/canvas/canvasStore';
import { useCanvasPreviewStore } from '@/features/modules/canvas/previewStore';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * Canvas PROVENANCE (owner decision, docs/17 row 93 amendment): "i do want to
 * see who wrote the module text and i dont think i can see that elsewhere. So…
 * please put it below the module text." He thus reversed the earlier "the
 * canvas shows no id" decision.
 *
 * The canvas carries the ids in TWO read-only places — the preview's per-part
 * captions and the footer strip below the editor — and the load-bearing half is
 * the NEGATIVE: the ids must never enter the editable document, a part's
 * `markdown`, the assembled module text, or anything a save could capture. That
 * document IS the module text; it is persisted to the parts and re-sent to
 * models, so an id inside it would become model INPUT (docs/18 §4). The last
 * two tests are that pin, and they first prove the ids really are on screen, so
 * the negative cannot pass vacuously.
 */

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

/** Distinctive ids: a leak into the document is unmistakable. */
const MODEL_A = 'probe-model-a-6f21';
const MODEL_B = 'probe-model-b-93c4';
const ALL_MODELS = [MODEL_A, MODEL_B];

const PART_TEXTS = [
  'The party bargains with the keeper at the gate.',
  'Below the tower, the flood rises.',
  'The long watch begins at dusk.',
];

const PART_PLAN = [
  { title: 'The Gate Bargain', levelBand: '1', synopsis: '', levelUpTrigger: '' },
  { title: 'The Flooded Nave', levelBand: '2', synopsis: '', levelUpTrigger: '' },
  { title: 'The Long Watch', levelBand: '2', synopsis: '', levelUpTrigger: '' },
];

/** The doc the canvas mounts with — assembled from the PLAIN text only. */
const WHOLE_DOC = assembleModulePartsDocument({
  partPlan: PART_PLAN,
  parts: PART_TEXTS.map((markdown, planIndex) => ({ planIndex, markdown })),
}).document;

/** Start of part 0's TEXT (hand edits must land in a part, never the labels). */
const PART0_FROM = splitPartsDocument(WHOLE_DOC, PART_PLAN)[0]?.textFrom ?? 0;

let world: { campaignId: Id; moduleId: Id } = { campaignId: '', moduleId: '' };

function renderCanvas(): ReturnType<typeof render> {
  window.history.replaceState('', '', canvasPath(world.campaignId, world.moduleId));
  return render(<RouterProvider router={createAppRouter()} />);
}

/** The canvas opens in PREVIEW by default, so editor flows enter Edit first
 * (the module-canvas suite's precedent). */
async function enterEditMode(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  if (screen.queryByTestId('canvas-preview') !== null) {
    await user.click(screen.getByTestId('canvas-preview-toggle'));
  }
  await screen.findByTestId('canvas-editor', {}, { timeout: 10_000 });
}

/** One deterministic doc edit through the live editor view (act-wrapped — the
 * page mirrors the doc into React state on every change). */
function editDoc(from: number, to: number, insert: string): void {
  const view = activeCanvasView.current;
  if (view === null) throw new Error('canvas editor view not mounted');
  act(() => {
    view.dispatch({ changes: { from, to, insert } });
  });
}

/** Seeds three ready parts with the given per-part ids (and the premise's). */
async function seedModule(premiseModel: string, partModels: readonly string[]): Promise<void> {
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
      writerModel: premiseModel,
    }),
    parts: PART_PLAN.map((_, planIndex) =>
      modulePartSchema.parse({
        planIndex,
        markdown: PART_TEXTS[planIndex],
        status: 'ready',
        errorMessage: '',
        edited: false,
        writerModel: partModels[planIndex] ?? '',
      }),
    ),
  });
  world = { campaignId: campaign.id, moduleId: draft.id };
}

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
  useCanvasLedgerStore.setState({ ownerModuleId: null, byPart: {} });
  useCanvasPreviewStore.setState({ ownerModuleId: null, openByModule: {} });
});

describe('the canvas footer names the writers (owner decision)', () => {
  it('shows ONE id when the premise and every part agree', async () => {
    await seedModule(MODEL_A, [MODEL_A, MODEL_A, MODEL_A]);
    renderCanvas();

    const footer = await screen.findByTestId('canvas-writer-model', {}, { timeout: 10_000 });
    expect(footer).toHaveAttribute('data-model', MODEL_A);
    expect(footer.textContent).toContain(MODEL_A);
    // One id, not a per-part list: unanimity is stated once.
    expect(screen.queryByTestId('canvas-writer-model-scope-part-0')).toBeNull();
    await flushAsyncUpdates();
  });

  it('lists each scope — including a NOT RECORDED one — when the parts disagree', async () => {
    await seedModule(MODEL_A, [MODEL_A, MODEL_B, '']);
    renderCanvas();

    const footer = await screen.findByTestId('canvas-writer-model', {}, { timeout: 10_000 });
    expect(footer).toHaveAttribute('data-model', 'mixed');
    // The premise and part 1 agree; part 2 is the other model; part 3 recorded
    // nothing — reported as such, never folded into a neighbour's id and never
    // replaced by a settings-derived guess.
    expect(screen.getByTestId('canvas-writer-model-scope-premise')).toHaveAttribute(
      'data-model',
      MODEL_A,
    );
    expect(screen.getByTestId('canvas-writer-model-scope-part-0')).toHaveAttribute(
      'data-model',
      MODEL_A,
    );
    expect(screen.getByTestId('canvas-writer-model-scope-part-1')).toHaveAttribute(
      'data-model',
      MODEL_B,
    );
    const unrecorded = screen.getByTestId('canvas-writer-model-scope-part-2');
    expect(unrecorded).toHaveAttribute('data-model', '');
    expect(unrecorded.textContent).toContain('Part 3');
    expect(unrecorded.textContent).toContain('not recorded');
    expect(footer.textContent).not.toContain('various');
    await flushAsyncUpdates();
  });

  it('renders NOTHING when no scope recorded a model (legacy module)', async () => {
    await seedModule('', ['', '', '']);
    renderCanvas();

    // The canvas itself is up, so the negative is not vacuous.
    expect(
      await screen.findByTestId('canvas-module-title', {}, { timeout: 10_000 }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-writer-model')).toBeNull();
    await flushAsyncUpdates();
  });
});

describe('the canvas preview captions each part', () => {
  it('shows a part id under the part text it belongs to', async () => {
    await seedModule(MODEL_A, [MODEL_A, MODEL_B, MODEL_B]);
    renderCanvas();

    // The canvas opens in preview: no toggle needed to see the captions.
    expect(await screen.findByTestId('canvas-preview-part-0', {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(await screen.findByTestId('canvas-preview-part-model-0')).toHaveAttribute(
      'data-model',
      MODEL_A,
    );
    expect(await screen.findByTestId('canvas-preview-part-model-1')).toHaveAttribute(
      'data-model',
      MODEL_B,
    );
    await flushAsyncUpdates();
  });

  it('renders no caption for a part with nothing recorded', async () => {
    await seedModule(MODEL_A, [MODEL_A, '', MODEL_A]);
    renderCanvas();

    expect(await screen.findByTestId('canvas-preview-part-0', {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(await screen.findByTestId('canvas-preview-part-model-0')).toBeInTheDocument();
    // Part 2 has no recorded id → no caption element at all.
    expect(screen.queryByTestId('canvas-preview-part-model-1')).toBeNull();
    await flushAsyncUpdates();
  });
});

describe('the ids never enter the module text', () => {
  it('keeps the doc, the parts and the assembled text free of every id while showing them', async () => {
    await seedModule(MODEL_A, [MODEL_A, MODEL_B, '']);
    const user = userEvent.setup();
    renderCanvas();

    // NON-VACUITY: the ids really are rendered on this screen — footer…
    const footer = await screen.findByTestId('canvas-writer-model', {}, { timeout: 10_000 });
    expect(footer).toHaveAttribute('data-model', 'mixed');
    expect(footer.textContent).toContain(MODEL_A);
    expect(footer.textContent).toContain(MODEL_B);
    // …and the preview (which the canvas opens in by default).
    expect(await screen.findByTestId('canvas-preview-part-model-0')).toHaveAttribute(
      'data-model',
      MODEL_A,
    );

    // Switch to Edit and read the LIVE editor document (CodeMirror).
    await enterEditMode(user);
    // 1. The editor document — the module text itself.
    const liveDoc = activeCanvasView.current?.state.doc.toString() ?? '';
    expect(liveDoc).not.toBe('');
    for (const model of ALL_MODELS) expect(liveDoc).not.toContain(model);
    expect(liveDoc).toBe(WHOLE_DOC);

    // 2. Everything a save could capture: the assembled text of the PERSISTED
    //    parts, and each part's own markdown.
    const row = await getModule(world.moduleId);
    if (row === undefined) throw new Error('module row missing');
    const assembled = assembleModulePartsDocument({
      partPlan: row.spine?.partPlan ?? [],
      parts: row.parts,
    }).document;
    for (const model of ALL_MODELS) {
      expect(assembled).not.toContain(model);
      for (const part of row.parts) expect(part.markdown).not.toContain(model);
    }
    expect(assembled).toBe(WHOLE_DOC);
    // The ids ARE on the rows — the exclusion is a placement rule, not a wipe.
    expect(row.spine?.writerModel).toBe(MODEL_A);
    expect(row.parts.map((part) => part.writerModel)).toEqual([MODEL_A, MODEL_B, '']);

    // 3. The per-part SECTION text the preview renders from: the caption is a
    //    sibling of this text, never part of it.
    for (const section of splitPartsDocument(liveDoc, PART_PLAN)) {
      for (const model of ALL_MODELS) expect(section.text).not.toContain(model);
    }
    await flushAsyncUpdates();
  });

  it('a hand edit still saves no id anywhere in the text', async () => {
    await seedModule(MODEL_A, [MODEL_A, MODEL_B, '']);
    renderCanvas();

    const user = userEvent.setup();
    // The footer is visible in PREVIEW (the default mode)…
    expect(
      await screen.findByTestId('canvas-writer-model', {}, { timeout: 10_000 }),
    ).toHaveAttribute('data-model', 'mixed');
    await enterEditMode(user);
    // …and stays visible in EDIT — the mode the owner actually works in, which
    // is why the caption lives in the footer rather than inside the preview.
    expect(screen.getByTestId('canvas-writer-model')).toBeInTheDocument();
    // A hand edit in a PART (never the scaffolding) then the real save path.
    editDoc(PART0_FROM, PART0_FROM + 3, 'XXX');
    const save = await screen.findByTestId('canvas-save', {}, { timeout: 10_000 });
    expect(save).toBeEnabled();
    act(() => {
      save.click();
    });
    await waitFor(
      () => {
        expect(screen.getByTestId('canvas-saved-indicator')).toHaveTextContent('Saved');
      },
      { timeout: 10_000 },
    );

    const row = await getModule(world.moduleId);
    if (row === undefined) throw new Error('module row missing');
    // The edit landed…
    expect(row.parts[0]?.markdown).toContain('XXX');
    // …it carried no id into the text, and it did not erase the recorded one
    // (owner decision 2: the owner's edits never clear who wrote the text).
    for (const part of row.parts) {
      for (const model of ALL_MODELS) expect(part.markdown).not.toContain(model);
    }
    expect(row.parts[0]?.writerModel).toBe(MODEL_A);
    await flushAsyncUpdates();
  });
});
