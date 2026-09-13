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
 * ## This is a BYTE-PRESERVING refactor, and that is not optional
 *
 * The text this returns becomes `PackEntry.text` → the stored chunk `text` →
 * `contentHash = sha256Hex(text)`, stamped at import (`packImport.ts`) and
 * again when a citation is born (`encounterResolve.ts`). `resolveMonsterEntry`
 * resolves a citation by uuid first and then by EXACT content hash, and a
 * campaign bundle export treats an unresolvable citation as BLOCKING
 * (`exportDependencies.ts`, `exportImport.ts` throws `MissingDependenciesError`).
 * A changed byte therefore strands every stored citation on the next re-import,
 * with no heal path (docs/11's L1 "same creature, new hash" is deferred and no
 * contentHash re-stamp migration exists). So the two styles below reproduce
 * their former copies EXACTLY, defects included; the divergences are DECLARED
 * here rather than quietly repaired. Fixing them is a separate landing that
 * owns the re-import story (docs/17 row 143).
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
 *   (`@UUID[…]{Enfeebled 1}` → `Enfeebled{Enfeebled 1}`), which is the KNOWN,
 *   still-unfixed PF2e-item behaviour (see `blockAware` below and docs/17
 *   row 143; the fixture that shows it is
 *   `tests/fixtures/packs/pf2e-equipment/anointing-oil.json`).
 * - `at-brace-label` — the same `@`-notation rule, but a brace form wins first:
 *   `@UUID[a.b.C]{Label}` → `Label`. This is the rules-text convention.
 * - `bracket-links` — the dnd5e document dialect: `[[target]]{Label}` → `Label`,
 *   `[[target|label]]` → the LAST label segment, `[[target]]` (no label
 *   segment) → nothing, `&reference[target]` → `target`, and then the
 *   `at-label-last` rule for any remaining `@`-notation.
 */
export type HtmlNotation = 'at-label-last' | 'at-brace-label' | 'bracket-links';

/**
 * One HTML→text style: the minimum needed to reproduce the behaviours that
 * existed as seven copies. Both values of both axes are declared by a real
 * call site — there is no dead flag here.
 */
export interface HtmlToTextStyle {
  readonly notation: HtmlNotation;
  /**
   * `false` — line breaks only: `<hr>`/`<br>`/`</p>` become `\n` and every
   * other tag is dropped with nothing, so block structure and TABLES are lost
   * (`<td>` cells run together). No blank-line collapse, no per-line trim.
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
 * The THREE styles the ingest layer declares — the divergence as DATA, in one
 * place, instead of seven copies. All three are in use by real call sites; a
 * fourth adapter picks one of these BY NAME rather than declaring its own
 * combination, because a new style is a behaviour change and belongs with the
 * re-import story (docs/17 row 143). The three are pinned byte-for-byte by the
 * differential table in `tests/ingest/packs/html-to-text.test.ts`.
 */

/** PF2e item/creature descriptions: `@Type[a.b.C|…]` → `C`, line breaks only.
 *  A brace label survives verbatim and a table's cells run together — the
 *  KNOWN, still-unfixed behaviour (landing 2), not an accident. */
export const AT_LABEL_LAST_LINE_BREAKS: HtmlToTextStyle = {
  notation: 'at-label-last',
  blockAware: false,
};

/** dnd5e item/creature descriptions: `[[…]]{L}` / `[[…|l]]` / `&reference[…]`
 *  resolve first, then `@Type[…|…]` → the last segment; line breaks only. */
export const BRACKET_LINKS_LINE_BREAKS: HtmlToTextStyle = {
  notation: 'bracket-links',
  blockAware: false,
};

/** PF2e rules text (journals, conditions, the feat/spell/action corpus):
 *  `@Type[…]{Label}` → `Label`, and block/table structure survives. */
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
 * A `{Label}` suffix is deliberately NOT matched here: for `at-label-last`
 * this pattern leaves the brace text behind as ordinary text, which is exactly
 * what the PF2e item copies did.
 */
function resolveAtLabelLast(html: string): string {
  return html.replace(/@(\w+)\[([^\]]*)\]/g, (_match, _kind: string, inner: string) => {
    const beforePipe = inner.split('|')[0] ?? '';
    return beforePipe.split('.').pop() ?? '';
  });
}

/** Applies the declared inline-notation dialect, in the order that dialect needs. */
function resolveNotation(html: string, notation: HtmlNotation): string {
  switch (notation) {
    case 'at-label-last':
      return resolveAtLabelLast(html);
    case 'at-brace-label':
      return resolveAtLabelLast(
        html.replace(
          /@(\w+)\[([^\]]*)\]\{([^}]*)\}/g,
          (_match, _kind: string, _inner: string, label: string) => label,
        ),
      );
    case 'bracket-links':
      return resolveAtLabelLast(
        html
          .replace(/\[\[[^\]]*\]\]\{([^}]*)\}/g, '$1')
          .replace(/\[\[([^\]]*)\]\]/g, (_match, inner: string) => {
            // [[/condition conditions:Incapacitated|incapacitated]] → last label;
            // bracket links without a label segment render as nothing.
            const segments = inner.split('|');
            return segments.length > 1 ? (segments[segments.length - 1] ?? '') : '';
          })
          .replace(/&(amp;)?reference\[([^\]]*)\]/g, '$2'),
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
 * changing a byte). `style` is the caller's DECLARED convention; all three
 * declared styles are pinned byte-for-byte by the differential table in
 * `tests/ingest/packs/html-to-text.test.ts`.
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
