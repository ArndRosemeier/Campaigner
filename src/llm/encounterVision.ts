import { z } from 'zod';

import type { EncounterLayout } from '@/domain';
import { chat, type ChatMessage } from '@/llm/openrouter';
import { parseJsonReply } from '@/llm/jsonReply';
import { errorMessage } from '@/lib/errors';

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
  const stride = coarseStride(layout);
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

/** Coarse cells containing corridor/room openings; stylization may vary there. */
export function coarseDoorIndexes(layout: EncounterLayout): Set<number> {
  const stride = coarseStride(layout);
  const cols = Math.ceil(layout.gridW / stride);
  const roomCells = new Set<string>();
  for (const room of layout.rooms) addRects(roomCells, room.rects);
  const doors = new Set<number>();
  for (const corridor of layout.corridors) {
    const corridorCells = new Set<string>();
    addRects(corridorCells, corridor.rects);
    for (const key of corridorCells) {
      const [xText, yText] = key.split(',');
      const x = Number(xText);
      const y = Number(yText);
      const touchesRoom = [
        `${String(x + 1)},${String(y)}`,
        `${String(x - 1)},${String(y)}`,
        `${String(x)},${String(y + 1)}`,
        `${String(x)},${String(y - 1)}`,
      ].some((neighbor) => roomCells.has(neighbor));
      if (touchesRoom) {
        doors.add(Math.floor(y / stride) * cols + Math.floor(x / stride));
      }
    }
  }
  return doors;
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
  /** Optional model for the one grid-repair attempt (contract escalation —
   * the caller picks a vision-capable fallback via visionRepairModel). */
  repairModel?: string | undefined;
  signal?: AbortSignal | undefined;
  excludedIndexes?: ReadonlySet<number>;
}): Promise<EncounterMapVerification> {
  const expected = coarseStructure(input.layout);
  const isStaging = input.layout.rooms.some((room) => room.stagingPoint !== undefined);
  if (isStaging) {
    // Staging layouts use procedural dual-encoded neon marker detection.
    // They do not condition on a rigid rectangular schematic and do not
    // require an expensive cell-by-cell vision classification.
    const totalRooms = input.layout.rooms.length;
    const placedRooms = input.layout.rooms.filter((r) => r.stagingPoint !== undefined).length;
    const mismatchRatio = totalRooms > 0 ? (totalRooms - placedRooms) / totalRooms : 0;
    return {
      expected,
      actual: expected,
      mismatchRatio,
      mismatchedIndexes: [],
      needsReview: mismatchRatio > 0.5,
    };
  }
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
  let { text: raw } = await chat(messages, {
    model: input.model,
    temperature: 0,
    responseFormat: 'json',
    signal: input.signal,
  });
  let parsed = parseGrid(raw, expected);
  if (!parsed.success) {
    raw = (
      await chat(
        [
          ...messages,
          { role: 'assistant', content: raw },
          {
            role: 'user',
            content: `Your response was invalid: ${parsed.error}. Return corrected JSON only with the exact dimensions and cell count.`,
          },
        ],
        {
          // Contract repair escalates to the caller-provided repair model
          // (vision-capable fallback) when configured.
          model: input.repairModel ?? input.model,
          temperature: 0,
          responseFormat: 'json',
          signal: input.signal,
        },
      )
    ).text;
    parsed = parseGrid(raw, expected);
  }
  if (!parsed.success) throw new Error(`Vision verification failed after repair: ${parsed.error}`);
  return compareStructureGrids(
    expected,
    parsed.data,
    input.excludedIndexes ?? coarseDoorIndexes(input.layout),
  );
}

function parseGrid(
  raw: string,
  expected: StructureGrid,
): { success: true; data: StructureGrid } | { success: false; error: string } {
  try {
    const data = structureGridSchema.parse(parseJsonReply(raw));
    if (data.cols !== expected.cols || data.rows !== expected.rows) {
      return { success: false, error: 'grid dimensions do not match' };
    }
    if (data.cells.length !== expected.cells.length) {
      return { success: false, error: 'grid cell count does not match' };
    }
    return { success: true, data };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
}

function coarseStride(layout: EncounterLayout): number {
  return Math.max(2, Math.ceil(layout.gridW / 12), Math.ceil(layout.gridH / 9));
}

function addRects(cells: Set<string>, rects: readonly { x: number; y: number; w: number; h: number }[]): void {
  for (const rect of rects) {
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      for (let x = rect.x; x < rect.x + rect.w; x += 1) cells.add(`${String(x)},${String(y)}`);
    }
  }
}

export const visionMarkerLocationSchema = z.object({
  found: z.boolean(),
  x: z.number().min(0).max(1).optional(),
  y: z.number().min(0).max(1).optional(),
  notes: z.string().default(''),
});
export type VisionMarkerLocation = z.infer<typeof visionMarkerLocationSchema>;

/** Sparse vision fallback for missing markers that the procedural neon detector could not find. */
export async function locateMissingMarkerWithVision(input: {
  mapDataUrl: string;
  letter: string;
  colorName: string;
  roomName: string;
  model: string;
  signal?: AbortSignal | undefined;
}): Promise<{ found: boolean; x: number; y: number }> {
  const prompt = [
    `You are inspecting a generated top-down tabletop RPG battlemap.`,
    `We need to find the staging marker for "${input.roomName}".`,
    `Marker visual appearance: A solid neon ${input.colorName} disc on the floor with a small black plaque labeled "${input.letter}" immediately to its right.`,
    `Inspect the image and report the normalized coordinates (x, y from 0.0 to 1.0, where (0,0) is top-left and (1,1) is bottom-right) of the center of this marker disc.`,
    `Reply with JSON only: {"found": true, "x": 0.45, "y": 0.72} or {"found": false, "notes": "reason"}.`,
  ].join(' ');

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: 'You locate room staging markers on top-down RPG battlemaps. Reply with JSON only.',
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: input.mapDataUrl } },
      ],
    },
  ];

  const { text: raw } = await chat(messages, {
    model: input.model,
    temperature: 0,
    responseFormat: 'json',
    signal: input.signal,
  });

  try {
    const parsed = visionMarkerLocationSchema.parse(parseJsonReply(raw));
    if (parsed.found && parsed.x !== undefined && parsed.y !== undefined) {
      return { found: true, x: parsed.x, y: parsed.y };
    }
  } catch {
    // Best-effort enrichment only: the marker was already reported missing by
    // the deterministic detector, and "not found" is a legitimate verdict —
    // no phantom coordinates are invented from a failed parse (AGENTS rule 1).
  }
  return { found: false, x: 0.5, y: 0.5 };
}

