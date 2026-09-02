import 'fake-indexeddb/auto';

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * The table surface (09-MILESTONE-5 M5-D): the player-safe DOM contract,
 * drag commits, initiative reconcile (fog coverage), and HP ownership split
 * writes. The acceptance criteria of the milestone live here.
 */

const BOARD_W = 800;
const BOARD_H = 600;

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
  observe(): void {
    // Report the fixed test viewport on a microtask, inside act — the board
    // mounts only after the battle row's liveQuery resolves.
    queueMicrotask(() => {
      act(() => {
        this.callback(
          [{ contentRect: { width: BOARD_W, height: BOARD_H } } as ResizeObserverEntry],
          this,
        );
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
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  // jsdom reports zero rects; the surface needs a real board frame.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: BOARD_H,
    right: BOARD_W,
    width: BOARD_W,
    height: BOARD_H,
    toJSON: () => ({}),
  });
  campaignId = (await createCampaign({ name: 'Battle UI', system: 'dnd5e' })).id;
});

afterEach(() => {
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
      role: '',
      appearance: '',
      personality: '',
      motivation: '',
      secrets: 'The troll fears fire — a secret.',
      voiceNotes: '',
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

function renderSurface(moduleId: string): void {
  render(
    <MemoryRouter initialEntries={[`/c/${campaignId}/m/${moduleId}/battle`]}>
      <Routes>
        <Route path="/c/:campaignId/m/:moduleId/battle" element={<BattleSurface />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function currentBattle(moduleId: string) {
  const battle = await getBattleByModule(moduleId);
  if (battle === undefined) throw new Error('battle row missing');
  return battle;
}

describe('player-safe DOM contract', () => {
  it('renders only board pieces: names, HP, initiative — never stat text or secrets', async () => {
    const { moduleId } = await seedStandardBattle();
    renderSurface(moduleId);
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
    renderSurface(moduleId);
    await flushAsyncUpdates();
    expect(screen.queryByTestId('battle-token')).toBeNull();
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
    renderSurface(moduleId);
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
    renderSurface(moduleId);
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
  });
});

describe('HP ownership split writes', () => {
  it('damages the NPC onto the token instance and the PC onto the artifact', async () => {
    const { moduleId, npcId } = await seedStandardBattle();
    renderSurface(moduleId);
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
    await flushAsyncUpdates();
    let battle = await currentBattle(moduleId);
    expect(battle.board.tokens.find((token) => token.label === 'Troll')?.currentHp).toBe(74);
    const artifacts = await listArtifactsByCampaign(campaignId);
    const trollArtifact = artifacts.find((artifact) => artifact.id === npcId);
    expect(trollArtifact?.kind === 'npc' && 'currentHp' in trollArtifact.data).toBe(false);

    // PC damage: the pc artifact's currentHp changes (persists across battles).
    await selectByLabel('Serren');
    await user.type(screen.getByLabelText('HP delta'), '5');
    await user.click(screen.getByTestId('damage'));
    await flushAsyncUpdates();
    const refreshed = await listArtifactsByCampaign(campaignId);
    const serren = refreshed.find((artifact) => artifact.kind === 'pc' && artifact.name === 'Serren');
    if (serren?.kind !== 'pc') throw new Error('serren missing');
    expect(serren.data.currentHp).toBe(15);
    battle = await currentBattle(moduleId);
    expect(battle.board.tokens.find((token) => token.label === 'Serren')?.currentHp).toBeNull();
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
    renderSurface(moduleId);
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
    renderSurface(moduleId);
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
    renderSurface(moduleId);
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
    renderSurface(moduleId);
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
