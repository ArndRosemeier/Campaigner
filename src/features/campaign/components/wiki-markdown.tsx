import { memo, useMemo } from 'react';
import type { JSX, ReactNode } from 'react';
import Markdown, { defaultUrlTransform } from 'react-markdown';

import type { AnyArtifact, ArtifactKind, Id } from '@/domain';
import { ImageThumb } from '@/features/images/image-thumb';
import { remarkWikiLinks, WIKI_RAW_ATTRIBUTE } from '@/lib/remark-wikilinks';
import { resolveWikiLink } from '@/lib/wikilinks';
import { cn } from '@/lib/utils';

/**
 * The shared wiki-link markdown renderer (08-MODULE-DESIGNER M4-A): ONE
 * component used by the module reader and artifact editor preview
 * and the peek modal. Resolved `[[links]]` render as kind-colored chips (with
 * a cover micro-thumb when present), unresolved ones as dashed muted chips,
 * ambiguous ones with a ⚠ tooltip listing the candidates.
 *
 * EVERY chip's hover tooltip LEADS with the byte-exact token it was written
 * from (`data-wiki-raw`, carried by `remarkWikiLinks`) and keeps what the chip
 * already said after it — the rendered view drops the source text (an
 * encounter's parameters live in the token, not in its display text), and a
 * reconstruction from name + display cannot reproduce it (docs/17 row 100).
 *
 * MEMOIZED on its props, and the reader passes STABLE ones (a part's `value`,
 * the `artifacts` pool and the callbacks do not change per token or per page
 * state change): a markdown tree is rebuilt only when its OWN text or link
 * pool changed. Measured — the markdown parse is the expensive half of a
 * reader render, and an unmemoized renderer re-parsed the whole document
 * whenever an ancestor re-rendered for any reason. `highlight` is an object
 * prop, so the canvas preview (a fresh range per render) behaves as before.
 */

export interface WikiMarkdownProps {
  value: string;
  /** Campaign artifacts to resolve link names against. */
  artifacts: readonly AnyArtifact[];
  /** The owning module, when the text belongs to one (08-MODULE-DESIGNER):
   * the module's own entities win tier-0 over same-named campaign/global
   * rows. Omit → plain pool resolution. */
  moduleId?: Id | undefined;
  /** Resolved-chip click (peek modal, focus jump…). Omit → inert chip. */
  onOpenArtifact?: ((artifact: AnyArtifact) => void) | undefined;
  /**
   * Unresolved-chip click (stub popover). The anchor is the chip's client
   * position, for popover placement. Omit → inert chip.
   */
  onStub?: ((name: string, anchor: { x: number; y: number }) => void) | undefined;
  className?: string | undefined;
  /**
   * Last-replacement highlight (canvas preview): offsets into `value`
   * (the part's text) marking the text the chat just replaced. Rendered as
   * a block-level wash around that slice; OMITTED (never an empty range)
   * ⇒ the reader output is byte-identical to the unhighlighted render.
   */
  highlight?: { from: number; to: number } | undefined;
  /**
   * Source map (canvas preview only, docs/17 row 102): wraps every rendered
   * text run in an inline `<span data-md-from data-md-to>` carrying that run's
   * BYTE range in `value`, so a rendered DOM selection can be resolved back to
   * an exact SOURCE range (`resolveSelectionRange`). OPT-IN — the module
   * reader, the peek modal, the board and the artifact bodies pass nothing,
   * and without it this component's rendered output is unchanged (same tags,
   * same text, no attributes), which a parity test pins byte-for-byte.
   *
   * It changes no rendered TEXT anywhere: the wrapper is an inline span around
   * the SAME text node. The wrapper is a PARENT node rather than a marker on
   * the text node itself because `remarkWikiLinks` runs after the wrapper and
   * REPLACES any text node holding a `[[token]]` — a marker on the text node
   * would be lost exactly where the mapping matters most (a run next to a
   * chip); the wrapper survives the split and its children ARE the pieces the
   * resolver folds back into source offsets.
   */
  sourceOffsets?: boolean | undefined;
}

const KIND_CHIP_CLASSES: Readonly<Record<ArtifactKind, string>> = {
  pc: 'border-rose-500/50 bg-rose-500/10 text-rose-800 dark:text-rose-200',
  npc: 'border-sky-500/50 bg-sky-500/10 text-sky-800 dark:text-sky-200',
  location: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200',
  event: 'border-teal-500/50 bg-teal-500/10 text-teal-800 dark:text-teal-200',
  faction: 'border-amber-500/60 bg-amber-500/10 text-amber-800 dark:text-amber-200',
  note: 'border-neutral-500/50 bg-neutral-500/10 text-neutral-800 dark:text-neutral-200',
  encounter: 'border-red-500/50 bg-red-500/10 text-red-800 dark:text-red-200',
  plotarc: 'border-violet-500/50 bg-violet-500/10 text-violet-800 dark:text-violet-200',
};

export const WikiMarkdown = memo(function WikiMarkdown({
  value,
  artifacts,
  moduleId,
  onOpenArtifact,
  onStub,
  className,
  highlight,
  sourceOffsets,
}: WikiMarkdownProps): JSX.Element {
  const components = useMemo(
    () => ({
      a: wikiAnchorComponent({ artifacts, moduleId, onOpenArtifact, onStub }),
    }),
    [artifacts, moduleId, onOpenArtifact, onStub],
  );

  // The last-replacement range, clamped to the value (an out-of-range or
  // empty range is no wash at all — never an empty highlighted span).
  const highlightRange =
    highlight === undefined
      ? null
      : (() => {
          const from = Math.max(0, Math.min(value.length, highlight.from));
          const to = Math.max(0, Math.min(value.length, highlight.to));
          return to > from ? { from, to } : null;
        })();

  // The remark pipeline, per render. Opt-in `sourceOffsets` wraps every text
  // run in its source range, and a `highlight` washes the last replacement
  // inline; the wrapper MUST run BEFORE `remarkWikiLinks` (the wiki plugin
  // splits the runs it wraps). Both ride ONE parse of ONE string — no slice
  // is ever parsed on its own. Without either the array is exactly the
  // historical `[remarkWikiLinks]`.
  const renderPlugins = () =>
    sourceOffsets === true || highlightRange !== null
      ? [remarkSourceSpans({ wrap: sourceOffsets === true, highlight: highlightRange }), remarkWikiLinks]
      : [remarkWikiLinks];

  // One parse, one string, whatever the props: the wash is a decoration
  // applied INSIDE that parse (see `remarkSourceSpans`), so the rendered text
  // is the source text character for character — with or without a highlight.
  // Without any prop the pipeline is exactly the historical
  // `[remarkWikiLinks]` and the output is byte-identical.
  return (
    <div className={className}>
      <Markdown
        remarkPlugins={renderPlugins()}
        urlTransform={wikiUrlTransform}
        components={components}
      >
        {value}
      </Markdown>
    </div>
  );
});

/** Keeps relative `#wiki:` hrefs; everything else goes through the default. */
function wikiUrlTransform(url: string): string {
  if (url.startsWith('#wiki:')) return url;
  return defaultUrlTransform(url);
}

function wikiAnchorComponent(context: {
  artifacts: readonly AnyArtifact[];
  moduleId?: Id | undefined;
  onOpenArtifact?: ((artifact: AnyArtifact) => void) | undefined;
  onStub?: ((name: string, anchor: { x: number; y: number }) => void) | undefined;
}): (props: WikiAnchorProps) => JSX.Element {
  return function WikiAnchor(props: WikiAnchorProps) {
    const { href, children } = props;
    // The byte-exact token the link was written from, carried by
    // `remarkWikiLinks` on the node's `data.hProperties` (see
    // `WIKI_RAW_ATTRIBUTE`). Absent only for a hand-written
    // `[text](#wiki:Name)` link, which never went through the plugin.
    const raw = props[WIKI_RAW_ATTRIBUTE];
    if (!href?.startsWith('#wiki:')) {
      return <a href={href}>{children}</a>;
    }
    let name = href.slice('#wiki:'.length);
    try {
      name = decodeURIComponent(name);
    } catch {
      // A malformed escape stays as-is — the chip simply won't resolve.
    }
    const display = plainText(children) ?? name;
    return <WikiChip name={name} display={display} raw={raw} context={context} />;
  };
}

/** The props react-markdown hands a rendered `a` element, narrowed to what
 * this renderer reads (`data-wiki-raw` is the extra one it carries). */
interface WikiAnchorProps {
  href?: string | undefined;
  children?: ReactNode;
  [WIKI_RAW_ATTRIBUTE]?: string | undefined;
}

/**
 * The chip's hover tooltip: the byte-exact source token FIRST, then whatever
 * the chip already said (artifact kind + name, the unresolved "not detailed
 * yet", or the ⚠ ambiguity list) — never a reconstruction from name+display
 * (docs/17 row 100, docs/05 §The chip).
 */
function wikiChipTitle(raw: string | undefined, existing: string): string {
  return raw === undefined || raw === '' ? existing : `${raw} — ${existing}`;
}

function WikiChip({
  name,
  display,
  raw,
  context,
}: {
  name: string;
  display: string;
  raw: string | undefined;
  context: {
    artifacts: readonly AnyArtifact[];
    moduleId?: Id | undefined;
    onOpenArtifact?: ((artifact: AnyArtifact) => void) | undefined;
    onStub?: ((name: string, anchor: { x: number; y: number }) => void) | undefined;
  };
}): JSX.Element {
  const { artifacts, moduleId, onOpenArtifact, onStub } = context;
  const resolution = resolveWikiLink(name, artifacts, moduleId === undefined ? undefined : { moduleId });

  if (resolution.status === 'unresolved' || resolution.artifact === undefined) {
    return (
      <button
        type="button"
        data-testid="wiki-chip-unresolved"
        data-wiki-name={name}
        data-wiki-raw={raw}
        className={cn(CHIP_BASE, CHIP_UNRESOLVED, onStub === undefined && 'cursor-default')}
        title={wikiChipTitle(raw, `${name} — not detailed yet`)}
        onClick={
          onStub === undefined
            ? undefined
            : (event) => {
                event.preventDefault();
                onStub(name, { x: event.clientX, y: event.clientY });
              }
        }
      >
        {display}
      </button>
    );
  }

  const artifact = resolution.artifact;
  const ambiguous = resolution.status === 'ambiguous';
  const title =
    resolution.candidates.length > 1
      ? `⚠ ${resolution.candidates.length} artifacts match “${name}”: ${resolution.candidates
          .map((candidate) => candidate.name)
          .join(', ')}`
      : `${ARTICLE_KIND_LABEL[artifact.kind]} ${artifact.name}`;
  return (
    <button
      type="button"
      data-testid="wiki-chip"
      data-wiki-name={name}
      data-wiki-artifact-id={artifact.id}
      data-wiki-raw={raw}
      data-wiki-ambiguous={ambiguous || undefined}
      className={cn(CHIP_BASE, KIND_CHIP_CLASSES[artifact.kind], onOpenArtifact === undefined && 'cursor-default')}
      title={wikiChipTitle(raw, title)}
      onClick={
        onOpenArtifact === undefined
          ? undefined
          : (event) => {
              event.preventDefault();
              onOpenArtifact(artifact);
            }
      }
    >
      <CoverMicroThumb imageId={artifact.coverImageId} />
      <span>{display}</span>
      {ambiguous && (
        <span aria-hidden className="text-amber-600 dark:text-amber-400">
          ⚠
        </span>
      )}
    </button>
  );
}

const ARTICLE_KIND_LABEL: Readonly<Record<ArtifactKind, string>> = {
  pc: 'PC',
  npc: 'NPC',
  location: 'Location',
  event: 'Event',
  faction: 'Faction',
  note: 'Note',
  encounter: 'Encounter',
  plotarc: 'Plot arc',
};

const CHIP_BASE =
  'mx-0.5 inline-flex max-w-full items-center gap-1 rounded-full border px-1.5 py-0.5 align-baseline text-[0.9em] font-medium whitespace-nowrap';

const CHIP_UNRESOLVED =
  'border-dashed border-muted-foreground/40 bg-transparent text-muted-foreground hover:text-foreground';

/** Cover-image micro-thumb inside a resolved chip (hidden when none). */
function CoverMicroThumb({ imageId }: { imageId: Id | null }): JSX.Element | null {
  if (imageId === null) return null;
  return <ImageThumb imageId={imageId} alt="" size={14} rounded />;
}

/** Joins a React node tree down to plain text (for chip labels). */
function plainText(node: ReactNode): string | null {
  if (node === null || node === undefined || typeof node === 'boolean') return null;
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) {
    const parts = node
      .map((child: ReactNode) => plainText(child))
      .filter((part): part is string => part !== null);
    return parts.length === 0 ? null : parts.join('');
  }
  if (typeof node === 'object' && 'props' in (node as object)) {
    const props = (node as { props?: { children?: ReactNode } }).props;
    if (props !== undefined) return plainText(props.children);
  }
  return null;
}

/* ------------------------------------------------------------------------ *
 * The source map: rendered DOM → markdown SOURCE (canvas preview, row 102)
 * ------------------------------------------------------------------------ */

/**
 * The two attributes a source-run wrapper carries: that run's byte range in
 * the markdown SOURCE string the renderer was handed. ONE constant each, so
 * the producer (`remarkSourceSpans`) and the consumer
 * (`resolveSelectionRange`) can never drift apart — the
 * `WIKI_RAW_ATTRIBUTE` precedent.
 */
export const SOURCE_FROM_ATTRIBUTE = 'data-md-from';
export const SOURCE_TO_ATTRIBUTE = 'data-md-to';

/**
 * Minimal structural mdast view for the source-span plugin — positions
 * included. `remarkWikiLinks`' `WikiMdNode` deliberately carries no
 * `position`, so this plugin declares the slice of the tree it needs.
 */
interface SourceMdNode {
  type: string;
  value?: string | undefined;
  children?: SourceMdNode[] | undefined;
  data?:
    | { hName?: string | undefined; hProperties?: Record<string, string> | undefined }
    | undefined;
  position?:
    | {
        start?: { offset?: number | undefined } | undefined;
        end?: { offset?: number | undefined } | undefined;
      }
    | undefined;
}

/**
 * The last-replacement wash, rendered INLINE over exactly the replaced
 * characters. It used to be a block-level `<div>` around three separately
 * parsed markdown SLICES — and MEASURED, that lost every whitespace character
 * at a slice boundary ("one two three" with [4,7) replaced rendered
 * "onetwothree"), because CommonMark strips the initial and final whitespace
 * of a paragraph and each slice was parsed as its own document. The wash is
 * therefore applied to ONE parse, by the same source-span plugin that builds
 * the DOM→source map: the covered run's text is split at the range and the
 * middle piece is washed. No text is moved, dropped or re-chunked, and the
 * washed piece carries its own source range (a selection inside the wash maps
 * exactly like any other text).
 */
export const HIGHLIGHT_ATTRIBUTE = 'data-testid';
export const HIGHLIGHT_TEST_ID = 'replacement-highlight';
const HIGHLIGHT_CLASSES = 'rounded-sm bg-amber-300/40 dark:bg-amber-400/25';

/**
 * The source-run wrapper (opt-in, `WikiMarkdown` prop `sourceOffsets`): wraps
 * EVERY mdast text node — outside links — in a `<span>` carrying the node's
 * byte range in the source, so the rendering keeps a DOM→source map.
 *
 * Three properties make this the honest mechanism:
 * - The wrapper is a PARENT mdast node, never a marker on the text node
 *   itself: `remarkWikiLinks` runs AFTER this plugin and REPLACES any text
 *   node holding a `[[token]]`, so a marker on that node would vanish exactly
 *   where the mapping matters most (a run next to a chip). The wrapper
 *   survives the split and the split pieces become its children — which is
 *   what the resolver folds back into offsets.
 * - Only mdast `text` nodes are wrapped, so nothing the parser did not treat
 *   as literal source text (inline code, fenced code, images, raw HTML) is
 *   ever mapped: a selection inside one of those is refused by name instead of
 *   being mapped through a transform.
 * - The attributes ride `data.hName`/`data.hProperties`, the one supported
 *   mdast→hast route for a custom element (`mdast-util-to-hast`'s
 *   `applyData`), so the span reaches the DOM with no second renderer.
 *
 * The same pass applies the last-replacement wash when a range is given
 * (`options.highlight`, part-relative): a text node that only PARTLY overlaps
 * the range is split into up to three nodes with recomputed positions, so the
 * washed piece is an exact source range and the surrounding text stays in the
 * same paragraph, in the same order, character for character. A node whose
 * value does not reproduce its source slice (an escape or an entity — the
 * length check below) is left unwashed rather than washed in the wrong place:
 * a decoration may be absent, it may never lie.
 *
 * `baseOffset` keeps the ranges relative to the STRING THE CALLER RENDERS FROM
 * rather than to the parsed slice.
 */
export interface SourceSpanOptions {
  /** Offset of the parsed value inside the part's source. */
  base?: number;
  /** Wrap every text run in its source range (the DOM→source map). */
  wrap?: boolean;
  /** Part-relative source range of the last replacement (wash), if any. */
  highlight?: { from: number; to: number } | null;
}

export function remarkSourceSpans(
  options: SourceSpanOptions = {},
): () => (tree: SourceMdNode) => void {
  const base = options.base ?? 0;
  const wrap = options.wrap ?? true;
  const highlight = options.highlight ?? null;
  return () => (tree: SourceMdNode): void => {
    wrapSourceRuns(tree, base, false, highlight, wrap);
  };
}

function wrapSourceRuns(
  node: SourceMdNode,
  base: number,
  insideLink: boolean,
  highlight: { from: number; to: number } | null,
  wrap: boolean,
): void {
  const children = node.children;
  if (children === undefined) return;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child === undefined) continue;
    if (child.type === 'link') {
      // A link's children are the chip label (display text) — never a source
      // range of their own: the chip maps to its whole `[[…]]` token.
      wrapSourceRuns(child, base, true, highlight, wrap);
      continue;
    }
    const range = textRunRange(child, base);
    const replacement =
      !insideLink && range !== null ? sourceRunNodes(child, range, highlight, wrap) : null;
    if (replacement !== null) {
      children.splice(index, 1, ...replacement);
      index += replacement.length - 1;
      continue;
    }
    wrapSourceRuns(child, base, insideLink, highlight, wrap);
  }
}

/**
 * One text node as the source-run nodes that replace it: normally ONE wrapper
 * around the node, and up to THREE when the wash range cuts it (before /
 * washed / after) — each keeping its own exact source range.
 */
function sourceRunNodes(
  node: SourceMdNode,
  range: { from: number; to: number },
  highlight: { from: number; to: number } | null,
  wrap: boolean,
): SourceMdNode[] | null {
  const value = node.value ?? '';
  const washed = washPieces(value, range, highlight);
  if (washed === null) {
    return wrap ? [sourceRunNode(node, node, range.from, range.to, false)] : null;
  }
  return washed.map((piece) =>
    sourceRunNode(
      node,
      { type: 'text', value: piece.value, position: piece.position },
      piece.from,
      piece.to,
      piece.marked,
    ),
  );
}

/**
 * Splits a text node's value at the wash range, or null when the wash does not
 * cut it (or cannot be placed — see the length check). The source offsets of
 * each piece are computed from the node's own range, which is why the value
 * must reproduce that range one character at a time.
 */
function washPieces(
  value: string,
  range: { from: number; to: number },
  highlight: { from: number; to: number } | null,
): { value: string; from: number; to: number; marked: boolean; position: SourceMdNode['position'] }[] | null {
  if (highlight === null) return null;
  if (highlight.from >= range.to || highlight.to <= range.from) return null;
  if (value.length !== range.to - range.from) return null;
  const start = Math.max(0, highlight.from - range.from);
  const end = Math.min(value.length, highlight.to - range.from);
  if (end <= start) return null;
  const pieces: { value: string; from: number; to: number; marked: boolean }[] = [];
  if (start > 0) pieces.push({ value: value.slice(0, start), from: range.from, to: range.from + start, marked: false });
  pieces.push({ value: value.slice(start, end), from: range.from + start, to: range.from + end, marked: true });
  if (end < value.length) {
    pieces.push({ value: value.slice(end), from: range.from + end, to: range.to, marked: false });
  }
  return pieces.map((piece) => ({ ...piece, position: offsetPosition(piece.from, piece.to) }));
}

/** A position carrying ONLY offsets (all this plugin and its resolver read). */
function offsetPosition(from: number, to: number): SourceMdNode['position'] {
  return { start: { offset: from }, end: { offset: to } };
}

/**
 * A wrapper around `positionSource`'s position holding `node`'s content, with
 * the given exact source range. The wash markers ride the same element, so a
 * washed piece is also a mappable run.
 */
function sourceRunNode(
  positionSource: SourceMdNode,
  node: SourceMdNode,
  from: number,
  to: number,
  marked: boolean,
): SourceMdNode {
  return {
    type: 'sourceRun',
    data: {
      hName: 'span',
      hProperties: {
        [SOURCE_FROM_ATTRIBUTE]: String(from),
        [SOURCE_TO_ATTRIBUTE]: String(to),
        ...(marked ? { className: HIGHLIGHT_CLASSES, [HIGHLIGHT_ATTRIBUTE]: HIGHLIGHT_TEST_ID } : {}),
      },
    },
    position: node.position ?? positionSource.position,
    children: [node],
  };
}

function textRunRange(node: SourceMdNode, base: number): { from: number; to: number } | null {
  if (node.type !== 'text') return null;
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (typeof start !== 'number' || typeof end !== 'number' || end < start) return null;
  return { from: base + start, to: base + end };
}

/**
 * The refusals a rendered selection can get when it cannot be mapped to an
 * exact source range. Each is a NAMED state the UI states verbatim; NONE of
 * them is ever resolved by guessing — no clamping, no rounding to a
 * convenient boundary, no falling back to the display text (docs/17 row 102).
 */
export const SOURCE_MAP_REFUSALS = {
  empty:
    'Nothing is selected — select the text to refine first. A collapsed cursor is not a selection.',
  backwards: 'That selection is not a single forward range — select the text again.',
  insideChip:
    'The selection starts or ends inside a wiki-link chip. Select whole chips or plain text — a chip is replaced as its whole [[…]] token, never as its label.',
  unmapped:
    'The selection is not inside text this view can map to the module source (code spans, images, link labels and the nothing-written-yet placeholder are not mapped).',
  mismatch:
    'The rendered text and the module source do not line up here (an escaped character, a raw entity or a re-wrapped line), so the exact range cannot be stated. Select a different span.',
} as const;

/** A point in the rendered DOM, as a DOM Range reports it. */
export interface DomPoint {
  node: Node;
  offset: number;
}

export type SelectionRangeResult =
  | { status: 'mapped'; from: number; to: number }
  | { status: 'refused'; reason: string };

/**
 * Maps a rendered DOM selection back to an exact, PART-RELATIVE source range
 * — or refuses by name. This is the inverse of `remarkSourceSpans`, and the
 * only place that turns rendered offsets into source offsets.
 *
 * Byte-exact or refuse, and nothing else:
 * - a source run's pieces (its text nodes, and each chip's byte-exact
 *   `data-wiki-raw` token) must CONCATENATE to exactly the source slice the
 *   run claims — that is the proof the mapping is exact, and it fails for an
 *   escaped character, a raw entity, a `trim-lines` divergence or a highlight
 *   slice re-chunked at a token boundary;
 * - a chip is atomic: its outer boundaries map to the whole `[[…]]` token, a
 *   point strictly inside its label/decoration is refused;
 * - an endpoint outside any run (inline code, images, headings rendered
 *   elsewhere, the placeholder text of an unwritten part) is refused.
 */
export function resolveSelectionRange(
  partText: string,
  start: DomPoint,
  end: DomPoint,
): SelectionRangeResult {
  const head = resolvePoint(partText, start);
  if (!head.ok) return { status: 'refused', reason: head.reason };
  const tail = resolvePoint(partText, end);
  if (!tail.ok) return { status: 'refused', reason: tail.reason };
  if (tail.offset < head.offset) {
    return { status: 'refused', reason: SOURCE_MAP_REFUSALS.backwards };
  }
  if (tail.offset === head.offset) {
    return { status: 'refused', reason: SOURCE_MAP_REFUSALS.empty };
  }
  return { status: 'mapped', from: head.offset, to: tail.offset };
}

type PointResult = { ok: true; offset: number } | { ok: false; reason: string };

/** One piece of a source run, in document order, with its exact source range. */
interface RunPiece {
  node: Node;
  from: number;
  to: number;
  /** True for a rendered text node, false for a chip (its token). */
  text: boolean;
}

/** The nearest source run above `node`, and the chip between them (if any). */
function nearestRunContext(node: Node): { run: Element; chip: Element | null } | null {
  let current: Element | null = node.nodeType === Node.TEXT_NODE ? node.parentElement : asElement(node);
  let chip: Element | null = null;
  while (current !== null) {
    if (current.hasAttribute(SOURCE_FROM_ATTRIBUTE)) return { run: current, chip };
    if (chip === null && current.hasAttribute(WIKI_RAW_ATTRIBUTE)) chip = current;
    current = current.parentElement;
  }
  return null;
}

function resolvePoint(partText: string, point: DomPoint): PointResult {
  const context = nearestRunContext(point.node);
  if (context === null) return { ok: false, reason: SOURCE_MAP_REFUSALS.unmapped };
  const pieces = runPieces(partText, context.run);
  if (!pieces.ok) return { ok: false, reason: pieces.reason };

  if (point.node === context.run) {
    // An element-level boundary on the run itself: an offset between pieces
    // (or at either end). Every such boundary IS an exact source offset.
    const index = point.offset;
    if (!Number.isInteger(index) || index < 0 || index > pieces.pieces.length) {
      return { ok: false, reason: SOURCE_MAP_REFUSALS.mismatch };
    }
    if (index === pieces.pieces.length) return { ok: true, offset: pieces.to };
    const piece = pieces.pieces[index];
    if (piece === undefined) return { ok: false, reason: SOURCE_MAP_REFUSALS.mismatch };
    return { ok: true, offset: piece.from };
  }

  for (const piece of pieces.pieces) {
    if (piece.text && piece.node === point.node) {
      if (!Number.isInteger(point.offset) || point.offset < 0 || point.offset > piece.to - piece.from) {
        return { ok: false, reason: SOURCE_MAP_REFUSALS.mismatch };
      }
      return { ok: true, offset: piece.from + point.offset };
    }
  }

  const chip =
    context.chip === null ? undefined : pieces.pieces.find((piece) => piece.node === context.chip);
  if (chip !== undefined) return chipEdge(chip, point);
  return { ok: false, reason: SOURCE_MAP_REFUSALS.unmapped };
}

/**
 * A point inside (or on) a chip. Only the chip's OWN outer boundaries are
 * exact source offsets — before its first rendered character and after its
 * last one, which is the whole `[[…]]` token. A point strictly inside its
 * label is refused: rounding it to the token would silently replace text the
 * owner did not select.
 */
function chipEdge(chip: RunPiece, point: DomPoint): PointResult {
  const element = asElement(chip.node);
  if (element === null) return { ok: false, reason: SOURCE_MAP_REFUSALS.insideChip };
  if (point.node === element) {
    if (point.offset === 0) return { ok: true, offset: chip.from };
    if (point.offset === element.childNodes.length) return { ok: true, offset: chip.to };
    return { ok: false, reason: SOURCE_MAP_REFUSALS.insideChip };
  }
  const textNodes = textNodesWithin(element);
  const index = textNodes.findIndex((candidate) => candidate === point.node);
  if (index === -1) return { ok: false, reason: SOURCE_MAP_REFUSALS.insideChip };
  const value = point.node.nodeValue ?? '';
  if (index === 0 && point.offset === 0) return { ok: true, offset: chip.from };
  if (index === textNodes.length - 1 && point.offset === value.length) {
    return { ok: true, offset: chip.to };
  }
  return { ok: false, reason: SOURCE_MAP_REFUSALS.insideChip };
}

type RunPieces =
  | { ok: true; pieces: RunPiece[]; from: number; to: number }
  | { ok: false; reason: string };

/**
 * Folds a source run's rendered children back into source offsets — and
 * PROVES it while doing so: the pieces must concatenate to exactly the source
 * slice the run claims (a chip contributes its `data-wiki-raw` token, never
 * its label). A run whose rendered text does not reproduce its source — an
 * escape, an entity, a dropped line-break space, a highlight slice re-chunked
 * mid-token — fails here and its selection is refused.
 */
function runPieces(partText: string, run: Element): RunPieces {
  const from = Number(run.getAttribute(SOURCE_FROM_ATTRIBUTE));
  const to = Number(run.getAttribute(SOURCE_TO_ATTRIBUTE));
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < from ||
    to > partText.length
  ) {
    return { ok: false, reason: SOURCE_MAP_REFUSALS.mismatch };
  }
  const pieces: RunPiece[] = [];
  let cursor = from;
  for (const child of Array.from(run.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const value = child.nodeValue ?? '';
      // The BYTE proof, not a length proof: the rendered characters must BE
      // the source bytes at that range. A same-length divergence (a smart-quote
      // swap, a transform the parser applied) would otherwise map silently.
      if (partText.slice(cursor, cursor + value.length) !== value) {
        return { ok: false, reason: SOURCE_MAP_REFUSALS.mismatch };
      }
      pieces.push({ node: child, from: cursor, to: cursor + value.length, text: true });
      cursor += value.length;
      continue;
    }
    const element = asElement(child);
    const raw = element?.getAttribute(WIKI_RAW_ATTRIBUTE) ?? null;
    if (element === null || raw === null) {
      // Something inside a source run that carries no source range of its own
      // (a bare element the plugin never wrapped): no proof, no mapping.
      return { ok: false, reason: SOURCE_MAP_REFUSALS.mismatch };
    }
    // A chip maps to its whole `[[…]]` token, and the token must BE the source
    // bytes there — never the display label, never a reconstruction.
    if (partText.slice(cursor, cursor + raw.length) !== raw) {
      return { ok: false, reason: SOURCE_MAP_REFUSALS.mismatch };
    }
    pieces.push({ node: element, from: cursor, to: cursor + raw.length, text: false });
    cursor += raw.length;
  }
  if (cursor !== to) return { ok: false, reason: SOURCE_MAP_REFUSALS.mismatch };
  return { ok: true, pieces, from, to };
}

function asElement(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : null;
}

function textNodesWithin(element: Element): Node[] {
  const found: Node[] = [];
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) found.push(child);
    else {
      const nested = asElement(child);
      if (nested !== null) found.push(...textNodesWithin(nested));
    }
  }
  return found;
}
