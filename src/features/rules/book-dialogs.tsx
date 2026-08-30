import { useEffect, useState } from 'react';

import { GAME_SYSTEMS, GAME_SYSTEM_LABELS, type GameSystem } from '@/domain/gameSystem';
import type { Rulebook } from '@/domain/rulebook';
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
import { deleteRulebook, updateRulebook } from '@/db/rulebookRepo';
import { toastError, toastSuccess } from '@/lib/toast';

export type BookMenuAction = 'rename' | 'system' | 'delete' | null;

export interface BookDialogsProps {
  book: Rulebook;
  action: BookMenuAction;
  onOpenChange: (open: boolean) => void;
}

/** Rename / Set system / Delete flows for a book card menu (05-UI §Rules). */
export function BookDialogs({ book, action, onOpenChange }: BookDialogsProps) {
  return (
    <>
      <RenameDialog book={book} open={action === 'rename'} onOpenChange={onOpenChange} />
      <SystemDialog book={book} open={action === 'system'} onOpenChange={onOpenChange} />
      <DeleteDialog book={book} open={action === 'delete'} onOpenChange={onOpenChange} />
    </>
  );
}

function RenameDialog({
  book,
  open,
  onOpenChange,
}: {
  book: Rulebook;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [value, setValue] = useState(book.title);
  useEffect(() => {
    if (open) setValue(book.title);
  }, [open, book.title]);

  async function handleRename(): Promise<void> {
    const title = value.trim();
    onOpenChange(false);
    if (title === '' || title === book.title) return;
    try {
      await updateRulebook(book.id, { title });
      toastSuccess('Renamed');
    } catch (error) {
      toastError('Rename failed', error);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleRename();
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename rulebook</DialogTitle>
            <DialogDescription>Titles must not be empty.</DialogDescription>
          </DialogHeader>
          <Input
            value={value}
            autoFocus
            aria-label="Rulebook title"
            className="my-2"
            onChange={(event) => {
              setValue(event.target.value);
            }}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={value.trim() === ''}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SystemDialog({
  book,
  open,
  onOpenChange,
}: {
  book: Rulebook;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [system, setSystem] = useState<GameSystem>(book.system);
  useEffect(() => {
    if (open) setSystem(book.system);
  }, [open, book.system]);

  async function handleSet(): Promise<void> {
    onOpenChange(false);
    if (system === book.system) return;
    try {
      await updateRulebook(book.id, { system });
      toastSuccess(`System set to ${GAME_SYSTEM_LABELS[system]}`);
    } catch (error) {
      toastError('Could not set system', error);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleSet();
          }}
        >
          <DialogHeader>
            <DialogTitle>Game system</DialogTitle>
            <DialogDescription>Used by personas when interpreting this book.</DialogDescription>
          </DialogHeader>
          <div className="my-3">
            <Select
              value={system}
              onValueChange={(value) => {
                if (value !== null) setSystem(value);
              }}
            >
              <SelectTrigger className="w-full" aria-label="Game system">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GAME_SYSTEMS.map((gameSystem) => (
                  <SelectItem key={gameSystem} value={gameSystem}>
                    {GAME_SYSTEM_LABELS[gameSystem]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  book,
  open,
  onOpenChange,
}: {
  book: Rulebook;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  async function handleDelete(): Promise<void> {
    onOpenChange(false);
    try {
      await deleteRulebook(book.id);
      toastSuccess('Rulebook deleted');
    } catch (error) {
      toastError('Delete failed', error);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{book.title}”?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently removes the book and all of its chunks. Cached embeddings are kept
            (they are shared by content).
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => void handleDelete()}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
