import { z } from 'zod';

import { BaseEntitySchema, type BaseEntity, type Id } from '@/domain/entity';
import { statBlockSchema } from '@/domain/statblock';

/** Artifact kinds; M1 shipped npc/location/faction/note, M2 adds the rest. */
export const ARTIFACT_KINDS = [
  'npc',
  'location',
  'faction',
  'note',
  'encounter',
  'plotarc',
  'session',
] as const;

export const artifactKindSchema = z.enum(ARTIFACT_KINDS);

export type ArtifactKind = z.infer<typeof artifactKindSchema>;

/** Tree section labels per kind (05-UI: "NPCs", "Locations", "Factions", "Notes"). */
export const ARTIFACT_KIND_LABELS: Readonly<Record<ArtifactKind, string>> = {
  npc: 'NPCs',
  location: 'Locations',
  faction: 'Factions',
  note: 'Notes',
  encounter: 'Encounters',
  plotarc: 'Plot Arcs',
  session: 'Sessions',
};

/** Singular labels, for badges and toasts ("NPC created"). */
export const ARTIFACT_KIND_SINGULAR: Readonly<Record<ArtifactKind, string>> = {
  npc: 'NPC',
  location: 'Location',
  faction: 'Faction',
  note: 'Note',
  encounter: 'Encounter',
  plotarc: 'Plot arc',
  session: 'Session',
};

export const artifactLinkSchema = z.object({
  targetId: z.uuid(),
  relation: z.string(),
});

export type ArtifactLink = z.infer<typeof artifactLinkSchema>;

const artifactBaseShape = {
  ...BaseEntitySchema.shape,
  campaignId: z.uuid(),
  kind: artifactKindSchema,
  name: z.string().min(1),
  tags: z.array(z.string()),
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
  kind: ArtifactKind;
  name: string;
  tags: string[];
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

export const encounterDataSchema = z.object({
  /** e.g. 'medium', 'deadly', or free text. */
  difficulty: z.string(),
  /** Party level this encounter targets. */
  levelHint: z.string(),
  monsters: z.array(
    z.object({ name: z.string(), count: z.number().int().positive(), notes: z.string() }),
  ),
  terrain: z.string(),
  tactics: z.string(),
  treasure: z.string(),
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

export const sessionDataSchema = z.object({
  /** Display label, e.g. '12' or '2025-01-31'. */
  sessionNumber: z.string(),
  recap: z.string(),
  /** Prep checklist for the next session. */
  prep: z.array(z.string()),
  /** Unresolved threads carried forward. */
  openThreads: z.array(z.string()),
});

export type SessionArtifactData = z.infer<typeof sessionDataSchema>;

export type ArtifactData =
  | NpcArtifactData
  | LocationArtifactData
  | FactionArtifactData
  | NoteArtifactData
  | EncounterArtifactData
  | PlotArcArtifactData
  | SessionArtifactData;

// --- Discriminated artifact union -------------------------------------------

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

export const sessionArtifactSchema = z.object({
  ...artifactBaseShape,
  kind: z.literal('session'),
  data: sessionDataSchema,
});

export const artifactSchema = z.discriminatedUnion('kind', [
  npcArtifactSchema,
  locationArtifactSchema,
  factionArtifactSchema,
  noteArtifactSchema,
  encounterArtifactSchema,
  plotArcArtifactSchema,
  sessionArtifactSchema,
]);

export type NpcArtifact = z.infer<typeof npcArtifactSchema>;
export type LocationArtifact = z.infer<typeof locationArtifactSchema>;
export type FactionArtifact = z.infer<typeof factionArtifactSchema>;
export type NoteArtifact = z.infer<typeof noteArtifactSchema>;
export type EncounterArtifact = z.infer<typeof encounterArtifactSchema>;
export type PlotArcArtifact = z.infer<typeof plotArcArtifactSchema>;
export type SessionArtifact = z.infer<typeof sessionArtifactSchema>;
export type Artifact = z.infer<typeof artifactSchema>;

/** Mutable fields of an artifact; `kind`/`campaignId`/identity are immutable. */
export interface ArtifactPatch {
  name?: string;
  tags?: string[];
  summary?: string;
  body?: string;
  links?: ArtifactLink[];
  data?: ArtifactData;
  /** Image gallery changes (M3-A): appends/removes references; blobs are
   * deleted by the repo when the last reference goes away. */
  imageIds?: Id[];
  coverImageId?: Id | null;
}
