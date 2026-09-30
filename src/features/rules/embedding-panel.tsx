import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { LoaderCircleIcon, Trash2Icon, ZapIcon } from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { BlockedControl } from '@/components/blocked-control';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { HelpButton } from '@/help/HelpButton';
import { readSettings } from '@/db/settingsRepo';
import { toastError, toastSuccess } from '@/lib/toast';
import {
  clearEmbeddings,
  embedWholeLibrary,
  embeddingStats,
  type EmbeddingStats,
} from '@/search/embeddings';

/**
 * WHY the two controls cannot act while `busy` (docs/18 §2.3, docs/05 §Why a
 * control cannot act): the gates are untouched, and this sentence is computed
 * from that SAME flag — the whole-library run, which streams embeddings for
 * every chunk and can take minutes, while neither button changes its label.
 * Way out: honest, not invented — the runner takes no `AbortSignal` and the
 * progress dock does not carry an embedding run, so the way out is to wait.
 */
const LIBRARY_EMBEDDING_REASON =
  'The whole library is being embedded right now — wait for it to finish.';

/**
 * The reason the well-known rungs of both gates state, in gate order — and the
 * two rungs that deliberately state NOTHING, so the judgement is a decision and
 * not an omission:
 * - `embed-library` is `disabled={!active || busy || total === 0}`. `!active` is
 *   stated in place (the "inactive" badge plus the notice paragraph below the
 *   buttons: "Enable embeddings and add an API key in Settings…"); `total === 0`
 *   is self-evident (the stats line reads "0 of 0 chunks embedded" — an empty
 *   set to embed);
 * - `Clear` is `disabled={busy || embeddedChunks === 0}`. The busy rung states
 *   the reason below even though the run is not Clear's own work (reported as an
 *   over-block finding in docs/17 row 99, NOT changed here); the empty rung is
 *   self-evident (nothing to clear — the stats line shows it).
 */
function libraryEmbedBlockedReason(active: boolean, busy: boolean): string | null {
  if (!active) return null;
  if (busy) return LIBRARY_EMBEDDING_REASON;
  return null;
}

/**
 * Whole-library embedding management (06-MILESTONES M2): shows how many
 * chunks are embedded for the current model, embeds the whole library with a
 * progress bar, and clears the cache.
 */
export function EmbeddingLibraryPanel(): JSX.Element {
  const [stats, setStats] = useState<EmbeddingStats | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const settings = useLiveQuery(() => readSettings(), []);

  async function refreshStats(): Promise<void> {
    try {
      setStats(await embeddingStats());
    } catch (error) {
      toastError('Could not load embedding stats', error);
    }
  }

  useEffect(() => {
    void refreshStats();
  }, [settings?.embeddingModel, settings?.embeddingsEnabled]);

  async function handleEmbedAll(): Promise<void> {
    setBusy(true);
    setProgress({ done: 0, total: stats?.totalChunks ?? 0 });
    try {
      await embedWholeLibrary((done, total) => {
        setProgress({ done, total });
      });
      toastSuccess('Library embedded');
    } catch (error) {
      toastError('Embedding failed', error);
    } finally {
      setBusy(false);
      setProgress(null);
      void refreshStats();
    }
  }

  async function handleClear(): Promise<void> {
    setConfirmClear(false);
    try {
      await clearEmbeddings();
      toastSuccess('Embeddings cleared');
    } catch (error) {
      toastError('Could not clear embeddings', error);
    } finally {
      void refreshStats();
    }
  }

  const active = settings?.embeddingsEnabled === true && settings.openRouterApiKey !== '';
  const total = progress?.total ?? stats?.totalChunks ?? 0;
  /** Why each button is held right now (docs/18 §2.3 — see the helper above). */
  const embedLibraryReason = libraryEmbedBlockedReason(active, busy);
  const clearReason = busy ? LIBRARY_EMBEDDING_REASON : null;

  return (
    <div className="flex flex-col gap-2 border-b p-3" data-testid="embedding-panel">
      <div className="flex items-center gap-2">
        <h2 className="flex items-center gap-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Embeddings
          <HelpButton topic="embeddings" label="embeddings" className="size-5" />
        </h2>
        <Badge variant={active ? 'secondary' : 'outline'}>
          {active ? (stats?.model ?? 'model') : 'inactive'}
        </Badge>
      </div>

      {stats !== null && (
        <p className="text-xs text-muted-foreground">
          {stats.embeddedChunks} of {stats.totalChunks} chunks embedded
        </p>
      )}

      {progress !== null && total > 0 && (
        <Progress
          value={(progress.done / Math.max(1, total)) * 100}
          aria-label="Embedding progress"
        />
      )}

      <div className="flex gap-2">
        <BlockedControl testId="embed-library" reason={embedLibraryReason}>
          <Button
            size="xs"
            disabled={!active || busy || total === 0}
            onClick={() => void handleEmbedAll()}
            data-testid="embed-library"
          >
            {busy ? (
              <LoaderCircleIcon aria-hidden data-icon="inline-start" className="animate-spin" />
            ) : (
              <ZapIcon aria-hidden data-icon="inline-start" />
            )}
            Embed whole library
          </Button>
        </BlockedControl>
        <BlockedControl testId="clear-embeddings" reason={clearReason}>
          <Button
            variant="outline"
            size="xs"
            data-testid="clear-embeddings"
            disabled={busy || (stats?.embeddedChunks ?? 0) === 0}
            onClick={() => {
              setConfirmClear(true);
            }}
          >
            <Trash2Icon aria-hidden data-icon="inline-start" />
            Clear
          </Button>
        </BlockedControl>
      </div>

      {!active && (
        <p className="text-xs text-muted-foreground">
          Enable embeddings and add an API key in Settings to use semantic search.
        </p>
      )}

      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear all embeddings?</AlertDialogTitle>
            <AlertDialogDescription>
              Cached embedding vectors for every chunk are deleted. Keyword search keeps working;
              re-embedding costs API calls.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void handleClear();
              }}
            >
              Clear
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
