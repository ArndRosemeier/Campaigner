import { z } from 'zod';

import { BaseEntitySchema, type BaseEntity, type Id } from '@/domain/entity';
import { statBlockSchema } from '@/domain/statblock';

/** Artifact kinds; M1 shipped npc/location/faction/note, M2 adds the rest.
 * M5-A puts `pc` first — the campaign tree renders kinds in this order, and
 * the doc binds the Party group to the top of the tree. */
export const ARTIFACT_KINDS = [
  'pc',
  'npc',
  'location',
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
  faction: 'Factions',
  note: 'Notes',
  encounter: 'Encounters',
  plotarc: 'Plot Arcs',
};

/** Singular labels, for badges and toasts ("NPC created"). */
export const ARTIFACT_KIND_SINGULAR: Readonly<Record<ArtifactKind, string>> = {
  pc: 'PC',
  npc: 'NPC',
  location: 'Location',
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
  /** Alternate names module wiki-links may resolve against (M4-A). */
  aliases: z.array(z.string()),
  /** 1–3 sentences, shown in tree tooltips. */
  summary: z.string(),
  /** Markdown — the main free-text content. */
  body: z.string(),
  /** Outgoing links to other artifacts. */
  links: z.array(artifactLinkSchema),
  /** 1-based; every content save appends a matching revision row. */
  currentRevision: z.number().int().positive(),
  /** Referenced image blobs (images table), in gallery order (M3-A). */
  imageIds: z.array(z.uuid()),
  /** The artifact's cover image (thumbnail in tree/PDF), or null. */
  coverImageId: z.uuid().nullable(),
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
  role: z.string(),
  appearance: z.string(),
  personality: z.string(),
  motivation: z.string(),
  secrets: z.string(),
  /** How to play them at the table. */
  voiceNotes: z.string(),
  statBlock: statBlockSchema.nullable(),
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
  z.object({ type: z.literal('rulebook'), chunkId: z.uuid() }),
  z.object({ type: z.literal('none') }),
]);

export type MonsterSource = z.infer<typeof monsterSourceSchema>;

export const monsterEntrySchema = z.object({
  name: z.string(),
  count: z.number().int().positive(),
  notes: z.string(),
  source: monsterSourceSchema,
});

export type MonsterEntry = z.infer<typeof monsterEntrySchema>;

export const encounterDataSchema = z.object({
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
});

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
  factionArtifactSchema,
  noteArtifactSchema,
  encounterArtifactSchema,
  plotArcArtifactSchema,
]);

export type PcArtifact = z.infer<typeof pcArtifactSchema>;
export type NpcArtifact = z.infer<typeof npcArtifactSchema>;
export type LocationArtifact = z.infer<typeof locationArtifactSchema>;
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
export const GLOBAL_ARTIFACT_KINDS = ['npc', 'location', 'faction', 'encounter'] as const;

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
  /** M6-B/C scope moves: adopt into a campaign / publish to the library. */
  campaignId?: Id | null;
  moduleId?: Id | null;
}
