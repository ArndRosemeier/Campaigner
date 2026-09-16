import { z } from 'zod';

import { gameSystemSchema } from '@/domain/gameSystem';

/**
 * Normalized spell payload (docs/12 §15, the spells arc): the exact,
 * validated data carried by `chunkType: 'spell'` RuleChunks, mirroring the
 * `itemData` precedent (12-BESTIARY-PACKS §13) — absent/null on every
 * non-spell chunk. The PF2e rules-text lane's own field mapping
 * (`ingest/packs/pf2e-rules.ts`) is its ONE producer: it already reads the
 * spell documents and renders rank, traditions and the cast facts into prose,
 * so this payload is that SAME mapping's structured half, never a second
 * parser.
 *
 * The stored `text` is deliberately NOT derived from this payload — the text
 * is the `contentHash` key and changing it would invalidate stored citations,
 * so the lane keeps its bytes and adds the payload beside them.
 */

/**
 * PF2e's four magical traditions, validated rather than free strings. A new
 * tradition is a one-line addition HERE (the enum is the closed vocabulary);
 * an unknown tradition in a source document fails that entry loudly instead
 * of reaching a stored row unvalidated.
 */
export const spellTraditionSchema = z.enum(['arcane', 'divine', 'occult', 'primal']);

export type SpellTradition = z.infer<typeof spellTraditionSchema>;

/**
 * The cast facts the pf2e-rules lane already extracts (docs/12 §15.3):
 * verbatim trimmed source strings, `''` when the document states none.
 */
export const spellCastSchema = z.object({
  time: z.string().default(''),
  range: z.string().default(''),
  target: z.string().default(''),
  duration: z.string().default(''),
});

export type SpellCast = z.infer<typeof spellCastSchema>;

/**
 * One heightening note parsed from a spell's RAW description HTML, in
 * document order (the next arc renders a spell at the rank a mob actually
 * casts it, so the notes are captured here rather than re-parsed later):
 * - `fixed` from `<strong>Heightened (3rd)</strong> …` (an exact rank),
 * - `increment` from `<strong>Heightened (+1)</strong> …` (an interval).
 * `text` is the note's prose, stripped by the ingest lane's ONE HTML→text
 * seam. A description that mentions Heightened in NEITHER shape is captured
 * in `heighteningUnparsed` instead — loud data, never a silent drop.
 */
export const spellHeighteningEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('fixed'),
    rank: z.number().int().positive(),
    text: z.string(),
  }),
  z.object({
    kind: z.literal('increment'),
    increment: z.number().int().positive(),
    text: z.string(),
  }),
]);

export type SpellHeighteningEntry = z.infer<typeof spellHeighteningEntrySchema>;

export const spellDataSchema = z.object({
  system: gameSystemSchema,
  /**
   * LIST-ORDER rank: a cantrip is 0, a ranked/ritual spell is the source's
   * `system.level.value`. MEASURED against `v14-dev` (2026-09-16): the source
   * stores cantrips at level 1 — both the legacy Acid Splash fixture and the
   * remastered Ignition document carry `level.value: 1` plus the `cantrip`
   * trait — so the trait is normalized to 0 here, giving a spell list ONE
   * order where cantrips lead. The companion `text` still prints the source's
   * own rendering ("Cantrip 1"), byte-identically.
   */
  rank: z.number().int().nonnegative(),
  /** True when the document is a cantrip — the `cantrip` TRAIT is the signal
   *  (the same trait `rank: 0` is derived from), never the stored level. */
  cantrip: z.boolean(),
  /** Validated traditions; source order preserved. */
  traditions: z.array(spellTraditionSchema).default([]),
  /** Verbatim `system.traits.value` (includes `cantrip` when it is one). */
  traits: z.array(z.string()).default([]),
  /** Verbatim `system.traits.rarity` ('common'…'unique'). */
  rarity: z.string().default('common'),
  /** The four cast facts, verbatim. */
  cast: spellCastSchema,
  /**
   * The source's OWN `system.heightening` object, captured verbatim and never
   * normalized into new semantics (its `levels`/`type`/`damage` shapes are the
   * Foundry system's). Nullish when the document carries none.
   */
  heightening: z.record(z.string(), z.unknown()).nullish(),
  /** Parsed heightening notes, document order; `[]` when the spell has none. */
  heighteningEntries: z.array(spellHeighteningEntrySchema).default([]),
  /**
   * Raw description line(s) that mention "Heightened" but matched NEITHER
   * shape — stored, never silently dropped (AGENTS rule 1). `[]` when nothing
   * was left unparsed.
   */
  heighteningUnparsed: z.array(z.string()).default([]),
  /**
   * Per-entry source publication (docs/12 §15.1): pf2e spell documents carry
   * `system.publication {license, remaster, title}` — the license (ORC/OGL) is
   * PRESERVED, never dropped. Nullish on pre-arc rows and non-spell chunks.
   */
  publication: z
    .object({
      title: z.string().default(''),
      license: z.string().default(''),
    })
    .nullish(),
});

export type SpellData = z.infer<typeof spellDataSchema>;
