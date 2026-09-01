import type { Artifact } from '@/domain';

/**
 * Wiki-link syntax & resolution (08-MODULE-DESIGNER M4-A, pure): markdown
 * text contains `[[Name]]` or `[[Name|display text]]` — names only, never
 * IDs. Resolution is case-insensitive on artifact name first, then on any
 * alias; ambiguity resolves to the first match by `updatedAt` desc (the
 * reader marks such chips with a ⚠ tooltip listing the candidates).
 */

/** The wiki-link token pattern used everywhere (renderer, PDF, extraction). */
export const WIKI_LINK_PATTERN = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

export interface ExtractedWikiLink {
  /** The link target as written (trimmed). */
  name: string;
  /** The display text (trimmed) — the name when no `|display` was given. */
  display: string;
}

/** Extracts the wiki-links of a markdown text, deduped case-insensitively. */
export function extractWikiLinks(markdown: string): ExtractedWikiLink[] {
  const seen = new Set<string>();
  const links: ExtractedWikiLink[] = [];
  for (const match of markdown.matchAll(WIKI_LINK_PATTERN)) {
    const name = (match[1] ?? '').trim();
    if (name === '') continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const display = (match[2] ?? '').trim();
    links.push({ name, display: display === '' ? name : display });
  }
  return links;
}

/** Replaces each `[[Name]]`/`[[Name|display]]` token with its display text. */
export function stripWikiLinks(markdown: string): string {
  return markdown.replaceAll(WIKI_LINK_PATTERN, (_all, name: string, display?: string) => {
    const text = (display ?? '').trim();
    return text === '' ? name.trim() : text;
  });
}

/** A link-target rewrite: the token `[[from…]]` points at `to` instead. */
export interface LinkRewrite {
  /** The verbatim wiki-link name as extracted from the same text. */
  from: string;
  /** The canonical spelling the token's target becomes. */
  to: string;
}

/**
 * Rewrites wiki-link TARGETS per the given verdict (fix-01 "Applying a
 * verdict"), preserving the rendered prose: `[[from]]` becomes
 * `[[to|from]]` and `[[from|display]]` becomes `[[to|display]]` — the
 * display text is exactly what was written, so reader and PDF render
 * byte-identically. Matched in one pass against the token's trimmed name,
 * so a rewritten token is never re-matched. Tokens inside fenced code
 * blocks and inline code spans are untouched (mechanical text hygiene —
 * the verdict itself is never re-derived here).
 */
export function rewriteWikiLinkTargets(markdown: string, rewrites: readonly LinkRewrite[]): string {
  const byName = new Map<string, LinkRewrite>();
  for (const rewrite of rewrites) {
    // A self-mapping is not a rewrite — skip it rather than noise the text
    // up with a redundant [[Seggel|Seggel]] display.
    if (rewrite.from.trim().toLowerCase() === rewrite.to.trim().toLowerCase()) continue;
    byName.set(rewrite.from.trim(), rewrite);
  }
  if (byName.size === 0) return markdown;
  const rewriteSegment = (segment: string): string =>
    segment.replaceAll(WIKI_LINK_PATTERN, (whole, rawName: string, rawDisplay?: string) => {
      const rewrite = byName.get(rawName.trim());
      if (rewrite === undefined) return whole;
      const display = (rawDisplay ?? '').trim();
      return display === '' ? `[[${rewrite.to}|${rawName.trim()}]]` : `[[${rewrite.to}|${display}]]`;
    });
  // Odd segments are the captured code spans/blocks — left untouched.
  return markdown
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((segment, index) => (index % 2 === 1 ? segment : rewriteSegment(segment)))
    .join('');
}

/** One resolution outcome for a wiki-link name against the campaign artifacts. */
export interface WikiLinkResolution {
  status: 'resolved' | 'unresolved' | 'ambiguous';
  /** For resolved/ambiguous: the winning artifact (first by updatedAt desc). */
  artifact: Artifact | undefined;
  /** For ambiguous: every candidate, newest first. */
  candidates: Artifact[];
}

/**
 * Resolves a wiki-link name case-insensitively: exact artifact `name` first,
 * then aliases. Ties on `updatedAt` keep list order — callers pass artifacts
 * sorted `updatedAt` desc (or any deterministic order).
 */
export function resolveWikiLink(name: string, artifacts: readonly Artifact[]): WikiLinkResolution {
  const target = name.trim().toLowerCase();
  if (target === '') return { status: 'unresolved', artifact: undefined, candidates: [] };

  const byName = artifacts.filter((artifact) => artifact.name.trim().toLowerCase() === target);
  const byAlias = artifacts.filter((artifact) =>
    artifact.aliases.some((alias) => alias.trim().toLowerCase() === target),
  );
  // An artifact can match BOTH by name and by alias (e.g. its own old name
  // kept as an alias) — dedupe by id so it is one candidate, not two.
  const seen = new Set<Artifact['id']>();
  const candidates = newestFirst(
    [...byName, ...byAlias].filter((artifact) => {
      if (seen.has(artifact.id)) return false;
      seen.add(artifact.id);
      return true;
    }),
  );

  if (candidates.length === 0) {
    return { status: 'unresolved', artifact: undefined, candidates: [] };
  }
  return {
    status: candidates.length > 1 ? 'ambiguous' : 'resolved',
    artifact: candidates[0],
    candidates,
  };
}

/** Sorts artifacts by `updatedAt` desc without mutating the input. */
function newestFirst(artifacts: Artifact[]): Artifact[] {
  return [...artifacts].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** All wiki-link names of a markdown text (trimmed, deduped, in order). */
export function wikiLinkNames(markdown: string): string[] {
  return extractWikiLinks(markdown).map((link) => link.name);
}

/** Occurrences of a wiki-link name across a set of markdown documents. */
export interface WikiLinkOccurrence {
  /** Where it occurred ('premise' or `part-<planIndex>`). */
  where: string;
  count: number;
}

/** Counts occurrences of `name` per document (case-insensitive). */
export function countOccurrences(
  name: string,
  documents: readonly { where: string; markdown: string }[],
): WikiLinkOccurrence[] {
  const target = name.trim().toLowerCase();
  // A blank target would loop forever (`indexOf('', i)` never advances) and
  // matches nothing — return no occurrences instead.
  if (target === '') return [];
  const out: WikiLinkOccurrence[] = [];
  for (const document of documents) {
    const haystack = document.markdown.toLowerCase();
    let count = 0;
    let index = haystack.indexOf(target);
    while (index !== -1) {
      count += 1;
      index = haystack.indexOf(target, index + target.length);
    }
    if (count > 0) out.push({ where: document.where, count });
  }
  return out;
}

/** Splits markdown into sentences (period/exclamation/question boundaries). */
function sentences(markdown: string): string[] {
  return markdown
    .replaceAll(WIKI_LINK_PATTERN, (_all, name: string, display?: string) => {
      const text = (display ?? '').trim();
      return text === '' ? name.trim() : text;
    })
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '');
}

/**
 * The sentence containing the first occurrence of `name` (readable text —
 * wiki tokens are stripped to their display text). Empty when absent.
 */
export function sentenceAround(markdown: string, name: string): string {
  const target = name.trim().toLowerCase();
  if (target === '') return '';
  return (
    sentences(markdown).find((sentence) => sentence.toLowerCase().includes(target)) ?? ''
  );
}

/**
 * The paragraphs surrounding `name`'s occurrences (08 §M4-C persona briefs),
 * capped at ~1200 chars. Wiki tokens stay intact so the brief shows the
 * actual module text.
 */
export function surroundingParagraphs(
  markdown: string,
  name: string,
  cap = 1200,
): string {
  const target = name.trim().toLowerCase();
  if (target === '') return '';
  const paragraphs = markdown.split(/\n{2,}/).filter((paragraph) => {
    const plain = paragraph.toLowerCase().replaceAll(
      WIKI_LINK_PATTERN,
      (_all, n: string) => n.trim().toLowerCase(),
    );
    return plain.includes(target);
  });
  const joined = paragraphs.join('\n\n');
  return joined.length > cap ? `${joined.slice(0, cap)}…` : joined;
}

