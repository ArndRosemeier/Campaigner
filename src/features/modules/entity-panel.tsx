import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import { ChevronDownIcon, ChevronRightIcon, SparklesIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { Artifact, Campaign, Id, Module } from '@/domain';
import { moduleTagFor } from '@/domain';
import { artifactRepo } from '@/db';
import { listPersonas } from '@/db/personaRepo';
import { chainRunner } from '@/llm/chainRunner';
import type { ChainStepInput } from '@/llm/chainRunner';
import {
  buildEntityBrief,
  guessKindFromSentence,
  STUB_KINDS,
  STUB_PERSONA_SLUGS,
  type StubKind,
} from '@/features/modules/persona-request';
import {
  countOccurrences,
  extractWikiLinks,
  resolveWikiLink,
  sentenceAround,
  surroundingParagraphs,
} from '@/lib/wikilinks';
import { toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';

/**
 * Entity panel (08-MODULE-DESIGNER M4-C): the right sidebar of the module
 * reader. Lists every wiki-link in the module (resolved first, then
 * unresolved) with occurrence counts, the "N mentioned · M detailed" progress
 * line, scroll-to-first-occurrence, and the M4-C batch action "Generate all
 * unresolved of kind…".
 */

export interface EntityPanelProps {
  module: Module;
  artifacts: readonly Artifact[];
  campaign: Campaign;
  /** Opens the stub popover for an unresolved name. */
  onStub: (name: string, anchor: { x: number; y: number }) => void;
  /** Scrolls the reader to the first occurrence of a name. */
  onScrollTo: (name: string) => void;
}

interface EntityEntry {
  name: string;
  resolved: boolean;
  ambiguous: boolean;
  artifact: Artifact | undefined;
  occurrences: { where: string; count: number }[];
  total: number;
  sentence: string;
}

export function useModuleEntities(
  module: Module,
  artifacts: readonly Artifact[],
): { entries: EntityEntry[]; documents: { where: string; markdown: string }[] } {
  return useMemo(() => {
    const documents = [
      { where: 'premise', markdown: module.spine?.premise ?? '' },
      ...module.parts
        .slice()
        .sort((a, b) => a.planIndex - b.planIndex)
        .map((part) => ({ where: `part-${String(part.planIndex)}`, markdown: part.markdown })),
    ];
    const names = extractWikiLinks(documents.map((document) => document.markdown).join('\n\n')).map(
      (link) => link.name,
    );
    const entries = names.map((name) => {
      const resolution = resolveWikiLink(name, artifacts);
      const occurrences = countOccurrences(name, documents);
      const firstDoc = documents.find((document) =>
        countOccurrences(name, [document]).length > 0,
      );
      return {
        name,
        resolved: resolution.artifact !== undefined,
        ambiguous: resolution.status === 'ambiguous',
        artifact: resolution.artifact,
        occurrences,
        total: occurrences.reduce((sum, occurrence) => sum + occurrence.count, 0),
        sentence: sentenceAround(firstDoc?.markdown ?? '', name),
      };
    });
    // Resolved first, then by total mentions descending.
    entries.sort((a, b) => {
      if (a.resolved !== b.resolved) return a.resolved ? -1 : 1;
      return b.total - a.total;
    });
    return { entries, documents };
  }, [module, artifacts]);
}

export function EntityPanel({
  module,
  artifacts,
  campaign,
  onStub,
  onScrollTo,
}: EntityPanelProps): JSX.Element {
  const { entries, documents } = useModuleEntities(module, artifacts);
  const [collapsed, setCollapsed] = useState(false);
  const [batching, setBatching] = useState<StubKind | null>(null);

  const mentioned = entries.length;
  const detailed = entries.filter((entry) => entry.resolved).length;
  const unresolved = entries.filter((entry) => !entry.resolved);
  const unresolvedByKind = new Map<StubKind, EntityEntry[]>();
  for (const entry of unresolved) {
    const kind = guessKindFromSentence(entry.sentence);
    const list = unresolvedByKind.get(kind) ?? [];
    list.push(entry);
    unresolvedByKind.set(kind, list);
  }

  const moduleTag = moduleTagFor(module.title);

  /** Full module text for the brief context. */
  const moduleText = documents.map((document) => document.markdown).join('\n\n');

  async function generateBatch(kind: StubKind): Promise<void> {
    const targets = unresolvedByKind.get(kind) ?? [];
    if (targets.length === 0) return;
    setBatching(kind);
    try {
      const personas = await listPersonas();
      const persona =
        personas.find((candidate) => candidate.slug === STUB_PERSONA_SLUGS[kind]) ??
        personas.find((candidate) => candidate.producesKind === kind);
      if (persona === undefined) {
        toastError(`No persona available to detail ${kind}s — check Settings → Personas`);
        return;
      }
      let remaining: EntityEntry[] = targets;
      const producedIds: Id[] = [];
      // One chain over all targets; chain semantics keep completed steps and
      // show failed runs in the Runs tab. On a failed step the batch
      // CONTINUES with the remaining names (fresh chain).
      while (remaining.length > 0) {
        const steps: ChainStepInput[] = remaining.map((entry) => ({
          personaId: persona.id,
          title: `Detail: ${entry.name}`,
          brief: buildEntityBrief(
            entry.name,
            surroundingParagraphs(moduleText, entry.name),
            module.spine?.premise ?? '',
          ),
          autonomy: 'auto' as const,
        }));
        const result = await chainRunner.run(campaign, personas, steps, 'auto', []);
        for (const step of result.steps) {
          if (step.artifactId !== null) producedIds.push(step.artifactId);
        }
        const failedIndex = result.steps.findIndex((step) => step.status === 'failed');
        if (result.status === 'completed') break;
        if (result.status === 'cancelled') break;
        if (failedIndex === -1) break;
        // Skip everything up to and including the failed step, keep going.
        remaining = remaining.slice(failedIndex + 1);
      }
      // Stamp the produced artifacts with the module tag.
      for (const artifactId of producedIds) {
        try {
          const artifact = await artifactRepo.getArtifact(artifactId);
          if (artifact !== undefined && !artifact.tags.includes(moduleTag)) {
            await artifactRepo.updateArtifact(artifactId, {
              tags: [...artifact.tags, moduleTag],
            });
          }
        } catch (error) {
          toastError('Could not tag a produced artifact', error);
        }
      }
    } catch (error) {
      toastError('Batch generation failed', error);
    } finally {
      setBatching(null);
    }
  }

  return (
    <aside
      className="flex h-full flex-col border-l bg-card"
      data-testid="entity-panel"
      aria-label="Module entities"
    >
      <button
        type="button"
        className="flex items-center gap-2 border-b px-3 py-2 text-left text-sm font-medium hover:bg-accent"
        aria-expanded={!collapsed}
        onClick={() => {
          setCollapsed((value) => !value);
        }}
      >
        {collapsed ? (
          <ChevronRightIcon aria-hidden className="size-4" />
        ) : (
          <ChevronDownIcon aria-hidden className="size-4" />
        )}
        Entities
        <span className="ml-auto text-xs text-muted-foreground">
          {detailed} detailed · {mentioned} mentioned
        </span>
      </button>

      {!collapsed && (
        <>
          <div className="flex flex-wrap gap-1 border-b px-3 py-2">
            {STUB_KINDS.map((kind) => {
              const targets = unresolvedByKind.get(kind) ?? [];
              if (targets.length === 0) return null;
              return (
                <Button
                  key={kind}
                  variant="outline"
                  size="xs"
                  disabled={batching !== null}
                  data-testid={`batch-${kind}`}
                  onClick={() => {
                    void generateBatch(kind);
                  }}
                >
                  <SparklesIcon aria-hidden data-icon="inline-start" />
                  {batching === kind ? 'Generating…' : `Generate ${targets.length} ${kind}`}
                </Button>
              );
            })}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 text-sm">
            {entries.length === 0 && (
              <p className="px-1 text-xs text-muted-foreground">
                No wiki-links yet. Write [[Names]] in the premise or parts.
              </p>
            )}
            {entries.map((entry) => (
              <button
                key={entry.name}
                type="button"
                data-testid="entity-row"
                data-resolved={entry.resolved || undefined}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent',
                  !entry.resolved && 'text-muted-foreground',
                )}
                onClick={(event) => {
                  if (entry.resolved) {
                    onScrollTo(entry.name);
                  } else {
                    onStub(entry.name, { x: event.clientX, y: event.clientY });
                  }
                }}
              >
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {entry.ambiguous && (
                  <span title="Multiple artifacts match this name" aria-hidden>
                    ⚠
                  </span>
                )}
                {entry.resolved ? (
                  <Badge variant="secondary" className="shrink-0 text-[10px]">
                    {entry.artifact?.kind}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    stub
                  </Badge>
                )}
                <span className="shrink-0 text-xs text-muted-foreground">×{entry.total}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
