import { useState } from 'react';
import type { JSX } from 'react';
import { CloudDownloadIcon, PackageIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { BlockedControl } from '@/components/blocked-control';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
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
import { PackImportReport } from '@/features/rules/pack-import-dialog';

/**
 * "Bestiary packs" settings card (16-BESTIARY-FETCH §5): per adapter the
 * curated pack recipes with per-pack "Fetch & import" buttons, plus the
 * advanced "list everything in the repo" toggle (an on-demand GitHub trees
 * listing). Fetching downloads the pack from the pinned upstream repo into
 * this browser and runs the unchanged `importPack` — the report component is
 * the one from the /rules manual-import dialog, which stays as the fallback.
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

const FETCH_RUNNING_REASON =
  'A pack fetch is already running — one fetch runs at a time here; wait for it to finish.';

export function BestiaryFetchSection(): JSX.Element {
  const [states, setStates] = useState<Record<string, FetchState>>({});
  const [fullLists, setFullLists] = useState<Record<string, FullList>>({});
  const [showFailedFor, setShowFailedFor] = useState<Record<string, boolean>>({});

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
    try {
      const result = await fetchAndImportPack(adapterId, recipeId, {
        onFetchProgress: (progress) => {
          setState(adapterId, { kind: 'fetching', detail: progressDetail(progress) });
        },
        onProgress: (progress) => {
          setState(adapterId, { kind: 'fetching', detail: progressDetail(progress) });
        },
      });
      setState(adapterId, { kind: 'done', result });
      // Loud on fallback (16 §1.1 amendment): when the ref chain fired, the
      // toast names BOTH attempts via `fetchNote` — no silent degradation.
      // Item packs (12-BESTIARY-PACKS §13) are named "items", not "creatures";
      // rules-text packs (docs/12 §15) are "sections".
      const noun =
        result.sectionsImported === result.imported
          ? 'sections'
          : result.itemsImported === result.imported
            ? 'items'
            : 'creatures';
      toastSuccess(
        `Fetched & imported “${result.book.title}” (${String(result.imported)} ` +
          `${noun}, ` +
          `${String(result.skipped)} skipped, ${String(result.failed.length)} failed) — it is in Rules` +
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
          Bestiary packs
        </CardTitle>
        <CardDescription>
          Download machine-readable bestiaries from the pinned upstream repos into this browser —
          fetched packs work exactly like locally imported ones. Each fetch tries the repo's newest
          state (HEAD) first and falls back to the verified snapshot when the newest format imports
          poorly or fails to list — loudly reported either way. The manual file import stays
          available in Rules.
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
                {recipes.map((recipe) => (
                  <li key={recipe.id} className="flex items-center justify-between gap-2">
                    <span className="text-sm">
                      {recipe.label}{' '}
                      <span className="text-xs text-muted-foreground">
                        {/* Item packs (12-BESTIARY-PACKS §13) count documents
                            in "items", journal packs (docs/12 §15) count
                            pages, condition/corpus packs count sections; the
                            listing counts adapter-parseable files either
                            way. */}
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
                        aria-label={`Fetch & import ${recipe.label}`}
                        onClick={() => void runFetch(source.adapterId, recipe.id)}
                      >
                        <CloudDownloadIcon aria-hidden className="size-3.5" />
                        Fetch &amp; import
                      </Button>
                    </BlockedControl>
                  </li>
                ))}
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
