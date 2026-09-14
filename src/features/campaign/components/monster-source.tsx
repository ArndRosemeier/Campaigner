import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { BookOpenIcon, FileWarningIcon, LinkIcon, PenLineIcon, UsersIcon } from 'lucide-react';

import type { AnyArtifact, Id, MonsterEntry, MonsterSource, StatBlock } from '@/domain';
import type { GameSystem } from '@/domain/gameSystem';
import { blankStatBlock } from '@/domain';
import {
  isMissingRefOrigin,
  rosterReferenceFor,
  rosterStatBlockFor,
} from '@/domain/encounterResolve';
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
import { getRulebook } from '@/db/rulebookRepo';
import { citationBookTitle, contentIdentityFor } from '@/domain/encounterResolve';
import { searchRules } from '@/search';

/**
 * Monster source controls + resolved roster panel (07-MILESTONE-3 M3-B): each
 * encounter monster row carries a source selector — link an NPC artifact, cite
 * an ingested rulebook statblock chunk, embed inline stats, or stay name-only.
 * Below the list EVERY roster entry renders as a card with the reference and the
 * numbers the ONE domain rules produce (docs/17 rows 144/146 —
 * `MonsterStatblocksPanel`), so the editor, the session-mode card and the module
 * reader's entity panel all read the same line the exported books print; a
 * dangling reference names itself, never a crash.
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
  campaignSystem,
  onChange,
}: {
  entry: MonsterEntry;
  campaignArtifacts: readonly AnyArtifact[];
  /** The dialog's stat-block pool stays inside the campaign's game system. */
  campaignSystem: GameSystem;
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
        campaignSystem={campaignSystem}
        onPick={(pick) => {
          // Content identity stamped at citation birth (chunk-hash-fallback
          // arc): the uuid alone breaks on re-ingest; the hash survives it.
          setSource({
            type: 'rulebook',
            chunkId: pick.chunkId,
            ...contentIdentityFor(
              pick.contentHash,
              pick.creatureHeading,
              entry.name,
              pick.bookTitle,
            ),
          });
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
  campaignSystem,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Only books of the campaign's system are offered — no cross-system links. */
  campaignSystem: GameSystem;
  onPick: (pick: {
    chunkId: Id;
    contentHash: string;
    creatureHeading: string;
    bookTitle: string | undefined;
  }) => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<
    {
      chunkId: Id;
      label: string;
      snippet: string;
      contentHash: string;
      creatureHeading: string;
      bookTitle: string | undefined;
    }[]
  >([]);

  async function runSearch(text: string): Promise<void> {
    setQuery(text);
    if (text.trim() === '') {
      setResults([]);
      return;
    }
    // fix-02 (decision 3): the dialog's pool excludes unparsed chunks — a
    // null-statBlock 'statblock' chunk would resolve to "missing ref". The
    // pool is also campaign-scoped by game system: a pf2e pack book's
    // creatures are never offered to a dnd5e campaign (and vice versa).
    const hits = await searchRules(text, {
      limit: 20,
      chunkTypes: ['statblock'],
      hasStatBlock: true,
      system: campaignSystem,
    });
    // The book each hit came from, read ONCE per distinct book: the title is
    // stamped on the citation this pick writes (docs/17 row 155), through the
    // same `citationBookTitle` reading every other citation writer uses.
    const bookIds = [...new Set(hits.map((hit) => hit.chunk.bookId))];
    const titles = new Map<string, string | undefined>(
      await Promise.all(
        bookIds.map(
          async (bookId): Promise<[string, string | undefined]> => [
            bookId,
            citationBookTitle(await getRulebook(bookId)),
          ],
        ),
      ),
    );
    setResults(
      hits.map((hit) => ({
        chunkId: hit.chunk.id,
        label: hit.chunk.headingPath.join(' > '),
        snippet: hit.chunk.text.slice(0, 140),
        contentHash: hit.chunk.contentHash,
        creatureHeading: hit.chunk.headingPath[0] ?? '',
        bookTitle: titles.get(hit.chunk.bookId),
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
            className="pointer-coarse:text-base"
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
                    onPick({
                      chunkId: result.chunkId,
                      contentHash: result.contentHash,
                      creatureHeading: result.creatureHeading,
                      bookTitle: result.bookTitle,
                    });
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

/**
 * The resolved roster of ONE encounter: a card per entry carrying the reference
 * and the numbers a GM needs to run it (M3-B, extended by docs/17 rows 144/146).
 *
 * ONE RULE, both renderers: the reference comes from
 * `domain/encounterResolve.rosterReferenceFor` and the numbers from
 * `rosterStatBlockFor` — the same two seams the module PDF and the
 * single-artifact export render — so the app can never label a roster entry
 * differently from the book it is about to print. This component composes
 * NOTHING: a hand-rolled reference string here is exactly the second mechanism
 * AGENTS rule 4 forbids (`tests/features/reader-encounter-roster.test.tsx` scans
 * for one).
 *
 * EVERY entry is listed, `none` included: a name-only creature is a mob the GM
 * has to find, and the formatter's own sentence says what is true about it —
 * the panel used to drop the row entirely, which is the "no mobs detailed"
 * complaint this slice answers. A citation nothing can supply prints the NAMED
 * `missing ref (<creature>)` line and NO box (never an empty or invented one,
 * AGENTS rule 1).
 */
export function MonsterStatblocksPanel({
  monsters,
  targets,
}: {
  monsters: readonly MonsterEntry[];
  /**
   * The rows THIS surface can cross-reference, for an `npc-ref` entry — the
   * same question `ModulePdfInput`'s destination map answers for the book. The
   * formatter needs the target's NAME and prints ` — see <name>` for a row the
   * surface can point at, and its own named `missing ref (…)` reason for one it
   * cannot; passing a row that does not exist here would therefore be a claim
   * the surface cannot honour, so the pool is stated explicitly at every mount
   * rather than guessed.
   */
  targets: readonly AnyArtifact[];
}): JSX.Element | null {
  const resolved = useLiveQuery(
    () => resolveMonsterEntries(monsters),
    [JSON.stringify(monsters)],
  );
  const byId = useMemo(() => new Map(targets.map((row) => [row.id, row])), [targets]);
  if (monsters.length === 0) return null;

  return (
    <div className="flex flex-col gap-2" data-testid="stat-blocks-panel">
      <span className="text-xs font-medium text-muted-foreground">Stat blocks</span>
      {(resolved ?? []).map((entry, index) => {
        const monster = monsters[index];
        if (monster === undefined) return null;
        // The reference is the formatter's, extracted for exactly this row —
        // never reworded here. While the live query is still resolving, no row
        // is printed at all (an unresolved citation must never flash as truth).
        const target =
          monster.source.type === 'npc-ref'
            ? byId.get(monster.source.artifactId)
            : undefined;
        const reference = rosterReferenceFor(
          monster,
          entry,
          target === undefined ? undefined : { name: target.name, destination: target.id },
        );
        /*
         * THE BOX: the PRINT rule first (`rosterStatBlockFor`), then the block
         * the resolution itself produced. The two agree on every arm but one,
         * and the difference is deliberate and visible rather than hidden: an
         * `npc-ref` row prints NO box in the books because its numbers print at
         * that NPC's own entry one page away (the reference says `see <name>`),
         * while a sidebar has no page to turn to — so the linked row's numbers
         * stay under its own row here. Nothing is invented either way: the
         * fallback is the SAME chunk-or-artifact block the ONE resolution read,
         * and a citation nothing can supply is `null` on both sides, which
         * prints the named `missing ref (…)` line and no box at all.
         */
        const statBlock = rosterStatBlockFor(monster, entry) ?? entry.statBlock;
        return (
          <div
            key={`${monster.name}-${index}`}
            className="flex flex-col gap-1 rounded-md border p-2"
            data-testid="roster-entry"
            data-name={monster.name}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{monster.name}</span>
              <Badge variant="outline">×{monster.count}</Badge>
              <MonsterSourceBadge source={monster.source} />
              {isMissingRefOrigin(entry.origin) && (
                <Badge variant="destructive" aria-label="Missing reference">
                  <FileWarningIcon aria-hidden className="size-3" /> missing ref
                </Badge>
              )}
            </div>
            {reference.printed !== '' && (
              <span
                className="text-xs text-muted-foreground"
                data-testid="roster-reference"
              >
                {reference.printed}
              </span>
            )}
            {monster.notes !== '' && (
              <span className="text-xs text-muted-foreground">{monster.notes}</span>
            )}
            {statBlock !== null && (
              <StatBlockCard statBlock={statBlock} name={monster.name} />
            )}
          </div>
        );
      })}
    </div>
  );
}
