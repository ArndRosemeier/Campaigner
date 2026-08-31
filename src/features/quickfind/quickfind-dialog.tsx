import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import MiniSearch from 'minisearch';

import type { Artifact, Id, RuleChunk } from '@/domain';
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
 * campaign artifacts (name/tags/summary via MiniSearch) and rule chunks
 * (existing searchRules), in two result groups. Enter on an artifact sets
 * focus (play) or opens the editor (workspace); Enter on a chunk expands an
 * inline preview with "Pin to Assistant".
 */

export type QuickFindMode = 'play' | 'workspace';

interface ArtifactHit {
  artifact: Artifact;
}

export interface QuickFindDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  artifacts: readonly Artifact[];
  mode: QuickFindMode;
  /** Play mode: receives the picked artifact to set focus. */
  onPickArtifact?: (artifact: Artifact) => void;
  /** Workspace mode: caller navigates to the artifact editor. */
  onWorkspaceArtifact?: (artifact: Artifact) => void;
}

export function QuickFindDialog({
  open,
  onOpenChange,
  artifacts,
  mode,
  onPickArtifact,
  onWorkspaceArtifact,
}: QuickFindDialogProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [artifactHits, setArtifactHits] = useState<ArtifactHit[]>([]);
  const [ruleHits, setRuleHits] = useState<SearchHit[]>([]);
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
    const mini = new MiniSearch<Artifact>({
      fields: ['name', 'tags', 'summary'],
      storeFields: ['id'],
      extractField: (artifact, field) =>
        field === 'tags' ? artifact.tags.join(' ') : artifact[field as 'name' | 'summary'],
    });
    mini.addAll([...artifacts]);
    index.current = mini;
    setQuery('');
    setArtifactHits([]);
    setRuleHits([]);
    setExpandedChunkId(null);
  }, [open, artifacts]);

  useEffect(() => {
    if (!open) return;
    const text = query.trim();
    if (text === '') {
      setArtifactHits([]);
      setRuleHits([]);
      return;
    }
    const ids = index.current?.search(text).slice(0, 10).map((hit) => String(hit.id)) ?? [];
    setArtifactHits(
      ids.flatMap((id) => {
        const artifact = artifactById.get(id);
        return artifact === undefined ? [] : [{ artifact }];
      }),
    );
    let cancelled = false;
    void searchRules(text, { limit: 8 }).then((hits) => {
      if (!cancelled) setRuleHits(hits);
    });
    return () => {
      cancelled = true;
    };
  }, [query, open, artifactById]);

  function pickArtifact(artifact: Artifact): void {
    if (mode === 'play') {
      onPickArtifact?.(artifact);
      onOpenChange(false);
      return;
    }
    onWorkspaceArtifact?.(artifact);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" data-testid="quickfind-dialog">
        <DialogTitle>Quick find</DialogTitle>
        <DialogDescription>
          Search artifacts and rules for this campaign.
        </DialogDescription>
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search…"
            value={query}
            onValueChange={setQuery}
            data-testid="quickfind-input"
          />
          <CommandList>
            <CommandEmpty>Nothing found.</CommandEmpty>
            {artifactHits.length > 0 && (
              <CommandGroup heading="Artifacts">
                {artifactHits.map(({ artifact }) => (
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
                      <span className="ml-2 text-xs text-muted-foreground">{artifact.kind}</span>
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
