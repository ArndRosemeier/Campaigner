import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { createArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { getBattleByModule, saveBattleBoard } from '@/db/battleRepo';
import { seedBattleFromEncounter } from '@/db/battleSeed';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { buildFighterStatsLookup } from '@/db/fighterStats';
import { findMobArtifactByChunk } from '@/db/mobArtifacts';
import { createRulebook, updateRulebook } from '@/db/rulebookRepo';
import { createModule as saveModule } from '@/db/moduleRepo';
import {
  createModule,
  monsterEntrySchema,
  newId,
  ruleChunkSchema,
  stampNewEntity,
  statBlockSchema,
  type Id,
  type MonsterEntry,
  type StatBlock,
} from '@/domain';
import { fallbackSpawnPoint } from '@/domain/battle/board';
import { sha256Hex } from '@/lib/hash';
import { toastError } from '@/lib/toast';
import {
  SpawnPicker,
  buildMobPickEntry,
  countLabelSlots,
  nextFreeSpawnPoint,
  parseLevelOrLast,
  spawnPickedEntry,
} from '@/features/play/battle/SpawnPicker';
import { clearDatabase } from '../db/helpers';
import { actDrained, flushAsyncUpdates } from '../helpers/flush';

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastErrorPersistent: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

/**
 * The mid-fight spawn picker (spawn-picker arc): three spawn groups (roster /
 * campaign NPCs / core mobs) behind one Spawn button, one search field, one
 * name/level sort — every pick spawning through the shared expansion path.
 */

function statBlock(level: string, hp: number): StatBlock {
  return statBlockSchema.parse({
    system: 'dnd5e',
    level,
    size: 'Medium',
    creatureType: 'humanoid',
    ac: 12,
    acNote: '',
    hp,
    hpFormula: '',
    speed: '30 ft.',
    abilities: { str: 10, dex: 14, con: 12, int: 10, wis: 10, cha: 10 },
    saves: '',
    skills: '',
    senses: '',
    languages: '',
    traits: [],
    actions: [],
    reactions: [],
    legendary: [],
    extras: {},
  });
}

let campaignId = '';
let moduleId = '';
let battleId = '';
let trollId = '';
let vexraId = '';
let wispId = '';
let goblinChunkId: Id = '';
let roster: MonsterEntry[] = [];

async function addChunk(bookId: Id, name: string, level: string, hp: number): Promise<Id> {
  const text = `${name}, a test creature of level ${level}.`;
  await putChunks([
    ruleChunkSchema.parse({
      ...stampNewEntity(),
      bookId,
      pageStart: 1,
      pageEnd: 1,
      chunkType: 'statblock',
      headingPath: [name],
      text,
      statBlock: statBlock(level, hp),
      contentHash: await sha256Hex(text),
    }),
  ]);
  const { db } = await import('@/db/db');
  const chunk = await db.chunks.where('bookId').equals(bookId).and((row) => row.headingPath[0] === name).first();
  if (chunk === undefined) throw new Error(`chunk ${name} missing`);
  return chunk.id;
}

async function addNpc(name: string, level: string | null, hp: number): Promise<string> {
  const npc = await createArtifact({
    campaignId,
    kind: 'npc',
    name,
    data: {
      appearance: '',
      personality: '',
      statBlock: level === null ? null : statBlock(level, hp),
    },
  });
  return npc.id;
}

beforeEach(async () => {
  await clearDatabase();
  vi.mocked(toastError).mockClear();
  // jsdom has no layout: virtual-core reads the scroll element's
  // offsetWidth/offsetHeight synchronously (both 0 in jsdom), so the mob
  // window would render empty. A fixed 800×600 keeps the seeded creatures
  // in the window (same stub as the bestiary roster tests).
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 800,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 600,
  });
  campaignId = (await createCampaign({ name: 'Spawn picker', system: 'dnd5e' })).id;

  const book = await createRulebook({ title: 'Core Bestiary', system: 'dnd5e', filename: 'core.pdf' });
  await updateRulebook(book.id, { status: 'ready', pageCount: 320 });
  goblinChunkId = await addChunk(book.id, 'Goblin Boss', '1', 21);
  await addChunk(book.id, 'Ancient Wyrm', '12', 200);
  await addChunk(book.id, 'Oddling', 'high', 10);

  trollId = await addNpc('Troll', '2', 84);
  vexraId = await addNpc('Vexra', '3', 30);
  wispId = await addNpc('Wisp', null, 0);

  roster = [
    monsterEntrySchema.parse({
      name: 'Troll',
      count: 1,
      notes: '',
      treasure: '',
      source: { type: 'npc-ref', artifactId: trollId },
    }),
  ];
  const encounter = await createArtifact({
    campaignId,
    kind: 'encounter',
    name: 'Bridge ambush',
    data: {
      difficulty: 'medium',
      levelHint: '3',
      monsters: roster,
      terrain: '',
      tactics: '',
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
      title: 'Spawn Module',
      concept: '',
      levelMin: 1,
      levelMax: 5,
      sizeDial: 'sketch',
    }),
  );
  moduleId = module.id;
  await seedBattleFromEncounter(campaignId, moduleId, encounter.id);
  const battle = await getBattleByModule(moduleId);
  if (battle === undefined) throw new Error('battle row missing');
  battleId = battle.id;
});

afterEach(async () => {
  await flushAsyncUpdates(20);
  cleanup();
  delete (HTMLElement.prototype as unknown as { offsetWidth?: unknown }).offsetWidth;
  delete (HTMLElement.prototype as unknown as { offsetHeight?: unknown }).offsetHeight;
});

async function currentBattle() {
  const battle = await actDrained(async () => {
    const row = await getBattleByModule(moduleId);
    if (row === undefined) throw new Error('battle row missing');
    return row;
  });
  return battle;
}

async function renderPicker(): Promise<void> {
  const artifacts = await listArtifactsByCampaign(campaignId);
  render(
    <SpawnPicker
      open
      onOpenChange={() => undefined}
      battleId={battleId}
      campaignId={campaignId}
      roster={roster}
      encounterName="Bridge ambush"
      artifacts={artifacts}
    />,
  );
  await waitFor(() => {
    expect(screen.getByTestId('spawn-picker-group-roster')).toBeInTheDocument();
  });
  await flushAsyncUpdates();
}

describe('spawn picker groups', () => {
  it('lists the roster, campaign NPCs, and core mobs', async () => {
    await renderPicker();
    expect(screen.getByTestId('spawn-picker-group-roster')).toHaveTextContent('Troll ×1');
    const npcs = screen.getByTestId('spawn-picker-group-npcs');
    expect(npcs).toHaveTextContent('Troll');
    expect(npcs).toHaveTextContent('Vexra');
    expect(npcs).toHaveTextContent('Wisp');
    const mobs = screen.getByTestId('spawn-picker-group-mobs');
    await waitFor(() => {
      expect(mobs).toHaveTextContent('Goblin Boss');
    });
    expect(mobs).toHaveTextContent('Ancient Wyrm');
    expect(mobs).toHaveTextContent('Oddling');
  });

  it('spawns a campaign NPC through the shared expansion (same artifact, fresh HP, visible)', async () => {
    await renderPicker();
    const user = userEvent.setup();
    await user.click(screen.getByTestId(`spawn-pick-npc-${vexraId}`));
    await flushAsyncUpdates();
    const battle = await currentBattle();
    const spawned = battle.board.tokens.find((token) => token.label === 'Vexra 1');
    if (spawned === undefined) throw new Error('spawned Vexra missing');
    expect(spawned.artifactId).toBe(vexraId);
    expect(spawned.currentHp).toBe(30);
    expect(spawned.visible).toBe(true);
    expect(vi.mocked(toastError)).not.toHaveBeenCalled();
  });

  it('spawns a core mob through the mob-artifact path (one artifact, one frozen seed row)', async () => {
    await renderPicker();
    const mobs = screen.getByTestId('spawn-picker-group-mobs');
    await waitFor(() => {
      expect(mobs).toHaveTextContent('Goblin Boss');
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId(`spawn-pick-mob-${goblinChunkId}`));
    await flushAsyncUpdates();
    const battle = await currentBattle();
    const spawned = battle.board.tokens.find((token) => token.label === 'Goblin Boss 1');
    if (spawned === undefined) throw new Error('spawned goblin missing');
    // The shared mob path: get-or-create the ONE mob artifact for the chunk,
    // then freeze ONE seed row under it (never a stat copy on the token).
    const mob = await findMobArtifactByChunk(campaignId, goblinChunkId);
    expect(mob?.id).toBeDefined();
    expect(spawned.artifactId).toBe(mob?.id);
    expect(spawned.currentHp).toBe(21);
    expect(spawned.visible).toBe(true);
    expect(battle.seedFighters.filter((seed) => seed.id === mob?.id)).toHaveLength(1);
    expect(vi.mocked(toastError)).not.toHaveBeenCalled();
  });

  it('statless picks toast loudly and spawn HP-less tokens without dummy numbers', async () => {
    await renderPicker();
    const user = userEvent.setup();
    await user.click(screen.getByTestId(`spawn-pick-npc-${wispId}`));
    await flushAsyncUpdates();
    expect(vi.mocked(toastError)).toHaveBeenCalledWith(
      expect.stringContaining('No combat stats for:'),
    );
    const battle = await currentBattle();
    const spawned = battle.board.tokens.find((token) => token.label === 'Wisp 1');
    if (spawned === undefined) throw new Error('spawned wisp missing');
    // No placeholder numbers: the token carries null HP and resolves no
    // fighter stats (initiative excludes it, like the seed-time convention).
    expect(spawned.currentHp).toBeNull();
    const stats = buildFighterStatsLookup(battle, await listArtifactsByCampaign(campaignId));
    expect(stats(wispId)).toBeUndefined();
  });
});

describe('spawn picker search and sort', () => {
  it('filters all three groups by one name query', async () => {
    await renderPicker();
    const mobs = screen.getByTestId('spawn-picker-group-mobs');
    await waitFor(() => {
      expect(mobs).toHaveTextContent('Goblin Boss');
    });
    const user = userEvent.setup();
    await user.type(screen.getByTestId('spawn-picker-search'), 'vex');
    await flushAsyncUpdates();
    expect(screen.getByTestId('spawn-picker-group-roster')).toHaveTextContent('No roster entries match.');
    const npcs = screen.getByTestId('spawn-picker-group-npcs');
    expect(npcs).toHaveTextContent('Vexra');
    expect(npcs).not.toHaveTextContent('Troll');
    expect(screen.getByTestId('spawn-picker-group-mobs')).toHaveTextContent('No creatures match.');
  });

  it('toggles name/level order with statless and unparsable levels last', async () => {
    await renderPicker();
    const mobs = screen.getByTestId('spawn-picker-group-mobs');
    await waitFor(() => {
      expect(mobs).toHaveTextContent('Oddling');
    });
    const npcItems = (): (string | null)[] =>
      within(screen.getByTestId('spawn-picker-group-npcs'))
        .getAllByRole('listitem')
        .map((item) => item.textContent);
    // Default: name order.
    expect(npcItems()[0]).toContain('Troll');
    expect(npcItems()[1]).toContain('Vexra');
    expect(npcItems()[2]).toContain('Wisp');
    const user = userEvent.setup();
    await user.click(screen.getByTestId('spawn-picker-sort'));
    await flushAsyncUpdates();
    expect(screen.getByTestId('spawn-picker-sort')).toHaveTextContent('Sort: Level');
    // Level order: Troll (2), Vexra (3), then the statless Wisp last.
    expect(npcItems()[0]).toContain('Lv 2');
    expect(npcItems()[1]).toContain('Lv 3');
    expect(npcItems()[2]).toContain('no stats');
    // Core mobs: Goblin Boss (1), Ancient Wyrm (12), then the unparsable
    // 'high' Oddling last.
    const mobRows = within(screen.getByTestId('spawn-picker-mob-list')).getAllByTestId(
      'spawn-picker-mob-row',
    );
    const mobName = (row: Element): string => {
      const head = row.textContent.split('Lv')[0];
      if (head === undefined) throw new Error('mob row has no name part');
      return head.replace('Spawn', '').trim();
    };
    expect(mobRows.map((row) => mobName(row))).toEqual(['Goblin Boss', 'Ancient Wyrm', 'Oddling']);
    expect(mobRows[0]?.textContent).toContain('Lv 1');
    expect(mobRows[1]?.textContent).toContain('Lv 12');
    expect(mobRows[2]?.textContent).toContain('Lv high');
  });
});

describe('spawn placement', () => {
  it('lands picks on a free spot, never stacked exactly atop an existing token', async () => {
    const battle = await currentBattle();
    // Park an existing token exactly on the next computed spawn base.
    const base = nextFreeSpawnPoint(battle.board.tokens, battle.board.stagingGround);
    const victim = battle.board.tokens[0];
    if (victim === undefined) throw new Error('no tokens on the board');
    await act(async () => {
      await saveBattleBoard(battle.id, {
        ...battle.board,
        tokens: battle.board.tokens.map((token) =>
          token.id === victim.id ? { ...token, x: base.x, y: base.y } : token,
        ),
      });
    });
    await flushAsyncUpdates();
    await renderPicker();
    const user = userEvent.setup();
    await user.click(screen.getByTestId(`spawn-pick-npc-${vexraId}`));
    await flushAsyncUpdates();
    const after = await currentBattle();
    const spawned = after.board.tokens.find((token) => token.label === 'Vexra 1');
    if (spawned === undefined) throw new Error('spawned Vexra missing');
    expect(spawned.x === base.x && spawned.y === base.y).toBe(false);
  });
});

describe('spawn picker helpers', () => {
  it('parseLevelOrLast orders levels numerically and sorts the unparsable last', () => {
    expect(parseLevelOrLast('3')).toBe(3);
    expect(parseLevelOrLast('-1')).toBe(-1);
    expect(parseLevelOrLast('1/2')).toBe(0.5);
    expect(parseLevelOrLast('—')).toBe(Number.POSITIVE_INFINITY);
    expect(parseLevelOrLast('high')).toBe(Number.POSITIVE_INFINITY);
    expect(parseLevelOrLast('')).toBe(Number.POSITIVE_INFINITY);
    expect(parseLevelOrLast(null)).toBe(Number.POSITIVE_INFINITY);
    expect(parseLevelOrLast(undefined)).toBe(Number.POSITIVE_INFINITY);
  });

  it('countLabelSlots continues the on-board count without matching longer names', () => {
    const tokens = [{ label: 'Goblin' }, { label: 'Goblin 2' }, { label: 'Goblin Chef' }];
    expect(countLabelSlots(tokens, 'Goblin')).toBe(2);
  });

  it('nextFreeSpawnPoint reuses the seeding base and nudges off occupied spots', () => {
    const base = fallbackSpawnPoint(0);
    expect(nextFreeSpawnPoint([], null)).toEqual(base);
    const nudged = nextFreeSpawnPoint([{ x: base.x, y: base.y }], null);
    expect(nudged.x === base.x && nudged.y === base.y).toBe(false);
  });

  it('spawnPickedEntry throws loudly for a missing battle (never a silent no-op)', async () => {
    const entry = monsterEntrySchema.parse({
      name: 'Ghost',
      count: 1,
      notes: '',
      treasure: '',
      source: { type: 'none' },
    });
    await expect(spawnPickedEntry(newId(), entry)).rejects.toThrow();
  });

  it('buildMobPickEntry stamps content identity at citation birth', async () => {
    const entry = await buildMobPickEntry(goblinChunkId, 'Goblin Boss');
    if (entry.source.type !== 'rulebook') throw new Error('expected a rulebook citation');
    expect(entry.source.chunkId).toBe(goblinChunkId);
    expect(entry.source.contentHash).toBe(await sha256Hex('Goblin Boss, a test creature of level 1.'));
    expect(entry.source.creatureName).toBe('Goblin Boss');
  });

  it('buildMobPickEntry stays uuid-only for a vanished chunk (statless toast stays loud)', async () => {
    const entry = await buildMobPickEntry(newId(), 'Ghost');
    if (entry.source.type !== 'rulebook') throw new Error('expected a rulebook citation');
    expect(entry.source.contentHash).toBeUndefined();
    expect(entry.source.creatureName).toBe('Ghost');
  });
});
