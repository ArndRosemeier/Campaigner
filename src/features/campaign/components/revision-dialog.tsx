import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import type { AnyArtifact, ArtifactRevision } from '@/domain';
import { WikiMarkdown } from '@/features/campaign/components/wiki-markdown';
import { formatDateTime } from '@/lib/format';

const SOURCE_LABELS: Readonly<Record<ArtifactRevision['source'], string>> = {
  user: 'manual save',
  persona: 'persona run',
};

/**
 * A revision snapshot has no campaign context of its own (history is stored on
 * the artifact row, not against a live pool), so its model prose renders
 * through the ONE wiki-aware renderer with an EMPTY pool: a `[[Name]]` the
 * model echoed from the module prose still renders as the dashed unresolved
 * chip with its byte-exact tooltip, never as raw `[[…]]` bytes (docs/17 row
 * 217). This dialog used to import `react-markdown` DIRECTLY — the only place
 * the app's one renderer chain was bypassed by an import.
 */
const NO_ARTIFACTS: readonly AnyArtifact[] = [];

export interface RevisionDialogProps {
  revision: ArtifactRevision | null;
  onOpenChange: (open: boolean) => void;
  onRestore: (revision: number) => void;
}

/**
 * Read-only snapshot view (05-UI §Revisions): picking a revision from the
 * header dropdown opens this dialog; "Restore" saves the snapshot as a new
 * revision.
 */
export function RevisionDialog({ revision, onOpenChange, onRestore }: RevisionDialogProps) {
  return (
    <Dialog open={revision !== null} onOpenChange={onOpenChange}>
      {revision !== null && (
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Revision {revision.revision}</DialogTitle>
            <DialogDescription>
              Saved {formatDateTime(revision.updatedAt)} · {SOURCE_LABELS[revision.source]}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh] rounded-lg border p-3">
            <h3 className="text-base font-semibold">{revision.snapshot.name}</h3>
            {revision.snapshot.summary !== '' && (
              <WikiMarkdown
                value={revision.snapshot.summary}
                artifacts={NO_ARTIFACTS}
                className="mt-1 text-xs text-muted-foreground"
              />
            )}
            <Separator className="my-2" />
            <div className="text-sm leading-relaxed [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:ml-4 [&_li]:list-disc [&_p]:my-1.5">
              <WikiMarkdown
                value={
                  revision.snapshot.body === '' ? '*No body content.*' : revision.snapshot.body
                }
                artifacts={NO_ARTIFACTS}
              />
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Close
            </Button>
            <Button
              onClick={() => {
                onRestore(revision.revision);
                onOpenChange(false);
              }}
            >
              Restore this revision
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
