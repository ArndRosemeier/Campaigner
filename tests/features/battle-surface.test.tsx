import 'fake-indexeddb/auto';

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { createArtifact } from '@/db/artifactRepo';
import { getBattleByModule, saveBattleBoard } from '@/db/battleRepo';
import { seedBattleFromEncounter } from '@/db/battleSeed';
import { createCampaign } from '@/db/campaignRepo';
import { listArtifactsByCampaign } from '@/db/artifactRepo';
import type { StatBlock } from '@/domain';
import { createModule, newId, statBlockSchema } from '@/domain';
import { createModule as saveModule } from '@/db/moduleRepo';
import { BattleSurface } from '@/features/play/battle/BattleSurface';
import { battleGridStyle } from '@/domain/battle/gridSnap';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

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
      monsters: [{ name: 'Troll', count: 1, notes: '', source: { type: 'npc-ref', artifactId: npc.id } }],
      terrain: '',
      tactics: 'Regenerates — a GM tactic note.',
      treasure: '',
      mapImageId: null,
      layout: null,
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

  it('removes veiled and hidden tokens from the DOM entirely', async () => {
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
    // The veiled token (Troll) is removed from the DOM.
    const labels = screen.queryAllByTestId('battle-token').map((el) => el.getAttribute('data-token-label'));
    expect(labels).not.toContain('Troll');
    // Hidden (visible: false) tokens vanish the same way. The save fires
    // liveQuery updates — wrap it in act (component is mounted).
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
    await user.type(screen.getByLabelText('HP delta'), '10');
    await user.click(screen.getByTestId('damage'));
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
    await user.type(screen.getByLabelText('HP delta'), '5');
    await user.click(screen.getByTestId('damage'));
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
    // The TROLL leaves the DOM; the PC tokens remain.
    await waitFor(() => {
      const labels = screen.queryAllByTestId('battle-token').map((el) => el.getAttribute('data-token-label'));
      expect(labels).not.toContain('Troll');
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
});
