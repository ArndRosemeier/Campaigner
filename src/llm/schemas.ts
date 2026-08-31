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
