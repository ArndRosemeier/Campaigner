import { useEffect, useMemo, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { ClockIcon, SparklesIcon, TriangleAlertIcon } from 'lucide-react';

import { ROUTES } from '@/app/routes';
import { SpellChip } from '@/components/spell-chip';
import { Checkbox } from '@/components/ui/checkbox';
import { loadSpellChunksFor } from '@/db/spellRepo';
import { listRulebooks, readyBooksOf } from '@/db/rulebookRepo';
import { GAME_SYSTEM_LABELS } from '@/domain/gameSystem';
import { DND5E_SPELL_SCHOOL_LABELS } from '@/domain/spellData';
import type {
  Campaign,
  Dnd5eSpellSchool,
  Id,
  Rulebook,
  SpellFilterAxis,
  SpellTradition,
} from '@/domain';
import { useCampaign } from '@/features/campaign/hooks';
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
 * EMPTY IS ALWAYS EXPLAINED, AND WHICH EMPTY IT IS COMES FROM THE DATA
 * (docs/17 row 204, amending row 181's named follow-up): a campaign with NO
 * same-system book at all gets the import remedy; a campaign WITH ready books
 * whose library carries no spell payload gets the RE-IMPORT remedy (docs/12
 * §15.4 — the spells arc had no migration, so a rules pack imported before it
 * needs importing again); and a filter that matches nothing keeps its own
 * distinct state. The first two are told apart by the ready books the page
 * already read — never guessed — and neither is ever a silent blank list.
 *
 * A SAME-SYSTEM BOOK THAT IS NOT READY IS NAMED, NEVER HIDDEN (docs/17 row
 * 277): when the system has no ready book but does have one that is still
 * importing or that failed, the page names those books and their situation
 * instead of claiming nothing is imported. The ready-book answer still comes
 * from the ONE rule, and the not-ready rows are what remains of the same-system
 * books — see the read above.
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
   *
   * A book of this system that is NOT ready is carried too (docs/17 row 277).
   * The page used to read ready books only, so a same-system book that was still
   * importing — or that had failed — made it claim "No spells imported for
   * <system>", i.e. told the owner to import what is already importing. The
   * ready half still comes from the ONE rule (`readyBooksOf`); the other half is
   * what is LEFT of the same-system rows, so no second "is ready" predicate
   * exists.
   */
  const loaded = useLiveQuery(async () => {
    if (campaign === undefined) return undefined;
    if (campaign === null) return null;
    const books = await listRulebooks();
    const ready = readyBooksOf(books, campaign.system);
    const readyIds = new Set(ready.map((book) => book.id));
    const notReady = books.filter(
      (book) => book.system === campaign.system && !readyIds.has(book.id),
    );
    const chunks = await loadSpellChunksFor(campaign.system);
    return { books: ready, notReady, chunks };
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
        loaded.books.length > 0 ? (
          <EmptySpells
            testId="spells-no-spell-data"
            title={`No spell data in your ${GAME_SYSTEM_LABELS[system]} library`}
            body={
              system === 'pathfinder2e'
                ? 'Your Pathfinder 2e books carry no structured spell data — a rules pack imported before the app stored spells that way looks exactly like this, and so does a library with only a bestiary pack. Re-import the Pathfinder 2e rules-text pack on the Rules page to add the spell list.'
                : 'Your D&D 5e books carry no structured spell data — a rules pack imported before the app stored spells that way looks exactly like this, and so does a library with only a bestiary pack. Re-import the D&D 5e SRD spells pack on the Rules page to add the spell list.'
            }
            remedy
          />
        ) : loaded.notReady.length > 0 ? (
          // A same-system book EXISTS but is not ready (docs/17 row 277):
          // naming it is the honest answer — "No spells imported for <system>"
          // would tell the owner to import what is already importing.
          <NotReadySpells books={loaded.notReady} system={system} />
        ) : (
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
        )
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
 * 181): the title states the FACT and the body names the way out. `children`
 * and `icon` let the not-ready state below reuse this ONE shell instead of
 * growing a second empty-state frame.
 */
function EmptySpells({
  testId,
  title,
  body,
  remedy = false,
  icon,
  children,
}: {
  testId: string;
  title: string;
  body: string;
  remedy?: boolean;
  icon?: JSX.Element;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-8 text-center"
      data-testid={testId}
    >
      {icon ?? <SparklesIcon aria-hidden className="size-8 text-muted-foreground" />}
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="max-w-[52ch] text-xs text-muted-foreground">{body}</p>
      {children}
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

/**
 * The empty state for a system whose books are NOT ready yet (docs/17 row
 * 277): it NAMES them and says each one's own situation, so the page never
 * claims nothing is imported while a same-system import is running or has
 * failed. The ready half is the ONE ready-book rule's answer (see the read in
 * `SpellsPage`), and these rows are simply what is left of the same-system
 * books — there is deliberately no second "is ready" predicate here.
 */
function NotReadySpells({
  books,
  system,
}: {
  books: readonly Rulebook[];
  system: Campaign['system'];
}): JSX.Element {
  const label = GAME_SYSTEM_LABELS[system];
  const processing = books.filter((book) => book.status === 'processing');
  const failed = books.filter((book) => book.status === 'error');
  const title =
    processing.length > 0 && failed.length === 0
      ? `${label} books are still importing`
      : `No spells imported yet for ${label}`;
  const body = [
    processing.length === 0
      ? ''
      : `${String(processing.length)} ${label} book${processing.length === 1 ? '' : 's'} ` +
        `${processing.length === 1 ? 'is' : 'are'} still importing — the spell list appears ` +
        `here when the import finishes.`,
    failed.length === 0
      ? ''
      : `${String(failed.length)} ${label} import${failed.length === 1 ? '' : 's'} failed — ` +
        `the way forward is named on the book's card on the Rules page.`,
  ]
    .filter((line) => line !== '')
    .join(' ');
  return (
    <EmptySpells
      testId="spells-not-ready"
      title={title}
      body={body}
      remedy
      icon={<ClockIcon aria-hidden className="size-8 text-muted-foreground" />}
    >
      <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
        {books.map((book) => (
          <li key={book.id} data-testid="spells-not-ready-book" data-status={book.status}>
            <span className="font-medium text-foreground">{book.title}</span>
            {' — '}
            {notReadyLine(book)}
          </li>
        ))}
      </ul>
    </EmptySpells>
  );
}

/**
 * What one not-ready book's own line says. The REMEDY is the book's own: a pack
 * book is imported again ("Import bestiary pack"), a PDF book is re-selected
 * through the `Retry…` control its card carries — naming the wrong one would be
 * the same defect this state exists to prevent (docs/17 row 277).
 */
function notReadyLine(book: Rulebook): string {
  if (book.status === 'processing') return 'still importing…';
  return book.origin === 'pack'
    ? 'the import failed — import this pack again on the Rules page'
    : 'the import failed — open its card on the Rules page and choose "Retry…"';
}
