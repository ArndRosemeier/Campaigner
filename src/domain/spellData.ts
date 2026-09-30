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
 * A dnd5e spell's SCHOOL, validated against the system's OWN `CONFIG.DND5E
 * .spellSchools` keys (foundryvtt/dnd5e @ `6.0.x`, `module/config.mjs` — the
 * eight schools below, each with its `fullKey`). Stored as the SOURCE's own
 * abbreviation and rendered through `DND5E_SPELL_SCHOOL_LABELS`: an unknown
 * code fails that entry loudly at import rather than reaching a stored row
 * unvalidated (AGENTS rule 3).
 */
export const dnd5eSpellSchoolSchema = z.enum([
  'abj',
  'con',
  'div',
  'enc',
  'evo',
  'ill',
  'nec',
  'trs',
]);

export type Dnd5eSpellSchool = z.infer<typeof dnd5eSpellSchoolSchema>;

/** The system's own school codes → the printed school names (`fullKey`). */
export const DND5E_SPELL_SCHOOL_LABELS: Readonly<Record<Dnd5eSpellSchool, string>> = {
  abj: 'Abjuration',
  con: 'Conjuration',
  div: 'Divination',
  enc: 'Enchantment',
  evo: 'Evocation',
  ill: 'Illusion',
  nec: 'Necromancy',
  trs: 'Transmutation',
};

/**
 * WHICH LIST AXIS A PAYLOAD'S SPELLS CAN BE FILTERED BY (docs/12 §15, row
 * 194). The axis is a property of the SOURCE DOCUMENT, not of the UI: PF2e
 * spells carry `traits.traditions` (4 values), a dnd5e spell carries a
 * `school` (8 values), and only the adapter that read the document can know
 * which. Stamping it here is what stops the Spells page from inventing a
 * PF2e tradition for a dnd5e spell — the failure this field exists to make
 * impossible. A payload with NO axis states none (a dnd5e spell whose source
 * carries no school) and the list says so honestly instead of faking one.
 */
export const spellFilterAxisSchema = z.enum(['tradition', 'school']);

export type SpellFilterAxis = z.infer<typeof spellFilterAxisSchema>;

/**
 * One dnd5e damage PART's `scaling` block, captured VERBATIM (row 194). The
 * system's `damageScalingModes` are `whole` (add `number` dice per step) and
 * `half` (`number / 2` per step); an unstated mode (`''`, the real Magic
 * Missile document) is NO structured scaling — the entry is prose-only and
 * the heightening rule computes nothing from it.
 */
export const dnd5eDamageScalingSchema = z
  .object({
    mode: z.string().default(''),
    number: z.number().nullish(),
    formula: z.string().default(''),
  })
  .nullish();

export type Dnd5eDamageScaling = z.infer<typeof dnd5eDamageScalingSchema>;

/**
 * One dnd5e damage part (`activities.<id>.damage.parts[]`) as this payload
 * carries it. `number`/`denomination`/`bonus`/`types` are the source's own
 * fields; `formula` is the part RENDERED in the printed `NdM±K` convention
 * (the same convention the dnd5e attack lines use) so the shared spell card
 * and the resolver's `values.damage` can show it without a second renderer.
 */
export const dnd5eDamagePartSchema = z.object({
  index: z.number().int().nonnegative(),
  formula: z.string(),
  number: z.number().nullish(),
  denomination: z.number().nullish(),
  bonus: z.string().default(''),
  types: z.array(z.string()).default([]),
  scaling: dnd5eDamageScalingSchema,
});

export type Dnd5eDamagePart = z.infer<typeof dnd5eDamagePartSchema>;

/**
 * dnd5e's "At Higher Levels" / cantrip progression, captured as DATA (row
 * 194) — the dnd5e counterpart of PF2e's `heightening`, and deliberately a
 * SEPARATE field: the two systems scale on different axes (a slot level vs a
 * character level) and reusing one shape for both is exactly how a PF2e rule
 * leaks into a 5e spell.
 *
 * `baseLevel` is the source's own `system.level` (0 for a cantrip); `sentence`
 * is the document's OWN "At Higher Levels" prose, stored VERBATIM (the loud
 * `prose-only` fallback prints exactly these bytes when the structure carries
 * no numbers); `parts` are the source's damage parts with their own
 * `scaling` blocks.
 */
export const spellUpcastSchema = z.object({
  baseLevel: z.number().int().nonnegative().default(0),
  sentence: z.string().default(''),
  parts: z.array(dnd5eDamagePartSchema).default([]),
});

export type SpellUpcast = z.infer<typeof spellUpcastSchema>;

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
 * - `increment` from `<strong>Heightened (+1)</strong> …` (an interval),
 * - `note` from a bare `<strong>Heightened</strong> …` — the shape the
 *   summon-spell family writes (docs/17 row 221), where the scaling is
 *   delegated to a trait ("As listed in the … summon trait"). It names NO
 *   rank and NO interval, so NOTHING is computed from it: it carries its
 *   `text` and is printed as the source's own prose (the `prose-only`
 *   provenance in `domain/spellHeightening` is the same "we print, we do not
 *   compute" boundary).
 * `text` is the note's prose, stripped by the ingest lane's ONE HTML→text
 * seam. A description that mentions Heightened in NONE of the three shapes is
 * captured in `heighteningUnparsed` instead — loud data, never a silent drop.
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
  z.object({
    kind: z.literal('note'),
    text: z.string(),
  }),
]);

export type SpellHeighteningEntry = z.infer<typeof spellHeighteningEntrySchema>;

const spellDataObjectSchema = z.object({
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
  /**
   * The dnd5e `system.school` code, verbatim (row 194). `''` when the source
   * states none — the list then says it has no school rather than guessing
   * one. ALWAYS `''` for a PF2e spell, whose schools the system does not have.
   */
  school: z.union([dnd5eSpellSchoolSchema, z.literal('')]).default(''),
  /**
   * Which list axis this payload's spells support (row 194) — stamped by the
   * adapter that READ the document, so the Spells page never has to infer it.
   * `null` for a legacy/payload-less row written before this arc, which the
   * list renders as "no filter axis" without inventing one.
   */
  filterAxis: spellFilterAxisSchema.nullish(),
  /**
   * The dnd5e `system.properties` (casting components, verbatim: `vocal`,
   * `somatic`, `material`, `concentration`, `ritual`). PF2e carries its own
   * vocabulary in `traits`; these are the same kind of source-stated facts.
   */
  properties: z.array(z.string()).default([]),
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
  /**
   * The dnd5e "At Higher Levels" / cantrip progression, captured as data (row
   * 194). Nullish for a PF2e spell (which carries `heightening` instead) and
   * for any row written before this arc — the resolver then refuses to
   * compute a 5e upcast rather than inventing one.
   */
  upcast: spellUpcastSchema.nullish(),
  /** Parsed heightening notes, document order; `[]` when the spell has none. */
  heighteningEntries: z.array(spellHeighteningEntrySchema).default([]),
  /**
   * Description line(s) that mention "Heightened" but matched NONE of the
   * three shapes — stored, never silently dropped (AGENTS rule 1). Each line
   * is stripped by the SAME ingest HTML→text seam as every other stored
   * string here, so it is PLAIN PROSE: no markup and no `@UUID[…]` notation
   * ever reaches a GM through it (docs/17 row 221). `[]` when nothing was
   * left unparsed.
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

/**
 * THE axis on a payload that predates the field (row 194). The ADAPTER stamps
 * the real axis it read (`tradition` for the PF2e rules lane, `school` for the
 * dnd5e lane); this default only keeps a pre-arc row parseable without
 * inventing anything at READ time — PF2e was the only spell system before row
 * 194, so `tradition` is what such a row meant. A malformed payload claiming to
 * be dnd5e without the field is stamped below by the schema's own check
 * (`dnd5e` ⇒ `school`), so a 5e row can never silently wear the PF2e axis.
 */
function defaultFilterAxis(data: {
  system: string;
  filterAxis?: 'tradition' | 'school' | null | undefined;
}):
  | 'tradition'
  | 'school'
  | null {
  if (data.filterAxis !== undefined) return data.filterAxis;
  return data.system === 'dnd5e' ? 'school' : 'tradition';
}

const spellDataSchemaBase = spellDataObjectSchema.transform((data) => ({
  ...data,
  filterAxis: defaultFilterAxis(data),
}));

export const spellDataSchema = spellDataSchemaBase;

/**
 * The COPY-ONLY payload schema: the transform-free OBJECT shape (docs/17 row
 * 255c). A copy is STORED in this shape, and the copy key rides a schema every
 * LLM contract embeds — and `z.toJSONSchema` cannot represent a transform AT
 * ALL, so embedding the transforming `spellDataSchema` above made the whole
 * stat-block and encounter-brief strict conversion THROW (measured: "Transforms
 * cannot be represented in JSON Schema"), which no amount of dropping the key
 * from the EMITTED schema could avoid, because the throw happens first.
 *
 * `filterAxis` is therefore not re-derived on a copy's parse: it was already
 * stamped by the library parse that produced the copy, and the copy stores that
 * OUTPUT. The transform stays on `spellDataSchema` for the library's own read.
 */
export const storedSpellDataSchema = spellDataObjectSchema;

/** The schema's INPUT type — `filterAxis` optional, so a document that omits it
 *  parses (the transform above stamps the system's own axis). */
export type SpellDataInput = z.input<typeof spellDataSchema>;
export type SpellData = z.output<typeof spellDataSchema>;

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
 * How a payload's OWN system prints a spell's rank (row 194): `Cantrip` when
 * the cantrip flag is set, `Level N` for dnd5e and `Rank N` for PF2e. The two
 * systems number their spells the same way but NAME the number differently,
 * and the label is part of the payload's own system rather than a page
 * preference — a dnd5e spell must never print "Rank N" (the PF2e vocabulary)
 * after this arc wires both systems into ONE list.
 *
 * `axis === 'school'` is the dnd5e signal; the local `spellRankLabel(rank,
 * cantrip)` re-export keeps every PF2e caller's bytes unchanged.
 */
export function spellRankLabelFor(
  rank: number,
  cantrip: boolean,
  axis?: SpellFilterAxis | null,
): string {
  if (cantrip) return 'Cantrip';
  return axis === 'school' ? `Level ${String(rank)}` : `Rank ${String(rank)}`;
}

/**
 * The values a spell row can be filtered by on its OWN axis (row 194): the
 * PF2e traditions, or the dnd5e school as a single value, or `[]` when the
 * source states none. The list's filter compares against THIS — never
 * against a cross-system guess — so a dnd5e spell is never matched by (or
 * given) a PF2e tradition.
 */
export function spellFilterValues(data: SpellData): string[] {
  if (data.filterAxis === 'tradition') return [...data.traditions];
  if (data.filterAxis === 'school') return data.school === '' ? [] : [data.school];
  return [];
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
