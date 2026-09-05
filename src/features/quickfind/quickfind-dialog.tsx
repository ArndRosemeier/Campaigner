import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import MiniSearch from 'minisearch';
import { BookOpenIcon, CompassIcon } from 'lucide-react';

import type { AnyArtifact, Artifact, Id, Module, RuleChunk } from '@/domain';
import type { GoToEntry } from '@/features/quickfind/go-to';
import { usePinnedChunksStore } from '@/features/rules/pinStore';
import { searchRules, type SearchHit } from '@/search';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

/**
 * Quick-find command palette (07-MILESTONE-3 M3-C, Ctrl+K): one input over
 * campaign artifacts (name/tags/summary/aliases via MiniSearch), modules and
 * their parts (M4-D) and rule chunks (existing searchRules), in three result
 * groups — plus an optional "Go to" group of screens while the query is
 * empty (P5: the palette doubles as an app map). Enter on an artifact sets
 * focus (play) or opens the editor (workspace); Enter on a module/part
 * scrolls the module reader; Enter on a chunk expands an inline preview
 * with "Pin to Assistant".
 */

export type QuickFindMode = 'picker' | 'workspace';

interface ArtifactHit {
  artifact: AnyArtifact;
  /** Verbatim alias that matched the query, shown as the row's "aka" hint. */
  matchedAlias?: string | undefined;
}

/** MiniSearch's default field tokenizer — mirrored only to resolve a matched
 * index term back to the verbatim alias string for the row hint. */
const MINISEARCH_TOKEN_SPLIT = /[\n\r\p{Z}\p{P}]+/u;

/**
 * The first verbatim alias containing a term MiniSearch matched in the
 * `aliases` field (`match` keys are processed index terms, lowercased; search
 * is exact-term, so a matched alias term is one of the alias's tokens). A
 * display hint only — quickfind is a search surface, not a grounding one:
 * rows are never filtered or deduplicated on it, and a name match on the same
 * artifact appears just the same.
 */
function matchedAliasHint(
  artifact: AnyArtifact,
  match: Record<string, string[]>,
): string | undefined {
  const aliasTerms = Object.entries(match)
    .filter(([, fields]) => fields.includes('aliases'))
    .map(([term]) => term);
  if (aliasTerms.length === 0) return undefined;
  for (const alias of artifact.aliases) {
    const tokens = alias
      .toLowerCase()
      .split(MINISEARCH_TOKEN_SPLIT)
      .filter((token) => token !== '');
    if (aliasTerms.some((term) => tokens.includes(term))) return alias;
  }
  return undefined;
}

/** One module/part match ("selecting scrolls the reader"). */
export interface ModuleHit {
  module: Module;
  /** Undefined = the module itself; else the part index. */
  partIndex?: number | undefined;
}

/** Case-insensitive substring match over module title + part titles/bands. */
export function matchModules(
  query: string,
  modules: readonly Module[],
  limit = 8,
): ModuleHit[] {
  const text = query.trim().toLowerCase();
  if (text === '') return [];
  const hits: ModuleHit[] = [];
  for (const module of modules) {
    if (module.title.toLowerCase().includes(text) && hits.length < limit) {
      hits.push({ module });
    }
    const plan = module.spine?.partPlan ?? [];
    for (const [partIndex, part] of plan.entries()) {
      if (hits.length >= limit) break;
      const haystack =
        `${part.title} ${part.levelBand} ${part.synopsis}`.toLowerCase();
      if (haystack.includes(text)) {
        hits.push({ module, partIndex });
      }
    }
  }
  return hits.slice(0, limit);
}

export interface QuickFindDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Any-scope rows, already filtered by the caller's scope control. */
  artifacts: readonly AnyArtifact[];
  mode: QuickFindMode;
  /** Campaign modules + parts (M4-D). Omit → no module group. */
  modules?: readonly Module[] | undefined;
  /** Picker mode: receives the picked artifact without navigation. */
  onPickArtifact?: (artifact: AnyArtifact) => void;
  /** Workspace mode: caller navigates to the artifact editor. */
  onWorkspaceArtifact?: (artifact: AnyArtifact) => void;
  /** Module/part pick: caller scrolls the module reader. */
  onPickModule?: (moduleId: Id, partIndex: number | undefined) => void;
  /**
   * "Go to" entries (screens), shown while the query is empty — the palette
   * doubles as an app map. Omit → no Go-to group (e.g. in-surface pickers).
   */
  goTo?: readonly GoToEntry[] | undefined;
  /** Receives the entry's `to` path; the caller closes + navigates. */
  onGoTo?: (to: string) => void;
}

export function QuickFindDialog({
  open,
  onOpenChange,
  artifacts,
  mode,
  modules,
  onPickArtifact,
  onWorkspaceArtifact,
  onPickModule,
  goTo,
  onGoTo,
}: QuickFindDialogProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [artifactHits, setArtifactHits] = useState<ArtifactHit[]>([]);
  const [ruleHits, setRuleHits] = useState<SearchHit[]>([]);
  const [moduleHits, setModuleHits] = useState<ModuleHit[]>([]);
  const [expandedChunkId, setExpandedChunkId] = useState<Id | null>(null);
  const pin = usePinnedChunksStore((state) => state.pin);
  const index = useRef<MiniSearch<Artifact> | null>(null);
  const artifactById = useMemo(
    () => new Map(artifacts.map((artifact) => [artifact.id, artifact])),
    [artifacts],
  );

  // Rebuild the artifact index whenever the dialog opens (campaign sizes are
  // small; a fresh index per open is simpler than invalidation).
  useEffect(() => {
    if (!open) return;
    const mini = new MiniSearch<AnyArtifact>({
      fields: ['name', 'tags', 'summary', 'aliases'],
      storeFields: ['id'],
      extractField: (artifact, field) =>
        field === 'tags'
          ? artifact.tags.join(' ')
          : field === 'aliases'
            ? artifact.aliases.join(' ')
            : artifact[field as 'name' | 'summary'],
    });
    mini.addAll([...artifacts]);
    index.current = mini;
    setQuery('');
    setArtifactHits([]);
    setRuleHits([]);
    setModuleHits([]);
    setExpandedChunkId(null);
  }, [open, artifacts]);

  useEffect(() => {
    if (!open) return;
    const text = query.trim();
    if (text === '') {
      setArtifactHits([]);
      setRuleHits([]);
      setModuleHits([]);
      return;
    }
    const hits = index.current?.search(text).slice(0, 10) ?? [];
    setArtifactHits(
      hits.flatMap((hit) => {
        const artifact = artifactById.get(String(hit.id));
        if (artifact === undefined) return [];
        const matchedAlias = matchedAliasHint(artifact, hit.match);
        return matchedAlias === undefined ? [{ artifact }] : [{ artifact, matchedAlias }];
      }),
    );
    setModuleHits(matchModules(text, modules ?? []));
    let cancelled = false;
    void searchRules(text, { limit: 8 }).then((hits) => {
      if (!cancelled) setRuleHits(hits);
    });
    return () => {
      cancelled = true;
    };
  }, [query, open, artifactById, modules]);

  function pickArtifact(artifact: AnyArtifact): void {
    if (mode === 'picker') {
      onPickArtifact?.(artifact);
      onOpenChange(false);
      return;
    }
    onWorkspaceArtifact?.(artifact);
  }

  function pickModule(hit: ModuleHit): void {
    onPickModule?.(hit.module.id, hit.partIndex);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" data-testid="quickfind-dialog">
        <DialogTitle>Quick find</DialogTitle>
        <DialogDescription>
          Search artifacts, modules and rules for this campaign.
        </DialogDescription>
        <Command shouldFilter={false}>
          <CommandInput
            autoFocus
            placeholder="Search…"
            value={query}
            onValueChange={setQuery}
            data-testid="quickfind-input"
          />
          <CommandList>
            <CommandEmpty>Nothing found.</CommandEmpty>
            {query.trim() === '' && goTo !== undefined && goTo.length > 0 && onGoTo !== undefined && (
              <CommandGroup heading="Go to">
                {goTo.map((entry) => (
                  <CommandItem
                    key={entry.label}
                    value={entry.label}
                    data-testid="quickfind-go-to"
                    onSelect={() => {
                      onGoTo(entry.to);
                    }}
                  >
                    <CompassIcon aria-hidden className="mr-2 size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{entry.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {artifactHits.length > 0 && (
              <CommandGroup heading="Artifacts">
                {artifactHits.map(({ artifact, matchedAlias }) => (
                  <CommandItem
                    key={artifact.id}
                    value={artifact.id}
                    data-testid="quickfind-artifact"
                    onSelect={() => {
                      pickArtifact(artifact);
                    }}
                  >
                    <span className="truncate">
                      {artifact.name}
                      <span className="ml-2 text-xs text-muted-foreground">
                        {artifact.campaignId === null ? `Library · ${artifact.kind}` : artifact.kind}
                      </span>
                      {matchedAlias !== undefined && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          aka: {matchedAlias}
                        </span>
                      )}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {moduleHits.length > 0 && (
              <CommandGroup heading="Modules">
                {moduleHits.map((hit, hitIndex) => (
                  <CommandItem
                    key={`${hit.module.id}-${String(hit.partIndex ?? 'm')}-${String(hitIndex)}`}
                    value={`${hit.module.id}-${String(hit.partIndex ?? 'm')}`}
                    data-testid="quickfind-module"
                    onSelect={() => {
                      pickModule(hit);
                    }}
                  >
                    <BookOpenIcon aria-hidden className="mr-2 size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">
                      {hit.module.title}
                      {hit.partIndex === undefined ? (
                        <span className="ml-2 text-xs text-muted-foreground">module</span>
                      ) : (
                        (() => {
                          const part = hit.module.spine?.partPlan[hit.partIndex];
                          return (
                            <span className="ml-2 text-xs text-muted-foreground">
                              Part {String((hit.partIndex ?? 0) + 1)}: {part?.levelBand ?? ''} ·{' '}
                              {part?.title ?? ''}
                            </span>
                          );
                        })()
                      )}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {ruleHits.length > 0 && (
              <CommandGroup heading="Rules">
                {ruleHits.map((hit) => {
                  const chunk: RuleChunk = hit.chunk;
                  const expanded = expandedChunkId === chunk.id;
                  return (
                    <div key={chunk.id}>
                      <CommandItem
                        value={chunk.id}
                        data-testid="quickfind-chunk"
                        onSelect={() => {
                          setExpandedChunkId((current) => (current === chunk.id ? null : chunk.id));
                        }}
                      >
                        <span className="truncate">
                          {chunk.headingPath.join(' > ')}
                          <span className="ml-2 text-xs text-muted-foreground">
                            p.{chunk.pageStart}
                          </span>
                        </span>
                      </CommandItem>
                      {expanded && (
                        <div className="flex flex-col gap-1 border-l-2 border-border px-3 py-1.5">
                          <p className="line-clamp-6 text-xs whitespace-pre-wrap text-muted-foreground">
                            {chunk.text}
                          </p>
                          <Button
                            variant="outline"
                            size="xs"
                            className="self-start"
                            aria-label="Pin to Assistant"
                            onClick={() => {
                              pin(chunk);
                            }}
                          >
                            Pin to Assistant
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
