import { useState } from 'react';
import type { JSX } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { BookOpenIcon, FileWarningIcon, LinkIcon, PenLineIcon, UsersIcon } from 'lucide-react';

import type { Artifact, Id, MonsterEntry, MonsterSource, StatBlock } from '@/domain';
import { blankStatBlock } from '@/domain';
import { StatBlockCard, StatBlockForm } from '@/features/campaign/components/stat-block';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { resolveMonsterEntries } from '@/db/monsterResolve';
import { searchRules } from '@/search';

/**
 * Monster source controls + resolved Stat blocks panel (07-MILESTONE-3
 * M3-B): each encounter monster row carries a source selector — link an NPC
 * artifact, cite an ingested rulebook statblock chunk, embed inline stats,
 * or stay name-only. Below the list the resolved stat blocks render as
 * cards; dangling references show a warning badge, never a crash.
 */

const SOURCE_OPTIONS: { value: MonsterSource['type']; label: string }[] = [
  { value: 'none', label: 'None (name only)' },
  { value: 'npc-ref', label: 'Link NPC…' },
  { value: 'rulebook', label: 'From rulebook…' },
  { value: 'inline', label: 'Inline stats' },
];

export function MonsterSourceBadge({ source }: { source: MonsterSource }): JSX.Element {
  switch (source.type) {
    case 'npc-ref':
      return (
        <Badge variant="secondary" aria-label="Linked NPC">
          <UsersIcon aria-hidden className="size-3" /> NPC
        </Badge>
      );
    case 'rulebook':
      return (
        <Badge variant="secondary" aria-label="Rulebook stat block">
          <BookOpenIcon aria-hidden className="size-3" /> Rulebook
        </Badge>
      );
    case 'inline':
      return (
        <Badge variant="secondary" aria-label="Inline stat block">
          <PenLineIcon aria-hidden className="size-3" /> Inline
        </Badge>
      );
    case 'none':
      return <Badge variant="outline">no stats</Badge>;
  }
}

/** Per-row source selector + nested editors (NPC combobox, inline form). */
export function MonsterSourceControls({
  entry,
  campaignArtifacts,
  onChange,
}: {
  entry: MonsterEntry;
  campaignArtifacts: readonly Artifact[];
  onChange: (next: MonsterEntry) => void;
}): JSX.Element {
  const [rulebookOpen, setRulebookOpen] = useState(false);
  const [inlineOpen, setInlineOpen] = useState(false);
  const npcCandidates = campaignArtifacts.filter((artifact) => artifact.kind === 'npc');
  const selectedNpcId =
    entry.source.type === 'npc-ref' ? entry.source.artifactId : null;
  const selectedNpc =
    selectedNpcId === null
      ? undefined
      : npcCandidates.find((artifact) => artifact.id === selectedNpcId);

  function setSource(source: MonsterSource): void {
    onChange({ ...entry, source });
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <MonsterSourceBadge source={entry.source} />
        <Select
          value={entry.source.type}
          items={Object.fromEntries(SOURCE_OPTIONS.map((option) => [option.value, option.label]))}
          onValueChange={(value) => {
            if (value === null) return;
            switch (value) {
              case 'none':
                setSource({ type: 'none' });
                break;
              case 'npc-ref':
                setSource({ type: 'npc-ref', artifactId: selectedNpc?.id ?? npcCandidates[0]?.id ?? '' });
                break;
              case 'rulebook':
                setRulebookOpen(true);
                break;
              case 'inline':
                setInlineOpen(true);
                break;
            }
          }}
        >
          <SelectTrigger size="sm" aria-label={`Stats source for ${entry.name || 'monster'}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SOURCE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {entry.source.type === 'npc-ref' && selectedNpc !== undefined && (
          <Select
            value={entry.source.artifactId}
            items={Object.fromEntries(
              // NPCs with stat blocks first (07-MILESTONE-3 M3-B).
              [...npcCandidates]
                .sort(
                  (a, b) =>
                    Number(b.data.statBlock !== null) - Number(a.data.statBlock !== null),
                )
                .map((artifact) => [artifact.id, artifact.name]),
            )}
            onValueChange={(value) => {
              if (value !== null) setSource({ type: 'npc-ref', artifactId: value });
            }}
          >
            <SelectTrigger size="sm" aria-label="Linked NPC artifact">
              <SelectValue placeholder="Choose NPC" />
            </SelectTrigger>
            <SelectContent>
              {npcCandidates.map((artifact) => (
                <SelectItem key={artifact.id} value={artifact.id}>
                  {artifact.name}
                  {artifact.data.statBlock !== null ? ' (stats)' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {entry.source.type === 'rulebook' && (
          <Button
            variant="ghost"
            size="xs"
            aria-label="Change rulebook stat block"
            onClick={() => {
              setRulebookOpen(true);
            }}
          >
            <LinkIcon aria-hidden data-icon="inline-start" />
            Change
          </Button>
        )}
        {entry.source.type === 'inline' && (
          <Button
            variant="ghost"
            size="xs"
            aria-label="Edit inline stat block"
            onClick={() => {
              setInlineOpen(true);
            }}
          >
            <PenLineIcon aria-hidden data-icon="inline-start" />
            Edit stats
          </Button>
        )}
      </div>

      <RulebookStatblockDialog
        open={rulebookOpen}
        onOpenChange={setRulebookOpen}
        onPick={(chunkId) => {
          setSource({ type: 'rulebook', chunkId });
          setRulebookOpen(false);
        }}
      />

      <Dialog open={inlineOpen} onOpenChange={setInlineOpen}>
        <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
          <DialogTitle>Inline stat block — {entry.name || 'monster'}</DialogTitle>
          <DialogDescription>Embedded one-off stats; not linked to an NPC.</DialogDescription>
          <InlineStatblockEditor
            statBlock={entry.source.type === 'inline' ? entry.source.statBlock : null}
            onChange={(statBlock) => {
              if (statBlock !== null) setSource({ type: 'inline', statBlock });
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Search dialog restricted to ingested statblock chunks (M3-B). */
function RulebookStatblockDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (chunkId: Id) => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ chunkId: Id; label: string; snippet: string }[]>([]);

  async function runSearch(text: string): Promise<void> {
    setQuery(text);
    if (text.trim() === '') {
      setResults([]);
      return;
    }
    const hits = await searchRules(text, { limit: 20, chunkTypes: ['statblock'] });
    setResults(
      hits.map((hit) => ({
        chunkId: hit.chunk.id,
        label: hit.chunk.headingPath.join(' > '),
        snippet: hit.chunk.text.slice(0, 140),
      })),
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogTitle>Link a rulebook stat block</DialogTitle>
        <DialogDescription>Search the ingested bestiary (stat blocks only).</DialogDescription>
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search stat blocks…"
            value={query}
            onValueChange={(value) => {
              void runSearch(value);
            }}
          />
          <CommandList>
            <CommandEmpty>No stat blocks found.</CommandEmpty>
            <CommandGroup>
              {results.map((result) => (
                <CommandItem
                  key={result.chunkId}
                  value={result.chunkId}
                  onSelect={() => {
                    onPick(result.chunkId);
                  }}
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm">{result.label}</span>
                    <span className="truncate text-xs text-muted-foreground">{result.snippet}</span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function InlineStatblockEditor({
  statBlock,
  onChange,
}: {
  statBlock: StatBlock | null;
  onChange: (statBlock: StatBlock | null) => void;
}): JSX.Element {
  if (statBlock === null) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          onChange(blankStatBlock('generic-d20'));
        }}
      >
        Add stat block
      </Button>
    );
  }
  return <StatBlockForm statBlock={statBlock} onChange={onChange} />;
}

/** Resolved stat-block cards for every sourced monster entry (M3-B). */
export function MonsterStatblocksPanel({
  monsters,
}: {
  monsters: readonly MonsterEntry[];
}): JSX.Element | null {
  const sourced = monsters.filter((monster) => monster.source.type !== 'none');
  const resolved = useLiveQuery(
    () => resolveMonsterEntries(sourced),
    [JSON.stringify(sourced)],
  );
  if (sourced.length === 0) return null;

  return (
    <div className="flex flex-col gap-2" data-testid="stat-blocks-panel">
      <span className="text-xs font-medium text-muted-foreground">Stat blocks</span>
      {(resolved ?? []).map((entry, index) => {
        const monster = sourced[index];
        if (monster === undefined) return null;
        return (
          <div key={`${monster.name}-${index}`} className="flex flex-col gap-1 rounded-md border p-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{monster.name}</span>
              <Badge variant="outline">×{monster.count}</Badge>
              {entry.origin === 'missing ref' ? (
                <Badge variant="destructive" aria-label="Missing reference">
                  <FileWarningIcon aria-hidden className="size-3" /> missing ref
                </Badge>
              ) : (
                <Badge variant="secondary">{entry.origin}</Badge>
              )}
            </div>
            {entry.statBlock !== null && (
              <StatBlockCard statBlock={entry.statBlock} name={monster.name} />
            )}
          </div>
        );
      })}
    </div>
  );
}
