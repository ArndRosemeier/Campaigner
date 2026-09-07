import { beforeEach, describe, expect, it, vi } from 'vitest';

import { newId, packRooms, type EncounterLayout } from '@/domain';
import {
  coarseDoorIndexes,
  coarseDriftTolerances,
  coarseEntranceIndexes,
  coarseStructure,
  compareStructureGrids,
  verifyEncounterMap,
} from '@/llm/encounterVision';
import { chat } from '@/llm/openrouter';

vi.mock('@/llm/openrouter', () => ({ chat: vi.fn() }));
const chatMock = vi.mocked(chat);

function complexLayout() {
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
        key: '',
        keyTreasure: '',
      },
      {
        id: b,
        name: 'Sanctum',
        description: '',
        size: 'medium',
        monsterIndexes: [0],
        adjacentRoomIds: [a],
        key: '',
        keyTreasure: '',
      },
    ],
  });
}

/** The owner's failing shape: a single-room arena, 24×18 standard, entrance
 * north (packRooms places it deterministically on the north outer wall). */
function singleLayout(): EncounterLayout {
  const a = newId();
  return packRooms({
    theme: 'Kreuzgang der Unterstadt-Wache',
    aspect: '4:3',
    preset: 'standard',
    entryRoomId: a,
    rosterCounts: [4],
    rooms: [
      {
        id: a,
        name: 'Kreuzgang',
        description: '',
        size: 'medium',
        monsterIndexes: [0],
        adjacentRoomIds: [],
        key: '',
        keyTreasure: '',
      },
    ],
  });
}

/** A single-room layout without an entrance (placeEntrance can omit it). */
function singleLayoutNoEntrance(): EncounterLayout {
  const a = newId();
  return {
    gridW: 24,
    gridH: 18,
    theme: 'Cellar',
    rooms: [
      {
        id: a,
        name: 'Cellar',
        description: '',
        monsterIndexes: [],
        spawn: true,
        key: '',
        keyTreasure: '',
        rects: [{ x: 9, y: 6, w: 6, h: 5 }],
        mobsRect: { x: 10, y: 7, w: 4, h: 3 },
      },
    ],
    corridors: [],
    path: [a],
  };
}

function verdictReply(overrides: Partial<Record<'arenaCount' | 'arenaInRegion' | 'entranceGap' | 'notes', unknown>> = {}) {
  return JSON.stringify({
    arenaCount: 1,
    arenaInRegion: true,
    entranceGap: true,
    notes: 'one walled arena, opening at the top',
    ...overrides,
  });
}

function userText(callIndex: number): string | undefined {
  const message = chatMock.mock.calls[callIndex]?.[0]?.find((candidate) => candidate.role === 'user');
  const content = message?.content;
  if (typeof content === 'string') return content;
  return content?.find((part) => part.type === 'text')?.text;
}

beforeEach(() => {
  chatMock.mockReset();
});

describe('encounter map vision verification', () => {
  it('builds a bounded deterministic coarse structure grid', () => {
    const expected = coarseStructure(complexLayout());
    expect(expected.cols).toBeLessThanOrEqual(12);
    expect(expected.rows).toBeLessThanOrEqual(9);
    expect(expected.cells).toHaveLength(expected.cols * expected.rows);
    expect(expected.cells).toContain('floor');
    expect(expected.cells).toContain('void');
    expect(coarseDoorIndexes(complexLayout()).size).toBeGreaterThan(0);
  });

  it('flags mismatches above 12% and excludes declared door cells, naming the counts', () => {
    const expected = { cols: 2, rows: 2, cells: ['floor', 'wall', 'void', 'floor'] as const };
    const actual = { cols: 2, rows: 2, cells: ['void', 'wall', 'void', 'floor'] as const };
    const compared = compareStructureGrids(
      { ...expected, cells: [...expected.cells] },
      { ...actual, cells: [...actual.cells] },
    );
    expect(compared.mismatchRatio).toBe(0.25);
    expect(compared.needsReview).toBe(true);
    // Threshold semantics are NAMED: what mismatched, by how much, against a
    // counted allowance.
    expect(compared.report).toBe(
      'structure verification: 1 of 4 graded cells mismatched the layout (allowance 0 = 12% of graded cells; no cells excluded)',
    );
    const tolerated = compareStructureGrids(
      { ...expected, cells: [...expected.cells] },
      { ...actual, cells: [...actual.cells] },
      new Set([0]),
    );
    expect(tolerated.mismatchRatio).toBe(0);
    expect(tolerated.report).toContain('within tolerance');
    expect(tolerated.report).toContain('1 excluded cell (door/entrance openings)');
  });

  it('excludes entrance coarse cells from the default comparison (drift tolerance)', async () => {
    const packed = complexLayout();
    const expected = coarseStructure(packed);
    const entrances = coarseEntranceIndexes(packed);
    expect(entrances.size).toBeGreaterThan(0);
    const tolerances = coarseDriftTolerances(packed);
    for (const door of coarseDoorIndexes(packed)) expect(tolerances.has(door)).toBe(true);
    for (const index of entrances) expect(tolerances.has(index)).toBe(true);

    // Behavioral pin: flipping EVERY entrance coarse cell in the vision
    // response still passes the default (doors ∪ entrance) exclusion.
    const cells = [...expected.cells];
    for (const index of entrances) {
      cells[index] = cells[index] === 'floor' ? 'void' : 'floor';
    }
    chatMock.mockResolvedValue({
      text: JSON.stringify({ cols: expected.cols, rows: expected.rows, cells }),
      modelUsed: 'test-model',
      fallback: null,
    });
    const verification = await verifyEncounterMap({
      layout: packed,
      schematicDataUrl: 'data:image/png;base64,schematic',
      stylizedDataUrl: 'data:image/png;base64,stylized',
      model: 'test-model',
    });
    expect(verification.needsReview).toBe(false);
    expect(verification.mismatchedIndexes).toEqual([]);
  });

  it('sends both images and repairs invalid JSON exactly once (complex grid branch)', async () => {
    const mapLayout = complexLayout();
    const expected = coarseStructure(mapLayout);
    chatMock
      .mockResolvedValueOnce({ text: 'not-json', modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(expected), modelUsed: 'test-model', fallback: null });

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
    expect(chatMock.mock.calls[0]?.[1]).toMatchObject({
      responseFormat: { kind: 'schema', name: 'structure-grid' },
    });
    expect(chatMock.mock.calls[1]?.[1]).toMatchObject({
      responseFormat: { kind: 'schema', name: 'structure-grid' },
    });
  });

  it('fails loudly when the repair response is still invalid (complex grid branch)', async () => {
    chatMock.mockResolvedValue({ text: 'still invalid', modelUsed: 'test-model', fallback: null });
    await expect(
      verifyEncounterMap({
        layout: complexLayout(),
        schematicDataUrl: 'data:image/png;base64,a',
        stylizedDataUrl: 'data:image/webp;base64,b',
        model: 'vision/model',
      }),
    ).rejects.toThrow(/after repair/);
    expect(chatMock).toHaveBeenCalledTimes(2);
  });

  it('complex prompts describe the structure and the class semantics', async () => {
    const mapLayout = complexLayout();
    const expected = coarseStructure(mapLayout);
    chatMock.mockResolvedValue({
      text: JSON.stringify({ cols: expected.cols, rows: expected.rows, cells: expected.cells }),
      modelUsed: 'test-model',
      fallback: null,
    });
    await verifyEncounterMap({
      layout: mapLayout,
      schematicDataUrl: 'data:image/png;base64,schematic',
      stylizedDataUrl: 'data:image/webp;base64,stylized',
      model: 'vision/model',
    });
    const text = userText(0);
    expect(text).toBeDefined();
    // Structural anchoring: room count, corridor count, per-room regions.
    expect(text).toContain('2 rooms joined by 1 corridor');
    expect(text).toContain("Room 'Gate' spans roughly coarse columns");
    expect(text).toContain("Room 'Sanctum' spans roughly coarse columns");
    // Class semantics so the void periphery is judged consistently.
    expect(text).toContain('"void" — everything beyond the mapped structure');
  });

  it('complex verify still enforces structure and names the failing counts', async () => {
    const mapLayout = complexLayout();
    const expected = coarseStructure(mapLayout);
    const tolerances = coarseDriftTolerances(mapLayout);
    const graded = expected.cells.flatMap((_, index) => (tolerances.has(index) ? [] : [index]));
    // Flip well above the 12% allowance of the graded cells.
    const cells = [...expected.cells];
    for (const index of graded.slice(0, 30)) {
      cells[index] = cells[index] === 'floor' ? 'void' : 'floor';
    }
    chatMock.mockResolvedValue({
      text: JSON.stringify({ cols: expected.cols, rows: expected.rows, cells }),
      modelUsed: 'test-model',
      fallback: null,
    });
    const failed = await verifyEncounterMap({
      layout: mapLayout,
      schematicDataUrl: 'data:image/png;base64,schematic',
      stylizedDataUrl: 'data:image/webp;base64,stylized',
      model: 'vision/model',
    });
    expect(failed.needsReview).toBe(true);
    expect(failed.report).toMatch(
      new RegExp(`structure verification: 30 of ${String(graded.length)} graded cells mismatched the layout \\(allowance \\d+ = 12% of graded cells;`),
    );

    // A sub-threshold drift stays within tolerance, and says so.
    const nearMiss = [...expected.cells];
    for (const index of graded.slice(0, 2)) {
      nearMiss[index] = nearMiss[index] === 'floor' ? 'void' : 'floor';
    }
    chatMock.mockResolvedValue({
      text: JSON.stringify({ cols: expected.cols, rows: expected.rows, cells: nearMiss }),
      modelUsed: 'test-model',
      fallback: null,
    });
    const passed = await verifyEncounterMap({
      layout: mapLayout,
      schematicDataUrl: 'data:image/png;base64,schematic',
      stylizedDataUrl: 'data:image/webp;base64,stylized',
      model: 'vision/model',
    });
    expect(passed.needsReview).toBe(false);
    expect(passed.report).toContain('within tolerance');
  });
});

describe('single-arena structural verdict (the verify blocker fix)', () => {
  it('verifies a single arena by verdict questions, not per-cell grading', async () => {
    const mapLayout = singleLayout();
    expect(mapLayout.rooms).toHaveLength(1);
    expect(mapLayout.rooms[0]?.entrance?.side).toBe('north');
    chatMock.mockResolvedValue({ text: verdictReply(), modelUsed: 'test-model', fallback: null });
    const verification = await verifyEncounterMap({
      layout: mapLayout,
      schematicDataUrl: 'data:image/png;base64,schematic',
      stylizedDataUrl: 'data:image/webp;base64,stylized',
      model: 'vision/model',
    });
    expect(verification.needsReview).toBe(false);
    expect(verification.mismatchRatio).toBe(0);
    expect(verification.mismatchedIndexes).toEqual([]);
    expect(verification.report).toContain('single-arena structural verdict passed');
    expect(verification.report).toContain('entrance gap in the north wall confirmed');

    // Contract pin: the single-arena call uses the verdict schema and asks
    // the coarse questions.
    expect(chatMock.mock.calls[0]?.[1]).toMatchObject({
      responseFormat: { kind: 'schema', name: 'arena-verdict' },
    });
    const text = userText(0);
    expect(text).toContain('SINGLE-ARENA');
    expect(text).toContain('"arenaCount"');
    expect(text).toContain('gap in the arena\'s outer wall on the north side');
    expect(text).toContain('coarse columns');
  });

  it('never asks the single-arena model for the old coarse-cell grid', async () => {
    // REGRESSION PIN (owner blocker): under the old contract the vision model
    // classified a 12×9 grid whose expected cells are ~88% 'void' periphery
    // for a single room — any honest reading of a walled arena mismatched
    // 95/108 cells (ratio 0.88) and failed the 0.12 threshold 100% of the
    // time. The single-arena contract must not request the grid at all.
    const mapLayout = singleLayout();
    chatMock.mockResolvedValue({ text: verdictReply(), modelUsed: 'test-model', fallback: null });
    await verifyEncounterMap({
      layout: mapLayout,
      schematicDataUrl: 'data:image/png;base64,schematic',
      stylizedDataUrl: 'data:image/webp;base64,stylized',
      model: 'vision/model',
    });
    const text = userText(0);
    expect(text).not.toMatch(/"cells"/);
    expect(text).not.toMatch(/row-major/);
    expect(text).not.toMatch(/Classify each coarse cell/);
  });

  it('prompts reference no painted markers, plaques, discs, neon or palette', async () => {
    for (const mapLayout of [singleLayout(), complexLayout()]) {
      const expected = coarseStructure(mapLayout);
      const reply =
        mapLayout.rooms.length === 1
          ? verdictReply()
          : JSON.stringify({ cols: expected.cols, rows: expected.rows, cells: expected.cells });
      chatMock.mockResolvedValue({ text: reply, modelUsed: 'test-model', fallback: null });
      await verifyEncounterMap({
        layout: mapLayout,
        schematicDataUrl: 'data:image/png;base64,schematic',
        stylizedDataUrl: 'data:image/webp;base64,stylized',
        model: 'vision/model',
      });
      const text = userText(chatMock.mock.calls.length - 1);
      expect(text).toBeDefined();
      expect(text?.toLowerCase()).not.toMatch(/disc|plaque|neon|marker|palette|triangle|canonical/);
    }
  });

  it('names every failed single-arena expectation in the report', async () => {
    const mapLayout = singleLayout();
    for (const [overrides, expectedFragment] of [
      [{ arenaCount: 3 }, 'counted 3 distinct arenas (expected exactly 1)'],
      [{ arenaInRegion: false }, 'not in the expected region'],
      [{ entranceGap: false }, 'entrance gap in the north outer wall was not confirmed'],
    ] as const) {
      chatMock.mockResolvedValue({ text: verdictReply({ ...overrides }), modelUsed: 'test-model', fallback: null });
      const verification = await verifyEncounterMap({
        layout: mapLayout,
        schematicDataUrl: 'data:image/png;base64,schematic',
        stylizedDataUrl: 'data:image/webp;base64,stylized',
        model: 'vision/model',
      });
      expect(verification.needsReview).toBe(true);
      expect(verification.report).toContain('single-arena structural verdict failed');
      expect(verification.report).toContain(expectedFragment);
      // A verdict claims no per-cell mismatches — none are fabricated.
      expect(verification.mismatchedIndexes).toEqual([]);
    }
  });

  it('repairs an invalid verdict reply exactly once', async () => {
    const mapLayout = singleLayout();
    chatMock
      .mockResolvedValueOnce({ text: 'not-json', modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: verdictReply(), modelUsed: 'test-model', fallback: null });
    const verification = await verifyEncounterMap({
      layout: mapLayout,
      schematicDataUrl: 'data:image/png;base64,schematic',
      stylizedDataUrl: 'data:image/webp;base64,stylized',
      model: 'vision/model',
      repairModel: 'fallback/vision',
    });
    expect(verification.needsReview).toBe(false);
    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(chatMock.mock.calls[0]?.[1]).toMatchObject({
      responseFormat: { kind: 'schema', name: 'arena-verdict' },
    });
    expect(chatMock.mock.calls[1]?.[0]).toHaveLength(4); // original + assistant + repair turn
    expect(chatMock.mock.calls[1]?.[1]).toMatchObject({ model: 'fallback/vision' });
  });

  it('fails loudly when the verdict repair is still invalid', async () => {
    chatMock.mockResolvedValue({ text: 'still invalid', modelUsed: 'test-model', fallback: null });
    await expect(
      verifyEncounterMap({
        layout: singleLayout(),
        schematicDataUrl: 'data:image/png;base64,a',
        stylizedDataUrl: 'data:image/webp;base64,b',
        model: 'vision/model',
      }),
    ).rejects.toThrow(/after repair/);
  });

  it('tolerates a null entranceGap when the layout has no entrance', async () => {
    const mapLayout = singleLayoutNoEntrance();
    expect(mapLayout.rooms[0]?.entrance).toBeUndefined();
    chatMock.mockResolvedValue({
      text: JSON.stringify({ arenaCount: 1, arenaInRegion: true, entranceGap: null, notes: 'one arena' }),
      modelUsed: 'test-model',
      fallback: null,
    });
    const verification = await verifyEncounterMap({
      layout: mapLayout,
      schematicDataUrl: 'data:image/png;base64,schematic',
      stylizedDataUrl: 'data:image/webp;base64,stylized',
      model: 'vision/model',
    });
    expect(verification.needsReview).toBe(false);
    expect(verification.report).toContain('no entrance described');
  });
});
