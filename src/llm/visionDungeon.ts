import { z } from 'zod';

import { parseJsonReply } from '@/llm/jsonReply';
import { absentable } from '@/llm/schemas';

/**
 * The shared vision-located dungeon map machinery (docs/11 vision path),
 * generalized from the lab's labeled-dungeon bench: the bench
 * (`features/lab/experiments/labeledDungeon.ts`) is ONE caller of this
 * module's prompt builder + vision contract — never a forked copy.
 *
 * Pure logic + injected transports only (the prompt builders, the JSON point
 * schema/parse, the locate→verify orchestration with injected vision
 * passes). The run engine wires the production transports (image pipeline +
 * chat model); the lab wires its bench transports.
 */

/** One labeled room for the shared map prompt: marker letter + name + visual hook. */
export interface LabeledMapRoom {
  label: string;
  name: string;
  description: string;
  /**
   * Designates the dungeon entrance (docs/11 vision path): the brief's
   * `entryRoomIndex` room, threaded through the vision sidecar. The entry
   * room keeps its letter like every other room — this flag only tells the
   * prompt builder to draw it as the visual ingress. Optional so bench/lab
   * callers without an entry keep working (no clause when absent).
   */
  isEntry?: boolean;
}

/**
 * Marker letters in plan order: A..N. Complex rooms run 4–10 per the
 * generation-dichotomy shape clause, so N is headroom, never a second
 * vocabulary (numerals-beyond-letters are an explicit non-goal).
 */
export const MAX_LABELED_MAP_ROOMS = 14;

/** The marker letter for a room plan index (0 → 'A'). Throws past 'N'. */
export function labelForRoomIndex(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_LABELED_MAP_ROOMS) {
    throw new Error(`Room plan index ${String(index)} has no marker letter (A–N only)`);
  }
  return String.fromCharCode(65 + index);
}

/** The marker letters for a run's room count, in plan order. */
export function labelsForRoomCount(count: number): string[] {
  if (!Number.isInteger(count) || count < 1 || count > MAX_LABELED_MAP_ROOMS) {
    throw new Error(`Cannot label ${String(count)} rooms (1–${String(MAX_LABELED_MAP_ROOMS)} only)`);
  }
  return Array.from({ length: count }, (_, index) => labelForRoomIndex(index));
}

/**
 * Builds the labeled-map image prompt for ANY room list: one interconnected
 * dungeon holding every room, each marked inside with its letter plaque.
 *
 * When exactly one room carries `isEntry` (the brief's entry room, threaded
 * through the vision sidecar), the prompt renders that chamber AS the visual
 * entrance — stairs down, a cave mouth, a gate, a portal, per the dungeon
 * concept — naming the entry letter explicitly. Zero flagged rooms render no
 * entrance clause; more than one throws loud (never a silent pick).
 *
 * Owner-directed shape posture (no regular/irregular distinction or toggle
 * anywhere in the vision path): shape follows each room's description + the
 * dungeon concept naturally — worked rooms read architectural, natural ones
 * organic — because the descriptions already carry shape language. There is
 * deliberately no global shape clause to argue with the rooms.
 *
 * Pure — prompt-capture tests pin its contents.
 */
export function buildLabeledMapPrompt(
  rooms: readonly LabeledMapRoom[],
  concept: string,
  connectivity?: string,
): string {
  if (rooms.length === 0) {
    throw new Error('Cannot build a labeled map prompt with no rooms');
  }
  if (rooms.length > MAX_LABELED_MAP_ROOMS) {
    throw new Error(`Cannot label ${String(rooms.length)} rooms (A–N only)`);
  }
  if (concept.trim() === '') throw new Error('Cannot build a labeled map prompt with no dungeon concept');
  const entries = rooms.filter((room) => room.isEntry === true);
  if (entries.length > 1) {
    throw new Error(
      `Cannot build a labeled map prompt with ${String(entries.length)} entrances (${entries.map((room) => room.label).join(', ')}) — exactly one room is the way in`,
    );
  }
  const entry = entries[0];
  const first = rooms[0]?.label ?? '';
  const last = rooms[rooms.length - 1]?.label ?? '';
  const roomLines = rooms.map((room) => `Room ${room.label}: ${room.name} — ${room.description}.`);
  return [
    `Top-down tabletop battlemap of ${concept} containing ALL ${String(rooms.length)} of these rooms, linked by tunnels and passages into a single explorable whole:`,
    ...roomLines,
    ...(entry === undefined
      ? []
      : [`Room ${entry.label} is the dungeon entrance — the party's way in: draw it AS a visual entrance (stairs descending, a cave mouth, a gate, or a portal to suit the ${concept}), plaque included.`]),
    ...(connectivity === undefined || connectivity.trim() === '' ? [] : [`Rooms connect: ${connectivity}.`]),
    `Requirements: let each room's shape follow its description and the dungeon concept — worked, built rooms read architectural with walls and corners, natural spaces read organic; there is no single global shape rule. INSIDE each room, on the floor, a LARGE clearly-legible capital letter plaque (${first} through ${last}, one per room), engraved or carved into the floor, marking that room; top-down battlemap style with a subtle grid; no monsters, no creatures, no people, and no written text anywhere except the ${String(rooms.length)} letter plaques.`,
  ].join('\n');
}

/**
 * The instruction sent with a map image on a vision pass: report every
 * plaque letter actually SEEN as a 0–1000 point (origin top-left). A letter
 * that is not visible is OMITTED — never invented (AGENTS rule 1).
 */
export function buildVisionLocateInstruction(labels: readonly string[]): string {
  if (labels.length === 0) throw new Error('Cannot build a vision instruction with no labels');
  const first = labels[0] ?? '';
  const last = labels[labels.length - 1] ?? '';
  return `This is a top-down battlemap of one interconnected dungeon whose rooms are marked inside with large capital letter plaques ${first} through ${last}. For EVERY plaque letter you can actually see, report its label and its position as a point in a 0–1000 normalized grid with the origin at the TOP-LEFT of the image (x grows right, y grows down). Reply with JSON only: {"marks": [{"label": "${first}", "x": 123, "y": 456}]}. If a letter is not visible, OMIT it — never invent coordinates for a letter you cannot see. An optional short "note" per mark may describe the plaque.`;
}

/**
 * The focused re-ask instruction for the verify step's misses: ONLY the
 * missing plaques, with the already-found points as context (orientation,
 * not answers to change).
 */
export function buildVisionRelocateInstruction(
  missing: readonly string[],
  found: readonly { label: string; x: number; y: number }[],
): string {
  if (missing.length === 0) throw new Error('Cannot build a re-ask instruction with no missing labels');
  const context = found.length === 0
    ? 'No plaques were located on the first pass.'
    : `Already located (context only — do not change these): ${found.map((mark) => `${mark.label} at (${String(mark.x)}, ${String(mark.y)})`).join(', ')}.`;
  return `This is the SAME battlemap as before. You missed these room plaques: ${missing.join(', ')}. Look again carefully — report ONLY the missing letters, each as a point in the same 0–1000 normalized grid with the origin at the TOP-LEFT of the image (x grows right, y grows down). Reply with JSON only: {"marks": [{"label": "${missing[0] ?? ''}", "x": 123, "y": 456}]}. ${context} If a missing letter is truly not visible, OMIT it — never invent coordinates for a letter you cannot see.`;
}

/** One validated vision mark: a letter plus its 0–1000 grid point. */
export const visionLabelMarkSchema = z.object({
  label: z.string().regex(/^[A-N]$/, 'label must be one capital letter A–N'),
  x: z.number().min(0).max(1000),
  y: z.number().min(0).max(1000),
  note: absentable(z.string()),
});

export type VisionLabelMark = z.infer<typeof visionLabelMarkSchema>;

/** The vision reply contract — validated at the boundary (AGENTS rule 3). */
export const visionLocateReplySchema = z.object({
  marks: z.array(visionLabelMarkSchema),
});

export type VisionLocateReply = z.infer<typeof visionLocateReplySchema>;

/**
 * Parses one vision reply: JSON extraction (`parseJsonReply`) + the zod
 * contract. Malformed JSON or a contract violation THROWS — the pass fails
 * loud, and no partial points are read from unparsed text.
 */
export function parseVisionLocateReply(raw: string): VisionLocateReply {
  return visionLocateReplySchema.parse(parseJsonReply(raw));
}

/**
 * A still-missing plaque after the focused re-ask: the MAP STEP fails loud
 * naming the letters (never an invented/defaulted coordinate — AGENTS
 * rule 1: a wrong spawn breaks playability silently).
 */
export class VisionLocateError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(
      `The vision model could not locate room plaque${missing.length === 1 ? '' : 's'} ${missing.join(', ')} on the generated map — even after a focused re-ask. No coordinates were invented; regenerate the map to try again.`,
    );
    this.name = 'VisionLocateError';
    this.missing = missing;
  }
}

/** The injected vision transport one locate needs (mocked in tests). */
export interface VisionLocateClients {
  /** One structured vision pass over a map data URL; resolves RAW reply text. */
  visionPass: (imageDataUrl: string, instruction: string) => Promise<{ text: string }>;
}

/**
 * Locate → verify (docs/11 vision path): one structured vision pass over the
 * labeled map, then the count check (exactly one point per letter) with a
 * focused re-ask per miss ("only label D", found points as context). Still
 * missing afterwards ⇒ throws `VisionLocateError` — the map step fails
 * loud, NOTHING is persisted or invented. De-duplicate repeat sightings:
 * the first validated mark per letter wins.
 */
export async function locateDungeonLabels(
  clients: VisionLocateClients,
  args: { imageDataUrl: string; labels: readonly string[] },
): Promise<VisionLabelMark[]> {
  if (args.labels.length === 0) throw new Error('Cannot locate dungeon labels with no labels');
  const seen = new Map<string, VisionLabelMark>();
  const first = parseVisionLocateReply(
    (await clients.visionPass(args.imageDataUrl, buildVisionLocateInstruction(args.labels))).text,
  );
  for (const mark of first.marks) {
    if (args.labels.includes(mark.label) && !seen.has(mark.label)) seen.set(mark.label, mark);
  }
  const missing = args.labels.filter((label) => !seen.has(label));
  if (missing.length === 0) return marksInLabelOrder(args.labels, seen);
  const second = parseVisionLocateReply(
    (
      await clients.visionPass(
        args.imageDataUrl,
        buildVisionRelocateInstruction(missing, [...seen.values()]),
      )
    ).text,
  );
  for (const mark of second.marks) {
    if (missing.includes(mark.label) && !seen.has(mark.label)) seen.set(mark.label, mark);
  }
  const stillMissing = args.labels.filter((label) => !seen.has(label));
  if (stillMissing.length > 0) throw new VisionLocateError(stillMissing);
  return marksInLabelOrder(args.labels, seen);
}

/**
 * Marks in the caller's label order. Every label was just verified present
 * (or the miss threw above) — the guard below is the loud invariant, never
 * a defaulted coordinate.
 */
function marksInLabelOrder(
  labels: readonly string[],
  seen: ReadonlyMap<string, VisionLabelMark>,
): VisionLabelMark[] {
  return labels.map((label) => {
    const mark = seen.get(label);
    if (mark === undefined) throw new VisionLocateError([label]);
    return mark;
  });
}
