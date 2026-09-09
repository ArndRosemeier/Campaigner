import { describe, expect, it } from 'vitest';

import {
  encounterDataSchema,
  encounterDataIsComplex,
  LEGACY_COMPLEX_BUDGET_NOTE,
  drawFillGrade,
  type EncounterArtifactData,
} from '@/domain';
import { encounterLayoutSchema, spawnFirstPath } from '@/domain/encounterMap/schema';
import { packRooms } from '@/domain/encounterMap/layout';
import { newId } from '@/domain';

/**
 * Site shape (docs/11 D11): `'single'` is one arena (one room, no corridors,
 * no veils at seed); `'complex'` is a dungeon (multi-room, sequential play
 * along the stored `path`). The derived shape materializes for legacy rows
 * at every parse (`normalizeEncounterShapeData` — ONE derivation shared with
 * the v17 backfill and backup validation), the hard invariants refine on the
 * artifact data, and the packer emits the brief-order path with the spawn
 * room first.
 */

const ROOM_IDS: [string, string, string] = [newId(), newId(), newId()];

function layoutWithRooms(count: number): NonNullable<EncounterArtifactData['layout']> {
  return encounterLayoutSchema.parse({
    gridW: 24,
    gridH: 18,
    theme: 'test theme',
    corridors: [],
    rooms: Array.from({ length: count }, (_, index) => ({
      id: ROOM_IDS[index],
      name: `Room ${String(index + 1)}`,
      rects: [{ x: 1 + index * 8, y: 1, w: 6, h: 6 }],
      mobsRect: { x: 2 + index * 8, y: 2, w: 4, h: 4 },
      description: '',
      monsterIndexes: [],
      spawn: index === 0,
    })),
  });
}

function baseData(overrides: Partial<EncounterArtifactData> = {}): Record<string, unknown> {
  return {
    difficulty: '',
    levelHint: '3',
    monsters: [],
    terrain: '',
    tactics: '',
    treasure: '',
    mapImageId: null,
    layout: null,
    preset: 'standard',
    locationKind: 'other',
    ...overrides,
  };
}

describe('siteShape derivation (docs/11 D11)', () => {
  it('derives complex + spawn-first path for legacy multi-room layouts', () => {
    const layout = layoutWithRooms(3);
    const parsed = encounterDataSchema.parse(baseData({ layout }));
    expect(parsed.siteShape).toBe('complex');
    expect(parsed.layout?.path).toEqual(ROOM_IDS); // room 1 is the spawn room
  });

  it('rotates a non-first spawn room to the front of the derived path', () => {
    const layout = layoutWithRooms(3);
    const rotated = {
      ...layout,
      rooms: layout.rooms.map((room, index) => ({ ...room, spawn: index === 2 })),
    };
    const ids = rotated.rooms.map((room) => room.id);
    const parsed = encounterDataSchema.parse(baseData({ layout: rotated }));
    expect(parsed.siteShape).toBe('complex');
    expect(parsed.layout?.path).toEqual([...ids.slice(2), ...ids.slice(0, 2)]);
  });

  it('keeps an explicit path over the derived one and rejects a non-permutation', () => {
    const layout = layoutWithRooms(2);
    const ids = layout.rooms.map((room) => room.id);
    const reversed = { ...layout, path: [...ids].reverse() };
    const parsed = encounterDataSchema.parse(baseData({ layout: reversed }));
    expect(parsed.layout?.path).toEqual([...ids].reverse());

    expect(() =>
      encounterLayoutSchema.parse({ ...layout, path: [ids[0] ?? newId(), ids[0] ?? newId()] }),
    ).toThrow(/permutation/);
    expect(() =>
      encounterLayoutSchema.parse({ ...layout, path: [ids[0] ?? newId(), newId()] }),
    ).toThrow(/permutation/);
    expect(() =>
      encounterLayoutSchema.parse({ ...layout, path: [ids[0] ?? newId()] }),
    ).toThrow(/permutation/);
  });

  it('derives single for legacy one-room layouts and clears stray corridors', () => {
    const layout = {
      ...layoutWithRooms(1),
      corridors: [
        { a: ROOM_IDS[0], b: newId(), rects: [{ x: 9, y: 3, w: 1, h: 1 }] },
      ],
    };
    const parsed = encounterDataSchema.parse(baseData({ layout }));
    expect(parsed.siteShape).toBe('single');
    expect(parsed.layout?.corridors).toEqual([]);
  });

  it('derives single for layoutless (uploaded-map) rows', () => {
    const parsed = encounterDataSchema.parse(baseData());
    expect(parsed.siteShape).toBe('single');
    expect(parsed.layout).toBeNull();
  });

  it('never re-derives when siteShape is persisted (a stored path stays put)', () => {
    const layout = layoutWithRooms(3);
    const ids = layout.rooms.map((room) => room.id);
    // Derivation would rotate the spawn room (room 1) to the front; the row
    // declares complex AND carries its own path, so both stay untouched.
    const parsed = encounterDataSchema.parse(
      baseData({ layout: { ...layout, path: ids }, siteShape: 'complex' }),
    );
    expect(parsed.siteShape).toBe('complex');
    expect(parsed.layout?.path).toEqual(ids);
  });

  it('defaults budgetAdvisory to empty', () => {
    const parsed = encounterDataSchema.parse(baseData());
    expect(parsed.budgetAdvisory).toBe('');
  });
});

describe('encounterDataIsComplex (docs/11 D12 amendment — shape-gated restock)', () => {
  it('reads the parse-normalized siteShape, never a second room-count heuristic', () => {
    const complex = encounterDataSchema.parse(baseData({ siteShape: 'complex', layout: layoutWithRooms(2) }));
    expect(encounterDataIsComplex(complex)).toBe(true);
    const single = encounterDataSchema.parse(baseData({ siteShape: 'single', layout: layoutWithRooms(1) }));
    expect(encounterDataIsComplex(single)).toBe(false);
  });

  it('sees a legacy row\'s derived shape (the field normalizes at every parse)', () => {
    // No persisted siteShape: the multi-room layout derives 'complex' at
    // parse — exactly what the Cartographer's stocking gate must react to.
    const legacy = baseData({ layout: layoutWithRooms(3) });
    delete legacy.siteShape;
    const parsed = encounterDataSchema.parse(legacy);
    expect(parsed.siteShape).toBe('complex');
    expect(encounterDataIsComplex(parsed)).toBe(true);
  });
});

describe('siteShape invariants (artifact superRefine, docs/11 D11)', () => {
  it('rejects single with a multi-room layout', () => {
    expect(() =>
      encounterDataSchema.parse(baseData({ siteShape: 'single', layout: layoutWithRooms(2) })),
    ).toThrow(/exactly one room/);
  });

  it('rejects single with corridors', () => {
    const layout = layoutWithRooms(1);
    expect(() =>
      encounterDataSchema.parse(
        baseData({
          siteShape: 'single',
          layout: { ...layout, corridors: [{ a: ROOM_IDS[0], b: newId(), rects: [{ x: 9, y: 3, w: 1, h: 1 }] }] },
        }),
      ),
    ).toThrow(/no corridors/);
  });

  it('rejects complex with a one-room layout', () => {
    expect(() =>
      encounterDataSchema.parse(baseData({ siteShape: 'complex', layout: layoutWithRooms(1) })),
    ).toThrow(/more than one room/);
  });
});

describe('packRooms path + targetLevel (docs/11 D12/D13)', () => {
  it('stores the brief room order as the path, entry room first, rooms rotated', () => {
    const a = newId();
    const b = newId();
    const c = newId();
    const layout = packRooms({
      theme: 'path order',
      aspect: '4:3',
      preset: 'standard',
      entryRoomId: b,
      rosterCounts: [],
      rooms: [
        { id: a, name: 'A', description: '', size: 'small', monsterIndexes: [], adjacentRoomIds: [b], key: '', keyTreasure: '' },
        { id: b, name: 'B', description: '', size: 'small', monsterIndexes: [], adjacentRoomIds: [c], key: '', keyTreasure: '' },
        { id: c, name: 'C', description: '', size: 'small', monsterIndexes: [], adjacentRoomIds: [b], key: '', keyTreasure: '' },
      ],
    });
    expect(layout.path).toEqual([b, c, a]);
    // The packed rooms array rotates (attempt 0 = no rotation here), the
    // path is stored explicitly so play order survives repacking.
    expect(layout.rooms.map((room) => room.id)).toContain(b);
    const spawn = layout.rooms.find((room) => room.spawn);
    expect(spawn?.id).toBe(b);
  });

  it('carries the brief room targetLevel onto the packed room', () => {
    const a = newId();
    const layout = packRooms({
      theme: 'targeted',
      aspect: '4:3',
      preset: 'standard',
      entryRoomId: a,
      rosterCounts: [],
      rooms: [
        { id: a, name: 'A', description: '', size: 'small', monsterIndexes: [], adjacentRoomIds: [], key: '', keyTreasure: '', targetLevel: 5 },
      ],
    });
    expect(layout.rooms[0]?.targetLevel).toBe(5);
  });
});

describe('spawnFirstPath', () => {
  it('moves the spawn id to the front, preserving relative order', () => {
    expect(spawnFirstPath(['a', 'b', 'c'], 'b')).toEqual(['b', 'c', 'a']);
  });

  it('keeps the order when the spawn id is first or absent', () => {
    expect(spawnFirstPath(['a', 'b'], 'a')).toEqual(['a', 'b']);
    expect(spawnFirstPath(['a', 'b'], undefined)).toEqual(['a', 'b']);
    expect(spawnFirstPath(['a', 'b'], null)).toEqual(['a', 'b']);
    expect(spawnFirstPath(['a', 'b'], 'zzz')).toEqual(['a', 'b']);
  });
});

describe('legacy complex budget note (docs/11 D12, amended by the fill-grade arc)', () => {
  it('is a non-empty owner-facing sentence naming the draw-once refill', () => {
    expect(LEGACY_COMPLEX_BUDGET_NOTE.length).toBeGreaterThan(20);
    expect(LEGACY_COMPLEX_BUDGET_NOTE).toContain('under-budget');
    expect(LEGACY_COMPLEX_BUDGET_NOTE).toContain('fill grade');
  });
});

describe('fillGrade field (docs/11 D12 amendment — additive optional, no Dexie bump)', () => {
  const baseData = {
    difficulty: 'hard',
    levelHint: '4',
    monsters: [],
    terrain: '',
    tactics: '',
    treasure: '',
    mapImageId: null,
    preset: 'standard' as const,
    locationKind: 'dungeon' as const,
    siteShape: 'complex' as const,
    budgetAdvisory: '',
    layout: null,
  };

  it('parses legacy rows with the field absent and validates the range on read', () => {
    const absent = encounterDataSchema.parse({ ...baseData });
    expect(absent.fillGrade).toBeUndefined();
    expect(encounterDataSchema.parse({ ...baseData, fillGrade: 70 }).fillGrade).toBe(70);
    expect(encounterDataSchema.parse({ ...baseData, fillGrade: 0 }).fillGrade).toBe(0);
    // Out-of-range or fractional values fail the boundary loudly.
    expect(() => encounterDataSchema.parse({ ...baseData, fillGrade: 101 })).toThrow();
    expect(() => encounterDataSchema.parse({ ...baseData, fillGrade: -1 })).toThrow();
    expect(() => encounterDataSchema.parse({ ...baseData, fillGrade: 70.5 })).toThrow();
  });

  it('draws integers inside the documented 30–100 range (draw-once source)', () => {
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let index = 0; index < 500; index += 1) {
      const draw = drawFillGrade(random);
      expect(Number.isInteger(draw)).toBe(true);
      expect(draw).toBeGreaterThanOrEqual(30);
      expect(draw).toBeLessThanOrEqual(100);
    }
  });
});
