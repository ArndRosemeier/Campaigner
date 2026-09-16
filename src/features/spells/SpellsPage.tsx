import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { SparklesIcon, TriangleAlertIcon } from 'lucide-react';

import { ROUTES } from '@/app/routes';
import { SpellChip } from '@/components/spell-chip';
import { Checkbox } from '@/components/ui/checkbox';
import { loadSpellChunksFor } from '@/db/spellRepo';
import { listRulebooks } from '@/db/rulebookRepo';
import { GAME_SYSTEM_LABELS } from '@/domain/gameSystem';
import type { Campaign, Id, SpellTradition } from '@/domain';
import { useCampaign } from '@/features/campaign/hooks';
import { readyBookIds } from '@/search';
import { SpellCard } from '@/features/spells/spell-card';
import { buildSpellRows, filterSpellRows, type SpellRow } from '@/features/spells/spell-rows';

/**
 * The campaign's spell list (docs/17 row 182, docs/12 §15): every imported
 * `spell` chunk of the campaign's OWN game system, ordered by rank with
 * cantrips first and filterable by tradition (multi-select — a spell carries
 * 0..n), with the selected spell's details in the right-hand pane.
 *
 * WHY THIS IS CAMPAIGN-SCOPED. A spell's game system is a property of the
 * imported material, and the library is global, so "which spells" has no
 * app-level answer — but `campaign.system` already answers it. The page reads
 * ready, SAME-SYSTEM books only (`search.readyBookIds`, the same rule the
 * retrieval pool uses) and drops a cross-system chunk rather than merging it:
 * a Pathfinder 2e campaign must never surface a dnd5e row.
 *
 * EMPTY IS ALWAYS EXPLAINED, PER SYSTEM (docs/17 row 181's named follow-up):
 * a dnd5e campaign has no imported spells at all — that adapter skips spell
 * documents — so the page says so instead of rendering an empty list; a
 * Pathfinder 2e campaign with no ready rules-text pack gets the named absence
 * plus the import remedy. A filter that matches nothing is a third, distinct
 * state.
 */
export function SpellsPage(): JSX.Element {
  const { campaignId = '' } = useParams<{ campaignId: string }>();
  const campaign = useCampaign(campaignId === '' ? undefined : campaignId);
  const [selectedId, setSelectedId] = useState<Id | null>(null);
  const [traditions, setTraditions] = useState<SpellTradition[]>([]);

  /**
   * Ready books of the campaign's system (the ONE ready-book rule) plus every
   * `spell` chunk of those books. Both halves ride the ONE spell-corpus read
   * (`db/spellRepo.loadSpellChunksFor`, docs/17 row 184) — the same read a
   * mob's chips and the run engine's stat-block grounding use, and the
   * cross-system rows are dropped by the book-id intersection.
   */
  const loaded = useLiveQuery(async () => {
    if (campaign === undefined) return undefined;
    if (campaign === null) return null;
    const readyIds = new Set(await readyBookIds(campaign.system));
    const books = (await listRulebooks()).filter((book) => readyIds.has(book.id));
    const chunks = await loadSpellChunksFor(campaign.system);
    return { books, chunks };
  }, [campaign]);

  const allRows: SpellRow[] = useMemo(
    () => (loaded === undefined || loaded === null ? [] : buildSpellRows(loaded.books, loaded.chunks)),
    [loaded],
  );
  const rows = useMemo(() => filterSpellRows(allRows, traditions), [allRows, traditions]);

  const errorRows = rows.filter((row) => row.kind === 'data-error');
  const entryCount = rows.filter((row) => row.kind === 'entry').length;
  const totalEntries = allRows.filter((row) => row.kind === 'entry').length;

  const selected = useMemo(() => {
    if (selectedId === null || loaded === undefined || loaded === null) return null;
    const row = allRows.find((candidate) => candidate.kind === 'entry' && candidate.chunkId === selectedId);
    if (row?.kind !== 'entry') return null;
    const chunk = loaded.chunks.find((candidate) => candidate.id === selectedId);
    if (chunk === undefined) return null;
    return { row, description: chunk.text };
  }, [selectedId, allRows, loaded]);

  if (campaign === undefined || loaded === undefined) {
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  }
  if (campaign === null || loaded === null) {
    return <p className="p-6 text-sm text-destructive">Campaign not found.</p>;
  }

  const system: Campaign['system'] = campaign.system;

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col p-6" data-testid="spells-page">
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <h1 className="font-heading text-xl font-semibold">Spells</h1>
        <span className="text-sm text-muted-foreground" data-testid="spells-count">
          {String(entryCount)} spell{entryCount === 1 ? '' : 's'}
          {errorRows.length > 0 && (
            <span className="ml-2 text-destructive">
              {String(errorRows.length)} data error{errorRows.length === 1 ? '' : 's'}
            </span>
          )}
        </span>
      </div>

      {system !== 'pathfinder2e' ? (
        <EmptySpells
          testId="spells-not-imported"
          title={`Spells are not imported for ${GAME_SYSTEM_LABELS[system]}`}
          body="Campaigner imports spells from the Pathfinder 2e rules-text pack only; this campaign's system has no spell corpus to show."
        />
      ) : totalEntries === 0 && errorRows.length === 0 ? (
        <EmptySpells
          testId="spells-no-material"
          title="No spells imported for Pathfinder 2e"
          body="Import the Pathfinder 2e rules-text pack on the Rules page — its spell documents appear here, ordered by rank and filterable by tradition."
          remedy
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            className="mb-2 flex flex-wrap items-center gap-3 rounded-lg border p-2 text-xs"
            data-testid="spell-tradition-filter"
          >
            <span className="font-semibold">Traditions</span>
            {TRADITIONS.map((tradition) => (
              <label key={tradition} className="flex items-center gap-1.5">
                <Checkbox
                  checked={traditions.includes(tradition)}
                  data-testid={`spell-tradition-${tradition}`}
                  onCheckedChange={(checked) => {
                    setTraditions((previous) =>
                      checked
                        ? [...previous, tradition]
                        : previous.filter((entry) => entry !== tradition),
                    );
                  }}
                />
                {tradition}
              </label>
            ))}
          </div>
          <div className="flex min-h-0 flex-1">
            <div className="min-w-0 flex-1 overflow-auto" data-testid="spell-list">
              {errorRows.length > 0 && (
                <ul className="mb-2 flex flex-col gap-1">
                  {errorRows.map((row) => (
                    <li
                      key={row.chunkId}
                      className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-xs text-destructive"
                      data-testid="spell-data-error"
                    >
                      <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
                      {row.message}
                    </li>
                  ))}
                </ul>
              )}
              {entryCount === 0 ? (
                <p className="p-4 text-sm text-muted-foreground" data-testid="spells-filter-empty">
                  No spells match the selected traditions.
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {rows
                    .filter((row): row is Extract<SpellRow, { kind: 'entry' }> => row.kind === 'entry')
                    .map((row) => (
                      <li key={row.chunkId} className="flex items-center gap-2">
                        <SpellChip
                          data-spell-chunk-id={row.chunkId}
                          aria-pressed={selectedId === row.chunkId}
                          name={row.name}
                          detail={
                            row.origin === '' ? row.name : `${row.rankLabel} — ${row.origin}`
                          }
                          onClick={() => {
                            setSelectedId(row.chunkId);
                          }}
                        />
                        <span className="text-xs text-muted-foreground">{row.rankLabel}</span>
                      </li>
                    ))}
                </ul>
              )}
            </div>
            <div className="w-96 shrink-0 overflow-auto border-l p-3" data-testid="spell-detail">
              {selected === null ? (
                <p className="text-sm text-muted-foreground">
                  Select a spell to see its details.
                </p>
              ) : (
                <div data-testid="spell-detail-card">
                  {selected.row.origin !== '' && (
                    <p className="mb-2 text-xs text-muted-foreground">{selected.row.origin}</p>
                  )}
                  <SpellCard
                    name={selected.row.name}
                    spellData={selected.row.data}
                    description={selected.description}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** The traditions the filter offers — the domain enum, in its declared order. */
const TRADITIONS: readonly SpellTradition[] = ['arcane', 'divine', 'occult', 'primal'];

/**
 * A named empty state. Never a silent empty list (AGENTS rule 1, docs/17 row
 * 181): the title states the FACT and the body names the way out.
 */
function EmptySpells({
  testId,
  title,
  body,
  remedy = false,
}: {
  testId: string;
  title: string;
  body: string;
  remedy?: boolean;
}): JSX.Element {
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-8 text-center"
      data-testid={testId}
    >
      <SparklesIcon aria-hidden className="size-8 text-muted-foreground" />
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="max-w-[52ch] text-xs text-muted-foreground">{body}</p>
      {remedy && (
        <Link
          to={ROUTES.rules}
          className="text-xs underline underline-offset-2 hover:text-foreground"
          data-testid="spells-import-remedy"
        >
          Open the Rules page
        </Link>
      )}
    </div>
  );
}
