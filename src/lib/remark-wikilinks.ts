import { WIKI_LINK_PATTERN } from '@/lib/wikilinks';

/**
 * remark transform for wiki-links (08-MODULE-DESIGNER M4-A): turns
 * `[[Name]]` / `[[Name|display]]` text runs into markdown link nodes whose
 * href is `#wiki:<name>` — the single shared pipeline every wiki-aware
 * markdown render goes through (`WikiMarkdown`). Text inside code spans,
 * code fences and existing links is left untouched.
 *
 * Typed with a minimal structural view of the mdast tree: no transitive
 * `mdast` type imports.
 */

/**
 * The hast attribute a chipped wiki-link carries its byte-exact source token
 * on (`WikiMarkdown` reads it back for the chip's hover tooltip). ONE constant
 * so the producer and the consumer can never drift apart.
 */
export const WIKI_RAW_ATTRIBUTE = 'data-wiki-raw';

/** Minimal structural mdast node (enough to walk inline text). */
export interface WikiMdNode {
  type: string;
  value?: string | undefined;
  url?: string | undefined;
  title?: string | null | undefined;
  children?: WikiMdNode[] | undefined;
  /**
   * The node's `data` — the ONE supported mdast→hast route for custom
   * properties on a node whose type already has a handler:
   * `mdast-util-to-hast`'s `applyData` merges `data.hProperties` into the
   * element it produced, and `hast-util-to-jsx-runtime` hands those to the
   * React component. MEASURED at HEAD (scratch probe against react-markdown
   * 10.1.0 / mdast-util-to-hast 13.2.1): a `link` node carrying
   * `data.hProperties['data-wiki-raw']` renders
   * `<a href="#wiki:…" data-wiki-raw="[[Name|display]]">` and the `a`
   * component receives `href, data-wiki-raw, node, children`. Typed as a
   * deliberate minimal view — no transitive mdast/hast type imports.
   */
  data?: { hProperties?: Record<string, string> | undefined } | undefined;
}

type WikiSegment =
  | { kind: 'text'; value: string }
  /** `raw` is the byte-exact token as written, spacing included — the ONLY
   * copy of the source text once the run is split (see `wikiLinkNode`). */
  | { kind: 'wiki'; name: string; display: string; raw: string };

/** Splits inline text into plain-text and wiki-link segments. */
export function splitWikiText(value: string): WikiSegment[] {
  const segments: WikiSegment[] = [];
  let last = 0;
  for (const match of value.matchAll(WIKI_LINK_PATTERN)) {
    const index = match.index;
    if (index > last) segments.push({ kind: 'text', value: value.slice(last, index) });
    const name = (match[1] ?? '').trim();
    const display = (match[2] ?? '').trim();
    if (name !== '') {
      // `match[0]` is the token BYTE-EXACT (inner spacing the parser trims
      // included) and is the last place it exists — carry it, never
      // reconstruct it from name+display.
      segments.push({
        kind: 'wiki',
        name,
        display: display === '' ? name : display,
        raw: match[0],
      });
    } else {
      segments.push({ kind: 'text', value: match[0] });
    }
    last = index + match[0].length;
  }
  if (last < value.length) segments.push({ kind: 'text', value: value.slice(last) });
  return segments;
}

/** The href encoding for a wiki-link node (decoded by the renderer). */
export function wikiHref(name: string): string {
  return `#wiki:${encodeURIComponent(name)}`;
}

/**
 * Builds the mdast link node for one wiki-link.
 *
 * `raw` is the token exactly as the author wrote it (`[[ Ash Gate |the
 * gate]]` — the name and display are TRIMMED for resolution and for the chip
 * label, the token is not). It rides the node's `data.hProperties`, the one
 * supported mdast→hast route for custom properties (`mdast-util-to-hast`'s
 * `applyData`), so it reaches the rendered element as `data-wiki-raw` and
 * `WikiMarkdown` can put it in the chip's tooltip. It is NOT recoverable from
 * `name` + `display`: the plugin is the last point where the source bytes
 * exist.
 */
export function wikiLinkNode(name: string, display: string, raw: string): WikiMdNode {
  return {
    type: 'link',
    url: wikiHref(name),
    title: null,
    data: { hProperties: { [WIKI_RAW_ATTRIBUTE]: raw } },
    children: [{ type: 'text', value: display }],
  };
}

/** The remark plugin: `remarkPlugins={[remarkWikiLinks]}`. */
export function remarkWikiLinks(): (tree: WikiMdNode) => void {
  return (tree) => {
    transformChildren(tree, false);
  };
}

function transformChildren(node: WikiMdNode, insideLink: boolean): void {
  const children = node.children;
  if (children === undefined) return;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child === undefined) continue;
    if (!insideLink) transformChildren(child, child.type === 'link');
    if (insideLink || child.type !== 'text' || typeof child.value !== 'string') continue;
    if (!child.value.includes('[[')) continue;
    const segments = splitWikiText(child.value);
    // A single segment means "no token" only when it is TEXT: a run that is
    // exactly one token splits to a single WIKI segment and must still chip
    // (bare `### [[Name]]` headings, solo `**[[Name]]**` lines).
    if (!segments.some((segment) => segment.kind === 'wiki')) continue;
    const replacement = segments.map((segment): WikiMdNode =>
      segment.kind === 'text'
        ? { type: 'text', value: segment.value }
        : wikiLinkNode(segment.name, segment.display, segment.raw),
    );
    children.splice(index, 1, ...replacement);
    index += replacement.length - 1;
  }
}
