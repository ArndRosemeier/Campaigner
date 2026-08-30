import { z } from 'zod';

import { BaseEntitySchema, type BaseEntity, type Id } from '@/domain/entity';
import { statBlockSchema } from '@/domain/statblock';

/** Artifact kinds implemented in Milestone 1; the union grows in M2. */
export const ARTIFACT_KINDS = ['npc', 'location', 'faction', 'note'] as const;

export const artifactKindSchema = z.enum(ARTIFACT_KINDS);

export type ArtifactKind = z.infer<typeof artifactKindSchema>;

/** Tree section labels per kind (05-UI: "NPCs", "Locations", "Factions", "Notes"). */
export const ARTIFACT_KIND_LABELS: Readonly<Record<ArtifactKind, string>> = {
  npc: 'NPCs',
  location: 'Locations',
  faction: 'Factions',
  note: 'Notes',
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

export type ArtifactData =
  NpcArtifactData | LocationArtifactData | FactionArtifactData | NoteArtifactData;

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

export const artifactSchema = z.discriminatedUnion('kind', [
  npcArtifactSchema,
  locationArtifactSchema,
  factionArtifactSchema,
  noteArtifactSchema,
]);

export type NpcArtifact = z.infer<typeof npcArtifactSchema>;
export type LocationArtifact = z.infer<typeof locationArtifactSchema>;
export type FactionArtifact = z.infer<typeof factionArtifactSchema>;
export type NoteArtifact = z.infer<typeof noteArtifactSchema>;
export type Artifact = z.infer<typeof artifactSchema>;

/** Mutable fields of an artifact; `kind`/`campaignId`/identity are immutable. */
export interface ArtifactPatch {
  name?: string;
  tags?: string[];
  summary?: string;
  body?: string;
  links?: ArtifactLink[];
  data?: ArtifactData;
}
