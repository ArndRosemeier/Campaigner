import { describe, expect, it } from 'vitest';

import type { RuleChunk } from '@/domain';
import { newId } from '@/domain';
import {
  FILL_GRADE_DRAW_WEIGHTS,
  drawFillGrade,
} from '@/domain/artifact';
import {
  PF2E_BUDGET_ADVISORY,
  ROOM_BUDGET_UNDER_MARGIN,
  checkRoomBudget,
  expectedRoomThreat,
  fillGradeStockingFor,
  parseBudgetLevel,
  reconcileRoomAssignments,
  resolveBriefMonsterLevels,
  roomBudgetBandUpper,
  roomBudgetGuidanceFor,
  roomBudgetMode,
  roomBudgetReferenceCreatureLevel,
} from '@/llm/roomBudget';

/**
 * The per-room budget loop (docs/11 D12; amended by the fill-grade arc):
 * every layout room carries a targetLevel; assigned creature levels are
 * summed against the documented dnd5e band. SINGLE arenas keep the original
 * asymmetry — too easy ships silently, too hard lowers the target and joins
 * the brief's EXISTING repair turn. COMPLEX rooms invert it: 'empty' is a
 * repairable verdict and 'under' ships a LOUD advisory against the
 * encounter's fill-grade expectation. pf2e ships no numbers (Paizo
 * licensing) — the advisory is the replacement.
 */

/** Deterministic Math.random-compatible source (distribution tests). */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('drawFillGrade (docs/11 D12 amendment — the documented draw distribution)', () => {
  it('draws integers across the documented 30–100 range, never outside it', () => {
    const random = mulberry32(20260918);
    const draws = Array.from({ length: 4000 }, () => drawFillGrade(random));
    for (const draw of draws) {
      expect(Number.isInteger(draw)).toBe(true);
      expect(draw).toBeGreaterThanOrEqual(30);
      expect(draw).toBeLessThanOrEqual(100);
    }
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(30);
    expect(Math.max(...draws)).toBeLessThanOrEqual(100);
  });

  it('carries ~70% of its mass in the 55–90 center with the documented tails', () => {
    const random = mulberry32(20260918);
    const draws = Array.from({ length: 4000 }, () => drawFillGrade(random));
    const inBucket = (min: number, max: number): number =>
      draws.filter((draw) => draw >= min && draw <= max).length / draws.length;
    // The weights sum to 1 (breather 0.1, light 0.1, center 0.7, spike 0.1);
    // the seeded sample lands well inside these windows.
    expect(inBucket(55, 90)).toBeGreaterThan(0.66);
    expect(inBucket(55, 90)).toBeLessThan(0.74);
    expect(inBucket(30, 45)).toBeGreaterThan(0.07);
    expect(inBucket(30, 45)).toBeLessThan(0.13);
    expect(inBucket(45, 55)).toBeGreaterThan(0.07);
    expect(inBucket(45, 55)).toBeLessThan(0.13);
    expect(inBucket(90, 100)).toBeGreaterThan(0.07);
    expect(inBucket(90, 100)).toBeLessThan(0.13);
  });

  it('uses the random source for both the bucket roll and the in-bucket draw', () => {
    // A source pinned to the center bucket's roll window and a mid-span
    // value draws exactly the documented center values.
    const rolls = [0.5, 0.5];
    let cursor = 0;
    const draw = drawFillGrade(() => {
      const value = rolls[cursor % rolls.length] ?? 0;
      cursor += 1;
      return value;
    });
    expect(draw).toBeGreaterThanOrEqual(FILL_GRADE_DRAW_WEIGHTS[2].min);
    expect(draw).toBeLessThanOrEqual(FILL_GRADE_DRAW_WEIGHTS[2].max);
  });

  it('rejects an out-of-range random source loudly (never a silent draw)', () => {
    expect(() => drawFillGrade(() => 1.5)).toThrow(/expected a value in/);
    expect(() => drawFillGrade(() => -0.1)).toThrow(/expected a value in/);
  });
});

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

describe('expectedRoomThreat (the fill-grade expectation, docs/11 D12 amendment)', () => {
  it('scales the documented band by the fill grade share', () => {
    // T=5 band = 7 creature-levels; 70% of it ≈ 4.9.
    expect(expectedRoomThreat(70, 5, 'dnd5e')).toEqual({
      expectedLevels: 4.9,
      approximateCreatureCount: 2,
    });
    // A full-share room sits exactly at the band.
    expect(expectedRoomThreat(100, 5, 'dnd5e')?.expectedLevels).toBe(7);
    // A sanctioned-empty room (fill grade 0) expects nothing.
    expect(expectedRoomThreat(0, 5, 'dnd5e')).toEqual({
      expectedLevels: 0,
      approximateCreatureCount: 0,
    });
  });

  it('derives the approximate mob count from the reference creature level', () => {
    expect(roomBudgetReferenceCreatureLevel(1)).toBe(1);
    expect(roomBudgetReferenceCreatureLevel(5)).toBe(3);
    expect(roomBudgetReferenceCreatureLevel(10)).toBe(5);
    // A full band at T=5 (7 levels / 3 reference) rounds to ~2 creatures.
    expect(expectedRoomThreat(100, 5, 'dnd5e')?.approximateCreatureCount).toBe(2);
    // Small positive expectations still read as at least one creature.
    expect(expectedRoomThreat(10, 1, 'dnd5e')?.approximateCreatureCount).toBe(1);
  });

  it('ships no numbers for pf2e (Paizo licensing) and rejects a malformed grade', () => {
    expect(expectedRoomThreat(70, 5, 'pathfinder2e')).toBeNull();
    expect(() => expectedRoomThreat(101, 5, 'dnd5e')).toThrow(/fillGrade must be an integer/);
    expect(() => expectedRoomThreat(70.5, 5, 'dnd5e')).toThrow(/fillGrade must be an integer/);
  });
});

function room(overrides: Partial<Parameters<typeof checkRoomBudget>[0]> = {}) {
  return {
    roomIndex: 0,
    roomName: 'Sanctum',
    targetLevel: 5,
    creatures: [{ name: 'Troll', count: 1, level: '5' }],
    complex: false,
    system: 'dnd5e' as const,
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

  it('verdicts a zero-creature COMPLEX room with a fill grade as repairable-empty', () => {
    const verdict = checkRoomBudget(
      room({
        complex: true,
        fillGrade: 70,
        creatures: [],
      }),
    );
    expect(verdict.status).toBe('empty');
    expect(verdict.expectedLevels).toBeCloseTo(4.9);
    expect(verdict.approximateCreatureCount).toBe(2);
    // The repair-turn issue names the room and the expected-vs-shipped gap.
    expect(verdict.issue).toContain('rooms[0] ("Sanctum")');
    expect(verdict.issue).toContain('shipped 0, expected ~4.9 creature-levels (≈2 creatures)');
    expect(verdict.issue).toContain('Assign at least one creature');
    // And the finalize advisory is loud too.
    expect(verdict.advisory).toContain('ships empty');
    expect(verdict.advisory).toContain('expected ~4.9');
  });

  it('verdicts a well-under COMPLEX room with a loud advisory (not a repair issue)', () => {
    const verdict = checkRoomBudget(
      room({
        complex: true,
        fillGrade: 70,
        creatures: [{ name: 'Rat', count: 2, level: '1/8' }],
      }),
    );
    expect(verdict.status).toBe('under');
    expect(verdict.issue).toBeNull();
    expect(verdict.advisory).toContain('ships under its expected challenge');
    expect(verdict.advisory).toContain('sum to 0.3 creature-levels, expected ~4.9');
    expect(verdict.advisory).toContain('fill grade 70%');
  });

  it('keeps a complex room within its expected share ok (under the margin stays silent)', () => {
    const verdict = checkRoomBudget(
      room({
        complex: true,
        fillGrade: 70,
        creatures: [{ name: 'Ogre', count: 1, level: '4' }],
      }),
    );
    expect(verdict.status).toBe('ok');
    expect(verdict.advisory).toBeNull();
    expect(verdict.expectedLevels).toBeCloseTo(4.9);
  });

  it('honors fill grade 0 as a sanctioned empty room and over bands first', () => {
    const sanctioned = checkRoomBudget(room({ complex: true, fillGrade: 0, creatures: [] }));
    expect(sanctioned.status).toBe('ok');
    // The upper band still wins: an over-full complex room is 'over', not 'under'.
    const over = checkRoomBudget(
      room({ complex: true, fillGrade: 70, creatures: [{ name: 'Dragon', count: 1, level: '10' }] }),
    );
    expect(over.status).toBe('over');
  });

  it('keeps the single-arena asymmetry byte-identical (no lower verdicts)', () => {
    // The pinned "no lower bound" call: a quiet SINGLE room ships silently —
    // even with a fill grade on the row and even with no creatures at all.
    expect(
      checkRoomBudget(room({ creatures: [{ name: 'Rat', count: 1, level: '1/8' }] })).status,
    ).toBe('ok');
    expect(checkRoomBudget(room({ creatures: [] })).status).toBe('ok');
    expect(
      checkRoomBudget(room({ complex: false, fillGrade: 70, creatures: [] })).status,
    ).toBe('ok');
    // And no expectation is computed for a single arena at all.
    expect(
      checkRoomBudget(room({ complex: false, fillGrade: 70 })).expectedLevels,
    ).toBeNull();
  });

  it('computes no expectation without a fill grade (legacy complex) or for pf2e', () => {
    expect(checkRoomBudget(room({ complex: true, creatures: [] })).status).toBe('ok');
    expect(
      checkRoomBudget(room({ complex: true, system: 'pathfinder2e', creatures: [] })).status,
    ).toBe('ok');
    expect(
      checkRoomBudget(room({ complex: true, system: 'pathfinder2e', fillGrade: 70, creatures: [] }))
        .expectedLevels,
    ).toBeNull();
  });

  it('documents the under margin as a level of slack', () => {
    expect(ROOM_BUDGET_UNDER_MARGIN).toBe(1);
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

  it('inverts the asymmetry for complexes while keeping singles quiet-is-a-feature', () => {
    const guidance = roomBudgetGuidanceFor('dnd5e');
    // D12 amendment: complexes stock every room; the old "under is fine"
    // clause survives for SINGLE arenas only.
    expect(guidance).toContain('A DUNGEON COMPLEX requires a targetLevel on EVERY room');
    expect(guidance).toContain('a complex room with no creatures is a repairable defect');
    expect(guidance).toContain('For a SINGLE arena, under is fine (a quiet room is a feature)');
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

describe('fillGradeStockingFor (the brief prompt numbers)', () => {
  it('renders the fill-grade share as concrete levels and a creature count', () => {
    const line = fillGradeStockingFor(70, 5, 'dnd5e');
    expect(line).toContain("fill grade is 70%");
    expect(line).toContain('T + 2 creature-levels');
    expect(line).toContain('roughly 4.9 creature-levels (≈2 creatures)');
  });

  it('renders no numbers for pf2e or a digit-free level (never an invented number)', () => {
    expect(fillGradeStockingFor(70, 5, 'pathfinder2e')).toBeNull();
    expect(fillGradeStockingFor(70, undefined, 'dnd5e')).toBeNull();
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
        // The production roster index is keyed LOWERCASE (rosterNameIndex) —
        // the lookup normalizes the cited name the same way the citation
        // checks do.
        rosterChunkByName: { orc: chunkA.id },
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

describe('reconcileRoomAssignments packing (fill-grade arc — nearest-band fit)', () => {
  const roomA = { id: 'room-a', monsterIndexes: [] };
  const roomB = { id: 'room-b', monsterIndexes: [] };

  it('packs unclaimed entries where they bring rooms nearest their expected bands', () => {
    // Expected 7 vs 3: the troll (5) ties |7-5| == |3-5| and lands in room A
    // (lowest index); the orc (2) completes A exactly; the goblin (1) fills
    // B (A is already at its expectation — rooms under their band are
    // preferred, a fitted room is never topped up while another waits).
    const result = reconcileRoomAssignments(
      [roomA, roomB],
      [],
      [{ name: 'Troll', count: 1 }, { name: 'Goblin', count: 1 }, { name: 'Orc', count: 1 }],
      { expectedLevels: [7, 3], levels: ['5', '1', '2'] },
    );
    expect(result).toEqual([
      { roomId: 'room-a', monsterIndexes: [0, 2] },
      { roomId: 'room-b', monsterIndexes: [1] },
    ]);
  });

  it('counts preserved (name-matched) entries toward the room\'s shipped threat', () => {
    // The preserved Troll already fills room A to its 5; the new Ogre (5)
    // fits room B (|5-5| = 0) instead of overflowing A.
    const result = reconcileRoomAssignments(
      [{ id: 'room-a', monsterIndexes: [0] }, roomB],
      [{ name: 'Troll' }],
      [{ name: 'Troll' }, { name: 'Ogre' }],
      { expectedLevels: [5, 5], levels: ['5', '5'] },
    );
    expect(result).toEqual([
      { roomId: 'room-a', monsterIndexes: [0] },
      { roomId: 'room-b', monsterIndexes: [1] },
    ]);
  });

  it('multiplies the entry count into its packing threat', () => {
    // Four goblins (4 × 1) fit room B's 4-band better than room A's 8.
    const result = reconcileRoomAssignments(
      [roomA, roomB],
      [],
      [{ name: 'Goblin', count: 4 }],
      { expectedLevels: [8, 4], levels: ['1'] },
    );
    expect(result[0]?.monsterIndexes).toEqual([]);
    expect(result[1]?.monsterIndexes).toEqual([0]);
  });

  it('leaves a room empty when nothing fits it — a legit loud-empty outcome', () => {
    // A one-fight roster packs into its best-fit room; the other rooms stay
    // empty by packing (the budget loop reports them 'empty', loudly).
    const result = reconcileRoomAssignments(
      [roomA, { id: 'room-b', monsterIndexes: [] }, { id: 'room-c', monsterIndexes: [] }],
      [],
      [{ name: 'Troll', count: 1 }],
      { expectedLevels: [5, 5, 5], levels: ['5'] },
    );
    expect(result[0]?.monsterIndexes).toEqual([0]);
    expect(result[1]?.monsterIndexes).toEqual([]);
    expect(result[2]?.monsterIndexes).toEqual([]);
  });

  it('falls back to round-robin when expectations are absent or incomplete', () => {
    // No expectations: the documented pre-arc round-robin, byte-identical.
    const fallback = reconcileRoomAssignments(
      [roomA, roomB],
      [],
      [{ name: 'Goblin', count: 1 }, { name: 'Orc', count: 1 }, { name: 'Ogre', count: 1 }],
      { levels: ['1', '2', '5'] },
    );
    expect(fallback).toEqual([
      { roomId: 'room-a', monsterIndexes: [0, 2] },
      { roomId: 'room-b', monsterIndexes: [1] },
    ]);
    // An INCOMPLETE expectation list (a room without a derivable target)
    // also falls back — never a partial fit against partial numbers.
    const incomplete = reconcileRoomAssignments(
      [roomA, roomB],
      [],
      [{ name: 'Goblin', count: 1 }, { name: 'Orc', count: 1 }],
      { expectedLevels: [7, undefined], levels: ['1', '2'] },
    );
    expect(incomplete).toEqual([
      { roomId: 'room-a', monsterIndexes: [0] },
      { roomId: 'room-b', monsterIndexes: [1] },
    ]);
  });
});
