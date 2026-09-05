import { useState } from 'react';
import type { JSX } from 'react';
import { CloudDownloadIcon, PackageIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import {
  fetchAndImportPack,
  listPackRecipes,
  PACK_FETCH_SOURCES,
  type PackFetchProgress,
  type PackRecipe,
} from '@/ingest/packFetch';
import type { PackImportProgress, PackImportResult } from '@/ingest/packImport';
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
  | { kind: 'done'; result: PackImportResult }
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

export function BestiaryFetchSection(): JSX.Element {
  const [states, setStates] = useState<Record<string, FetchState>>({});
  const [fullLists, setFullLists] = useState<Record<string, FullList>>({});
  const [showFailedFor, setShowFailedFor] = useState<Record<string, boolean>>({});

  const running = Object.values(states).some((state) => state.kind === 'fetching');

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
      toastSuccess(
        `Fetched & imported “${result.book.title}” (${String(result.imported)} creatures, ` +
          `${String(result.skipped)} skipped, ${String(result.failed.length)} failed) — it is in Rules`,
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
          fetched packs work exactly like locally imported ones. The manual file import stays
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
                <Badge variant="outline" data-testid={`ref-${source.adapterId}`}>
                  {source.owner}/{source.repo} @ {source.ref}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">{adapter.license}</p>
              <ul className="flex flex-col gap-1">
                {recipes.map((recipe) => (
                  <li key={recipe.id} className="flex items-center justify-between gap-2">
                    <span className="text-sm">
                      {recipe.label}{' '}
                      <span className="text-xs text-muted-foreground">
                        ({String(recipe.creatures)} {recipe.creatures === 1 ? 'creature' : 'creatures'})
                      </span>
                    </span>
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
                    All {source.repo} packs (GitHub API, 60 requests/hour per IP). Fetching a
                    non-bestiary pack fails loudly with zero entries.
                  </p>
                </div>
                <Switch
                  id={`full-list-${source.adapterId}`}
                  data-testid={`full-list-${source.adapterId}`}
                  checked={fullList.kind === 'listed' || fullList.kind === 'loading'}
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
