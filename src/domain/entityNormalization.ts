import { z } from 'zod';

import {
  ENTITY_KINDS,
  MODULE_ENTITY_KIND_CAP,
  type EntityKind,
  type EntityRewriteProposal,
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
 *   itself, an existing artifact's name, or (incremental runs only, via
 *   `options.canonicalNames`) a name the module already records — no chains,
 *   no cycles;
 * - a name that exactly matches an existing artifact maps to itself, always.
 */
export function validateNormalizationReply(
  names: readonly string[],
  entries: readonly NormalizationEntry[],
  artifactNames: readonly string[],
  options: {
    /**
     * Names that are a TERMINAL canonical target without being listed inputs:
     * the module's already-recorded entity names, on an INCREMENTAL run
     * (a new variant may map onto a canonical the module recorded earlier —
     * that canonical is neither a listed name nor an artifact). Records are
     * keyed canonically by construction, so no chain can hide behind them.
     */
    canonicalNames?: readonly string[];
  } = {},
): string[] {
  const violations = new Set<string>();

  const listed = new Map<string, string>();
  for (const name of names) {
    const key = name.trim().toLowerCase();
    if (key !== '') listed.set(key, name);
  }
  const artifactKeys = new Set(artifactNames.map((name) => name.trim().toLowerCase()));
  const canonicalKeys = new Set([...artifactKeys]);
  for (const name of options.canonicalNames ?? []) canonicalKeys.add(name.trim().toLowerCase());

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
    if (canonicalKeys.has(canonicalKey)) continue;
    const canonicalOwn = canonicalOf.get(canonicalKey);
    if (canonicalOwn === undefined) {
      violations.add(
        options.canonicalNames === undefined
          ? `"${entry.name}" maps to "${entry.canonical}", which is neither a listed name nor an existing artifact`
          : `"${entry.name}" maps to "${entry.canonical}", which is neither a listed name, a recorded entity name, nor an existing artifact`,
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
 * The names the record gate cannot batch yet — the panel's OBSERVED state
 * (08 §M4-C "names the text picks up later"; docs/17 row 64).
 *
 * Every batchable bucket is keyed by a recorded kind, so a name without a
 * record is invisible to the toolbar: that is the fix-01 guarantee (no
 * variant name can become an artifact through the batch), and it is why the
 * panel needs this derivation — the ONE place those names are named. It is
 * pure bookkeeping over EXACT, case-insensitive comparisons: it decides no
 * merges, classifies nothing and never guesses a kind (the model owns every
 * decision).
 *
 * Excluded, deliberately:
 * - names that already RESOLVE to an artifact (there is no artifact to create,
 *   so there is nothing to classify for the batch);
 * - names a pending consent proposal has already answered for — their surface
 *   is the panel's review banner, not another classification run.
 */
export function unclassifiedEntityNames(input: {
  entityKinds: readonly ModuleEntityKind[];
  /** The module text's wiki-link names, first-mention order. */
  names: readonly string[];
  /** Those of `names` that resolve to an artifact already. */
  resolvedNames: readonly string[];
  /** Held consent rewrites (the module row's `entityRewriteProposals`). */
  proposals?: readonly EntityRewriteProposal[] | null;
}): string[] {
  const recorded = new Set(input.entityKinds.map((entry) => entry.name.trim().toLowerCase()));
  const resolved = new Set(input.resolvedNames.map((name) => name.trim().toLowerCase()));
  const answered = new Set(
    (input.proposals ?? []).flatMap((proposal) =>
      proposal.replacements.map((rewrite) => rewrite.from.trim().toLowerCase()),
    ),
  );
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of input.names) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    if (recorded.has(key) || resolved.has(key) || answered.has(key)) continue;
    names.push(name);
  }
  return names;
}

/**
 * Appends an INCREMENTAL pass's records to the module's existing ones
 * (08 §M4-C names the text picks up later): a canonical that already has a
 * record keeps it BYTE-IDENTICAL — never re-keyed, never edited, never
 * duplicated — and only canonicals the module has no record for are added, in
 * verdict order. That is the whole no-duplicates guarantee the batch buckets
 * (and the fix-01 folding) rest on: repeating the run can only ever add what
 * is genuinely missing.
 *
 * Exceeding the row's record cap is a LOUD throw, never a silent drop: a
 * dropped record is a name that can never become batchable.
 */
export function mergeNewEntityRecords(
  existing: readonly ModuleEntityKind[],
  additions: readonly ModuleEntityKind[],
): ModuleEntityKind[] {
  const merged = [...existing];
  const known = new Set(existing.map((entry) => entry.name.trim().toLowerCase()));
  for (const addition of additions) {
    const key = addition.name.trim().toLowerCase();
    if (key === '' || known.has(key)) continue;
    known.add(key);
    merged.push(addition);
  }
  if (merged.length > MODULE_ENTITY_KIND_CAP) {
    throw new Error(
      `this module would carry ${String(merged.length)} recorded entities — past the ` +
        `${String(MODULE_ENTITY_KIND_CAP)}-record cap (its text names too many entities to record)`,
    );
  }
  return merged;
}

/**
 * Unions a pass's held consent proposals with the ones still pending
 * (fix-01): an incremental pass must never discard a review the user has not
 * answered yet. Deduped per (document, from → to), so repeating a
 * classification cannot pile duplicate rows into the review dialog; the
 * premise (planIndex −1) keeps its first place.
 */
export function mergeEntityRewriteProposals(
  pending: readonly EntityRewriteProposal[] | null,
  additions: readonly EntityRewriteProposal[],
): EntityRewriteProposal[] | null {
  const byPlan = new Map<number, EntityRewriteProposal>();
  const key = (rewrite: { from: string; to: string }): string =>
    `${rewrite.from.trim().toLowerCase()}\u0000${rewrite.to.trim().toLowerCase()}`;
  const add = (proposal: EntityRewriteProposal): void => {
    const current = byPlan.get(proposal.planIndex) ?? {
      planIndex: proposal.planIndex,
      replacements: [],
    };
    const seen = new Set(current.replacements.map((rewrite) => key(rewrite)));
    for (const rewrite of proposal.replacements) {
      const rewriteKey = key(rewrite);
      if (seen.has(rewriteKey)) continue;
      seen.add(rewriteKey);
      current.replacements.push(rewrite);
    }
    byPlan.set(proposal.planIndex, current);
  };
  for (const proposal of pending ?? []) add(proposal);
  for (const proposal of additions) add(proposal);
  if (byPlan.size === 0) return null;
  return [...byPlan.values()].sort((a, b) => a.planIndex - b.planIndex);
}

/**
 * Folds a validated reply into one entity record per canonical entity
 * (fix-01 "Applying a verdict" #4): `module.entityKinds` is REPLACED with
 * these — never merged into the previous variant-keyed records. The kind is
 * the canonical entity's own entry's kind when it is listed, else the first
 * variant's kind (the reply describes the canonical entity). `absorbed`
 * carries the variant names a canonical folded, for the checkpoint display.
 */
export function canonicalEntityRecords(
  entries: readonly NormalizationEntry[],
): ModuleEntityKind[] {
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
