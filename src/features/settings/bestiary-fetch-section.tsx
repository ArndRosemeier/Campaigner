import { useState } from 'react';
import type { JSX } from 'react';
import { CloudDownloadIcon, PackageIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { BlockedControl } from '@/components/blocked-control';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { GAME_SYSTEM_LABELS, type GameSystem } from '@/domain/gameSystem';
import {
  fetchAndImportPack,
  listPackRecipes,
  PACK_FETCH_NEWEST_REF,
  PACK_FETCH_SOURCES,
  type PackFetchProgress,
  type PackFetchResult,
  type PackRecipe,
} from '@/ingest/packFetch';
import type { PackImportProgress } from '@/ingest/packImport';
import { getPackAdapter } from '@/ingest/packs/registry';
import { errorMessage } from '@/lib/errors';
import { toastError, toastSuccess } from '@/lib/toast';
import { useRulebookSummaries } from '@/features/rules/hooks';
import { PackImportReport } from '@/features/rules/pack-import-dialog';
import {
  packSourceImportState,
  type PackSourceCandidate,
  type PackSourceImportState,
} from '@/features/rules/pack-import-state';
import { bookPackLaneCounts, formatPackLanes, formatPackSystem, packLaneCounts } from '@/features/rules/pack-lanes';

/**
 * "Bestiary packs" settings card (16-BESTIARY-FETCH §5): per adapter the
 * curated pack recipes with per-pack "Fetch & import" / "Re-import" buttons,
 * plus the advanced "list everything in the repo" toggle (an on-demand GitHub
 * trees listing). Fetching downloads the pack from the pinned upstream repo into
 * this browser and runs the unchanged `importPack` — the report component is
 * the one from the /rules manual-import dialog, which stays as the fallback.
 *
 * Since docs/17 row 210 every recipe row also STATES whether the library
 * already holds that pack, derived live from the book rows
 * (`features/rules/pack-import-state` — provenance first, title fallback, then
 * the upstream FOLDER name with its basis NAMED, docs/17 row 281; UNKNOWN
 * rather than a guess) with row 204's ONE per-lane breakdown; a matched
 * book stored under another system is stated too, because that is invisible the
 * same way.
 *
 * Failure policy is loud (AGENTS rule 1): fetch/listing/import errors toast
 * via `toastError` AND stay named in the card; one fetch runs at a time.
 */

type FetchState =
  | { kind: 'idle' }
  | { kind: 'fetching'; detail: string }
  | { kind: 'done'; result: PackFetchResult }
  | { kind: 'failed'; message: string };

type FullList =
  | { kind: 'unlisted' }
  | { kind: 'loading' }
  | { kind: 'listed'; recipes: readonly PackRecipe[] };

function progressDetail(progress: PackFetchProgress | PackImportProgress): string {
  if ('phase' in progress) {
    return progress.phase === 'listing'
      ? 'Listing the repo…'
      : `Downloading ${String(progress.done)}/${String(progress.total)}${progress.detail === undefined ? '' : ` — ${progress.detail}`}`;
  }
  return `Importing ${String(progress.done)}/${String(progress.total)} chunks…`;
}

/** The titles an UNKNOWN state names, quoted — never a pick among them. */
function quoteTitles(candidates: readonly PackSourceCandidate[]): string {
  return candidates.map((candidate) => `“${candidate.summary.book.title}”`).join(', ');
}

/** An `imported` state, whichever basis arm proved it. */
type ImportedState = Extract<PackSourceImportState, { kind: 'imported' }>;

/**
 * The BASIS half of the imported line (docs/17 row 281): WHICH key proved the
 * pack, stated rather than assumed. The switch is exhaustive over the `via`
 * union ON PURPOSE — a new basis arm cannot fall through silently. A provenance
 * match was fetched, a title match carries no fetch provenance, and a folder
 * match names the upstream folder the book's title matched so the owner can
 * judge that key himself.
 */
function importedBasis(state: ImportedState, when: string): string {
  switch (state.via) {
    case 'provenance':
      return `Imported — fetched ${when}`;
    case 'title':
      return `Imported — updated ${when}`;
    case 'folder':
      return (
        `Imported from a file — matched by the upstream folder name \`${state.folderName}\` ` +
        `(no fetch provenance) · updated ${when}`
      );
  }
}

/**
 * THE line every recipe row states (docs/17 row 210). The IDENTITY decision is
 * the pure seam (`features/rules/pack-import-state`); the lane breakdown is
 * row 204's ONE formatter over the LIVE spell count, so this row can never
 * print a different spell number than the book's own card.
 *
 * `library-loading` is not "not imported": the live library read has not
 * answered yet, and claiming absence before the answer exists is the lie this
 * row exists to end (AGENTS rule 1).
 */
function importStateLine(state: PackSourceImportState): string {
  switch (state.kind) {
    case 'library-loading':
      return 'Checking the library…';
    case 'not-imported':
      return 'Not imported yet.';
    case 'imported': {
      const fetchedAt = state.candidate.packMeta.fetchedAt;
      const stamp = fetchedAt ?? state.candidate.summary.book.updatedAt;
      return (
        `${importedBasis(state, new Date(stamp).toISOString())} · ` +
        formatPackLanes(
          bookPackLaneCounts(state.candidate.packMeta, state.candidate.summary.spellChunkCount),
        )
      );
    }
    case 'unknown': {
      const count = state.candidates.length;
      const titles = quoteTitles(state.candidates);
      return state.reason === 'ambiguous'
        ? `Import state unknown — ${String(count)} books in the library match this pack (${titles}), so which one to report cannot be decided.`
        : `Import state unknown — ${String(count)} book${count === 1 ? '' : 's'} in the library ` +
            `look${count === 1 ? 's' : ''} like this pack (${titles}) but ` +
            `${count === 1 ? 'carries' : 'carry'} neither provenance nor a matching title, so none is proven to be this pack.`;
    }
  }
}

/**
 * The neighbouring confusion this row closes (docs/17 row 210): a pack stored
 * under another system is invisible to the campaign system that expects it, and
 * nothing on this card said so. The correction is named because it exists — the
 * Rules page's book menu "Set system".
 */
function systemMismatchLine(actual: GameSystem, expected: GameSystem): string {
  return (
    `System mismatch: the matched book is stored as ${GAME_SYSTEM_LABELS[actual]}, but this source imports ` +
    `${GAME_SYSTEM_LABELS[expected]} — a ${GAME_SYSTEM_LABELS[expected]} campaign will not see its content. ` +
    `Use “Set system” on the Rules page to correct it.`
  );
}

const FETCH_RUNNING_REASON =
  'A pack fetch is already running — one fetch runs at a time here; wait for it to finish.';

export function BestiaryFetchSection(): JSX.Element {
  const [states, setStates] = useState<Record<string, FetchState>>({});
  const [fullLists, setFullLists] = useState<Record<string, FullList>>({});
  const [showFailedFor, setShowFailedFor] = useState<Record<string, boolean>>({});
  /**
   * The LIVE library read (row 204's ONE book read), so every recipe row can
   * say whether it is already imported and show the lanes the book's own card
   * shows. `undefined` is "not answered yet" — never "not imported".
   */
  const summaries = useRulebookSummaries();

  const running = Object.values(states).some((state) => state.kind === 'fetching');
  /**
   * WHY every "Fetch & import" button states this while `running` (docs/18
   * §2.3, docs/05 §Why a control cannot act): `running` is the flag its gate
   * reads, so the reason cannot disagree with it. The sentence is TRUE for the
   * whole section — `running` is section-wide on purpose (the guard at
   * `runFetch`'s entry: one fetch at a time), and the in-card progress line
   * ("Downloading N/M…") belongs to the RUNNING card, so a sibling card's held
   * button is exactly the case with nothing on screen beside it.
   *
   * Way out: honest, not invented — a pack fetch takes no `AbortSignal` and the
   * progress dock does not carry it, so the way out is to wait.
   */
  const fetchBlockedReason = running ? FETCH_RUNNING_REASON : null;

  function setState(adapterId: string, next: FetchState): void {
    setStates((previous) => ({ ...previous, [adapterId]: next }));
  }

  async function runFetch(adapterId: string, recipeId: string): Promise<void> {
    if (running) return;
    setState(adapterId, { kind: 'fetching', detail: 'Starting…' });
    // ONE progress handler for BOTH phases (docs/17 row 315): the download
    // phase (`onFetchProgress`, a `PackFetchProgress`) and the import phase
    // (`onProgress`, a `PackImportProgress`) reported the identical thing, and
    // `progressDetail` already reads the union — so ONE arrow taking the common
    // shape is handed to both options, byte-identical to the two copies it
    // replaces (a narrower-parameter callback is exactly what each option
    // accepts, so neither callback's behaviour is weakened).
    function applyProgress(progress: PackFetchProgress | PackImportProgress): void {
      setState(adapterId, { kind: 'fetching', detail: progressDetail(progress) });
    }
    try {
      const result = await fetchAndImportPack(adapterId, recipeId, {
        onFetchProgress: applyProgress,
        onProgress: applyProgress,
      });
      setState(adapterId, { kind: 'done', result });
      // Loud on fallback (16 §1.1 amendment): when the ref chain fired, the
      // toast names BOTH attempts via `fetchNote` — no silent degradation.
      // The per-lane breakdown (docs/17 row 204) is the SAME wording the
      // manual-import toast prints, so a fetched rules pack says how many
      // SPELLS it brought instead of one mixed noun; the system line (docs/17
      // row 209) says which system the book went in as, through the SAME
      // spelling seam the manual report uses.
      toastSuccess(
        `Fetched & imported “${result.book.title}” (${formatPackLanes(packLaneCounts(result))}, ` +
          `${String(result.skipped)} skipped, ${String(result.failed.length)} failed) — ` +
          `${formatPackSystem(result.system)}, it is in Rules` +
          (result.fetchNote === undefined ? '' : ` — ${result.fetchNote}`),
      );
    } catch (error) {
      const message = errorMessage(error);
      setState(adapterId, { kind: 'failed', message });
      toastError('Bestiary pack fetch failed', error);
    }
  }

  async function toggleFullList(adapterId: string, on: boolean): Promise<void> {
    if (!on) {
      setFullLists((previous) => ({ ...previous, [adapterId]: { kind: 'unlisted' } }));
      return;
    }
    setFullLists((previous) => ({ ...previous, [adapterId]: { kind: 'loading' } }));
    try {
      const recipes = await listPackRecipes(adapterId, { full: true });
      setFullLists((previous) => ({ ...previous, [adapterId]: { kind: 'listed', recipes } }));
    } catch (error) {
      setFullLists((previous) => ({ ...previous, [adapterId]: { kind: 'unlisted' } }));
      setState(adapterId, { kind: 'failed', message: errorMessage(error) });
      toastError('Could not list the repo packs', error);
    }
  }

  return (
    <Card data-testid="bestiary-fetch-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PackageIcon aria-hidden className="size-4" />
          Bestiary &amp; rules packs
        </CardTitle>
        <CardDescription>
          Download machine-readable bestiaries, equipment and spells from the pinned upstream repos
          into this browser — fetched packs work exactly like locally imported ones. Each fetch
          tries the repo's newest state (HEAD) first and falls back to the verified snapshot when
          the newest format imports poorly or fails to list — loudly reported either way. The manual
          file import stays available in Rules.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {PACK_FETCH_SOURCES.map((source) => {
          const adapter = getPackAdapter(source.adapterId);
          const state = states[source.adapterId] ?? { kind: 'idle' };
          const fullList = fullLists[source.adapterId] ?? { kind: 'unlisted' };
          const recipes = fullList.kind === 'listed' ? fullList.recipes : source.curated;
          return (
            <div key={source.adapterId} className="flex flex-col gap-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{adapter.label}</span>
                {/* Two-ref badge (16 §1.1 amendment, decision 6): the fallback
                    story is visible before any fetch — newest first, then the
                    pinned verified ref the chain can degrade to. */}
                <Badge variant="outline" data-testid={`ref-${source.adapterId}`}>
                  {source.owner}/{source.repo}: newest ({PACK_FETCH_NEWEST_REF}) → verified{' '}
                  {source.ref}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">{adapter.license}</p>
              <ul className="flex flex-col gap-1">
                {recipes.map((recipe) => {
                  const importState = packSourceImportState(
                    source,
                    recipe,
                    adapter.system,
                    summaries,
                  );
                  // The label states the REAL action (docs/17 row 210): a recipe
                  // the library already proves imported offers "Re-import" — a
                  // legitimate, documented remedy (docs/12: a library imported
                  // before the structured spell payload looks exactly like a
                  // stale one) — so the control is never disabled; only a
                  // running fetch holds it, with its own stated reason.
                  const action = importState.kind === 'imported' ? 'Re-import' : 'Fetch & import';
                  return (
                    <li key={recipe.id} className="flex flex-col gap-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm">
                          {recipe.label}{' '}
                          <span className="text-xs text-muted-foreground">
                            {/* Item packs (12-BESTIARY-PACKS §13) count documents
                                in "items", journal packs (docs/12 §15) count
                                pages, condition/corpus packs count sections, spell
                                packs (docs/17 row 194) count spells; the listing
                                counts adapter-parseable files either way. */}
                            ({String(recipe.creatures)}{' '}
                            {recipe.unit === 'items'
                              ? recipe.creatures === 1
                                ? 'item'
                                : 'items'
                              : recipe.unit === 'pages'
                                ? recipe.creatures === 1
                                  ? 'page'
                                  : 'pages'
                                : recipe.unit === 'sections'
                                  ? recipe.creatures === 1
                                    ? 'section'
                                    : 'sections'
                                  : recipe.unit === 'spells'
                                    ? recipe.creatures === 1
                                      ? 'spell'
                                      : 'spells'
                                    : recipe.creatures === 1
                                      ? 'creature'
                                      : 'creatures'})
                          </span>
                        </span>
                        <BlockedControl
                          testId={`fetch-${recipe.id}`}
                          reason={fetchBlockedReason}
                        >
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={running}
                            data-testid={`fetch-${recipe.id}`}
                            aria-label={`${action} ${recipe.label}`}
                            onClick={() => void runFetch(source.adapterId, recipe.id)}
                          >
                            <CloudDownloadIcon aria-hidden className="size-3.5" />
                            {action}
                          </Button>
                        </BlockedControl>
                      </div>
                      {/* The row STATES its library-derived import state (docs/17
                          row 210) — the owner could not tell an imported pack
                          from an unfetched one, and the spell lane is the number
                          that would have told him. */}
                      <p
                        className="text-xs text-muted-foreground"
                        data-testid={`import-state-${recipe.id}`}
                      >
                        {importStateLine(importState)}
                      </p>
                      {importState.kind === 'imported' && importState.systemMismatch && (
                        <p
                          className="text-xs text-destructive"
                          data-testid={`import-system-mismatch-${recipe.id}`}
                        >
                          {systemMismatchLine(
                            importState.candidate.summary.book.system,
                            adapter.system,
                          )}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
              {fullList.kind === 'loading' && (
                <p className="text-xs text-muted-foreground" data-testid={`listing-${source.adapterId}`}>
                  Listing every pack in the repo…
                </p>
              )}
              <div className="flex items-center justify-between rounded-md border p-2">
                <div>
                  <label htmlFor={`full-list-${source.adapterId}`} className="text-sm">
                    Advanced: list everything in the repo
                  </label>
                  <p className="text-xs text-muted-foreground">
                    All {source.repo} packs (GitHub API, 60 requests/hour per IP). Sources that only
                    parse part of the repo list just their folders; fetching a pack this adapter
                    cannot parse fails loudly with zero entries.
                  </p>
                </div>
                <Switch
                  id={`full-list-${source.adapterId}`}
                  data-testid={`full-list-${source.adapterId}`}
                  checked={fullList.kind === 'listed' || fullList.kind === 'loading'}
                  /* Self-evident, so NO reason is attached (pinned): the switch
                     is checked exactly while loading and the paragraph line
                     "Listing every pack in the repo…" sits directly below it —
                     the state is on screen beside its own control. */
                  disabled={fullList.kind === 'loading'}
                  onCheckedChange={(checked) => void toggleFullList(source.adapterId, checked)}
                />
              </div>
              {state.kind === 'fetching' && (
                <p className="text-xs text-muted-foreground" data-testid={`progress-${source.adapterId}`}>
                  {state.detail}
                </p>
              )}
              {state.kind === 'failed' && (
                <p className="text-xs text-destructive" data-testid={`error-${source.adapterId}`}>
                  {state.message}
                </p>
              )}
              {state.kind === 'done' && (
                <PackImportReport
                  result={state.result}
                  showFailed={showFailedFor[source.adapterId] ?? false}
                  onToggleFailed={() => {
                    setShowFailedFor((previous) => ({
                      ...previous,
                      [source.adapterId]: !(previous[source.adapterId] ?? false),
                    }));
                  }}
                />
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
