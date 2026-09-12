import { stripWikiLinks } from '@/lib/wikilinks';

/**
 * Minimal markdown → plain text (no WYSIWYG). This is the FAITHFUL-SOURCE
 * stripper: it removes markdown syntax and nothing else, so a wiki token
 * survives it as `[[…]]`. Use it where the text is not read as a document —
 * the deterministic image-prompt builder feeds the image API prose, never a
 * rendering. Anything a READER sees (every export path) goes through
 * `markdownToDisplayText` instead (docs/18 §2.3, docs/17 row 105).
 */
export function markdownToText(markdown: string): string {
  return markdown
    .replaceAll(/```[\s\S]*?```/g, (block) => block.replaceAll(/^```[a-z]*\n?|```$/gm, ''))
    .replaceAll(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replaceAll(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replaceAll(/^#{1,6}\s+/gm, '')
    .replaceAll(/\*\*([^*]+)\*\*/g, '$1')
    .replaceAll(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '$1')
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
