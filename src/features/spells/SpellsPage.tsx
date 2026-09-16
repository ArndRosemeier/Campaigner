import { useEffect, useMemo, useState } from 'react';
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
import { DND5E_SPELL_SCHOOL_LABELS } from '@/domain/spellData';
import type { Campaign, Dnd5eSpellSchool, Id, SpellFilterAxis, SpellTradition } from '@/domain';
import { useCampaign } from '@/features/campaign/hooks';
import { readyBookIds } from '@/search';
import { SpellCard } from '@/features/spells/spell-card';
import { buildSpellRows, filterSpellRows, type SpellRow } from '@/features/spells/spell-rows';

/**
 * The campaign's spell list (docs/17 row 182, docs/12 §15): every imported
 * `spell` chunk of the campaign's OWN game system, ordered by rank with
 * cantrips first and filterable on that system's OWN axis (multi-select),
 * with the selected spell's details in the right-hand pane.
 *
 * WHY THIS IS CAMPAIGN-SCOPED. A spell's game system is a property of the
 * imported material, and the library is global, so "which spells" has no
 * app-level answer — but `campaign.system` already answers it. The page reads
 * ready, SAME-SYSTEM books only (`search.readyBookIds`, the same rule the
 * retrieval pool uses) and drops a cross-system chunk rather than merging it:
 * a Pathfinder 2e campaign must never surface a dnd5e row.
 *
 * THE FILTER AXIS IS THE PAYLOAD'S OWN, NEVER INVENTED (row 194). A PF2e
 * spell is filtered by its traditions; a dnd5e spell by its SCHOOL — the
 * payload's own `filterAxis` (stamped by the adapter that read the document)
 * says which, and the strip's label says which it is. A 5e spell is therefore
 * NEVER given a PF2e tradition, and a spell whose source states no value on
 * its axis is listed with that stated plainly rather than being filtered into
 * or out of a category it does not have.
 *
 * EMPTY IS ALWAYS EXPLAINED, PER SYSTEM (docs/17 row 181's named follow-up,
 * amended by row 194 when the dnd5e lane landed): a campaign whose system has
 * no ready spell corpus gets the named absence plus the import remedy — for
 * BOTH systems now that dnd5e spells are imported too. A filter that matches
 * nothing is a third, distinct state.
 */
export function SpellsPage(): JSX.Element {
  const { campaignId = '' } = useParams<{ campaignId: string }>();
  const campaign = useCampaign(campaignId === '' ? undefined : campaignId);
  const [selectedId, setSelectedId] = useState<Id | null>(null);
  // ONE selection for whichever axis the corpus carries (a campaign is one
  // system, so rows cannot mix axes); switching axis cannot inherit a stale
  // selection; changing campaign resets it (a selection of `evo` means
  // nothing in a PF2e campaign).
  const [selectedAxis, setSelectedAxis] = useState<string[]>([]);
  useEffect(() => {
    setSelectedAxis([]);
  }, [campaignId]);

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
  const rows = useMemo(() => filterSpellRows(allRows, selectedAxis), [allRows, selectedAxis]);

  const errorRows = rows.filter((row) => row.kind === 'data-error');
  const entryCount = rows.filter((row) => row.kind === 'entry').length;
  const totalEntries = allRows.filter((row) => row.kind === 'entry').length;

  /**
   * The corpus's OWN filter axis (row 194), taken from the rows' payloads —
   * NOT from the campaign system, so the strip can only label an axis the
   * documents actually state. A corpus with no axis at all (a pre-arc payload,
   * or 5e spells whose source states no school) offers no filter and says so.
   */
  const filterAxis: SpellFilterAxis | null = useMemo(() => {
    for (const row of allRows) {
      if (row.kind === 'entry' && row.filterAxis !== null) return row.filterAxis;
    }
    return null;
  }, [allRows]);
  const axisOptions: readonly { value: string; label: string }[] =
    filterAxis === 'tradition'
      ? TRADITIONS.map((tradition) => ({ value: tradition, label: tradition }))
      : filterAxis === 'school'
        ? SCHOOLS.map((school) => ({ value: school, label: DND5E_SPELL_SCHOOL_LABELS[school] }))
        : [];

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

      {totalEntries === 0 && errorRows.length === 0 ? (
        <EmptySpells
          testId="spells-no-material"
          title={`No spells imported for ${GAME_SYSTEM_LABELS[system]}`}
          body={
            system === 'pathfinder2e'
              ? 'Import the Pathfinder 2e rules-text pack on the Rules page — its spell documents appear here, ordered by rank and filterable by tradition.'
              : 'Import the D&D 5e SRD spells pack on the Rules page — its spell documents appear here, ordered by level and filterable by school.'
          }
          remedy
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            className="mb-2 flex flex-wrap items-center gap-3 rounded-lg border p-2 text-xs"
            data-testid="spell-filter"
          >
            {filterAxis === null ? (
              <span className="text-muted-foreground" data-testid="spell-filter-none">
                These spells state no {system === 'dnd5e' ? 'school' : 'tradition'} in their
                source, so there is nothing to filter by.
              </span>
            ) : (
              <>
                <span className="font-semibold" data-testid="spell-filter-axis">
                  {filterAxis === 'school' ? 'Schools' : 'Traditions'}
                </span>
                {axisOptions.map((option) => (
                  <label key={option.value} className="flex items-center gap-1.5">
                    <Checkbox
                      checked={selectedAxis.includes(option.value)}
                      data-testid={`spell-${filterAxis}-${option.value}`}
                      onCheckedChange={(checked) => {
                        setSelectedAxis((previous) =>
                          checked
                            ? [...previous, option.value]
                            : previous.filter((entry) => entry !== option.value),
                        );
                      }}
                    />
                    {option.label}
                  </label>
                ))}
              </>
            )}
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
                  {filterAxis === 'school'
                    ? 'No spells match the selected schools.'
                    : 'No spells match the selected traditions.'}
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
                        {filterAxis !== null && row.filterValues.length === 0 && (
                          <span
                            className="text-xs text-muted-foreground"
                            data-testid="spell-no-axis-value"
                          >
                            no {filterAxis === 'school' ? 'school' : 'tradition'}
                          </span>
                        )}
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

/** The dnd5e schools the filter offers — the system's own keys, in the order
 *  its `CONFIG.DND5E.spellSchools` declares them. */
const SCHOOLS: readonly Dnd5eSpellSchool[] = ['abj', 'con', 'div', 'enc', 'evo', 'ill', 'nec', 'trs'];

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
