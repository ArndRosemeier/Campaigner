import { z } from 'zod';

import { BaseEntitySchema, type BaseEntity, type Id } from '@/domain/entity';
import { sha256HexSchema } from '@/domain/rulebook';
import { statBlockSchema } from '@/domain/statblock';
import {
  encounterLayoutSchema,
  encounterLocationKindSchema,
  encounterMapModeSchema,
  encounterPresetSchema,
  encounterSiteShapeSchema,
  spawnFirstPath,
} from '@/domain/encounterMap/schema';

/** Artifact kinds; M1 shipped npc/location/faction/note, M2 adds the rest.
 * M5-A puts `pc` first — the campaign tree renders kinds in this order, and
 * the doc binds the Party group to the top of the tree. */
export const ARTIFACT_KINDS = [
  'pc',
  'npc',
  'location',
  'event',
  'faction',
  'note',
  'encounter',
  'plotarc',
] as const;

export const artifactKindSchema = z.enum(ARTIFACT_KINDS);

export type ArtifactKind = z.infer<typeof artifactKindSchema>;

/** Tree section labels per kind (05-UI: "NPCs", "Locations", "Factions", "Notes"; M5-A: "Party" on top). */
export const ARTIFACT_KIND_LABELS: Readonly<Record<ArtifactKind, string>> = {
  pc: 'Party',
  npc: 'NPCs',
  location: 'Locations',
  event: 'Events',
  faction: 'Factions',
  note: 'Notes',
  encounter: 'Encounters',
  plotarc: 'Plot Arcs',
};

/**
 * Kinds with NO per-region "remove all" action in the campaign tree (05-UI
 * §Left pane — Campaign tree). ONE constant, read by the tree (button
 * presence) AND by `artifactRepo.deleteArtifactsOfKind` (loud refusal), so
 * the exclusion is a property of the kind taxonomy instead of a scattered
 * `kind !== 'pc'` check that could drift.
 *
 * Why `pc`: the Party is AUTHORED, not generated — `removeAllGeneratedContent`
 * protects it explicitly, and the sanctioned way to take the Party is the
 * Edit-campaign "Clear workspace" hammer (docs/05 §Clear workspace).
 */
export const BULK_REMOVE_EXCLUDED_KINDS: readonly ArtifactKind[] = ['pc'];

/**
 * Kinds INVISIBLE to module creation (08 §M4-A/§M4-B/§M4-C; owner-ratified
 * rule, docs/17 row 69 — verbatim: "The creator is referring to players in
 * the party. The party should not be visible to module creation.").
 *
 * Why `pc` and not "any artifact": a PC is AUTHORED BY THE PLAYERS. Feeding
 * `pc` rows into module creation made the generator address the players by
 * name — the cast block told it to REUSE them and the name-classification
 * pass then resolved generated names back onto the players' characters, so a
 * module silently bound itself to the party. NPCs/locations/factions and the
 * rest stay visible: that reuse is the feature.
 *
 * ONE constant, mirroring `BULK_REMOVE_EXCLUDED_KINDS` — read by every
 * module-creation consumer (the shared cast block, the "existing campaign
 * entities/artifacts" prompt indexes, the name-classification candidate set
 * and every pool those resolve against) through `visibleToModuleCreation` /
 * `moduleCreationPool`, never a scattered `kind !== 'pc'` that could drift.
 *
 * Boundary (do not "fix" it): this is about ARTIFACT visibility to
 * generation, not about censoring the owner's prose — a campaign premise or a
 * module premise that names a party member is the owner's own text and stays
 * byte-identical. Party-derived LEVEL context (`partyLevelLine`) and the
 * npc-only fixed cast are not party artifacts and are untouched.
 */
export const MODULE_CREATION_EXCLUDED_KINDS: readonly ArtifactKind[] = ['pc'];

/** The ONE module-creation visibility predicate: false ⇔ this artifact must
 * never reach a module-creation prompt, index or resolution set. */
export function visibleToModuleCreation(artifact: AnyArtifact): boolean {
  return !MODULE_CREATION_EXCLUDED_KINDS.includes(artifact.kind);
}

/** The module-creation pool: the campaign/batch input list with the excluded
 * kinds removed. Idempotent — safe to apply both where a list is loaded and
 * where it is consumed. */
export function moduleCreationPool<T extends AnyArtifact>(artifacts: readonly T[]): T[] {
  return artifacts.filter(visibleToModuleCreation);
}

/** Singular labels, for badges and toasts ("NPC created"). */
export const ARTIFACT_KIND_SINGULAR: Readonly<Record<ArtifactKind, string>> = {
  pc: 'PC',
  npc: 'NPC',
  location: 'Location',
  event: 'Event',
  faction: 'Faction',
  note: 'Note',
  encounter: 'Encounter',
  plotarc: 'Plot arc',
};

export const artifactLinkSchema = z.object({
  targetId: z.uuid(),
  relation: z.string(),
});

export type ArtifactLink = z.infer<typeof artifactLinkSchema>;

const artifactBaseShape = {
  ...BaseEntitySchema.shape,
  campaignId: z.uuid(),
  /** M6-A ownership: set ⇔ the artifact belongs to that module (its home
   * campaign is still `campaignId`); null ⇔ campaign- or global-scoped.
   * Scope itself is DERIVED (artifactScope) — never a stored enum. */
  moduleId: z.uuid().nullable().default(null),
  kind: artifactKindSchema,
  name: z.string().min(1),
  tags: z.array(z.string()),
  /** Alternate names module wiki-links may resolve against (M4-A). Additive
   * `.default([])` — the v6 upgrade backfilled rows, and parse-on-read keeps
   * every historical row (and revision snapshot) valid without a migration. */
  aliases: z.array(z.string()).default([]),
  /** 1–3 sentences, shown in tree tooltips. */
  summary: z.string(),
  /** Markdown — the main free-text content. */
  body: z.string(),
  /** Outgoing links to other artifacts. */
  links: z.array(artifactLinkSchema),
  /** 1-based; every content save appends a matching revision row. */
  currentRevision: z.number().int().positive(),
  /** Referenced image blobs (images table), in gallery order (M3-A). Additive
   * `.default([])`/`.default(null)` mirror the v2 upgrade backfill, so rows
   * and revision snapshots written before M3 parse at the read boundary. */
  imageIds: z.array(z.uuid()).default([]),
  /** The artifact's cover image (thumbnail in tree/PDF), or null. */
  coverImageId: z.uuid().nullable().default(null),
  /**
   * PROVENANCE (provenance arc, docs/17 row 93): the model that WROTE this
   * artifact's text — the `modelUsed` of the chat call that served the write,
   * never a settings lookup (a fallback-served step was written by a
   * different model than the configured one; docs/18 §4).
   *
   * Additive `.default('')` — parse-on-read, NO Dexie version. `''` means NOT
   * RECORDED (every row written before the field, every hand-authored row,
   * every deterministic/seed row) and displays as NOTHING. It is never
   * backfilled, guessed or derived from current settings, and a HAND EDIT
   * keeps it: the field answers "which model wrote this", so the owner's own
   * edits must not erase the provenance of the text they edited
   * (docs/01 §Artifact, docs/18 §2.2).
   */
  writerModel: z.string().default(''),
};

/** Fields shared by every artifact kind. */
export interface ArtifactBase extends BaseEntity {
  campaignId: Id;
  /** Set ⇔ owned by that module (10-MILESTONE-6 M6-A). */
  moduleId: Id | null;
  kind: ArtifactKind;
  name: string;
  tags: string[];
  /** Alternate names module wiki-links may resolve against (M4-A). */
  aliases: string[];
  summary: string;
  body: string;
  links: ArtifactLink[];
  currentRevision: number;
  /** Referenced image blobs (images table), in gallery order (M3-A). */
  imageIds: Id[];
  /** The artifact's cover image, or null (M3-A). */
  coverImageId: Id | null;
  /** The model that wrote this artifact's text; `''` = not recorded (see
   * `artifactBaseShape.writerModel`). */
  writerModel: string;
}

// --- Kind-specific structured data -----------------------------------------

/**
 * Player character (M5-A): the human side of a battle. The battle engine
 * REQUIRES the stat block for initiative/HP — a statless PC is a loud
 * warning in the UI, never a silent placeholder.
 */
export const pcDataSchema = z.object({
  /** The human player's name; '' for GM-run PCs. */
  playerName: z.string(),
  /** Same normalized d20 shape NPCs carry; null until filled in. */
  statBlock: statBlockSchema.nullable(),
  /** Owned by the PC (not the battle): whole number, 0..maxHp. */
  currentHp: z.number().int().min(0),
  /** Extra initiative bonus on top of the dex modifier (Alert etc.); null = dex only. */
  initiativeOverride: z.number().int().nullable(),
  notes: z.string(),
});

export type PcArtifactData = z.infer<typeof pcDataSchema>;

export const npcDataSchema = z.object({
  appearance: z.string(),
  personality: z.string(),
  statBlock: statBlockSchema.nullable(),
  /**
   * Mob-artifact marker (owner-ratified mob-artifact arc): set ⇔ this npc
   * artifact is the ONE image-able artifact for a bestiary creature cited by
   * `chunkId` in this campaign (keyed by chunkId, never by name). Stats are
   * NOT duplicated here — the chunk stays the source of truth. Additive +
   * optional: old rows (and real NPCs) simply leave it unset.
   */
  monsterChunkId: z.uuid().optional(),
});

export type NpcArtifactData = z.infer<typeof npcDataSchema>;

export const locationDataSchema = z.object({
  /** 'city' | 'dungeon' | 'region' | free text. */
  locationType: z.string(),
  inhabitants: z.string(),
  pointsOfInterest: z.array(z.object({ name: z.string(), description: z.string() })),
  /** Adventure hooks anchored here. */
  hooks: z.array(z.string()),
});

export type LocationArtifactData = z.infer<typeof locationDataSchema>;

/**
 * Event (social/non-combat content): CODE-IDENTICAL to location — GM-readable
 * text + a showable image, a place for the model to put social content and
 * for the user to illustrate. Alias, not a copy, so the two shapes can never
 * drift; no event-specific fields exist.
 */
export const eventDataSchema = locationDataSchema;

export type EventArtifactData = LocationArtifactData;

export const factionDataSchema = z.object({
  goals: z.string(),
  methods: z.string(),
  resources: z.string(),
  ranks: z.array(z.object({ title: z.string(), description: z.string() })),
});

export type FactionArtifactData = z.infer<typeof factionDataSchema>;

/** Notes carry no structured data — body/tags only. */
export const noteDataSchema = z.record(z.string(), z.never());

export type NoteArtifactData = z.infer<typeof noteDataSchema>;

/**
 * Where a monster's stats come from (07-MILESTONE-3 M3-B):
 * - npc-ref: links an NPC artifact (stats live with the NPC);
 * - inline: a one-off embedded StatBlock;
 * - rulebook: an ingested statblock chunk;
 * - none: name-only entry (pre-M3 rows migrate to this).
 */
export const monsterSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('npc-ref'), artifactId: z.uuid() }),
  z.object({ type: z.literal('inline'), statBlock: statBlockSchema }),
  z.object({
    type: z.literal('rulebook'),
    chunkId: z.uuid(),
    /**
     * Mob artifact identity (owner-ratified mob-artifact arc): the ONE
     * campaign-scoped npc artifact standing in for this creature kind
     * (`data.monsterChunkId === chunkId`), stamped by finalize — or lazily
     * at seed time for encounters written before the marker existed.
     * Additive + optional: old rows parse unchanged and retro-fill at seed.
     */
    mobArtifactId: z.uuid().optional(),
    /**
     * Content identity (chunk-hash-fallback arc): SHA-256 of the cited
     * chunk's text at citation birth. `resolveMonsterEntry` falls back to a
     * content-hash lookup when the uuid misses (a re-ingest lands the same
     * bytes under a new row id), so byte-identical installs clear
     * 'missing ref'. Additive + optional: old rows parse unchanged and
     * heal at import from the v2 manifest.
     */
    contentHash: sha256HexSchema.optional(),
    /**
     * Reserved L1 creature identity (chunk-hash-fallback arc):
     * `chunk.headingPath[0]` trimmed, roster entry-name fallback — stamped
     * at citation birth for a future same-creature resolver. UNUSED by the
     * resolver in this slice (exact content-hash only): a same-creature
     * chunk under a new hash still resolves 'missing ref' by design.
     */
    creatureName: z.string().optional(),
  }),
  z.object({ type: z.literal('none') }),
]);

export type MonsterSource = z.infer<typeof monsterSourceSchema>;

export const monsterEntrySchema = z.object({
  name: z.string(),
  count: z.number().int().positive(),
  notes: z.string(),
  /**
   * Mob treasure (owner-ratified room-keys/treasure arc): what ONE instance
   * of this entry carries, as GM checklist text — one item per line, '' when
   * it carries nothing. Encounter-scoped by construction (it lives on the
   * encounter's roster entry, never on the creature-kind artifact); frozen
   * onto each seeded token at seed time for the GM token card.
   */
  treasure: z.string().default(''),
  source: monsterSourceSchema,
});

export type MonsterEntry = z.infer<typeof monsterEntrySchema>;

/**
 * Derives the additive shape fields for encounter data written before they
 * existed (docs/11 D11 + the v17 backfill; ONE derivation shared by the
 * migration, parse-on-read and backup validation so every legacy row reads
 * identically):
 *
 * - `siteShape` absent (legacy) ⇒ derived: layout null ⇒ 'single' (uploaded
 *   maps stay byte-identical in behavior); `rooms.length <= 1` ⇒ 'single'
 *   (and corridors cleared — a one-room arena has none); `rooms.length > 1`
 *   ⇒ 'complex' with `path` backfilled as the current room-array order,
 *   spawn room first when derivable.
 * - A persisted `siteShape` always wins — the owner's editor value and the
 *   generation output are never overwritten here.
 */
export function normalizeEncounterShapeData(data: EncounterShapeDataLike): EncounterShapeDataLike {
  if (data.siteShape === 'single' || data.siteShape === 'complex') return data;
  const layout = data.layout;
  if (layout === null || layout === undefined) return { ...data, siteShape: 'single' };
  // Array.isArray would narrow to `any[]` — keep the row's record shape and
  // validate each member explicitly (raw legacy rows are untrusted).
  const rawRooms: unknown = layout.rooms;
  const rooms: (Record<string, unknown> | null)[] = Array.isArray(rawRooms)
    ? (rawRooms as (Record<string, unknown> | null)[])
    : [];
  if (rooms.length <= 1) {
    return { ...data, siteShape: 'single', layout: { ...layout, corridors: [] } };
  }
  // Spawn room first "if derivable": legacy rooms carry a spawn flag; a
  // layout without one keeps the plain room-array order.
  const ids: string[] = [];
  let spawnId: string | undefined;
  for (const room of rooms) {
    if (room === null || typeof room.id !== 'string') continue;
    ids.push(room.id);
    if (room.spawn === true) spawnId = room.id;
  }
  const path = Array.isArray(layout.path) ? layout.path : spawnFirstPath(ids, spawnId);
  return {
    ...data,
    siteShape: 'complex',
    layout: { ...layout, path },
  };
}

/** Structural input of `normalizeEncounterShapeData` (raw legacy rows). */
export interface EncounterShapeDataLike {
  siteShape?: unknown;
  budgetAdvisory?: unknown;
  layout?:
    | {
        rooms?: readonly { id?: unknown; spawn?: unknown }[];
        corridors?: unknown;
        path?: unknown;
      }
    | null
    | undefined;
}

/**
 * The regeneration target's ACTUAL shape (docs/11 D12 amendment, shape-gated
 * restock): the ONE pure predicate for "is this encounter a multi-room
 * complex". It reads the parsed data's own `siteShape` — `encounterDataSchema`
 * normalizes that field at EVERY read through `normalizeEncounterShapeData`
 * (a persisted value wins; a legacy row derives it from the layout's room
 * count) and the superRefine rejects shape-inconsistent rows — so this IS the
 * D11 shape derivation, never a second room-count heuristic at a call site.
 * The Cartographer consumes it for BOTH the stocking prompt clauses and the
 * bounded-expansion gate so the prompt and the gate can never disagree; the
 * remembered `preset` keeps driving the grid tier/prose (docs/11 D10).
 */
export function encounterDataIsComplex(data: EncounterArtifactData): boolean {
  return data.siteShape === 'complex';
}

/**
 * The migration note (docs/11 D12, amended by the fill-grade arc) the v17
 * upgrade writes onto encounter rows it maps to 'complex' (legacy multi-room
 * layouts): their rooms carry no per-room challenge targets, so each is
 * roughly 1/N of the whole and may be under-budget. The FIRST battlemap
 * regeneration draws the row's `fillGrade` (draw-once; an owner-set value
 * always wins) and re-checks every room against its expected share. The
 * editor shows it verbatim via the room-keys/budget advisory block.
 */
export const LEGACY_COMPLEX_BUDGET_NOTE =
  'This encounter was written before per-room challenge budgets: each room is roughly 1/N of the whole encounter\'s strength and may be under-budget until the battlemap is regenerated. The next map generation draws this dungeon\'s fill grade (the per-room stocking share) and re-checks every room against it.';

// --- Fill grade (docs/11 D12 amendment — per-room stocking) ------------------

/** Valid `fillGrade` range: a percentage of a room's standard threat budget. */
export const FILL_GRADE_MIN = 0;
export const FILL_GRADE_MAX = 100;

/**
 * The draw distribution for `drawFillGrade` (docs/11 D12 amendment,
 * owner-ratified shape): most complexes are solid fights — ~70% of draws
 * land in the 55–90 center; ~10% draw a light room (45–55) bridging toward
 * the tail; ~10% draw a breather room (30–45); ~10% draw a spike (90–100).
 * The full range is therefore 30–100, and no draw ever plans a room at or
 * near zero — a complex of real fights is the default shape. Documented in
 * docs/11 and pinned by distribution tests (seeded RNG injection).
 */
export const FILL_GRADE_DRAW_WEIGHTS = [
  { weight: 0.1, min: 30, max: 45 }, // breather tail
  { weight: 0.1, min: 45, max: 55 }, // light
  { weight: 0.7, min: 55, max: 90 }, // center — most of the mass
  { weight: 0.1, min: 90, max: 100 }, // spike
] as const;

/**
 * Draws one `fillGrade` — the share of a standard single-encounter threat
 * budget each room of a complex should carry. PURE: the randomness is
 * injected (`random` is a Math.random-compatible source) so the
 * distribution is testable with a seeded RNG.
 *
 * Draw-once discipline (docs/11 D12 amendment): invoked only when a complex
 * layout first materializes with the field ABSENT — a value on the row
 * (owner-set or an earlier draw) is never redrawn, and a single-arena
 * outcome discards the draw (nothing persists).
 */
export function drawFillGrade(random: () => number = Math.random): number {
  const roll = random();
  if (!(roll >= 0 && roll < 1)) {
    throw new Error(`drawFillGrade: the random source produced ${String(roll)} — expected a value in [0, 1)`);
  }
  let cursor = 0;
  for (const bucket of FILL_GRADE_DRAW_WEIGHTS) {
    cursor += bucket.weight;
    if (roll < cursor) {
      const span = bucket.max - bucket.min + 1;
      return bucket.min + Math.floor(random() * span);
    }
  }
  // The weights sum to 1, so this is unreachable — a floating-point guard
  // that keeps the function total (the last bucket's upper edge).
  const last = FILL_GRADE_DRAW_WEIGHTS[FILL_GRADE_DRAW_WEIGHTS.length - 1];
  if (last === undefined) throw new Error('drawFillGrade: no draw buckets configured');
  return last.max;
}

const encounterDataShape = z.object({
  /** e.g. 'medium', 'deadly', or free text. */
  difficulty: z.string(),
  /** Party level this encounter targets. */
  levelHint: z.string(),
  monsters: z.array(monsterEntrySchema),
  terrain: z.string(),
  tactics: z.string(),
  treasure: z.string(),
  /** The designed battlemap (M5-C), set from the existing image pipeline. */
  mapImageId: z.uuid().nullable().default(null),
  /** Authoritative generated room geometry (v12); null for uploaded maps. */
  layout: encounterLayoutSchema.nullable().default(null),
  /**
   * The Dungeon preset (docs/11 D10): which grid tier the layout was
   * generated on, and the user-facing label. 'standard' default — upgrade
   * backfill (Dexie v15); a regenerate run keeps the target's preset.
   */
  preset: encounterPresetSchema.default('standard'),
  /**
   * Where the encounter takes place (docs/11 D10 amendment), classified by
   * the encounter persona's own draft call and owner-correctable in the
   * encounter editor. Drives the automatic battlemap's preset resolution —
   * explicit per-run choice > locationKind > Settings fallback. 'other' is
   * the unclassified default: legacy rows parse without a Dexie bump (the
   * additive M5-C pattern).
   */
  locationKind: encounterLocationKindSchema.default('other'),
  /**
   * The map's STYLE MODE (docs/11 natural-site mode): 'architectural' forces
   * the dungeon map contract (schematic-faithful walls, keep-structure
   * prompt), 'natural' forces the placement-only natural-site contract —
   * regardless of the brief's `environment` or the `locationKind`
   * classification. `undefined` = derive
   * (`resolveEncounterMapMode`: brief `environment: 'outdoor'` OR
   * `locationKind: 'wilderness'` ⇒ natural, else architectural) — the
   * editor's "Auto" option. Additive + optional: legacy rows parse without
   * a Dexie bump; runs never stamp it, so a re-classification re-derives.
   */
  mapMode: encounterMapModeSchema.optional(),
  /**
   * The encounter's SHAPE (docs/11 D11): 'single' = one arena (one room, no
   * corridors, no veils at seed), 'complex' = a dungeon (multi-room,
   * sequential play along the layout's path). Editor labels: "Encounter" /
   * "Dungeon". 'single' default — legacy rows parse without a Dexie bump and
   * `normalizeEncounterShapeData` (below) derives the real shape from the
   * layout at every read; the v17 backfill writes the same value into the
   * stored rows.
   */
  siteShape: encounterSiteShapeSchema.default('single'),
  /**
   * Loud per-room challenge advisory (docs/11 D12): the asymmetric budget
   * loop persists here when a room ships over its challenge band (or could
   * not be verified), and the v17 migration notes legacy multi-room rows'
   * ~1/N-strength rooms. '' = no advisory.
   */
  budgetAdvisory: z.string().default(''),
  /**
   * Per-room stocking share (docs/11 D12 amendment): the percentage of a
   * standard single-encounter threat budget each room of a COMPLEX should
   * carry — the deterministic lower bound behind `checkRoomBudget`'s
   * 'empty'/'under' verdicts and the Cartographer's roster sizing. Integer
   * 0–100. Additive + optional, NO Dexie bump: legacy rows parse with the
   * field absent; the value is DRAWN ONCE (`drawFillGrade`) when a complex
   * layout first materializes with the field absent, and an owner-set value
   * always wins (never redrawn — the mapMode-precedence pattern). Inert on
   * single sites (a quiet room is a feature there) and on pf2e (no numbers
   * ship — Paizo licensing); the field itself stays system-neutral.
   */
  fillGrade: z
    .number()
    .int()
    .min(FILL_GRADE_MIN)
    .max(FILL_GRADE_MAX)
    .optional(),
});

export const encounterDataSchema = z.preprocess(
  (data: unknown) => normalizeEncounterShapeData(data as EncounterShapeDataLike),
  encounterDataShape.superRefine((data, context) => {
    // D11 shape invariants (the shared layout schema stays shape-agnostic —
    // it is also the packer's output type). Generation enforces the stricter
    // 1-or-4–10 dichotomy at the brief boundary; here only the two hard
    // invariants bind, so grandfathered legacy complexes (2–3 rooms) parse.
    if (data.layout === null) return;
    if (data.siteShape === 'single' && data.layout.rooms.length !== 1) {
      context.addIssue({
        code: 'custom',
        message: 'a single-site encounter carries exactly one room',
      });
    }
    if (data.siteShape === 'single' && data.layout.corridors.length !== 0) {
      context.addIssue({
        code: 'custom',
        message: 'a single-site encounter carries no corridors',
      });
    }
    if (data.siteShape === 'complex' && data.layout.rooms.length < 2) {
      context.addIssue({
        code: 'custom',
        message: 'a complex (dungeon) encounter carries more than one room',
      });
    }
  }),
);

export type EncounterArtifactData = z.infer<typeof encounterDataSchema>;

export const plotArcDataSchema = z.object({
  /** 'adventure' | 'campaign' | free text. */
  arcType: z.string(),
  premise: z.string(),
  stakes: z.string(),
  /** Ordered story beats. */
  beats: z.array(z.object({ title: z.string(), description: z.string() })),
  /** Adventure hooks that pull the party into the arc. */
  hooks: z.array(z.string()),
  climax: z.string(),
});

export type PlotArcArtifactData = z.infer<typeof plotArcDataSchema>;

export type ArtifactData =
  | PcArtifactData
  | NpcArtifactData
  // Event data IS the location shape (`eventDataSchema` is the location
  // alias, so `EventArtifactData` is not a separate union member — listing it
  // would be a duplicate constituent, not a wider type).
  | LocationArtifactData
  | FactionArtifactData
  | NoteArtifactData
  | EncounterArtifactData
  | PlotArcArtifactData;

// --- Discriminated artifact union -------------------------------------------

export const pcArtifactSchema = z.object({
  ...artifactBaseShape,
  kind: z.literal('pc'),
  data: pcDataSchema,
});

export const npcArtifactSchema = z.object({
  ...artifactBaseShape,
  kind: z.literal('npc'),
  data: npcDataSchema,
});

export const locationArtifactSchema = z.object({
  ...artifactBaseShape,
  kind: z.literal('location'),
  data: locationDataSchema,
});

export const eventArtifactSchema = z.object({
  ...artifactBaseShape,
  kind: z.literal('event'),
  data: eventDataSchema,
});

export const factionArtifactSchema = z.object({
  ...artifactBaseShape,
  kind: z.literal('faction'),
  data: factionDataSchema,
});

export const noteArtifactSchema = z.object({
  ...artifactBaseShape,
  kind: z.literal('note'),
  data: noteDataSchema,
});

export const encounterArtifactSchema = z.object({
  ...artifactBaseShape,
  kind: z.literal('encounter'),
  data: encounterDataSchema,
});

export const plotArcArtifactSchema = z.object({
  ...artifactBaseShape,
  kind: z.literal('plotarc'),
  data: plotArcDataSchema,
});

export const artifactSchema = z.discriminatedUnion('kind', [
  pcArtifactSchema,
  npcArtifactSchema,
  locationArtifactSchema,
  eventArtifactSchema,
  factionArtifactSchema,
  noteArtifactSchema,
  encounterArtifactSchema,
  plotArcArtifactSchema,
]);

export type PcArtifact = z.infer<typeof pcArtifactSchema>;
export type NpcArtifact = z.infer<typeof npcArtifactSchema>;
export type LocationArtifact = z.infer<typeof locationArtifactSchema>;
export type EventArtifact = z.infer<typeof eventArtifactSchema>;
export type FactionArtifact = z.infer<typeof factionArtifactSchema>;
export type NoteArtifact = z.infer<typeof noteArtifactSchema>;
export type EncounterArtifact = z.infer<typeof encounterArtifactSchema>;
export type PlotArcArtifact = z.infer<typeof plotArcArtifactSchema>;
export type Artifact = z.infer<typeof artifactSchema>;

// --- Global artifacts (10-MILESTONE-6) ---------------------------------------

/** Kinds that may live in the shared library (D6): static descriptions with
 * nothing per-campaign accumulating on them. A global `pc` is impossible by
 * design — its current HP lives ON the artifact and would be shared across
 * campaigns; `session`/`plotarc` are per-campaign by nature; `note` stays
 * campaign-bound in v1. */
export const GLOBAL_ARTIFACT_KINDS = ['npc', 'location', 'event', 'faction', 'encounter'] as const;

export type GlobalArtifactKind = (typeof GLOBAL_ARTIFACT_KINDS)[number];

export const globalArtifactKindSchema = z.enum(GLOBAL_ARTIFACT_KINDS);

/** Global members mirror the owned ones with `campaignId: null` and
 * `moduleId: null` — the shape itself encodes the ownership invariant
 * (global ⇔ no campaign, no module), so no extra refine can drift. */
const globalBaseShape = {
  ...artifactBaseShape,
  campaignId: z.null(),
  moduleId: z.null(),
};

const globalNpcArtifactSchema = z.object({ ...globalBaseShape, kind: z.literal('npc'), data: npcDataSchema });
const globalLocationArtifactSchema = z.object({
  ...globalBaseShape,
  kind: z.literal('location'),
  data: locationDataSchema,
});
const globalEventArtifactSchema = z.object({
  ...globalBaseShape,
  kind: z.literal('event'),
  data: eventDataSchema,
});
const globalFactionArtifactSchema = z.object({
  ...globalBaseShape,
  kind: z.literal('faction'),
  data: factionDataSchema,
});
const globalEncounterArtifactSchema = z.object({
  ...globalBaseShape,
  kind: z.literal('encounter'),
  data: encounterDataSchema,
});

export const globalArtifactSchema = z.discriminatedUnion('kind', [
  globalNpcArtifactSchema,
  globalLocationArtifactSchema,
  globalEventArtifactSchema,
  globalFactionArtifactSchema,
  globalEncounterArtifactSchema,
]);

/** Parses either an owned (campaign/module) or a global artifact row — the
 * shape rejects impossible states: a global `pc`, a global with a `moduleId`,
 * a global `campaignId` on a non-library kind, or a null campaignId on an
 * owned kind. */
export const anyArtifactSchema = z.union([artifactSchema, globalArtifactSchema]);

export type GlobalArtifact = z.infer<typeof globalArtifactSchema>;
export type AnyArtifact = Artifact | GlobalArtifact;

/** The derived ownership scope (D1): never stored — computed. */
export function artifactScope(artifact: AnyArtifact): 'global' | 'campaign' | 'module' {
  if (artifact.campaignId === null) return 'global';
  return artifact.moduleId === null ? 'campaign' : 'module';
}

/**
 * The patch for a scope move (10-MILESTONE-6 M6-B/C): publishing to the
 * library nulls the campaign anchor, adopting fills it. All other fields
 * are mutable as before; `kind`/identity stay immutable.
 */
export interface ArtifactPatch {
  name?: string;
  tags?: string[];
  aliases?: string[];
  summary?: string;
  body?: string;
  links?: ArtifactLink[];
  data?: ArtifactData;
  /** Image gallery changes (M3-A): appends/removes references; blobs are
   * deleted by the repo when the last reference goes away. */
  imageIds?: Id[];
  coverImageId?: Id | null;
  /**
   * PROVENANCE (docs/17 row 93): set it ONLY when the patch itself writes
   * model-authored text — the model that wrote it. Omitting the key LEAVES
   * the recorded id alone, which is what makes a hand edit (the artifact
   * editor's autosave, a name/alias fix, an image attach) keep the
   * provenance of the text it did not write.
   */
  writerModel?: string;
  /** M6-B/C scope moves: adopt into a campaign / publish to the library. */
  campaignId?: Id | null;
  moduleId?: Id | null;
}
