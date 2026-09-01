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

/** Minimal structural mdast node (enough to walk inline text). */
export interface WikiMdNode {
  type: string;
  value?: string | undefined;
  url?: string | undefined;
  title?: string | null | undefined;
  children?: WikiMdNode[] | undefined;
}

type WikiSegment =
  | { kind: 'text'; value: string }
  | { kind: 'wiki'; name: string; display: string };

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
      segments.push({ kind: 'wiki', name, display: display === '' ? name : display });
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

/** Builds the mdast link node for one wiki-link. */
export function wikiLinkNode(name: string, display: string): WikiMdNode {
  return {
    type: 'link',
    url: wikiHref(name),
    title: null,
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
    if (segments.length <= 1) continue;
    const replacement = segments.map((segment): WikiMdNode =>
      segment.kind === 'text'
        ? { type: 'text', value: segment.value }
        : wikiLinkNode(segment.name, segment.display),
    );
    children.splice(index, 1, ...replacement);
    index += replacement.length - 1;
  }
}
