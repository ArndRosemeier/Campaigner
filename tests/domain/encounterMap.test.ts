import { describe, expect, it, vi } from 'vitest';

import {
  EncounterLayoutError,
  mergeVeilCovers,
  packRooms,
  placeEntrance,
  placeMonsters,
  renderSchematic,
  schematicCellPx,
  stagingBlockRect,
  validateEncounterLayout,
  veilsFromRooms,
  veilsFromSpawnClusters,
  encounterLayoutSchema,
  battleVeilSchema,
  VEIL_MIN_CELLS,
  type EncounterLayout,
  type EncounterMapBrief,
  type LayoutRoom,
} from '@/domain';

const ROOM_A = '00000000-0000-4000-8000-0000000000a1';
const ROOM_B = '00000000-0000-4000-8000-0000000000b2';
const ROOM_C = '00000000-0000-4000-8000-0000000000c3';

/** The preset's fixed \u00d72 tier per aspect (mirrors GRID_BY_ASPECT_DUNGEON). */
const DUNGEON_GRIDS = {
  '4:3': { gridW: 48, gridH: 36 },
  '16:9': { gridW: 56, gridH: 32 },
  '1:1': { gridW: 40, gridH: 40 },
} as const;

function brief(): EncounterMapBrief {
  return {
    theme: 'Flooded dwarven crypt',
    aspect: '4:3',
    preset: 'standard',
    entryRoomId: ROOM_A,
    rosterCounts: [2, 1],
    rooms: [
      {
        id: ROOM_A,
        name: 'Entry Hall',
        description: 'Broken gate',
        size: 'small',
        monsterIndexes: [],
        adjacentRoomIds: [ROOM_B],
        key: '',
        keyTreasure: '',
      },
      {
        id: ROOM_B,
        name: 'Flooded Nave',
        description: 'Black water',
        size: 'large',
        monsterIndexes: [0],
        adjacentRoomIds: [ROOM_A, ROOM_C],
        key: '',
        keyTreasure: '',
      },
      {
        id: ROOM_C,
        name: 'Reliquary',
        description: 'Sealed vault',
        size: 'medium',
        monsterIndexes: [1],
        adjacentRoomIds: [ROOM_B],
        key: '',
        keyTreasure: '',
      },
    ],
  };
}

describe('encounter map layout engine', () => {
  it('keeps schematic cell px inside the 4096 map cap (96 for standard grids)', () => {
    // Base-tier grids keep the doc-11 default byte-identical.
    expect(schematicCellPx({ gridW: 24, gridH: 18 })).toBe(96);
    expect(schematicCellPx({ gridW: 56, gridH: 32 })).toBe(73);
    // The dungeon preset's fixed ×2 tier would overflow at 96 (48×36×96 =
    // 4608px > 4096) — scaled down to exactly the cap, never below 1.
    expect(schematicCellPx({ gridW: 48, gridH: 36 })).toBe(85);
    expect(schematicCellPx({ gridW: 56, gridH: 32 }) * 56).toBeLessThanOrEqual(4096);
    expect(schematicCellPx({ gridW: 48, gridH: 36 }) * 36).toBeLessThanOrEqual(4096);
    expect(schematicCellPx({ gridW: 6000, gridH: 2 })).toBe(1);
  });

  it('packs the same brief deterministically into a valid connected layout', () => {
    const first = packRooms(brief());
    const second = packRooms(brief());

    expect(second).toEqual(first);
    expect(first.gridW).toBe(24);
    expect(first.gridH).toBe(18);
    expect(first.rooms).toHaveLength(3);
    expect(first.corridors).toHaveLength(2);
    expect(validateEncounterLayout(first, brief().rosterCounts)).toEqual([]);
    expect(first.rooms.filter((room) => room.spawn).map((room) => room.id)).toEqual([ROOM_A]);
    expect(first.rooms.some((room) => room.rects.length > 1)).toBe(true);
  });

  it('fails loudly after the bounded ladder for disconnected or impossible briefs', () => {
    const disconnected = brief();
    disconnected.rooms = disconnected.rooms.map((room) => ({ ...room, adjacentRoomIds: [] }));
    expect(() => packRooms(disconnected)).toThrow(EncounterLayoutError);

    const impossible = brief();
    impossible.rosterCounts = [100, 1];
    expect(() => packRooms(impossible)).toThrow(/does not fit/);
  });

  it('carries each room key with its room through packing rotation and the staging rebuild', () => {
    // Variant 1 forces the retry ladder's rotation (attempt % count) — the
    // packed rooms array is REORDERED relative to the brief. A key must stay
    // on its own room (id-keyed), never drift with the array index.
    const withKeys = brief();
    withKeys.rooms = withKeys.rooms.map((room, index) => ({
      ...room,
      key: `Key for ${room.name}`,
      keyTreasure: index === 0 ? 'Loose coins behind the gate: 25 gp' : '',
    }));
    const rotated = packRooms(withKeys, 1);
    expect(rotated.rooms.map((room) => room.name)).not.toEqual(withKeys.rooms.map((room) => room.name));
    for (const room of rotated.rooms) {
      expect(room.key).toBe(`Key for ${room.name}`);
      expect(room.keyTreasure).toBe(room.id === ROOM_A ? 'Loose coins behind the gate: 25 gp' : '');
    }

  });

  it('reports structural violations instead of repairing geometry', () => {
    const layout = packRooms(brief());
    const broken: EncounterLayout = {
      ...layout,
      rooms: layout.rooms.map((room, index) =>
        index === 1 ? { ...room, rects: layout.rooms[0]?.rects ?? room.rects } : room,
      ),
      corridors: layout.corridors.map((corridor, index) =>
        index === 0 ? { ...corridor, rects: [{ x: 0, y: 0, w: 2, h: 2 }] } : corridor,
      ),
    };
    const issues = validateEncounterLayout(broken, brief().rosterCounts).join(' | ');
    expect(issues).toContain('overlaps another room');
    expect(issues).toContain('corridors must be one cell wide');
  });

  it('places every roster instance in its room and derives one exact fog veil per room', () => {
    const layout = packRooms(brief());
    const placements = placeMonsters(layout, [{ count: 2 }, { count: 1 }]);
    expect(placements).toHaveLength(3);
    expect(new Set(placements.map((placement) => `${placement.x},${placement.y}`)).size).toBe(3);
    expect(placements.every((placement) => placement.x > 0 && placement.x < 1)).toBe(true);
    expect(placements.every((placement) => placement.y > 0 && placement.y < 1)).toBe(true);

    const veils = veilsFromRooms(layout);
    expect(veils).toHaveLength(layout.rooms.length);
    for (const room of layout.rooms) {
      const veil = veils.find((candidate) => candidate.id === room.id);
      expect(veil).toMatchObject({
        kind: 'fog',
        widthCells: room.mobsRect.w,
        heightCells: room.mobsRect.h,
      });
      expect(veil?.x).toBe((room.mobsRect.x + room.mobsRect.w / 2) / layout.gridW);
      expect(veil?.y).toBe((room.mobsRect.y + room.mobsRect.h / 2) / layout.gridH);
    }
  });

  describe('veilsFromSpawnClusters (one fog veil per monster spawn group)', () => {
    /** A room's mobsRect cells in the row-major order placeMonsters deals from. */
    function mobsCells(room: LayoutRoom): { x: number; y: number }[] {
      const cells: { x: number; y: number }[] = [];
      for (let y = room.mobsRect.y; y < room.mobsRect.y + room.mobsRect.h; y += 1) {
        for (let x = room.mobsRect.x; x < room.mobsRect.x + room.mobsRect.w; x += 1) {
          cells.push({ x, y });
        }
      }
      return cells;
    }

    /** Grid cells covered by a seeded veil rect. */
    function veilCells(veil: { x: number; y: number; widthCells: number; heightCells: number }, layout: EncounterLayout): Set<string> {
      const rect = {
        x: Math.round(veil.x * layout.gridW - veil.widthCells / 2),
        y: Math.round(veil.y * layout.gridH - veil.heightCells / 2),
        w: veil.widthCells,
        h: veil.heightCells,
      };
      const covered = new Set<string>();
      for (let y = rect.y; y < rect.y + rect.h; y += 1) {
        for (let x = rect.x; x < rect.x + rect.w; x += 1) covered.add(`${String(x)},${String(y)}`);
      }
      return covered;
    }

    it('seeds one veil per group in owner order, rooms without groups seed none', () => {
      const layout = packRooms(brief());
      const counts = brief().rosterCounts;
      const veils = veilsFromSpawnClusters(layout, counts);
      // Entry Hall has no monster groups → no veil; Flooded Nave [0] and
      // Reliquary [1] seed one group veil each, first group keeping room.id.
      expect(veils).toHaveLength(2);
      for (const room of layout.rooms) {
        const roomVeils = veils.filter((veil) => veil.id === room.id || veil.roomId === room.id);
        if (room.monsterIndexes.length === 0) {
          expect(roomVeils).toHaveLength(0);
        } else {
          expect(roomVeils).toHaveLength(room.monsterIndexes.length);
          expect(roomVeils[0]?.id).toBe(room.id);
        }
      }
      for (const veil of veils) {
        expect(battleVeilSchema.parse(veil)).toEqual(veil);
        expect(veil.kind).toBe('fog');
        expect(Number.isInteger(veil.widthCells) && veil.widthCells >= VEIL_MIN_CELLS).toBe(true);
        expect(Number.isInteger(veil.heightCells) && veil.heightCells >= VEIL_MIN_CELLS).toBe(true);
      }
    });

    it('merges each multi-group room with overlapping covers into ONE veil over the union of its spawn cells', () => {
      const multiA = '00000000-0000-4000-8000-0000000000a1';
      const multiB = '00000000-0000-4000-8000-0000000000b2';
      const counts = [1, 2, 3];
      const layout = packRooms({
        theme: 'Divided crypt',
        aspect: '4:3',
        entryRoomId: multiA,
        rosterCounts: counts,
        rooms: [
          { id: multiA, name: 'Vestry', description: '', size: 'medium', monsterIndexes: [0], adjacentRoomIds: [multiB], key: '', keyTreasure: '' },
          { id: multiB, name: 'Choir', description: '', size: 'large', monsterIndexes: [1, 2], adjacentRoomIds: [multiA], key: '', keyTreasure: '' },
        ],
      });
      const veils = veilsFromSpawnClusters(layout, counts);
      // One group in the Vestry + two ADJACENT groups in the Choir: the
      // Choir's contiguous runs own adjacent cells, so their +1-margin
      // covers always share ground and merge — one veil per room, not three.
      expect(veils).toHaveLength(2);
      const choir = layout.rooms.find((room) => room.id === multiB);
      if (choir === undefined) throw new Error('choir missing');
      const choirVeils = veils.filter((veil) => veil.id === multiB || veil.roomId === multiB);
      expect(choirVeils).toHaveLength(1);
      // Rail identity: the merged veil keeps the first-emitted identity —
      // the room id — so "Reveal next room" still resolves the room, and
      // roomId carries it for the reveal-all mapping.
      const merged = choirVeils[0];
      if (merged === undefined) throw new Error('merged choir veil missing');
      expect(merged.id).toBe(multiB);
      expect(merged.roomId).toBe(multiB);
      expect(merged.kind).toBe('fog');
      expect(new Set(veils.map((veil) => veil.id)).size).toBe(veils.length);
      // Probe-mapped: every placement cell of BOTH groups lies inside the
      // single merged veil (same row-major deal order as placeMonsters,
      // owner-ordered by monsterIndexes).
      const placements = placeMonsters(layout, counts.map((count) => ({ count })));
      const choirCells: { x: number; y: number }[] = [];
      for (const placement of placements) {
        if (placement.roomId !== multiB) continue;
        choirCells.push({ x: Math.floor(placement.x * layout.gridW), y: Math.floor(placement.y * layout.gridH) });
      }
      expect(choirCells).toHaveLength((counts[1] ?? 0) + (counts[2] ?? 0));
      const xs = choirCells.map((cell) => cell.x);
      const ys = choirCells.map((cell) => cell.y);
      // Exact union pin: bounding box of ALL group cells plus the one-cell
      // cover margin, clamped to the board — the merge of the two per-group
      // covers, not either one alone.
      const want = {
        x: Math.max(0, Math.min(...xs) - 1),
        y: Math.max(0, Math.min(...ys) - 1),
      };
      const wantW = Math.min(layout.gridW, Math.max(...xs) + 2) - want.x;
      const wantH = Math.min(layout.gridH, Math.max(...ys) + 2) - want.y;
      expect(merged.widthCells).toBe(wantW);
      expect(merged.heightCells).toBe(wantH);
      expect(merged.x).toBe((want.x + wantW / 2) / layout.gridW);
      expect(merged.y).toBe((want.y + wantH / 2) / layout.gridH);
      const covered = veilCells(merged, layout);
      for (const cell of choirCells) {
        expect(covered.has(`${String(cell.x)},${String(cell.y)}`)).toBe(true);
      }
      // Center normalized from the merged rect center (layout-anchored, D6).
      expect(merged.x).toBe((Math.round(merged.x * layout.gridW - merged.widthCells / 2) + merged.widthCells / 2) / layout.gridW);
      expect(battleVeilSchema.parse(merged)).toEqual(merged);
      // The Choir's groups share the room's mobsRect cells between them.
      const allCovered = new Set<string>();
      for (const key of veilCells(merged, layout)) allCovered.add(key);
      for (const cell of mobsCells(choir).slice(0, (counts[1] ?? 0) + (counts[2] ?? 0))) {
        expect(allCovered.has(`${String(cell.x)},${String(cell.y)}`)).toBe(true);
      }
    });

    it('merges a single-room two-group encounter into exactly one veil (owner jungle case: no purposeless stack)', () => {
      const roomId = '00000000-0000-4000-8000-0000000000c6';
      const layout: EncounterLayout = {
        gridW: 12,
        gridH: 12,
        theme: 'Jungle probe',
        rooms: [
          {
            id: roomId,
            name: 'Clearing',
            rects: [{ x: 2, y: 2, w: 8, h: 6 }],
            mobsRect: { x: 4, y: 4, w: 4, h: 2 },
            description: '',
            monsterIndexes: [0, 1],
            spawn: true,
            key: '',
            keyTreasure: '',
          },
        ],
        corridors: [],
      };
      const veils = veilsFromSpawnClusters(layout, [2, 2]);
      // Row-major deal: group 0 owns (4,4),(5,4); group 1 owns (6,4),(7,4) —
      // adjacent runs whose covers share ground, so exactly one veil seeds.
      expect(veils).toHaveLength(1);
      const veil = veils[0];
      if (veil === undefined) throw new Error('merged veil missing');
      // Union of the per-group covers [3,7)x[3,6) and [5,9)x[3,6).
      expect(veil).toMatchObject({ id: roomId, kind: 'fog', roomId, widthCells: 6, heightCells: 3 });
      expect(veil.x).toBe((3 + 6 / 2) / layout.gridW);
      expect(veil.y).toBe((3 + 3 / 2) / layout.gridH);
      const covered = veilCells(veil, layout);
      for (const key of ['4,4', '5,4', '6,4', '7,4']) expect(covered.has(key)).toBe(true);
      expect(battleVeilSchema.parse(veil)).toEqual(veil);
    });

    it('fails loudly when a room references a missing roster entry', () => {
      const layout = packRooms(brief());
      expect(() => veilsFromSpawnClusters(layout, [2])).toThrow(EncounterLayoutError);
    });

    it('expands each group veil by a one-cell margin: a 1x1 interior group seeds 3x3 with handles beside the token', () => {
      const roomId = '00000000-0000-4000-8000-0000000000d4';
      const layout: EncounterLayout = {
        gridW: 12,
        gridH: 12,
        theme: 'Margin probe',
        rooms: [
          {
            id: roomId,
            name: 'Cell',
            rects: [{ x: 2, y: 2, w: 6, h: 6 }],
            mobsRect: { x: 4, y: 4, w: 2, h: 2 },
            description: '',
            monsterIndexes: [0],
            spawn: true,
            key: '',
            keyTreasure: '',
          },
        ],
        corridors: [],
      };
      const veils = veilsFromSpawnClusters(layout, [1]);
      expect(veils).toHaveLength(1);
      const veil = veils[0];
      if (veil === undefined) throw new Error('group veil missing');
      // The group owns only the row-major first mobsRect cell (4,4); the
      // cover convention expands the 1x1 box by one cell on every side.
      expect(veil.widthCells).toBe(3);
      expect(veil.heightCells).toBe(3);
      expect(veil.x).toBe((3 + 3 / 2) / layout.gridW);
      expect(veil.y).toBe((3 + 3 / 2) / layout.gridH);
      const covered = veilCells(veil, layout);
      const tokenKey = '4,4';
      expect(covered.has(tokenKey)).toBe(true);
      // Grabbable body: the margin ring around the token is veil, not token.
      const ring = [...covered].filter((key) => key !== tokenKey);
      expect(ring).toHaveLength(8);
      // jsdom has no hit-testing, so the reachability contract is pinned
      // geometrically: the four edge-handle midpoints (n/s/e/w, where the
      // 44px pads center) land on margin-ring cells, never on token cells.
      const handleCells = new Set([
        `${String(Math.floor(veil.x * layout.gridW))},${String(Math.round(veil.y * layout.gridH - veil.heightCells / 2))}`,
        `${String(Math.floor(veil.x * layout.gridW))},${String(Math.round(veil.y * layout.gridH + veil.heightCells / 2) - 1)}`,
        `${String(Math.round(veil.x * layout.gridW - veil.widthCells / 2))},${String(Math.floor(veil.y * layout.gridH))}`,
        `${String(Math.round(veil.x * layout.gridW + veil.widthCells / 2) - 1)},${String(Math.floor(veil.y * layout.gridH))}`,
      ]);
      expect(handleCells.has(tokenKey)).toBe(false);
      for (const key of handleCells) expect(covered.has(key)).toBe(true);
    });

    it('clamps the margin to the board at grid edges while still covering multi-cell groups', () => {
      const roomId = '00000000-0000-4000-8000-0000000000e5';
      const layout: EncounterLayout = {
        gridW: 12,
        gridH: 12,
        theme: 'Edge probe',
        rooms: [
          {
            id: roomId,
            name: 'Corner',
            rects: [{ x: 0, y: 0, w: 6, h: 6 }],
            mobsRect: { x: 1, y: 1, w: 3, h: 2 },
            description: '',
            monsterIndexes: [0, 1],
            spawn: true,
            key: '',
            keyTreasure: '',
          },
        ],
        corridors: [],
      };
      const veils = veilsFromSpawnClusters(layout, [2, 2]);
      // Row-major deal: group 0 owns (1,1),(2,1); group 1 owns (3,1),(1,2).
      // The per-group covers ([0,4)x[0,3) and [0,5)x[0,4)) share ground, so
      // they merge to their union bounding box — a single veil.
      expect(veils).toHaveLength(1);
      const veil = veils[0];
      if (veil === undefined) throw new Error('merged veil missing');
      expect(veil).toMatchObject({ id: roomId, kind: 'fog', roomId, widthCells: 5, heightCells: 4 });
      expect(veil.x).toBe((0 + 5 / 2) / layout.gridW);
      expect(veil.y).toBe((0 + 4 / 2) / layout.gridH);
      const covered = veilCells(veil, layout);
      for (const key of ['1,1', '2,1', '3,1', '1,2']) expect(covered.has(key)).toBe(true);
      // Clamped to the board on every side.
      for (const key of covered) {
        const [x, y] = key.split(',').map(Number);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(layout.gridW);
        expect(y).toBeLessThan(layout.gridH);
      }
      expect(battleVeilSchema.parse(veil)).toEqual(veil);
    });
  });

  describe('mergeVeilCovers (seed-time overlap merge)', () => {
    const ROOM_X = '00000000-0000-4000-8000-0000000000x1';
    const ROOM_Y = '00000000-0000-4000-8000-0000000000y2';

    it('merges overlapping same-room covers into the union bounding box under the first identity', () => {
      const merged = mergeVeilCovers(
        [
          { roomId: ROOM_X, veilId: ROOM_X, rect: { x: 0, y: 0, w: 4, h: 3 } },
          { roomId: ROOM_X, veilId: 'secondary', rect: { x: 2, y: 1, w: 4, h: 3 } },
        ],
        12,
        12,
      );
      expect(merged).toHaveLength(1);
      expect(merged[0]).toEqual({ roomId: ROOM_X, veilId: ROOM_X, rect: { x: 0, y: 0, w: 6, h: 4 } });
    });

    it('keeps disjoint same-room covers separate so staged reveal still works', () => {
      const merged = mergeVeilCovers(
        [
          { roomId: ROOM_X, veilId: ROOM_X, rect: { x: 0, y: 0, w: 2, h: 2 } },
          { roomId: ROOM_X, veilId: 'far-group', rect: { x: 8, y: 8, w: 2, h: 2 } },
        ],
        12,
        12,
      );
      expect(merged).toHaveLength(2);
      expect(merged[0]).toEqual({ roomId: ROOM_X, veilId: ROOM_X, rect: { x: 0, y: 0, w: 2, h: 2 } });
      expect(merged[1]).toEqual({ roomId: ROOM_X, veilId: 'far-group', rect: { x: 8, y: 8, w: 2, h: 2 } });
    });

    it('keeps edge-touching covers with no shared ground separate', () => {
      const merged = mergeVeilCovers(
        [
          { roomId: ROOM_X, veilId: ROOM_X, rect: { x: 0, y: 0, w: 4, h: 3 } },
          { roomId: ROOM_X, veilId: 'neighbor', rect: { x: 4, y: 0, w: 4, h: 3 } },
        ],
        12,
        12,
      );
      expect(merged).toHaveLength(2);
    });

    it('never merges cross-room covers however much they overlap', () => {
      const merged = mergeVeilCovers(
        [
          { roomId: ROOM_X, veilId: ROOM_X, rect: { x: 2, y: 2, w: 4, h: 4 } },
          { roomId: ROOM_Y, veilId: ROOM_Y, rect: { x: 2, y: 2, w: 4, h: 4 } },
        ],
        12,
        12,
      );
      expect(merged).toHaveLength(2);
      expect(merged[0]?.veilId).toBe(ROOM_X);
      expect(merged[1]?.veilId).toBe(ROOM_Y);
    });

    it('merges transitively chained covers into one component', () => {
      const merged = mergeVeilCovers(
        [
          { roomId: ROOM_X, veilId: ROOM_X, rect: { x: 0, y: 0, w: 3, h: 3 } },
          { roomId: ROOM_X, veilId: 'mid', rect: { x: 2, y: 2, w: 3, h: 3 } },
          { roomId: ROOM_X, veilId: 'far', rect: { x: 4, y: 4, w: 3, h: 3 } },
        ],
        12,
        12,
      );
      expect(merged).toHaveLength(1);
      expect(merged[0]).toEqual({ roomId: ROOM_X, veilId: ROOM_X, rect: { x: 0, y: 0, w: 7, h: 7 } });
    });
  });

  it('renders schematic pixels at the exact layout dimensions', () => {
    const layout = packRooms(brief());
    const context = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
    };
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    vi.spyOn(canvas, 'toDataURL').mockReturnValue('data:image/png;base64,schematic');

    const rendered = renderSchematic(layout, 10, (width, height) => {
      canvas.width = width;
      canvas.height = height;
      return canvas;
    });
    expect(rendered).toEqual({
      dataUrl: 'data:image/png;base64,schematic',
      width: layout.gridW * 10,
      height: layout.gridH * 10,
    });
    expect(context.fillRect).toHaveBeenCalled();
    expect(context.strokeRect).toHaveBeenCalled();
  });

  describe('entrance zone', () => {
    const OPPOSITE_SIDE = {
      north: 'south',
      south: 'north',
      east: 'west',
      west: 'east',
    } as const;
    function schematicContext() {
      return {
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        closePath: vi.fn(),
        fill: vi.fn(),
        stroke: vi.fn(),
        fillRect: vi.fn(),
        strokeRect: vi.fn(),
      };
    }

    function roomWith(rects: LayoutRoom['rects'], mobsRect: LayoutRoom['mobsRect']): LayoutRoom {
      return {
        id: ROOM_A,
        name: 'Hall',
        rects,
        mobsRect,
        description: '',
        monsterIndexes: [],
        spawn: true,
        key: '',
        keyTreasure: '',
      };
    }

    it('packs exactly one entrance onto the spawn room, deterministically and valid', () => {
      const first = packRooms(brief());
      const second = packRooms(brief());
      const spawn = first.rooms.find((room) => room.spawn);
      if (spawn === undefined) throw new Error('spawn room missing');
      expect(first.rooms.filter((room) => room.entrance !== undefined)).toHaveLength(1);
      expect(spawn.entrance).toBeDefined();
      expect(second).toEqual(first);
      expect(validateEncounterLayout(first, brief().rosterCounts)).toEqual([]);
    });

    it('places the entrance on the outer wall farthest from the room doors', () => {
      // 7×6 room at (2,2) in a 24×18 grid; one corridor door west of (2,4).
      const room = roomWith([{ x: 2, y: 2, w: 7, h: 6 }], { x: 3, y: 3, w: 5, h: 4 });
      const corridorCells = new Set(['1,4']);
      const occupied = new Set<string>();
      for (let y = 2; y < 8; y += 1) {
        for (let x = 2; x < 9; x += 1) occupied.add(`${String(x)},${String(y)}`);
      }
      // Farthest wall cell from the door (2,4) is the corner (8,7) (distance 9),
      // offering east and south; the south outward cell (8,8) sits nearer the
      // grid edge (10 steps vs 15), so south wins the tiebreak.
      expect(placeEntrance(room, occupied, corridorCells, 24, 18)).toEqual({
        x: 8,
        y: 7,
        side: 'south',
      });
    });

    it('omits the entrance when every boundary face is a corridor door', () => {
      const closet = roomWith([{ x: 5, y: 5, w: 1, h: 1 }], { x: 5, y: 5, w: 1, h: 1 });
      const around = new Set(['4,5', '6,5', '5,4', '5,6']);
      expect(placeEntrance(closet, new Set(), around, 24, 18)).toBeUndefined();
    });

    it('reports entrance violations as named issues and rejects them at the schema boundary', () => {
      const layout = packRooms(brief());
      const spawn = layout.rooms.find((room) => room.spawn);
      const other = layout.rooms.find((room) => !room.spawn);
      if (spawn === undefined || other === undefined) throw new Error('rooms missing');
      const entrance = spawn.entrance;
      if (entrance === undefined) throw new Error('entrance missing');

      const moved = {
        ...layout,
        rooms: layout.rooms.map((room) =>
          room.id === spawn.id ? { ...room, entrance: { ...entrance, x: entrance.x + 100 } } : room,
        ),
      };
      expect(validateEncounterLayout(moved).join(' | ')).toContain('entrance cell is outside the room');

      const flipped = {
        ...layout,
        rooms: layout.rooms.map((room) =>
          room.id === spawn.id
            ? {
                ...room,
                entrance: { ...entrance, side: OPPOSITE_SIDE[entrance.side] },
              }
            : room,
        ),
      };
      expect(validateEncounterLayout(flipped).join(' | ')).toContain(
        'entrance side does not face the outer wall',
      );

      // The spawn room's own door cell aimed at its corridor.
      const spawnCells = new Set(spawn.rects.flatMap((rect) => {
        const keys: string[] = [];
        for (let y = rect.y; y < rect.y + rect.h; y += 1) {
          for (let x = rect.x; x < rect.x + rect.w; x += 1) keys.push(`${String(x)},${String(y)}`);
        }
        return keys;
      }));
      let doorCell: { x: number; y: number } | null = null;
      let doorSide: 'north' | 'south' | 'west' | 'east' = 'north';
      outer: for (const corridor of layout.corridors) {
        for (const rect of corridor.rects) {
          for (let y = rect.y; y < rect.y + rect.h; y += 1) {
            for (let x = rect.x; x < rect.x + rect.w; x += 1) {
              const probes: readonly (readonly ['north' | 'south' | 'west' | 'east', number, number])[] = [
                ['north', 0, -1],
                ['south', 0, 1],
                ['west', -1, 0],
                ['east', 1, 0],
              ];
              for (const [side, dx, dy] of probes) {
                if (spawnCells.has(`${String(x + dx)},${String(y + dy)}`)) {
                  doorCell = { x: x + dx, y: y + dy };
                  doorSide = side === 'north' ? 'south' : side === 'south' ? 'north' : side === 'west' ? 'east' : 'west';
                  break outer;
                }
              }
            }
          }
        }
      }
      if (doorCell === null) throw new Error('no door cell found');
      const ontoCorridor = {
        ...layout,
        rooms: layout.rooms.map((room) =>
          room.id === spawn.id ? { ...room, entrance: { x: doorCell.x, y: doorCell.y, side: doorSide } } : room,
        ),
      };
      expect(validateEncounterLayout(ontoCorridor).join(' | ')).toContain('entrance opens into a corridor');
      expect(encounterLayoutSchema.safeParse(ontoCorridor).success).toBe(false);

      const duplicated = {
        ...layout,
        rooms: layout.rooms.map((room) => (room.id === other.id ? { ...room, entrance } : room)),
      };
      const duplicatedIssues = validateEncounterLayout(duplicated).join(' | ');
      expect(duplicatedIssues).toContain('at most one entrance');
      expect(duplicatedIssues).toContain('only the spawn room may carry an entrance');
    });

    it('slides the staging block to the entrance wall, inside the room union', () => {
      const legacy = roomWith([{ x: 0, y: 0, w: 7, h: 6 }], { x: 1, y: 1, w: 5, h: 4 });
      expect(stagingBlockRect(legacy)).toEqual({ x: 1, y: 1, w: 5, h: 4 });

      const west = { ...legacy, entrance: { x: 0, y: 3, side: 'west' } as const };
      expect(stagingBlockRect(west)).toEqual({ x: 0, y: 1, w: 5, h: 4 });

      // L-shaped room: the slide stops where the union does.
      const ell = roomWith([{ x: 0, y: 0, w: 3, h: 6 }, { x: 3, y: 3, w: 3, h: 3 }], { x: 1, y: 1, w: 1, h: 4 });
      const eastEll = { ...ell, entrance: { x: 2, y: 1, side: 'east' } as const };
      expect(stagingBlockRect(eastEll)).toEqual({ x: 2, y: 1, w: 1, h: 4 });

      // Staging-style room (rect = mobsRect): no room to slide into.
      const staging = roomWith([{ x: 2, y: 2, w: 6, h: 5 }], { x: 2, y: 2, w: 6, h: 5 });
      const south = { ...staging, entrance: { x: 2, y: 6, side: 'south' } as const };
      expect(stagingBlockRect(south)).toEqual({ x: 2, y: 2, w: 6, h: 5 });
    });

    it('draws the entrance gap, landing pad and inward neon triangle on the schematic', () => {
      const context = schematicContext();
      const canvas = document.createElement('canvas');
      vi.spyOn(canvas, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
      vi.spyOn(canvas, 'toDataURL').mockReturnValue('data:image/png;base64,entrance');
      const layout: EncounterLayout = {
        gridW: 12,
        gridH: 12,
        theme: 'test',
        rooms: [
          {
            id: ROOM_A,
            name: 'Entry',
            rects: [{ x: 1, y: 1, w: 6, h: 6 }],
            mobsRect: { x: 2, y: 2, w: 4, h: 4 },
            description: '',
            monsterIndexes: [],
            spawn: true,
            entrance: { x: 1, y: 1, side: 'north' },
            key: '',
            keyTreasure: '',
          },
        ],
        corridors: [],
      };

      renderSchematic(layout, 10, (width, height) => {
        canvas.width = width;
        canvas.height = height;
        return canvas;
      });

      // Gap across the north wall of cell (1,1): thickness 2, opening 5.5.
      expect(context.fillRect).toHaveBeenCalledWith(12.25, 9, 5.5, 2);
      // One-cell landing pad outside the gap.
      expect(context.fillRect).toHaveBeenCalledWith(10, 0, 10, 10);
      // Triangle just inside, pointing south (inward): tip at (15,18), base
      // (12,12.8)–(18,12.8). Hue = palette entry past one room = B cyan 180.
      expect(context.moveTo).toHaveBeenCalledWith(15, 18);
      expect(context.lineTo).toHaveBeenCalledWith(12, 12.8);
      expect(context.lineTo).toHaveBeenCalledWith(18, 12.8);
      expect(context.closePath).toHaveBeenCalled();
      expect(context.fill).toHaveBeenCalled();
      expect(context.stroke).toHaveBeenCalled();
      expect(context.fillStyle).toBe('hsl(180, 100%, 50%)');
      expect(context.strokeStyle).toBe('#000');
    });
  });

  describe('topology', () => {
    it('keeps a hub-and-branch adjacency graph compact instead of forming a serial chain', () => {
      const roomIds = Array.from({ length: 6 }, (_, i) => `00000000-0000-4000-8000-0000abcdef0${String(i)}`);
      const adjacency: Record<number, number[]> = {
        0: [1, 2, 3],
        1: [0],
        2: [0, 4],
        3: [0],
        4: [2, 5],
        5: [4],
      };
      const layout = packRooms({
        theme: 'Branching vaults',
        aspect: '4:3',
        preset: 'dungeon',
        entryRoomId: roomIds[0] ?? ROOM_A,
        rosterCounts: [1],
        rooms: roomIds.map((id, index) => ({
          id,
          name: `Vault ${String(index + 1)}`,
          description: '',
          size: 'small' as const,
          monsterIndexes: index === 0 ? [0] : [],
          adjacentRoomIds: (adjacency[index] ?? []).map((adjacent) => roomIds[adjacent] ?? ROOM_A),
          key: '',
          keyTreasure: '',
        })),
      });
      expect(validateEncounterLayout(layout, [1])).toEqual([]);
      const centers = new Map(
        layout.rooms.map((room) => [
          room.id,
          room.rects.reduce((sum, rect) => sum + rect.x + rect.w / 2, 0) / room.rects.length,
        ]),
      );
      // The hub room should sit between its linked leaves instead of lining
      // them up across the map: the joined adjacent rooms must remain within
      // a compact neighborhood, not stretch one cell deep across the grid.
      const hub = centers.get(roomIds[0] ?? ROOM_A) ?? 0;
      expect(Math.abs((centers.get(roomIds[1] ?? ROOM_A) ?? 0) - hub)).toBeLessThanOrEqual(20);
      expect(Math.abs((centers.get(roomIds[3] ?? ROOM_A) ?? 0) - hub)).toBeLessThanOrEqual(20);
      // Corridors only connect graph neighbors; the union footprint must stay
      // far smaller than a serial route across the whole dungeon tier.
      const corridorCells = layout.corridors.reduce(
        (sum, corridor) => sum + corridor.rects.reduce((inner, rect) => inner + rect.w * rect.h, 0),
        0,
      );
      expect(corridorCells).toBeLessThan(110);
      expect(layout.corridors).toHaveLength(5);
    });
  });

  describe('capacity (10 rooms)', () => {
    it('supports 10-room dungeon layouts', () => {
      const roomIds = Array.from({ length: 10 }, (_, i) => `00000000-0000-4000-8000-00000000000${String(i)}`);
      const layout = packRooms({
        theme: 'Massive Crypt',
        aspect: '4:3',
        preset: 'dungeon',
        entryRoomId: roomIds[0] ?? ROOM_A,
        rosterCounts: Array(10).fill(1) as number[],
        rooms: roomIds.map((id, index) => ({
          id,
          name: `Dungeon Chamber ${String(index + 1)}`,
          description: `Room details ${String(index + 1)}`,
          size: 'small' as const,
          monsterIndexes: [index],
          adjacentRoomIds: index === 0 ? [roomIds[1] ?? ROOM_A] : [roomIds[0] ?? ROOM_A],
          key: `Key ${String(index + 1)}`,
          keyTreasure: '',
        })),
      });

      expect(layout.gridW).toBe(48);
      expect(layout.gridH).toBe(36);
      expect(layout.rooms).toHaveLength(10);
      expect(validateEncounterLayout(layout, Array(10).fill(1) as number[])).toEqual([]);
    });
  });

  describe('dungeon preset grid (docs/11 D10)', () => {
    it('packs on the fixed \u00d72 tier per aspect, independent of room count', () => {
      for (const aspect of ['4:3', '16:9', '1:1'] as const) {
        const layout = packRooms({ ...brief(), aspect, preset: 'dungeon' });
        expect(layout.gridW).toBe(DUNGEON_GRIDS[aspect].gridW);
        expect(layout.gridH).toBe(DUNGEON_GRIDS[aspect].gridH);
        expect(validateEncounterLayout(layout, brief().rosterCounts)).toEqual([]);
      }
    });

    it('keeps a dungeon pack deterministic and identical across room counts', () => {
      const first = packRooms({ ...brief(), preset: 'dungeon' });
      const second = packRooms({ ...brief(), preset: 'dungeon' });
      expect(first).toEqual(second);
      // A 1-room brief gets the SAME fixed tier (fixed scale, not adaptive).
      const single = packRooms({
        theme: 'Crypt antechamber',
        aspect: '4:3',
        preset: 'dungeon',
        entryRoomId: ROOM_A,
        rosterCounts: [2],
        rooms: [
          { id: ROOM_A, name: 'Antechamber', description: '', size: 'medium', monsterIndexes: [0], adjacentRoomIds: [], key: '', keyTreasure: '' },
        ],
      });
      expect(single.gridW).toBe(48);
      expect(single.gridH).toBe(36);
    });

    it('packs a 10-room dungeon complex and derives veils on the fine grid', () => {
      const ids = Array.from({ length: 10 }, (_, i) => `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`);
      const layout = packRooms({
        theme: 'Deep complex',
        aspect: '4:3',
        preset: 'dungeon',
        entryRoomId: ids[0] ?? ROOM_A,
        rosterCounts: Array(10).fill(1) as number[],
        rooms: ids.map((id, index) => ({
          id,
          name: `Chamber ${String(index + 1)}`,
          description: '',
          size: index % 3 === 0 ? 'large' as const : 'medium' as const,
          monsterIndexes: [index],
          adjacentRoomIds: index === 0 ? [ids[1] ?? id] : [ids[index - 1] ?? id],
          key: '',
          keyTreasure: '',
        })),
      });
      expect(layout.gridW).toBe(48);
      expect(layout.gridH).toBe(36);
      expect(validateEncounterLayout(layout, Array(10).fill(1) as number[])).toEqual([]);
      const veils = veilsFromRooms(layout);
      expect(veils).toHaveLength(10);
      expect(veils.every((veil) => veil.kind === 'fog')).toBe(true);
    });

  });
});

describe('natural-site placement overlay (docs/11 natural-site mode)', () => {
  /** Recorder context: every canvas call lands in `calls` with the fill
   * style snapshotted at call time — the pins read semantics, not pixels. */
  function recorderContext() {
    const calls: { method: string; args: unknown[]; fillStyle: unknown }[] = [];
    const record = (method: string) => (...args: unknown[]) => {
      calls.push({ method, args, fillStyle: (context as { fillStyle?: string }).fillStyle ?? '' });
    };
    const context = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      beginPath: record('beginPath'),
      moveTo: record('moveTo'),
      lineTo: record('lineTo'),
      arc: record('arc'),
      closePath: record('closePath'),
      fill: record('fill'),
      stroke: record('stroke'),
      fillRect: record('fillRect'),
      strokeRect: record('strokeRect'),
    };
    return { context, calls };
  }

  function renderWith(
    layout: EncounterLayout,
    mode: 'architectural' | 'natural',
  ): ReturnType<typeof recorderContext>['calls'] {
    const { context, calls } = recorderContext();
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    vi.spyOn(canvas, 'toDataURL').mockReturnValue('data:image/png;base64,mode');
    renderSchematic(layout, 10, (width, height) => {
      canvas.width = width;
      canvas.height = height;
      return canvas;
    }, mode);
    return calls;
  }

  /** One room (mobsRect 4×4 at (2,2)) with a north entrance on its outer
   * wall — the same shape the dungeon entrance test pins. */
  function outdoorLayout(): EncounterLayout {
    return {
      gridW: 12,
      gridH: 12,
      theme: 'mossy riverbank',
      rooms: [
        {
          id: ROOM_A,
          name: 'Riverbank',
          rects: [{ x: 1, y: 1, w: 6, h: 6 }],
          mobsRect: { x: 2, y: 2, w: 4, h: 4 },
          description: '',
          monsterIndexes: [],
          spawn: true,
          entrance: { x: 1, y: 1, side: 'north' },
          key: '',
          keyTreasure: '',
        },
      ],
      corridors: [],
    };
  }

  it('paints only the placement overlay: patches + marker, no wall stroke, no door vocabulary', () => {
    const calls = renderWith(outdoorLayout(), 'natural');
    // NO architecture: no wall/room stroke anywhere, and the only fillRect
    // is the neutral base coat (no corridor greys, no wall-gap openings, no
    // landing pads).
    expect(calls.filter((call) => call.method === 'strokeRect')).toHaveLength(0);
    const fillRects = calls.filter((call) => call.method === 'fillRect');
    expect(fillRects).toHaveLength(1);
    expect(fillRects[0]?.fillStyle).toBe('#111827');
    expect(calls.some((call) => call.fillStyle === '#d1d5db')).toBe(false);
    // The placement patches: 16 cluster cells × two passes (halo + core) of
    // ONE union fill each, in muted moss — never pale, never grey.
    const arcs = calls.filter((call) => call.method === 'arc');
    expect(arcs).toHaveLength(32);
    const patchFills = calls.filter(
      (call) => call.method === 'fill' && (call.fillStyle === 'rgba(90, 107, 68, 0.35)' || call.fillStyle === 'rgba(90, 107, 68, 0.9)'),
    );
    expect(patchFills).toHaveLength(2);
    // Every patch circle sits over the mob cluster cells (mobsRect at
    // cellPx 10: x ∈ [20, 60), y ∈ [20, 60), jittered ≤ ±0.35 cells).
    for (const call of arcs) {
      const [cx, cy] = call.args as [number, number, number];
      expect(cx).toBeGreaterThan(18);
      expect(cx).toBeLessThan(62);
      expect(cy).toBeGreaterThan(18);
      expect(cy).toBeLessThan(62);
    }
    // Organic on purpose: the jittered radii are not uniform (a plain
    // rectangle-shaped patch would read as architecture).
    const radii = new Set(arcs.map((call) => call.args[2]));
    expect(radii.size).toBeGreaterThan(1);
  });

  it('paints the same canonical entrance triangle with no wall gap around it', () => {
    const calls = renderWith(outdoorLayout(), 'natural');
    // The dungeon pin's exact triangle geometry: tip (15,18), base
    // (12,12.8)–(18,12.8), hue = palette entry past one room (cyan).
    const moveTo = calls.filter((call) => call.method === 'moveTo').map((call) => call.args);
    expect(moveTo).toContainEqual([15, 18]);
    const lineTo = calls.filter((call) => call.method === 'lineTo').map((call) => call.args);
    expect(lineTo).toContainEqual([12, 12.8]);
    expect(lineTo).toContainEqual([18, 12.8]);
    const triangle = calls.find((call) => call.method === 'fill' && call.fillStyle === 'hsl(180, 100%, 50%)');
    expect(triangle).toBeDefined();
    // And NOTHING else fills #d1d5db — no wall gap, no landing pad.
    expect(calls.some((call) => call.fillStyle === '#d1d5db')).toBe(false);
  });

  it('renders deterministically (same layout → same overlay bytes)', () => {
    const first = renderWith(outdoorLayout(), 'natural');
    const second = renderWith(outdoorLayout(), 'natural');
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('leaves the architectural mode byte-identical: walls, corridors, strokeRect all paint', () => {
    const layout = outdoorLayout();
    const { context, calls } = recorderContext();
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    vi.spyOn(canvas, 'toDataURL').mockReturnValue('data:image/png;base64,mode');
    const factory = (width: number, height: number) => {
      canvas.width = width;
      canvas.height = height;
      return canvas;
    };
    // The pre-mode call shape (no mode argument) and the explicit
    // 'architectural' call produce the identical call sequence — the
    // dungeon contract is untouched by the mode addition.
    renderSchematic(layout, 10, factory);
    const defaulted = JSON.stringify(calls);
    calls.length = 0;
    renderSchematic(layout, 10, factory, 'architectural');
    expect(JSON.stringify(calls)).toBe(defaulted);
    // The architectural vocabulary is present: wall strokes, room fills,
    // door-gap greys — and NO organic patch arcs anywhere.
    expect(calls.filter((call) => call.method === 'strokeRect').length).toBeGreaterThan(0);
    expect(calls.some((call) => call.fillStyle === '#d1d5db')).toBe(true);
    expect(calls.filter((call) => call.method === 'arc')).toHaveLength(0);
  });
});
