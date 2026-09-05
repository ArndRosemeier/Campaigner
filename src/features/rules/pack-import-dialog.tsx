import { useState } from 'react';
import type { JSX } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { importPack } from '@/ingest/packImport';
import { PACK_ADAPTERS } from '@/ingest/packs/registry';
import { fileToPackInput } from '@/ingest/packs/types';
import type { PackImportProgress, PackImportResult } from '@/ingest/packImport';
import { toastError, toastSuccess } from '@/lib/toast';

/**
 * "Import bestiary pack" flow (12-BESTIARY-PACKS §6): adapter select over the
 * registered adapters, a multi-file input (.json/.db/.yml/.zip), and the
 * import report (imported / skipped / failed counts with an expandable
 * failed-entries list). Page-chunk progress renders on the book's processing
 * chip via `onProgress`, exactly like PDF page progress.
 *
 * Failure policy is loud: importPack already marks the book `error` when zero
 * entries validate and throws — every throw toasts and stays in the dialog so
 * the selection can be corrected. No silent partial results.
 */

export interface PackImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProgress: (progress: PackImportProgress | null) => void;
}

export function PackImportDialog({ open, onOpenChange, onProgress }: PackImportDialogProps): JSX.Element {
  const firstAdapter = PACK_ADAPTERS[0];
  const [adapterId, setAdapterId] = useState<string>(firstAdapter?.id ?? '');
  const [files, setFiles] = useState<File[]>([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PackImportResult | null>(null);
  const [showFailed, setShowFailed] = useState(false);
  const adapterItems = Object.fromEntries(PACK_ADAPTERS.map((adapter) => [adapter.id, adapter.label]));

  function reset(): void {
    setFiles([]);
    setResult(null);
    setShowFailed(false);
  }

  async function runImport(): Promise<void> {
    if (running || files.length === 0 || adapterId === '') return;
    setRunning(true);
    setResult(null);
    setShowFailed(false);
    try {
      const inputs = await Promise.all(files.map((file) => fileToPackInput(file)));
      const imported = await importPack(adapterId, inputs, { onProgress });
      setResult(imported);
      onProgress(null);
      toastSuccess(
        `Imported “${imported.book.title}” (${String(imported.imported)} creatures, ` +
          `${String(imported.skipped)} skipped, ${String(imported.failed.length)} failed)`,
      );
    } catch (error) {
      onProgress(null);
      // importPack already marked the book `error` for zero-entry imports —
      // surface the reason loudly; the dialog stays open for a retry.
      toastError('Could not import the bestiary pack', error);
    } finally {
      setRunning(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (running) return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent data-testid="pack-import-dialog">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void runImport();
          }}
        >
          <DialogHeader>
            <DialogTitle>Import bestiary pack</DialogTitle>
            <DialogDescription>
              Machine-readable monster data (Foundry pack exports) becomes exact stat blocks. Files
              are read locally — nothing is downloaded or re-served.
            </DialogDescription>
          </DialogHeader>
          <div className="my-3 flex flex-col gap-3">
            {PACK_ADAPTERS.length === 0 ? (
              <p className="text-sm text-destructive">No pack adapters are registered.</p>
            ) : (
              <Select
                value={adapterId}
                items={adapterItems}
                onValueChange={(value) => {
                  if (value !== null) setAdapterId(value);
                }}
              >
                <SelectTrigger className="w-full" aria-label="Pack source" disabled={running}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PACK_ADAPTERS.map((adapter) => (
                    <SelectItem key={adapter.id} value={adapter.id}>
                      {adapter.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Input
              type="file"
              accept=".json,.db,.yml,.zip"
              multiple
              disabled={running}
              aria-label="Pack files"
              data-testid="pack-import-input"
              onChange={(event) => {
                setFiles(Array.from(event.target.files ?? []));
                setResult(null);
                setShowFailed(false);
              }}
            />
            {result !== null && (
              <PackImportReport
                result={result}
                showFailed={showFailed}
                onToggleFailed={() => {
                  setShowFailed((previous) => !previous);
                }}
              />
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={running}
              onClick={() => {
                onOpenChange(false);
                reset();
              }}
            >
              Close
            </Button>
            <Button type="submit" disabled={running || files.length === 0 || adapterId === ''}>
              {running ? 'Importing…' : 'Import'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The pack import report (16-BESTIARY-FETCH reuses it in Settings). */
export function PackImportReport({
  result,
  showFailed,
  onToggleFailed,
}: {
  result: PackImportResult;
  showFailed: boolean;
  onToggleFailed: () => void;
}): JSX.Element {
  const { imported, skipped, failed } = result;
  return (
    <div className="rounded-md border p-2 text-xs" data-testid="pack-import-report">
      <p className="flex items-center gap-2">
        <Badge className="bg-emerald-600/15 text-emerald-500">{String(imported)} imported</Badge>
        <Badge variant="secondary">{String(skipped)} skipped</Badge>
        <Badge variant={failed.length === 0 ? 'outline' : 'destructive'}>
          {String(failed.length)} failed
        </Badge>
      </p>
      {failed.length > 0 && (
        <>
          {/* 16-BESTIARY-FETCH §6: the report leads with a representative
              failure (the first entry's issue) so the reason is visible
              without expanding the list. */}
          {failed.slice(0, 1).map((entry) => (
            <p
              key={`lead-${entry.file}-${entry.name}`}
              className="mt-1 text-destructive"
              data-testid="pack-import-first-failure"
            >
              <span className="font-medium">
                {entry.name === '' ? entry.file : `${entry.file} (${entry.name})`}
              </span>
              {': '}
              {entry.message}
            </p>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-1 px-2 py-1 text-xs"
            aria-expanded={showFailed}
            onClick={onToggleFailed}
          >
            {showFailed ? 'Hide failed entries' : `Show failed entries (${String(failed.length)})`}
          </Button>
          {showFailed && (
            <ul className="mt-1 flex max-h-40 flex-col gap-1 overflow-y-auto">
              {failed.map((entry, index) => (
                <li key={`${entry.file}-${String(index)}`} className="text-destructive">
                  <span className="font-medium">{entry.name === '' ? entry.file : `${entry.name} (${entry.file})`}</span>
                  {': '}
                  {entry.message}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
