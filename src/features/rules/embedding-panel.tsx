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
        <Button
          variant="outline"
          size="xs"
          disabled={busy || (stats?.embeddedChunks ?? 0) === 0}
          onClick={() => {
            setConfirmClear(true);
          }}
        >
          <Trash2Icon aria-hidden data-icon="inline-start" />
          Clear
        </Button>
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
