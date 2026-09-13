import type { Artifact } from '@/domain';
import { listRevisions } from '@/db/artifactRepo';
import { buildExport } from '@/lib/exportImport';
import { fileSlug } from '@/lib/fileSlug';
import { EXPORT_JSON_TYPES, openSaveTarget } from '@/lib/filePicker';
import { toastError, toastSuccess } from '@/lib/toast';

/**
 * Single-artifact quick export (06-MILESTONES M2): the tree context menu's
 * one-click JSON export. Lives beside the campaign export dialog
 * (`export-dialog.tsx`), which owns the multi-artifact UI.
 */

/** One-click JSON export of a single artifact (tree context menu). */
export async function exportSingleArtifact(artifact: Artifact): Promise<void> {
  // Gesture-first like the campaign dialog's `runExport`: the tree menu click
  // carries the user activation the native picker needs, so the target is
  // acquired first.
  let target;
  try {
    target = await openSaveTarget({
      suggestedName: `${fileSlug(artifact.name, 'artifact')}-${new Date(Date.now()).toISOString().slice(0, 10)}.json`,
      types: EXPORT_JSON_TYPES,
    });
  } catch (error) {
    toastError('Artifact export failed', error);
    return;
  }
  if (target.cancelled) return;
  try {
    const revisions = await listRevisions(artifact.id);
    const exported = buildExport(null, [{ ...artifact, revisions }]);
    await target.write(
      new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' }),
    );
    toastSuccess('Artifact exported');
  } catch (error) {
    toastError('Artifact export failed', error);
  }
}
