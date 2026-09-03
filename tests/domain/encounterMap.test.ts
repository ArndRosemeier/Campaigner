import { describe, expect, it, vi } from 'vitest';

import {
  adaptiveGridDimensions,
  EncounterLayoutError,
  layoutFromStagingMarkers,
  packRooms,
  placeMonsters,
  renderSchematic,
  validateEncounterLayout,
  veilsFromRooms,
  type EncounterLayout,
  type EncounterMapBrief,
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
