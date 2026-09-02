import { describe, expect, it, vi } from 'vitest';

import {
  EncounterLayoutError,
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
});
