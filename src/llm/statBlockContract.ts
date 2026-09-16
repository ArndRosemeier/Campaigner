import { z } from 'zod';

import type { GameSystem } from '@/domain/gameSystem';
import type { StatBlock } from '@/domain/statblock';
import { statBlockBaseFields, storedMobSpellAssignmentSchema } from '@/domain/statblockFields';
import { schemaResponseFormat, type SchemaResponseFormat } from '@/llm/strictSchema';

/**
 * THE system-aware stat-block request contract (docs/17 row 205, docs/18 §2.2).
 *
 * THE DEFECT THIS EXISTS FOR. `domain/mobSpells.mobSpellAssignmentSchema` is
 * the ONE STORED assignment schema and its row-194 dnd5e keys
 * (`casterLevel`/`characterLevel`) are deliberately part of it — a stored row
 * must keep parsing. But the strict structured-output converter
 * (`llm/strictSchema`) turns EVERY non-free-form key of a zod schema into a
 * required, nullable property of the JSON Schema it emits, so a Pathfinder 2e
 * request whose response format was built from the STORED schema DEMANDED
 * `casterLevel`/`characterLevel` on every spell entry — the wrong system's
 * fields — and a model that filled them with numbers made the chip resolver
 * report "a spell it cannot use" for a harmless extra field. The prompt's own
 * prose shape (`{ name, castRank }`) disagreed with the schema that actually
 * constrained the reply.
 *
 * ONE BUILDER, TWO ARTIFACTS PER SYSTEM. This module is the ONE place a stat
 * block's request contract is built. `statBlockSchemaFor(system)` is the zod
 * schema handed to `schemaResponseFormat` (and to the two encounter contracts
 * that embed an inline stat block); `spellEntryShape(system)` is the prose the
 * model READS in the same prompt. Both render the SAME per-system key set
 * declared here, so what the model is told and what it must return are one
 * statement (pinned by `tests/llm/stat-block-contract.test.ts`).
 *
 * WHICH KEYS BELONG TO WHICH SYSTEM. `autoHeightenLevel` is the PF2e focus
 * key — the importer carries it from the creature document (docs/17 row 191) —
 * and `casterLevel`/`characterLevel` are the dnd5e keys the importer carries
 * for the 5e cantrip progression (docs/17 row 194). A request never names the
 * other system's keys. A system with no spell corpus is a separate arm:
 * `statBlockSchemaFor` is the FULL stored superset there, so a spell-less
 * request's JSON bytes are exactly what they were before this arc (the
 * compatibility/byte-identity promise).
 *
 * THE STORED SCHEMA IS UNTOUCHED. `domain/statblock.statBlockSchema` (and its
 * nested `mobSpellAssignmentSchema`) remains the superset every existing row
 * parses through, so an already-saved NPC whose assignments carry the spurious
 * field needs no migration — only the interpretation changed (docs/17 row 205).
 */

/** The stored assignment keys that belong to NO PF2e request. */
const DND5E_ASSIGNMENT_KEYS = ['casterLevel', 'characterLevel'] as const;

/** The prose half of one system's `spells` entry — THE bytes the model reads.
 *
 *  `spellEntryShape` is the only assembler: the vocabulary header, the
 *  reply-contract `"spells"` clause and the inline stat-block shape hint all
 *  render these exact bytes for the same system. */
function assignmentShapeParts(system: GameSystem): string[] {
  const base = [
    '"name": <copied EXACTLY from this prompt\'s spell list>',
    '"castRank": <the rank it is cast at, or null for the spell\'s own rank; a cantrip ignores it — a cantrip\'s rank is derived from the creature\'s level>',
  ];
  if (system === 'dnd5e') {
    return [
      ...base,
      '"casterLevel": <the creature\'s caster level as a number, or null when it states none — the 5e cantrip progression reads it>',
      '"characterLevel": <the creature\'s character level as a number, or null when it states none — preferred over the caster level when present>',
    ];
  }
  return [
    ...base,
    '"autoHeightenLevel": <a FOCUS spell\'s fixed auto-heightened rank as a number, or null when the source states none — only the creature document carries it>',
  ];
}

/** THE one per-system `{ "name", … }` prose shape. */
export function spellEntryShape(system: GameSystem): string {
  return `{ ${assignmentShapeParts(system).join(', ')} }`;
}

/** The keys `spellEntryShape(system)` names, in the same order. The contract
 *  pin compares this against the request schema's OWN `spells` property keys. */
export function spellEntryShapeKeys(system: GameSystem): string[] {
  return assignmentShapeParts(system).map((part) => /^"([^"]+)"/.exec(part)?.[1] ?? '');
}

/** One system's spell assignment as the REQUEST contract sees it. A fresh
 *  object per call: reusing one schema instance across two parents makes zod
 *  emit a `$ref`, which `strictSchema` refuses loudly (and rightly). */
export function mobSpellAssignmentSchemaFor(system: GameSystem) {
  const base = {
    name: z.string(),
    castRank: z.number().int().positive().nullish(),
  };
  if (system === 'dnd5e') {
    return z.object({
      ...base,
      casterLevel: z.number().int().positive().nullish(),
      characterLevel: z.number().int().positive().nullish(),
    });
  }
  return z.object({
    ...base,
    autoHeightenLevel: z.number().int().positive().max(10).nullish(),
  });
}

/** True when a system's request contract carries the dnd5e assignment keys. */
export function systemUsesDnd5eAssignment(system: GameSystem): boolean {
  return system === 'dnd5e';
}

/** Every request key this system must NOT be asked for — the OTHER system's
 *  stored assignment keys, named so a warning can say what was ignored. */
export function foreignAssignmentKeys(system: GameSystem): string[] {
  return systemUsesDnd5eAssignment(system) ? ['autoHeightenLevel'] : [...DND5E_ASSIGNMENT_KEYS];
}

/** Every stored assignment key, in the stored schema's own order. */
export const STORED_ASSIGNMENT_KEYS: readonly string[] = [
  'name',
  'castRank',
  'autoHeightenLevel',
  'casterLevel',
  'characterLevel',
];

/**
 * THE system-aware stat-block REQUEST schema. `spellCorpus` is the campaign
 * system's offer: a system with no imported corpus passes `false` and gets the
 * FULL stored superset, so its request JSON is byte-identical to the pre-arc
 * one (the row-200 gate, applied to the contract itself).
 *
 * NOTE the request schema is a STRUCTURAL SUBSET of `statBlockSchema`: the
 * stored superset stays the parse boundary everywhere (`statBlockSchema.parse`),
 * so a model reply that satisfies this contract always satisfies storage.
 */
export function statBlockSchemaFor(
  system: GameSystem,
  spellCorpus: boolean,
): z.ZodType<StatBlock> {
  if (!spellCorpus) {
    // The full stored superset, spells included — the SAME assignment builder
    // `domain/statblock.statBlockSchema` uses, so the no-corpus request can
    // never drift from what storage parses.
    return z.object({
      ...statBlockBaseFields(),
      spells: z.array(storedMobSpellAssignmentSchema()).nullish(),
    });
  }
  return z.object({
    ...statBlockBaseFields(),
    spells: z.array(mobSpellAssignmentSchemaFor(system)).nullish(),
  });
}

/** THE OpenRouter response format for one lane's stat-block request. The schema
 *  name carries the system, so two systems' contracts are distinguishable on
 *  the wire and in a run's recorded request. */
export function statBlockResponseFormat(
  system: GameSystem,
  spellCorpus: boolean,
): SchemaResponseFormat {
  return schemaResponseFormat(
    spellCorpus ? `statblock-${system}` : 'statblock',
    statBlockSchemaFor(system, spellCorpus),
  );
}
