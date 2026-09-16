import { z } from 'zod';

import { gameSystemSchema } from '@/domain/gameSystem';
import type { Id } from '@/domain/entity';
import type { RuleChunk } from '@/domain/rulebook';

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
 * One entry of the source's `system.damage` record, captured VERBATIM
 * (`docs/12` §15, amended by ledger 183). The BASE formula is load-bearing for
 * heightening: an `interval` spell states its improvement as a DELTA per step
 * (Fireball: base `6d6`, `heightening.damage['0'] = '2d6'`), so the delta can
 * only be applied to a base the payload actually carries. The record KEY is
 * the source's own damage id and is preserved (never renumbered) because the
 * delta is keyed by that SAME id.
 */
export const spellDamageSchema = z.object({
  formula: z.string(),
  type: z.string().default(''),
  category: z.string().nullish(),
  materials: z.array(z.string()).default([]),
});

export type SpellDamage = z.infer<typeof spellDamageSchema>;

/** The source's `system.damage` record verbatim (id → entry), order preserved. */
export const spellDamageMapSchema = z.record(z.string(), spellDamageSchema);

/**
 * The source's `system.area` verbatim (`null` when the spell has none). An
 * `interval` spell heightens its area by a NUMBER of feet per step, added to
 * `value` (Foundry `prepareBaseData`), so the base area must be stored too.
 */
export const spellAreaSchema = z.object({
  type: z.string(),
  value: z.number(),
  details: z.string().nullish(),
});

export type SpellArea = z.infer<typeof spellAreaSchema>;

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
   * The source's own `system.damage` record, verbatim (`docs/12` §15, amended
   * by ledger 183): `{}` when the spell deals none. The heightening rule ADDS
   * an interval delta to these formulas, so the numbers behind the rendered
   * text must be here — no test and no caller re-parses the stored prose.
   * `.default({})` keeps a payload written before this field readable.
   */
  damage: spellDamageMapSchema.default({}),
  /**
   * The source's own `system.area`, verbatim; `null` when the spell has none
   * (an interval spell adds its per-step area increase to `value`).
   */
  area: spellAreaSchema.nullable().default(null),
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

/**
 * THE cantrip signal of a PF2e spell: the source's own `cantrip` TRAIT.
 *
 * MEASURED against `v14-dev` (2026-09-16, docs/17 rows 181/189): the corpus
 * stores a cantrip at `system.level.value: 1` exactly like a rank-1 spell, in
 * BOTH the rules lane's spell documents and a creature's embedded `spell`
 * items, so the stored LEVEL is never the signal — the trait is. This is the
 * ONE spelling of that rule: the rules lane reads it to normalize `rank: 0`
 * for list order and to print "Cantrip", and the bestiary lane reads it to
 * stamp a cantrip with NO cast rank (docs/17 row 184's assignment contract),
 * so a future change to the signal cannot land in one lane only.
 */
export function spellTraitsAreCantrip(traits: readonly string[]): boolean {
  return traits.includes('cantrip');
}

/**
 * THE focus signal of a PF2e spell: the source's own `focus` TRAIT.
 *
 * MEASURED against `v14-dev` (2026-09-17, docs/17 row 191): upstream's
 * `SpellPF2e.isFocusSpell` is
 * `(traits.traditions.length === 0 && this.isCantrip) || traits.value.includes("focus")`
 * (`src/module/item/spell/document.ts`). The tradition-less-CANTRIP arm adds
 * nothing here: a cantrip is auto-heightened by `spellAtRank`'s cantrip arm
 * whatever its traditions, and upstream derives the SAME rank for it
 * (`clamp(ceil(actor.level / 2), 1, 10)`), so no stored value can tell the two
 * arms apart. The `focus` trait is therefore the ONE signal a NON-cantrip focus
 * spell carries, and it is read through this predicate by the bestiary importer
 * (to stamp it with NO cast rank and carry the source's fixed auto rank) and by
 * the heightening rule (to derive that rank) — one spelling, both lanes.
 */
export function spellTraitsAreFocus(traits: readonly string[]): boolean {
  return traits.includes('focus');
}

/**
 * A spell document's own name: the LAST element of its heading path (the
 * pack lane stamps the document title as the deepest heading). It is the ONE
 * spelling of "what is this spell called", shared by the spell list's rows and
 * by the mob arc's library index, so the two can never disagree about the name
 * a mob assigns.
 */
export function spellChunkName(chunk: RuleChunk): string {
  return chunk.headingPath[chunk.headingPath.length - 1]?.trim() ?? '';
}

/**
 * A validated spell-corpus entry (docs/17 row 184, docs/18 §2.1): the fields
 * every non-UI consumer needs — the mob-spell index, the prompt vocabulary and
 * the run engine's boundary. It is the SAME extraction
 * `features/spells/spell-rows.buildSpellRows` performs, minus the page-only
 * fields (origin label, display rank label) and minus the error rows: a `spell`
 * chunk without a payload or without a name is SKIPPED here, and the page that
 * must report it loudly reads `buildSpellRows` (its `data-error` rows), so a
 * corrupt row is never silent on the surface that shows the corpus. A mob that
 * assigns a corrupt row's name gets the loud unresolved-spell issue from the
 * run boundary.
 *
 * IT LIVES IN `domain/` (moved down from `features/spells/spell-rows` by row
 * 184's verification): `db/spellRepo` and `llm/runEngine` both consume it, and
 * a `db`/`llm` module importing a FEATURE is the same layering inversion as
 * importing the retrieval barrel (docs/18 §2.1). `features/spells/spell-rows`
 * re-exports it so the feature keeps its public surface.
 */
export interface SpellCorpusEntry {
  chunkId: Id;
  name: string;
  rank: number;
  cantrip: boolean;
  data: SpellData;
}

export function spellCorpusEntries(chunks: readonly RuleChunk[]): SpellCorpusEntry[] {
  const entries: SpellCorpusEntry[] = [];
  for (const chunk of chunks) {
    if (chunk.chunkType !== 'spell') continue;
    const data = chunk.spellData;
    if (data === undefined || data === null) continue;
    const name = spellChunkName(chunk);
    if (name === '') continue;
    entries.push({ chunkId: chunk.id, name, rank: data.rank, cantrip: data.cantrip, data });
  }
  return entries;
}
