import 'fake-indexeddb/auto';

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { createArtifact, listArtifactsByCampaign, updateArtifact } from '@/db/artifactRepo';
import { db } from '@/db/db';
import {
  ensureBattle,
  getBattleByModule,
  saveBattleBoard,
  saveBattleStage,
} from '@/db/battleRepo';
import type * as battleRepoModule from '@/db/battleRepo';
import type { Battle, StatBlock } from '@/domain';
import { seedBattleFromEncounter } from '@/db/battleSeed';
import { createCampaign } from '@/db/campaignRepo';
import { createImage } from '@/db/imageRepo';
import { createModule, newId, packRooms, statBlockSchema } from '@/domain';
import { createModule as saveModule } from '@/db/moduleRepo';
import { BattleSurface } from '@/features/play/battle/BattleSurface';
import { battleGridStyle } from '@/domain/battle/gridSnap';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

// Wrap (not replace) saveBattleBoard so veil-drag tests can count commits —
// zero writes while a drag is live, exactly one on release. Every other test
// keeps the real behavior.
vi.mock('@/db/battleRepo', async (importOriginal) => {
  const actual = await importOriginal<typeof battleRepoModule>();
  return { ...actual, saveBattleBoard: vi.fn(actual.saveBattleBoard) };
});

// Stub the dice roller (its own engine/UX is covered by dice-roller tests):
// here it only has to prove the integration boundary — the surface opens it
// with the captured intent and applies the settled total signed by intent.
vi.mock('@/features/dice/DiceRoller', () => ({
  DiceRoller: function StubDiceRoller(props: {
    open: boolean;
    intent?: { kind: string; subject?: string } | undefined;
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

async function currentBattle(moduleId: string) {
  const battle = await getBattleByModule(moduleId);
  if (battle === undefined) throw new Error('battle row missing');
  return battle;
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
    // Player view gets the same ~10% base — the veil never blinds anyone.
    const user = userEvent.setup();
    await user.click(screen.getByTestId('player-safe-toggle'));
    await flushAsyncUpdates();
    expectTint(screen.getByTestId('battle-veil'));
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

describe('selection card', () => {
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
    expect(within(card).getByText('Troll')).toBeInTheDocument();
    expect(screen.getByTestId('selection-card-portrait')).toBeInTheDocument();
    expect(screen.getByTestId('selection-card-hp')).toBeInTheDocument();
    // GM-only full card: the button mounts the existing NpcCard in a dialog —
    // statblock text appears there (it must NEVER appear on the board).
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
    expect(screen.getByTestId('token-controls').textContent).toContain('Mira');
  });
});

describe('HP ownership split writes', () => {
  it('damages the NPC onto the token instance and the PC onto the artifact', async () => {
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

    // NPC damage: token instance HP changes; the artifact never does.
    await selectByLabel('Troll');
    await user.click(screen.getByRole('button', { name: 'Damage 10' }));
    await waitFor(() => {
      expect(screen.getByTestId('token-hp')).toHaveTextContent('HP 74 / 84');
    });
    let battle = await currentBattle(moduleId);
    expect(battle.board.tokens.find((token) => token.label === 'Troll')?.currentHp).toBe(74);
    const artifacts = await listArtifactsByCampaign(campaignId);
    const trollArtifact = artifacts.find((artifact) => artifact.id === npcId);
    expect(trollArtifact?.kind === 'npc' && 'currentHp' in trollArtifact.data).toBe(false);

    // PC damage: the pc artifact's currentHp changes (persists across battles).
    await selectByLabel('Serren');
    await user.click(screen.getByRole('button', { name: 'Damage 5' }));
    await waitFor(() => {
      expect(screen.getByTestId('token-hp')).toHaveTextContent('HP 15 / 20 (persists)');
    });
    const refreshed = await listArtifactsByCampaign(campaignId);
    const serren = refreshed.find((artifact) => artifact.kind === 'pc' && artifact.name === 'Serren');
    if (serren?.kind !== 'pc') throw new Error('serren missing');
    expect(serren.data.currentHp).toBe(15);
    battle = await currentBattle(moduleId);
    expect(battle.board.tokens.find((token) => token.label === 'Serren')?.currentHp).toBeNull();
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

  it('prunes a fogged monster from initiative and restores it with an auto-roll when revealed', async () => {
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

    // Fog over the troll → removed from the board AND the order.
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
    expect(battle.board.initiativeOrder).toHaveLength(2);
    // The order prunes, but GM view still SEES the fogged troll on the board
    // (M5-D amendment: coverage removal from the DOM is player-view-only);
    // the PC tokens remain too.
    await waitFor(() => {
      const labels = screen.queryAllByTestId('battle-token').map((el) => el.getAttribute('data-token-label'));
      expect(labels).toContain('Troll');
      expect(labels).toContain('Serren');
    });

    // Lift the fog → back on the board with a fresh auto-roll.
    await act(async () => {
      await saveBattleBoard(battle.id, { ...battle.board, veils: [] });
      await flushAsyncUpdates();
    });
    battle = await currentBattle(moduleId);
    expect(battle.board.initiativeOrder).toHaveLength(3);
    const rolled = battle.board.tokens.find((token) => token.label === 'Troll');
    expect(rolled?.initiativeRoll).not.toBeNull();
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

describe('in-battle spawn (encounter-resume arc)', () => {
  it('offers the provenance roster in the GM rail and appends a spawned fighter to the live board', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const panel = screen.getByTestId('spawn-panel');
    expect(panel).toHaveTextContent('Spawn — “Bridge ambush”');
    expect(panel).toHaveTextContent('Troll ×1');
    const user = userEvent.setup();
    await user.click(screen.getByTestId('spawn-monster-0'));
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

  it('auto-rolls a spawned fighter into initiative (late-arrival rule)', async () => {
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
    await user.click(screen.getByTestId('spawn-monster-0'));
    await flushAsyncUpdates();
    battle = await currentBattle(moduleId);
    expect(battle.board.initiativeOrder).toHaveLength(4);
    const rolled = battle.board.tokens.find((token) => token.label === 'Troll 2');
    expect(rolled?.initiativeRoll).not.toBeNull();
  });

  it('hides the spawn panel in player view', async () => {
    const { moduleId } = await seedStandardBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    expect(screen.getByTestId('spawn-panel')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('player-safe-toggle'));
    await flushAsyncUpdates();
    expect(screen.queryByTestId('spawn-panel')).toBeNull();
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
    const refreshed = await listArtifactsByCampaign(campaignId);
    const serren = refreshed.find((artifact) => artifact.kind === 'pc' && artifact.name === 'Serren');
    if (serren?.kind !== 'pc') throw new Error('serren missing');
    expect(serren.data.currentHp).toBe(20);
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

describe('room keys + mob treasure on the surface (owner-ratified arc)', () => {
  const KEY_TEXT = 'Cracked doors hang off one hinge.';
  const KEY_TREASURE = 'Fallen banner: 15 gp';
  const MOB_TREASURE = 'Pouch: 5 gp, a bone key';

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
      },
    });
    const module = await saveModule(
      createModule({ campaignId, title: 'Keyed Module', concept: '', levelMin: 1, levelMax: 5, sizeDial: 'sketch' }),
    );
    await seedBattleFromEncounter(campaignId, module.id, encounter.id);
    return { moduleId: module.id, encounterId: encounter.id };
  }

  it('GM view: key markers render at room staging points and tapping one opens the key card in the rail', async () => {
    const { moduleId } = await seedKeyedBattle();
    await renderSurface(moduleId);
    await flushAsyncUpdates();
    // Only rooms WITH key content get a marker (Sanctum's is empty).
    expect(screen.getByTestId('room-key-marker-A')).toBeInTheDocument();
    expect(screen.queryByTestId('room-key-marker-B')).toBeNull();
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
});
