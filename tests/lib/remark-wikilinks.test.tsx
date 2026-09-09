import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { WikiMarkdown } from '@/features/campaign/components/wiki-markdown';
import { remarkWikiLinks, splitWikiText, type WikiMdNode } from '@/lib/remark-wikilinks';

/**
 * Solo-token wiki-link tokenizing (module-reader literal-bracket fix).
 *
 * `transformChildren` used to skip any text node whose split produced a
 * single segment (`segments.length <= 1`) — which conflated "no match" (one
 * text segment) with "the whole run is exactly one token" (one wiki
 * segment). A token that is the ENTIRE content of one inline run (bare
 * `### [[Name]]` headings, solo `**[[Name]]**` lines) therefore never
 * produced a `#wiki:` link node and rendered as literal brackets.
 */

const NAME = 'Die Flucht vor den Nisselsporen';

function runPlugin(tree: WikiMdNode): WikiMdNode {
  remarkWikiLinks()(tree);
  return tree;
}

function paragraphWithText(value: string): WikiMdNode {
  return {
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'text', value }] }],
  };
}

/** Collects every `#wiki:` link node in the tree. */
function wikiLinkNodes(node: WikiMdNode): WikiMdNode[] {
  const found: WikiMdNode[] = [];
  if (node.type === 'link' && node.url?.startsWith('#wiki:')) found.push(node);
  for (const child of node.children ?? []) found.push(...wikiLinkNodes(child));
  return found;
}

/** Collects every remaining literal text node containing brackets. */
function bracketTextNodes(node: WikiMdNode): WikiMdNode[] {
  const found: WikiMdNode[] = [];
  if (node.type === 'text' && node.value?.includes('[[')) found.push(node);
  for (const child of node.children ?? []) found.push(...bracketTextNodes(child));
  return found;
}

describe('splitWikiText', () => {
  it('produces a single wiki segment when the whole run is exactly one token', () => {
    expect(splitWikiText(`[[${NAME}]]`)).toEqual([{ kind: 'wiki', name: NAME, display: NAME }]);
  });

  it('produces a single text segment when there is no token', () => {
    expect(splitWikiText('plain text')).toEqual([{ kind: 'text', value: 'plain text' }]);
  });
});

describe('remarkWikiLinks solo-token fix', () => {
  it('turns a solo token in a paragraph into a single #wiki: link node', () => {
    const tree = runPlugin(paragraphWithText(`[[${NAME}]]`));
    const links = wikiLinkNodes(tree);
    expect(links).toHaveLength(1);
    expect(links[0]?.url).toBe(`#wiki:${encodeURIComponent(NAME)}`);
    expect(bracketTextNodes(tree)).toHaveLength(0);
  });

  it('chips a bare-token heading line', () => {
    const tree = runPlugin({
      type: 'root',
      children: [
        { type: 'heading', children: [{ type: 'text', value: `[[${NAME}]]` }] },
      ],
    });
    const links = wikiLinkNodes(tree);
    expect(links).toHaveLength(1);
    expect(links[0]?.url).toBe(`#wiki:${encodeURIComponent(NAME)}`);
    expect(bracketTextNodes(tree)).toHaveLength(0);
  });

  it('chips a solo token inside strong markup', () => {
    const tree = runPlugin({
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'strong', children: [{ type: 'text', value: `[[${NAME}]]` }] }],
        },
      ],
    });
    const links = wikiLinkNodes(tree);
    expect(links).toHaveLength(1);
    expect(bracketTextNodes(tree)).toHaveLength(0);
  });

  it('control: a token with prefix text chips (already worked before the fix)', () => {
    const tree = runPlugin(paragraphWithText(`Encounter: [[${NAME}]]`));
    const links = wikiLinkNodes(tree);
    expect(links).toHaveLength(1);
    expect(bracketTextNodes(tree)).toHaveLength(0);
  });

  it('control: plain text without a token stays a single text node', () => {
    const tree = runPlugin(paragraphWithText('plain text'));
    expect(wikiLinkNodes(tree)).toHaveLength(0);
    expect(tree.children?.[0]?.children).toEqual([{ type: 'text', value: 'plain text' }]);
  });

  it('control: a token nested inside markdown link text stays literal', () => {
    const tree = runPlugin({
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'link',
              url: 'https://example.com',
              children: [{ type: 'text', value: `[[${NAME}]]` }],
            },
          ],
        },
      ],
    });
    expect(wikiLinkNodes(tree)).toHaveLength(0);
    expect(bracketTextNodes(tree)).toHaveLength(1);
  });

  it('control: inline code spans stay literal', () => {
    const tree = runPlugin({
      type: 'root',
      children: [
        { type: 'paragraph', children: [{ type: 'inlineCode', value: `[[${NAME}]]` }] },
      ],
    });
    expect(wikiLinkNodes(tree)).toHaveLength(0);
    expect(tree.children?.[0]?.children).toEqual([{ type: 'inlineCode', value: `[[${NAME}]]` }]);
  });

  it('control: fenced code blocks stay literal', () => {
    const tree = runPlugin({
      type: 'root',
      children: [{ type: 'code', value: `Example: [[${NAME}]] stays` }],
    });
    expect(wikiLinkNodes(tree)).toHaveLength(0);
    expect(tree.children).toEqual([{ type: 'code', value: `Example: [[${NAME}]] stays` }]);
  });
});

describe('WikiMarkdown solo-token heading', () => {
  it('renders a bare-token heading as a chip, not literal brackets', () => {
    render(<WikiMarkdown value={`### [[${NAME}]]`} artifacts={[]} />);
    const chip = screen.getByTestId('wiki-chip-unresolved');
    expect(chip).toHaveAttribute('data-wiki-name', NAME);
    expect(screen.queryByText(`[[${NAME}]]`)).not.toBeInTheDocument();
  });
});
