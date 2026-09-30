import 'fake-indexeddb/auto';

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { AnyArtifact } from '@/domain';
import {
  resolveSelectionRange,
  SOURCE_FROM_ATTRIBUTE,
  SOURCE_MAP_REFUSALS,
  SOURCE_TO_ATTRIBUTE,
  WikiMarkdown,
} from '@/features/campaign/components/wiki-markdown';
import type { DomPoint } from '@/features/campaign/components/wiki-markdown';

/**
 * The source map (docs/17 row 102): a rendered DOM selection inside the canvas
 * PREVIEW resolves back to the exact markdown SOURCE range the module text
 * holds — byte-exact, or a NAMED refusal with nothing written.
 *
 * Every case here is a REAL render (react-markdown, the wiki plugin, the
 * source-span wrapper) with a REAL DOM Range built over the rendered nodes —
 * never a hand-made element tree, and never geometry: jsdom has no layout, so
 * anything that needed `getBoundingClientRect` or `caretRangeFromPoint` would
 * be untestable here and would ship unproven. Offsets are walked.
 */

afterEach(cleanup);

/** A point in the rendered DOM, from the first text node whose data contains
 * `needle` (occurrence-counted) plus a delta inside that node. */
function pointAt(root: HTMLElement, needle: string, delta = 0, occurrence = 0): DomPoint {
  let seen = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const index = (node.nodeValue ?? '').indexOf(needle);
    if (index === -1) continue;
    if (seen < occurrence) {
      seen += 1;
      continue;
    }
    return { node, offset: index + delta };
  }
  throw new Error(`no text node contains ${JSON.stringify(needle)}`);
}

/** The chip button whose token is `raw`, as the preview renders it. */
function chipOf(root: HTMLElement, raw: string): HTMLElement {
  const chip = root.querySelector(`[data-wiki-raw="${raw}"]`);
  if (chip === null) throw new Error(`no chip for ${raw}`);
  return chip as HTMLElement;
}

function firstTextNodeWithin(element: HTMLElement): Text {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const node = walker.nextNode();
  if (node === null) throw new Error('no text node inside the element');
  return node as Text;
}

/** Renders a part the way the canvas preview does (opt-in map ON). */
function renderPart(value: string, artifacts: readonly AnyArtifact[] = []): HTMLElement {
  const { container } = render(<WikiMarkdown value={value} artifacts={artifacts} sourceOffsets />);
  const root = container.firstElementChild;
  if (root === null) throw new Error('WikiMarkdown rendered nothing');
  return root as HTMLElement;
}

/** The rendered TEXT of the whole render — the "no text changed" witness. */
function renderedText(root: HTMLElement): string {
  // textContent is always a string for an Element (never null).
  return root.textContent;
}

const PART = 'The party bargains with [[Keeper Ilse|the keeper]] at the gate.\n\nThe rain hammers the stones.';

describe('rendered selection → source range (byte-exact)', () => {
  it('maps a selection inside a plain paragraph, character for character', () => {
    const root = renderPart(PART);
    // "bargains" → the end of "gate."
    const result = resolveSelectionRange(
      PART,
      pointAt(root, 'bargains'),
      pointAt(root, 'gate.', 5),
    );
    expect(result).toEqual({ status: 'mapped', from: 10, to: 63 });
    expect(PART.slice(10, 63)).toBe('bargains with [[Keeper Ilse|the keeper]] at the gate.');
  });

  it('maps across an emphasis run — the markdown syntax INSIDE the span is included', () => {
    const value = 'A **bold** word and *italic* text.';
    const root = renderPart(value);
    const result = resolveSelectionRange(
      value,
      pointAt(root, 'bold'),
      pointAt(root, 'italic', 'italic'.length),
    );
    // The rendered text reads "bold word and italic"; the SOURCE span carries
    // the `**` and `*` markers, because those bytes are what a replacement
    // would have to replace.
    expect(result).toEqual({ status: 'mapped', from: 4, to: 27 });
    expect(value.slice(4, 27)).toBe('bold** word and *italic');
  });

  it('maps a chip inside the selected range to the [[…]] TOKEN, never the display text', () => {
    const root = renderPart(PART);
    const start = pointAt(root, 'bargains');
    const end = pointAt(root, 'at the gate.', 'at'.length);
    const result = resolveSelectionRange(PART, start, end);
    expect(result.status).toBe('mapped');
    if (result.status !== 'mapped') return;
    const source = PART.slice(result.from, result.to);
    expect(source).toBe('bargains with [[Keeper Ilse|the keeper]] at');
    // The display text the DOM shows is NOT a source substring of the mapping:
    // the token is what lives in the source (and what the tooltip shows).
    expect(source).toContain('[[Keeper Ilse|the keeper]]');
    expect(root.textContent).toContain('the keeper'); // the DOM really shows the label
  });

  it('maps a selection that is EXACTLY one chip to that chip’s whole token', () => {
    const root = renderPart(PART);
    const chip = chipOf(root, '[[Keeper Ilse|the keeper]]');
    const label = firstTextNodeWithin(chip);
    expect(label.nodeValue).toBe('the keeper');
    const result = resolveSelectionRange(
      PART,
      { node: label, offset: 0 },
      { node: label, offset: 'the keeper'.length },
    );
    // 24 = the token's start, 50 = its end. NOT the label's position, NOT 0.
    expect(result).toEqual({ status: 'mapped', from: 24, to: 50 });
    expect(PART.slice(24, 50)).toBe('[[Keeper Ilse|the keeper]]');
  });

  it('maps a resolved chip (label inside a span, cover thumb before it) the same way', () => {
    const value = 'See [[Keeper Ilse]] now.';
    const artifact = {
      id: 'artifact-1',
      campaignId: 'campaign-1',
      kind: 'npc',
      name: 'Keeper Ilse',
      summary: '',
      body: '',
      tags: [],
      aliases: [],
      coverImageId: null,
      imageIds: [],
      createdAt: 0,
      updatedAt: 0,
    } as unknown as AnyArtifact;
    const root = renderPart(value, [artifact]);
    const chip = chipOf(root, '[[Keeper Ilse]]');
    const label = firstTextNodeWithin(chip);
    const result = resolveSelectionRange(
      value,
      { node: label, offset: 0 },
      { node: label, offset: 'Keeper Ilse'.length },
    );
    expect(result).toEqual({ status: 'mapped', from: 4, to: 19 });
    expect(value.slice(4, 19)).toBe('[[Keeper Ilse]]');
  });

  it('maps a multi-line selection across two paragraphs, newlines included', () => {
    const root = renderPart(PART);
    const result = resolveSelectionRange(
      PART,
      pointAt(root, 'bargains'),
      pointAt(root, 'hammers', 'hammers'.length),
    );
    expect(result.status).toBe('mapped');
    if (result.status !== 'mapped') return;
    expect(PART.slice(result.from, result.to)).toBe(
      'bargains with [[Keeper Ilse|the keeper]] at the gate.\n\nThe rain hammers',
    );
  });

  it('maps boundaries at run edges exactly (whole runs, and the whole text)', () => {
    const value = 'One **two** three.';
    const root = renderPart(value);
    // The first run ("One ") as a whole: element-edge and text-edge agree.
    const first = pointAt(root, 'One ');
    const afterFirst = { node: first.node, offset: 'One '.length };
    expect(resolveSelectionRange(value, first, afterFirst)).toEqual({
      status: 'mapped',
      from: 0,
      to: 4,
    });
    expect(value.slice(0, 4)).toBe('One ');
    // Everything: run start → last run end = the whole source.
    const whole = resolveSelectionRange(value, first, pointAt(root, 'three.', 'three.'.length));
    expect(whole).toEqual({ status: 'mapped', from: 0, to: value.length });
    // The last run alone (" three." — the leading space belongs to it) as a
    // whole: it starts right after the closing `**` and ends after the ".".
    const last = resolveSelectionRange(
      value,
      pointAt(root, 'three.'),
      pointAt(root, 'three.', 'three.'.length),
    );
    expect(last).toEqual({ status: 'mapped', from: 12, to: 18 });
    expect(value.slice(12, 18)).toBe('three.');
  });

  it('maps an element-level boundary on a run as the exact source offset', () => {
    const value = 'One **two** three.';
    const root = renderPart(value);
    const runs = Array.from(root.querySelectorAll<HTMLElement>(`[${SOURCE_FROM_ATTRIBUTE}]`));
    expect(runs).toHaveLength(3);
    const middle = runs[1];
    if (middle === undefined) throw new Error('no middle run');
    // The run wraps the literal TEXT node, not the `**` markers around it:
    // emphasis syntax is source BETWEEN runs, exactly as the markdown says.
    expect(middle.getAttribute(SOURCE_FROM_ATTRIBUTE)).toBe('6');
    expect(middle.getAttribute(SOURCE_TO_ATTRIBUTE)).toBe('9');
    // Before the middle run's first child == the run's start.
    const head = resolveSelectionRange(
      value,
      { node: middle, offset: 0 },
      pointAt(root, 'three.', 'three.'.length),
    );
    expect(head.status).toBe('mapped');
    if (head.status !== 'mapped') return;
    expect(value.slice(head.from, head.to)).toBe('two** three.');
  });
});

describe('refusals: a mapping that is not exact writes nothing', () => {
  it('refuses a selection inside a code span (no source-mapped text there)', () => {
    const value = 'Use the `gate` word.';
    const root = renderPart(value);
    const result = resolveSelectionRange(
      value,
      pointAt(root, 'gate'),
      pointAt(root, 'gate', 'gate'.length),
    );
    expect(result).toEqual({ status: 'refused', reason: SOURCE_MAP_REFUSALS.unmapped });
  });

  it('refuses a point strictly inside a chip’s label — never rounds to the token', () => {
    const root = renderPart(PART);
    const label = firstTextNodeWithin(chipOf(root, '[[Keeper Ilse|the keeper]]'));
    // "the keeper" selected from its second character: the DOM point is inside
    // the token, and the token is atomic in the source.
    const result = resolveSelectionRange(
      PART,
      { node: label, offset: 1 },
      { node: label, offset: 'the keeper'.length },
    );
    expect(result).toEqual({ status: 'refused', reason: SOURCE_MAP_REFUSALS.insideChip });
    // …and the end-boundary case refuses too.
    expect(
      resolveSelectionRange(PART, pointAt(root, 'bargains'), { node: label, offset: 3 }),
    ).toEqual({ status: 'refused', reason: SOURCE_MAP_REFUSALS.insideChip });
  });

  it('refuses a collapsed selection', () => {
    const root = renderPart(PART);
    const point = pointAt(root, 'bargains');
    expect(resolveSelectionRange(PART, point, point)).toEqual({
      status: 'refused',
      reason: SOURCE_MAP_REFUSALS.empty,
    });
  });

  it('refuses a run whose rendered text does not reproduce its source (an escape)', () => {
    const value = 'A literal \\* star.';
    const root = renderPart(value);
    // The render shows "A literal * star."; the source carries the escape, so
    // the run's pieces CANNOT be folded back onto it exactly.
    expect(renderedText(root)).toContain('A literal * star.');
    const result = resolveSelectionRange(
      value,
      pointAt(root, 'literal'),
      pointAt(root, 'star', 'star'.length),
    );
    expect(result).toEqual({ status: 'refused', reason: SOURCE_MAP_REFUSALS.mismatch });
  });

  it('refuses an entity that the renderer decoded', () => {
    const value = 'Fish &amp; chips.';
    const root = renderPart(value);
    expect(renderedText(root)).toContain('Fish & chips.');
    const result = resolveSelectionRange(value, pointAt(root, 'Fish'), pointAt(root, 'chips', 5));
    expect(result).toEqual({ status: 'refused', reason: SOURCE_MAP_REFUSALS.mismatch });
  });
});

describe('refusals: the byte proof is CONTENT, not just length', () => {
  /**
   * The plugin's own output cannot produce a same-length divergence through
   * the real pipeline (an escape or an entity changes the length, and both are
   * pinned above), so these pins build the DOM by hand: a run that CLAIMS a
   * source range its characters do not hold. That is exactly the shape a
   * length-only check accepts — a silent mis-map — and each pin contrasts it
   * with the SAME DOM carrying the bytes it claims, so a broken fixture cannot
   * pass the refusal by accident.
   */
  it('refuses a run whose text has the right length but the wrong characters', () => {
    const host = document.createElement('div');
    const run = document.createElement('span');
    run.setAttribute(SOURCE_FROM_ATTRIBUTE, '0');
    run.setAttribute(SOURCE_TO_ATTRIBUTE, '4');
    run.textContent = 'Thex';
    host.append(run);
    document.body.append(host);

    const wrong = run.firstChild;
    if (wrong === null) throw new Error('the synthetic run has no text node');
    expect(
      resolveSelectionRange('The ', { node: wrong, offset: 0 }, { node: wrong, offset: 4 }),
    ).toEqual({ status: 'refused', reason: SOURCE_MAP_REFUSALS.mismatch });

    run.textContent = 'The ';
    const right = run.firstChild;
    if (right === null) throw new Error('the re-texted run has no text node');
    expect(
      resolveSelectionRange('The ', { node: right, offset: 0 }, { node: right, offset: 4 }),
    ).toEqual({ status: 'mapped', from: 0, to: 4 });
    host.remove();
  });

  it('refuses a run whose pieces do not add up to the range it claims', () => {
    const host = document.createElement('div');
    const run = document.createElement('span');
    // The run CLAIMS ten source characters but holds four: every piece matches
    // its own slice, so only the total can catch it — and a selection at the
    // run's own end would otherwise answer with the last piece's end instead of
    // the range the run states.
    run.setAttribute(SOURCE_FROM_ATTRIBUTE, '0');
    run.setAttribute(SOURCE_TO_ATTRIBUTE, '10');
    run.textContent = 'The ';
    host.append(run);
    document.body.append(host);

    const text = run.firstChild;
    if (text === null) throw new Error('the synthetic run has no text node');
    expect(
      resolveSelectionRange('The xxxxxx', { node: text, offset: 0 }, { node: run, offset: 1 }),
    ).toEqual({ status: 'refused', reason: SOURCE_MAP_REFUSALS.mismatch });

    run.setAttribute(SOURCE_TO_ATTRIBUTE, '4');
    expect(
      resolveSelectionRange('The xxxxxx', { node: text, offset: 0 }, { node: run, offset: 1 }),
    ).toEqual({ status: 'mapped', from: 0, to: 4 });
    host.remove();
  });

  it('refuses a chip piece whose token is not the source bytes there', () => {
    const host = document.createElement('div');
    const run = document.createElement('span');
    run.setAttribute(SOURCE_FROM_ATTRIBUTE, '0');
    run.setAttribute(SOURCE_TO_ATTRIBUTE, '13');
    const text = document.createTextNode('with ');
    const chip = document.createElement('button');
    chip.setAttribute('data-wiki-raw', '[[Kals]]');
    chip.textContent = 'Kals';
    run.append(text, chip);
    host.append(run);
    document.body.append(host);

    // The text piece alone maps (the fixture works).
    expect(
      resolveSelectionRange('with [[Kals]]', { node: text, offset: 0 }, { node: text, offset: 5 }),
    ).toEqual({ status: 'mapped', from: 0, to: 5 });
    // A point on the chip's own outer boundary says the whole token — but only
    // when the token IS the source there.
    expect(
      resolveSelectionRange(
        'with [[Kals]]',
        { node: text, offset: 0 },
        { node: chip, offset: chip.childNodes.length },
      ),
    ).toEqual({ status: 'mapped', from: 0, to: 13 });
    expect(
      resolveSelectionRange(
        'with [[Kral]]',
        { node: text, offset: 0 },
        { node: chip, offset: chip.childNodes.length },
      ),
    ).toEqual({ status: 'refused', reason: SOURCE_MAP_REFUSALS.mismatch });
    host.remove();
  });
});

describe('reader parity: the map is opt-in and changes no rendered text', () => {
  it('renders the reader path byte-identically, with no wrapper and no attributes', () => {
    const value = 'One **two** [[Keeper Ilse|the keeper]] three.';
    const reader = render(<WikiMarkdown value={value} artifacts={[]} />);
    const readerRoot = reader.container.firstElementChild;
    // The EXACT reader output: no source-run spans, no data-md-* attributes.
    // This is the pin that keeps the reader (ModuleReaderPage, the peek modal,
    // the board, artifact bodies) out of the mapping's way.
    expect(readerRoot?.innerHTML).toBe(
      '<p>One <strong>two</strong> <button type="button" data-testid="wiki-chip-unresolved" ' +
        'data-wiki-name="Keeper Ilse" data-wiki-raw="[[Keeper Ilse|the keeper]]" class="mx-0.5 inline-flex max-w-full items-center gap-1 ' +
        'rounded-full border px-1.5 py-0.5 align-baseline text-[0.9em] font-medium ' +
        'whitespace-nowrap border-dashed border-muted-foreground/40 bg-transparent ' +
        'text-muted-foreground hover:text-foreground cursor-default" ' +
        'title="[[Keeper Ilse|the keeper]] — Keeper Ilse — not detailed yet">the keeper</button> three.</p>',
    );
    expect(readerRoot?.querySelectorAll(`[${SOURCE_FROM_ATTRIBUTE}]`)).toHaveLength(0);
    reader.unmount();

    const mapped = renderPart(value);
    // Same TEXT, character for character — the wrapper is an inline span
    // around the same text nodes, never a rewrite of the prose.
    expect(renderedText(mapped)).toBe('One two the keeper three.');
    expect(renderedText(mapped)).toBe(
      'One two the keeper three.',
    );
    // …and the mapping is actually ON in this render (non-vacuity: the parity
    // assertion above would also pass if sourceOffsets were silently ignored).
    expect(mapped.querySelectorAll(`[${SOURCE_FROM_ATTRIBUTE}]`).length).toBeGreaterThan(0);
  });
});
