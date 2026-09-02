import { useMemo } from 'react';
import type { JSX, ReactNode } from 'react';
import Markdown, { defaultUrlTransform } from 'react-markdown';

import type { AnyArtifact, ArtifactKind, Id } from '@/domain';
import { ImageThumb } from '@/features/images/image-thumb';
import { remarkWikiLinks } from '@/lib/remark-wikilinks';
import { resolveWikiLink } from '@/lib/wikilinks';
import { cn } from '@/lib/utils';

/**
 * The shared wiki-link markdown renderer (08-MODULE-DESIGNER M4-A): ONE
 * component used by the module reader, the artifact editor preview, Play mode
 * and the peek modal. Resolved `[[links]]` render as kind-colored chips (with
 * a cover micro-thumb when present), unresolved ones as dashed muted chips,
 * ambiguous ones with a ⚠ tooltip listing the candidates.
 */

export interface WikiMarkdownProps {
  value: string;
  /** Campaign artifacts to resolve link names against. */
  artifacts: readonly AnyArtifact[];
  /** Resolved-chip click (peek modal, focus jump…). Omit → inert chip. */
  onOpenArtifact?: ((artifact: AnyArtifact) => void) | undefined;
  /**
   * Unresolved-chip click (stub popover). The anchor is the chip's client
   * position, for popover placement. Omit → inert chip.
   */
  onStub?: ((name: string, anchor: { x: number; y: number }) => void) | undefined;
  className?: string | undefined;
}

const KIND_CHIP_CLASSES: Readonly<Record<ArtifactKind, string>> = {
  pc: 'border-rose-500/50 bg-rose-500/10 text-rose-800 dark:text-rose-200',
  npc: 'border-sky-500/50 bg-sky-500/10 text-sky-800 dark:text-sky-200',
  location: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200',
  faction: 'border-amber-500/60 bg-amber-500/10 text-amber-800 dark:text-amber-200',
  note: 'border-neutral-500/50 bg-neutral-500/10 text-neutral-800 dark:text-neutral-200',
  encounter: 'border-red-500/50 bg-red-500/10 text-red-800 dark:text-red-200',
  plotarc: 'border-violet-500/50 bg-violet-500/10 text-violet-800 dark:text-violet-200',
  session: 'border-cyan-500/50 bg-cyan-500/10 text-cyan-800 dark:text-cyan-200',
};

export function WikiMarkdown({
  value,
  artifacts,
  onOpenArtifact,
  onStub,
  className,
}: WikiMarkdownProps): JSX.Element {
  const components = useMemo(
    () => ({
      a: wikiAnchorComponent({ artifacts, onOpenArtifact, onStub }),
    }),
    [artifacts, onOpenArtifact, onStub],
  );

  return (
    <div className={className}>
      <Markdown
        remarkPlugins={[remarkWikiLinks]}
        urlTransform={wikiUrlTransform}
        components={components}
      >
        {value}
      </Markdown>
    </div>
  );
}

/** Keeps relative `#wiki:` hrefs; everything else goes through the default. */
function wikiUrlTransform(url: string): string {
  if (url.startsWith('#wiki:')) return url;
  return defaultUrlTransform(url);
}

function wikiAnchorComponent(context: {
  artifacts: readonly AnyArtifact[];
  onOpenArtifact?: ((artifact: AnyArtifact) => void) | undefined;
  onStub?: ((name: string, anchor: { x: number; y: number }) => void) | undefined;
}): (props: { href?: string | undefined; children?: ReactNode }) => JSX.Element {  return function WikiAnchor({ href, children }) {
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
    return <WikiChip name={name} display={display} context={context} />;
  };
}

function WikiChip({
  name,
  display,
  context,
}: {
  name: string;
  display: string;
  context: {
    artifacts: readonly AnyArtifact[];
    onOpenArtifact?: ((artifact: AnyArtifact) => void) | undefined;
    onStub?: ((name: string, anchor: { x: number; y: number }) => void) | undefined;
  };
}): JSX.Element {
  const { artifacts, onOpenArtifact, onStub } = context;
  const resolution = resolveWikiLink(name, artifacts);

  if (resolution.status === 'unresolved' || resolution.artifact === undefined) {
    return (
      <button
        type="button"
        data-testid="wiki-chip-unresolved"
        data-wiki-name={name}
        className={cn(CHIP_BASE, CHIP_UNRESOLVED, onStub === undefined && 'cursor-default')}
        title={`${name} — not detailed yet`}
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
      data-wiki-ambiguous={ambiguous || undefined}
      className={cn(CHIP_BASE, KIND_CHIP_CLASSES[artifact.kind], onOpenArtifact === undefined && 'cursor-default')}
      title={title}
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
  faction: 'Faction',
  note: 'Note',
  encounter: 'Encounter',
  plotarc: 'Plot arc',
  session: 'Session',
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
