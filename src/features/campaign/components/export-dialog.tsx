import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { DownloadIcon, FileArchiveIcon, FileJsonIcon } from 'lucide-react';

import { ARTIFACT_KIND_SINGULAR, type Artifact, type Id } from '@/domain';
import { Button } from '@/components/ui/button';
import { BlockedControl } from '@/components/blocked-control';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { exportCampaignBundle } from '@/features/campaign/components/export-campaign-bundle';

/**
 * Export (06-MILESTONES M2): a campaign-wide dialog with artifact selection
 * (JSON file or zip bundle). The single-artifact quick export from the tree
 * context menu lives in the `export-single-artifact.ts` sibling; the
 * acquire-target/build/write sequence EVERY campaign export shares lives in
 * `export-campaign-bundle.ts` (docs/17 row 322), which the workspace's
 * selection action bar calls too.
 */

type ExportFormat = 'json' | 'zip';

/**
 * WHY the Export button cannot act while `busy` (docs/18 §2.3, docs/05 §Why a
 * control cannot act): the gate is untouched, and this sentence is computed
 * from that SAME flag. `busy` spans the destination picker AND the slow build
 * (a zip walk plus image binaries) — the label "Export N artifact(s)" does not
 * change while it runs, so this state is the one that needs a sentence. Way
 * out: honest, not invented — a build/write in flight takes no `AbortSignal`
 * (Cancel only closes the dialog), so the way out is to wait.
 *
 * The gate's OTHER rung, `selected.size === 0`, is self-evident and gets NO
 * reason (pinned in tests/features/blocked-reasons-entity-sweep.test.tsx): the
 * button's own label reads "Export 0 artifact(s)".
 */
const EXPORT_RUNNING_REASON = 'The export is still being built and written — wait for it to finish.';

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
    try {
      const ids = artifacts
        .filter((artifact) => selected.has(artifact.id))
        .map((artifact) => artifact.id);
      // Gesture-first + the slow build + the loud failure all live in the ONE
      // shared seam; this dialog only owns its `busy` gate and the selection.
      const outcome = await exportCampaignBundle({
        campaignId,
        campaignName,
        // Every artifact selected is the WHOLE-campaign path (an undefined id
        // list, which is what carries the campaign's tables) — unchanged.
        artifactIds: selected.size === artifacts.length ? undefined : ids,
        format,
        images: format === 'zip',
      });
      if (outcome === 'saved') onOpenChange(false);
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
          <BlockedControl testId="export-run" reason={busy ? EXPORT_RUNNING_REASON : null}>
            <Button
              data-testid="export-run"
              disabled={busy || selected.size === 0}
              onClick={() => void runExport()}
            >
              <DownloadIcon aria-hidden data-icon="inline-start" />
              Export {selected.size} artifact(s)
            </Button>
          </BlockedControl>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
