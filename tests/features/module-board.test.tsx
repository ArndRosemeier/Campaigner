import 'fake-indexeddb/auto';

import { act, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
import { boardPath } from '@/app/routes';
import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { getModule, saveModule } from '@/db/moduleRepo';
import {
  CANVAS_PREMISE_NODE_KEY,
  canvasPartNodeKey,
  canvasPriorModuleNodeKey,
  createModule,
  modulePartSchema,
  moduleSpineSchema,
  type Campaign,
  type Id,
  type Module,
} from '@/domain';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';
import { useBoardStore } from '@/features/modules/board/boardStore';
import {
  deriveContinuityEdges,
  BOARD_CONTINUITY_EDGE_CAP,
} from '@/features/modules/board/boardEdges';
import {
  resolveBoardNodePositions,
  seedBoardNodePositions,
} from '@/features/modules/board/boardLayout';

/**
 * Whole-module board — SUBSTRATE (08-MODULE-DESIGNER §Module board,
 * commit 1): cards render the plan×part JOIN, prior modules render as
 * read-only text groups in createdAt ASC order with per-module chip
 * resolution, LOD switches at the zoom threshold, node keys are stable, and
 * the layout round-trips through the module row's `canvas` field.
 */

const MODULE_TITLE = 'The Drowned Vault';

const PREMISE = 'The party is hired to recover a drowned relic from the [[Old Tower]].';

const PART_0_TEXT =
  'The party bargains with [[Keeper Ilse]] at the gate while the [[Ember Key]] glows.';
const PART_1_TEXT = 'Below the tower, the [[Ember Key]] opens the flooded door.';

function renderAppAt(path: string): ReturnType<typeof render> {
  window.history.replaceState(null, '', path);
  return render(<RouterProvider router={createAppRouter()} />);
}

let seq = 0;

async function seedModuleRow(input: {
  campaignId: Id;
  title: string;
  premise: string;
  partTexts: string[];
  createdAt?: number;
}): Promise<Module> {
  seq += 1;
  const draft = createModule({
    campaignId: input.campaignId,
    title: input.title,
    concept: `concept ${String(seq)}`,
    levelMin: 1,
    levelMax: 3,
    tone: '',
    sizeDial: 'standard',
  });
  const spine = moduleSpineSchema.parse({
    premise: input.premise,
    themes: [],
    partPlan: input.partTexts.map((_, index) => ({
      title: `Part ${String(index + 1)} plan`,
      levelBand: String(index + 1),
      synopsis: `synopsis ${String(index + 1)}`,
      levelUpTrigger: `trigger ${String(index + 1)}`,
    })),
  });
  const parts = input.partTexts.map((text, index) =>
    modulePartSchema.parse({ planIndex: index, markdown: text, status: 'ready', errorMessage: '', edited: false }),
  );
  const row: Module = { ...draft, spine, parts, createdAt: input.createdAt ?? draft.createdAt };
  return saveModule(row);
}

interface World {
  campaign: Campaign;
  campaignId: Id;
  moduleId: Id;
  priorAId: Id;
  priorBId: Id;
  emberKeyModuleOwnedId: Id;
  emberKeyCampaignOwnedId: Id;
}

/** Seeds two prior modules + the current module with shared wiki-names. */
async function seedBoardWorld(): Promise<World> {
  const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
  // Same NAME in two scopes: module-owned (prior module A) vs campaign-owned
  // (created LAST, so within the campaign tier it wins on updatedAt).
  const priorA = await seedModuleRow({
    campaignId: campaign.id,
    title: 'Ashes of the Ford',
    premise: 'Earlier: the ford burned. [[Ember Key]] was forged.',
    partTexts: ['The party doused the fires with the [[Ember Key]].'],
    createdAt: 1000,
  });
  const emberKeyModuleOwned = await createArtifact({
    campaignId: campaign.id,
    moduleId: priorA.id,
    kind: 'note',
    name: 'Ember Key',
    summary: 'The module-owned Ember Key of module A.',
  });
  const emberKeyCampaignOwned = await createArtifact({
    campaignId: campaign.id,
    kind: 'note',
    name: 'Ember Key',
    summary: 'The campaign-level Ember Key.',
  });
  const priorB = await seedModuleRow({
    campaignId: campaign.id,
    title: 'Saltmarsh Smoke',
    premise: 'Later: smoke over the marsh.',
    partTexts: ['The [[Ember Key]] changes hands again.'],
    createdAt: 2000,
  });
  const current = await seedModuleRow({
    campaignId: campaign.id,
    title: MODULE_TITLE,
    premise: PREMISE,
    partTexts: [PART_0_TEXT, PART_1_TEXT],
    createdAt: 3000,
  });
  return {
    campaign,
    campaignId: campaign.id,
    moduleId: current.id,
    priorAId: priorA.id,
    priorBId: priorB.id,
    emberKeyModuleOwnedId: emberKeyModuleOwned.id,
    emberKeyCampaignOwnedId: emberKeyCampaignOwned.id,
  };
}

// jsdom's zero-size elements keep React Flow from measuring nodes (edges
// would never render). File-scoped firing stub: observe() reports a fixed
// content rect once, so node/edge measurement behaves like a real browser.
class FiringResizeObserver {
  private callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element): void {
    const rect = { width: 420, height: 200, x: 0, y: 0, top: 0, left: 0, right: 420, bottom: 200, toJSON: () => ({}) } as DOMRectReadOnly;
    // Deferred like a real observer: the callback must run AFTER the mount
    // effects that register React Flow's container refs.
    setTimeout(() => {
      this.callback([{ target, contentRect: rect } as ResizeObserverEntry], this);
    }, 0);
  }
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  unobserve(): void {}
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  disconnect(): void {}
}

// jsdom is layout-less: offsetWidth/offsetHeight/getBoundingClientRect are
// all zero, so React Flow would never measure nodes (and edges would never
// render). File-scoped: fixed dimensions + an observe() that fires once.
// React Flow reads the viewport transform with DOMMatrixReadOnly in
// updateNodeInternals; jsdom has no Web-Animations/DOMMatrix API at all.
beforeEach(() => {
  class DOMMatrixReadOnlyStub {
    m22 = 1;
    constructor(_transform?: string) {
      void _transform;
    }
  }
  const stubbed = DOMMatrixReadOnlyStub as unknown as typeof DOMMatrixReadOnly;
  globalThis.DOMMatrixReadOnly = stubbed;
  window.DOMMatrixReadOnly = stubbed;
});

beforeEach(() => {
  // jsdom has no SVG layout: edge labels measure themselves with getBBox.
  if (typeof SVGElement !== 'undefined' && !('getBBox' in SVGElement.prototype)) {
    Object.defineProperty(SVGElement.prototype, 'getBBox', {
      configurable: true,
      value: () => ({ x: 0, y: 0, width: 10, height: 10 }),
    });
  }
  for (const property of ['offsetWidth', 'clientWidth'] as const) {
    Object.defineProperty(HTMLElement.prototype, property, { configurable: true, get: () => 420 });
  }
  for (const property of ['offsetHeight', 'clientHeight'] as const) {
    Object.defineProperty(HTMLElement.prototype, property, { configurable: true, get: () => 200 });
  }
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({
      width: 420,
      height: 200,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 420,
      bottom: 200,
      toJSON: () => ({}),
    }),
  );
});

beforeEach(async () => {
  await clearDatabase();
  useBoardStore.getState().resetFor('reset');
  seq = 0;
  globalThis.ResizeObserver = FiringResizeObserver;
});

describe('module board substrate', () => {
  it('renders premise + part cards (plan×part JOIN) and prior groups in createdAt ASC order', async () => {
    const world = await seedBoardWorld();
    renderAppAt(boardPath(world.campaignId, world.moduleId));

    const premiseCard = await screen.findByTestId('board-premise-card', {}, { timeout: 10_000 });
    expect(premiseCard).toHaveTextContent(MODULE_TITLE);
    expect(screen.getByTestId('board-premise-body')).toHaveTextContent('drowned relic');

    const part0 = screen.getByTestId('board-part-0');
    expect(part0).toHaveTextContent('Part 1 plan');
    expect(part0).toHaveTextContent('Levels 1');
    expect(within(part0).getByTestId('board-part-body')).toHaveTextContent('Keeper Ilse');
    expect(screen.getByTestId('board-part-1')).toHaveTextContent('Part 2 plan');

    // Prior groups: ASC by createdAt — A (1000) before B (2000) in the DOM.
    const priorA = screen.getByTestId(`board-prior-${world.priorAId}`);
    const priorB = screen.getByTestId(`board-prior-${world.priorBId}`);
    expect(priorA).toHaveTextContent('Ashes of the Ford');
    expect(priorB).toHaveTextContent('Saltmarsh Smoke');
    expect(
      priorA.compareDocumentPosition(priorB) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('resolves wiki chips with each module’s OWN tier-0 context', async () => {
    const world = await seedBoardWorld();
    renderAppAt(boardPath(world.campaignId, world.moduleId));

    await screen.findByTestId('board-premise-card', {}, { timeout: 10_000 });
    // Module A owns "Ember Key": inside A's group the chip resolves to the
    // module-owned row (tier-0 beats the newer campaign-level row).
    const chipInA = withinPrior(world.priorAId, 'Ember Key');
    expect(chipInA).toHaveAttribute('data-wiki-artifact-id', world.emberKeyModuleOwnedId);
    // Module B does not own it: the same name resolves to the campaign-level
    // row there — per-module context, not one global answer.
    const chipInB = withinPrior(world.priorBId, 'Ember Key');
    expect(chipInB).toHaveAttribute('data-wiki-artifact-id', world.emberKeyCampaignOwnedId);
  });

  it('keeps prior groups read-only: chips are inert (no peek modal, no stub popover)', async () => {
    const world = await seedBoardWorld();
    renderAppAt(boardPath(world.campaignId, world.moduleId));

    await screen.findByTestId('board-premise-card', {}, { timeout: 10_000 });
    const chipInA = withinPrior(world.priorAId, 'Ember Key');
    fireEvent.click(chipInA);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // The current module's chips are equally inert on the board (TEXT-ONLY
    // v1: entity actions are deferred).
    const currentChips = screen.getAllByTestId('wiki-chip');
    for (const chip of currentChips) {
      fireEvent.click(chip);
    }
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('switches between full markdown and skeleton cards at the LOD zoom threshold', async () => {
    const world = await seedBoardWorld();
    renderAppAt(boardPath(world.campaignId, world.moduleId));

    await screen.findByTestId('board-premise-card', {}, { timeout: 10_000 });
    expect(screen.getByTestId('board-premise-card')).toHaveAttribute('data-lod', 'full');
    expect(screen.getByTestId('board-part-0')).toHaveAttribute('data-lod', 'full');
    expect(within(screen.getByTestId('board-part-0')).getByTestId('board-part-body')).toBeInTheDocument();

    actSetZoom(0.4);
    expect(screen.getByTestId('board-premise-card')).toHaveAttribute('data-lod', 'skeleton');
    expect(screen.getByTestId('board-part-0')).toHaveAttribute('data-lod', 'skeleton');
    expect(screen.queryByTestId('board-part-body')).not.toBeInTheDocument();
    // The skeleton keeps title/band/status.
    expect(screen.getByTestId('board-part-0')).toHaveTextContent('Part 1 plan');

    actSetZoom(1);
    expect(within(screen.getByTestId('board-part-0')).getByTestId('board-part-body')).toBeInTheDocument();
  });

  it('uses the stable node keys (premise, part-<planIndex>, prior-<moduleId>)', async () => {
    const world = await seedBoardWorld();
    renderAppAt(boardPath(world.campaignId, world.moduleId));

    await screen.findByTestId('board-premise-card', {}, { timeout: 10_000 });
    const nodeIds = [...document.querySelectorAll('.react-flow__node')].map(
      (element) => element.getAttribute('data-id'),
    );
    expect(nodeIds).toContain(CANVAS_PREMISE_NODE_KEY);
    expect(nodeIds).toContain(canvasPartNodeKey(0));
    expect(nodeIds).toContain(canvasPartNodeKey(1));
    expect(nodeIds).toContain(canvasPriorModuleNodeKey(world.priorAId));
    expect(nodeIds).toContain(canvasPriorModuleNodeKey(world.priorBId));
  });

  it('round-trips the layout through patchModule (drags persist, reload honors the row)', async () => {
    const world = await seedBoardWorld();
    const view = renderAppAt(boardPath(world.campaignId, world.moduleId));
    await screen.findByTestId('board-premise-card', {}, { timeout: 10_000 });

    // Drag part-0 by (+80, +40) — React Flow owns the gesture (d3-drag on
    // the node wrapper); the debounced persist lands through patchModule.
    const nodeElement = document.querySelector('.react-flow__node[data-id="part-0"]');
    if (nodeElement === null) throw new Error('part-0 node element not found');
    act(() => {
      dragNode(nodeElement, { x: 100, y: 100 }, { x: 180, y: 140 });
    });
    await flushAsyncUpdates();

    await waitFor(
      async () => {
        const row = await getModule(world.moduleId);
        if (row === undefined) throw new Error('module row vanished');
        if (row.canvas === null) throw new Error('board layout not persisted yet');
        const part0 = row.canvas.nodes.find((node) => node.key === canvasPartNodeKey(0));
        if (part0 === undefined) throw new Error('part-0 position not persisted yet');
        // Seed x (spine column) + 80px drag, y (row 1) + 40px drag.
        expect(part0.x).toBeGreaterThan(500);
        expect(part0.y).toBeGreaterThan(500);
      },
      { timeout: 5_000 },
    );

    // The persisted layout wins on the next mount (reload semantics).
    await flushAsyncUpdates();
    view.unmount();
    renderAppAt(boardPath(world.campaignId, world.moduleId));
    await screen.findByTestId('board-premise-card', {}, { timeout: 10_000 });
    const persisted = await getModule(world.moduleId);
    expect(persisted?.canvas?.zoom).toBeTypeOf('number');
    const nodeElement2 = document.querySelector<HTMLElement>('.react-flow__node[data-id="part-0"]');
    expect(nodeElement2).not.toBeNull();
    expect(nodeElement2?.style.transform).toContain('translate');
  });

  it('draws continuity edges for names shared between prior groups and the current module', async () => {
    const world = await seedBoardWorld();
    renderAppAt(boardPath(world.campaignId, world.moduleId));
    // "Ember Key" appears in both prior groups AND the current module's parts
    // → at least one prior→current edge.
    await screen.findByTestId('board-premise-card', {}, { timeout: 10_000 });
    await waitFor(
      () => {
        expect(document.querySelectorAll('.react-flow__edge').length).toBeGreaterThan(0);
      },
      { timeout: 5_000 },
    );
  });
});

// --- pure layout + edges ------------------------------------------------------

describe('board layout seeds', () => {
  it('seeds deterministic positions and lets persisted positions win', () => {
    const seeds = seedBoardNodePositions({ planCount: 2, priorModuleIds: ['a', 'b'] });
    expect(seeds[CANVAS_PREMISE_NODE_KEY]).toBeDefined();
    expect(seeds[canvasPartNodeKey(0)]).toBeDefined();
    expect(seeds[canvasPriorModuleNodeKey('b')]).toBeDefined();
    // Prior column sits left of the current spine.
    const priorSeedX = seeds[canvasPriorModuleNodeKey('a')]?.x ?? 0;
    const premiseSeedX = seeds[CANVAS_PREMISE_NODE_KEY]?.x ?? 0;
    expect(priorSeedX).toBeLessThan(premiseSeedX);

    const persisted = resolveBoardNodePositions(
      [{ key: canvasPartNodeKey(1), x: -50, y: 700 }],
      seeds,
    );
    expect(persisted[canvasPartNodeKey(1)]).toEqual({ x: -50, y: 700 });
    expect(persisted[canvasPartNodeKey(0)]).toEqual(seeds[canvasPartNodeKey(0)]);
  });
});

describe('deriveContinuityEdges', () => {
  it('connects a prior group to current cards sharing a canonical name and caps honestly', () => {
    const current = {
      id: 'm-current' as Id,
      title: 'Current',
      spine: {
        premise: 'Now: [[Alpha]] and [[Beta]] return.',
        themes: [],
        partPlan: [
          { title: 'P0', levelBand: '1', synopsis: '', levelUpTrigger: '' },
          { title: 'P1', levelBand: '2', synopsis: '', levelUpTrigger: '' },
        ],
      },
      parts: [
        modulePartSchema.parse({ planIndex: 0, markdown: '[[Alpha]] strikes.', status: 'ready', errorMessage: '', edited: false }),
        modulePartSchema.parse({ planIndex: 1, markdown: '[[Beta]] waits.', status: 'ready', errorMessage: '', edited: false }),
      ],
    };
    const prior = {
      id: 'm-prior' as Id,
      title: 'Prior',
      spine: {
        premise: 'Before: [[Alpha]] began.',
        themes: [],
        partPlan: [{ title: 'Old', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
      },
      parts: [
        modulePartSchema.parse({ planIndex: 0, markdown: '[[Beta]] appeared.', status: 'ready', errorMessage: '', edited: false }),
      ],
    };
    const { edges, truncated } = deriveContinuityEdges({
      module: current as unknown as Module,
      priorModules: [prior as unknown as Module],
      pool: [],
    });
    expect(truncated).toBe(0);
    const sources = edges.map((edge) => edge.source);
    expect(sources).toContain(canvasPriorModuleNodeKey('m-prior'));
    expect(edges.every((edge) => edge.target.startsWith('part-') || edge.target === CANVAS_PREMISE_NODE_KEY)).toBe(
      true,
    );

    // Cap: edges merge per (prior group, current doc) pair, so the cap
    // truncates across PAIRS — 7 priors × 2 current docs = 14 pairs.
    const wideCurrent = {
      id: 'm-current' as Id,
      title: 'Wide current',
      spine: {
        premise: '[[Bridge]] ties the story together.',
        themes: [],
        partPlan: [
          { title: 'P0', levelBand: '1', synopsis: '', levelUpTrigger: '' },
          { title: 'P1', levelBand: '2', synopsis: '', levelUpTrigger: '' },
        ],
      },
      parts: [
        modulePartSchema.parse({ planIndex: 0, markdown: '[[Harbor]] hosts the aftermath.', status: 'ready', errorMessage: '', edited: false }),
        modulePartSchema.parse({ planIndex: 1, markdown: '', status: 'pending', errorMessage: '', edited: false }),
      ],
    };
    const priors = Array.from({ length: 7 }, (_, index) => ({
      id: `m-prior-${String(index)}`,
      title: `Prior ${String(index)}`,
      spine: {
        premise: `[[Bridge]] began here in ${String(index)}.`,
        themes: [],
        partPlan: [{ title: 'Old', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
      },
      parts: [
        modulePartSchema.parse({ planIndex: 0, markdown: `[[Harbor]] saw it first in ${String(index)}.`, status: 'ready', errorMessage: '', edited: false }),
      ],
    }));
    const capped = deriveContinuityEdges({
      module: wideCurrent as unknown as Module,
      priorModules: priors as unknown as Module[],
      pool: [],
    });
    expect(capped.edges).toHaveLength(BOARD_CONTINUITY_EDGE_CAP);
    expect(capped.truncated).toBe(2);
  });
});

// --- helpers --------------------------------------------------------------------

function withinPrior(priorModuleId: Id, name: string): HTMLElement {
  const group = screen.getByTestId(`board-prior-${priorModuleId}`);
  const chip = [...group.querySelectorAll<HTMLElement>('[data-testid="wiki-chip"]')].find(
    (element) => element.getAttribute('data-wiki-name') === name,
  );
  if (chip === undefined) throw new Error(`chip "${name}" not found in prior group`);
  return chip;
}

function actSetZoom(zoom: number): void {
  act(() => {
    useBoardStore.getState().setZoom(zoom);
  });
}

// --- jsdom gesture plumbing ---------------------------------------------------
//
// d3-drag (React Flow's drag engine) attaches its move/up listeners to
// `event.view` and immediately calls `nodrag(event.view)` — which reads
// `view.document.documentElement`. jsdom's Window fails its OWN brand check
// when passed back through a MouseEvent constructor (vitest wraps the
// global), so a synthetic view object is the only way to drive the gesture.
// The helper registers d3's listeners for real (addEventListener keyed by
// bare event type — d3-selection strips the `.drag` namespace) and feeds
// them directly; two moves are needed (the first starts the drag).

interface FakeView {
  document: { documentElement: { style: Record<string, string> } };
  addEventListener: (type: string, listener: EventListener) => void;
  removeEventListener: (type: string, listener: EventListener) => void;
  dispatch: (type: string, event: Event) => void;
}

function makeFakeView(): FakeView {
  const listeners = new Map<string, EventListener[]>();
  const view: FakeView = {
    document: { documentElement: { style: {} } },
    addEventListener: (type, listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener: (type, listener) => {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((entry) => entry !== listener),
      );
    },
    dispatch: (type, event) => {
      // d3's contextListener reads `this.__data__` — invoke with the view.
      for (const listener of listeners.get(type) ?? []) listener.call(view, event);
    },
  };
  return view;
}

function dragNode(
  nodeElement: Element,
  from: { x: number; y: number },
  to: { x: number; y: number },
): void {
  const fake = makeFakeView();
  const down = createEvent.mouseDown(nodeElement, { button: 0, clientX: from.x, clientY: from.y });
  Object.defineProperty(down, 'view', { value: fake, configurable: true });
  fireEvent(nodeElement, down);
  const midX = Math.round((from.x + to.x) / 2);
  const midY = Math.round((from.y + to.y) / 2);
  const move = (x: number, y: number): MouseEvent => {
    const event = new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true });
    Object.defineProperty(event, 'view', { value: fake, configurable: true });
    return event;
  };
  fake.dispatch('mousemove', move(midX, midY));
  fake.dispatch('mousemove', move(to.x, to.y));
  const up = new MouseEvent('mouseup', { clientX: to.x, clientY: to.y, bubbles: true });
  Object.defineProperty(up, 'view', { value: fake, configurable: true });
  fake.dispatch('mouseup', up);
}
