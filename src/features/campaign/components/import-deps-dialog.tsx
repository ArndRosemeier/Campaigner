import type { JSX } from 'react';
import { Link } from 'react-router-dom';

import { ROUTES } from '@/app/routes';
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
import { groupCitationsByArtifact, type DependencyAnalysis } from '@/domain';

/**
 * The file waiting on the dependency decision, in the two shapes a read can
 * produce (docs/17 row 322): the raw JSON payload, or the zip bytes. Stashed so
 * "Import anyway" can run the SAME bytes without re-reading the file.
 */
export type PendingImportPayload =
  | { kind: 'json'; raw: unknown }
  | { kind: 'zip'; bytes: Uint8Array };

export interface PendingImport {
  analysis: DependencyAnalysis;
  payload: PendingImportPayload;
}

/**
 * Missing-dependency summary (07-MILESTONE-3 M3-E slice B): the abort-by-
 * default gate. Copies the backup-section AlertDialog abort/commit shape;
 * the per-book rows copy the PackImportReport badge/list grammar —
 * `{title, system, expectedChunks, matchLevel}` badges plus the citing
 * artifacts (`encounter → creature`) and the unmet NPC refs.
 *
 * Abort is the default (Cancel + Esc + backdrop — never enters the import
 * transaction, so there is nothing to roll back). "Import anyway" lands the
 * encounters with `missing ref` markers plus the campaign banner.
 *
 * It is ONE component with TWO hosts since docs/17 row 322: the picker (a new
 * campaign) and the workspace's selection import (into the campaign you are
 * in). The decision, its wording and its testids are the same on both — the
 * dependency check itself lives in `features/campaign/import-flow`.
 */
export function ImportDepsDialog({
  pending,
  working,
  onAbort,
  onImportAnyway,
}: {
  pending: PendingImport | null;
  working: boolean;
  onAbort: () => void;
  onImportAnyway: () => void;
}): JSX.Element {
  const citing = pending === null ? [] : groupCitationsByArtifact(pending.analysis);
  return (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) onAbort();
      }}
    >
      <AlertDialogContent data-testid="import-deps-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Import needs missing rulebook content</AlertDialogTitle>
          <AlertDialogDescription>
            This export cites stat blocks and references that are not in this library — nothing
            has been imported yet. Install the listed book(s) in{' '}
            <Link to={ROUTES.rules} className="underline" data-testid="import-deps-rules-link">
              Rules
            </Link>{' '}
            (“Import bestiary pack”, or re-import the rulebook PDF), then import again — or
            import anyway and the encounters below will show 'missing ref' until then.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {pending !== null && (
          <div className="flex max-h-64 flex-col gap-2 overflow-y-auto text-xs">
            {pending.analysis.books.map((entry) => (
              <div
                key={`${entry.book.system}-${entry.book.title}`}
                className="rounded-md border p-2"
                data-testid="import-deps-book"
              >
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {entry.book.title} ({entry.book.system})
                  </span>
                  <Badge
                    variant={entry.matchLevel === 'L0' ? 'secondary' : entry.matchLevel === 'missing' ? 'destructive' : 'outline'}
                    data-testid="import-deps-match-level"
                  >
                    {entry.matchLevel === 'L0'
                      ? 'present'
                      : entry.matchLevel === 'L1'
                        ? 'version drift'
                        : entry.matchLevel === 'L2'
                          ? 'similar content'
                          : 'missing'}
                  </Badge>
                  <Badge variant="secondary" data-testid="import-deps-expected">
                    {String(entry.book.citedChunkIds.length)} cited
                  </Badge>
                </p>
                {entry.hint !== undefined && (
                  <p className="mt-1 text-muted-foreground">{entry.hint}</p>
                )}
              </div>
            ))}
            {citing.length > 0 && (
              <div className="rounded-md border p-2" data-testid="import-deps-citing">
                <p className="font-medium">Citing encounters</p>
                <ul className="mt-1 flex flex-col gap-1">
                  {citing.map((group) => (
                    <li key={group.artifactName}>
                      <span className="font-medium">{group.artifactName}</span>
                      {' → '}
                      {group.monsters.map((monster) => (
                        <span key={monster.monsterName} className="mr-2">
                          {monster.monsterName}{' '}
                          <Badge
                            variant={monster.verdict === 'missing' ? 'destructive' : 'outline'}
                          >
                            {monster.verdict === 'missing' ? 'missing' : 'version drift'}
                          </Badge>
                        </span>
                      ))}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {pending.analysis.unmetLibraryRefs.length > 0 && (
              <div className="rounded-md border p-2" data-testid="import-deps-unmet">
                <p className="font-medium">NPC references outside the export</p>
                <ul className="mt-1 flex flex-col gap-1">
                  {pending.analysis.unmetLibraryRefs.map((ref) => (
                    <li key={`${ref.artifactId}-${ref.npcArtifactId}`}>
                      <span className="font-medium">{ref.artifactName}</span>
                      {' → '}
                      {ref.npcName ?? ref.npcArtifactId}{' '}
                      <Badge variant="destructive">{ref.status}</Badge>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="import-deps-abort" disabled={working}>
            Abort
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="import-deps-import-anyway"
            disabled={working}
            onClick={() => {
              onImportAnyway();
            }}
          >
            {working ? 'Importing…' : 'Import anyway'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
