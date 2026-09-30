import type { Id } from '@/domain/entity';

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
 *   (`artifactRepo.addArtifactAliases` returns `null` on that case);
 * - a name that already answers for a DIFFERENT artifact is NOT merged either
 *   (docs/17 row 226). That question needs the campaign's OTHER rows, which a
 *   pure function cannot see, so it is `db/artifactRepo.foreignAliasNames` —
 *   the ONE lookup — and the guard is applied by every alias WRITE
 *   (`artifactRepo.addArtifactAliases` for its callers, and the callers that
 *   must land the alias inside their own revision call the same lookup).
 *   `AliasCollision` + `aliasCollisionSentence` are the shape and the ONE
 *   sentence a refusal is surfaced with, so the seam that refuses and the
 *   surface that speaks cannot drift.
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
 *
 * THE KEY SPACES BUILT ON IT (docs/17 row 167). The same primitive serves
 * several DIFFERENT questions, and they must not be merged into one helper: a
 * spelling-variant index and a creature IDENTITY are not interchangeable, so
 * conflating them would be a worse bug than legible duplication. The spaces,
 * declared here so a reader can tell them apart and a new copy cannot be born
 * unnoticed — `tests/domain/name-key-spaces.test.ts` is the accounting pin that
 * lists each one's sites and holds them in place:
 *
 * - `PACK_POOL_NAME_KEY` (`llm/encounterRoster`, `llm/encounterItems`,
 *   `llm/runEngine`, `llm/roomBudget`): the pack pool's printed name ↔ the
 *   model's `sourceName`, resolved to a chunk id — the creature roster AND the
 *   item pool are the same question with two pools (`rosterNameIndex` /
 *   `itemPoolNameIndex` mint; `runEngine`'s `rosterChunkByName` lookups and
 *   `roomBudget.resolveBriefMonsterLevels` read).
 * - `MODULE_NAME_KEY` (`llm/roomBudget`, `llm/runEngine`, `domain/module`): a
 *   name of something the MODULE holds matched against another such name in the
 *   same module (the fixed-cast scan, the room-reconciliation remap, the
 *   bestiary-slot source map, the run engine's roster digest). Distinct from
 *   `PACK_POOL_NAME_KEY` even where both live in `roomBudget`: a pack
 *   creature's name is a LIBRARY lookup, a roster name is this campaign's row.
 * - `WRITTEN_LINK_NAME_KEY` (`domain/wikiGraph`, `llm/moduleGen`,
 *   `features/modules/module-problems`, `db/artifactAutoPromote`): one WRITTEN
 *   `[[name]]` token recognised across a prose set (the resolution memo, the
 *   phantom node id, the rewrite-target match, the unresolved-chip census, the
 *   adopt set, the encounter-name census).
 * - `LIBRARY_CREATURE_NAME_KEY` (`db/creatureCitations`,
 *   `llm/creatorRoster`): one library creature prints/suggests once.
 * - `IMPORT_IDENTITY_KEY` (`domain/exportDependencies`): an export manifest's
 *   logical identity against a local snapshot — the L1 verdict asks ONE
 *   question of BOTH its halves (a cited book TITLE and a cited creature
 *   NAME), so they share one tolerance here deliberately, though `sameSlot`
 *   in `domain/module` keeps its book half hand-rolled: there the book is
 *   compared to another book of the same module, not to a library row.
 * - `PRINTED_NAME_DEDUPE_KEY` (`features/campaign/components/missing-refs-summary`):
 *   one displayed name, once, in the missing-refs sentence.
 * - `PROMPT_STYLE_NAME_KEY` (`db/promptStyleRepo`): a prompt style's name is
 *   unique across the picker — the clash map AND the free-copy-name set are
 *   one space; keying one half by `toLowerCase()` alone misses the other
 *   half's entries (the partial-fold trap, row 167).
 * - `CREATURE_CONTENT_IDENTITY_KEY` (`domain/creature.contentCreatureKey`):
 *   FOLDED since docs/17 row 168 — a PERSISTED identity whose bytes are a Dexie
 *   index value. Because the bytes are an existing identity, the fold ships
 *   with a Dexie upgrade that re-keys stored rows and battle keys;
 *   `domain/creature.foldCreatureKey` is the migration/import seam that folds a
 *   pre-fold key. See its own doc for the honest limit (a stored name half was
 *   already lowercased, so the migration folds `lowercase(name)`).
 *
 * DECLARED NOT-BUILT-ON-IT (the anti-spaces — each a place the primitive would
 * be WRONG, which is why they are named rather than silently left):
 *
 * - `ALIAS_FORM_KEY` (`llm/campaignGrounding`): the grounding SPELLING pick.
 *   Its map's values become detection REGEXES, and a regex never folds
 *   composition — folding this key would DROP a real spelling and blind
 *   detection to the prose spelled the way an alias spelled it. Case and
 *   surrounding space fold; composition does not.
 * - The SEARCH NEEDLES (`features/bestiary/roster`, `features/play/battle/
 *   SpawnPicker`, `features/quickfind/*`, `features/campaign/filter`,
 *   `help/HelpDialog`, `search/search`, `features/rules/search-browser`,
 *   `features/modules/textMatches`): substring CONTAINS matching, fuzzy BY
 *   CONTRACT — not identity, not keys, and deliberately not exact.
 * - The EMPTINESS PROBES (`domain/module.entityKindFor`-class `const target =
 *   name.trim().toLowerCase(); if (target === '')`): composition cannot
 *   change emptiness; the real comparison beside them is a tier call.
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

/**
 * One candidate alias name that was REFUSED because another artifact already
 * answers it (docs/17 row 226).
 *
 * The name alone is not enough to speak loudly: the owner has to be told WHICH
 * artifact it belongs to, or "not attached" reads as an arbitrary refusal.
 * `artifactId` is what a surface could navigate to; `artifactName` is what it
 * prints. The shape is pure data so `db/artifactRepo` can mint it and the
 * domain can own the sentence, without either importing the other's layer.
 */
export interface AliasCollision {
  /** The candidate name, exactly as the caller passed it. */
  name: string;
  /** The artifact that already answers this name. */
  artifactId: Id;
  /** That artifact's own name (what a reader calls it). */
  artifactName: string;
}

/**
 * THE sentence a refused alias is surfaced with (docs/17 row 226, AGENTS rule
 * 1: a refusal is LOUD, never a silent drop). ONE composer, because the seam
 * that decides the refusal is not always the surface that reports it — the run
 * engine writes its own step notice and toast, the entity batch records a
 * per-entity toast, and the module/reader paths toast their own headline — and
 * three hand-written sentences for one fact drift.
 */
export function aliasCollisionSentence(collision: AliasCollision): string {
  return `The name «${collision.name}» already answers for another artifact, «${collision.artifactName}» — it was NOT attached as an alias.`;
}
