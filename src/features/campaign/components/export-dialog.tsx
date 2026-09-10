import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { DownloadIcon, FileArchiveIcon, FileJsonIcon } from 'lucide-react';

import { ARTIFACT_KIND_SINGULAR, type Artifact, type Id } from '@/domain';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  buildCampaignExport,
  buildZip,
  exportSuggestedName,
} from '@/lib/exportImport';
import { EXPORT_JSON_TYPES, EXPORT_ZIP_TYPES, openSaveTarget } from '@/lib/filePicker';
import { toastError, toastSuccess } from '@/lib/toast';

/**
 * Export (06-MILESTONES M2): a campaign-wide dialog with artifact selection
 * (JSON file or zip bundle). The single-artifact quick export from the tree
 * context menu lives in the `export-single-artifact.ts` sibling.
 */

type ExportFormat = 'json' | 'zip';

export function ExportCampaignDialog({
  campaignId,
  campaignName,
  artifacts,
  open,
  onOpenChange,
}: {
  campaignId: Id;
  campaignName: string;
  artifacts: readonly Artifact[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const [format, setFormat] = useState<ExportFormat>('json');
  const [selected, setSelected] = useState<ReadonlySet<Id>>(new Set(artifacts.map((a) => a.id)));
  const [busy, setBusy] = useState(false);

  // Preselect every artifact each time the dialog opens. The artifacts prop
  // resolves asynchronously (live query), so the useState initializer above
  // sees an empty list on mount — without this reset the dialog would open
  // with nothing selected (found by tests/features/export-dialog.test.tsx).
  const [wasOpen, setWasOpen] = useState(false);
  useEffect(() => {
    if (open && !wasOpen) setSelected(new Set(artifacts.map((a) => a.id)));
    setWasOpen(open);
  }, [open, wasOpen, artifacts]);

  const allSelected = selected.size === artifacts.length;

  function toggle(id: Id, checked: boolean): void {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function runExport(): Promise<void> {
    setBusy(true);
    // Gesture-first (backup-section precedent): the native save picker needs
    // transient user activation, and building the export easily outlives it —
    // so the destination is acquired inside the click handler, BEFORE the
    // slow build, and the finished blob is written to it afterwards.
    let target;
    try {
      target = await openSaveTarget({
        suggestedName: exportSuggestedName(campaignName, format),
        types: format === 'zip' ? EXPORT_ZIP_TYPES : EXPORT_JSON_TYPES,
      });
    } catch (error) {
      setBusy(false);
      toastError('Export failed', error);
      return;
    }
    if (target.cancelled) {
      // The user backed out of the native dialog: the export dialog stays
      // open with the selection intact — nothing was built, no toast.
      setBusy(false);
      return;
    }
    try {
      const ids = artifacts
        .filter((artifact) => selected.has(artifact.id))
        .map((artifact) => artifact.id);
      const exported =
        selected.size === artifacts.length
          ? await buildCampaignExport(campaignId, undefined, { images: format === 'zip' })
          : await buildCampaignExport(campaignId, ids, { images: format === 'zip' });
      if (format === 'zip') {
        await target.write(
          new Blob([buildZip(exported) as BlobPart], { type: 'application/zip' }),
        );
      } else {
        await target.write(
          new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' }),
        );
      }
      toastSuccess(`Exported ${exported.artifacts.length} artifact(s)`);
      onOpenChange(false);
    } catch (error) {
      toastError('Export failed', error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogTitle>Export “{campaignName}”</DialogTitle>
        <DialogDescription>Choose the artifacts to include.</DialogDescription>

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Checkbox
              id="select-all"
              checked={allSelected}
              onCheckedChange={(checked) => {
                setSelected(checked ? new Set(artifacts.map((a) => a.id)) : new Set());
              }}
            />
            <Label htmlFor="select-all">All artifacts ({artifacts.length})</Label>
          </div>
          <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
            {artifacts.map((artifact) => (
              <label key={artifact.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={selected.has(artifact.id)}
                  onCheckedChange={(checked) => {
                    if (typeof checked === 'boolean') toggle(artifact.id, checked);
                  }}
                />
                <span className="truncate">{artifact.name}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {ARTIFACT_KIND_SINGULAR[artifact.kind]}
                </span>
              </label>
            ))}
            {artifacts.length === 0 && (
              <p className="text-sm text-muted-foreground">No artifacts to export.</p>
            )}
          </div>
        </div>

        <div className="flex gap-2">
          <Button
            variant={format === 'json' ? 'default' : 'outline'}
            size="sm"
            onClick={() => {
              setFormat('json');
            }}
          >
            <FileJsonIcon aria-hidden data-icon="inline-start" />
            JSON file
          </Button>
          <Button
            variant={format === 'zip' ? 'default' : 'outline'}
            size="sm"
            onClick={() => {
              setFormat('zip');
            }}
          >
            <FileArchiveIcon aria-hidden data-icon="inline-start" />
            Zip bundle
          </Button>
        </div>

        <DialogFooter>
          {format === 'json' && (
            <p className="mr-auto text-xs text-muted-foreground">
              Plain JSON export omits image binaries — use the zip bundle to include images.
            </p>
          )}
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button disabled={busy || selected.size === 0} onClick={() => void runExport()}>
            <DownloadIcon aria-hidden data-icon="inline-start" />
            Export {selected.size} artifact(s)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
