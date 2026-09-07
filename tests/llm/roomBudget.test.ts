import { describe, expect, it } from 'vitest';

import type { RuleChunk } from '@/domain';
import { newId } from '@/domain';
import {
  PF2E_BUDGET_ADVISORY,
  checkRoomBudget,
  parseBudgetLevel,
  reconcileRoomAssignments,
  resolveBriefMonsterLevels,
  roomBudgetBandUpper,
  roomBudgetGuidanceFor,
  roomBudgetMode,
} from '@/llm/roomBudget';

/**
 * The asymmetric per-room budget loop (docs/11 D12): every layout room
 * carries a targetLevel; assigned creature levels are summed against the
 * documented dnd5e band. TOO EASY ships silently (no lower bound); TOO HARD
 * lowers the room's target a step (floor 1) and joins the brief's EXISTING
 * repair turn; after the bounded retry the room ships with a LOUD advisory.
 * pf2e ships no numbers (Paizo licensing) — the advisory is the replacement.
 */

describe('parseBudgetLevel', () => {
  it('parses integers, negatives and fractional printed levels', () => {
    expect(parseBudgetLevel('3')).toEqual({ kind: 'level', value: 3 });
    expect(parseBudgetLevel(' 3 ')).toEqual({ kind: 'level', value: 3 });
    expect(parseBudgetLevel('1/2')).toEqual({ kind: 'level', value: 0.5 });
    expect(parseBudgetLevel('-1')).toEqual({ kind: 'level', value: -1 });
  });

  it('reads "—" (CR-less summons) as level 0', () => {
    expect(parseBudgetLevel('—')).toEqual({ kind: 'level', value: 0 });
  });

  it('reports missing and unreadable levels loudly', () => {
    expect(parseBudgetLevel(undefined)).toEqual({ kind: 'unknown' });
    expect(parseBudgetLevel('')).toEqual({ kind: 'unknown' });
    expect(parseBudgetLevel('boss')).toEqual({ kind: 'unparseable', raw: 'boss' });
  });
});

describe('roomBudgetBandUpper (the documented dnd5e approximation)', () => {
  it('gives the target two levels of headroom, floored at 1', () => {
    expect(roomBudgetBandUpper(1)).toBe(3);
    expect(roomBudgetBandUpper(5)).toBe(7);
    expect(roomBudgetBandUpper(0)).toBe(3);
  });
});

function room(overrides: Partial<Parameters<typeof checkRoomBudget>[0]> = {}) {
  return {
    roomIndex: 0,
    roomName: 'Sanctum',
    targetLevel: 5,
    creatures: [{ name: 'Troll', count: 1, level: '5' }],
    ...overrides,
  };
}

describe('checkRoomBudget', () => {
  it('passes a room at or under its band', () => {
    expect(checkRoomBudget(room())).toMatchObject({ status: 'ok', sumLevels: 5, bandUpper: 7 });
    expect(checkRoomBudget(room({ creatures: [{ name: 'Orc', count: 12, level: '1/2' }] }))).toMatchObject({
      status: 'ok',
      sumLevels: 6,
    });
    // No lower bound: a near-empty room ships silently (owner: fine).
    expect(checkRoomBudget(room({ creatures: [{ name: 'Rat', count: 1, level: '1/8' }] }))).toMatchObject({
      status: 'ok',
      sumLevels: 0.125,
    });
    expect(checkRoomBudget(room({ creatures: [{ name: 'Summon', count: 2, level: '—' }] }))).toMatchObject({
      status: 'ok',
      sumLevels: 0,
    });
  });

  it('flags over-budget rooms with the repair issue and the step-down', () => {
    const verdict = checkRoomBudget(
      room({ creatures: [{ name: 'Dragon', count: 1, level: '10' }, { name: 'Orc', count: 2, level: '2' }] }),
    );
    expect(verdict.status).toBe('over');
    expect(verdict.sumLevels).toBe(14);
    expect(verdict.bandUpper).toBe(7);
    expect(verdict.loweredTargetLevel).toBe(4);
    expect(verdict.issue).toContain('sum to 14 creature-levels');
    expect(verdict.issue).toContain('"targetLevel": 4');
    expect(verdict.advisory).toContain('ships over its challenge budget');
  });

  it('floors the step-down at target level 1', () => {
    const verdict = checkRoomBudget(room({ targetLevel: 1, creatures: [{ name: 'Dragon', count: 1, level: '9' }] }));
    expect(verdict.loweredTargetLevel).toBe(1);
    expect(verdict.issue).toContain('"targetLevel": 1');
  });

  it('marks rooms with unresolvable creature levels loud-unverified', () => {
    const verdict = checkRoomBudget(
      room({ creatures: [{ name: 'Ghost', count: 1, level: undefined }, { name: 'Weird', count: 1, level: 'varies' }] }),
    );
    expect(verdict.status).toBe('unverified');
    expect(verdict.advisory).toContain('"Ghost" has no readable level');
    expect(verdict.advisory).toContain('"Weird" has an unreadable level "varies"');
  });

  it('marks rooms without a derivable target loud-unverified', () => {
    const verdict = checkRoomBudget(room({ targetLevel: undefined }));
    expect(verdict.status).toBe('unverified');
    expect(verdict.advisory).toContain('no target level is derivable');
  });
});

describe('roomBudgetGuidanceFor', () => {
  it('teaches the own-words dnd5e band (never DMG text)', () => {
    const guidance = roomBudgetGuidanceFor('dnd5e');
    expect(guidance).toContain('every room must ALONE challenge the party');
    expect(guidance).toContain('targetLevel');
    expect(guidance).toContain('documented approximation');
    expect(guidance).toContain('not licensable');
    expect(guidance).toContain('targetLevel + 2');
  });

  it('demands verbatim GM Core grounding for pf2e and ships no numbers', () => {
    const guidance = roomBudgetGuidanceFor('pathfinder2e');
    expect(guidance).toContain('VERBATIM');
    expect(guidance).toContain('do not' in {} ? '' : 'without inventing XP amounts');
    expect(guidance).not.toContain('+ 2');
    expect(roomBudgetMode('pathfinder2e')).toBe('verbatim');
    expect(PF2E_BUDGET_ADVISORY).toContain('not deterministically budget-checked');
  });
});

describe('resolveBriefMonsterLevels', () => {
  const chunk = (id: string, level: string): RuleChunk => ({
    id,
    bookId: newId(),
    pageStart: 1,
    pageEnd: 1,
    chunkType: 'statblock',
    headingPath: ['Creature'],
    text: '',
    statBlock: {
      system: 'dnd5e', level, size: 'Medium', creatureType: 'humanoid', ac: 12, acNote: '', hp: 7,
      hpFormula: '', speed: '', abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      saves: '', skills: '', senses: '', languages: '', traits: [], actions: [], reactions: [],
      legendary: [], extras: {},
    },
    contentHash: '',
    createdAt: 1,
    updatedAt: 1,
  });

  it('resolves inline → roster name → excerpt index (the M-B precedence)', () => {
    const chunkA = chunk(newId(), '2');
    const levels = resolveBriefMonsterLevels(
      [
        { statBlock: { level: '7' } as never },
        { sourceName: 'Orc' },
        { sourceChunkIndex: 0 },
        {},
      ],
      {
        chunkById: new Map([[chunkA.id, chunkA]]),
        rosterChunkByName: { Orc: chunkA.id },
        statblockChunkIds: [chunkA.id],
      },
    );
    expect(levels).toEqual(['7', '2', '2', undefined]);
  });
});

describe('reconcileRoomAssignments (in-place fill partition, docs/11 D12)', () => {
  const roomA = { id: 'room-a', monsterIndexes: [0] };
  const roomB = { id: 'room-b', monsterIndexes: [1] };

  it('preserves assignments by name-match, remapped to the new indexes', () => {
    const oldRoster = [{ name: 'Troll' }, { name: 'Orc' }];
    const newRoster = [{ name: 'Orc' }, { name: 'Troll' }];
    const result = reconcileRoomAssignments([roomA, roomB], oldRoster, newRoster);
    expect(result).toEqual([
      { roomId: 'room-a', monsterIndexes: [1] },
      { roomId: 'room-b', monsterIndexes: [0] },
    ]);
  });

  it('appends new entries round-robin and drops the gone', () => {
    const oldRoster = [{ name: 'Troll' }, { name: 'Orc' }];
    // Troll survives (room A); Orc is gone; Ogre and Ghoul are new.
    const newRoster = [{ name: 'Troll' }, { name: 'Ogre' }, { name: 'Ghoul' }];
    const result = reconcileRoomAssignments([roomA, roomB], oldRoster, newRoster);
    expect(result[0]?.monsterIndexes).toEqual([0, 1]); // Troll kept, Ogre appended
    expect(result[1]?.monsterIndexes).toEqual([2]); // Ghoul appended
  });

  it('keeps the exactly-one-room invariant with duplicate names', () => {
    const oldRoster = [{ name: 'Goblin' }];
    const newRoster = [{ name: 'Goblin' }, { name: 'Goblin' }];
    const result = reconcileRoomAssignments([roomA, roomB], oldRoster, newRoster);
    // The first claim wins; the duplicate Goblin is placed round-robin.
    const assigned = result.flatMap((room) => room.monsterIndexes).sort((a, b) => a - b);
    expect(assigned).toEqual([0, 1]);
  });

  it('puts the whole roster in the one room of a single-site layout', () => {
    const result = reconcileRoomAssignments(
      [{ id: 'solo', monsterIndexes: [1] }],
      [{ name: 'Goblin' }, { name: 'Orc' }],
      [{ name: 'Orc' }, { name: 'Goblin' }, { name: 'Ogre' }],
    );
    expect(result[0]?.monsterIndexes).toEqual([0, 1, 2]);
  });
});
