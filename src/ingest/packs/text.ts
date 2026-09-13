import { loadAll } from 'js-yaml';

import { errorMessage } from '@/lib/errors';

/**
 * The ingest layer's ONE HTML→text seam (AGENTS §Centralization rule 4).
 *
 * Seven pack adapters each carried their own HTML→text stripper — the same
 * idea, seven copies, which had drifted into two block conventions and THREE
 * inline-notation dialects. Nothing failed when a copy was born, which is why
 * only a pin catches it: `tests/ingest/packs/html-to-text.test.ts` is that pin
 * (the differential table + the source scan over this directory).
 *
 * ## The bytes are a content hash, and row 149 changed them ON PURPOSE
 *
 * The text this returns becomes `PackEntry.text` → the stored chunk `text` →
 * `contentHash = sha256Hex(text)`, stamped at import (`packImport.ts`) and
 * again when a citation is born (`encounterResolve.ts`). `resolveMonsterEntry`
 * resolves a citation by uuid first and then by EXACT content hash, and a
 * campaign bundle export treats an unresolvable citation as BLOCKING
 * (`exportDependencies.ts`, `exportImport.ts` throws `MissingDependenciesError`).
 * A changed byte therefore strands every stored citation on the next re-import,
 * with no heal path (docs/11's L1 "same creature, new hash" is deferred and no
 * contentHash re-stamp migration exists).
 *
 * Row 143 therefore folded the seven copies BYTE-PRESERVING and left the
 * corruptions declared as data. Row 149 repaired the two corrupted behaviours
 * on the owner's own recorded decision that the consequence is honest:
 * **after a re-import of an affected pack, citations stored against the OLD
 * bytes read `missing ref (<name>)`; the user re-imports the pack and re-picks
 * the creature. No rebind tool, no migration, no contentHash re-stamp.**
 * Concretely, what changed: a PF2e or dnd5e description now resolves its
 * `@Type[…]{Label}` brace label instead of storing `Enfeebled{Enfeebled 1}`,
 * and a PF2e item description now keeps its table structure instead of storing
 * `HardnessHPBT52010`. docs/17 row 149 carries the per-lane evidence table,
 * the rejected lanes and the re-import instruction.
 *
 * ## The two axes
 *
 * The axes are independent dimensions of "turn this document's HTML into
 * plain text", named for what they DO — never for the adapter that happens to
 * declare them today:
 *
 * - `notation` — how the source's inline link markup is resolved to a label.
 * - `blockAware` — whether block/table structure survives into the text.
 *
 * ## Where the sibling helpers go
 *
 * This module is the ingest layer's DOCUMENT-CONVENTIONS module — text AND the
 * document stream that feeds it — not a file per helper. `parseJsonDocs` and
 * `parseYamlDocs` below are its second and third occupants (docs/17 row 147):
 * `parseDocs` used to be spelled SEVEN times in three bodies across this
 * directory, and the two YAML bodies DISAGREED (a comment-only file was a loud
 * failure in one adapter and accounted NOWHERE in the other — the AGENTS rule 1
 * shape). Seven call sites, two helpers, one rule, pinned by
 * `tests/ingest/packs/parse-docs.test.ts`.
 *
 * ONE adjacent duplication in this directory is deliberately NOT folded here:
 * `publicationSourceLine` (two byte-identical copies — private in
 * `pf2e-rules.ts`, exported from `pf2e-conditions.ts` — plus two INLINE
 * spellings, `domain/itemData.ts` and `pf2e-foundry.ts`). It is a different
 * idea from document parsing, and three of the four sites feed chunk `text` →
 * `contentHash` with no heal path (see above), so docs/17 row 147 lands the
 * DIFFERENTIAL PIN and leaves the fold as the owner's call: docs/12 §15.5 still
 * describes the copies as carried. Read that row before folding it.
 */

/**
 * How a source document's inline link notation resolves to a plain-text label.
 *
 * - `at-label-last` — Foundry `@`-notation only, keeping the TARGET's last
 *   dotted segment: `@UUID[a.b.C|label]` → `C`. A `{Label}` brace form is NOT
 *   resolved — the brace text survives VERBATIM, braces included
 *   (`@UUID[…]{Enfeebled 1}` → `Enfeebled{Enfeebled 1}`).
 *
 *   **RETIRED (docs/17 row 149): no adapter declares it any more.** It is kept
 *   in the enum, and only for that, so the OLD bytes stay REACHABLE as the old
 *   behaviour: the differential table runs this notation against every sample
 *   case beside the two live styles, which is what makes the repair PROVABLE
 *   (the pin states what the retired rule emits, so "fixed" cannot mean "the
 *   sample changed shape") and what the FAILED-REVERT injection reverts a lane
 *   to. Nothing may ship it: the SOURCE SCAN forbids an `HtmlToTextStyle`
 *   literal in an adapter file, and no exported style constant uses it.
 * - `at-brace-label` — the live PF2e rule (§the declaration below): a brace
 *   form wins FIRST — `@Type[a.b.C]{Label}` → `Label` — and anything left is
 *   resolved by the `at-label-last` rule (`@Type[a.b.C|label]` → `C`).
 * - `bracket-links` — the dnd5e document dialect, its OWN grammar, not a merge
 *   of the PF2e one: a three-rule PRELUDE first — `[[target]]{Label}` → `Label`,
 *   `[[target|label]]` → the LAST label segment, `[[target]]` (no label
 *   segment) → nothing, `&reference[target]` → `target` — and then the brace
 *   rule above for any remaining `@`-notation `{Label}` form. The prelude stays
 *   first because `[[…]]` is not `@`-notation; the brace rule is shared, not
 *   copied, because a `{Label}` suffix means the same thing in both dialects.
 */
export type HtmlNotation = 'at-label-last' | 'at-brace-label' | 'bracket-links';

/**
 * One HTML→text style: the minimum needed to reproduce the behaviours that
 * existed as seven copies. Every value of the `notation` axis that a CALL SITE
 * declares is live; `at-label-last` alone is retired-and-reachable (read the
 * comment above and docs/17 row 149 before deleting it).
 */
export interface HtmlToTextStyle {
  readonly notation: HtmlNotation;
  /**
   * `false` — line breaks only: `<hr>`/`<br>`/`</p>` become `\n` and every
   * other tag is dropped with nothing, so block structure and TABLES are lost
   * (`<td>` cells run together). No blank-line collapse, no per-line trim.
   * Since docs/17 row 149 the dnd5e dialect is the only style declaring it,
   * because no dnd5e fixture carries table markup — read that row's per-lane
   * table before turning it off for a lane.
   *
   * `true` — block-and-table aware: the block closers
   * (`</p>`, `</h1>`–`</h6>`, `</li>`, `</blockquote>`, `</div>`, `</caption>`,
   * `</table>`) break lines; `<tr …>` is dropped and `</tr>` becomes a newline;
   * a `</td>`/`</th>` followed by whitespace and another cell inserts ` | `;
   * then runs of 3+ newlines collapse to 2 and every line is trimmed.
   *
   * MEASURED, not assumed: the cell-separator's `\s*` SWALLOWS the `</tr>`
   * newline, so consecutive rows run together on ONE line unless a block closer
   * between them breaks it. The `Encounter Budget` section of
   * `tests/fixtures/packs/pf2e-journal/gm-screen.json` shows both at once —
   * `</caption>` starts a line and then all five rows sit on the next one
   * (`Difficulty | XP Budget | Character Adjustment | Trivial | 40 or less |
   * 10 or less | Low | 60 | 20 | …`). The old copies' comments claimed "`<tr>`
   * opens a line", which is not what their own regex order does; this seam
   * reproduces the behaviour, and the comment now describes it.
   */
  readonly blockAware: boolean;
}

/**
 * The TWO styles the ingest layer declares — the divergence that is left as
 * DATA, in one place, instead of seven copies. Both are in use by real call
 * sites; a new adapter picks one of these BY NAME rather than declaring its own
 * combination, because a new style is a behaviour change and belongs with the
 * re-import story (docs/17 rows 143 and 149). Both are pinned byte-for-byte by
 * the differential table in `tests/ingest/packs/html-to-text.test.ts`.
 *
 * Row 143 declared a THIRD (`AT_LABEL_LAST_LINE_BREAKS`, `at-label-last` +
 * line breaks only) for the two PF2e description lanes. Row 149 DELETED it, and
 * deliberately did not rename it: its repaired behaviour would have been
 * byte-identical to `AT_BRACE_LABEL_BLOCK_AND_TABLE`, and two names for one
 * behaviour is exactly the divergence this module exists to end. The two
 * surviving names are unchanged because they still describe what they do — the
 * NOTATION each declares and whether block/table structure survives.
 */

/** dnd5e item/creature descriptions — the dialect with its own prelude: the
 *  `[[…]]{L}` / `[[…|l]]` / `&reference[…]` rules resolve first, then the
 *  shared `{Label}` rule for `@`-notation, then the target's last segment;
 *  line breaks only (`blockAware: false`, measured: no `<table>` markup exists
 *  in any dnd5e fixture, so no dnd5e lane asked for the table rule). */
export const BRACKET_LINKS_LINE_BREAKS: HtmlToTextStyle = {
  notation: 'bracket-links',
  blockAware: false,
};

/** The `@`-notation rule — PF2e items, creatures, rules text, journals and
 *  conditions: `@Type[…]{Label}` → `Label` first, then `@Type[a.b.C|…]` → `C`,
 *  and block/table structure survives (`Hardness | HP | BT | 5 | 20 | 10`
 *  rather than `HardnessHPBT52010`). */
export const AT_BRACE_LABEL_BLOCK_AND_TABLE: HtmlToTextStyle = {
  notation: 'at-brace-label',
  blockAware: true,
};

/** HTML entities the source corpora actually carry, in the order they matter. */
const ENTITIES: readonly (readonly [RegExp, string])[] = [
  [/&nbsp;/gi, ' '],
  [/&amp;/gi, '&'],
  [/&lt;/gi, '<'],
  [/&gt;/gi, '>'],
  [/&quot;/gi, '"'],
  [/&#39;/gi, '\''],
];

/** The block closers that break a line when `blockAware` is on. */
const BLOCK_CLOSERS = /<\/(p|h[1-6]|li|blockquote|div|caption|table)>/gi;

/**
 * `@Type[target|…]` → the target's LAST dotted segment.
 *
 * The `|…` tail is dropped before the split, so `@UUID[a.b.C|label]` → `C`.
 * A `{Label}` suffix is deliberately NOT matched here: it is `resolveBraceLabels`
 * below that owns the brace form, so this rule and that one compose in the
 * order each notation needs.
 */
function resolveAtLabelLast(html: string): string {
  return html.replace(/@(\w+)\[([^\]]*)\]/g, (_match, _kind: string, inner: string) => {
    const beforePipe = inner.split('|')[0] ?? '';
    return beforePipe.split('.').pop() ?? '';
  });
}

/**
 * `@Type[…]{Label}` → `Label` — THE brace rule, declared once.
 *
 * A `{Label}` suffix is the source's own display text for the link, so it wins
 * over anything the target would render as. Both live notations use it (row
 * 149 fixed the residue the line-breaks-only styles stored: `Enfeebled{Enfeebled 1}`
 * became `Enfeebled 1`), and it is applied to what is LEFT of the `@`-notation
 * after a dialect's own prelude — never re-spelled per adapter.
 */
function resolveBraceLabels(html: string): string {
  return html.replace(
    /@(\w+)\[([^\]]*)\]\{([^}]*)\}/g,
    (_match, _kind: string, _inner: string, label: string) => label,
  );
}

/** Applies the declared inline-notation dialect, in the order that dialect needs. */
function resolveNotation(html: string, notation: HtmlNotation): string {
  switch (notation) {
    case 'at-label-last':
      // RETIRED (docs/17 row 149) — the OLD, corrupted behaviour, kept
      // reachable so the differential pin and the FAILED-REVERT injection can
      // state it. No adapter may declare it.
      return resolveAtLabelLast(html);
    case 'at-brace-label':
      return resolveAtLabelLast(resolveBraceLabels(html));
    case 'bracket-links':
      return resolveAtLabelLast(
        resolveBraceLabels(
          html
            .replace(/\[\[[^\]]*\]\]\{([^}]*)\}/g, '$1')
            .replace(/\[\[([^\]]*)\]\]/g, (_match, inner: string) => {
              // [[/condition conditions:Incapacitated|incapacitated]] → last label;
              // bracket links without a label segment render as nothing.
              const segments = inner.split('|');
              return segments.length > 1 ? (segments[segments.length - 1] ?? '') : '';
            })
            .replace(/&(amp;)?reference\[([^\]]*)\]/g, '$2'),
        ),
      );
  }
}

/** Tags → line breaks, entities decoded, whitespace runs collapsed. */
function decodeTagsAndEntities(html: string, blockAware: boolean): string {
  let text = html
    .replace(/<hr\s*\/?>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');
  if (blockAware) {
    text = text
      .replace(BLOCK_CLOSERS, '\n')
      .replace(/<tr[^>]*>/gi, '')
      .replace(/<\/tr>/gi, '\n')
      .replace(/<\/t[dh]>\s*(?=<t[dh])/gi, ' | ');
  } else {
    text = text.replace(/<\/p>/gi, '\n');
  }
  text = text.replace(/<[^>]+>/g, '');
  for (const [pattern, replacement] of ENTITIES) text = text.replace(pattern, replacement);
  return text.replace(/[ \t]+/g, ' ');
}

/**
 * Strips a pack document's HTML to the plain text that becomes a chunk's
 * stored `text` (and therefore its content hash — read the header before
 * changing a byte). `style` is the caller's DECLARED convention; both declared
 * styles are pinned byte-for-byte by the differential table in
 * `tests/ingest/packs/html-to-text.test.ts`, which also pins the RETIRED
 * `at-label-last` notation beside them (docs/17 row 149).
 */
export function htmlToText(html: string, style: HtmlToTextStyle): string {
  const withoutNotation = resolveNotation(html, style.notation);
  const decoded = decodeTagsAndEntities(withoutNotation, style.blockAware);
  if (!style.blockAware) return decoded.trim();
  return decoded
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

// --- The document stream a pack file carries (docs/17 row 147) --------------

/**
 * A pack DATA file's documents: whole-file JSON when possible, otherwise
 * newline-delimited JSON (the older `.db` pack format, one document per line).
 *
 * An empty or whitespace-only file fails LOUDLY with that name; a line that
 * fails to parse fails the file loudly with its 1-BASED line number. The
 * invariant the JSON family has always held: **every non-empty input either
 * yields at least one document or throws** — a file can never come back
 * accounted NOWHERE. `parseYamlDocs` below now holds the same rule.
 */
export function parseJsonDocs(text: string, fileName: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed === '') throw new Error(`${fileName}: file is empty`);
  try {
    return [JSON.parse(trimmed) as unknown];
  } catch {
    // Fall through to NDJSON — this branch decides nothing, the loop below
    // still fails loudly per line.
  }
  const docs: unknown[] = [];
  for (const [index, line] of trimmed.split('\n').entries()) {
    const candidate = line.trim();
    if (candidate === '') continue;
    try {
      docs.push(JSON.parse(candidate) as unknown);
    } catch (error) {
      throw new Error(`${fileName}: line ${String(index + 1)} is not valid JSON: ${errorMessage(error)}`, { cause: error });
    }
  }
  return docs;
}

/**
 * A YAML file's documents (one per `---` document in the stream) via js-yaml's
 * `loadAll`.
 *
 * THE RULE, and it is data — the JSON family's own invariant, made true here
 * (docs/17 row 147):
 *
 * 1. **A stream that yields NO document at all is a LOUD file-level failure.**
 *    `js-yaml` returns `[]` for a comment-only file (`'# comment only'`) and
 *    for a purely blank one, so those are exactly the inputs this catches. Two
 *    dnd5e adapters used to DISAGREE here: one returned `[]`, and a file whose
 *    documents were ALL null came back as `{entries: 0, skipped: 0,
 *    failures: []}` through the per-file door (`packImport.ts`) — accounted
 *    NOWHERE, with no surface at all. AGENTS rule 1 forbids precisely that,
 *    and nothing pinned it.
 * 2. **A document that parses to `null` is RETURNED**, so the adapter counts it
 *    as a SKIP. A bare `---`, an explicit `null` and `'# c\n---\n# c2'` (a
 *    separator between two comment-only regions still DECLARES a document) are
 *    contentless, but they ARE documents: `skip` is the honest accounting for
 *    them, not a failure and not nothing. Never reintroduce
 *    `docs.filter((doc) => doc != null)` here — that filter IS the
 *    silent-drop defect, not a tidy-up.
 *
 * A whitespace-only file keeps the loud empty-file failure BOTH YAML bodies
 * already had, and an unparseable one keeps the foundry body's wording —
 * `invalid YAML: …`, the sentence a pre-existing test assertion already names
 * as a literal. The retired equipment body's `not valid YAML` is a SUPERSEDED
 * spelling of the same sentence (docs/17 row 147 records the choice).
 */
export function parseYamlDocs(text: string, fileName: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed === '') throw new Error(`${fileName}: file is empty`);
  let docs: unknown[];
  try {
    docs = loadAll(trimmed);
  } catch (error) {
    throw new Error(`${fileName}: invalid YAML: ${errorMessage(error)}`, { cause: error });
  }
  if (docs.length === 0) throw new Error(`${fileName}: no YAML document`);
  return docs;
}
