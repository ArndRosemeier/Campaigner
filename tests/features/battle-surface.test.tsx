import 'fake-indexeddb/auto';

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { createArtifact, getAnyArtifact, listArtifactsByCampaign, updateArtifact } from '@/db/artifactRepo';
import { toastError, toastSuccess } from '@/lib/toast';
import { db } from '@/db/db';
import {
  ensureBattle,
  getBattleByModule,
  saveBattleBoard,
  saveBattleStage,
} from '@/db/battleRepo';
import type * as battleRepoModule from '@/db/battleRepo';
import type * as toastModule from '@/lib/toast';
import type { Battle, EncounterLayout, StatBlock } from '@/domain';
import { seedBattleFromEncounter } from '@/db/battleSeed';
import { createCampaign } from '@/db/campaignRepo';
import { createImage } from '@/db/imageRepo';
import { createModule, newId, packRooms, statBlockSchema } from '@/domain';
import { createModule as saveModule } from '@/db/moduleRepo';
import { BattleSurface } from '@/features/play/battle/BattleSurface';
import { battleGridStyle } from '@/domain/battle/gridSnap';
import { isBoardGestureActive } from '@/domain/battle/gestureGate';
import { clearDatabase } from '../db/helpers';
import { actDrained, flushAsyncUpdates } from '../helpers/flush';

// Wrap (not replace) saveBattleBoard so veil-drag tests can count commits —
// zero writes while a drag is live, exactly one on release. Every other test
// keeps the real behavior.
vi.mock('@/db/battleRepo', async (importOriginal) => {
  const actual = await importOriginal<typeof battleRepoModule>();
  return { ...actual, saveBattleBoard: vi.fn(actual.saveBattleBoard) };
});

// Observe loud user feedback (removal toasts) without rendering a Toaster:
// the wrappers call through to the real implementation AND record calls.
vi.mock('@/lib/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof toastModule>();
  return {
    ...actual,
    toastError: vi.fn(actual.toastError),
    toastErrorPersistent: vi.fn(actual.toastErrorPersistent),
    toastInfo: vi.fn(actual.toastInfo),
    toastSuccess: vi.fn(actual.toastSuccess),
  };
});

// Stub the dice roller (its own engine/UX is covered by dice-roller tests):
// here it only has to prove the integration boundary — the surface opens it
// with the captured intent and applies the settled total signed by intent.
vi.mock('@/features/dice/DiceRoller', () => ({
  DiceRoller: function StubDiceRoller(props: {
    open: boolean;
    intent?: { kind: string; subject?: string } | undefined;
    onOpenChange?: (open: boolean) => void;
    onResult?: (result: { total: number; summary: string; perDie: number[] }) => void;
  }) {
    if (!props.open) return null;
    return (
      <div data-testid="dice-roller-stub">
        <span data-testid="stub-intent-kind">{props.intent?.kind ?? 'none'}</span>
        <span data-testid="stub-intent-subject">{props.intent?.subject ?? ''}</span>
        <button
          type="button"
          data-testid="stub-apply-roll"
          onClick={() => props.onResult?.({ total: 7, summary: '2d6+1', perDie: [3, 4] })}
        >
          apply-7
        </button>
        <button type="button" data-testid="stub-close-roll" onClick={() => props.onOpenChange?.(false)}>
          close-without-rolling
        </button>
      </div>
    );
  },
}));

/**
 * The table surface (09-MILESTONE-5 M5-D): the player-safe DOM contract,
 * drag commits, initiative reconcile (fog coverage), and HP ownership split
 * writes. The acceptance criteria of the milestone live here.
 */

const BOARD_W = 800;
const BOARD_H = 600;
// The aspect-fitted content div: 800 wide at the fallback 16:9 aspect → 450
// high, letterboxed 75px top/bottom inside the 600-high container. The board
// frame the surface converts pointers against and snaps in.
const CONTENT_H = 450;
const CONTENT_TOP = 75;

/**
 * The container rect (the outer board div) and the content div's rect, as the
 * browser would report them at zoom 1 / pan 0. Tests mutate `contentRect` to
 * simulate a transformed content element (zoom/pan) — the surface must then
 * convert pointers against THIS rect, not the container's.
 */
const containerRect = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  bottom: BOARD_H,
  right: BOARD_W,
  width: BOARD_W,
  height: BOARD_H,
  toJSON: () => ({}),
};
let contentRect = {
  x: 0,
  y: CONTENT_TOP,
  top: CONTENT_TOP,
  left: 0,
  bottom: CONTENT_TOP + CONTENT_H,
  right: BOARD_W,
  width: BOARD_W,
  height: CONTENT_H,
  toJSON: () => ({}),
};

/** Post-transform content rect for a zoom/pan, per the surface's CSS
 * (`translate(pan) scale(zoom)`, origin center of the 800×600 container). */
function transformedContentRect(zoom: number, pan: { x: number; y: number }): typeof contentRect {
  return {
    x: 400 + (0 - 400) * zoom + pan.x,
    y: 300 + (CONTENT_TOP - 300) * zoom + pan.y,
    top: 300 + (CONTENT_TOP - 300) * zoom + pan.y,
    left: 400 + (0 - 400) * zoom + pan.x,
    bottom: 300 + (CONTENT_TOP - 300) * zoom + pan.y + CONTENT_H * zoom,
    right: 400 + (0 - 400) * zoom + pan.x + BOARD_W * zoom,
    width: BOARD_W * zoom,
    height: CONTENT_H * zoom,
    toJSON: () => ({}),
  };
}

function statBlock(over: Partial<StatBlock> = {}): StatBlock {
  return statBlockSchema.parse({
    system: 'dnd5e',
    level: '1',
    size: 'Medium',
    creatureType: 'humanoid',
    ac: 12,
    acNote: '',
    hp: 10,
    hpFormula: '',
    speed: '30 ft.',
    abilities: { str: 10, dex: 14, con: 12, int: 10, wis: 10, cha: 10 },
    saves: '',
    skills: '',
    senses: '',
    languages: '',
    cr: '1/2',
    proficiency: 2,
    traits: [],
    actions: [],
    reactions: [],
    legendary: [],
    extras: {},
    ...over,
  });
}

let campaignId = '';

// The GM-only key/treasure strings the player-safe DOM contract pins as
// ABSENT from `document.body` — module scope because `seedKeyedBattle`
// (the keyed-room seed helper) also reads them.
const KEY_TEXT = 'Cracked doors hang off one hinge.';
const KEY_TREASURE = 'Fallen banner: 15 gp';
const MOB_TREASURE = 'Pouch: 5 gp, a bone key';

class ResizeObserverStub {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(element: Element): void {
    // Per-element layout rects: the board container and the aspect-fitted
    // content div report DIFFERENT frames (the letterbox lives between them;
    // ResizeObserver ignores transforms, so contentRect stays the layout box
    // even when a test transforms `contentRect` for pointer conversion).
    const rect =
      element.getAttribute('data-board-content') === 'true'
        ? { width: contentRect.width, height: contentRect.height }
        : { width: BOARD_W, height: BOARD_H };
    // Report the fixed test viewport on a microtask, inside act — the board
    // mounts only after the battle row's liveQuery resolves.
    queueMicrotask(() => {
      act(() => {
        this.callback([{ contentRect: rect } as ResizeObserverEntry], this);
      });
    });
  }
  /* eslint-disable @typescript-eslint/no-empty-function */
  unobserve(): void {}
  disconnect(): void {}
  /* eslint-enable @typescript-eslint/no-empty-function */
}

beforeEach(async () => {
  await clearDatabase();
  contentRect = {
    x: 0,
    y: CONTENT_TOP,
    top: CONTENT_TOP,
    left: 0,
    bottom: CONTENT_TOP + CONTENT_H,
    right: BOARD_W,
    width: BOARD_W,
    height: CONTENT_H,
    toJSON: () => ({}),
  };
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  // jsdom reports zero rects; the surface needs real frames. The content div
  // gets its own (letterboxed) rect — the surface must convert pointers
  // against the content frame, not the container's.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ) {
    return this.getAttribute('data-board-content') === 'true'
      ? { ...contentRect }
      : { ...containerRect };
  });
  campaignId = (await createCampaign({ name: 'Battle UI', system: 'dnd5e' })).id;
});

afterEach(async () => {
  await flushAsyncUpdates(20);
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function addPc(name: string, currentHp: number): Promise<string> {
  const pc = await createArtifact({
    campaignId,
    kind: 'pc',
    name,
    data: {
      playerName: '',
      statBlock: statBlock({ hp: 20 }),
      currentHp,
      initiativeOverride: null,
      notes: '',
    },
  });
  return pc.id;
}

async function seedStandardBattle(): Promise<{ moduleId: string; encounterId: string; npcId: string; pc1: string }> {
  const pc1 = await addPc('Serren', 20);
  await addPc('Mira', 12);
  const npc = await createArtifact({
    campaignId,
    kind: 'npc',
    name: 'Troll',
    data: {
      appearance: '',
      personality: '',
      statBlock: statBlock({ hp: 84 }),
    },
  });
  const encounter = await createArtifact({
    campaignId,
    kind: 'encounter',
    name: 'Bridge ambush',
    data: {
      difficulty: 'deadly',
      levelHint: '5',
      monsters: [{ name: 'Troll', count: 1, notes: '', treasure: '', source: { type: 'npc-ref', artifactId: npc.id } }],
      terrain: '',
      tactics: 'Regenerates — a GM tactic note.',
      treasure: '',
      mapImageId: null,
      layout: null,
      preset: 'standard',
      locationKind: 'other',
      siteShape: 'single',
      budgetAdvisory: '',
    },
  });
  const module = await saveModule(
    createModule({
      campaignId,
      title: 'Battle Module',
      concept: '',
      levelMin: 1,
      levelMax: 5,
      sizeDial: 'sketch',
    }),
  );
  await seedBattleFromEncounter(campaignId, module.id, encounter.id);
  return { moduleId: module.id, encounterId: encounter.id, npcId: npc.id, pc1 };
}

async function renderSurface(moduleId: string): Promise<void> {
  render(
    <MemoryRouter initialEntries={[`/c/${campaignId}/m/${moduleId}/battle`]}>
      <Routes>
        <Route path="/c/:campaignId/m/:moduleId/battle" element={<BattleSurface />} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => {
    expect(screen.getByTestId('battle-board')).toBeInTheDocument();
  });
  await flushAsyncUpdates(20);
}

/**
 * Live-drag frames (batch H throttle): the surface coalesces pointermove
 * renders to requestAnimationFrame, so a mid-drag position only reaches the
 * DOM after a frame. The drag's own frame is always scheduled BEFORE this
 * waiter frame, so one call lands it deterministically. Release/commit paths
 * flush the queue synchronously and need no helper — only assertions that
 * read the piece's LIVE position do.
 */
async function flushDragFrames(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  });
}

/**
 * The battle-row read runs inside ONE act with a drain (actDrained, docs/08
 * §Console guard) — for EVERY caller: a bare `await currentBattle()` while
 * the surface is mounted hands fake-indexeddb's timed queue an outside-act
 * window, and a token's image liveQuery that (re)subscribed when a late
 * cascade landed emits its subscribe-time query there (dispatch + re-render
 * outside act — the intermittent act-leak class: first caught in 'tap shows
 * the card…', again in 'GM view: tapping a treasure-carrying token…' under
 * full-suite load). The helper absorbs the window so call sites stay plain
 * awaits; reads are safe to wrap (the spanning-act caveat applies to paired
 * fireEvent pointer sequences, which stay bare everywhere).
 */
async function currentBattle(moduleId: string) {
  const battle = await actDrained(async () => {
    const row = await getBattleByModule(moduleId);
    if (row === undefined) throw new Error('battle row missing');
    return row;
  });
  return battle;
}

/** A battle seeded from an encounter WITH a layout (2 keyed rooms) and a
 *  treasure-carrying roster row. packRooms keeps attempt-0 order. */
async function seedKeyedBattle(): Promise<{ moduleId: string; encounterId: string }> {
  const pc1 = await addPc('Serren', 20);
  void pc1;
  const roomA = newId();
  const roomB = newId();
  const layout = packRooms({
    theme: 'Ash temple',
    aspect: '4:3',
    entryRoomId: roomA,
    rosterCounts: [1],
    rooms: [
      {
        id: roomA,
        name: 'Entry',
        description: '',
        size: 'small',
        monsterIndexes: [],
        adjacentRoomIds: [roomB],
        key: KEY_TEXT,
        keyTreasure: KEY_TREASURE,
      },
      {
        id: roomB,
        name: 'Sanctum',
        description: '',
        size: 'medium',
        monsterIndexes: [0],
        adjacentRoomIds: [roomA],
        key: '',
        keyTreasure: '',
      },
    ],
  });
  const encounter = await createArtifact({
    campaignId,
    kind: 'encounter',
    name: 'Temple ambush',
    data: {
      difficulty: 'hard',
      levelHint: '4',
      monsters: [{ name: 'Cultist', count: 1, notes: '', treasure: MOB_TREASURE, source: { type: 'inline', statBlock: statBlock({ hp: 22 }) } }],
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: null,
      layout,
      preset: 'standard',
      locationKind: 'other',
      siteShape: 'complex',
      budgetAdvisory: '',
    },
  });
  const module = await saveModule(
    createModule({ campaignId, title: 'Keyed Module', concept: '', levelMin: 1, levelMax: 5, sizeDial: 'sketch' }),
  );
  await seedBattleFromEncounter(campaignId, module.id, encounter.id);
  return { moduleId: module.id, encounterId: encounter.id };
}

describe('layout-anchored grid rendering', () => {
  it('uses normalized layout tracks rather than fixed CSS pixels', () => {
    expect(battleGridStyle({ cols: 24, rows: 18 }, 72)).toMatchObject({
      backgroundSize: `${String(100 / 24)}% ${String(100 / 18)}%`,
    });
    expect(battleGridStyle(null, 72).backgroundImage).toContain('72px');
  });
});

/**
 * Regression pin (deployed-bundle crash `Cannot read properties of undefined
 * (reading 'find')` on the Battle table button): the battle route must render
 * a row written by an OLDER app version — one whose board predates later-arc
 * fields (effects, mapLayout, entrance, everLive, reseed, token treasure).
 * The row is inserted raw (only the fields an old board had); the surface
 * renders it, the stamp token shows, and no render throws.
 */
describe('legacy battle row (pre-effects board)', () => {
  it('renders a board written before the later-arc fields existed', async () => {
    const moduleId = newId();
    const stamp = Date.now();
    // Stored RAW (cast — the missing keys are the point): the pre-arc shape
    // an older app version wrote, which the current type can't express.
    await db.battles.put({
      id: newId(),
      createdAt: stamp,
      updatedAt: stamp,
      campaignId,
      moduleId,
      encounterArtifactId: null,
      seedFighters: [],
      board: {
        mapImageId: null,
        live: false,
        tokens: [
          {
            id: newId(),
            artifactId: null,
            label: 'Brazier stamp',
            x: 0.5,
            y: 0.5,
            visible: true,
            scale: 1,
            shape: 'square',
            color: '#ff0000',
            currentHp: null,
            initiativeRoll: null,
            initiativeBonus: null,
            conditions: [],
          },
        ],
        veils: [],
        gridSize: 72,
        tokenSize: 64,
        sceneryMovementLocked: false,
        initiativeEnabled: false,
        initiativeOrder: [],
        activeIndex: 0,
        stage: null,
        stagingGround: null,
      },
    } as unknown as Battle);
    await renderSurface(moduleId);
    await flushAsyncUpdates();
    // The board (not the "no battle" empty state) renders, with the legacy
    // stamp token and the fixed-grid viewport — the absent later-arc pieces
    // (effects, veils, entrance, layout) render as their empty states.
    expect(screen.getByTestId('battle-board')).toBeInTheDocument();
    expect(screen.getByTestId('battle-token')).toBeInTheDocument();
    expect(screen.getByTestId('battle-token')).toHaveTextContent('Brazier stamp');
    expect(screen.getByTestId('battle-grid')).toBeInTheDocument();
    expect(screen.queryByTestId('battle-entrance')).not.toBeInTheDocument();
    // The first-entry reveal write re-persists the board with the
    // materialized defaults — the row leaves the legacy shape on disk.
    const stored = await getBattleByModule(moduleId);
    expect(stored?.board.effects).toEqual([]);
    expect(stored?.board.everLive).toBe(true);
  });
});

describe('token render size', () => {
  it('renders tokens at board.tokenSize — the same number the fog-coverage math uses', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await flushAsyncUpdates();
    const token = screen.getAllByTestId('battle-token')[0];
    if (token === undefined) throw new Error('token missing');
    // Mapless seed: tokenSize stays the 64px default (auto-fit only runs on
    // layout boards) — width% = 64 / 800.
    expect(token.style.width).toBe(`${String((64 / 800) * 100)}%`);
  });

  it('follows the auto-fit tokenSize on a layout board (cell-filling, docs/11)', async () => {
    const pc1 = await addPc('Serren', 20);
    void pc1;
    const roomA = newId();
    const roomB = newId();
    const layout = packRooms({
      theme: 'Fit hall',
      aspect: '16:9',
      entryRoomId: roomA,
      rosterCounts: [],
      rooms: [
        { id: roomA, name: 'Entry', description: '', size: 'small', monsterIndexes: [], adjacentRoomIds: [roomB], key: '', keyTreasure: '' },
        { id: roomB, name: 'Hall', description: '', size: 'medium', monsterIndexes: [], adjacentRoomIds: [roomA], key: '', keyTreasure: '' },
      ],
    });
    const encounter = await createArtifact({
      campaignId,
      kind: 'encounter',
      name: 'Fit battle',
      data: {
        difficulty: '',
        levelHint: '',
        monsters: [],
        terrain: '',
        tactics: '',
        treasure: '',
        mapImageId: null,
        layout,
        preset: 'standard',
        locationKind: 'other',
        siteShape: 'complex',
        budgetAdvisory: '',
      },
    });
    const module = await saveModule(
      createModule({ campaignId, title: 'Fit Module', concept: '', levelMin: 1, levelMax: 5, sizeDial: 'sketch' }),
    );
    await seedBattleFromEncounter(campaignId, module.id, encounter.id);
    await renderSurface(module.id);
    // The auto-fit effect re-captures tokenSize from the measured cell via a
    // Dexie round-trip; the rendered width must track whatever tokenSize the
    // row settles on (rendered size ≡ coverage size, no hardcoded 64px).
    await waitFor(async () => {
      const battle = await currentBattle(module.id);
      const token = screen.getByTestId('battle-token');
      expect(token.style.width).toBe(`${String((battle.board.tokenSize / 800) * 100)}%`);
      expect(battle.board.tokenSize).not.toBe(64);
    });
  });
});

describe('player-safe DOM contract', () => {
  it('renders only board pieces: names, HP, initiative — never stat text or secrets', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getByTestId('battle-board')).toBeInTheDocument();
    });
    await flushAsyncUpdates();
    const surface = screen.getByTestId('battle-surface');
    // Names and HP show; secrets/tactics/stat terms NEVER enter the DOM.
    expect(surface.textContent).toContain('Troll');
    expect(surface.textContent).not.toContain('fears fire');
    expect(surface.textContent).not.toContain('Regenerates');
    expect(surface.textContent).not.toContain('AC');
    expect(surface.textContent).not.toContain('Hit Dice');
  });

  it('keeps GM view seeing a veiled mob; hidden (visible:false) tokens are removed from the DOM entirely', async () => {
    const { moduleId } = await seedStandardBattle();
    // A fog parked exactly over the troll token (fallback spawn point 1).
    const battle = await currentBattle(moduleId);
    const troll = battle.board.tokens.find((token) => token.label === 'Troll');
    if (troll === undefined) throw new Error('troll token missing');
    await saveBattleBoard(battle.id, {
      ...battle.board,
      veils: [
        {
          id: newId(),
          kind: 'fog',
          x: troll.x,
          y: troll.y,
          widthCells: 2,
          heightCells: 2,
        },
      ],
    });
    await renderSurface(moduleId);
    await flushAsyncUpdates();
    // M5-D amendment: the GM sees their own map — the fogged troll STAYS in
    // the DOM in GM view (player-view removal is pinned by the coverage test
    // in 'veil coverage hides mobs only').
    const labels = screen.queryAllByTestId('battle-token').map((el) => el.getAttribute('data-token-label'));
    expect(labels).toContain('Troll');
    // Hidden (visible: false) tokens vanish the same way, in both views —
    // that is the GM deliberately hiding a token, not coverage. The save
    // fires liveQuery updates — wrap it in act (component is mounted).
    const fresh = await currentBattle(moduleId);
    await act(async () => {
      await saveBattleBoard(fresh.id, {
        ...fresh.board,
        veils: [],
        tokens: fresh.board.tokens.map((token) => ({ ...token, visible: false })),
      });
      await flushAsyncUpdates();
    });
    expect(screen.queryByTestId('battle-token')).toBeNull();
  });
});

describe('veil coverage hides mobs only', () => {
  it('removes a mob token under a veil in player view while the PC under the same veil stays visible ABOVE it; GM view sees both', async () => {
    const { moduleId } = await seedStandardBattle();
    // Park Serren on the troll's spot so ONE fog covers both: the headline
    // pin is the PC surviving coverage that hides the mob beside it.
    const battle = await currentBattle(moduleId);
    const troll = battle.board.tokens.find((token) => token.label === 'Troll');
    const serren = battle.board.tokens.find((token) => token.label === 'Serren');
    if (troll === undefined || serren === undefined) throw new Error('tokens missing');
    await act(async () => {
      await saveBattleBoard(battle.id, {
        ...battle.board,
        tokens: battle.board.tokens.map((token) =>
          token.label === 'Serren' ? { ...token, x: troll.x, y: troll.y } : token,
        ),
        veils: [
          { id: newId(), kind: 'veil', x: troll.x, y: troll.y, widthCells: 2, heightCells: 2 },
        ],
      });
      await flushAsyncUpdates();
    });
    await renderSurface(moduleId);
    await flushAsyncUpdates();
    // GM view: everything under the GM's own veil stays on the board.
    let labels = screen.getAllByTestId('battle-token').map((el) => el.getAttribute('data-token-label'));
    expect(labels).toContain('Troll');
    expect(labels).toContain('Serren');
    // Player view: the mob is removed; the PC under the same veil is not.
    const user = userEvent.setup();
    await user.click(screen.getByTestId('player-safe-toggle'));
    await flushAsyncUpdates();
    labels = screen.getAllByTestId('battle-token').map((el) => el.getAttribute('data-token-label'));
    expect(labels).not.toContain('Troll');
    expect(labels).toContain('Serren');
    // The surviving PC renders ABOVE the veil (same stacking context: later
    // document order paints on top).
    const veilEl = screen.getByTestId('battle-veil');
    const serrenEl = screen
      .getAllByTestId('battle-token')
      .find((el) => el.getAttribute('data-token-label') === 'Serren');
    if (serrenEl === undefined) throw new Error('serren element missing');
    expect(veilEl.compareDocumentPosition(serrenEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('veil presentation', () => {
  it('tints veils at ~10% in both views; selection reads via outline, never opacity', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const seeded = await currentBattle(moduleId);
    await act(async () => {
      await saveBattleBoard(seeded.id, {
        ...seeded.board,
        veils: [{ id: newId(), kind: 'veil', x: 0.3, y: 0.3, widthCells: 2, heightCells: 2 }],
      });
      await flushAsyncUpdates();
    });
    // Base tint pinned as a class: black at 10% alpha, and NO opacity-* class
    // anywhere on the veil (selection/dragging must not swing it).
    const expectTint = (el: HTMLElement): void => {
      expect(el.className).toContain('bg-black/10');
      expect(el.className).not.toMatch(/opacity-\d/);
    };
    expectTint(screen.getByTestId('battle-veil'));
    // Tap (below threshold) selects: the outline appears, the tint does not.
    const veilEl = screen.getByTestId('battle-veil');
    const cx = (fx: number): number => contentRect.left + fx * contentRect.width;
    const cy = (fy: number): number => contentRect.top + fy * contentRect.height;
    fireEvent.pointerDown(veilEl, { pointerId: 5, clientX: cx(0.3), clientY: cy(0.3) });
    fireEvent.pointerUp(veilEl, { pointerId: 5 });
    await flushAsyncUpdates();
    expectTint(screen.getByTestId('battle-veil'));
    expect(screen.getByTestId('battle-veil').className).toContain('ring-2');
    // Player view gets the same ~10% base — the transparent veil never blinds
    // anyone (the OPAQUE fog is the other kind; see the next test).
    const user = userEvent.setup();
    await user.click(screen.getByTestId('player-safe-toggle'));
    await flushAsyncUpdates();
    expectTint(screen.getByTestId('battle-veil'));
  });

  it('renders fog OPAQUE and veil transparent, keyed off kind, in both views (ledger 65 supersession)', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const seeded = await currentBattle(moduleId);
    await act(async () => {
      await saveBattleBoard(seeded.id, {
        ...seeded.board,
        veils: [
          { id: newId(), kind: 'fog', x: 0.25, y: 0.25, widthCells: 2, heightCells: 2 },
          { id: newId(), kind: 'veil', x: 0.7, y: 0.7, widthCells: 2, heightCells: 2 },
        ],
      });
      await flushAsyncUpdates();
    });
    const elFor = (kind: 'fog' | 'veil'): HTMLElement => {
      const el = screen
        .getAllByTestId('battle-veil')
        .find((node) => node.getAttribute('data-veil-kind') === kind);
      if (el === undefined) throw new Error(`no ${kind} veil rendered`);
      return el;
    };
    // The kind attribute is the switch the contract keys off — first pinned here.
    expect(screen.getAllByTestId('battle-veil')).toHaveLength(2);
    const expectKinds = (): void => {
      // Fog: a SOLID rectangle — a non-transparent fill class with no `/alpha`
      // suffix, and never an `opacity-*` class (the fill may not be walked back).
      const fog = elFor('fog');
      expect(fog.className).toContain('bg-zinc-300');
      expect(fog.className).not.toMatch(/opacity-\d/);
      for (const cls of fog.className.split(/\s+/)) {
        expect(cls).not.toMatch(/^bg-zinc-300\//);
      }
      // Veil: still the transparent ~10% tint (its job is plain cover).
      const veil = elFor('veil');
      expect(veil.className).toContain('bg-black/10');
      expect(veil.className).not.toMatch(/opacity-\d/);
    };
    expectKinds();
    // The owner asked for a rectangle that reads as opaque on their OWN board,
    // so GM view and player view render the very same distinction — never a
    // mode-dependent fill.
    await userEvent.setup().click(screen.getByTestId('player-safe-toggle'));
    await flushAsyncUpdates();
    expect(screen.getAllByTestId('battle-veil')).toHaveLength(2);
    expectKinds();
  });

  it('the two toolbar tools stay distinct: veil-tool mints a veil, fog-tool mints a fog', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const seeded = await currentBattle(moduleId);
    await act(async () => {
      await saveBattleBoard(seeded.id, { ...seeded.board, veils: [] });
      await flushAsyncUpdates();
    });
    // No testid existed before ledger 65, so a test could not click either
    // tool — the distinction the owner reported broken was unpinnable.
    const user = userEvent.setup();
    await user.click(screen.getByTestId('veil-tool'));
    await flushAsyncUpdates();
    await user.click(screen.getByTestId('fog-tool'));
    await flushAsyncUpdates();
    const kinds = (await currentBattle(moduleId)).board.veils.map((veil) => veil.kind);
    expect(kinds).toEqual(['veil', 'fog']);
    // Each minted veil renders with ITS kind's fill.
    expect(screen.getAllByTestId('battle-veil')).toHaveLength(2);
    const byKind = new Map(
      screen.getAllByTestId('battle-veil').map((el) => [el.getAttribute('data-veil-kind'), el]),
    );
    expect(byKind.get('fog')?.className).toContain('bg-zinc-300');
    expect(byKind.get('veil')?.className).toContain('bg-black/10');
  });

  it('gives veil resize handles a 44px touch target and drag-resizes with one commit (T2a/T2b unified)', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const seeded = await currentBattle(moduleId);
    await act(async () => {
      await saveBattleBoard(seeded.id, {
        ...seeded.board,
        veils: [{ id: newId(), kind: 'veil', x: 0.3, y: 0.3, widthCells: 2, heightCells: 2 }],
      });
      await flushAsyncUpdates();
    });
    // GM view, unlocked board: all four edge handles render.
    for (const edge of ['n', 's', 'e', 'w'] as const) {
      const handle = screen.getByTestId(`veil-handle-${edge}`);
      // The 44px (size-11) transparent hit pad lives on the button itself…
      expect(handle.className).toContain('size-11');
      // …with the visible affordance unchanged at 12px (size-3) inside.
      const dot = handle.querySelector('span');
      if (dot === null) throw new Error(`veil handle ${edge} lost its visible dot`);
      expect(dot.className).toContain('size-3');
    }
    // Drag-resize (one-gesture-machine — the click-to-resize path is
    // deleted): the east handle drags one cell outward with a live preview,
    // zero writes mid-gesture, and exactly one commit on release carrying
    // the final geometry (opposite edge pinned).
    vi.mocked(saveBattleBoard).mockClear();
    const veilEl = screen.getByTestId('battle-veil');
    const beforeWidth = veilEl.style.width;
    const handle = screen.getByTestId('veil-handle-e');
    // The 2-cell veil spans 144px centered at 0.3: its east rim sits 72px
    // right of center. Dragging one full cell (72px) further out lands the
    // span at 3 cells, west edge pinned, center shifted to 0.345.
    const rimX = 0.3 * BOARD_W + 72;
    const midY = CONTENT_TOP + 0.3 * CONTENT_H;
    fireEvent.pointerDown(handle, { pointerId: 13, clientX: rimX, clientY: midY });
    fireEvent.pointerMove(handle, { pointerId: 13, clientX: rimX + 72, clientY: midY });
    await flushAsyncUpdates();
    // The LOCAL veil previews the grown size with zero writes mid-gesture.
    expect(Number.parseFloat(veilEl.style.width)).toBeCloseTo(27, 9);
    expect(veilEl.style.width).not.toBe(beforeWidth);
    expect(saveBattleBoard).not.toHaveBeenCalled();
    // Release: exactly one commit; height untouched, gate balanced.
    fireEvent.pointerUp(handle, { pointerId: 13 });
    await flushAsyncUpdates();
    expect(saveBattleBoard).toHaveBeenCalledTimes(1);
    expect(isBoardGestureActive()).toBe(false);
    const after = (await currentBattle(moduleId)).board.veils[0];
    if (after === undefined) throw new Error('veil vanished');
    expect(after.widthCells).toBe(3);
    expect(after.heightCells).toBe(2);
    expect(after.x).toBeCloseTo(0.345, 9);
    expect(after.y).toBe(0.3);
  });
});

describe('veil tap pass-through to the room-key markers (ledger 65)', () => {
  async function seedMarkerBattle(): Promise<{
    moduleId: string;
    markerX: number;
    markerY: number;
  }> {
    const { moduleId, encounterId } = await seedKeyedBattle();
    const encounter = await getAnyArtifact(encounterId);
    if (encounter?.kind !== 'encounter' || encounter.data.layout == null) {
      throw new Error('layout missing');
    }
    const roomA = encounter.data.layout.rooms.find((room) => room.name === 'Entry');
    const mobsRect = roomA?.mobsRect;
    if (roomA === undefined || mobsRect === undefined) throw new Error('room A missing its mobsRect');
    // Room A is the KEYED room (Entry) and only Sanctum spawns mobs, so the
    // seeded board's single fog veil never covers room A: park a GM-drawn
    // TRANSPARENT veil exactly over the marker's pad. The veil body then owns
    // pointerdown (markers sit BELOW it — DOM order, no z-index), which is
    // exactly the state the pass-through exists for.
    const markerX = (mobsRect.x + mobsRect.w / 2) / encounter.data.layout.gridW;
    const markerY = (mobsRect.y + mobsRect.h / 2) / encounter.data.layout.gridH;
    const seeded = await currentBattle(moduleId);
    await act(async () => {
      await saveBattleBoard(seeded.id, {
        ...seeded.board,
        veils: [
          ...seeded.board.veils,
          { id: newId(), kind: 'veil', x: markerX, y: markerY, widthCells: 2, heightCells: 2 },
        ],
      });
      await flushAsyncUpdates();
    });
    return { moduleId, markerX, markerY };
  }

  /** The veil body the tap lands on — the LAST veil, i.e. the parked one. */
  function parkedVeil(): HTMLElement {
    const veils = screen.getAllByTestId('battle-veil');
    const veil = veils[veils.length - 1];
    if (veil === undefined) throw new Error('no veil rendered');
    return veil;
  }

  const frameX = (fx: number): number => contentRect.left + fx * contentRect.width;
  const frameY = (fy: number): number => contentRect.top + fy * contentRect.height;

  it('a tap on a TRANSPARENT veil inside a marker pad opens that room’s key', async () => {
    const { moduleId, markerX, markerY } = await seedMarkerBattle();
    await renderSurface(moduleId);
    await flushAsyncUpdates();
    expect(screen.queryByTestId('room-key-card')).toBeNull();
    const veil = parkedVeil();
    expect(veil.getAttribute('data-veil-kind')).toBe('veil');
    // Down and up at the marker centre: the veil body takes the grab (it is
    // painted above the pad), and the release is a tap (0px, way below the
    // 8px threshold) whose point lands inside the 44px pad.
    fireEvent.pointerDown(veil, { pointerId: 11, clientX: frameX(markerX), clientY: frameY(markerY) });
    fireEvent.pointerUp(veil, { pointerId: 11, clientX: frameX(markerX), clientY: frameY(markerY) });
    await flushAsyncUpdates();
    // The key opened…
    const card = screen.getByTestId('room-key-card');
    expect(within(card).getByText('Room A — Entry')).toBeInTheDocument();
    // …AND the veil is not merely selected (the old behavior this replaces).
    expect(screen.queryByTestId('delete-veil')).toBeNull();
    expect(veil.className).not.toContain('ring-2');
    // Nothing was committed: a tap never writes.
    expect((await currentBattle(moduleId)).board.veils).toHaveLength(2);
  });

  it('the SAME tap on a FOG blocks: no key opens, the fog is selected instead', async () => {
    const { moduleId, markerX, markerY } = await seedMarkerBattle();
    const seeded = await currentBattle(moduleId);
    const parked = seeded.board.veils[seeded.board.veils.length - 1];
    if (parked === undefined) throw new Error('parked veil missing');
    await act(async () => {
      await saveBattleBoard(seeded.id, {
        ...seeded.board,
        veils: seeded.board.veils.map((veil) =>
          veil.id === parked.id ? { ...veil, kind: 'fog' as const } : veil,
        ),
      });
      await flushAsyncUpdates();
    });
    await renderSurface(moduleId);
    await flushAsyncUpdates();
    const fog = parkedVeil();
    expect(fog.getAttribute('data-veil-kind')).toBe('fog');
    fireEvent.pointerDown(fog, { pointerId: 12, clientX: frameX(markerX), clientY: frameY(markerY) });
    fireEvent.pointerUp(fog, { pointerId: 12, clientX: frameX(markerX), clientY: frameY(markerY) });
    await flushAsyncUpdates();
    // Fog is opaque and blocks: the identical tap reaches NOTHING behind it —
    // no key card — and behaves exactly as before (the fog is selected).
    expect(screen.queryByTestId('room-key-card')).toBeNull();
    expect(screen.getByTestId('delete-veil')).toBeInTheDocument();
    expect(fog.className).toContain('ring-2');
  });

  it('a veil tap OUTSIDE every marker pad still selects the veil and reaches delete-veil', async () => {
    const { moduleId, markerX, markerY } = await seedMarkerBattle();
    await renderSurface(moduleId);
    await flushAsyncUpdates();
    // Move the parked veil out from under room A's pad (its own center), so
    // the tap misses: the pass-through is a pad test, never a plain "is
    // there any marker on this board" test.
    const parkedId = (await currentBattle(moduleId)).board.veils.slice(-1)[0]?.id;
    if (parkedId === undefined) throw new Error('parked veil missing');
    const battle = await currentBattle(moduleId);
    await act(async () => {
      await saveBattleBoard(battle.id, {
        ...battle.board,
        veils: battle.board.veils.map((veil) =>
          veil.id === parkedId ? { ...veil, x: markerX + 0.4, y: markerY } : veil,
        ),
      });
      await flushAsyncUpdates();
    });
    const veil = parkedVeil();
    const atX = markerX + 0.4;
    fireEvent.pointerDown(veil, { pointerId: 13, clientX: frameX(atX), clientY: frameY(markerY) });
    fireEvent.pointerUp(veil, { pointerId: 13, clientX: frameX(atX), clientY: frameY(markerY) });
    await flushAsyncUpdates();
    expect(screen.queryByTestId('room-key-card')).toBeNull();
    // The veil is selected, exactly as before ledger 65.
    expect(veil.className).toContain('ring-2');
    const deleteButton = screen.getByTestId('delete-veil');
    await userEvent.setup().click(deleteButton);
    await flushAsyncUpdates();
    expect(screen.queryByTestId('delete-veil')).toBeNull();
    expect((await currentBattle(moduleId)).board.veils.some((entry) => entry.id === parkedId)).toBe(false);
  });

  it('a SEEDED mob cover passes the tap through to its room’s key (the opaque fog used to swallow it)', async () => {
    // The consequence of the fog-cloud arc that is NOT cosmetic: a generated
    // cover's marker sits at its room's mobsRect CENTRE — inside the cover
    // body by construction — and markers stay BELOW veils (DOM order, no
    // z-index). While the seeded kind was the opaque, blocking `fog` that
    // marker was unreachable by tap; as a plain cover the same tap passes
    // through and opens the key. One room, keyed AND mobbed, mobsRect filled
    // by a single group (count 6 of the small room's 12 mobsRect cells) so
    // the seeded cover's body covers the marker pad.
    const pc1 = await addPc('Serren', 20);
    void pc1;
    const roomId = newId();
    const layout = packRooms({
      theme: 'Veiled crypt',
      aspect: '4:3',
      entryRoomId: roomId,
      rosterCounts: [6],
      rooms: [
        { id: roomId, name: 'Crypt', description: '', size: 'small', monsterIndexes: [0], adjacentRoomIds: [], key: KEY_TEXT, keyTreasure: '' },
      ],
    });
    const encounter = await createArtifact({
      campaignId,
      kind: 'encounter',
      name: 'Veiled crypt',
      data: {
        difficulty: '',
        levelHint: '',
        monsters: [{ name: 'Ghoul', count: 6, notes: '', treasure: '', source: { type: 'inline', statBlock: statBlock({ hp: 12 }) } }],
        terrain: '',
        tactics: '',
        treasure: '',
        mapImageId: null,
        layout,
        preset: 'standard',
        locationKind: 'other',
        siteShape: 'single',
        budgetAdvisory: '',
      },
    });
    const module = await saveModule(
      createModule({ campaignId, title: 'Crypt Module', concept: '', levelMin: 1, levelMax: 3, sizeDial: 'sketch' }),
    );
    await seedBattleFromEncounter(campaignId, module.id, encounter.id);
    await renderSurface(module.id);
    await flushAsyncUpdates();
    const room = layout.rooms[0];
    const mobs = room?.mobsRect;
    if (mobs === undefined) throw new Error('room missing mobsRect');
    const markerX = (mobs.x + mobs.w / 2) / layout.gridW;
    const markerY = (mobs.y + mobs.h / 2) / layout.gridH;
    const seeded = await currentBattle(module.id);
    expect(seeded.board.veils).toHaveLength(1);
    const cover = seeded.board.veils[0];
    if (cover === undefined) throw new Error('seeded cover missing');
    expect(cover.kind).toBe('veil');
    // The cover body really does sit over the marker's own point.
    expect(cover.x).toBeCloseTo((mobs.x + mobs.w / 2) / layout.gridW, 6);
    expect(cover.y).toBeCloseTo((mobs.y + mobs.h / 2) / layout.gridH, 6);
    const coverEl = screen.getByTestId('battle-veil');
    expect(coverEl.getAttribute('data-veil-kind')).toBe('veil');
    expect(screen.queryByTestId('room-key-card')).toBeNull();
    fireEvent.pointerDown(coverEl, { pointerId: 21, clientX: frameX(markerX), clientY: frameY(markerY) });
    fireEvent.pointerUp(coverEl, { pointerId: 21, clientX: frameX(markerX), clientY: frameY(markerY) });
    await flushAsyncUpdates();
    const card = screen.getByTestId('room-key-card');
    expect(within(card).getByText(KEY_TEXT)).toBeInTheDocument();
    // The cover is not merely selected, and a tap never writes: the mobs stay
    // covered until the GM lifts the veil (drag it, or "Reveal next room").
    expect(screen.queryByTestId('delete-veil')).toBeNull();
    expect(coverEl.className).not.toContain('ring-2');
    expect((await currentBattle(module.id)).board.veils).toHaveLength(1);
  });
});

describe('zoom controls touch targets (T4)', () => {
  it('keeps the zoom toolbar buttons at a 44px touch target', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    for (const label of ['Zoom in', 'Zoom out', 'Reset view'] as const) {
      const button = screen.getByLabelText(label);
      expect(button.className).toContain('min-h-11');
      expect(button.className).toContain('min-w-11');
    }
  });
});

describe('drag & tap', () => {
  it('drags a token with a live position and commits the snapped spot once', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const battle = await currentBattle(moduleId);
    const pcToken = battle.board.tokens.find((token) => token.label === 'Serren');
    if (pcToken === undefined) throw new Error('pc token missing');
    const tokenEl = screen
      .getAllByTestId('battle-token')
      .find((element) => element.getAttribute('data-token-label') === 'Serren');
    if (tokenEl === undefined) throw new Error('serren element missing');
    // Press (below threshold), move well past 8px, release.
    fireEvent.pointerDown(tokenEl, { pointerId: 1, clientX: pcToken.x * BOARD_W, clientY: pcToken.y * BOARD_H });
    fireEvent.pointerMove(tokenEl, { pointerId: 1, clientX: 0.62 * BOARD_W, clientY: 0.58 * BOARD_H });
    fireEvent.pointerUp(tokenEl, { pointerId: 1 });
    await flushAsyncUpdates();
    const after = await currentBattle(moduleId);
    const moved = after.board.tokens.find((token) => token.label === 'Serren');
    expect(moved?.x).not.toBe(pcToken.x);
    // Snapped to the 72px grid: the stored px offset from the board's left
    // edge is an integer multiple of 72 (rounding float noise under 1e-6).
    if (moved === undefined) throw new Error('token vanished');
    // Snap centers the token in a grid block: px ≡ 36 (mod 72) for span 1.
    const px = moved.x * BOARD_W;
    expect(Math.abs((px % 72) - 36)).toBeLessThan(1e-6);
  });

  it('commits the drag when the pointer leaves the token node mid-gesture', async () => {
    // The reported intermittent failure: a fast drag outruns the token
    // element, so the token's own move/up stream dies and the mob "snaps
    // back". Moves bubble to the board, which now follows the active drag,
    // and an off-piece release finishes it with identical commit semantics.
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const battle = await currentBattle(moduleId);
    const pcToken = battle.board.tokens.find((token) => token.label === 'Serren');
    if (pcToken === undefined) throw new Error('pc token missing');
    const tokenEl = screen
      .getAllByTestId('battle-token')
      .find((element) => element.getAttribute('data-token-label') === 'Serren');
    if (tokenEl === undefined) throw new Error('serren element missing');
    const board = screen.getByTestId('battle-board');
    fireEvent.pointerDown(tokenEl, { pointerId: 1, clientX: pcToken.x * BOARD_W, clientY: pcToken.y * BOARD_H });
    fireEvent.pointerMove(tokenEl, { pointerId: 1, clientX: 0.55 * BOARD_W, clientY: 0.5 * BOARD_H });
    // The cursor leaves the token node: the rest of the gesture lands on the board.
    fireEvent.pointerMove(board, { pointerId: 1, clientX: 0.62 * BOARD_W, clientY: 0.58 * BOARD_H });
    fireEvent.pointerUp(board, { pointerId: 1, clientX: 0.62 * BOARD_W, clientY: 0.58 * BOARD_H });
    await flushAsyncUpdates();
    const after = await currentBattle(moduleId);
    const moved = after.board.tokens.find((token) => token.label === 'Serren');
    if (moved === undefined) throw new Error('token vanished');
    expect(moved.x).not.toBe(pcToken.x);
    const px = moved.x * BOARD_W;
    expect(Math.abs((px % 72) - 36)).toBeLessThan(1e-6);
  });

  it('taps to select and shows name + HP only in the controls', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const battle = await currentBattle(moduleId);
    const troll = battle.board.tokens.find((token) => token.label === 'Troll');
    if (troll === undefined) throw new Error('troll missing');
    const trollEl = screen
      .getAllByTestId('battle-token')
      .find((element) => element.getAttribute('data-token-label') === 'Troll');
    if (trollEl === undefined) throw new Error('troll element missing');
    fireEvent.pointerDown(trollEl, { pointerId: 1, clientX: troll.x * BOARD_W, clientY: troll.y * BOARD_H });
    fireEvent.pointerUp(trollEl, { pointerId: 1 });
    await flushAsyncUpdates();
    const controls = screen.getByTestId('token-controls');
    expect(within(controls).getByTestId('token-hp').textContent).toContain('84');
    expect(controls.textContent).not.toContain('fears fire');
    await flushAsyncUpdates();
  });
});

describe('board touch robustness (batch B — drag-state hardening)', () => {
  it('aborts the token drag when pointer capture fails: no live drag, no commit, gesture closed', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const battle = await currentBattle(moduleId);
    const pcToken = battle.board.tokens.find((token) => token.label === 'Serren');
    if (pcToken === undefined) throw new Error('pc token missing');
    const tokenEl = screen
      .getAllByTestId('battle-token')
      .find((element) => element.getAttribute('data-token-label') === 'Serren');
    if (tokenEl === undefined) throw new Error('serren element missing');
    // jsdom lacks setPointerCapture; install a throwing one to simulate the
    // stolen-gesture failure (capture present but already released).
    const proto = Element.prototype as unknown as { setPointerCapture?: unknown };
    const hadCapture = proto.setPointerCapture;
    proto.setPointerCapture = (): void => {
      throw new Error('gesture stolen');
    };
    try {
      vi.mocked(saveBattleBoard).mockClear();
      fireEvent.pointerDown(tokenEl, { pointerId: 1, clientX: pcToken.x * BOARD_W, clientY: pcToken.y * BOARD_H });
      fireEvent.pointerMove(tokenEl, { pointerId: 1, clientX: 0.62 * BOARD_W, clientY: 0.58 * BOARD_H });
      fireEvent.pointerUp(tokenEl, { pointerId: 1 });
      await flushAsyncUpdates();
      // No live drag ever started: zero commits, token unmoved…
      expect(vi.mocked(saveBattleBoard)).not.toHaveBeenCalled();
      const after = await currentBattle(moduleId);
      expect(after.board.tokens.find((token) => token.label === 'Serren')?.x).toBe(pcToken.x);
      // …and the gesture gate stayed balanced (no open gesture leaks out).
      expect(isBoardGestureActive()).toBe(false);
    } finally {
      if (hadCapture === undefined) delete proto.setPointerCapture;
      else proto.setPointerCapture = hadCapture;
    }
  });

  it('abandons the live drag with no commit when a second finger starts a pinch mid-drag', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const battle = await currentBattle(moduleId);
    const pcToken = battle.board.tokens.find((token) => token.label === 'Serren');
    if (pcToken === undefined) throw new Error('pc token missing');
    const tokenEl = screen
      .getAllByTestId('battle-token')
      .find((element) => element.getAttribute('data-token-label') === 'Serren');
    if (tokenEl === undefined) throw new Error('serren element missing');
    const board = screen.getByTestId('battle-board');
    vi.mocked(saveBattleBoard).mockClear();
    // Finger 1 drags the token (its down stops propagation, so the board
    // never sees it — exactly like the real gesture).
    fireEvent.pointerDown(tokenEl, { pointerId: 1, clientX: pcToken.x * BOARD_W, clientY: pcToken.y * BOARD_H });
    fireEvent.pointerMove(tokenEl, { pointerId: 1, clientX: 0.55 * BOARD_W, clientY: 0.5 * BOARD_H });
    await flushAsyncUpdates();
    await flushDragFrames();
    expect(tokenEl.className).toContain('opacity-90');
    // Fingers 2+3 land on the background: the second board-visible pointer
    // starts a pinch/rotation, and the token drag is abandoned, not stranded.
    fireEvent.pointerDown(board, { pointerId: 2, clientX: 60, clientY: 550 });
    fireEvent.pointerDown(board, { pointerId: 3, clientX: 120, clientY: 550 });
    await flushAsyncUpdates();
    expect(isBoardGestureActive()).toBe(false);
    // Every finger lifts: nothing commits (no drop point was ever chosen).
    fireEvent.pointerUp(board, { pointerId: 1, clientX: 0.55 * BOARD_W, clientY: 0.5 * BOARD_H });
    fireEvent.pointerUp(board, { pointerId: 2, clientX: 60, clientY: 550 });
    fireEvent.pointerUp(board, { pointerId: 3, clientX: 120, clientY: 550 });
    await flushAsyncUpdates();
    expect(vi.mocked(saveBattleBoard)).not.toHaveBeenCalled();
    const after = await currentBattle(moduleId);
    expect(after.board.tokens.find((token) => token.label === 'Serren')?.x).toBe(pcToken.x);
  });

  it('abandons the live drag with no commit on board pointercancel, closing the gesture', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const battle = await currentBattle(moduleId);
    const pcToken = battle.board.tokens.find((token) => token.label === 'Serren');
    if (pcToken === undefined) throw new Error('pc token missing');
    const tokenEl = screen
      .getAllByTestId('battle-token')
      .find((element) => element.getAttribute('data-token-label') === 'Serren');
    if (tokenEl === undefined) throw new Error('serren element missing');
    const board = screen.getByTestId('battle-board');
    vi.mocked(saveBattleBoard).mockClear();
    fireEvent.pointerDown(tokenEl, { pointerId: 1, clientX: pcToken.x * BOARD_W, clientY: pcToken.y * BOARD_H });
    fireEvent.pointerMove(tokenEl, { pointerId: 1, clientX: 0.62 * BOARD_W, clientY: 0.58 * BOARD_H });
    await flushAsyncUpdates();
    // The stream dies off-piece (no drop point, no tap): abandon, never commit.
    fireEvent.pointerCancel(board, { pointerId: 1, clientX: 0.62 * BOARD_W, clientY: 0.58 * BOARD_H });
    await flushAsyncUpdates();
    expect(vi.mocked(saveBattleBoard)).not.toHaveBeenCalled();
    expect(isBoardGestureActive()).toBe(false);
    const after = await currentBattle(moduleId);
    expect(after.board.tokens.find((token) => token.label === 'Serren')?.x).toBe(pcToken.x);
  });

  it('abandons a dragged veil on cancel with no commit — cancel never commits (S7)', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const seeded = await currentBattle(moduleId);
    const veilId = newId();
    await act(async () => {
      await saveBattleBoard(seeded.id, {
        ...seeded.board,
        veils: [{ id: veilId, kind: 'veil', x: 0.3, y: 0.3, widthCells: 2, heightCells: 2 }],
      });
      await flushAsyncUpdates();
    });
    vi.mocked(saveBattleBoard).mockClear();
    const veilEl = screen.getByTestId('battle-veil');
    const cx = (fx: number): number => contentRect.left + fx * contentRect.width;
    const cy = (fy: number): number => contentRect.top + fy * contentRect.height;
    fireEvent.pointerDown(veilEl, { pointerId: 9, clientX: cx(0.3), clientY: cy(0.3) });
    fireEvent.pointerMove(veilEl, { pointerId: 9, clientX: cx(0.55), clientY: cy(0.62) });
    await flushAsyncUpdates();
    // Cancel is NEVER a release: the stream died, so there is no drop point
    // and no tap — the drag abandons with zero commits (the old veil path
    // committed here; the machine unifies every piece on abandon) and the
    // gate balances without throwing.
    fireEvent.pointerCancel(veilEl, { pointerId: 9 });
    await flushAsyncUpdates();
    expect(vi.mocked(saveBattleBoard)).not.toHaveBeenCalled();
    expect(isBoardGestureActive()).toBe(false);
    const after = await currentBattle(moduleId);
    expect(after.board.veils.find((entry) => entry.id === veilId)?.x).toBe(0.3);
  });

  it('abandons a dragged effect on cancel with no commit — cancel never commits (S7)', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const seeded = await currentBattle(moduleId);
    const effectId = newId();
    await act(async () => {
      await saveBattleBoard(seeded.id, {
        ...seeded.board,
        effects: [{ id: effectId, shape: 'square', x: 0.3, y: 0.3, sizeCells: 1, color: '#ffe600', label: '' }],
      });
      await flushAsyncUpdates();
    });
    vi.mocked(saveBattleBoard).mockClear();
    const effectEl = screen.getByTestId('battle-effect');
    const cx = (fx: number): number => contentRect.left + fx * contentRect.width;
    const cy = (fy: number): number => contentRect.top + fy * contentRect.height;
    fireEvent.pointerDown(effectEl, { pointerId: 7, clientX: cx(0.3), clientY: cy(0.3) });
    fireEvent.pointerMove(effectEl, { pointerId: 7, clientX: cx(0.55), clientY: cy(0.62) });
    await flushAsyncUpdates();
    // Same unified contract as veils and tokens: an on-piece cancel
    // abandons with zero commits (the old effect path committed here) and
    // the gate balances without throwing.
    fireEvent.pointerCancel(effectEl, { pointerId: 7 });
    await flushAsyncUpdates();
    expect(vi.mocked(saveBattleBoard)).not.toHaveBeenCalled();
    expect(isBoardGestureActive()).toBe(false);
    const after = await currentBattle(moduleId);
    expect(after.board.effects.find((entry) => entry.id === effectId)?.x).toBe(0.3);
  });
});

describe('veil live drag', () => {
  it('tracks the pointer with ZERO Dexie writes and a dragging visual, then commits the snapped drop exactly once', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    // Seed a 2×2 veil away from the fighters.
    const seeded = await currentBattle(moduleId);
    const veilId = newId();
    await act(async () => {
      await saveBattleBoard(seeded.id, {
        ...seeded.board,
        veils: [{ id: veilId, kind: 'veil', x: 0.3, y: 0.3, widthCells: 2, heightCells: 2 }],
      });
      await flushAsyncUpdates();
    });
    vi.mocked(saveBattleBoard).mockClear();
    const veilEl = screen.getByTestId('battle-veil');
    const cx = (fx: number): number => contentRect.left + fx * contentRect.width;
    const cy = (fy: number): number => contentRect.top + fy * contentRect.height;
    // Press on the veil and drag — the LOCAL veil must follow the pointer.
    fireEvent.pointerDown(veilEl, { pointerId: 5, clientX: cx(0.3), clientY: cy(0.3) });
    fireEvent.pointerMove(veilEl, { pointerId: 5, clientX: cx(0.55), clientY: cy(0.62) });
    await flushAsyncUpdates();
    await flushDragFrames();
    expect(Number.parseFloat(veilEl.style.left) / 100).toBeCloseTo(0.55, 9);
    expect(Number.parseFloat(veilEl.style.top) / 100).toBeCloseTo(0.62, 9);
    // Dragging visual mirrors tokens: lifted (z-20) with outline emphasis —
    // the tint never swings (selection reads via outline, not opacity).
    expect(veilEl.className).toContain('z-20');
    expect(veilEl.className).toContain('ring-2');
    expect(veilEl.className).not.toMatch(/opacity-\d/);
    // Zero persistence while the drag is live — the battle row is untouched.
    expect(saveBattleBoard).not.toHaveBeenCalled();
    const during = await currentBattle(moduleId);
    expect(during.board.veils.find((veil) => veil.id === veilId)?.x).toBe(0.3);
    // Release: exactly one commit, snapped like a token drop.
    fireEvent.pointerUp(veilEl, { pointerId: 5 });
    await flushAsyncUpdates();
    expect(saveBattleBoard).toHaveBeenCalledTimes(1);
    const after = await currentBattle(moduleId);
    const dropped = after.board.veils.find((veil) => veil.id === veilId);
    if (dropped === undefined) throw new Error('veil vanished');
    expect(dropped.x).not.toBe(0.3);
    // Span-aware snap (2×2 → centre ≡ 0 mod 72 content px on both axes):
    // drop fraction (0.55, 0.62) → (432/800, 288/450) = (0.54, 0.64).
    expect(dropped.x).toBeCloseTo(0.54, 9);
    expect(dropped.y).toBeCloseTo(0.64, 9);
    expect(Math.abs((dropped.x * BOARD_W) % 72)).toBeLessThan(1e-6);
    expect(Math.abs((dropped.y * CONTENT_H) % 72)).toBeLessThan(1e-6);
  });

  it('does not commit a veil tap below the screen-space threshold', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const seeded = await currentBattle(moduleId);
    const veilId = newId();
    await act(async () => {
      await saveBattleBoard(seeded.id, {
        ...seeded.board,
        veils: [{ id: veilId, kind: 'veil', x: 0.3, y: 0.3, widthCells: 2, heightCells: 2 }],
      });
      await flushAsyncUpdates();
    });
    vi.mocked(saveBattleBoard).mockClear();
    const veilEl = screen.getByTestId('battle-veil');
    const cx = (fx: number): number => contentRect.left + fx * contentRect.width;
    const cy = (fy: number): number => contentRect.top + fy * contentRect.height;
    fireEvent.pointerDown(veilEl, { pointerId: 5, clientX: cx(0.3), clientY: cy(0.3) });
    fireEvent.pointerMove(veilEl, { pointerId: 5, clientX: cx(0.3) + 3, clientY: cy(0.3) });
    fireEvent.pointerUp(veilEl, { pointerId: 5 });
    await flushAsyncUpdates();
    // A 3px nudge is a tap (veil selection), never a teleport or a commit.
    expect(saveBattleBoard).not.toHaveBeenCalled();
    const after = await currentBattle(moduleId);
    const veil = after.board.veils.find((entry) => entry.id === veilId);
    expect(veil?.x).toBe(0.3);
    expect(veil?.y).toBe(0.3);
    expect(screen.getByTestId('delete-veil')).toBeInTheDocument();
  });
});

describe('live-drag frame throttle (batch H)', () => {
  it('coalesces a burst of moves to one render and commits the final position exactly once', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const seeded = await currentBattle(moduleId);
    const veilId = newId();
    await act(async () => {
      await saveBattleBoard(seeded.id, {
        ...seeded.board,
        veils: [{ id: veilId, kind: 'veil', x: 0.3, y: 0.3, widthCells: 2, heightCells: 2 }],
      });
      await flushAsyncUpdates();
    });
    vi.mocked(saveBattleBoard).mockClear();
    const veilEl = screen.getByTestId('battle-veil');
    const cx = (fx: number): number => contentRect.left + fx * contentRect.width;
    const cy = (fy: number): number => contentRect.top + fy * contentRect.height;
    // A burst of moves inside one frame: synchronous fireEvents give the
    // frame timer no window to interleave, so NOTHING may reach the DOM yet —
    // every move is coalesced into the single queued frame.
    fireEvent.pointerDown(veilEl, { pointerId: 5, clientX: cx(0.3), clientY: cy(0.3) });
    fireEvent.pointerMove(veilEl, { pointerId: 5, clientX: cx(0.4), clientY: cy(0.4) });
    fireEvent.pointerMove(veilEl, { pointerId: 5, clientX: cx(0.48), clientY: cy(0.55) });
    fireEvent.pointerMove(veilEl, { pointerId: 5, clientX: cx(0.55), clientY: cy(0.62) });
    expect(Number.parseFloat(veilEl.style.left) / 100).toBeCloseTo(0.3, 9);
    expect(saveBattleBoard).not.toHaveBeenCalled();
    // One frame lands the FINAL burst position (intermediates never render).
    await flushDragFrames();
    expect(Number.parseFloat(veilEl.style.left) / 100).toBeCloseTo(0.55, 9);
    expect(Number.parseFloat(veilEl.style.top) / 100).toBeCloseTo(0.62, 9);
    expect(saveBattleBoard).not.toHaveBeenCalled();
    // Release commits the coalesced drop exactly once, snapped like a token.
    fireEvent.pointerUp(veilEl, { pointerId: 5 });
    await flushAsyncUpdates();
    expect(saveBattleBoard).toHaveBeenCalledTimes(1);
    const after = await currentBattle(moduleId);
    const dropped = after.board.veils.find((veil) => veil.id === veilId);
    if (dropped === undefined) throw new Error('veil vanished');
    expect(dropped.x).toBeCloseTo(0.54, 9);
    expect(dropped.y).toBeCloseTo(0.64, 9);
  });

  it('drops the queued frame on cancel so no stale position commits after release', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const seeded = await currentBattle(moduleId);
    const veilId = newId();
    await act(async () => {
      await saveBattleBoard(seeded.id, {
        ...seeded.board,
        veils: [{ id: veilId, kind: 'veil', x: 0.3, y: 0.3, widthCells: 2, heightCells: 2 }],
      });
      await flushAsyncUpdates();
    });
    vi.mocked(saveBattleBoard).mockClear();
    const veilEl = screen.getByTestId('battle-veil');
    const board = screen.getByTestId('battle-board');
    const cx = (fx: number): number => contentRect.left + fx * contentRect.width;
    const cy = (fy: number): number => contentRect.top + fy * contentRect.height;
    // Queue moves, then kill the stream off-piece before any frame lands: the
    // queued frame is cancelled, nothing commits, the gesture closes.
    fireEvent.pointerDown(veilEl, { pointerId: 9, clientX: cx(0.3), clientY: cy(0.3) });
    fireEvent.pointerMove(veilEl, { pointerId: 9, clientX: cx(0.55), clientY: cy(0.62) });
    fireEvent.pointerCancel(board, { pointerId: 9, clientX: cx(0.55), clientY: cy(0.62) });
    // Let every timer drain: a stale frame would re-lift the veil here.
    await flushAsyncUpdates();
    await flushDragFrames();
    await flushAsyncUpdates();
    expect(vi.mocked(saveBattleBoard)).not.toHaveBeenCalled();
    expect(isBoardGestureActive()).toBe(false);
    const after = await currentBattle(moduleId);
    expect(after.board.veils.find((entry) => entry.id === veilId)?.x).toBe(0.3);
  });
});

describe('selection card', () => {
  /**
   * The battle-row read is actDrained inside currentBattle itself (see the
   * helper): the pointer events stay bare fireEvents on purpose — each
   * flushes its own render, which the down→up gesture pairing (live drag
   * state) depends on.
   */
  async function tapToken(label: string, moduleId: string): Promise<void> {
    const battle = await currentBattle(moduleId);
    const token = battle.board.tokens.find((entry) => entry.label === label);
    if (token === undefined) throw new Error(`${label} missing`);
    const el = screen
      .getAllByTestId('battle-token')
      .find((element) => element.getAttribute('data-token-label') === label);
    if (el === undefined) throw new Error(`${label} element missing`);
    fireEvent.pointerDown(el, { pointerId: 2, clientX: token.x * BOARD_W, clientY: CONTENT_TOP + token.y * CONTENT_H });
    fireEvent.pointerUp(el, { pointerId: 2 });
    await flushAsyncUpdates();
  }

  it('tap shows the card: portrait art, label, HP meter — and GM mode opens the full statblock card in a dialog', async () => {
    const { moduleId, npcId } = await seedStandardBattle();
    // Give the troll's NPC artifact portrait art (same useImageUrl path).
    const image = await createImage({
      campaignId,
      blob: new Blob(['fake-png-bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
      width: 64,
      height: 64,
      prompt: 'troll portrait',
      model: 'google/gemini-2.5-flash-image',
      source: 'generated',
    });
    await updateArtifact(npcId, { coverImageId: image.id });
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    await tapToken('Troll', moduleId);
    const card = screen.getByTestId('selection-card');
    expect(within(card).getAllByText('Troll').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId('selection-card-portrait')).toBeInTheDocument();
    expect(screen.getByTestId('selection-card-hp')).toBeInTheDocument();
    // GM-only sidebar stat block is visible immediately after selecting the mob.
    expect(screen.getByTestId('selection-card-statblock')).toHaveTextContent('AC');
    // The existing full-card button remains available for the richer artifact card.
    const user = userEvent.setup();
    await user.click(screen.getByTestId('open-token-card'));
    const dialogCard = await screen.findByTestId('play-npc-card');
    expect(dialogCard.textContent).toContain('AC');
    await flushAsyncUpdates();
  });

  it('player-safe mode shows the card but never the full-card button or stat text', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('player-safe-toggle'));
    await tapToken('Troll', moduleId);
    // The two-tier card: portrait/label/HP show, the statblock button does not.
    expect(screen.getByTestId('selection-card')).toBeInTheDocument();
    expect(screen.queryByTestId('open-token-card')).toBeNull();
    expect(screen.queryByTestId('play-npc-card')).toBeNull();
    expect(screen.queryByTestId('token-controls')).toBeNull();
    // Player-safe DOM contract holds with the card mounted.
    const surface = screen.getByTestId('battle-surface');
    expect(surface.textContent).not.toContain('AC');
    expect(surface.textContent).not.toContain('Hit Dice');
    expect(surface.textContent).not.toContain('Regenerates');
    await flushAsyncUpdates();
  });

  it('tapping the empty board deselects; panning does not', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    await tapToken('Troll', moduleId);
    expect(screen.getByTestId('selection-card')).toBeInTheDocument();
    // Background tap (letterbox strip below the content div): clears it.
    const board = screen.getByTestId('battle-board');
    fireEvent.pointerDown(board, { pointerId: 9, clientX: 40, clientY: 550 });
    fireEvent.pointerUp(board, { pointerId: 9, clientX: 40, clientY: 550 });
    await flushAsyncUpdates();
    expect(screen.queryByTestId('selection-card')).toBeNull();
    expect(screen.queryByTestId('token-controls')).toBeNull();
    // A pan drag (well past the threshold) keeps the selection.
    await tapToken('Troll', moduleId);
    expect(screen.getByTestId('selection-card')).toBeInTheDocument();
    fireEvent.pointerDown(board, { pointerId: 10, clientX: 40, clientY: 550 });
    fireEvent.pointerMove(board, { pointerId: 10, clientX: 340, clientY: 550 });
    fireEvent.pointerUp(board, { pointerId: 10, clientX: 340, clientY: 550 });
    await flushAsyncUpdates();
    expect(screen.getByTestId('selection-card')).toBeInTheDocument();
  });
});

describe('token HP edge strip', () => {
  it('renders the HP meter as a thin bottom strip whose fill width is the HP ratio — never a full-area wash', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const trollEl = screen
      .getAllByTestId('battle-token')
      .find((element) => element.getAttribute('data-token-label') === 'Troll');
    if (trollEl === undefined) throw new Error('troll element missing');
    const meter = within(trollEl).getByTestId('hp-meter');
    // Edge bar: thin, bottom-anchored, rounded — the portrait stays uncovered.
    expect(meter.className).toContain('h-1.5');
    expect(meter.className).toContain('bottom-1');
    expect(meter.className).toContain('rounded-full');
    expect(meter.className).not.toContain('bg-emerald-500/45');
    expect(meter.getAttribute('aria-hidden')).toBe('true');
    expect(meter.style.height).toBe('');
    // Full HP (84/84): the inner fill spans the whole track via WIDTH.
    const fill = meter.firstElementChild as HTMLElement | null;
    if (fill === null) throw new Error('hp fill missing');
    expect(fill.style.width).toBe('100%');
  });

  it('keeps the downed overlay and grayscale exactly as-is at 0 HP', async () => {
    const { moduleId } = await seedStandardBattle();
    const battle = await currentBattle(moduleId);
    await saveBattleBoard(battle.id, {
      ...battle.board,
      tokens: battle.board.tokens.map((token) => (token.label === 'Troll' ? { ...token, currentHp: 0 } : token)),
    });
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const trollEl = screen
      .getAllByTestId('battle-token')
      .find((element) => element.getAttribute('data-token-label') === 'Troll');
    if (trollEl === undefined) throw new Error('troll element missing');
    expect(within(trollEl).getByTestId('downed-overlay')).toBeInTheDocument();
    expect(trollEl.querySelector('.grayscale')).not.toBeNull();
    // The strip survives at 0 HP with an empty fill.
    const meter = within(trollEl).getByTestId('hp-meter');
    expect((meter.firstElementChild as HTMLElement | null)?.style.width).toBe('0%');
  });
});

describe('token portrait lightbox', () => {
  async function tapTokenEl(label: string, moduleId: string): Promise<HTMLElement> {
    const battle = await currentBattle(moduleId);
    const token = battle.board.tokens.find((entry) => entry.label === label);
    if (token === undefined) throw new Error(`${label} missing`);
    const el = screen
      .getAllByTestId('battle-token')
      .find((element) => element.getAttribute('data-token-label') === label);
    if (el === undefined) throw new Error(`${label} element missing`);
    fireEvent.pointerDown(el, { pointerId: 2, clientX: token.x * BOARD_W, clientY: CONTENT_TOP + token.y * CONTENT_H });
    fireEvent.pointerUp(el, { pointerId: 2 });
    await flushAsyncUpdates();
    return el;
  }

  async function seedTrollPortrait(npcId: string): Promise<void> {
    const image = await createImage({
      campaignId,
      blob: new Blob(['fake-png-bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
      width: 64,
      height: 64,
      prompt: 'troll portrait',
      model: 'google/gemini-2.5-flash-image',
      source: 'generated',
    });
    await updateArtifact(npcId, { coverImageId: image.id });
  }

  it('GM taps stay select-only: no portrait, and the rail stays usable', async () => {
    const { moduleId, npcId } = await seedStandardBattle();
    await seedTrollPortrait(npcId);
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    await tapTokenEl('Troll', moduleId);
    // Select-only: the card + controls mount, but no modal buries the rail
    // (a modal marks the background inert, which would hide the Damage/Heal
    // buttons from both the GM and the accessibility tree until dismissed).
    expect(screen.queryByTestId('token-lightbox')).toBeNull();
    expect(screen.getByTestId('selection-card')).toBeInTheDocument();
    expect(screen.getByTestId('token-controls')).toBeInTheDocument();
    expect(screen.getByTestId('roll-damage')).toBeInTheDocument();
    expect(screen.getByTestId('roll-heal')).toBeInTheDocument();
    // Constant ± steppers are gone — fixed amounts go through the roller's
    // own ± modifier steppers.
    expect(screen.queryByRole('button', { name: 'Damage 10' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Heal 10' })).toBeNull();
    await flushAsyncUpdates();
  });

  it('opens with large initials for imageless tokens — no dead taps', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('player-safe-toggle'));
    // Serren (PC) carries no cover art, so the token falls back to initials.
    await tapTokenEl('Serren', moduleId);
    const lightbox = screen.getByTestId('token-lightbox');
    expect(within(lightbox).getByTestId('token-lightbox-name')).toHaveTextContent('Serren');
    expect(within(lightbox).getByTestId('token-lightbox-initials')).toHaveTextContent('S');
    expect(within(lightbox).queryByTestId('zoomable-image')).toBeNull();
    await flushAsyncUpdates();
  });

  it('never opens on a drag at/above the 8px threshold — the move still commits', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const battle = await currentBattle(moduleId);
    const pcToken = battle.board.tokens.find((token) => token.label === 'Serren');
    if (pcToken === undefined) throw new Error('pc token missing');
    const tokenEl = screen
      .getAllByTestId('battle-token')
      .find((element) => element.getAttribute('data-token-label') === 'Serren');
    if (tokenEl === undefined) throw new Error('serren element missing');
    fireEvent.pointerDown(tokenEl, { pointerId: 1, clientX: pcToken.x * BOARD_W, clientY: pcToken.y * BOARD_H });
    fireEvent.pointerMove(tokenEl, { pointerId: 1, clientX: 0.62 * BOARD_W, clientY: 0.58 * BOARD_H });
    fireEvent.pointerUp(tokenEl, { pointerId: 1 });
    await flushAsyncUpdates();
    expect(screen.queryByTestId('token-lightbox')).toBeNull();
    const after = await currentBattle(moduleId);
    expect(after.board.tokens.find((token) => token.label === 'Serren')?.x).not.toBe(pcToken.x);
  });

  it('board-level release fallback still tap-selects in GM mode without opening the portrait', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const battle = await currentBattle(moduleId);
    const troll = battle.board.tokens.find((token) => token.label === 'Troll');
    if (troll === undefined) throw new Error('troll missing');
    const trollEl = screen
      .getAllByTestId('battle-token')
      .find((element) => element.getAttribute('data-token-label') === 'Troll');
    if (trollEl === undefined) throw new Error('troll element missing');
    const board = screen.getByTestId('battle-board');
    const x = troll.x * BOARD_W;
    const y = CONTENT_TOP + troll.y * CONTENT_H;
    fireEvent.pointerDown(trollEl, { pointerId: 3, clientX: x, clientY: y });
    fireEvent.pointerUp(board, { pointerId: 3, clientX: x, clientY: y });
    await flushAsyncUpdates();
    // The off-piece release finishes with tap-select semantics (no leaked
    // lift), and GM mode opens no portrait.
    expect(screen.queryByTestId('token-lightbox')).toBeNull();
    expect(screen.getByTestId('selection-card')).toBeInTheDocument();
  });

  it('player-safe tap that lifts off the token node still opens the portrait', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('player-safe-toggle'));
    const battle = await currentBattle(moduleId);
    const troll = battle.board.tokens.find((token) => token.label === 'Troll');
    if (troll === undefined) throw new Error('troll missing');
    const trollEl = screen
      .getAllByTestId('battle-token')
      .find((element) => element.getAttribute('data-token-label') === 'Troll');
    if (trollEl === undefined) throw new Error('troll element missing');
    const board = screen.getByTestId('battle-board');
    const x = troll.x * BOARD_W;
    const y = CONTENT_TOP + troll.y * CONTENT_H;
    fireEvent.pointerDown(trollEl, { pointerId: 5, clientX: x, clientY: y });
    fireEvent.pointerUp(board, { pointerId: 5, clientX: x, clientY: y });
    await flushAsyncUpdates();
    expect(screen.getByTestId('token-lightbox')).toBeInTheDocument();
  });

  it('opens the portrait in player-safe mode with name + image only', async () => {
    const { moduleId, npcId } = await seedStandardBattle();
    await seedTrollPortrait(npcId);
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('player-safe-toggle'));
    await tapTokenEl('Troll', moduleId);
    const lightbox = screen.getByTestId('token-lightbox');
    expect(within(lightbox).getByTestId('token-lightbox-name')).toHaveTextContent('Troll');
    expect(within(lightbox).getByTestId('zoomable-image')).toBeInTheDocument();
    // True fullscreen (peek-modal fill contract): the dialog box IS the
    // viewport, not a capped card — generated portraits upscale to fill.
    expect(lightbox.className).toContain('h-dvh');
    expect(lightbox.className).toContain('w-dvw');
    const surface = screen.getByTestId('battle-surface');
    expect(surface.textContent).not.toContain('AC');
    expect(surface.textContent).not.toContain('Hit Dice');
    expect(surface.textContent).not.toContain('Regenerates');
    await flushAsyncUpdates();
  });

  it('player-safe drag past the threshold never opens the portrait and never moves the token', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('player-safe-toggle'));
    const battle = await currentBattle(moduleId);
    const troll = battle.board.tokens.find((token) => token.label === 'Troll');
    if (troll === undefined) throw new Error('troll missing');
    const trollEl = screen
      .getAllByTestId('battle-token')
      .find((element) => element.getAttribute('data-token-label') === 'Troll');
    if (trollEl === undefined) throw new Error('troll element missing');
    const x = troll.x * BOARD_W;
    const y = CONTENT_TOP + troll.y * CONTENT_H;
    fireEvent.pointerDown(trollEl, { pointerId: 4, clientX: x, clientY: y });
    fireEvent.pointerMove(trollEl, { pointerId: 4, clientX: x + 60, clientY: y });
    fireEvent.pointerUp(trollEl, { pointerId: 4 });
    await flushAsyncUpdates();
    expect(screen.queryByTestId('token-lightbox')).toBeNull();
    const after = await currentBattle(moduleId);
    expect(after.board.tokens.find((token) => token.label === 'Troll')?.x).toBe(troll.x);
  });

  it('closes on Escape and returns focus to the previously focused control', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('player-safe-toggle'));
    const toggle = screen.getByTestId('player-safe-toggle');
    toggle.focus();
    await tapTokenEl('Troll', moduleId);
    expect(screen.getByTestId('token-lightbox')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByTestId('token-lightbox')).toBeNull();
    });
    expect(document.activeElement).toBe(toggle);
  });

  it('closes on tap-outside (backdrop)', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('player-safe-toggle'));
    await tapTokenEl('Troll', moduleId);
    expect(screen.getByTestId('token-lightbox')).toBeInTheDocument();
    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    if (overlay === null) throw new Error('dialog overlay missing');
    await user.click(overlay);
    await waitFor(() => {
      expect(screen.queryByTestId('token-lightbox')).toBeNull();
    });
  });
});

describe('sidebar portrait fullscreen', () => {
  /**
   * GM-mode select: pointer down→up on the piece (select-only — the board
   * never opens the portrait here, so the sidebar button is the entry).
   */
  async function selectToken(label: string, moduleId: string): Promise<void> {
    const battle = await currentBattle(moduleId);
    const token = battle.board.tokens.find((entry) => entry.label === label);
    if (token === undefined) throw new Error(`${label} missing`);
    const el = screen
      .getAllByTestId('battle-token')
      .find((element) => element.getAttribute('data-token-label') === label);
    if (el === undefined) throw new Error(`${label} element missing`);
    fireEvent.pointerDown(el, { pointerId: 2, clientX: token.x * BOARD_W, clientY: CONTENT_TOP + token.y * CONTENT_H });
    fireEvent.pointerUp(el, { pointerId: 2 });
    await flushAsyncUpdates();
  }

  async function seedTrollPortrait(npcId: string): Promise<void> {
    const image = await createImage({
      campaignId,
      blob: new Blob(['fake-png-bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
      width: 64,
      height: 64,
      prompt: 'troll portrait',
      model: 'google/gemini-2.5-flash-image',
      source: 'generated',
    });
    await updateArtifact(npcId, { coverImageId: image.id });
  }

  it('GM mode: the sidebar image opens the same fullscreen portrait (image + name only), Esc returns focus to it', async () => {
    const { moduleId, npcId } = await seedStandardBattle();
    await seedTrollPortrait(npcId);
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    await selectToken('Troll', moduleId);
    // Select-only board tap: the card mounts, no portrait yet.
    expect(screen.getByTestId('selection-card')).toBeInTheDocument();
    expect(screen.queryByTestId('token-lightbox')).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('selection-card-portrait-button'));
    // The lightbox's own useImageUrl resolves a tick after mount (null while
    // loading), so wait for the image — the same art the sidebar showed.
    await waitFor(() => {
      expect(screen.getByTestId('zoomable-image')).toBeInTheDocument();
    });
    const lightbox = screen.getByTestId('token-lightbox');
    // The SAME lightbox the board tokens use: image + name only, never stats.
    expect(within(lightbox).getByTestId('token-lightbox-name')).toHaveTextContent('Troll');
    expect(within(lightbox).getByTestId('zoomable-image')).toBeInTheDocument();
    expect(within(lightbox).queryByTestId('selection-card-statblock')).toBeNull();
    expect(lightbox.textContent).not.toContain('AC');
    // Esc dismisses and focus returns to the sidebar portrait button, so the
    // rail (Damage/Heal) stays usable without re-selecting.
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByTestId('token-lightbox')).toBeNull();
    });
    expect(document.activeElement).toBe(screen.getByTestId('selection-card-portrait-button'));
    expect(screen.getByTestId('roll-damage')).toBeInTheDocument();
    expect(screen.getByTestId('roll-heal')).toBeInTheDocument();
    await flushAsyncUpdates();
  });

  it('player-safe mode: the sidebar image opens the same fullscreen portrait (image + name only)', async () => {
    const { moduleId, npcId } = await seedStandardBattle();
    await seedTrollPortrait(npcId);
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('player-safe-toggle'));
    // The board tap opens the portrait (existing path) — dismiss it so the
    // sidebar button is the entry under test.
    await selectToken('Troll', moduleId);
    expect(screen.getByTestId('token-lightbox')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByTestId('token-lightbox')).toBeNull();
    });
    // Selection survives the dismiss; the sidebar shows the same image.
    expect(screen.getByTestId('selection-card-portrait-button')).toBeInTheDocument();
    await user.click(screen.getByTestId('selection-card-portrait-button'));
    // The lightbox's own useImageUrl resolves a tick after mount (null while
    // loading), so wait for the image — the same art the sidebar showed.
    await waitFor(() => {
      expect(screen.getByTestId('zoomable-image')).toBeInTheDocument();
    });
    const lightbox = screen.getByTestId('token-lightbox');
    expect(within(lightbox).getByTestId('token-lightbox-name')).toHaveTextContent('Troll');
    expect(within(lightbox).getByTestId('zoomable-image')).toBeInTheDocument();
    // Player-safe DOM contract holds with the sidebar-opened lightbox mounted.
    const surface = screen.getByTestId('battle-surface');
    expect(surface.textContent).not.toContain('AC');
    expect(surface.textContent).not.toContain('Hit Dice');
    expect(surface.textContent).not.toContain('Regenerates');
    await flushAsyncUpdates();
  });

  it('imageless entries: the initials fallback is not clickable and opens nothing', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    // Serren (PC) carries no cover art, so the card falls back to initials.
    await selectToken('Serren', moduleId);
    expect(screen.getByTestId('selection-card')).toBeInTheDocument();
    expect(screen.getByTestId('selection-card-initials')).toHaveTextContent('S');
    // No portrait button mounts — the fallback is plain text, never a dead
    // affordance.
    expect(screen.queryByTestId('selection-card-portrait-button')).toBeNull();
    expect(screen.getByTestId('selection-card-initials').closest('button')).toBeNull();
    fireEvent.click(screen.getByTestId('selection-card-initials'));
    await flushAsyncUpdates();
    expect(screen.queryByTestId('token-lightbox')).toBeNull();
    await flushAsyncUpdates();
  });

  it('sidebar portrait lightbox closes on backdrop click and on the close button', async () => {
    const { moduleId, npcId } = await seedStandardBattle();
    await seedTrollPortrait(npcId);
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const user = userEvent.setup();
    await selectToken('Troll', moduleId);
    await user.click(screen.getByTestId('selection-card-portrait-button'));
    expect(screen.getByTestId('token-lightbox')).toBeInTheDocument();
    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    if (overlay === null) throw new Error('dialog overlay missing');
    await user.click(overlay);
    await waitFor(() => {
      expect(screen.queryByTestId('token-lightbox')).toBeNull();
    });
    // Reopen and dismiss via the dialog close button.
    await user.click(screen.getByTestId('selection-card-portrait-button'));
    expect(screen.getByTestId('token-lightbox')).toBeInTheDocument();
    const close = document.querySelector('[data-slot="dialog-close"]');
    if (close === null) throw new Error('dialog close button missing');
    await user.click(close);
    await waitFor(() => {
      expect(screen.queryByTestId('token-lightbox')).toBeNull();
    });
    await flushAsyncUpdates();
  });
});

describe('pan from the map', () => {
  /** The transformed background wrapper (pan/zoom transform lives here). */
  function panWrapper(): HTMLElement {
    const wrapper = screen
      .getByTestId('battle-board')
      .querySelector<HTMLElement>(':scope > [data-board-background="true"]');
    if (wrapper === null) throw new Error('background wrapper missing');
    return wrapper;
  }

  /** Surface with a real map image so gestures start on the <img> itself. */
  async function renderWithMap(): Promise<string> {
    const { moduleId } = await seedStandardBattle();
    const image = await createImage({
      campaignId,
      blob: new Blob(['fake-png-bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
      width: 64,
      height: 64,
      prompt: 'battlemap',
      model: 'google/gemini-2.5-flash-image',
      source: 'generated',
    });
    const seeded = await currentBattle(moduleId);
    await act(async () => {
      await saveBattleBoard(seeded.id, { ...seeded.board, mapImageId: image.id });
      await flushAsyncUpdates();
    });
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getByTestId('battle-map')).toBeInTheDocument();
    });
    return moduleId;
  }

  it('pans the board when the drag starts on the map image — no commits, selection preserved, tap still deselects', async () => {
    const moduleId = await renderWithMap();
    // Select a token first: pan-dragging the map must preserve it.
    const battle = await currentBattle(moduleId);
    const troll = battle.board.tokens.find((token) => token.label === 'Troll');
    if (troll === undefined) throw new Error('troll missing');
    const trollEl = screen
      .getAllByTestId('battle-token')
      .find((el) => el.getAttribute('data-token-label') === 'Troll');
    if (trollEl === undefined) throw new Error('troll element missing');
    fireEvent.pointerDown(trollEl, { pointerId: 2, clientX: troll.x * BOARD_W, clientY: CONTENT_TOP + troll.y * CONTENT_H });
    fireEvent.pointerUp(trollEl, { pointerId: 2 });
    await flushAsyncUpdates();
    expect(screen.getByTestId('selection-card')).toBeInTheDocument();

    vi.mocked(saveBattleBoard).mockClear();
    // Drag on the map image (120, -40 client px): the board transform follows.
    const map = screen.getByTestId('battle-map');
    fireEvent.pointerDown(map, { pointerId: 11, clientX: 400, clientY: 300 });
    fireEvent.pointerMove(map, { pointerId: 11, clientX: 520, clientY: 260 });
    await flushAsyncUpdates();
    expect(panWrapper().style.transform).toContain('translate(120px');
    expect(panWrapper().style.transform).toContain('-40px');
    fireEvent.pointerUp(map, { pointerId: 11, clientX: 520, clientY: 260 });
    await flushAsyncUpdates();
    // Well past the 8px screen-space threshold: a pan, not a tap-deselect —
    // the selection survives — and ZERO Dexie writes (no token/veil commit).
    expect(screen.getByTestId('selection-card')).toBeInTheDocument();
    expect(saveBattleBoard).not.toHaveBeenCalled();

    // A sub-threshold press+release on the map is a TAP: it deselects.
    fireEvent.pointerDown(map, { pointerId: 12, clientX: 300, clientY: 300 });
    fireEvent.pointerUp(map, { pointerId: 12, clientX: 300, clientY: 300 });
    await flushAsyncUpdates();
    expect(screen.queryByTestId('selection-card')).toBeNull();

    // A token drag still moves the TOKEN, not the camera: exactly one commit
    // (the snapped token drop) and the pan transform is untouched.
    const fresh = await currentBattle(moduleId);
    const serren = fresh.board.tokens.find((token) => token.label === 'Serren');
    if (serren === undefined) throw new Error('serren missing');
    const serrenEl = screen
      .getAllByTestId('battle-token')
      .find((el) => el.getAttribute('data-token-label') === 'Serren');
    if (serrenEl === undefined) throw new Error('serren element missing');
    fireEvent.pointerDown(serrenEl, { pointerId: 13, clientX: serren.x * BOARD_W, clientY: CONTENT_TOP + serren.y * CONTENT_H });
    fireEvent.pointerMove(serrenEl, { pointerId: 13, clientX: serren.x * BOARD_W + 60, clientY: CONTENT_TOP + serren.y * CONTENT_H });
    fireEvent.pointerUp(serrenEl, { pointerId: 13 });
    await flushAsyncUpdates();
    const after = await currentBattle(moduleId);
    const moved = after.board.tokens.find((token) => token.label === 'Serren');
    if (moved === undefined) throw new Error('serren vanished');
    expect(moved.x).not.toBe(serren.x);
    expect(saveBattleBoard).toHaveBeenCalledTimes(1);
    expect(panWrapper().style.transform).toContain('translate(120px');
    expect(panWrapper().style.transform).toContain('-40px');
  });

  it('keeps pinch zoom working when both fingers land on the map image', async () => {
    await renderWithMap();
    const map = screen.getByTestId('battle-map');
    // Two pointers down on the map → pinch (pan state is cleared), the same
    // pairing the letterbox background has always had. The first move only
    // captures the pinch base; the second one drives the zoom.
    fireEvent.pointerDown(map, { pointerId: 20, clientX: 400, clientY: 300 });
    fireEvent.pointerDown(map, { pointerId: 21, clientX: 410, clientY: 300 });
    fireEvent.pointerMove(map, { pointerId: 20, clientX: 500, clientY: 300 });
    fireEvent.pointerMove(map, { pointerId: 20, clientX: 1300, clientY: 300 });
    await flushAsyncUpdates();
    // 90px base → 890px spread ≈ ×9.9, clamped to the 4× maximum.
    expect(screen.getByText('400%')).toBeInTheDocument();
    // Release clears the pinch; a later map drag pans again (no stuck pinch).
    fireEvent.pointerUp(map, { pointerId: 20, clientX: 500, clientY: 300 });
    fireEvent.pointerUp(map, { pointerId: 21, clientX: 410, clientY: 300 });
    fireEvent.pointerDown(map, { pointerId: 22, clientX: 400, clientY: 300 });
    fireEvent.pointerMove(map, { pointerId: 22, clientX: 440, clientY: 300 });
    fireEvent.pointerUp(map, { pointerId: 22, clientX: 440, clientY: 300 });
    await flushAsyncUpdates();
    expect(panWrapper().style.transform).toContain('translate(40px');
  });

  it('pans from the mapless viewport board too (fallback gradient is a pan surface)', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const content = screen
      .getByTestId('battle-board')
      .querySelector<HTMLElement>('[data-board-content="true"]');
    if (content === null) throw new Error('content frame missing');
    const gradient = content.firstElementChild;
    if (
      !(gradient instanceof HTMLElement) ||
      gradient.getAttribute('data-board-background') !== 'true'
    ) {
      throw new Error('fallback gradient missing');
    }
    fireEvent.pointerDown(gradient, { pointerId: 14, clientX: 400, clientY: 300 });
    fireEvent.pointerMove(gradient, { pointerId: 14, clientX: 460, clientY: 330 });
    fireEvent.pointerUp(gradient, { pointerId: 14 });
    await flushAsyncUpdates();
    const wrapper = panWrapper();
    expect(wrapper.style.transform).toContain('translate(60px');
    expect(wrapper.style.transform).toContain('30px');
  });
});

describe('content-frame pointer conversion', () => {
  it('commits a token where the pointer was under zoom AND pan', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    // Disable the 72px grid so the committed spot is EXACTLY the pointer's
    // content-frame fraction (snapPoint is the identity without a grid).
    const seeded = await currentBattle(moduleId);
    await act(async () => {
      await saveBattleBoard(seeded.id, { ...seeded.board, gridSize: null });
      await flushAsyncUpdates();
    });
    const user = userEvent.setup();
    // Zoom to exactly 1.5625 (two ×1.25 steps — exact in binary floating
    // point), then pan +100/−50 by dragging the background.
    await user.click(screen.getByLabelText('Zoom in'));
    await user.click(screen.getByLabelText('Zoom in'));
    const zoom = 1.5625;
    const pan = { x: 100, y: -50 };
    const board = screen.getByTestId('battle-board');
    fireEvent.pointerDown(board, { pointerId: 7, clientX: 400, clientY: 300 });
    fireEvent.pointerMove(board, { pointerId: 7, clientX: 400 + pan.x, clientY: 300 + pan.y });
    fireEvent.pointerUp(board, { pointerId: 7 });
    // The rect the browser would report for the transformed content element.
    contentRect = transformedContentRect(zoom, pan);
    const battle = await currentBattle(moduleId);
    const serren = battle.board.tokens.find((token) => token.label === 'Serren');
    if (serren === undefined) throw new Error('serren token missing');
    const serrenEl = screen
      .getAllByTestId('battle-token')
      .find((element) => element.getAttribute('data-token-label') === 'Serren');
    if (serrenEl === undefined) throw new Error('serren element missing');
    const cx = (fx: number): number => contentRect.left + fx * contentRect.width;
    const cy = (fy: number): number => contentRect.top + fy * contentRect.height;
    fireEvent.pointerDown(serrenEl, { pointerId: 3, clientX: cx(0.55), clientY: cy(0.35) });
    fireEvent.pointerMove(serrenEl, { pointerId: 3, clientX: cx(0.7), clientY: cy(0.45) });
    fireEvent.pointerUp(serrenEl, { pointerId: 3 });
    await flushAsyncUpdates();
    const after = await currentBattle(moduleId);
    const moved = after.board.tokens.find((token) => token.label === 'Serren');
    // Committed exactly where the pointer was — the container-frame bug would
    // drift by (s−c)(1−1/zoom) + pan/zoom + letterbox here.
    expect(moved?.x).toBeCloseTo(0.7, 9);
    expect(moved?.y).toBeCloseTo(0.45, 9);
  });

  it('snaps y against the content frame under letterbox (72px grid)', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const battle = await currentBattle(moduleId);
    const troll = battle.board.tokens.find((token) => token.label === 'Troll');
    if (troll === undefined) throw new Error('troll token missing');
    const trollEl = screen
      .getAllByTestId('battle-token')
      .find((element) => element.getAttribute('data-token-label') === 'Troll');
    if (trollEl === undefined) throw new Error('troll element missing');
    // Move to content fraction (0.5, 0.5): the grid overlay renders INSIDE
    // the 450-high content div, so y-snap must quantize against 450, not the
    // 600-high container.
    fireEvent.pointerDown(trollEl, { pointerId: 3, clientX: 80, clientY: 120 });
    fireEvent.pointerMove(trollEl, { pointerId: 3, clientX: 400, clientY: 300 });
    fireEvent.pointerUp(trollEl, { pointerId: 3 });
    await flushAsyncUpdates();
    const after = await currentBattle(moduleId);
    const moved = after.board.tokens.find((token) => token.label === 'Troll');
    if (moved === undefined) throw new Error('troll vanished');
    // Span-1 snap lands the centre mid-cell in CONTENT px: ≡36 (mod 72).
    expect(Math.abs(((moved.x * BOARD_W) % 72) - 36)).toBeLessThan(1e-6);
    expect(Math.abs(((moved.y * CONTENT_H) % 72) - 36)).toBeLessThan(1e-6);
    // 225 content px → block 3 → 252/450 = 0.56 (the container frame would
    // snap 300 container px to 0.54 — the letterbox drift this pins out).
    expect(moved.y).toBeCloseTo(0.56, 9);
  });

  it('keeps the 8px tap threshold screen-space across zoom', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const user = userEvent.setup();

    function tokenEl(label: string): HTMLElement {
      const element = screen
        .getAllByTestId('battle-token')
        .find((entry) => entry.getAttribute('data-token-label') === label);
      if (element === undefined) throw new Error(`${label} element missing`);
      return element;
    }

    // Zoom to the 4× clamp (7 ×1.25 steps overshoot; clampZoom pins 4).
    for (let click = 0; click < 7; click += 1) {
      await user.click(screen.getByLabelText('Zoom in'));
    }
    contentRect = transformedContentRect(4, { x: 0, y: 0 });
    // A 20-client-px move at 4× reads 5 board-px under a zoom-scaled
    // threshold (→ tap); screen-space pins it as a DRAG that commits.
    const serrenEl = tokenEl('Serren');
    fireEvent.pointerDown(serrenEl, { pointerId: 3, clientX: 400, clientY: 300 });
    fireEvent.pointerMove(serrenEl, { pointerId: 3, clientX: 420, clientY: 300 });
    fireEvent.pointerUp(serrenEl, { pointerId: 3 });
    await flushAsyncUpdates();
    const dragged = (await currentBattle(moduleId)).board.tokens.find(
      (token) => token.label === 'Serren',
    );
    // Committed the snapped content-frame spot of the moved-to fraction
    // (0.5, 0.5 → 0.495/0.56) — a tap would have left the row untouched.
    expect(dragged?.x).toBeCloseTo(0.495, 9);
    expect(dragged?.y).toBeCloseTo(0.56, 9);

    // Zoom back out to the 0.35 clamp. A 6-client-px move stays a TAP
    // (screen-space); a zoom-scaled threshold would read ~17 board-px and
    // commit a drag.
    const miraBefore = (await currentBattle(moduleId)).board.tokens.find(
      (token) => token.label === 'Mira',
    );
    if (miraBefore === undefined) throw new Error('mira token missing');
    for (let click = 0; click < 11; click += 1) {
      await user.click(screen.getByLabelText('Zoom out'));
    }
    contentRect = transformedContentRect(0.35, { x: 0, y: 0 });
    const miraEl = tokenEl('Mira');
    fireEvent.pointerDown(miraEl, { pointerId: 4, clientX: 200, clientY: 300 });
    fireEvent.pointerMove(miraEl, { pointerId: 4, clientX: 206, clientY: 300 });
    fireEvent.pointerUp(miraEl, { pointerId: 4 });
    await flushAsyncUpdates();
    const miraAfter = (await currentBattle(moduleId)).board.tokens.find(
      (token) => token.label === 'Mira',
    );
    expect(miraAfter?.x).toBe(miraBefore.x);
    expect(miraAfter?.y).toBe(miraBefore.y);
    // Tap selected Mira instead of committing a drag.
    expect(screen.getByTestId('token-controls')).toBeInTheDocument();
    expect(screen.getByTestId('selection-card').textContent).toContain('Mira');
  });
});

describe('HP ownership split writes', () => {
  it('rolls damage onto the NPC token instance and the PC artifact (steppers gone — the roller is the only HP path)', async () => {
    const { moduleId, npcId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });

    async function selectByLabel(label: string): Promise<void> {
      const battle = await currentBattle(moduleId);
      const token = battle.board.tokens.find((entry) => entry.label === label);
      if (token === undefined) throw new Error(`${label} missing`);
      const el = screen
        .getAllByTestId('battle-token')
        .find((element) => element.getAttribute('data-token-label') === label);
      if (el === undefined) throw new Error(`${label} element missing`);
      fireEvent.pointerDown(el, { pointerId: 1, clientX: token.x * BOARD_W, clientY: token.y * BOARD_H });
      fireEvent.pointerUp(el, { pointerId: 1 });
      await flushAsyncUpdates();
    }

    const user = userEvent.setup();

    // NPC damage via the roller (stub settles 7): token instance HP changes;
    // the artifact never does.
    await selectByLabel('Troll');
    await user.click(screen.getByTestId('roll-damage'));
    await user.click(screen.getByTestId('stub-apply-roll'));
    await waitFor(() => {
      expect(screen.getByTestId('token-hp')).toHaveTextContent('HP 77 / 84');
    });
    let battle = await currentBattle(moduleId);
    expect(battle.board.tokens.find((token) => token.label === 'Troll')?.currentHp).toBe(77);
    // HP writes re-fire the artifacts live query on the timed queue — the
    // raw read is actDrained so the emission stays inside act (docs/08).
    const artifacts = await actDrained(() => listArtifactsByCampaign(campaignId));
    const trollArtifact = artifacts.find((artifact) => artifact.id === npcId);
    expect(trollArtifact?.kind === 'npc' && 'currentHp' in trollArtifact.data).toBe(false);

    // PC damage via the roller: the pc artifact's currentHp changes
    // (persists across battles).
    await selectByLabel('Serren');
    await user.click(screen.getByTestId('roll-damage'));
    await user.click(screen.getByTestId('stub-apply-roll'));
    await waitFor(() => {
      expect(screen.getByTestId('token-hp')).toHaveTextContent('HP 13 / 20 (persists)');
    });
    const refreshed = await actDrained(() => listArtifactsByCampaign(campaignId));
    const serren = refreshed.find((artifact) => artifact.kind === 'pc' && artifact.name === 'Serren');
    if (serren?.kind !== 'pc') throw new Error('serren missing');
    expect(serren.data.currentHp).toBe(13);
    battle = await currentBattle(moduleId);
    expect(battle.board.tokens.find((token) => token.label === 'Serren')?.currentHp).toBeNull();
    await flushAsyncUpdates();
  });

  it('mounts Damage/Heal directly below the name, above the lengthy description', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const battle = await currentBattle(moduleId);
    const troll = battle.board.tokens.find((token) => token.label === 'Troll');
    if (troll === undefined) throw new Error('troll missing');
    const trollEl = screen
      .getAllByTestId('battle-token')
      .find((element) => element.getAttribute('data-token-label') === 'Troll');
    if (trollEl === undefined) throw new Error('troll element missing');
    fireEvent.pointerDown(trollEl, { pointerId: 1, clientX: troll.x * BOARD_W, clientY: troll.y * BOARD_H });
    fireEvent.pointerUp(trollEl, { pointerId: 1 });
    await flushAsyncUpdates();
    const card = screen.getByTestId('selection-card');
    const name = within(card).getByTestId('selection-card-name');
    const damage = within(card).getByTestId('roll-damage');
    const heal = within(card).getByTestId('roll-heal');
    const statblock = within(card).getByTestId('selection-card-statblock');
    // Name → actions → description: the lengthy statblock must not push the
    // Damage/Heal buttons out of view.
    expect(name.compareDocumentPosition(damage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(heal.compareDocumentPosition(statblock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await flushAsyncUpdates();
  });

  it('shows the downed overlay when a token hits 0 HP', async () => {
    const { moduleId } = await seedStandardBattle();
    const battle = await currentBattle(moduleId);
    const troll = battle.board.tokens.find((token) => token.label === 'Troll');
    if (troll === undefined) throw new Error('troll missing');
    await saveBattleBoard(battle.id, {
      ...battle.board,
      tokens: battle.board.tokens.map((token) => (token.label === 'Troll' ? { ...token, currentHp: 0 } : token)),
    });
    await renderSurface(moduleId);
    await flushAsyncUpdates();
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    expect(screen.getByTestId('downed-overlay')).toBeInTheDocument();
  });
});

describe('initiative', () => {
  it('rolls every visible fighter when enabled, sorted, with a turn marker', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('toggle-initiative'));
    await flushAsyncUpdates();
    const battle = await currentBattle(moduleId);
    expect(battle.board.initiativeEnabled).toBe(true);
    expect(battle.board.initiativeOrder).toHaveLength(3);
    const totals = battle.board.initiativeOrder.map((id) => {
      const token = battle.board.tokens.find((entry) => entry.id === id);
      if (token === undefined) throw new Error('order token missing');
      return (token.initiativeRoll ?? 0) + (token.initiativeBonus ?? 0);
    });
    const sorted = [...totals].sort((left, right) => right - left);
    expect(totals).toEqual(sorted);
    await waitFor(() => {
      expect(screen.getByTestId('initiative-sidebar')).toBeInTheDocument();
    });
    expect(screen.getAllByTestId('initiative-entry')).toHaveLength(3);
  });

  it('gates initiative reorder behind GM view: moves in GM mode, hidden in player-safe', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('toggle-initiative'));
    await waitFor(() => {
      expect(screen.getByTestId('initiative-sidebar')).toBeInTheDocument();
    });
    // GM view: every row offers its up/down moves.
    expect(screen.getAllByTestId('initiative-move-up').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('initiative-move-down').length).toBeGreaterThan(0);
    // Player-safe view: the order, totals, and turn controls stay, but no
    // row can be moved — players never reorder.
    await user.click(screen.getByTestId('player-safe-toggle'));
    await flushAsyncUpdates();
    expect(screen.getAllByTestId('initiative-entry').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('initiative-move-up')).toBeNull();
    expect(screen.queryByTestId('initiative-move-down')).toBeNull();
    // Back to GM: the moves return.
    await user.click(screen.getByTestId('player-safe-toggle'));
    await flushAsyncUpdates();
    expect(screen.getAllByTestId('initiative-move-up').length).toBeGreaterThan(0);
  });

  it('keeps a fogged monster in GM initiative with a veiled marker; player-safe prunes it and the GM re-rolls it back', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('toggle-initiative'));
    await flushAsyncUpdates();
    let battle = await currentBattle(moduleId);
    expect(battle.board.initiativeOrder).toHaveLength(3);
    expect(screen.queryByTestId('veiled-marker')).toBeNull();

    // Fog over the troll → the GM KEEPS it in the order with a veiled badge
    // (GM honesty: the GM sees everything under their own veils), and the GM
    // board still shows the troll above the fog.
    const troll = battle.board.tokens.find((token) => token.label === 'Troll');
    if (troll === undefined) throw new Error('troll missing');
    await act(async () => {
      await saveBattleBoard(battle.id, {
        ...battle.board,
        veils: [{ id: newId(), kind: 'fog', x: troll.x, y: troll.y, widthCells: 2, heightCells: 2 }],
      });
      await flushAsyncUpdates();
    });
    battle = await currentBattle(moduleId);
    expect(battle.board.initiativeOrder).toHaveLength(3);
    await waitFor(() => {
      const labels = screen.queryAllByTestId('battle-token').map((el) => el.getAttribute('data-token-label'));
      expect(labels).toContain('Troll');
      expect(labels).toContain('Serren');
    });
    const trollRow = screen
      .getAllByTestId('initiative-entry')
      .find((el) => el.textContent.includes('Troll'));
    if (trollRow === undefined) throw new Error('troll initiative row missing');
    expect(within(trollRow).getByTestId('veiled-marker')).toHaveTextContent('veiled');

    // Player-safe view: the fogged troll prunes from the shared order (the
    // player-safe computation is byte-identical to the old visible-only rule
    // — no leak), with no badge and no Hidden group anywhere.
    await user.click(screen.getByTestId('player-safe-toggle'));
    await flushAsyncUpdates();
    battle = await currentBattle(moduleId);
    expect(battle.board.initiativeOrder).toHaveLength(2);
    expect(screen.getAllByTestId('initiative-entry')).toHaveLength(2);
    expect(screen.queryByTestId('veiled-marker')).toBeNull();
    expect(screen.queryByTestId('hidden-group')).toBeNull();

    // Back to GM: the veiled troll re-enters with a fresh auto-roll + badge.
    await user.click(screen.getByTestId('player-safe-toggle'));
    await flushAsyncUpdates();
    battle = await currentBattle(moduleId);
    expect(battle.board.initiativeOrder).toHaveLength(3);
    const rolled = battle.board.tokens.find((token) => token.label === 'Troll');
    expect(rolled?.initiativeRoll).not.toBeNull();
    await waitFor(() => {
      expect(screen.getAllByTestId('veiled-marker')).toHaveLength(1);
    });

    // Lift the fog → still 3, badge gone.
    await act(async () => {
      await saveBattleBoard(battle.id, { ...battle.board, veils: [] });
      await flushAsyncUpdates();
    });
    battle = await currentBattle(moduleId);
    expect(battle.board.initiativeOrder).toHaveLength(3);
    await waitFor(() => {
      expect(screen.queryByTestId('veiled-marker')).toBeNull();
    });
  });
});

describe('token removal (token-lifecycle arc)', () => {
  async function tapToken(label: string, moduleId: string): Promise<void> {
    const battle = await currentBattle(moduleId);
    const token = battle.board.tokens.find((entry) => entry.label === label);
    if (token === undefined) throw new Error(`${label} missing`);
    const el = screen
      .getAllByTestId('battle-token')
      .find((element) => element.getAttribute('data-token-label') === label);
    if (el === undefined) throw new Error(`${label} element missing`);
    fireEvent.pointerDown(el, { pointerId: 2, clientX: token.x * BOARD_W, clientY: CONTENT_TOP + token.y * CONTENT_H });
    fireEvent.pointerUp(el, { pointerId: 2 });
    await flushAsyncUpdates();
  }

  it('removes an NPC-backed mob token with a loud toast; artifact, roster row, and portrait survive', async () => {
    const { moduleId, encounterId, npcId } = await seedStandardBattle();
    // Portrait art on the mob artifact (the removal must not detach it).
    const image = await createImage({
      campaignId,
      blob: new Blob(['fake-png-bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
      width: 64,
      height: 64,
      prompt: 'troll portrait',
      model: 'google/gemini-2.5-flash-image',
      source: 'generated',
    });
    await updateArtifact(npcId, { coverImageId: image.id });
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const user = userEvent.setup();
    // Initiative on so the removal must also drop the order entry.
    await user.click(screen.getByTestId('toggle-initiative'));
    await flushAsyncUpdates();
    let battle = await currentBattle(moduleId);
    const troll = battle.board.tokens.find((token) => token.label === 'Troll');
    if (troll === undefined) throw new Error('troll missing');
    expect(battle.board.initiativeOrder).toContain(troll.id);

    vi.clearAllMocks();
    await tapToken('Troll', moduleId);
    expect(screen.getByTestId('selection-card')).toBeInTheDocument();
    await user.click(screen.getByLabelText('Remove token'));
    await flushAsyncUpdates();

    // Board token gone, initiative entry gone, card deselected — with a loud
    // toast naming the mob.
    battle = await currentBattle(moduleId);
    expect(battle.board.tokens.some((token) => token.label === 'Troll')).toBe(false);
    expect(battle.board.initiativeOrder).not.toContain(troll.id);
    expect(screen.queryByTestId('selection-card')).toBeNull();
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining('Troll'));
    // Artifact, roster row, and portrait are NEVER deleted by board removal.
    const artifact = await actDrained(() => getAnyArtifact(npcId));
    if (artifact?.kind !== 'npc') throw new Error('mob artifact missing after removal');
    expect(artifact.coverImageId).toBe(image.id);
    expect(await actDrained(() => db.images.get(image.id))).not.toBeUndefined();
    const encounter = await actDrained(() => getAnyArtifact(encounterId));
    if (encounter?.kind !== 'encounter') throw new Error('encounter missing after removal');
    expect(encounter.data.monsters).toHaveLength(1);
  });

  it('refuses PC-backed tokens: no Remove affordance and the token stays', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    vi.clearAllMocks();
    await tapToken('Serren', moduleId);
    expect(screen.getByTestId('selection-card')).toBeInTheDocument();
    // PC HP lives on the artifact — the card offers no removal at all.
    expect(screen.queryByLabelText('Remove token')).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
    const battle = await currentBattle(moduleId);
    expect(battle.board.tokens.some((token) => token.label === 'Serren')).toBe(true);
  });
});

describe('Hidden group (token-lifecycle arc)', () => {
  it('lists hidden tokens for the GM; Unhide returns them to the board with a fresh initiative roll', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('toggle-initiative'));
    await flushAsyncUpdates();
    let battle = await currentBattle(moduleId);
    expect(battle.board.initiativeOrder).toHaveLength(3);

    // The eye toggle hides the troll: off the board DOM AND out of the order.
    const troll = battle.board.tokens.find((token) => token.label === 'Troll');
    if (troll === undefined) throw new Error('troll missing');
    await act(async () => {
      await saveBattleBoard(battle.id, {
        ...battle.board,
        tokens: battle.board.tokens.map((token) =>
          token.id === troll.id ? { ...token, visible: false } : token,
        ),
      });
      await flushAsyncUpdates();
    });
    battle = await currentBattle(moduleId);
    expect(battle.board.initiativeOrder).toHaveLength(2);
    await waitFor(() => {
      const labels = screen.queryAllByTestId('battle-token').map((el) => el.getAttribute('data-token-label'));
      expect(labels).not.toContain('Troll');
    });
    // The trap door is gone: the GM-only Hidden group names it with Unhide.
    expect(screen.getByTestId('hidden-group')).toHaveTextContent('Hidden (1)');
    expect(screen.getByLabelText('Unhide Troll')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Unhide Troll'));
    await flushAsyncUpdates();
    battle = await currentBattle(moduleId);
    expect(battle.board.tokens.find((token) => token.label === 'Troll')?.visible).toBe(true);
    // Unhide re-enters via the existing newcomer auto-roll.
    expect(battle.board.initiativeOrder).toHaveLength(3);
    expect(battle.board.tokens.find((token) => token.label === 'Troll')?.initiativeRoll).not.toBeNull();
    await waitFor(() => {
      const labels = screen.queryAllByTestId('battle-token').map((el) => el.getAttribute('data-token-label'));
      expect(labels).toContain('Troll');
      expect(screen.queryByTestId('hidden-group')).toBeNull();
    });
  });

  it('shows no Hidden group in player-safe view — hidden fighters stay secret', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('toggle-initiative'));
    await flushAsyncUpdates();
    let battle = await currentBattle(moduleId);
    const troll = battle.board.tokens.find((token) => token.label === 'Troll');
    if (troll === undefined) throw new Error('troll missing');
    await act(async () => {
      await saveBattleBoard(battle.id, {
        ...battle.board,
        tokens: battle.board.tokens.map((token) =>
          token.id === troll.id ? { ...token, visible: false } : token,
        ),
      });
      await flushAsyncUpdates();
    });
    await waitFor(() => {
      expect(screen.getByTestId('hidden-group')).toBeInTheDocument();
    });
    // Player-safe: the group vanishes (and the pruned order stays pruned).
    await user.click(screen.getByTestId('player-safe-toggle'));
    await flushAsyncUpdates();
    expect(screen.queryByTestId('hidden-group')).toBeNull();
    battle = await currentBattle(moduleId);
    expect(battle.board.initiativeOrder).toHaveLength(2);
    // Back to GM: the group returns.
    await user.click(screen.getByTestId('player-safe-toggle'));
    await flushAsyncUpdates();
    await waitFor(() => {
      expect(screen.getByTestId('hidden-group')).toHaveTextContent('Hidden (1)');
    });
  });
});

describe('resume reveal (everLive — encounter-resume arc)', () => {
  it('reveals every token on the first entry, then a Lift → re-enter keeps hidden tokens hidden', async () => {
    const { moduleId } = await seedStandardBattle();
    // First entry after a seed: the prep board goes live and reveals all.
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    await flushAsyncUpdates();
    let battle = await currentBattle(moduleId);
    expect(battle.board.live).toBe(true);
    expect(battle.board.everLive).toBe(true);
    expect(battle.board.tokens.every((token) => token.visible)).toBe(true);

    // The GM hides a fighter and lifts the battle off the table.
    const troll = battle.board.tokens.find((token) => token.label === 'Troll');
    if (troll === undefined) throw new Error('troll token missing');
    await act(async () => {
      await saveBattleBoard(battle.id, {
        ...battle.board,
        tokens: battle.board.tokens.map((token) =>
          token.id === troll.id ? { ...token, visible: false } : token,
        ),
        live: false,
      });
      await flushAsyncUpdates();
    });
    cleanup();

    // Re-entry resumes: live returns, the reveal does NOT re-run — the
    // deliberately hidden troll stays off the board.
    await renderSurface(moduleId);
    await flushAsyncUpdates();
    const labels = screen
      .getAllByTestId('battle-token')
      .map((el) => el.getAttribute('data-token-label'));
    expect(labels).not.toContain('Troll');
    battle = await currentBattle(moduleId);
    expect(battle.board.live).toBe(true);
    expect(battle.board.everLive).toBe(true);
    expect(battle.board.tokens.find((token) => token.id === troll.id)?.visible).toBe(false);
  });
});

describe('re-seed + provenance (encounter-resume arc)', () => {
  it('shows the seeding provenance, re-seeds destructively after confirm, and stamps the row', async () => {
    const { moduleId, encounterId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    await flushAsyncUpdates();
    // The rail names the seeding encounter (GM view).
    expect(screen.getByTestId('battle-provenance').textContent).toContain('Bridge ambush');

    // Drift the running board: a saved stage snapshot that re-seeding must
    // discard.
    const battle = await currentBattle(moduleId);
    await act(async () => {
      await saveBattleStage(battle.id, battle.board);
      await flushAsyncUpdates();
    });
    expect((await currentBattle(moduleId)).board.stage).not.toBeNull();

    const user = userEvent.setup();
    await user.click(screen.getByTestId('reseed-battle'));
    await user.click(screen.getByTestId('confirm-reseed'));
    await flushAsyncUpdates();

    const reseeded = await currentBattle(moduleId);
    expect(reseeded.board.stage).toBeNull();
    expect(reseeded.encounterArtifactId).toBe(encounterId);
    // Provenance records who/when/what replaced the board.
    const reseed = reseeded.reseed;
    expect(reseed).not.toBeNull();
    if (reseed !== null) {
      expect(reseed.encounterArtifactId).toBe(encounterId);
      expect(reseed.encounterName).toBe('Bridge ambush');
      expect(reseed.at).toBeGreaterThan(0);
    }
    // The fresh board went live on the table with the reveal spent.
    expect(reseeded.board.live).toBe(true);
    expect(reseeded.board.everLive).toBe(true);
    // And the rail records the re-seed.
    await flushAsyncUpdates();
    expect(screen.getByTestId('battle-reseed-line').textContent).toContain('Bridge ambush');
  });

  it('hides the re-seed affordance and provenance when the battle has no provenance', async () => {
    const module = await saveModule(
      createModule({
        campaignId,
        title: 'Bare Module',
        concept: '',
        levelMin: 1,
        levelMax: 4,
        sizeDial: 'sketch',
      }),
    );
    await ensureBattle(campaignId, module.id);
    await renderSurface(module.id);
    await flushAsyncUpdates();
    expect(screen.queryByTestId('reseed-battle')).toBeNull();
    expect(screen.queryByTestId('battle-provenance')).toBeNull();
    await flushAsyncUpdates();
  });
});

describe('effect markers (D7 — geometric forms, encounter-resume arc)', () => {
  it('adds a disc from the toolbar and renders it in BOTH views at ~70% transparent fill', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('add-effect-disc'));
    await flushAsyncUpdates();
    const effect = screen.getByTestId('battle-effect');
    expect(effect).toHaveAttribute('data-effect-shape', 'disc');
    // ~70% transparent: the fill carries alpha 0x4d (≈30% opacity) and the
    // border reads at 0xcc — static values, never opacity swings. (jsdom
    // normalizes the 8-digit hex to rgba.)
    expect(effect.style.backgroundColor).toBe('rgba(255, 0, 0, 0.3)');
    expect(effect.style.borderColor).toBe('rgba(255, 0, 0, 0.8)');
    const row = await currentBattle(moduleId);
    expect(row.board.effects).toHaveLength(1);
    expect(row.board.effects[0]?.shape).toBe('disc');
    expect(row.board.effects[0]?.sizeCells).toBe(1);
    // Player view: the marker is board material — still on the table, but
    // the GM-only creation affordances are disabled.
    await user.click(screen.getByTestId('player-safe-toggle'));
    await flushAsyncUpdates();
    expect(screen.getByTestId('battle-effect')).toBeInTheDocument();
    expect(screen.getByTestId('add-effect-disc')).toBeDisabled();
  });

  it('drags an effect with a live position and commits the snapped drop exactly once', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const seeded = await currentBattle(moduleId);
    const effectId = newId();
    await act(async () => {
      await saveBattleBoard(seeded.id, {
        ...seeded.board,
        effects: [{ id: effectId, shape: 'square', x: 0.3, y: 0.3, sizeCells: 1, color: '#ffe600', label: '' }],
      });
      await flushAsyncUpdates();
    });
    vi.mocked(saveBattleBoard).mockClear();
    const effectEl = screen.getByTestId('battle-effect');
    const cx = (fx: number): number => contentRect.left + fx * contentRect.width;
    const cy = (fy: number): number => contentRect.top + fy * contentRect.height;
    fireEvent.pointerDown(effectEl, { pointerId: 7, clientX: cx(0.3), clientY: cy(0.3) });
    fireEvent.pointerMove(effectEl, { pointerId: 7, clientX: cx(0.55), clientY: cy(0.62) });
    await flushAsyncUpdates();
    // The LOCAL marker follows the pointer, lifted while dragging.
    expect(Number.parseFloat(effectEl.style.left) / 100).toBeCloseTo(0.55, 9);
    expect(Number.parseFloat(effectEl.style.top) / 100).toBeCloseTo(0.62, 9);
    expect(effectEl.className).toContain('z-20');
    expect(saveBattleBoard).not.toHaveBeenCalled();
    // Release: exactly one commit, snapped like a token/veil drop.
    fireEvent.pointerUp(effectEl, { pointerId: 7 });
    await flushAsyncUpdates();
    expect(saveBattleBoard).toHaveBeenCalledTimes(1);
    const after = await currentBattle(moduleId);
    const dropped = after.board.effects.find((entry) => entry.id === effectId);
    if (dropped === undefined) throw new Error('effect vanished');
    // Drop fraction (0.55, 0.62) → a 1×1 span quantizes its center to the
    // middle of a 72px cell: (468/800, 252/450) = (0.585, 0.56).
    expect(dropped.x).toBeCloseTo(0.585, 9);
    expect(dropped.y).toBeCloseTo(0.56, 9);
    // The marker's EDGES land on cell boundaries (center ≡ ½cell mod cell).
    expect(Math.abs((dropped.x * BOARD_W - 36) % 72)).toBeLessThan(1e-6);
    expect(Math.abs((dropped.y * CONTENT_H - 36) % 72)).toBeLessThan(1e-6);
  });

  it('gives effect resize handles a 44px touch target while the visible dot stays small', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const seeded = await currentBattle(moduleId);
    const effectId = newId();
    await act(async () => {
      await saveBattleBoard(seeded.id, {
        ...seeded.board,
        effects: [{ id: effectId, shape: 'disc', x: 0.3, y: 0.3, sizeCells: 1, color: '#ff0000', label: '' }],
      });
      await flushAsyncUpdates();
    });
    // GM view, unlocked board: all four edge handles render (veil parity).
    for (const edge of ['n', 's', 'e', 'w'] as const) {
      const handle = screen.getByTestId(`effect-handle-${edge}`);
      // The 44px (size-11) transparent hit pad lives on the button itself…
      expect(handle.className).toContain('size-11');
      // …with the visible affordance unchanged at 12px (size-3) inside.
      const dot = handle.querySelector('span');
      if (dot === null) throw new Error(`effect handle ${edge} lost its visible dot`);
      expect(dot.className).toContain('size-3');
    }
  });

  it('drags an effect handle with a live preview and commits the final size exactly once', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const seeded = await currentBattle(moduleId);
    const effectId = newId();
    await act(async () => {
      await saveBattleBoard(seeded.id, {
        ...seeded.board,
        effects: [{ id: effectId, shape: 'square', x: 0.3, y: 0.3, sizeCells: 1, color: '#ff0000', label: '' }],
      });
      await flushAsyncUpdates();
    });
    vi.mocked(saveBattleBoard).mockClear();
    const effectEl = screen.getByTestId('battle-effect');
    const handle = screen.getByTestId('effect-handle-e');
    const beforeWidth = effectEl.style.width;
    const beforeLeft = effectEl.style.left;
    // The 1-cell marker spans 72px centered at 0.3: its east rim sits 36px
    // right of center. Dragging one full cell (72px) further out lands the
    // half-span at 1.5 cells → symmetric size 3, center fixed.
    const rimX = 0.3 * BOARD_W + 36;
    const midY = CONTENT_TOP + 0.3 * CONTENT_H;
    fireEvent.pointerDown(handle, { pointerId: 11, clientX: rimX, clientY: midY });
    fireEvent.pointerMove(handle, { pointerId: 11, clientX: rimX + 72, clientY: midY });
    await flushAsyncUpdates();
    // The LOCAL marker previews the grown size with zero writes mid-gesture.
    expect(effectEl.style.width).not.toBe(beforeWidth);
    expect(effectEl.style.left).toBe(beforeLeft);
    expect(saveBattleBoard).not.toHaveBeenCalled();
    // Release: exactly one commit carrying the final size; center untouched.
    fireEvent.pointerUp(handle, { pointerId: 11 });
    await flushAsyncUpdates();
    expect(saveBattleBoard).toHaveBeenCalledTimes(1);
    expect(isBoardGestureActive()).toBe(false);
    const after = await currentBattle(moduleId);
    const resized = after.board.effects.find((entry) => entry.id === effectId);
    if (resized === undefined) throw new Error('effect vanished');
    expect(resized.sizeCells).toBe(3);
    expect(resized.x).toBe(0.3);
    expect(resized.y).toBe(0.3);
  });

  it('cancelling an effect resize commits nothing and closes the gesture', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const seeded = await currentBattle(moduleId);
    const effectId = newId();
    await act(async () => {
      await saveBattleBoard(seeded.id, {
        ...seeded.board,
        effects: [{ id: effectId, shape: 'disc', x: 0.3, y: 0.3, sizeCells: 1, color: '#ffe600', label: '' }],
      });
      await flushAsyncUpdates();
    });
    vi.mocked(saveBattleBoard).mockClear();
    const storedWidth = screen.getByTestId('battle-effect').style.width;
    const handle = screen.getByTestId('effect-handle-e');
    const rimX = 0.3 * BOARD_W + 36;
    const midY = CONTENT_TOP + 0.3 * CONTENT_H;
    fireEvent.pointerDown(handle, { pointerId: 12, clientX: rimX, clientY: midY });
    fireEvent.pointerMove(handle, { pointerId: 12, clientX: rimX + 72, clientY: midY });
    await flushAsyncUpdates();
    expect(isBoardGestureActive()).toBe(true);
    fireEvent.pointerCancel(handle, { pointerId: 12 });
    await flushAsyncUpdates();
    expect(saveBattleBoard).not.toHaveBeenCalled();
    expect(isBoardGestureActive()).toBe(false);
    const after = await currentBattle(moduleId);
    expect(after.board.effects.find((entry) => entry.id === effectId)?.sizeCells).toBe(1);
    // The preview is gone: the marker renders its stored size again.
    expect(screen.getByTestId('battle-effect').style.width).toBe(storedWidth);
  });

  it('scenery lock and player-safe hide the effect handles and pin the size', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const seeded = await currentBattle(moduleId);
    const effectId = newId();
    await act(async () => {
      await saveBattleBoard(seeded.id, {
        ...seeded.board,
        sceneryMovementLocked: true,
        effects: [{ id: effectId, shape: 'square', x: 0.3, y: 0.3, sizeCells: 1, color: '#ff0000', label: '' }],
      });
      await flushAsyncUpdates();
    });
    // Locked: no handles to grab — the veil gating, identically.
    expect(screen.queryByTestId('effect-handle-e')).toBeNull();
    vi.mocked(saveBattleBoard).mockClear();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('player-safe-toggle'));
    await flushAsyncUpdates();
    // Player view: still no handles (board material renders, affordances do not).
    expect(screen.getByTestId('battle-effect')).toBeInTheDocument();
    expect(screen.queryByTestId('effect-handle-e')).toBeNull();
    expect(saveBattleBoard).not.toHaveBeenCalled();
  });

  it('resizes and deletes the selected effect from the rail (GM view only)', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const seeded = await currentBattle(moduleId);
    const effectId = newId();
    await act(async () => {
      await saveBattleBoard(seeded.id, {
        ...seeded.board,
        effects: [{ id: effectId, shape: 'disc', x: 0.7, y: 0.4, sizeCells: 1, color: '#000000', label: '' }],
      });
      await flushAsyncUpdates();
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('battle-effect'));
    await flushAsyncUpdates();
    expect(screen.getByTestId('effect-controls')).toBeInTheDocument();
    await user.click(screen.getByTestId('grow-effect'));
    await flushAsyncUpdates();
    expect((await currentBattle(moduleId)).board.effects[0]?.sizeCells).toBe(2);
    await user.click(screen.getByTestId('shrink-effect'));
    await flushAsyncUpdates();
    expect((await currentBattle(moduleId)).board.effects[0]?.sizeCells).toBe(1);
    // The floor pins: Shrink stays disabled at one cell.
    expect(screen.getByTestId('shrink-effect')).toBeDisabled();
    await user.click(screen.getByTestId('delete-effect'));
    await flushAsyncUpdates();
    expect((await currentBattle(moduleId)).board.effects).toHaveLength(0);
    expect(screen.queryByTestId('effect-controls')).toBeNull();
  });

  it('scenery lock blocks effect drags — no movement, no commit', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const seeded = await currentBattle(moduleId);
    const effectId = newId();
    await act(async () => {
      await saveBattleBoard(seeded.id, {
        ...seeded.board,
        sceneryMovementLocked: true,
        effects: [{ id: effectId, shape: 'square', x: 0.3, y: 0.3, sizeCells: 1, color: '#ff0000', label: '' }],
      });
      await flushAsyncUpdates();
    });
    vi.mocked(saveBattleBoard).mockClear();
    const effectEl = screen.getByTestId('battle-effect');
    const cx = (fx: number): number => contentRect.left + fx * contentRect.width;
    const cy = (fy: number): number => contentRect.top + fy * contentRect.height;
    fireEvent.pointerDown(effectEl, { pointerId: 9, clientX: cx(0.3), clientY: cy(0.3) });
    fireEvent.pointerMove(effectEl, { pointerId: 9, clientX: cx(0.55), clientY: cy(0.62) });
    fireEvent.pointerUp(effectEl, { pointerId: 9 });
    await flushAsyncUpdates();
    expect(saveBattleBoard).not.toHaveBeenCalled();
    const after = await currentBattle(moduleId);
    expect(after.board.effects.find((entry) => entry.id === effectId)?.x).toBe(0.3);
  });

  it('stage reset restores removed effects from the snapshot', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('add-effect-square'));
    await flushAsyncUpdates();
    await user.click(screen.getByTestId('set-stage'));
    await user.click(screen.getByTestId('confirm-stage'));
    await flushAsyncUpdates();
    // Drift: remove the effect entirely.
    const drifted = await currentBattle(moduleId);
    await act(async () => {
      await saveBattleBoard(drifted.id, { ...drifted.board, effects: [] });
      await flushAsyncUpdates();
    });
    expect(screen.queryByTestId('battle-effect')).toBeNull();
    await user.click(screen.getByTestId('reset-stage'));
    await flushAsyncUpdates();
    const restored = screen.getByTestId('battle-effect');
    expect(restored).toHaveAttribute('data-effect-shape', 'square');
  });
});

describe('in-battle spawn picker (spawn-picker arc)', () => {
  it('shows the roster readout with one Spawn button and appends a roster fighter via the picker', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const panel = screen.getByTestId('spawn-panel');
    expect(panel).toHaveTextContent('Spawn — “Bridge ambush”');
    expect(panel).toHaveTextContent('Troll ×1');
    // No per-entry buttons — one Spawn button opens the picker.
    expect(screen.queryByTestId('spawn-monster-0')).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('open-spawn-picker'));
    await waitFor(() => {
      expect(screen.getByTestId('spawn-picker')).toBeInTheDocument();
    });
    expect(screen.getByTestId('spawn-picker-group-roster')).toHaveTextContent('Troll ×1');
    await user.click(screen.getByTestId('spawn-pick-roster-0'));
    await flushAsyncUpdates();
    const row = await currentBattle(moduleId);
    const fighters = row.board.tokens.filter((token) => token.visible);
    const spawned = fighters.find((token) => token.label === 'Troll 2');
    if (spawned === undefined) throw new Error('spawned troll missing');
    // npc-ref identity: the spawned instance points at the SAME troll
    // artifact and resolves its HP through it (no stat duplication).
    const original = fighters.find((token) => token.label === 'Troll');
    if (original === undefined) throw new Error('original troll missing');
    expect(spawned.artifactId).toBe(original.artifactId);
    expect(spawned.currentHp).toBe(84);
    expect(spawned.visible).toBe(true);
    // The new token renders on the board next to the original.
    await waitFor(() => {
      const labels = screen.getAllByTestId('battle-token').map((el) => el.getAttribute('data-token-label'));
      expect(labels).toContain('Troll 2');
    });
  });

  it('auto-rolls a picker-spawned fighter into initiative (late-arrival rule)', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('toggle-initiative'));
    await flushAsyncUpdates();
    let battle = await currentBattle(moduleId);
    expect(battle.board.initiativeOrder).toHaveLength(3);
    await user.click(screen.getByTestId('open-spawn-picker'));
    await waitFor(() => {
      expect(screen.getByTestId('spawn-picker')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('spawn-pick-roster-0'));
    await flushAsyncUpdates();
    battle = await currentBattle(moduleId);
    expect(battle.board.initiativeOrder).toHaveLength(4);
    const rolled = battle.board.tokens.find((token) => token.label === 'Troll 2');
    expect(rolled?.initiativeRoll).not.toBeNull();
  });

  it('hides the spawn panel and its Spawn button in player view', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    expect(screen.getByTestId('spawn-panel')).toBeInTheDocument();
    expect(screen.getByTestId('open-spawn-picker')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('player-safe-toggle'));
    await flushAsyncUpdates();
    expect(screen.queryByTestId('spawn-panel')).toBeNull();
    expect(screen.queryByTestId('open-spawn-picker')).toBeNull();
  });
});

describe('stage snapshot', () => {
  it('resets to the saved opening layout through the toolbar', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('set-stage'));
    await user.click(screen.getByTestId('confirm-stage'));
    await flushAsyncUpdates();
    let battle = await currentBattle(moduleId);
    expect(battle.board.stage).not.toBeNull();
    // Drift the troll down, then reset through the toolbar.
    await act(async () => {
      await saveBattleBoard(battle.id, {
        ...battle.board,
        tokens: battle.board.tokens.map((token) => (token.label === 'Troll' ? { ...token, currentHp: 1 } : token)),
      });
      await flushAsyncUpdates();
    });
    await user.click(screen.getByTestId('reset-stage'));
    await flushAsyncUpdates();
    battle = await currentBattle(moduleId);
    expect(battle.board.tokens.find((token) => token.label === 'Troll')?.currentHp).toBe(84);
  });

describe('entrance overlay (doc 11)', () => {
  it('renders the stamped entrance cell with the inward-pointing triangle, player view included', async () => {
    const { moduleId } = await seedStandardBattle();
    const battle = await currentBattle(moduleId);
    // Entrance at cell (1,1) of a 12×12 grid, west side — inward is east.
    await saveBattleBoard(battle.id, {
      ...battle.board,
      mapLayout: { cols: 12, rows: 12 },
      entrance: { x: 0.125, y: 0.125, side: 'west' },
    });
    await renderSurface(moduleId);

    const entrance = screen.getByTestId('battle-entrance');
    // One map cell: centered on the entrance cell, sized 1/cols × 1/rows.
    expect(entrance.style.left).toBe(`${String(0.125 * 100 - 50 / 12)}%`);
    expect(entrance.style.top).toBe(`${String(0.125 * 100 - 50 / 12)}%`);
    expect(entrance.style.width).toBe(`${String(100 / 12)}%`);
    expect(entrance.style.height).toBe(`${String(100 / 12)}%`);
    const glyph = entrance.firstElementChild as HTMLElement | null;
    if (glyph === null) throw new Error('entrance glyph missing');
    // West side opens outward — a down-pointing glyph rotated 270deg.
    expect(glyph.style.transform).toBe('rotate(270deg)');

    // Board material: survives the player-safe toggle.
    await userEvent.click(screen.getByTestId('player-safe-toggle'));
    expect(screen.getByTestId('battle-entrance')).toBeInTheDocument();
  });

  it('renders nothing when no entrance is stamped', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    expect(screen.queryByTestId('battle-entrance')).toBeNull();
  });
});
});

describe('dice-roller damage/heal (M5-D amendment)', () => {
  async function selectByLabel(moduleId: string, label: string): Promise<void> {
    const battle = await currentBattle(moduleId);
    const token = battle.board.tokens.find((entry) => entry.label === label);
    if (token === undefined) throw new Error(`${label} missing`);
    const el = screen
      .getAllByTestId('battle-token')
      .find((element) => element.getAttribute('data-token-label') === label);
    if (el === undefined) throw new Error(`${label} element missing`);
    fireEvent.pointerDown(el, { pointerId: 1, clientX: token.x * BOARD_W, clientY: token.y * BOARD_H });
    fireEvent.pointerUp(el, { pointerId: 1 });
    await flushAsyncUpdates();
  }

  it('opens the roller with the captured intent and applies the total as damage onto the token', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const user = userEvent.setup();

    await selectByLabel(moduleId, 'Troll');
    await user.click(screen.getByTestId('roll-damage'));
    // The roller is open, aimed at the captured fighter with the damage intent.
    expect(screen.getByTestId('dice-roller-stub')).toHaveTextContent('damage');
    expect(screen.getByTestId('stub-intent-subject')).toHaveTextContent('Troll');
    // A settled roll of 7 lands as −7 HP on the NPC token instance.
    await user.click(screen.getByTestId('stub-apply-roll'));
    await waitFor(() => {
      expect(screen.getByTestId('token-hp')).toHaveTextContent('HP 77 / 84');
    });
    const battle = await currentBattle(moduleId);
    expect(battle.board.tokens.find((token) => token.label === 'Troll')?.currentHp).toBe(77);
  });

  it('applies a rolled heal through the pc artifact and clamps at max HP', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const user = userEvent.setup();

    await selectByLabel(moduleId, 'Serren');
    await user.click(screen.getByTestId('roll-heal'));
    expect(screen.getByTestId('stub-intent-kind')).toHaveTextContent('heal');
    // 7 heal on a full-HP PC: clamped to max, written to the artifact.
    await user.click(screen.getByTestId('stub-apply-roll'));
    await waitFor(() => {
      expect(screen.getByTestId('token-hp')).toHaveTextContent('HP 20 / 20 (persists)');
    });
    // The heal's artifact write re-fires the artifacts live query on the
    // timed queue — the raw read is actDrained so the emission stays inside
    // act (the act-leak the console guard caught in this test under load).
    const refreshed = await actDrained(() => listArtifactsByCampaign(campaignId));
    const serren = refreshed.find((artifact) => artifact.kind === 'pc' && artifact.name === 'Serren');
    if (serren?.kind !== 'pc') throw new Error('serren missing');
    expect(serren.data.currentHp).toBe(20);
    await flushAsyncUpdates();
  });

  it('never renders the roll controls or the roller in player view', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const user = userEvent.setup();
    await selectByLabel(moduleId, 'Troll');
    expect(screen.getByTestId('token-controls')).toBeInTheDocument();
    await user.click(screen.getByTestId('player-safe-toggle'));
    expect(screen.queryByTestId('token-controls')).toBeNull();
    expect(screen.queryByTestId('roll-damage')).toBeNull();
    expect(screen.queryByTestId('dice-roller-stub')).toBeNull();
    await flushAsyncUpdates();
  });
});

describe('rail free-roll dice button (GM-only)', () => {
  async function selectByLabel(moduleId: string, label: string): Promise<void> {
    const battle = await currentBattle(moduleId);
    const token = battle.board.tokens.find((entry) => entry.label === label);
    if (token === undefined) throw new Error(`${label} missing`);
    const el = screen
      .getAllByTestId('battle-token')
      .find((element) => element.getAttribute('data-token-label') === label);
    if (el === undefined) throw new Error(`${label} element missing`);
    fireEvent.pointerDown(el, { pointerId: 1, clientX: token.x * BOARD_W, clientY: token.y * BOARD_H });
    fireEvent.pointerUp(el, { pointerId: 1 });
    await flushAsyncUpdates();
  }

  it('opens the roller in generic free-roll mode and the settled total touches no HP', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const user = userEvent.setup();

    await selectByLabel(moduleId, 'Troll');
    expect(screen.getByTestId('token-hp')).toHaveTextContent('HP 84 / 84');
    // The rail button opens the roller with NO subject and the generic
    // intent — no pending HP target is captured.
    await user.click(screen.getByTestId('open-dice-roller'));
    expect(screen.getByTestId('dice-roller-stub')).toBeInTheDocument();
    expect(screen.getByTestId('stub-intent-kind')).toHaveTextContent('generic');
    expect(screen.getByTestId('stub-intent-subject')).toHaveTextContent('');
    // A settled roll of 7 is a safe no-op: the troll keeps full HP, both in
    // the rail readout and on the stored token instance.
    await user.click(screen.getByTestId('stub-apply-roll'));
    await flushAsyncUpdates();
    expect(screen.getByTestId('token-hp')).toHaveTextContent('HP 84 / 84');
    const battle = await currentBattle(moduleId);
    expect(battle.board.tokens.find((token) => token.label === 'Troll')?.currentHp).toBe(84);
  });

  it('a stale HP intent does not leak into the free roll: clearing it keeps HP intact', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const user = userEvent.setup();

    // Arm a damage intent, then close the roller WITHOUT rolling (the
    // stub's close button mirrors the real dialog's cancel path) — this
    // leaves the pending HP target behind, and the free-roll button must
    // clear it so the next settled total cannot land on the fighter.
    await selectByLabel(moduleId, 'Troll');
    await user.click(screen.getByTestId('roll-damage'));
    expect(screen.getByTestId('dice-roller-stub')).toBeInTheDocument();
    await user.click(screen.getByTestId('stub-close-roll'));
    await waitFor(() => {
      expect(screen.queryByTestId('dice-roller-stub')).toBeNull();
    });
    await user.click(screen.getByTestId('open-dice-roller'));
    expect(screen.getByTestId('stub-intent-kind')).toHaveTextContent('generic');
    await user.click(screen.getByTestId('stub-apply-roll'));
    await flushAsyncUpdates();
    expect(screen.getByTestId('token-hp')).toHaveTextContent('HP 84 / 84');
    const battle = await currentBattle(moduleId);
    expect(battle.board.tokens.find((token) => token.label === 'Troll')?.currentHp).toBe(84);
  });

  it('player-safe mode shows no free-roll button and never renders the roller', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    // GM view: the rail button is present.
    expect(screen.getByTestId('open-dice-roller')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('player-safe-toggle'));
    await flushAsyncUpdates();
    expect(screen.queryByTestId('open-dice-roller')).toBeNull();
    expect(screen.queryByTestId('dice-roller-stub')).toBeNull();
    await flushAsyncUpdates();
  });
});

describe('room keys + mob treasure on the surface (owner-ratified arc)', () => {
  it('GM view: key markers render at the room mobsRect CENTER (D11 fix) and tapping one opens the key card in the rail', async () => {
    const { moduleId, encounterId } = await seedKeyedBattle();
    await renderSurface(moduleId);
    await flushAsyncUpdates();
    // Only rooms WITH key content get a marker (Sanctum's is empty).
    expect(screen.getByTestId('room-key-marker-A')).toBeInTheDocument();
    expect(screen.queryByTestId('room-key-marker-B')).toBeNull();
    // The badge sits at the room's mobsRect center — never the board center
    // (the stagingPoint fallback stamped 0.5/0.5 before D11).
    const encounter = await getAnyArtifact(encounterId);
    if (encounter?.kind != 'encounter' || encounter.data.layout == null) {
      throw new Error('layout missing');
    }
    const roomA = encounter.data.layout.rooms.find((room) => room.name === 'Entry');
    if (roomA == undefined) throw new Error('room A missing');
    const roomAMobs = roomA.mobsRect;
    if (roomAMobs === undefined) throw new Error('room A missing mobsRect');
    const marker = screen.getByTestId('room-key-marker-A');
    expect(marker.style.left).toBe(
      `${String(((roomAMobs.x + roomAMobs.w / 2) / encounter.data.layout.gridW) * 100)}%`,
    );
    expect(marker.style.top).toBe(
      `${String(((roomAMobs.y + roomAMobs.h / 2) / encounter.data.layout.gridH) * 100)}%`,
    );
    // Marker text carries the key + room treasure; the GM reads it in the rail.
    fireEvent.click(screen.getByTestId('room-key-marker-A'));
    await flushAsyncUpdates();
    const card = screen.getByTestId('room-key-card');
    expect(within(card).getByText('Room A — Entry')).toBeInTheDocument();
    expect(screen.getByTestId('room-key-text')).toHaveTextContent(KEY_TEXT);
    expect(screen.getByTestId('room-key-treasure')).toHaveTextContent(KEY_TREASURE);
    // Background tap clears the selection (the pan wrapper owns the
    // down→up threshold logic).
    // Background tap clears the selection — pointerUp must restate the
    // down coords, or the down→up delta counts as a pan and keeps it.
    const board = screen.getByTestId('battle-board');
    fireEvent.pointerDown(board, { pointerId: 3, clientX: 40, clientY: 550 });
    fireEvent.pointerUp(board, { pointerId: 3, clientX: 40, clientY: 550 });
    await flushAsyncUpdates();
    expect(screen.queryByTestId('room-key-card')).toBeNull();
  });

  it('gives room-key markers a 44px hit pad with the visible badge unchanged at size-6', async () => {
    const { moduleId } = await seedKeyedBattle();
    await renderSurface(moduleId);
    await flushAsyncUpdates();
    const marker = screen.getByTestId('room-key-marker-A');
    // The 44px (size-11) transparent hit pad lives on the button itself…
    expect(marker.className).toContain('size-11');
    // …with the visible amber badge unchanged at 24px (size-6) inside.
    const badge = marker.querySelector('span');
    if (badge === null) throw new Error('room-key marker lost its visible badge');
    expect(badge.className).toContain('size-6');
    expect(badge.className).toContain('border-amber-300/70');
    expect(badge).toHaveTextContent('A');
    expect(marker).toHaveAttribute('aria-label', 'Room key A — Entry');
    // The padded button still opens the key card.
    fireEvent.click(marker);
    await flushAsyncUpdates();
    expect(screen.getByTestId('room-key-card')).toBeInTheDocument();
  });

  it('a seeded encounter’s mob covers are VEILS, rendering the plain-cover tint in both views', async () => {
    const { moduleId } = await seedKeyedBattle();
    await renderSurface(moduleId);
    await flushAsyncUpdates();
    // A generated cover over a MOB AREA is a veil, never a fog (fog-cloud
    // arc, owner-directed: "the mobs should be covered by a veil, not fog").
    // The hiding mechanic is player view REMOVING the covered mob tokens from
    // the DOM, never the fill — kind-agnostic coverage, so the seeded kind is
    // free to be the transparent one.
    const seeded = await currentBattle(moduleId);
    expect(seeded.board.veils.length).toBeGreaterThan(0);
    expect(seeded.board.veils.every((veil) => veil.kind === 'veil')).toBe(true);
    const coverEls = (): HTMLElement[] => {
      const els = screen
        .getAllByTestId('battle-veil')
        .filter((el) => el.getAttribute('data-veil-kind') === 'veil');
      expect(els).toHaveLength(seeded.board.veils.length);
      return els;
    };
    const expectPlainCover = (): void => {
      for (const el of coverEls()) {
        expect(el.className).toContain('bg-black/10');
        expect(el.className).not.toContain('bg-zinc-300');
        expect(el.className).not.toMatch(/opacity-\d/);
      }
    };
    expectPlainCover();
    await userEvent.setup().click(screen.getByTestId('player-safe-toggle'));
    await flushAsyncUpdates();
    expectPlainCover();
  });

  it('paints room-key markers BELOW veils and tokens (no z-10, DOM order decides hit-testing)', async () => {
    const { moduleId } = await seedKeyedBattle();
    await renderSurface(moduleId);
    await flushAsyncUpdates();
    const marker = screen.getByTestId('room-key-marker-A');
    // No elevated z-index: markers must lose hit-testing to tokens and
    // veil bodies wherever they overlap (the z-10 pad swallowed
    // mob/veil pointerdowns in GM view).
    expect(marker.className).not.toContain('z-10');
    // jsdom has no hit-testing, so the paint order is pinned geometrically:
    // markers mount BEFORE veils and tokens, so with equal (auto) stacking
    // the later siblings paint — and hit-test — above the marker pad.
    const followers = [...document.querySelectorAll('[data-testid="battle-veil"], [data-testid="battle-token"]')];
    expect(followers.length).toBeGreaterThan(0);
    for (const node of followers) {
      expect(marker.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // The veil bodies keep their `data-gesture-grab` hit areas — the tap
    // pass-through (ledger 65) never moves the marker layer or drops the
    // grab: reachability comes from the tap resolving under the veil, NOT
    // from z-index or from reordering (the 469f058 contract above).
    for (const veil of screen.getAllByTestId('battle-veil')) {
      expect(veil.getAttribute('data-gesture-grab')).toMatch(/^veil:/);
      expect(veil.className).not.toMatch(/\bz-\d/);
    }
    // The demoted marker still opens the key card (badge affordance kept).
    fireEvent.click(marker);
    await flushAsyncUpdates();
    expect(screen.getByTestId('room-key-card')).toBeInTheDocument();
  });

  it('GM view: tapping a treasure-carrying token shows the frozen treasure on the selection card', async () => {
    const { moduleId } = await seedKeyedBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const battle = await currentBattle(moduleId);
    const token = battle.board.tokens.find((entry) => entry.label === 'Cultist');
    if (token === undefined) throw new Error('cultist token missing');
    const el = screen
      .getAllByTestId('battle-token')
      .find((element) => element.getAttribute('data-token-label') === 'Cultist');
    if (el === undefined) throw new Error('cultist element missing');
    fireEvent.pointerDown(el, { pointerId: 2, clientX: token.x * BOARD_W, clientY: CONTENT_TOP + token.y * CONTENT_H });
    fireEvent.pointerUp(el, { pointerId: 2 });
    await flushAsyncUpdates();
    expect(screen.getByTestId('token-treasure')).toHaveTextContent(MOB_TREASURE);
  });

  it('player-safe view: no key markers and no key/treasure text anywhere in the DOM', async () => {
    const { moduleId } = await seedKeyedBattle();
    await renderSurface(moduleId);
    await flushAsyncUpdates();
    // GM view shows the marker first; then player view removes ALL of it.
    expect(screen.getByTestId('room-key-marker-A')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('room-key-marker-A'));
    expect(screen.getByTestId('room-key-card')).toBeInTheDocument();
    await user.click(screen.getByTestId('player-safe-toggle'));
    await flushAsyncUpdates();
    expect(screen.queryByTestId('room-key-marker-A')).toBeNull();
    expect(screen.queryByTestId('room-key-card')).toBeNull();
    // The M5-D player-safe DOM contract, extended to key/treasure text.
    expect(document.body.textContent).not.toContain(KEY_TEXT);
    expect(document.body.textContent).not.toContain(KEY_TREASURE);
    expect(document.body.textContent).not.toContain(MOB_TREASURE);
  });

  it('a complex site shows the GM Path rail in path order and Reveal next room lifts the next veil', async () => {
    const { moduleId } = await seedKeyedBattle();
    await renderSurface(moduleId);
    await flushAsyncUpdates();
    const rail = screen.getByTestId('path-rail');
    expect(within(rail).getByTestId('path-room-1')).toHaveTextContent('A');
    expect(within(rail).getByTestId('path-room-2')).toHaveTextContent('B');
    // Seed opens the spawn room (path room 1) — its veil is never seeded;
    // only room B stays veiled until the GM reveals it.
    const before = await currentBattle(moduleId);
    expect(before.board.veils).toHaveLength(1);
    // Reveal next room lifts room B's veil — a plain veil removal.
    await userEvent.setup().click(screen.getByTestId('reveal-next-room'));
    await flushAsyncUpdates();
    const after = await currentBattle(moduleId);
    expect(after.board.veils).toHaveLength(0);
  });

  it('a multi-group room reveals ALL its group veils through the Path rail (reveal-all, no dead end)', async () => {
    const pc1 = await addPc('Serren', 20);
    void pc1;
    const roomA = newId();
    const roomB = newId();
    const layout = packRooms({
      theme: 'Split sanctum',
      aspect: '4:3',
      entryRoomId: roomA,
      rosterCounts: [1, 1, 1],
      rooms: [
        { id: roomA, name: 'Entry', description: '', size: 'small', monsterIndexes: [0], adjacentRoomIds: [roomB], key: '', keyTreasure: '' },
        { id: roomB, name: 'Sanctum', description: '', size: 'large', monsterIndexes: [1, 2], adjacentRoomIds: [roomA], key: '', keyTreasure: '' },
      ],
    });
    const encounter = await createArtifact({
      campaignId,
      kind: 'encounter',
      name: 'Split ambush',
      data: {
        difficulty: 'hard',
        levelHint: '4',
        monsters: [1, 2, 3].map((number) => ({
          name: `Cultist ${String(number)}`,
          count: 1,
          notes: '',
          treasure: '',
          source: { type: 'inline', statBlock: statBlock({ hp: 22 }) },
        })),
        terrain: '',
        tactics: '',
        treasure: '',
        mapImageId: null,
        layout,
        preset: 'standard',
        locationKind: 'other',
        siteShape: 'complex',
        budgetAdvisory: '',
      },
    });
    const module = await saveModule(
      createModule({ campaignId, title: 'Split Module', concept: '', levelMin: 1, levelMax: 5, sizeDial: 'sketch' }),
    );
    await seedBattleFromEncounter(campaignId, module.id, encounter.id);
    await renderSurface(module.id);
    await flushAsyncUpdates();
    // Two spawn rooms ⇒ two veils: Entry primary + Sanctum merged group
    // veil (room id, so the rail resolves it) — Sanctum's adjacent groups
    // fuse at seed (overlap-merge), so no secondary veil is emitted.
    const seeded = await currentBattle(module.id);
    expect(seeded.board.veils).toHaveLength(2);
    const rail = screen.getByTestId('path-rail');
    const veiledLabel = (testId: string): string | null =>
      within(rail).getByTestId(testId).getAttribute('aria-label');
    expect(veiledLabel('path-room-1')).toContain('(veiled)');
    expect(veiledLabel('path-room-2')).toContain('(veiled)');
    const user = userEvent.setup();
    // Reveal room 1 (Entry): only its primary veil lifts.
    await user.click(screen.getByTestId('reveal-next-room'));
    await flushAsyncUpdates();
    expect((await currentBattle(module.id)).board.veils).toHaveLength(1);
    expect(veiledLabel('path-room-1')).not.toContain('(veiled)');
    // Reveal room 2 (Sanctum): reveal-all lifts the merged group veil (it
    // resolves per room via id + roomId) — no room ever reads revealed
    // while its mobs stay covered with no rail path left.
    await user.click(screen.getByTestId('reveal-next-room'));
    await flushAsyncUpdates();
    const after = await currentBattle(module.id);
    expect(after.board.veils).toHaveLength(0);
    expect(veiledLabel('path-room-2')).not.toContain('(veiled)');
    expect(screen.getByTestId('reveal-next-room')).toBeDisabled();
    // Player/GM consistency: with every Sanctum veil lifted, the covered
    // mobs are back in the player-view DOM (coverage removed nothing else).
    await user.click(screen.getByTestId('player-safe-toggle'));
    await flushAsyncUpdates();
    const labels = screen
      .getAllByTestId('battle-token')
      .map((element) => element.getAttribute('data-token-label'));
    expect(labels).toEqual(expect.arrayContaining(['Cultist 1', 'Cultist 2', 'Cultist 3']));
  });
})

describe('site shape on the surface (docs/11 D11)', () => {
  /** Seeds a single-arena encounter (one room, optional entrance) and its
   *  battle; returns the board + the spawn room for position assertions. */
  async function seedSingleSite(withEntrance: boolean) {
    const pc1 = await addPc('Serren', 20);
    void pc1;
    const roomId = newId();
    const packed = packRooms({
      theme: 'Single arena',
      aspect: '4:3',
      entryRoomId: roomId,
      rosterCounts: [1],
      rooms: [
        { id: roomId, name: 'Arena', description: '', size: 'medium', monsterIndexes: [0], adjacentRoomIds: [], key: '', keyTreasure: '' },
      ],
    });
    const layout: EncounterLayout = withEntrance
      ? packed
      : { ...packed, rooms: packed.rooms.map((room) => ({ ...room, entrance: undefined })) };
    const encounter = await createArtifact({
      campaignId,
      kind: 'encounter',
      name: 'One arena',
      data: {
        difficulty: '',
        levelHint: '',
        monsters: [{ name: 'Orc', count: 1, notes: '', treasure: '', source: { type: 'inline', statBlock: statBlock({ hp: 15 }) } }],
        terrain: '',
        tactics: '',
        treasure: '',
        mapImageId: null,
        layout,
        preset: 'standard',
        locationKind: 'wilderness',
        siteShape: 'single',
        budgetAdvisory: '',
      },
    });
    const module = await saveModule(
      createModule({ campaignId, title: 'Arena Module', concept: '', levelMin: 1, levelMax: 3, sizeDial: 'sketch' }),
    );
    const { battle } = await seedBattleFromEncounter(campaignId, module.id, encounter.id);
    const spawn = layout.rooms.find((room) => room.spawn);
    if (spawn == undefined) throw new Error('spawn room missing');
    return { battle, layout, spawn };
  }

  it('a single site seeds its spawn-group veil (no more zero-veil singles) and starts at the entrance cell', async () => {
    const { battle, layout, spawn } = await seedSingleSite(true);
    // One room, one spawn group ⇒ exactly one veil (id = room id), covering
    // the group's spawn cells — the old zero-veil exemption is gone, and a
    // generated mob cover is kind 'veil' (fog-cloud arc), never a fog.
    expect(battle.board.veils).toHaveLength(1);
    expect(battle.board.veils[0]).toMatchObject({ id: spawn.id, kind: 'veil', roomId: spawn.id });
    // The party starts AT the entrance cell when the layout carries one.
    if (spawn.entrance == undefined) throw new Error('packed arena has no entrance');
    expect(battle.board.stagingGround?.x).toBeCloseTo((spawn.entrance.x + 0.5) / layout.gridW, 9);
    expect(battle.board.stagingGround?.y).toBeCloseTo((spawn.entrance.y + 0.5) / layout.gridH, 9);
  });

  it('a single site without an entrance seeds its group veil and starts at the room mobsRect center', async () => {
    const { battle, spawn, layout } = await seedSingleSite(false);
    expect(battle.board.veils).toHaveLength(1);
    expect(battle.board.veils[0]).toMatchObject({ id: spawn.id, kind: 'veil', roomId: spawn.id });
    const spawnMobs = spawn.mobsRect;
    if (spawnMobs === undefined) throw new Error('spawn room missing mobsRect');
    expect(battle.board.stagingGround?.x).toBeCloseTo((spawnMobs.x + spawnMobs.w / 2) / layout.gridW, 9);
    expect(battle.board.stagingGround?.y).toBeCloseTo((spawnMobs.y + spawnMobs.h / 2) / layout.gridH, 9);
  });

});

describe('one-gesture-machine (unified board gesture layer)', () => {
  it('commits exactly once when the release lands on another piece — no cross-consuming finish (S1/R1)', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const seeded = await currentBattle(moduleId);
    const veilId = newId();
    await act(async () => {
      await saveBattleBoard(seeded.id, {
        ...seeded.board,
        veils: [{ id: veilId, kind: 'veil', x: 0.3, y: 0.3, widthCells: 2, heightCells: 2 }],
      });
      await flushAsyncUpdates();
    });
    const battle = await currentBattle(moduleId);
    const pcToken = battle.board.tokens.find((token) => token.label === 'Serren');
    if (pcToken === undefined) throw new Error('pc token missing');
    const tokenEl = screen
      .getAllByTestId('battle-token')
      .find((element) => element.getAttribute('data-token-label') === 'Serren');
    if (tokenEl === undefined) throw new Error('serren element missing');
    vi.mocked(saveBattleBoard).mockClear();
    // Drag the token, but release ON the veil node: one board owner means
    // one finish — the veil never consumes the token's release (the old
    // cross-consuming double finish committed twice / threw).
    fireEvent.pointerDown(tokenEl, { pointerId: 1, clientX: pcToken.x * BOARD_W, clientY: pcToken.y * BOARD_H });
    fireEvent.pointerMove(tokenEl, { pointerId: 1, clientX: 0.62 * BOARD_W, clientY: 0.58 * BOARD_H });
    fireEvent.pointerUp(screen.getByTestId('battle-veil'), { pointerId: 1, clientX: 0.62 * BOARD_W, clientY: 0.58 * BOARD_H });
    await flushAsyncUpdates();
    expect(vi.mocked(saveBattleBoard)).toHaveBeenCalledTimes(1);
    expect(isBoardGestureActive()).toBe(false);
    const after = await currentBattle(moduleId);
    expect(after.board.tokens.find((token) => token.label === 'Serren')?.x).not.toBe(pcToken.x);
    // The veil never moved — its own gesture never armed.
    expect(after.board.veils.find((entry) => entry.id === veilId)?.x).toBe(0.3);
  });

  it('ignores a second pointerdown on another piece mid-drag — no overwrite (S2/R4)', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const seeded = await currentBattle(moduleId);
    const veilId = newId();
    await act(async () => {
      await saveBattleBoard(seeded.id, {
        ...seeded.board,
        veils: [{ id: veilId, kind: 'veil', x: 0.3, y: 0.3, widthCells: 2, heightCells: 2 }],
      });
      await flushAsyncUpdates();
    });
    const battle = await currentBattle(moduleId);
    const pcToken = battle.board.tokens.find((token) => token.label === 'Serren');
    if (pcToken === undefined) throw new Error('pc token missing');
    const tokenEl = screen
      .getAllByTestId('battle-token')
      .find((element) => element.getAttribute('data-token-label') === 'Serren');
    if (tokenEl === undefined) throw new Error('serren element missing');
    const veilEl = screen.getByTestId('battle-veil');
    const cx = (fx: number): number => contentRect.left + fx * contentRect.width;
    const cy = (fy: number): number => contentRect.top + fy * contentRect.height;
    vi.mocked(saveBattleBoard).mockClear();
    // Finger 1 drags the token well past the threshold…
    fireEvent.pointerDown(tokenEl, { pointerId: 1, clientX: pcToken.x * BOARD_W, clientY: pcToken.y * BOARD_H });
    fireEvent.pointerMove(tokenEl, { pointerId: 1, clientX: 0.62 * BOARD_W, clientY: 0.58 * BOARD_H });
    // …then finger 2 grabs the veil: ignored, never an overwrite — the veil
    // does not even select (selection happens at arm, and arming is refused).
    fireEvent.pointerDown(veilEl, { pointerId: 2, clientX: cx(0.3), clientY: cy(0.3) });
    expect(screen.queryByTestId('delete-veil')).toBeNull();
    // Finger 2's moves never fold into the owner's stream (R3)…
    fireEvent.pointerMove(veilEl, { pointerId: 2, clientX: cx(0.1), clientY: cy(0.15) });
    // …so finger 1's release still commits finger 1's drop, exactly once.
    fireEvent.pointerUp(tokenEl, { pointerId: 1, clientX: 0.62 * BOARD_W, clientY: 0.58 * BOARD_H });
    fireEvent.pointerUp(veilEl, { pointerId: 2, clientX: cx(0.1), clientY: cy(0.15) });
    await flushAsyncUpdates();
    expect(vi.mocked(saveBattleBoard)).toHaveBeenCalledTimes(1);
    expect(isBoardGestureActive()).toBe(false);
    const after = await currentBattle(moduleId);
    const moved = after.board.tokens.find((token) => token.label === 'Serren');
    if (moved === undefined) throw new Error('token vanished');
    // Finger 1's zone (0.62), not finger 2's corner (0.1): no hijack.
    expect(moved.x).toBeGreaterThan(0.5);
    expect(after.board.veils.find((entry) => entry.id === veilId)?.x).toBe(0.3);
  });

  it('evaluates the scenery lock BEFORE arming: a locked grab no-ops loudly — no commit, no pan — and works after unlock (S6)', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const seeded = await currentBattle(moduleId);
    const veilId = newId();
    await act(async () => {
      await saveBattleBoard(seeded.id, {
        ...seeded.board,
        sceneryMovementLocked: true,
        veils: [{ id: veilId, kind: 'veil', x: 0.3, y: 0.3, widthCells: 2, heightCells: 2 }],
      });
      await flushAsyncUpdates();
    });
    vi.mocked(saveBattleBoard).mockClear();
    const veilEl = screen.getByTestId('battle-veil');
    const cx = (fx: number): number => contentRect.left + fx * contentRect.width;
    const cy = (fy: number): number => contentRect.top + fy * contentRect.height;
    // A grab on locked scenery arms nothing (the gate never opens) and —
    // the S6 fix — never degrades into a pan: the board transform is
    // untouched, nothing commits, nothing selects.
    fireEvent.pointerDown(veilEl, { pointerId: 9, clientX: cx(0.3), clientY: cy(0.3) });
    expect(isBoardGestureActive()).toBe(false);
    fireEvent.pointerMove(veilEl, { pointerId: 9, clientX: cx(0.55), clientY: cy(0.62) });
    fireEvent.pointerUp(veilEl, { pointerId: 9, clientX: cx(0.55), clientY: cy(0.62) });
    await flushAsyncUpdates();
    expect(vi.mocked(saveBattleBoard)).not.toHaveBeenCalled();
    expect(isBoardGestureActive()).toBe(false);
    const locked = await currentBattle(moduleId);
    expect(locked.board.veils.find((entry) => entry.id === veilId)?.x).toBe(0.3);
    const background = screen.getByTestId('battle-board').querySelector('[data-board-background]');
    expect(background?.getAttribute('style')).toContain('translate(0px, 0px) scale(1)');
    // Unlock: the same grab now arms and commits (grab-after-lock works).
    const user = userEvent.setup();
    await user.click(screen.getByTestId('toggle-scenery-lock'));
    await flushAsyncUpdates();
    vi.mocked(saveBattleBoard).mockClear();
    fireEvent.pointerDown(screen.getByTestId('battle-veil'), { pointerId: 9, clientX: cx(0.3), clientY: cy(0.3) });
    fireEvent.pointerMove(screen.getByTestId('battle-veil'), { pointerId: 9, clientX: cx(0.55), clientY: cy(0.62) });
    fireEvent.pointerUp(screen.getByTestId('battle-veil'), { pointerId: 9 });
    await flushAsyncUpdates();
    expect(vi.mocked(saveBattleBoard)).toHaveBeenCalledTimes(1);
    expect(isBoardGestureActive()).toBe(false);
    const after = await currentBattle(moduleId);
    expect(after.board.veils.find((entry) => entry.id === veilId)?.x).not.toBe(0.3);
  });

  it('resets to idle on capture loss with no commit — and the next grab works (S4)', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const battle = await currentBattle(moduleId);
    const pcToken = battle.board.tokens.find((token) => token.label === 'Serren');
    if (pcToken === undefined) throw new Error('pc token missing');
    const tokenEl = screen
      .getAllByTestId('battle-token')
      .find((element) => element.getAttribute('data-token-label') === 'Serren');
    if (tokenEl === undefined) throw new Error('serren element missing');
    const board = screen.getByTestId('battle-board');
    vi.mocked(saveBattleBoard).mockClear();
    fireEvent.pointerDown(tokenEl, { pointerId: 1, clientX: pcToken.x * BOARD_W, clientY: pcToken.y * BOARD_H });
    fireEvent.pointerMove(tokenEl, { pointerId: 1, clientX: 0.62 * BOARD_W, clientY: 0.58 * BOARD_H });
    await flushAsyncUpdates();
    // The owned stream dies mid-drag: abandon with no commit (the old code
    // had no lostpointercapture path and stranded the gesture).
    fireEvent.lostPointerCapture(board, { pointerId: 1 });
    await flushAsyncUpdates();
    expect(vi.mocked(saveBattleBoard)).not.toHaveBeenCalled();
    expect(isBoardGestureActive()).toBe(false);
    const stranded = await currentBattle(moduleId);
    expect(stranded.board.tokens.find((token) => token.label === 'Serren')?.x).toBe(pcToken.x);
    // The machine is idle again: a fresh grab arms and commits normally.
    fireEvent.pointerDown(tokenEl, { pointerId: 1, clientX: pcToken.x * BOARD_W, clientY: pcToken.y * BOARD_H });
    fireEvent.pointerMove(tokenEl, { pointerId: 1, clientX: 0.62 * BOARD_W, clientY: 0.58 * BOARD_H });
    fireEvent.pointerUp(tokenEl, { pointerId: 1 });
    await flushAsyncUpdates();
    expect(vi.mocked(saveBattleBoard)).toHaveBeenCalledTimes(1);
    expect(isBoardGestureActive()).toBe(false);
  });

  it('carries no forbidden-cursor sources and always owns the active grab visually', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const surface = screen.getByTestId('battle-surface');
    // Zero native-drag ghosts (the browser-native forbidden-cursor source)…
    expect(surface.querySelectorAll('[draggable="true"]').length).toBe(0);
    // …and zero not-allowed cursors anywhere on the surface.
    expect(surface.querySelectorAll('[class*="not-allowed"]').length).toBe(0);
    // Native HTML5 dragstart is suppressed at the board root.
    expect(fireEvent.dragStart(screen.getByTestId('battle-board'))).toBe(false);
    // An active grab is always visually owned: the dragged piece carries
    // cursor-grabbing while the stream is live…
    const battle = await currentBattle(moduleId);
    const pcToken = battle.board.tokens.find((token) => token.label === 'Serren');
    if (pcToken === undefined) throw new Error('pc token missing');
    const tokenEl = screen
      .getAllByTestId('battle-token')
      .find((element) => element.getAttribute('data-token-label') === 'Serren');
    if (tokenEl === undefined) throw new Error('serren element missing');
    fireEvent.pointerDown(tokenEl, { pointerId: 1, clientX: pcToken.x * BOARD_W, clientY: pcToken.y * BOARD_H });
    fireEvent.pointerMove(tokenEl, { pointerId: 1, clientX: 0.62 * BOARD_W, clientY: 0.58 * BOARD_H });
    await flushAsyncUpdates();
    await flushDragFrames();
    expect(tokenEl.className).toContain('cursor-grabbing');
    // …and the cursor is handed back on release.
    fireEvent.pointerUp(tokenEl, { pointerId: 1 });
    await flushAsyncUpdates();
    expect(tokenEl.className).toContain('cursor-grab');
    expect(tokenEl.className).not.toContain('cursor-grabbing');
  });
});
