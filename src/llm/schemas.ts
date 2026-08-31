import { z } from 'zod';

/**
 * Draft JSON contracts (04-LLM-PERSONAS §Draft JSON contracts): what the
 * draft LLM step must return for each artifact kind. Location/Faction mirror
 * their artifact `data` fields; `body` is always markdown for the artifact.
 */

const draftBase = {
  name: z.string().min(1),
  summary: z.string(),
  suggestedTags: z.array(z.string()),
  /** Markdown for the artifact body. */
  body: z.string(),
};

export const npcDraftSchema = z.object({
  ...draftBase,
  role: z.string(),
  appearance: z.string(),
  personality: z.string(),
  motivation: z.string(),
  secrets: z.string(),
  voiceNotes: z.string(),
});

export type NpcDraft = z.infer<typeof npcDraftSchema>;

export const locationDraftSchema = z.object({
  ...draftBase,
  locationType: z.string(),
  inhabitants: z.string(),
  pointsOfInterest: z.array(z.object({ name: z.string(), description: z.string() })),
  hooks: z.array(z.string()),
});

export type LocationDraft = z.infer<typeof locationDraftSchema>;

export const factionDraftSchema = z.object({
  ...draftBase,
  goals: z.string(),
  methods: z.string(),
  resources: z.string(),
  ranks: z.array(z.object({ title: z.string(), description: z.string() })),
});

export type FactionDraft = z.infer<typeof factionDraftSchema>;

export const noteDraftSchema = z.object({
  ...draftBase,
});

export type NoteDraft = z.infer<typeof noteDraftSchema>;

export const encounterDraftSchema = z.object({
  ...draftBase,
  difficulty: z.string(),
  levelHint: z.string(),
  monsters: z.array(
    z.object({ name: z.string(), count: z.number().int().positive(), notes: z.string() }),
  ),
  terrain: z.string(),
  tactics: z.string(),
  treasure: z.string(),
});

export type EncounterDraft = z.infer<typeof encounterDraftSchema>;

export const plotArcDraftSchema = z.object({
  ...draftBase,
  arcType: z.string(),
  premise: z.string(),
  stakes: z.string(),
  beats: z.array(z.object({ title: z.string(), description: z.string() })),
  hooks: z.array(z.string()),
  climax: z.string(),
});

export type PlotArcDraft = z.infer<typeof plotArcDraftSchema>;

export const sessionDraftSchema = z.object({
  ...draftBase,
  sessionNumber: z.string(),
  recap: z.string(),
  prep: z.array(z.string()),
  openThreads: z.array(z.string()),
});

export type SessionDraft = z.infer<typeof sessionDraftSchema>;

/** Continuity Editor report (06-MILESTONES M2): issues found in a target. */
export const continuityReportSchema = z.object({
  verdict: z.enum(['consistent', 'issues_found']),
  summary: z.string(),
  issues: z.array(
    z.object({
      severity: z.enum(['minor', 'major']),
      message: z.string(),
      /** Name of the artifact this conflicts with, '' when none. */
      relatedTo: z.string(),
    }),
  ),
});

export type ContinuityReport = z.infer<typeof continuityReportSchema>;
