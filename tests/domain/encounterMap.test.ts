import { describe, expect, it, vi } from 'vitest';

import {
  adaptiveGridDimensions,
  EncounterLayoutError,
  layoutFromStagingMarkers,
  packRooms,
  placeEntrance,
  placeMonsters,
  renderSchematic,
  stagingBlockRect,
  validateEncounterLayout,
  veilsFromRooms,
  encounterLayoutSchema,
  type EncounterLayout,
  type EncounterMapBrief,
  type LayoutRoom,
} from '@/domain';

const ROOM_A = '00000000-0000-4000-8000-0000000000a1';
const ROOM_B = '00000000-0000-4000-8000-0000000000b2';
const ROOM_C = '00000000-0000-4000-8000-0000000000c3';

function brief(): EncounterMapBrief {
  return {
    theme: 'Flooded dwarven crypt',
    aspect: '4:3',
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
      },
      {
        id: ROOM_B,
        name: 'Flooded Nave',
        description: 'Black water',
        size: 'large',
        monsterIndexes: [0],
        adjacentRoomIds: [ROOM_A, ROOM_C],
      },
      {
        id: ROOM_C,
        name: 'Reliquary',
        description: 'Sealed vault',
        size: 'medium',
        monsterIndexes: [1],
        adjacentRoomIds: [ROOM_B],
      },
    ],
  };
}

describe('encounter map layout engine', () => {
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

    it('emits the staging entrance on the map-edge side of the spawn area', () => {
      const stagingLayout = layoutFromStagingMarkers({
        theme: 'Cistern of Echoes',
        aspect: '4:3',
        rosterCounts: [3, 1, 2],
        rooms: [
          {
            id: ROOM_A,
            name: 'Flooded Stair',
            description: '',
            monsterIndexes: [0],
            spawn: true,
            letter: 'A',
            markerHue: 300,
            markerColorName: 'magenta',
            stagingPoint: { x: 0.47, y: 0.84 },
          },
          {
            id: ROOM_B,
            name: 'Settling Basin',
            description: '',
            monsterIndexes: [1],
            spawn: false,
            letter: 'B',
            markerHue: 180,
            markerColorName: 'cyan',
            stagingPoint: { x: 0.15, y: 0.5 },
          },
          {
            id: ROOM_C,
            name: 'Filter Gallery',
            description: '',
            monsterIndexes: [2],
            spawn: false,
            letter: 'C',
            markerHue: 60,
            markerColorName: 'yellow',
            stagingPoint: { x: 0.75, y: 0.54 },
          },
        ],
      });
      const spawn = stagingLayout.rooms.find((room) => room.spawn);
      if (spawn === undefined) throw new Error('spawn room missing');
      // Veil rect is {12,19,10,8} on the 36×27 grid — its south edge lies on
      // the grid boundary, so the entrance faces south at the lexicographically
      // first bottom-row cell.
      expect(spawn.rects[0]).toEqual({ x: 12, y: 19, w: 10, h: 8 });
      expect(spawn.entrance).toEqual({ x: 12, y: 26, side: 'south' });
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

  describe('staging layout and adaptive grid', () => {
    it('scales grid dimensions adaptively based on room count and aspect', () => {
      // 4:3
      expect(adaptiveGridDimensions('4:3', 1)).toEqual({ gridW: 24, gridH: 18 });
      expect(adaptiveGridDimensions('4:3', 2)).toEqual({ gridW: 24, gridH: 18 });
      expect(adaptiveGridDimensions('4:3', 5)).toEqual({ gridW: 36, gridH: 27 });
      expect(adaptiveGridDimensions('4:3', 10)).toEqual({ gridW: 48, gridH: 36 });

      // 16:9
      expect(adaptiveGridDimensions('16:9', 2)).toEqual({ gridW: 28, gridH: 16 });
      expect(adaptiveGridDimensions('16:9', 4)).toEqual({ gridW: 42, gridH: 24 });
      expect(adaptiveGridDimensions('16:9', 8)).toEqual({ gridW: 56, gridH: 32 });

      // 1:1
      expect(adaptiveGridDimensions('1:1', 1)).toEqual({ gridW: 20, gridH: 20 });
      expect(adaptiveGridDimensions('1:1', 5)).toEqual({ gridW: 30, gridH: 30 });
      expect(adaptiveGridDimensions('1:1', 10)).toEqual({ gridW: 40, gridH: 40 });
    });

    it('builds a valid staging layout from detected marker points with generous veils', () => {
      const stagingLayout = layoutFromStagingMarkers({
        theme: 'Cistern of Echoes',
        aspect: '4:3',
        rosterCounts: [3, 1, 2],
        rooms: [
          {
            id: ROOM_A,
            name: 'Flooded Stair',
            description: 'Steps into water',
            monsterIndexes: [0],
            spawn: true,
            letter: 'A',
            markerHue: 300,
            markerColorName: 'magenta',
            stagingPoint: { x: 0.47, y: 0.84 },
          },
          {
            id: ROOM_B,
            name: 'Settling Basin',
            description: 'Deep reservoir',
            monsterIndexes: [1],
            spawn: false,
            letter: 'B',
            markerHue: 180,
            markerColorName: 'cyan',
            stagingPoint: { x: 0.15, y: 0.50 },
          },
          {
            id: ROOM_C,
            name: 'Filter Gallery',
            description: 'Muck pits',
            monsterIndexes: [2],
            spawn: false,
            letter: 'C',
            markerHue: 60,
            markerColorName: 'yellow',
            stagingPoint: { x: 0.75, y: 0.54 },
          },
        ],
      });

      expect(stagingLayout.gridW).toBe(36);
      expect(stagingLayout.gridH).toBe(27);
      expect(stagingLayout.rooms).toHaveLength(3);
      expect(validateEncounterLayout(stagingLayout, [3, 1, 2])).toEqual([]);

      // Test generous veils
      const veils = veilsFromRooms(stagingLayout);
      expect(veils).toHaveLength(3);
      for (const veil of veils) {
        expect(veil.kind).toBe('fog');
        expect(veil.widthCells).toBeGreaterThanOrEqual(10);
        expect(veil.heightCells).toBeGreaterThanOrEqual(8);
      }

      // Test placements
      const placements = placeMonsters(stagingLayout, [{ count: 3 }, { count: 1 }, { count: 2 }]);
      expect(placements).toHaveLength(6);
      expect(placements.every((p) => p.x > 0 && p.x < 1 && p.y > 0 && p.y < 1)).toBe(true);
    });

    it('supports 10-room dungeon layouts', () => {
      const roomIds = Array.from({ length: 10 }, (_, i) => `00000000-0000-4000-8000-0000000000${i < 10 ? String(i) : 'a'}${String(i)}`);
      const stagingRooms = roomIds.map((id, index) => ({
        id,
        name: `Dungeon Chamber ${String(index + 1)}`,
        description: `Room details ${String(index + 1)}`,
        monsterIndexes: [index],
        spawn: index === 0,
        letter: String.fromCharCode(65 + index),
        markerHue: (index * 36) % 360,
        markerColorName: 'marker-color',
        stagingPoint: { x: (index % 4) * 0.25 + 0.1, y: Math.floor(index / 4) * 0.3 + 0.15 },
      }));

      const layout = layoutFromStagingMarkers({
        theme: 'Massive Crypt',
        aspect: '4:3',
        rosterCounts: Array(10).fill(1) as number[],
        rooms: stagingRooms,
      });

      expect(layout.gridW).toBe(48);
      expect(layout.gridH).toBe(36);
      expect(layout.rooms).toHaveLength(10);
      expect(validateEncounterLayout(layout, Array(10).fill(1) as number[])).toEqual([]);
    });
  });
});
