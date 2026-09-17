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
import { formatPackLanes, formatPackSystem, packLaneCounts } from '@/features/rules/pack-lanes';
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
      // The per-lane breakdown (docs/17 row 204): the noun that used to stand
      // here named ONE lane and could not say whether the import brought
      // spells — the owner's own debugging round. The four lanes partition the
      // chunks, so the toast states the total implicitly and the spell count
      // explicitly.
      toastSuccess(
        `Imported “${imported.book.title}” (${formatPackLanes(packLaneCounts(imported))}, ` +
          `${String(imported.skipped)} skipped, ${String(imported.failed.length)} failed) — ` +
          formatPackSystem(imported.system),
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
  /** `fetchNote` (16 §1.1 amendment) is set only by fetched packs whose
   *  ref chain fired — the manual import path never has it. */
  result: PackImportResult & { fetchNote?: string };
  showFailed: boolean;
  onToggleFailed: () => void;
}): JSX.Element {
  const { imported, skipped, failed } = result;
  return (
    <div className="rounded-md border p-2 text-xs" data-testid="pack-import-report">
      {result.fetchNote !== undefined && (
        <p className="mb-1 font-medium text-amber-500" data-testid="pack-import-fetch-note">
          {result.fetchNote}
        </p>
      )}
      <p className="flex items-center gap-2">
        <Badge className="bg-emerald-600/15 text-emerald-500">{String(imported)} imported</Badge>
        {/* The per-lane breakdown (docs/17 row 204): SPELLS named explicitly,
            because `sectionsImported` mixes journal pages, conditions, feats,
            spells, actions and class features into one number. The four lanes
            partition the chunks (the total stays on the badge beside it). */}
        <span data-testid="pack-import-lanes">{formatPackLanes(packLaneCounts(result))}</span>
        {/* The system the book was stored AS (docs/17 row 209): the adapter's
            DECLARED system, which every accepted payload agrees with (the
            runner's agreement check refuses one that claims another). Said at
            the moment of import, through its ONE spelling seam — a mismatch is
            otherwise invisible until a campaign of the expected system cannot
            see the book. */}
        <span data-testid="pack-import-system">{formatPackSystem(result.system)}</span>
        <Badge variant="secondary">{String(skipped)} skipped</Badge>
        <Badge variant={failed.length === 0 ? 'outline' : 'destructive'}>
          {String(failed.length)} failed
        </Badge>
      </p>
      {/* THE re-import consequence, said once, where a user meets it (docs/17
          row 149, docs/12 §5). A citation is born against the EXACT text this
          import stored (`contentHash = sha256Hex(text)`), and `resolveMonsterEntry`
          matches by uuid and then by that exact hash — so re-importing a pack
          whose stored text changed (row 149 changed it for the two PF2e
          description lanes and the dnd5e lanes: resolved brace labels, readable
          tables) leaves the ALREADY-SAVED citations reading `missing ref`.
          There is no rebind tool and no contentHash re-stamp migration by the
          owner's decision, so the repair is the user's two steps, stated here
          rather than discovered later. Shown with every report because the
          report is the ONE place a pack import is confirmed, and the rule is
          true of the import just run. */}
      <p className="mt-1 text-muted-foreground" data-testid="pack-import-rereimport-note">
        A saved encounter cites an entry by the exact text this import stored, so re-importing a
        pack whose entry text changed leaves those citations reading
        {' '}&lsquo;missing ref (&lt;creature&gt;)&rsquo; — re-pick the creature there to repair them.
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
