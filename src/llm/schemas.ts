import { z } from 'zod';

import { statBlockSchema } from '@/domain/statblock';

/**
 * Draft JSON contracts (04-LLM-PERSONAS §Draft JSON contracts): what the
 * draft LLM step must return for each artifact kind. Location/Faction mirror
 * their artifact `data` fields; `body` is always markdown for the artifact.
 */

const draftBase = {
  name: z.string().min(1),
  summary: z.string(),
  /** Models often omit tags entirely; a single string is also tolerated. */
  suggestedTags: z.preprocess(
    (value): unknown =>
      typeof value === 'string' ? [value] : (value ?? []),
    z.array(z.string()),
  ),
  /** Markdown for the artifact body. */
  body: z.string(),
};

/**
 * Models frequently return list items in a looser shape than the contract
 * (a bare string instead of {name, description}, "4" instead of 4, an object
 * inside a string list). These coercions accept the common variants so a
 * good draft isn't thrown away over formatting.
 */

/** Flattens an object item to a string (name/title/text field, else JSON). */
function itemToText(item: unknown): string {
  if (typeof item === 'string') return item;
  if (typeof item === 'number' || typeof item === 'boolean') return String(item);
  if (item !== null && typeof item === 'object') {
    const record = item as Record<string, unknown>;
    for (const key of ['name', 'title', 'text', 'description', 'message']) {
      const value = record[key];
      if (typeof value === 'string' && value !== '') return value;
    }
    return JSON.stringify(item);
  }
  return '';
}

/** z.array(z.string()) that tolerates object/number entries. */
function stringArray() {
  return z.preprocess(
    (value): unknown => (Array.isArray(value) ? value.map(itemToText) : value),
    z.array(z.string()),
  );
}

/** Array of {name|title, description}-style objects that tolerates bare strings. */
function namedItemArray(nameKey: 'name' | 'title') {
  return z.preprocess(
    (value): unknown =>
      Array.isArray(value)
        ? value.map((item: unknown) =>
            typeof item === 'string' ? { [nameKey]: item, description: '' } : item,
          )
        : value,
    z.array(z.object({ [nameKey]: z.string(), description: z.string() })),
  );
}

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
  pointsOfInterest: namedItemArray('name'),
  hooks: stringArray(),
});

export type LocationDraft = z.infer<typeof locationDraftSchema>;

export const factionDraftSchema = z.object({
  ...draftBase,
  goals: z.string(),
  methods: z.string(),
  resources: z.string(),
  ranks: namedItemArray('title'),
});

export type FactionDraft = z.infer<typeof factionDraftSchema>;

export const noteDraftSchema = z.object({
  ...draftBase,
});

export type NoteDraft = z.infer<typeof noteDraftSchema>;

/**
 * Illustrator prompt-draft contract (07-MILESTONE-3 M3-A): the checkpoint the
 * user edits instead of rerolling images. `negative` and `styleNotes` are
 * guidance fields, never empty-required.
 */
export const imagePromptDraftSchema = z.object({
  /** The image generation prompt (the main editable payload). */
  prompt: z.string().min(1),
  /** What to avoid; '' when none. */
  negative: z.string(),
  /** Free-form style guidance folded into the final prompt. */
  styleNotes: z.string(),
});

export type ImagePromptDraft = z.infer<typeof imagePromptDraftSchema>;

export const encounterDraftSchema = z.object({
  ...draftBase,
  difficulty: z.string(),
  levelHint: z.string(),
  monsters: z.array(
    z.object({
      name: z.string(),
      /** Models often send "4"; accept numeric strings. */
      count: z.coerce.number().int().positive(),
      notes: z.string(),
      /** M3-B: index into the numbered stat-block excerpts of the retrieve
       * step — mapped back to { type: 'rulebook', chunkId } on finalize. */
      sourceChunkIndex: z.number().int().nonnegative().optional(),
      /** M3-B: a full inline stat block when no rulebook excerpt matched. */
      statBlock: statBlockSchema.optional(),
    }),
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
  beats: namedItemArray('title'),
  hooks: stringArray(),
  climax: z.string(),
});

export type PlotArcDraft = z.infer<typeof plotArcDraftSchema>;

export const sessionDraftSchema = z.object({
  ...draftBase,
  sessionNumber: z.string(),
  recap: z.string(),
  prep: stringArray(),
  openThreads: stringArray(),
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
