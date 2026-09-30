import { z } from 'zod';

import { parseJsonReply } from '@/llm/jsonReply';
import { absentable } from '@/llm/schemas';
import type { ImageResolution } from '@/llm/imageGen';

/**
 * Lab bench: `unlabeled-dungeon-rooms`. Fifteen hardcoded irregular rooms
 * drawn as ONE high-resolution interconnected battlemap with NO letters,
 * numbers, or plaques. The configured chat model then finds chambers by
 * eye and reports each center on the 0–1000 grid.
 *
 * Pure logic only. This contract is lab-only — the production vision path
 * (`llm/visionDungeon`) locates painted A–N plaques and is not a caller
 * here, and this module does not call it. Nothing in the creation path
 * imports this file.
 */

/** One hardcoded bench room: a name and a one-line visual hook. No marker letter. */
export interface UnlabeledBenchRoom {
  name: string;
  visualHook: string;
}

/** Fifteen visually distinct chambers. Irregular by construction, never rectangles. */
export const UNLABELED_BENCH_ROOMS: readonly UnlabeledBenchRoom[] = [
  {
    name: 'Sunken Caravel Grotto',
    visualHook: 'a shipwrecked caravel fused into a flooded grotto, broken mast piercing the ceiling',
  },
  {
    name: 'Shelf-Mushroom Rotunda',
    visualHook: 'a rotunda grown from giant shelf mushrooms under teal spore-fall',
  },
  {
    name: 'Basalt Lava Tube',
    visualHook: 'a collapsed lava tube of hexagonal basalt columns over cracked glowing obsidian',
  },
  {
    name: 'Drowned Cistern',
    visualHook: 'green-black water on stone piers around a half-submerged bell frame',
  },
  {
    name: 'Briar Warren',
    visualHook: 'a spiral of white standing stones choked in thorn-vines',
  },
  {
    name: 'Geode Dome',
    visualHook: 'a shattered crystal dome of pale amethyst clusters catching the light',
  },
  {
    name: 'Toppled Ziggurat Court',
    visualHook: 'a roofless sand-choked courtyard around a fallen colossal head stair',
  },
  {
    name: 'Ash Fissure Warren',
    visualHook: 'rope bridges spanning glowing volcanic cracks in black ash',
  },
  {
    name: 'Ice-Rimed Well',
    visualHook: 'a frozen well whose hanging icicles form a pipe-organ over blue ice',
  },
  {
    name: 'Bone Ossuary Spiral',
    visualHook: 'a concentric gallery built from stacked bones around a dark central pit',
  },
  {
    name: 'Copper Pipeworks',
    visualHook: 'a rounded chamber of rusted copper pipes and leaking valves',
  },
  {
    name: 'Mirror-Shard Gallery',
    visualHook: 'walls of broken mirror mosaic leaning over a still black pool',
  },
  {
    name: 'Root-Cathedral Nave',
    visualHook: 'living tree roots woven into a vaulted nave with a dirt floor',
  },
  {
    name: 'Glass-Sand Hourglass Pit',
    visualHook: 'a funnel of pale glass sand around a buried bronze sundial',
  },
  {
    name: 'Lantern-Kelp Lagoon',
    visualHook: 'a tidal cave of bioluminescent kelp columns rising from shallow water',
  },
];

/** How many chambers the map is drawn to contain. The vision pass may report fewer. */
export const UNLABELED_DUNGEON_ROOM_COUNT = UNLABELED_BENCH_ROOMS.length;

/** One map per run — a 2K frame is the spend, not a sample of four. */
export const UNLABELED_DUNGEON_IMAGE_COUNT = 1;

/** OpenRouter tier above the provider default. Rejection fails the run loud. */
export const UNLABELED_DUNGEON_RESOLUTION: ImageResolution = '2K';

/** Wide frame so fifteen chambers are not crushed into a square. */
export const UNLABELED_DUNGEON_ASPECT = '16:9';

/**
 * Image prompt: fifteen rooms, no painted marks. Names and hooks are for
 * the image model only — the requirements line forbids rendering them as
 * text. Pure — prompt-capture tests pin the contents.
 */
export function buildUnlabeledDungeonPrompt(
  rooms: readonly UnlabeledBenchRoom[] = UNLABELED_BENCH_ROOMS,
): string {
  if (rooms.length !== UNLABELED_DUNGEON_ROOM_COUNT) {
    throw new Error(
      `The unlabeled bench draws exactly ${String(UNLABELED_DUNGEON_ROOM_COUNT)} rooms (got ${String(rooms.length)})`,
    );
  }
  const roomLines = rooms.map((room) => `${room.name} — ${room.visualHook}.`);
  return [
    `Top-down tabletop battlemap of ONE interconnected IRREGULAR dungeon complex containing ALL ${String(rooms.length)} of these rooms, linked by tunnels and passages into a single explorable whole. The rooms are UNLABELED.`,
    ...roomLines,
    'Requirements: let each room\'s shape follow its description — worked, built rooms read architectural with walls and corners, natural spaces read organic. Each room is a distinct enclosed chamber a viewer can tell apart by what is inside it, separated from its neighbors by walls or rock and joined only by narrower passages. Do not draw letters, numbers, plaques, captions, room names, or any written text anywhere on the map. Top-down battlemap style with a subtle grid; no monsters, no creatures, no people. High detail, so each chamber reads clearly.',
  ].join('\n');
}

/**
 * Vision instruction: find chambers, not plaques. The model numbers its
 * own sightings; it is not given the room catalog, so it cannot match a
 * name it cannot see.
 */
export function buildUnlabeledVisionInstruction(): string {
  return `This is a top-down battlemap of one interconnected dungeon. The rooms are NOT labeled: there are no letter plaques, numbers, captions, or written names. Find every distinct enclosed ROOM (a chamber). Do not mark corridors, tunnels, or passages as rooms. For each room you can actually see, report the visual center of that chamber as a point in a 0–1000 normalized grid with the origin at the TOP-LEFT of the image (x grows right, y grows down), a 1-based index in the order you report them, and a short "note" describing what the chamber looks like. Reply with JSON only: {"rooms": [{"index": 1, "x": 123, "y": 456, "note": "flooded shipwreck"}]}. The map was drawn as ${String(UNLABELED_DUNGEON_ROOM_COUNT)} rooms. Report only rooms you can see — if you see fewer, return fewer. Never invent a room or a coordinate for a chamber you cannot see.`;
}

/** One validated sighting: the model's own index plus a 0–1000 center. */
export const unlabeledRoomMarkSchema = z.object({
  index: z.number().int().min(1).max(99),
  x: z.number().min(0).max(1000),
  y: z.number().min(0).max(1000),
  note: absentable(z.string()),
});

export type UnlabeledRoomMark = z.infer<typeof unlabeledRoomMarkSchema>;

export const unlabeledVisionReplySchema = z.object({
  rooms: z.array(unlabeledRoomMarkSchema),
});

export type UnlabeledVisionReply = z.infer<typeof unlabeledVisionReplySchema>;

/**
 * Parses one vision reply: JSON extraction + the zod contract. Malformed
 * JSON or a contract violation THROWS — that image draws no disks.
 */
export function parseUnlabeledVisionReply(raw: string): UnlabeledVisionReply {
  return unlabeledVisionReplySchema.parse(parseJsonReply(raw));
}

/** One map's vision outcome. A count other than 15 is a result, not a parse failure. */
export interface UnlabeledDungeonMapResult {
  /** In-memory data URL (session-only, never persisted). */
  imageUrl: string;
  status: 'ok' | 'failed';
  /** Verbatim diagnosis on failure; '' on success. */
  errorMessage: string;
  /** Validated sightings, first index wins, sorted by index. Empty on failure. */
  rooms: UnlabeledRoomMark[];
  /** Sightings dropped because their index was already reported. */
  droppedDuplicates: number;
  /** Chambers the prompt asked the image model to draw. */
  expectedCount: number;
  modelUsed: string;
  resolution: ImageResolution;
  aspectRatio: string;
}

/** Injected transports (mocked in tests). */
export interface UnlabeledDungeonClients {
  generateMaps: () => Promise<{ blobs: Blob[]; cappedToOne: boolean; modelUsed: string }>;
  visionPass: (imageUrl: string, imageIndex: number) => Promise<{ text: string; modelUsed: string }>;
  blobToDataUrl: (blob: Blob) => Promise<string>;
}

function dedupeRooms(rooms: readonly UnlabeledRoomMark[]): {
  rooms: UnlabeledRoomMark[];
  droppedDuplicates: number;
} {
  const seen = new Set<number>();
  const kept: UnlabeledRoomMark[] = [];
  let droppedDuplicates = 0;
  for (const room of rooms) {
    if (seen.has(room.index)) {
      droppedDuplicates += 1;
      continue;
    }
    seen.add(room.index);
    kept.push(room);
  }
  kept.sort((left, right) => left.index - right.index);
  return { rooms: kept, droppedDuplicates };
}

/**
 * Generate the map(s), then one vision pass each. Generation that returns
 * nothing throws. A bad vision reply degrades that image to `failed` and
 * draws no disks; other maps still report.
 */
export async function runUnlabeledDungeonExperiment(
  clients: UnlabeledDungeonClients,
): Promise<UnlabeledDungeonMapResult[]> {
  const generated = await clients.generateMaps();
  if (generated.blobs.length === 0) {
    throw new Error('the image model returned no map images — the bench run failed');
  }
  const results: UnlabeledDungeonMapResult[] = [];
  for (let index = 0; index < generated.blobs.length; index += 1) {
    const blob = generated.blobs[index];
    if (blob === undefined) continue;
    const imageUrl = await clients.blobToDataUrl(blob);
    const frame = {
      imageUrl,
      expectedCount: UNLABELED_DUNGEON_ROOM_COUNT,
      resolution: UNLABELED_DUNGEON_RESOLUTION,
      aspectRatio: UNLABELED_DUNGEON_ASPECT,
    };
    try {
      const reply = await clients.visionPass(imageUrl, index);
      const parsed = parseUnlabeledVisionReply(reply.text);
      const deduped = dedupeRooms(parsed.rooms);
      results.push({
        ...frame,
        status: 'ok',
        errorMessage: '',
        rooms: deduped.rooms,
        droppedDuplicates: deduped.droppedDuplicates,
        modelUsed: reply.modelUsed,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        ...frame,
        status: 'failed',
        errorMessage: message,
        rooms: [],
        droppedDuplicates: 0,
        modelUsed: '',
      });
    }
  }
  return results;
}
