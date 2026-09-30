import { useState } from 'react';
import type { JSX } from 'react';
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
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { deleteAllData } from '@/db/maintenance';
import { toastSuccess } from '@/lib/toast';

const CONFIRM_WORD = 'DELETE';

/**
 * Danger zone (05-UI.md §Settings): "Delete all data" confirmed by typing
 * DELETE; reloads the page afterwards so stores re-seed.
 */
export function DangerZone(): JSX.Element {
  const [confirmText, setConfirmText] = useState('');
  const [open, setOpen] = useState(false);
  const armed = confirmText === CONFIRM_WORD;

  async function handleDelete(): Promise<void> {
    setOpen(false);
    await deleteAllData();
    toastSuccess('All data deleted');
    window.location.reload();
  }

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-destructive">Danger zone</CardTitle>
        <CardDescription>
          Deletes every campaign, artifact, rulebook, chunk, embedding, persona edit, run and
          setting in this browser. The theme preference is kept.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AlertDialog
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) setConfirmText('');
          }}
        >
          <AlertDialogTrigger
            className="inline-flex items-center justify-center gap-2 rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-white hover:bg-destructive/90"
            data-testid="delete-all-data"
          >
            <Trash2Icon aria-hidden data-icon="inline-start" />
            Delete all data
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete all data?</AlertDialogTitle>
              <AlertDialogDescription>
                This permanently removes everything Campaigner stored in this browser. Type{' '}
                {CONFIRM_WORD} to confirm.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="delete-confirm">Type {CONFIRM_WORD}</Label>
              <Input
                id="delete-confirm"
                value={confirmText}
                autoComplete="off"
                onChange={(event) => {
                  setConfirmText(event.target.value);
                }}
              />
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                disabled={!armed}
                onClick={() => void handleDelete()}
              >
                Delete everything
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
