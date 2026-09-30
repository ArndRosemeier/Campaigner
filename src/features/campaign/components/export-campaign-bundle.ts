import type { Id } from '@/domain';
import { buildCampaignExport, buildZip, exportSuggestedName } from '@/lib/exportImport';
import { EXPORT_JSON_TYPES, EXPORT_ZIP_TYPES, openSaveTarget } from '@/lib/filePicker';
import { toastError, toastSuccess } from '@/lib/toast';

/**
 * THE one campaign/selection export build+save seam (docs/17 row 322, AGENTS
 * rule 4). Both surfaces that export campaign artifacts call it: the picker's
 * `ExportCampaignDialog` (whole campaign, or a subset of it, with the source
 * campaign's tables as always) and the workspace's multi-select action bar
 * (`selectionOnly`, which omits those tables). Before this, the whole
 * acquire-target → build → write → toast sequence lived inside the dialog and
 * a second surface would have had to re-spell it.
 *
 * Gesture-first (the backup-section precedent, `lib/filePicker`): the native
 * save picker needs transient user activation and building the export easily
 * outlives it, so the destination is acquired BEFORE the slow build and the
 * finished blob is written to it afterwards. A cancelled picker is a silent
 * no-op (no build, no toast); a picker failure and a build/write failure both
 * surface through `toastError` (AGENTS rule 2).
 */

export type CampaignBundleFormat = 'json' | 'zip';

export interface CampaignBundleRequest {
  campaignId: Id;
  /** The campaign name the suggested save filename is derived from. */
  campaignName: string;
  /**
   * The artifact ids to export. `undefined` means EVERY campaign-level artifact
   * of the campaign (the whole-campaign path); an explicit list — even one that
   * happens to cover them all — is a selection.
   */
  artifactIds?: readonly Id[] | undefined;
  format: CampaignBundleFormat;
  /** Inline (JSON) or attach (zip) the referenced image binaries. */
  images: boolean;
  /**
   * Selection export: omit the source campaign's `modules`/`battles`/`runs`
   * from the file (`buildCampaignExport`'s `selectionOnly`). The picker's
   * whole-campaign path leaves this unset, byte-for-byte as it was.
   */
  selectionOnly?: boolean | undefined;
}

/** What the caller must do about the dialog/selection it owns. */
export type CampaignBundleOutcome = 'saved' | 'cancelled' | 'failed';

export async function exportCampaignBundle(
  request: CampaignBundleRequest,
): Promise<CampaignBundleOutcome> {
  let target;
  try {
    target = await openSaveTarget({
      suggestedName: exportSuggestedName(request.campaignName, request.format),
      types: request.format === 'zip' ? EXPORT_ZIP_TYPES : EXPORT_JSON_TYPES,
    });
  } catch (error) {
    toastError('Export failed', error);
    return 'failed';
  }
  if (target.cancelled) return 'cancelled';
  try {
    const exported = await buildCampaignExport(request.campaignId, request.artifactIds, {
      images: request.images,
      selectionOnly: request.selectionOnly === true,
    });
    if (request.format === 'zip') {
      // `buildZip` is async and chunked (docs/17 row 276): the await keeps the
      // caller's busy gate honest across the whole build, and a failure lands
      // in the catch below, never in a partial download. The `BlobPart` cast
      // is the backup surface's own precedent (TS strict rejects
      // `Uint8Array<ArrayBufferLike>` as a BlobPart directly).
      const zipBytes = await buildZip(exported);
      await target.write(new Blob([zipBytes as BlobPart], { type: 'application/zip' }));
    } else {
      await target.write(
        new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' }),
      );
    }
    toastSuccess(`Exported ${exported.artifacts.length} artifact(s)`);
    return 'saved';
  } catch (error) {
    toastError('Export failed', error);
    return 'failed';
  }
}
