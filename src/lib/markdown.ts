import { stripWikiLinks } from '@/lib/wikilinks';

/**
 * The `*soft emphasis*` rule, and the ONE place this file used to reason in
 * ASCII (docs/17 row 162).
 *
 * `\w` is ASCII-only in JavaScript — `[A-Za-z0-9_]` whatever the flags — so
 * `(?<!\w)`/`(?!\w)` asked "is the neighbouring character a LATIN-ASCII
 * letter" where the author of the text meant "is it a LETTER". Measured on the
 * pre-slice code: `Ein Gruß* aus Wien, und ein Spaß* für alle.` printed WITHOUT
 * its two asterisks (a word-final `ß` is not a `\w` character, so the `*` after
 * it read as an emphasis delimiter), while the English line of the same shape
 * kept both. A rule that only holds in English is not a rule (the owner's
 * mandate, verbatim: *"This should really work in any language."*).
 *
 * `[\p{L}\p{N}_]` is `\w`'s Unicode spelling, and it is not a loosening: on
 * ASCII input the two classes pick out EXACTLY the same characters, which is
 * pinned as a bounded-exhaustive differential over the emphasis grammar
 * (`tests/lib/unicodeTextHygiene.test.ts`) rather than promised here.
 */
const EMPHASIS_PATTERN = /(?<![\p{L}\p{N}_])\*([^*\n]+)\*(?![\p{L}\p{N}_])/gu;

/**
 * Minimal markdown → plain text (no WYSIWYG). This is the FAITHFUL-SOURCE
 * stripper: it removes markdown syntax and nothing else, so a wiki token
 * survives it as `[[…]]`. Use it where the text is not read as a document —
 * the deterministic image-prompt builder feeds the image API prose, never a
 * rendering. Anything a READER sees (every export path) goes through
 * `markdownToDisplayText` instead (docs/18 §2.3, docs/17 row 105).
 *
 * The fence rule strips the info string with `[^\n]*` where it used to spell
 * `[a-z]*`; an info string is machine metadata (`js`, `ts`), never prose, so a
 * fence written `\`\`\`JS` printed its `JS` to a reader as text. Deliberate
 * behaviour change, named in `tests/lib/unicodeTextHygiene.test.ts` (docs/17
 * row 162) — the same slice's ASCII-only-text sweep.
 */
export function markdownToText(markdown: string): string {
  return markdown
    .replaceAll(/```[\s\S]*?```/g, (block) => block.replaceAll(/^```[^\n]*\n?|```$/gm, ''))
    .replaceAll(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replaceAll(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replaceAll(/^#{1,6}\s+/gm, '')
    .replaceAll(/\*\*([^*]+)\*\*/g, '$1')
    .replaceAll(EMPHASIS_PATTERN, '$1')
    .replaceAll(/(?<!_)_([^_\n]+)_(?!_)/g, '$1')
    .replaceAll(/`([^`]+)`/g, '$1')
    .trim();
}

/**
 * Markdown → the text a READER sees: the DISPLAY text of every wiki token —
 * `[[Name]]` → the name, `[[Name|display]]` → the display, via
 * `lib/wikilinks.stripWikiLinks`, the ONE wiki-strip implementation (never a
 * second `\[\[…\]\]` regex) — and then `markdownToText` for the markdown
 * syntax.
 *
 * A PDF, a text export and a handout are RENDERINGS, so they print the
 * display and never the token: the token is the app's INTERNAL representation
 * (`[[…]]`), and one that reaches a reader is a leaked internal — the module /
 * module-PDF pipeline has rendered the display since `mdToPdfmake` existed,
 * and this function is what makes the single-artifact export agree with it
 * (docs/18 §2.3, docs/07 §Wiki-links in an exported document, docs/17 row 105).
 *
 * The token stage runs FIRST, and the order is MEASURED, not taste: on every
 * ordinary input the two orders agree, and the one input where they differ —
 * a token inside a markdown link's text, `[see [[Ash Gate]]](url)` — leaves
 * raw `[see Ash Gate](url)` markdown in the body under the other order, i.e.
 * the same class of leak this function exists to close. Stripping the token
 * first means the markdown stage always sees the prose a reader sees.
 *
 * Text that merely LOOKS like a token — `[[ not even this one`, an unclosed
 * `[[` — is not a token and stays literal (`stripWikiLinks`' own rule). Code
 * spans and fences get no carve-out: this is the plain-TEXT pipeline, which
 * has no code style at all (`markdownToText` already unwraps `` `…` `` and
 * strips emphasis inside a fence), so a token inside one is ordinary text —
 * a DELIBERATE divergence from `mdToPdfmake`, whose code branch keeps it
 * literal, recorded in docs/17 row 105.
 */
export function markdownToDisplayText(markdown: string): string {
  return markdownToText(stripWikiLinks(markdown));
}
