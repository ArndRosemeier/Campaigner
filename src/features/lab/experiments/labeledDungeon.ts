import { z } from 'zod';

import { parseJsonReply } from '@/llm/jsonReply';
import { absentable } from '@/llm/schemas';

/**
 * The first lab bench: `labeled-dungeon-maps`. Eight hardcoded IRREGULAR
 * dungeon rooms (caves, wrecks, grown structures — never eight rectangles)
 * generated as one interconnected battlemap per image, each room marked
 * inside with a large capital letter plaque A–H; the configured chat model
 * then reads each image back and reports where it sees the letters.
 *
 * Pure logic only (prompt, contract, parsing, mapping, runner with injected
 * deps) — the React shell lives in `features/lab/`, the transport clients in
 * `features/lab/labClients.ts`. Nothing in the creation path imports this.
 */

/** One hardcoded bench room: a stable letter, a name, and a one-line visual hook. */
export interface DungeonBenchRoom {
  label: string;
  name: string;
  visualHook: string;
}

/** The eight bench rooms — irregular by construction, never rectangles. */
export const DUNGEON_BENCH_ROOMS: readonly DungeonBenchRoom[] = [
  {
    label: 'A',
    name: 'Sunken Caravel Grotto',
    visualHook: 'a shipwrecked caravel fused into a flooded grotto, broken mast piercing the ceiling',
  },
  {
    label: 'B',
    name: 'Shelf-Mushroom Rotunda',
    visualHook: 'a rotunda grown from giant shelf mushrooms under teal spore-fall',
  },
  {
    label: 'C',
    name: 'Basalt Lava Tube',
    visualHook: 'a collapsed lava tube of hexagonal basalt columns over cracked glowing obsidian',
  },
  {
    label: 'D',
    name: 'Drowned Cistern',
    visualHook: 'green-black water on stone piers around a half-submerged bell frame',
  },
  {
    label: 'E',
    name: 'Briar Warren',
    visualHook: 'a spiral of white standing stones choked in thorn-vines',
  },
  {
    label: 'F',
    name: 'Geode Dome',
    visualHook: 'a shattered crystal dome of pale amethyst clusters catching the light',
  },
  {
    label: 'G',
    name: 'Toppled Ziggurat Court',
    visualHook: 'a roofless sand-choked courtyard around a fallen colossal head stair',
  },
  {
    label: 'H',
    name: 'Ash Fissure Warren',
    visualHook: 'rope bridges spanning glowing volcanic cracks in black ash',
  },
];

/** Every bench letter, in order — the vision contract's closed vocabulary. */
export const DUNGEON_BENCH_LABELS: readonly string[] = DUNGEON_BENCH_ROOMS.map((room) => room.label);

/** How many map images one bench run generates. */
export const LABELED_DUNGEON_IMAGE_COUNT = 4;

/**
 * Builds the image-generation prompt: ONE interconnected IRREGULAR dungeon
 * containing all 8 rooms, each marked inside with its letter plaque.
 * Pure — prompt-capture tests pin its contents.
 */
export function buildLabeledDungeonPrompt(
  rooms: readonly DungeonBenchRoom[] = DUNGEON_BENCH_ROOMS,
): string {
  const roomLines = rooms.map(
    (room) => `${room.label}. ${room.name} — ${room.visualHook}.`,
  );
  return [
    'Top-down tabletop battlemap of ONE interconnected IRREGULAR dungeon complex containing ALL 8 of these rooms, linked by tunnels and passages into a single explorable whole:',
    ...roomLines,
    'Requirements: every room an IRREGULAR organic shape (caves, wrecks, grown structures — no plain rectangles); the rooms interconnect through carved tunnels, gaps, and bridges so the whole reads as one dungeon; INSIDE each room, on the floor, a LARGE clearly-legible capital letter plaque (A through H, one per room) marking that room; top-down battlemap style with a subtle grid; no monsters, no creatures, no people, and no written text anywhere except the eight letter plaques.',
  ].join('\n');
}

/** The instruction sent with each map image on the vision pass. */
export function buildDungeonVisionInstruction(): string {
  return 'This is a top-down battlemap of one interconnected dungeon whose rooms are marked inside with large capital letter plaques A through H. For EVERY plaque letter you can actually see, report its label and its position as a point in a 0–1000 normalized grid with the origin at the TOP-LEFT of the image (x grows right, y grows down). Reply with JSON only: {"marks": [{"label": "A", "x": 123, "y": 456}]}. If a letter is not visible, OMIT it — never invent coordinates for a letter you cannot see. An optional short "note" per mark may describe the plaque.';
}

/** One validated vision mark: a letter plus its 0–1000 grid point. */
export const dungeonMarkSchema = z.object({
  label: z.string().regex(/^[A-H]$/, 'label must be one capital letter A–H'),
  x: z.number().min(0).max(1000),
  y: z.number().min(0).max(1000),
  note: absentable(z.string()),
});

export type DungeonMark = z.infer<typeof dungeonMarkSchema>;

/** The vision reply contract — validated at the boundary (AGENTS rule 3). */
export const dungeonVisionReplySchema = z.object({
  marks: z.array(dungeonMarkSchema),
});

export type DungeonVisionReply = z.infer<typeof dungeonVisionReplySchema>;

/**
 * Parses one vision reply: JSON extraction (`parseJsonReply`) + the zod
 * contract. Malformed JSON or a contract violation THROWS — that image's
 * pass fails loud, and no partial disks are drawn from unparsed text.
 */
export function parseDungeonVisionReply(raw: string): DungeonVisionReply {
  return dungeonVisionReplySchema.parse(parseJsonReply(raw));
}

/**
 * Maps a 0–1000 normalized coordinate to a 0–100 CSS percent for the SVG
 * overlay. Pure — corners/center/clamp behavior pinned by unit tests.
 */
export function normToPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value / 10));
}

/** One bench map's vision outcome. A MISSING letter renders NO disk. */
export interface LabeledDungeonMapResult {
  /** In-memory data URL of the generated map (session-only, never persisted). */
  imageUrl: string;
  /** 'ok' when the vision pass parsed; 'failed' names the loud failure. */
  status: 'ok' | 'failed';
  /** Verbatim diagnosis on failure; '' on success. */
  errorMessage: string;
  /** Validated marks only — empty on failure (never partial disks). */
  marks: DungeonMark[];
  /** Bench letters with no validated mark — loud "not found" rows. */
  missing: string[];
  /** The chat model that produced the vision pass. */
  modelUsed: string;
}

/** The injected transports one bench run needs (mocked in tests). */
export interface LabeledDungeonClients {
  /** Generates the bench maps; resolves one Blob per image. */
  generateMaps: () => Promise<{ blobs: Blob[]; cappedToOne: boolean; modelUsed: string }>;
  /** One vision pass over a map data URL; resolves the RAW reply text. */
  visionPass: (imageUrl: string, imageIndex: number) => Promise<{ text: string; modelUsed: string }>;
  /** Blob → in-memory data URL (session-only images). */
  blobToDataUrl: (blob: Blob) => Promise<string>;
}

function missingLabels(marks: readonly DungeonMark[]): string[] {
  const found = new Set(marks.map((mark) => mark.label));
  return DUNGEON_BENCH_LABELS.filter((label) => !found.has(label));
}

/**
 * Runs the bench: generate N maps, then one structured vision pass per map.
 * A failed generation throws (the whole run fails loud); a failed vision
 * pass degrades PER IMAGE to a loud `failed` row — one bad pass never takes
 * down the other maps, and a configured chat model without vision input
 * fails loud per image saying so (that IS a valid test result, never a
 * silent skip).
 */
export async function runLabeledDungeonExperiment(
  clients: LabeledDungeonClients,
): Promise<LabeledDungeonMapResult[]> {
  const generated = await clients.generateMaps();
  if (generated.blobs.length === 0) {
    throw new Error('the image model returned no map images — the bench run failed');
  }
  const results: LabeledDungeonMapResult[] = [];
  for (let index = 0; index < generated.blobs.length; index += 1) {
    const blob = generated.blobs[index];
    if (blob === undefined) continue;
    const imageUrl = await clients.blobToDataUrl(blob);
    try {
      const reply = await clients.visionPass(imageUrl, index);
      const parsed = parseDungeonVisionReply(reply.text);
      // De-duplicate repeat sightings of one letter: the first validated
      // mark wins, so one plaque never draws two disks.
      const seen = new Set<string>();
      const marks = parsed.marks.filter((mark) => {
        if (seen.has(mark.label)) return false;
        seen.add(mark.label);
        return true;
      });
      results.push({
        imageUrl,
        status: 'ok',
        errorMessage: '',
        marks,
        missing: missingLabels(marks),
        modelUsed: reply.modelUsed,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        imageUrl,
        status: 'failed',
        errorMessage: message,
        marks: [],
        missing: [...DUNGEON_BENCH_LABELS],
        modelUsed: '',
      });
    }
  }
  return results;
}
