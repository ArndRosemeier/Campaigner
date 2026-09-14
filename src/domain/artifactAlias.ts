/**
 * An artifact's ALIAS POOL — the ONE comparison and the ONE merge rule
 * (docs/17 row 121, docs/18 §2.1).
 *
 * An artifact's `aliases` are the pool `lib/wikilinks.resolveWikiLink` answers
 * `[[wiki links]]` from, so an alias that is MISSING is a dead link and an
 * alias that is DUPLICATED is a second row in the alias editor for one name.
 * "Add this name to the pool" was hand-rolled six times before this module
 * existed, and the copies had already drifted into three different comparison
 * rules — one of them untrimmed on the stored side, so a stored `"Kael "`
 * made the reader append a duplicate `"Kael"` that the batch path skipped.
 * The rule therefore lives here, with a name, and every caller goes through it.
 *
 * THE RULE this module owns:
 * - the comparison is TRIMMED and case-insensitive (`sameAliasName`);
 * - a name equal to the artifact's OWN name (same comparison) is NOT an alias
 *   — `resolveWikiLink` matches the name before it looks at aliases, so such
 *   an alias could never resolve and is dead weight (`alias-editor.tsx`'s own
 *   doc says the same thing at the form);
 * - a duplicate is never stored, neither against the existing pool nor against
 *   an earlier name of the same batch;
 * - a merge that adds NOTHING returns the caller's list UNCHANGED — the SAME
 *   reference — which is how a caller knows to skip its write entirely
 *   (`artifactRepo.addArtifactAliases` returns `null` on that case).
 *
 * STORED SPELLING (deliberate, docs/17 row 121): the accepted name is stored
 * EXACTLY as the caller passed it — never re-trimmed, never re-cased. The
 * comparison trims; the ROW does not. Three of the six folded call sites hand
 * this function a row's own name and one hands it a hand-typed link name, and
 * every one of them is byte-identical to what that site wrote before, which is
 * what makes the fold safe: this module owns the COMPARISON, not the spelling.
 * `alias-editor.tsx`'s contract ("stored spelling is preserved verbatim —
 * display fidelity: resolution lowercases on its own") is the same decision at
 * the form boundary.
 *
 * DELIBERATE BOUNDARIES (named, not oversights — docs/18 §2.1):
 * - `features/campaign/components/alias-editor.tsx` is NOT a caller: it
 *   validates what a person just typed into a form and REJECTS the keystroke,
 *   where this module merges a name the app already decided to add. The two
 *   rules agree today by construction of the same comparison, and the editor
 *   keeps its own copy deliberately (its rejection is UI feedback, not a
 *   write).
 * - `lib/wikilinks.resolveWikiLink` is not a caller of the MERGE rule, and must
 *   not become one: it RESOLVES a link against the pool (name first, then
 *   aliases, then scope tiers), and folding the merge in would tie resolution
 *   PRECEDENCE to it. It IS a caller of `comparableName`/`sameAliasName` since
 *   docs/17 row 162 — the equality it applies is this module's comparison, so
 *   "is this the same name?" has one answer in the app (row 162 folded
 *   `resolveWikiLink`'s seven hand-rolled `…trim().toLowerCase() === …` sites,
 *   the seventh copy the row-121 audit had left as a boundary for the wrong
 *   reason).
 *
 * Pure: no Dexie, no React, no formatting — the row write is
 * `db/artifactRepo.addArtifactAliases`.
 */

/**
 * THE comparable form of a user-visible NAME — the ONE spelling every name
 * comparison in the app compares through (docs/17 row 162).
 *
 * Three steps, and each one is a decision:
 *
 * - **`normalize('NFC')` — canonical equivalence, NOT diacritic folding.** The
 *   same name typed on a Mac (`Müller` decomposed: `u` + U+0308) and written by
 *   a model or a Windows editor (precomposed U+00FC) are the SAME NAME in
 *   Unicode's own equivalence relation and different STRINGS — so every `===`
 *   on names silently failed for one of the two authors. NFC makes canonically
 *   equivalent spellings identical and changes nothing else: `Schläger` and
 *   `Schlager` stay different names (`sameAliasName`'s no-diacritic-folding
 *   rule is untouched, and still pinned in `tests/domain/artifactAlias.test.ts`).
 * - **`trim()`** — surrounding whitespace is not part of a name.
 * - **`toLowerCase()`, never `toLocaleLowerCase()`.** The locale-aware fold is
 *   the HAZARD here, not an improvement: in a Turkish locale `I` folds to `ı`,
 *   so `[[Ilias]]` and `[[ilias]]` would stop matching on one machine and go on
 *   matching on another. Every `toLowerCase` site in this repo is deliberate
 *   (docs/17 row 162 records the audit: 148 sites, ZERO locale-aware ones, and
 *   that is correct — do not "fix" it).
 *
 * This function is the primitive; `sameAliasName`/`sameCreatureName` are the
 * two tier-specific comparisons built on it. Returning the comparable STRING
 * rather than a boolean is what lets a caller index a pool by name without
 * spelling these three steps a fourth time.
 */
export function comparableName(name: string): string {
  return name.normalize('NFC').trim().toLowerCase();
}

/**
 * The ONE alias-name comparison: equal after canonical composition (NFC),
 * trimming surrounding whitespace and case-folding. Nothing else is forgiven —
 * no punctuation folding, no diacritic folding, no prefix match. Two names that
 * differ in their interior are two names (`domain/creatureName`'s
 * `sameCreatureName` is the sibling of this function for the creature tier,
 * with the same strictness).
 */
export function sameAliasName(left: string, right: string): boolean {
  return comparableName(left) === comparableName(right);
}

/**
 * The merged alias pool: `existing` plus every name in `names` that is not
 * already answerable — not the artifact's own name (`artifactName`), not
 * already in the pool (by `sameAliasName`), not repeated earlier in `names`.
 *
 * Returns `existing` ITSELF when nothing was added, so `merged === existing` is
 * the caller's "there is nothing to write" test — the shape every folded call
 * site relies on to avoid a revision that changes nothing.
 */
export function mergeAliasNames(
  existing: string[],
  names: readonly string[],
  artifactName: string,
): string[] {
  let merged: string[] | null = null;
  for (const name of names) {
    if (sameAliasName(name, artifactName)) continue;
    const current = merged ?? existing;
    if (current.some((alias) => sameAliasName(alias, name))) continue;
    merged ??= [...existing];
    merged.push(name);
  }
  return merged ?? existing;
}
