import { z } from 'zod';

import { ENTITY_KINDS, type EntityKind, type ModuleEntityKind } from '@/domain/module';

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
}

/** The normalization call's JSON reply contract. */
export const normalizationReplySchema = z.object({
  entities: z.array(
    z.object({
      name: z.string(),
      canonical: z.string(),
      kind: z.enum(ENTITY_KINDS),
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

  return [...violations];
}

/**
 * Folds a validated reply into one entity record per canonical entity
 * (fix-01 "Applying a verdict" #4): `module.entityKinds` is REPLACED with
 * these — never merged into the previous variant-keyed records. The kind is
 * the canonical entity's own entry's kind when it is listed, else the first
 * variant's kind (the reply describes the canonical entity). `absorbed`
 * carries the variant names a canonical folded, for the checkpoint display.
 */
export function canonicalEntityRecords(entries: readonly NormalizationEntry[]): ModuleEntityKind[] {
  const entryBySelf = new Map<string, NormalizationEntry>();
  for (const entry of entries) {
    if (entry.name.trim().toLowerCase() === entry.canonical.trim().toLowerCase()) {
      entryBySelf.set(entry.name.trim().toLowerCase(), entry);
    }
  }

  const records = new Map<string, ModuleEntityKind>();
  for (const entry of entries) {
    const key = entry.canonical.trim().toLowerCase();
    if (key === '') continue;
    let record = records.get(key);
    if (record === undefined) {
      record = { name: entry.canonical, kind: entry.kind, absorbed: [] };
      records.set(key, record);
    }
    const own = entryBySelf.get(key);
    if (own !== undefined) record.kind = own.kind;
    if (entry.name.trim().toLowerCase() !== key) {
      record.absorbed = [...record.absorbed, entry.name];
    }
  }
  return [...records.values()];
}
