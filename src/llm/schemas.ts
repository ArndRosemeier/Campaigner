import { z } from 'zod';

import { statBlockSchema } from '@/domain/statblock';

/**
 * Draft JSON contracts (04-LLM-PERSONAS §Draft JSON contracts): what the
 * draft LLM step must return for each artifact kind. Location/Faction mirror
 * their artifact `data` fields; `body` is always markdown for the artifact.
 */

/**
 * Minimum-content contract (owner-ratified empty-text rejection): an empty
 * body never ships as a generation result, and neither do empty summary/name
 * where they carry the artifact's substance. The strict JSON schema cannot
 * express this (constraint keywords are stripped from the emitted schema),
 * so the zod parse enforces it at the boundary — a violation is a named
 * issue that rides the EXISTING one-repair turn (04 §draft step: parse
 * failure → one retry naming every problem → loud rejection), never a
 * silent pass.
 *
 * The floor is deliberately ONE non-whitespace character, not a prose
 * minimum: notes and hooks can be short, and a length floor (≥40 chars)
 * would over-reject legitimate short artifacts. Whitespace-only output is
 * the "empty text" failure mode; a short-but-real answer is not.
 */
function substanceText(label: string) {
  return z
    .string()
    .min(1)
    .refine((value) => value.trim() !== '', {
      message: `${label} is empty — it must contain at least one non-whitespace character (an empty generation is rejected, not shipped)`,
    });
}

const draftBase = {
  name: substanceText('name'),
  summary: substanceText('summary'),
  /** Models often omit tags entirely; a single string is also tolerated. */
  suggestedTags: z.preprocess(
    (value): unknown =>
      typeof value === 'string' ? [value] : (value ?? []),
    z.array(z.string()),
  ),
  /** Markdown for the artifact body. */
  body: substanceText('body'),
};

/**
 * "Absentable" optional field (strict structured outputs convention): the
 * strict JSON schema must carry EVERY key, so a formerly `.optional()` field
 * is emitted required + nullable and the model expresses "absent" as `null`.
 * The preprocessor maps `null` back to `undefined` at the boundary so the
 * parsed output — and every consumer reading it — keeps the old
 * `T | undefined` shape.
 */
export function absentable<T extends z.ZodType>(inner: T) {
  return z.preprocess((value) => (value === null ? undefined : value), inner.optional());
}

/** Models often send indexes/counts as "2"; accept numeric strings. */
const rosterIndex = z.coerce.number().int().nonnegative();

/** z.boolean() that tolerates the quoted "true"/"false" models sometimes send.
 */
export function booleanish() {
  return z.preprocess((value) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  }, z.boolean());
}

/** z.enum() that tolerates the model's capitalization ("Dungeon" → 'dungeon').
 * The `const` type parameter keeps the call-site literals, so the inferred
 * output stays the narrow member union, not `string`. */
function enumCaseInsensitive<const T extends readonly [string, ...string[]]>(values: T) {
  return z.preprocess(
    (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
    z.enum(values),
  );
}

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
  appearance: z.string(),
  personality: z.string(),
  /** The draft decides — false skips the statblock step entirely
   * (contacts/merchants/innkeepers don't need one; wasted effort). */
  needsStatBlock: booleanish(),
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
  needsStatBlock: booleanish(),
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

/**
 * Event draft: CODE-IDENTICAL to the location draft (same GM-text + image
 * shape, same coercions). Alias, not a copy, so the two contracts can never
 * drift; the run engine registers it under its own `event-draft` name.
 */
export const eventDraftSchema = locationDraftSchema;

export type EventDraft = LocationDraft;

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
      /** Mob treasure (owner-ratified): what ONE instance carries — GM
       * checklist text, '' when nothing. Optional enrichment, never a
       * rejection (the guidance-fields convention). */
      treasure: z.string().default(''),
      /** M3-B: index into the numbered stat-block excerpts of the retrieve
       * step — mapped back to a content-identity-stamped { type: 'rulebook' }
       * citation on finalize. Absentable: strict mode forces the key; `null`
       * parses to undefined. */
      sourceChunkIndex: absentable(rosterIndex),
      /** M-B (12-BESTIARY-PACKS §7): exact roster name of an imported pack
       * creature — resolved against the same roster the prompt listed. */
      sourceName: absentable(z.string()),
      /** M3-B: a full inline stat block when no rulebook excerpt matched. */
      statBlock: absentable(statBlockSchema),
    }),
  ),
  terrain: z.string(),
  tactics: z.string(),
  treasure: z.string(),
  /**
   * D10 amendment: the persona classifies WHERE the encounter takes place in
   * its existing draft call (no extra LLM call). Guides the automatic
   * battlemap's preset resolution; omitted drafts default to unclassified.
   */
  locationKind: enumCaseInsensitive(['dungeon', 'building', 'wilderness', 'other']).default(
    'other',
  ),
});

export type EncounterDraft = z.infer<typeof encounterDraftSchema>;

/**
 * Encounter Cartographer's coordinate-free design brief. Formatting
 * variants that carry the same meaning are coerced (numeric strings, a
 * missing guidance field) — `negative`/`styleNotes` are optional enrichment
 * per 07 §M3-A, never empty-required. Everything semantic (roster, rooms,
 * indexes, connectivity) stays strict and is reported as named issues.
 */
export const encounterGeneratorBriefSchema = z
  .object({
    name: substanceText('name'),
    summary: substanceText('summary'),
    body: substanceText('body'),
    difficulty: z.string(),
    levelHint: z.string(),
    terrain: z.string(),
    tactics: z.string(),
    treasure: z.string(),
    theme: z.string().min(1),
    styleNotes: z.string().default(''),
    negative: z.string().default(''),
    environment: enumCaseInsensitive(['dungeon', 'outdoor']).default('dungeon'),
    monsters: z.array(
      z.object({
        name: z.string().min(1),
        count: z.coerce.number().int().positive(),
        notes: z.string().default(''),
        /** Mob treasure (owner-ratified): what ONE instance carries — GM
         * checklist text, '' when nothing. Optional enrichment. */
        treasure: z.string().default(''),
        sourceChunkIndex: absentable(rosterIndex),
        sourceName: absentable(z.string()),
        statBlock: absentable(statBlockSchema),
      }),
    ).min(1),
    rooms: z.array(
      z.object({
        name: z.string().min(1),
        description: z.string().default(''),
        size: enumCaseInsensitive(['small', 'medium', 'large']).default('medium'),
        monsterIndexes: z.array(rosterIndex),
        adjacentRoomIndexes: z.array(rosterIndex).default([]),
        /** GM-only room key + this room's treasure checklist (one item per
         * line). Optional enrichment — '' when the brief gave none. */
        key: z.string().default(''),
        keyTreasure: z.string().default(''),
        /**
         * This room's own challenge target (docs/11 D12): the party level
         * this room ALONE should challenge. Absentable: strict mode forces
         * the key; `null` parses to undefined and the run stamps the
         * encounter's parsed levelHint instead.
         */
        targetLevel: absentable(rosterIndex),
      }),
    ).min(1).max(10),
    entryRoomIndex: rosterIndex,
  })
  .superRefine((brief, context) => {
    if (brief.entryRoomIndex >= brief.rooms.length) {
      context.addIssue({ code: 'custom', path: ['entryRoomIndex'], message: 'entry room index is outside rooms' });
    }
    // D12 amendment (fill-grade arc): a DUNGEON COMPLEX requires every room
    // to carry an explicit targetLevel — the party level that room alone
    // should challenge. A digit-free levelHint used to leave complex rooms
    // 'unverified' (advisory-only); now the missing field is a named schema
    // issue that rides the brief's EXISTING one-repair turn, then rejects
    // loudly. Single arenas stay optional (stampTargetLevels fills from the
    // level hint when present). Bounded to the VALID complex shapes (4–10):
    // a 2–3-room reply is still the D11 site-shape issue named one level up.
    if (brief.rooms.length > 3) {
      for (const [roomIndex, room] of brief.rooms.entries()) {
        if (room.targetLevel === undefined) {
          context.addIssue({
            code: 'custom',
            path: ['rooms', roomIndex, 'targetLevel'],
            message: 'a dungeon complex requires every room to carry a targetLevel (the party level this room alone should challenge)',
          });
        }
      }
    }
    for (const [roomIndex, room] of brief.rooms.entries()) {
      if (room.targetLevel !== undefined && room.targetLevel < 1) {
        context.addIssue({ code: 'custom', path: ['rooms', roomIndex, 'targetLevel'], message: 'target level must be at least 1' });
      }
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
  verdict: enumCaseInsensitive(['consistent', 'issues_found']),
  summary: z.string(),
  /** A "no issues" verdict may omit the list entirely — same meaning. */
  issues: z
    .array(
      z.object({
        severity: enumCaseInsensitive(['minor', 'major']),
        message: z.string(),
        /** Name of the artifact this conflicts with, '' when none. */
        relatedTo: z.string().default(''),
      }),
    )
    .default([]),
});

export type ContinuityReport = z.infer<typeof continuityReportSchema>;
