import { z } from 'zod';

import type { EncounterLayout } from '@/domain';
import { chat, type ChatMessage } from '@/llm/openrouter';

export const structureCellSchema = z.enum(['floor', 'wall', 'void']);
export type StructureCell = z.infer<typeof structureCellSchema>;

export const structureGridSchema = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  cells: z.array(structureCellSchema),
});
export type StructureGrid = z.infer<typeof structureGridSchema>;

export interface EncounterMapVerification {
  expected: StructureGrid;
  actual: StructureGrid;
  mismatchedIndexes: number[];
  mismatchRatio: number;
  needsReview: boolean;
}

/** Deterministic coarse classes against which the vision response is judged. */
export function coarseStructure(layout: EncounterLayout): StructureGrid {
  const stride = Math.max(2, Math.ceil(layout.gridW / 12), Math.ceil(layout.gridH / 9));
  const cols = Math.ceil(layout.gridW / stride);
  const rows = Math.ceil(layout.gridH / stride);
  const floor = new Set<string>();
  for (const room of layout.rooms) addRects(floor, room.rects);
  for (const corridor of layout.corridors) addRects(floor, corridor.rects);
  const cells: StructureCell[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < cols; column += 1) {
      const x = Math.min(layout.gridW - 1, column * stride + Math.floor(stride / 2));
      const y = Math.min(layout.gridH - 1, row * stride + Math.floor(stride / 2));
      const key = `${String(x)},${String(y)}`;
      if (floor.has(key)) {
        cells.push('floor');
      } else {
        const besideFloor = [
          `${String(x + 1)},${String(y)}`,
          `${String(x - 1)},${String(y)}`,
          `${String(x)},${String(y + 1)}`,
          `${String(x)},${String(y - 1)}`,
        ].some((neighbor) => floor.has(neighbor));
        cells.push(besideFloor ? 'wall' : 'void');
      }
    }
  }
  return { cols, rows, cells };
}

export function compareStructureGrids(
  expected: StructureGrid,
  actual: StructureGrid,
  excludedIndexes: ReadonlySet<number> = new Set(),
  threshold = 0.12,
): EncounterMapVerification {
  const validActual = structureGridSchema.parse(actual);
  if (validActual.cols !== expected.cols || validActual.rows !== expected.rows) {
    throw new Error(
      `Vision grid dimensions ${String(validActual.cols)}×${String(validActual.rows)} do not match expected ${String(expected.cols)}×${String(expected.rows)}`,
    );
  }
  if (validActual.cells.length !== expected.cells.length) {
    throw new Error(
      `Vision grid returned ${String(validActual.cells.length)} cells; expected ${String(expected.cells.length)}`,
    );
  }
  const compared = expected.cells.flatMap((cell, index) =>
    excludedIndexes.has(index) ? [] : [{ index, mismatch: validActual.cells[index] !== cell }],
  );
  if (compared.length === 0) throw new Error('Vision comparison excluded every cell');
  const mismatchedIndexes = compared.filter((entry) => entry.mismatch).map((entry) => entry.index);
  const mismatchRatio = mismatchedIndexes.length / compared.length;
  return {
    expected,
    actual: validActual,
    mismatchedIndexes,
    mismatchRatio,
    needsReview: mismatchRatio > threshold,
  };
}

export async function verifyEncounterMap(input: {
  layout: EncounterLayout;
  schematicDataUrl: string;
  stylizedDataUrl: string;
  model: string;
  signal?: AbortSignal | undefined;
  excludedIndexes?: ReadonlySet<number>;
}): Promise<EncounterMapVerification> {
  const expected = coarseStructure(input.layout);
  const contract = `Classify the stylized map into exactly ${String(expected.cols)} columns × ${String(expected.rows)} rows. Compare it with the reference schematic. Reply with JSON only: {"cols":${String(expected.cols)},"rows":${String(expected.rows)},"cells":["floor"|"wall"|"void", ...]} in row-major order with exactly ${String(expected.cells.length)} cells. Do not infer or repair geometry.`;
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: 'You verify whether a stylized top-down battlemap preserved the supplied reference structure.',
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: contract },
        { type: 'image_url', image_url: { url: input.schematicDataUrl } },
        { type: 'image_url', image_url: { url: input.stylizedDataUrl } },
      ],
    },
  ];
  let raw = await chat(messages, {
    model: input.model,
    temperature: 0,
    responseFormat: 'json',
    signal: input.signal,
  });
  let parsed = parseGrid(raw, expected);
  if (!parsed.success) {
    raw = await chat(
      [
        ...messages,
        { role: 'assistant', content: raw },
        {
          role: 'user',
          content: `Your response was invalid: ${parsed.error}. Return corrected JSON only with the exact dimensions and cell count.`,
        },
      ],
      {
        model: input.model,
        temperature: 0,
        responseFormat: 'json',
        signal: input.signal,
      },
    );
    parsed = parseGrid(raw, expected);
  }
  if (!parsed.success) throw new Error(`Vision verification failed after repair: ${parsed.error}`);
  return compareStructureGrids(
    expected,
    parsed.data,
    input.excludedIndexes ?? new Set(),
  );
}

function parseGrid(
  raw: string,
  expected: StructureGrid,
): { success: true; data: StructureGrid } | { success: false; error: string } {
  try {
    const data = structureGridSchema.parse(JSON.parse(raw) as unknown);
    if (data.cols !== expected.cols || data.rows !== expected.rows) {
      return { success: false, error: 'grid dimensions do not match' };
    }
    if (data.cells.length !== expected.cells.length) {
      return { success: false, error: 'grid cell count does not match' };
    }
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function addRects(cells: Set<string>, rects: readonly { x: number; y: number; w: number; h: number }[]): void {
  for (const rect of rects) {
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      for (let x = rect.x; x < rect.x + rect.w; x += 1) cells.add(`${String(x)},${String(y)}`);
    }
  }
}
