import { z } from 'zod';

import {
  ENCOUNTER_CONFLICT_KINDS,
  ENTITY_KINDS,
  type EncounterConflictKind,
  type EntityKind,
  type ModuleEntityKind,
} from '@/domain/module';

/**
 * Entity name normalization (fix-01): the model — which wrote the module text
 * — decides, per wiki-link name, which canonical entity it refers to. Code
 * only VALIDATES the reply's shape and post-conditions (reject, never
 * correct) and APPLIES the verdict mechanically. No similarity, suffix,
 * stop-word or edit-distance logic may enter the decision path.
 */

/** One normalization verdict: the listed `name` refers to `canonical`. */
export interface NormalizationEntry {
  /** A wiki-link name exactly as listed in the input (verbatim). */
  name: string;
  /** The name itself, another listed name, or an existing artifact's name. */
  canonical: string;
  /** The canonical entity's kind (same contract as the kind classification). */
  kind: EntityKind;
  /**
   * Structural conflict declarations (08 §M4-B): for `kind: "encounter"`
   * verdicts on module prose, the two mutually exclusive wants and the
   * declared conflict kind — authored by the model that wrote the text, from
   * that text. Spine-time verdicts (name mapping only) leave both absent and
   * the caller fills them from the planner's declarations.
   */
  wants?: string[] | undefined;
  conflictKind?: EncounterConflictKind | null | undefined;
}

/** The normalization call's JSON reply contract. */
export const normalizationReplySchema = z.object({
  entities: z.array(
    z.object({
      name: z.string(),
      canonical: z.string(),
      kind: z.enum(ENTITY_KINDS),
      wants: z.array(z.string()).max(2).default([]),
      conflictKind: z.enum(ENCOUNTER_CONFLICT_KINDS).nullable().default(null),
    }),
  ),
});

export type NormalizationReply = z.infer<typeof normalizationReplySchema>;

/**
 * Post-conditions on a parsed reply (fix-01 "reject, never correct"). Any
 * violation is returned as a human-readable message; the caller retries once
 * with the violations stated, then fails the pass loudly. All comparisons are
 * exact and case-insensitive — the only string operations allowed here.
 *
 * - every listed name is answered exactly once; no invented names;
 * - every `canonical` is the name itself, another listed name that maps to
 *   itself, or an existing artifact's name (no chains, no cycles);
 * - a name that exactly matches an existing artifact maps to itself, always.
 */
export function validateNormalizationReply(
  names: readonly string[],
  entries: readonly NormalizationEntry[],
  artifactNames: readonly string[],
  options: { requireEncounterDeclarations?: boolean } = {},
): string[] {
  const violations = new Set<string>();

  const listed = new Map<string, string>();
  for (const name of names) {
    const key = name.trim().toLowerCase();
    if (key !== '') listed.set(key, name);
  }
  const artifactKeys = new Set(artifactNames.map((name) => name.trim().toLowerCase()));

  const answered = new Map<string, number>();
  for (const entry of entries) {
    const key = entry.name.trim().toLowerCase();
    answered.set(key, (answered.get(key) ?? 0) + 1);
    if (!listed.has(key)) {
      violations.add(`the reply invented a name that was not listed: "${entry.name}"`);
    }
  }
  for (const [key, name] of listed) {
    const count = answered.get(key) ?? 0;
    if (count === 0) violations.add(`the reply omitted the listed name "${name}"`);
    if (count > 1) violations.add(`the reply answered for "${name}" more than once`);
  }

  const canonicalOf = new Map<string, string>();
  for (const entry of entries) {
    canonicalOf.set(entry.name.trim().toLowerCase(), entry.canonical.trim().toLowerCase());
  }
  for (const entry of entries) {
    const nameKey = entry.name.trim().toLowerCase();
    const canonicalKey = entry.canonical.trim().toLowerCase();
    if (canonicalKey === nameKey) continue;
    if (artifactKeys.has(canonicalKey)) continue;
    const canonicalOwn = canonicalOf.get(canonicalKey);
    if (canonicalOwn === undefined) {
      violations.add(
        `"${entry.name}" maps to "${entry.canonical}", which is neither a listed name nor an existing artifact`,
      );
    } else if (canonicalOwn !== canonicalKey) {
      violations.add(
        `mapping chain: "${entry.name}" → "${entry.canonical}", but "${entry.canonical}" maps elsewhere`,
      );
    }
  }

  for (const entry of entries) {
    const nameKey = entry.name.trim().toLowerCase();
    if (artifactKeys.has(nameKey) && entry.canonical.trim().toLowerCase() !== nameKey) {
      violations.add(
        `"${entry.name}" matches an existing artifact and must map to itself, never merge away`,
      );
    }
  }

  // Structural conflict declarations (08 §M4-B): opt-in per caller. The
  // spine-time call maps names only (the planner already declared wants/kind
  // on the spine records, carried over code-side); the post-parts call reads
  // prose, so every encounter verdict must author its own declarations —
  // a missing pair/kind is a violation (retry once, then loud), never a
  // defaulted kind.
  if (options.requireEncounterDeclarations === true) {
    for (const entry of entries) {
      if (entry.kind !== 'encounter') continue;
      const wants = (entry.wants ?? []).filter((want) => want.trim() !== '');
      if (wants.length !== 2) {
        violations.add(
          `"${entry.name}" is an encounter but declares ${String(wants.length)} wants — declare exactly the two mutually exclusive wants driving the scene`,
        );
      }
      if (entry.conflictKind === undefined || entry.conflictKind === null) {
        violations.add(
          `"${entry.name}" is an encounter but declares no conflict kind — declare one of ${ENCOUNTER_CONFLICT_KINDS.join(', ')}`,
        );
      }
    }
  }

  return [...violations];
}

/**
 * Folds a validated reply into one entity record per canonical entity
 * (fix-01 "Applying a verdict" #4): `module.entityKinds` is REPLACED with
 * these — never merged into the previous variant-keyed records. The kind is
 * the canonical entity's own entry's kind when it is listed, else the first
 * variant's kind (the reply describes the canonical entity). `absorbed`
 * carries the variant names a canonical folded, for the checkpoint display.
 *
 * Structural conflict declarations ride the same rule: a verdict's own
 * non-empty `wants` / non-null `conflictKind` (canonical's own entry, else
 * the first variant carrying one) win; the optional `declarations` fallback
 * (the planner's spine records, matched case-insensitively by canonical name
 * then by absorbed variant) fills the gaps the verdict left empty. The
 * fallback is code-side carry-over, never a classifier.
 */
export function canonicalEntityRecords(
  entries: readonly NormalizationEntry[],
  declarations: readonly ModuleEntityKind[] = [],
): ModuleEntityKind[] {
  const entryBySelf = new Map<string, NormalizationEntry>();
  for (const entry of entries) {
    if (entry.name.trim().toLowerCase() === entry.canonical.trim().toLowerCase()) {
      entryBySelf.set(entry.name.trim().toLowerCase(), entry);
    }
  }
  const declaredByName = new Map<string, ModuleEntityKind>();
  for (const declared of declarations) {
    declaredByName.set(declared.name.trim().toLowerCase(), declared);
    for (const variant of declared.absorbed) {
      if (!declaredByName.has(variant.trim().toLowerCase())) {
        declaredByName.set(variant.trim().toLowerCase(), declared);
      }
    }
  }

  const records = new Map<string, ModuleEntityKind>();
  const verdictsByCanonical = new Map<string, NormalizationEntry[]>();
  for (const entry of entries) {
    const key = entry.canonical.trim().toLowerCase();
    if (key === '') continue;
    let record = records.get(key);
    if (record === undefined) {
      record = { name: entry.canonical, kind: entry.kind, absorbed: [], wants: [], conflictKind: null };
      records.set(key, record);
    }
    const own = entryBySelf.get(key);
    if (own !== undefined) record.kind = own.kind;
    if (entry.name.trim().toLowerCase() !== key) {
      record.absorbed = [...record.absorbed, entry.name];
    }
    const bucket = verdictsByCanonical.get(key);
    if (bucket === undefined) verdictsByCanonical.set(key, [entry]);
    else bucket.push(entry);
  }
  // Verdict's own declarations (canonical's own entry first, else the first
  // variant carrying one) — mirroring the kind rule above.
  const nonBlank = (wants: readonly string[] | undefined): string[] =>
    (wants ?? []).filter((want) => want.trim() !== '');
  for (const [key, record] of records) {
    const bucket = verdictsByCanonical.get(key) ?? [];
    const own = entryBySelf.get(key);
    const ownWants = nonBlank(own?.wants);
    if (ownWants.length > 0) {
      record.wants = ownWants;
    } else {
      const variantWants = bucket.map((verdict) => nonBlank(verdict.wants)).find((wants) => wants.length > 0);
      if (variantWants !== undefined) record.wants = variantWants;
    }
    const ownKind: EncounterConflictKind | null = own?.conflictKind ?? null;
    if (ownKind !== null) {
      record.conflictKind = ownKind;
    } else {
      const variantKind: EncounterConflictKind | null =
        bucket.map((verdict) => verdict.conflictKind ?? null).find((kind) => kind !== null) ?? null;
      if (variantKind !== null) record.conflictKind = variantKind;
    }
  }
  // Planner carry-over: fill declarations the verdict left empty.
  if (declaredByName.size > 0) {
    for (const record of records.values()) {
      const declared =
        declaredByName.get(record.name.trim().toLowerCase()) ??
        record.absorbed
          .map((variant) => declaredByName.get(variant.trim().toLowerCase()))
          .find((found) => found !== undefined);
      if (declared === undefined) continue;
      if (record.wants.length === 0 && declared.wants.length > 0) record.wants = [...declared.wants];
      if (record.conflictKind === null && declared.conflictKind !== null) {
        record.conflictKind = declared.conflictKind;
      }
    }
  }
  return [...records.values()];
}
