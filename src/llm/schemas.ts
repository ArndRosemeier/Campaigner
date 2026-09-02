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
  /** M4-C: the draft decides — false skips the statblock step entirely
   * (contacts/merchants/innkeepers don't need one; wasted effort). */
  needsStatBlock: z.boolean(),
});

export type NpcDraft = z.infer<typeof npcDraftSchema>;

/**
 * PC draft (M5-A): a persona drafts the character concept/notes and may flag
 * the statblock step. Human-owned fields (playerName, currentHp,
 * initiativeOverride) are NEVER drafted — the player owns them.
 */
export const pcDraftSchema = z.object({
  ...draftBase,
  concept: z.string(),
  notes: z.string(),
  /** Same rule as NPCs: false skips the statblock step entirely. */
  needsStatBlock: z.boolean(),
});

export type PcDraft = z.infer<typeof pcDraftSchema>;

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

/** Encounter Cartographer's coordinate-free design brief. */
export const encounterGeneratorBriefSchema = z
  .object({
    name: z.string().min(1),
    summary: z.string(),
    body: z.string(),
    difficulty: z.string(),
    levelHint: z.string(),
    terrain: z.string(),
    tactics: z.string(),
    treasure: z.string(),
    theme: z.string(),
    styleNotes: z.string(),
    negative: z.string(),
    monsters: z.array(
      z.object({
        name: z.string().min(1),
        count: z.number().int().positive(),
        notes: z.string(),
        sourceChunkIndex: z.number().int().nonnegative().optional(),
        statBlock: statBlockSchema.optional(),
      }),
    ).min(1),
    rooms: z.array(
      z.object({
        name: z.string().min(1),
        description: z.string(),
        size: z.enum(['small', 'medium', 'large']),
        monsterIndexes: z.array(z.number().int().nonnegative()),
        adjacentRoomIndexes: z.array(z.number().int().nonnegative()),
      }),
    ).min(1).max(9),
    entryRoomIndex: z.number().int().nonnegative(),
  })
  .superRefine((brief, context) => {
    if (brief.entryRoomIndex >= brief.rooms.length) {
      context.addIssue({ code: 'custom', path: ['entryRoomIndex'], message: 'entry room index is outside rooms' });
    }
    for (const [roomIndex, room] of brief.rooms.entries()) {
      for (const monsterIndex of room.monsterIndexes) {
        if (monsterIndex >= brief.monsters.length) {
          context.addIssue({ code: 'custom', path: ['rooms', roomIndex, 'monsterIndexes'], message: 'monster index is outside roster' });
        }
      }
      for (const adjacent of room.adjacentRoomIndexes) {
        if (adjacent >= brief.rooms.length || adjacent === roomIndex) {
          context.addIssue({ code: 'custom', path: ['rooms', roomIndex, 'adjacentRoomIndexes'], message: 'adjacent room index is invalid' });
        }
      }
    }
  });
export type EncounterGeneratorBrief = z.infer<typeof encounterGeneratorBriefSchema>;

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
