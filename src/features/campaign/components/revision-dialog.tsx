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
import type { ArtifactRevision } from '@/domain';
import { formatDateTime } from '@/lib/format';
import Markdown from 'react-markdown';

const SOURCE_LABELS: Readonly<Record<ArtifactRevision['source'], string>> = {
  user: 'manual save',
  persona: 'persona run',
};

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
              <p className="mt-1 text-xs text-muted-foreground">{revision.snapshot.summary}</p>
            )}
            <Separator className="my-2" />
            <div className="text-sm leading-relaxed [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:ml-4 [&_li]:list-disc [&_p]:my-1.5">
              <Markdown>
                {revision.snapshot.body === '' ? '*No body content.*' : revision.snapshot.body}
              </Markdown>
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
