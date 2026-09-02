import { beforeEach, describe, expect, it, vi } from 'vitest';

import { newId, packRooms } from '@/domain';
import {
  coarseStructure,
  compareStructureGrids,
  verifyEncounterMap,
} from '@/llm/encounterVision';
import { chat } from '@/llm/openrouter';

vi.mock('@/llm/openrouter', () => ({ chat: vi.fn() }));
const chatMock = vi.mocked(chat);

function layout() {
  const a = newId();
  const b = newId();
  return packRooms({
    theme: 'Ash temple',
    aspect: '4:3',
    entryRoomId: a,
    rosterCounts: [1],
    rooms: [
      {
        id: a,
        name: 'Gate',
        description: '',
        size: 'small',
        monsterIndexes: [],
        adjacentRoomIds: [b],
      },
      {
        id: b,
        name: 'Sanctum',
        description: '',
        size: 'medium',
        monsterIndexes: [0],
        adjacentRoomIds: [a],
      },
    ],
  });
}

beforeEach(() => {
  chatMock.mockReset();
});

describe('encounter map vision verification', () => {
  it('builds a bounded deterministic coarse structure grid', () => {
    const expected = coarseStructure(layout());
    expect(expected.cols).toBeLessThanOrEqual(12);
    expect(expected.rows).toBeLessThanOrEqual(9);
    expect(expected.cells).toHaveLength(expected.cols * expected.rows);
    expect(expected.cells).toContain('floor');
    expect(expected.cells).toContain('void');
  });

  it('flags mismatches above 12% and excludes declared door cells', () => {
    const expected = { cols: 2, rows: 2, cells: ['floor', 'wall', 'void', 'floor'] as const };
    const actual = { cols: 2, rows: 2, cells: ['void', 'wall', 'void', 'floor'] as const };
    const compared = compareStructureGrids(
      { ...expected, cells: [...expected.cells] },
      { ...actual, cells: [...actual.cells] },
    );
    expect(compared.mismatchRatio).toBe(0.25);
    expect(compared.needsReview).toBe(true);
    expect(
      compareStructureGrids(
        { ...expected, cells: [...expected.cells] },
        { ...actual, cells: [...actual.cells] },
        new Set([0]),
      ).mismatchRatio,
    ).toBe(0);
  });

  it('sends both images and repairs invalid JSON exactly once', async () => {
    const mapLayout = layout();
    const expected = coarseStructure(mapLayout);
    chatMock
      .mockResolvedValueOnce('not-json')
      .mockResolvedValueOnce(JSON.stringify(expected));

    const result = await verifyEncounterMap({
      layout: mapLayout,
      schematicDataUrl: 'data:image/png;base64,schematic',
      stylizedDataUrl: 'data:image/webp;base64,stylized',
      model: 'vision/model',
    });
    expect(result.mismatchRatio).toBe(0);
    expect(chatMock).toHaveBeenCalledTimes(2);
    const firstMessages = chatMock.mock.calls[0]?.[0];
    const user = firstMessages?.find((message) => message.role === 'user');
    expect(user?.content).toEqual(
      expect.arrayContaining([
        { type: 'image_url', image_url: { url: 'data:image/png;base64,schematic' } },
        { type: 'image_url', image_url: { url: 'data:image/webp;base64,stylized' } },
      ]),
    );
    expect(chatMock.mock.calls[0]?.[1]).toMatchObject({ responseFormat: 'json' });
  });

  it('fails loudly when the repair response is still invalid', async () => {
    chatMock.mockResolvedValue('still invalid');
    await expect(
      verifyEncounterMap({
        layout: layout(),
        schematicDataUrl: 'data:image/png;base64,a',
        stylizedDataUrl: 'data:image/webp;base64,b',
        model: 'vision/model',
      }),
    ).rejects.toThrow(/after repair/);
    expect(chatMock).toHaveBeenCalledTimes(2);
  });
});
