import { useState } from 'react';
import type { JSX } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Trash2Icon } from 'lucide-react';

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
import { Button } from '@/components/ui/button';
import type { Module } from '@/domain';
import { listArtifactsByModule } from '@/db/artifactRepo';
import { modulesReferencingOwnedArtifacts, type ReferencedOwnedArtifact } from '@/db/artifactAutoPromote';
import { deleteModule } from '@/db/moduleRepo';
import { countCreaturesCitedByModule, type ModuleCreatureCitations } from '@/db/creatureCitations';
import { toastError, toastSuccess } from '@/lib/toast';

/**
 * THE delete affordance for a campaign's document (docs/17 row 389).
 *
 * It was the module LIST row's control; the list is deleted (a campaign owns
 * ONE document), so the control moved to the ONE surface that document has —
 * the reader's header. The dialog body is unchanged, and it is still the ONLY
 * mount: `deleteModule` (the repo's three-branch disposal, docs/17 row 103) is
 * reached from here and from nowhere else, so a legacy campaign's extra rows
 * are deleted through their OWN reader via the `LegacyModulesNotice` links.
 *
 * Reference kinds the delete scan reports, in the dialog's own words. A
 * total map (not a ternary chain): every new `ReferenceVia` member must state
 * its user-facing wording instead of silently rendering as "a battle".
 */
const REFERENCE_VIA_LABELS: Readonly<Record<ReferencedOwnedArtifact['via'], string>> = {
  link: 'a wiki-link',
  relation: 'an artifact relation',
  roster: 'an encounter roster',
  battle: 'a battle',
};

/** The reader-header delete control: a ghost icon button plus the dialog. */
export function ModuleDeleteButton({ module }: { module: Module }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Delete ${module.title}`}
        className="shrink-0 hover:text-destructive"
        data-testid="delete-module"
        onClick={() => {
          setOpen(true);
        }}
      >
        <Trash2Icon aria-hidden />
      </Button>
      {/* Mounted ONLY while open: the reader renders this control on every
          document, and an always-mounted dialog would run its three live
          scans (owned artifacts, cited creatures, outside references) on
          every reader render — a query nobody asked for. */}
      {open && <ModuleDeleteDialog module={module} open onOpenChange={setOpen} />}
    </>
  );
}

/**
 * The three-state delete confirm. It is MOUNTED only while open
 * (`ModuleDeleteButton`), so mounting it is what starts the live scans (owned
 * artifact count, cited bestiary creatures, externally referenced owned
 * artifacts) — the blast radius is stated before the click, and the confirm
 * re-counts once more inside the repo's transaction.
 */
export function ModuleDeleteDialog({
  module: target,
  open,
  onOpenChange,
}: {
  module: Module;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}): JSX.Element {
  /**
   * Artifacts owned by the delete target (10-MILESTONE-6 D5), LIVE: the
   * count re-derives while the dialog is open, so the user reads what the
   * module owns NOW, not what it owned when the dialog opened. undefined =
   * still counting; the confirm handler recounts once more before choosing
   * the branch.
   */
  const ownedCount = useLiveQuery(
    async () => (await listArtifactsByModule(target.id)).length,
    [target],
  );
  /**
   * LIBRARY creatures the target's encounters CITE (docs/11 D5 amendment): a
   * citation of a read-only bestiary row, so there is nothing for the cascade
   * to delete or release. A REFERENCE, never ownership. Counted so the dialog
   * states the blast radius — and its real limit — before the click.
   */
  const citedMobs = useLiveQuery(async () => {
    const rows = await listArtifactsByModule(target.id);
    if (rows.length === 0) return null;
    return countCreaturesCitedByModule(rows);
  }, [target]);
  /**
   * Owned artifacts referenced from OUTSIDE the delete target (auto-promote
   * reference scan: wikilinks, rosters, battle tokens), LIVE like the count.
   * Non-empty switches the dialog to its third state: promote-and-keep the
   * referenced rows vs force-delete everything. null = still scanning.
   */
  const referenced = useLiveQuery(async () => {
    if ((await listArtifactsByModule(target.id)).length === 0) return [];
    return modulesReferencingOwnedArtifacts(target.id);
  }, [target]);
  // useLiveQuery is undefined until the first run — normalize to null so
  // the dialog branches below stay total.
  const owned: number | null = ownedCount ?? null;
  const refs: ReferencedOwnedArtifact[] | null = referenced ?? null;
  const cited: ModuleCreatureCitations | null = citedMobs ?? null;

  /** Runs one delete branch (10-MILESTONE-6 D5): the user picked what happens
   * to the owned artifacts; the module row always goes. */
  function runDelete(ownedArtifacts: 'cascade' | 'keep' | 'promote-referenced'): void {
    onOpenChange(false);
    deleteModule(target.id, ownedArtifacts)
      .then(() => {
        toastSuccess(
          ownedArtifacts === 'promote-referenced'
            ? 'Module deleted — referenced artifacts are now shared across the campaign'
            : 'Module deleted',
        );
      })
      .catch((error: unknown) => {
        toastError('Could not delete the module', error);
      });
  }

  /** The plain "Delete" button's branch: derived from a FRESH count at
   * confirm time, never from the count that was live when the dialog opened
   * (an artifact that lands in between must be cascaded, not released —
   * deleteModule re-lists the rows inside its transaction either way). */
  async function confirmDelete(): Promise<void> {
    let freshCount: number;
    try {
      freshCount = (await listArtifactsByModule(target.id)).length;
    } catch (error) {
      toastError('Could not recount the artifacts owned by the module', error);
      return;
    }
    runDelete(freshCount > 0 ? 'cascade' : 'keep');
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{target.title}”?</AlertDialogTitle>
          <AlertDialogDescription>
            The module document and its parts are deleted.
            {owned === null || (owned > 0 && refs === null)
              ? ' Counting the artifacts this module owns…'
              : owned === 0
                ? ' This module owns no artifacts.'
                : refs !== null && refs.length > 0
                  ? ` ${String(refs.length)} owned artifact${refs.length === 1 ? ' is' : 's are'} still used outside this module — deleting would strand those references. Choose what happens:`
                  : ` This module owns ${String(owned)} artifact${owned === 1 ? '' : 's'}. Choose what happens to them:`}
          </AlertDialogDescription>
          {cited !== null && cited.creatures.length > 0 && (
            <p className="text-sm text-muted-foreground" data-testid="delete-module-cited-mobs">
              Its encounters also cite {String(cited.creatures.length)} creature
              {cited.creatures.length === 1 ? '' : 's'} from the bestiary ({cited.creatures
                .slice(0, 3)
                .map((creature) =>
                  creature.resolved ? `“${creature.name}”` : `“${creature.name}” (not installed)`,
                )
                .join(', ')}
              {cited.creatures.length > 3
                ? ` and ${String(cited.creatures.length - 3)} more`
                : ''}
              ). Those are library references, not part of this module — deleting it never
              removes them.
            </p>
          )}
        </AlertDialogHeader>
        {refs !== null && refs.length > 0 && (
          <ul className="max-h-40 overflow-y-auto rounded-md border px-3 py-2 text-sm" data-testid="delete-module-referenced-list">
            {refs.map((entry) => (
              <li key={entry.artifact.id} className="truncate">
                “{entry.artifact.name}” ({entry.artifact.kind}) — used by{' '}
                {REFERENCE_VIA_LABELS[entry.via]}
              </li>
            ))}
          </ul>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {refs !== null && refs.length > 0 ? (
            <>
              <AlertDialogAction
                data-testid="delete-module-promote-keep"
                onClick={() => {
                  // deleteModule re-scans the references fresh inside the
                  // branch — rows referenced after the dialog opened are
                  // promoted too, never stranded.
                  runDelete('promote-referenced');
                }}
              >
                Promote & keep {String(refs.length)} referenced, delete the rest
              </AlertDialogAction>
              <AlertDialogAction
                className="text-destructive"
                data-testid="delete-module-confirm"
                onClick={() => {
                  runDelete('cascade');
                }}
              >
                Force-delete all
              </AlertDialogAction>
            </>
          ) : (
            <>
              {owned !== null && owned > 0 && (
                <AlertDialogAction
                  data-testid="delete-module-keep"
                  onClick={() => {
                    runDelete('keep');
                  }}
                >
                  Keep {String(owned)} artifact{owned === 1 ? '' : 's'}
                </AlertDialogAction>
              )}
              <AlertDialogAction
                className={
                  owned !== null && owned > 0
                    ? 'text-destructive'
                    : undefined
                }
                data-testid="delete-module-confirm"
                onClick={() => {
                  void confirmDelete();
                }}
              >
                {owned !== null && owned > 0
                  ? `Delete module and ${String(owned)} artifact${owned === 1 ? '' : 's'}`
                  : 'Delete'}
              </AlertDialogAction>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
