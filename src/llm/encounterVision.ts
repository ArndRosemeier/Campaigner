import { z } from 'zod';

import { entranceOutwardCell, type EncounterLayout, type LayoutRect } from '@/domain';
import { absentable, booleanish } from '@/llm/schemas';
import { chat, type ChatMessage } from '@/llm/openrouter';
import { parseJsonReply } from '@/llm/jsonReply';
import { schemaResponseFormat } from '@/llm/strictSchema';
import { errorMessage } from '@/lib/errors';

export const structureCellSchema = z.enum(['floor', 'wall', 'void']);
export type StructureCell = z.infer<typeof structureCellSchema>;

export const structureGridSchema = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  cells: z.array(structureCellSchema),
});
export type StructureGrid = z.infer<typeof structureGridSchema>;

/**
 * needs_review threshold for the COMPLEX branch's per-cell grading: the
 * mismatch ratio of graded (non-excluded) coarse cells above which the
 * candidate is flagged. Single-arena sites do not use this ratio — see
 * `verifySingleArena` for why (docs/11 §verify).
 */
export const STRUCTURE_REVIEW_THRESHOLD = 0.12;

export interface EncounterMapVerification {
  expected: StructureGrid;
  actual: StructureGrid;
  mismatchedIndexes: number[];
  mismatchRatio: number;
  needsReview: boolean;
  /**
   * Named, debuggable outcome: WHAT failed (or passed) and by how much —
   * graded-cell counts against the allowance for the complex branch, the
   * failed verdict reasons for single-arena sites. Composed verbatim into
   * the auto-run failure error and shown in the pick UI.
   */
  report: string;
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

/**
 * Coarse cells covered by the entrance gap and its outward neighbor
 * (entrance/exit spawn zones, doc 11): the schematic paints a floor-colored
 * opening and landing pad there, so stylization may vary — the same
 * tolerance door cells get.
 */
export function coarseEntranceIndexes(layout: EncounterLayout): Set<number> {
  const stride = coarseStride(layout);
  const cols = Math.ceil(layout.gridW / stride);
  const cells: { x: number; y: number }[] = [];
  for (const room of layout.rooms) {
    const entrance = room.entrance;
    if (entrance === undefined) continue;
    cells.push({ x: entrance.x, y: entrance.y });
    const outward = entranceOutwardCell(entrance);
    if (outward.x >= 0 && outward.y >= 0 && outward.x < layout.gridW && outward.y < layout.gridH) {
      cells.push(outward);
    }
  }
  const indexes = new Set<number>();
  for (const cell of cells) {
    indexes.add(Math.floor(cell.y / stride) * cols + Math.floor(cell.x / stride));
  }
  return indexes;
}

/** Excluded coarse cells: door openings plus the entrance opening. */
export function coarseDriftTolerances(layout: EncounterLayout): Set<number> {
  const indexes = coarseDoorIndexes(layout);
  for (const index of coarseEntranceIndexes(layout)) indexes.add(index);
  return indexes;
}

export function compareStructureGrids(
  expected: StructureGrid,
  actual: StructureGrid,
  excludedIndexes: ReadonlySet<number> = new Set(),
  threshold: number = STRUCTURE_REVIEW_THRESHOLD,
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
  const needsReview = mismatchRatio > threshold;
  return {
    expected,
    actual: validActual,
    mismatchedIndexes,
    mismatchRatio,
    needsReview,
    report: gridReport(mismatchedIndexes.length, compared.length, excludedIndexes.size, threshold, needsReview),
  };
}

/**
 * The named threshold semantics (the owner debuggability requirement): WHAT
 * mismatched and by how much, against a COUNTED allowance — not a bare
 * "failed threshold".
 */
function gridReport(
  mismatched: number,
  compared: number,
  excluded: number,
  threshold: number,
  needsReview: boolean,
): string {
  const allowance = Math.floor(compared * threshold);
  const scope =
    excluded === 0
      ? 'no cells excluded'
      : `${String(excluded)} excluded cell${excluded === 1 ? '' : 's'} (door/entrance openings)`;
  const counts = `${String(mismatched)} of ${String(compared)} graded cells ${needsReview ? 'mismatched the layout' : 'mismatched'} (allowance ${String(allowance)} = ${String(Math.round(threshold * 100))}% of graded cells; ${scope})`;
  return needsReview
    ? `structure verification: ${counts}`
    : `structure verification: ${counts} — within tolerance`;
}

/**
 * The single-arena verdict contract: the vision model counts the distinct
 * floor regions, locates the main arena against the layout's stated region
 * and confirms the entrance opening. Coarse QUESTIONS, not per-cell
 * classification — a single room on a 24×18 grid grades ~88% 'void'
 * periphery under the cell contract, which no honest reading of a walled
 * arena can match (docs/11 §verify).
 */
export const arenaVerdictSchema = z.object({
  arenaCount: z.coerce.number().int().min(0).max(9),
  arenaInRegion: booleanish(),
  entranceGap: absentable(booleanish()),
  notes: z.string().default(''),
});
export type ArenaVerdict = z.infer<typeof arenaVerdictSchema>;

const VERIFY_SYSTEM_MESSAGE =
  'You verify whether a stylized top-down battlemap preserved the supplied reference structure.';

export async function verifyEncounterMap(input: {
  layout: EncounterLayout;
  schematicDataUrl: string;
  stylizedDataUrl: string;
  model: string;
  /** Optional model for the one repair attempt (contract escalation —
   * the caller picks a vision-capable fallback via visionRepairModel). */
  repairModel?: string | undefined;
  signal?: AbortSignal | undefined;
  excludedIndexes?: ReadonlySet<number>;
}): Promise<EncounterMapVerification> {
  const expected = coarseStructure(input.layout);
  return input.layout.rooms.length === 1
    ? verifySingleArena(input, expected)
    : verifyComplex(input, expected);
}

/** COMPLEX branch: per-cell classification of the coarse grid (unchanged
 * grading; the prompt now anchors the model structurally and defines the
 * class semantics so the void periphery is judged consistently). */
async function verifyComplex(
  input: Parameters<typeof verifyEncounterMap>[0],
  expected: StructureGrid,
): Promise<EncounterMapVerification> {
  const layout = input.layout;
  const stride = coarseStride(layout);
  const roomDescriptions = layout.rooms
    .map((room) => {
      const span = coarseSpan(room.rects, stride);
      return `Room '${room.name}' spans roughly coarse columns ${String(span.colMin)}–${String(span.colMax)} and rows ${String(span.rowMin)}–${String(span.rowMax)}`;
    })
    .join('; ');
  const entrance = layout.rooms.find((room) => room.entrance !== undefined)?.entrance;
  const entranceLine =
    entrance === undefined
      ? ''
      : ` The entry room has one entrance: a gap in its outer wall on the ${entrance.side} side.`;
  const corridorCount = layout.corridors.length;
  const contract = `The layout is a multi-room complex: ${String(layout.rooms.length)} rooms joined by ${String(corridorCount)} corridor${corridorCount === 1 ? '' : 's'} on a ${String(expected.cols)}×${String(expected.rows)} coarse grid. ${roomDescriptions}.${entranceLine} Classify each coarse cell of the STYLIZED map: "floor" — open walkable surface inside rooms and corridors; "wall" — solid structural barrier belonging to the mapped structure; "void" — everything beyond the mapped structure (the surrounding frame: darkness, cliffs, water or empty margin). Compare it with the reference schematic. Reply with JSON only: {"cols":${String(expected.cols)},"rows":${String(expected.rows)},"cells":["floor"|"wall"|"void", ...]} in row-major order with exactly ${String(expected.cells.length)} cells. Do not infer or repair geometry.`;
  const messages: ChatMessage[] = [
    { role: 'system', content: VERIFY_SYSTEM_MESSAGE },
    {
      role: 'user',
      content: [
        { type: 'text', text: contract },
        { type: 'image_url', image_url: { url: input.schematicDataUrl } },
        { type: 'image_url', image_url: { url: input.stylizedDataUrl } },
      ],
    },
  ];
  // Strict structured outputs (owner decision): the grid shape (cols/rows/
  // cells, enum members) is enforced token-level; the SEMANTIC checks below
  // (dimension equality with the expected grid, cell count) still apply and
  // still route to the vision repair model when they fail.
  const responseFormat = schemaResponseFormat('structure-grid', structureGridSchema);
  let { text: raw } = await chat(messages, {
    model: input.model,
    temperature: 0,
    responseFormat,
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
          responseFormat,
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
    input.excludedIndexes ?? coarseDriftTolerances(layout),
  );
}

/** SINGLE-ARENA branch: the layout has one room and no corridors, so there
 * is no multi-room structure for a coarse grid to measure — a single room on
 * the standard 24×18 tier grades ~88% of the grid as 'void' periphery, and
 * any honest reading of a stylized walled arena (frame = wall or terrain)
 * mismatches far above the 12% threshold. The check therefore asks coarse,
 * decidable questions instead: exactly one arena, in the packed room's
 * approximate region, with the entrance opening present. No painted
 * markers/plaques/letters are referenced — the entrance is judged as a GAP
 * in the wall (the schematic paints it; the stylize prompt preserves it). */
async function verifySingleArena(
  input: Parameters<typeof verifyEncounterMap>[0],
  expected: StructureGrid,
): Promise<EncounterMapVerification> {
  const layout = input.layout;
  const room = layout.rooms[0];
  if (room === undefined) throw new Error('Single-arena layout has no room');
  const stride = coarseStride(layout);
  const span = coarseSpan(room.rects, stride);
  const region = `coarse columns ${String(span.colMin)}–${String(span.colMax)} of ${String(expected.cols)} (left→right) and rows ${String(span.rowMin)}–${String(span.rowMax)} of ${String(expected.rows)} (top→bottom)`;
  const entrance = layout.rooms.find((candidate) => candidate.entrance !== undefined)?.entrance;
  const entranceLine =
    entrance === undefined
      ? ''
      : ` The party enters through one gap in the arena's outer wall on the ${entrance.side} side, coming from outside the arena.`;
  const contract = `The layout is a SINGLE-ARENA encounter: exactly one open floor region (one arena), and everything beyond it is outside the play area. The arena's floor sits roughly in ${region}.${entranceLine} Compare the stylized map with the reference schematic and answer: "arenaCount" — how many DISTINCT enclosed floor regions (areas separated by walls, water or darkness) the stylized map shows; "arenaInRegion" — whether the stylized map's main arena sits in the approximate region stated above; "entranceGap" — whether the described entrance opening is present in the arena's outer wall (null when no entrance was described); "notes" — one short sentence on what you see. Reply with JSON only: {"arenaCount":<number>,"arenaInRegion":true|false,"entranceGap":true|false|null,"notes":"..."}. Do not infer or repair geometry.`;
  const messages: ChatMessage[] = [
    { role: 'system', content: VERIFY_SYSTEM_MESSAGE },
    {
      role: 'user',
      content: [
        { type: 'text', text: contract },
        { type: 'image_url', image_url: { url: input.schematicDataUrl } },
        { type: 'image_url', image_url: { url: input.stylizedDataUrl } },
      ],
    },
  ];
  const responseFormat = schemaResponseFormat('arena-verdict', arenaVerdictSchema);
  let { text: raw } = await chat(messages, {
    model: input.model,
    temperature: 0,
    responseFormat,
    signal: input.signal,
  });
  let parsed = parseVerdict(raw);
  if (!parsed.success) {
    raw = (
      await chat(
        [
          ...messages,
          { role: 'assistant', content: raw },
          {
            role: 'user',
            content: `Your response was invalid: ${parsed.error}. Return corrected JSON only with the keys arenaCount, arenaInRegion, entranceGap and notes.`,
          },
        ],
        {
          model: input.repairModel ?? input.model,
          temperature: 0,
          responseFormat,
          signal: input.signal,
        },
      )
    ).text;
    parsed = parseVerdict(raw);
  }
  if (!parsed.success) throw new Error(`Vision verification failed after repair: ${parsed.error}`);
  return judgeArenaVerdict(layout, region, parsed.data);
}

/** Deterministic verdict over the vision reply: every failed expectation is
 * NAMED in the report (the owner debuggability requirement). The grid fields
 * carry the expected coarse shape for the pick UI; a verdict claims no
 * per-cell mismatches, so `mismatchedIndexes` stays empty and the ratio is 0
 * (pass) or 1 (the structural contract failed as a whole). */
function judgeArenaVerdict(
  layout: EncounterLayout,
  region: string,
  verdict: ArenaVerdict,
): EncounterMapVerification {
  const reasons: string[] = [];
  if (verdict.arenaCount !== 1) {
    reasons.push(`the reply counted ${String(verdict.arenaCount)} distinct arenas (expected exactly 1)`);
  }
  if (!verdict.arenaInRegion) {
    reasons.push(`the main arena is not in the expected region (${region})`);
  }
  const entrance = layout.rooms.find((candidate) => candidate.entrance !== undefined)?.entrance;
  if (entrance !== undefined && verdict.entranceGap !== true) {
    reasons.push(`the entrance gap in the ${entrance.side} outer wall was not confirmed`);
  }
  const notes = verdict.notes.trim() === '' ? '' : ` (vision notes: "${verdict.notes.trim().slice(0, 160)}")`;
  const expected = coarseStructure(layout);
  if (reasons.length > 0) {
    return {
      expected,
      actual: expected,
      mismatchedIndexes: [],
      mismatchRatio: 1,
      needsReview: true,
      report: `single-arena structural verdict failed: ${reasons.join('; ')}${notes}`,
    };
  }
  const entrancePhrase =
    entrance === undefined ? 'no entrance described' : `entrance gap in the ${entrance.side} wall confirmed`;
  return {
    expected,
    actual: expected,
    mismatchedIndexes: [],
    mismatchRatio: 0,
    needsReview: false,
    report: `single-arena structural verdict passed: one arena in the expected region (${region}), ${entrancePhrase}${notes}`,
  };
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

function parseVerdict(raw: string): { success: true; data: ArenaVerdict } | { success: false; error: string } {
  try {
    return { success: true, data: arenaVerdictSchema.parse(parseJsonReply(raw)) };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
}

function coarseStride(layout: EncounterLayout): number {
  return Math.max(2, Math.ceil(layout.gridW / 12), Math.ceil(layout.gridH / 9));
}

/** Coarse-column/row span of a room union (approximate region for the
 * structural prompt description — never coordinate regression). */
function coarseSpan(
  rects: readonly LayoutRect[],
  stride: number,
): { colMin: number; colMax: number; rowMin: number; rowMax: number } {
  if (rects.length === 0) throw new Error('room has no rectangles');
  const minX = Math.min(...rects.map((rect) => rect.x));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.w - 1));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.h - 1));
  return {
    colMin: Math.floor(minX / stride),
    colMax: Math.floor(maxX / stride),
    rowMin: Math.floor(minY / stride),
    rowMax: Math.floor(maxY / stride),
  };
}

function addRects(cells: Set<string>, rects: readonly { x: number; y: number; w: number; h: number }[]): void {
  for (const rect of rects) {
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      for (let x = rect.x; x < rect.x + rect.w; x += 1) cells.add(`${String(x)},${String(y)}`);
    }
  }
}
