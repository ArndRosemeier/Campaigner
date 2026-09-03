import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { DownloadIcon, FolderOpenIcon, SaveIcon } from 'lucide-react';

import { buildBackup, backupFileName, importBackup } from '@/lib/backup';
import { BACKUP_TYPES, openSaveTarget, pickBackupFile, supportsFilePickers } from '@/lib/filePicker';
import { storagePersistedStatus } from '@/lib/deviceCapabilities';
import { useProgressStore } from '@/lib/progress';
import { toastError, toastSuccess } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
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

/**
 * Storage-persistence status line (05-UI.md §Tablet): shows whether the
 * browser committed to keeping the IndexedDB (requested on app start).
 * Null status = API unavailable → the line simply does not render.
 */
function StorageStatus(): JSX.Element | null {
  const [persisted, setPersisted] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    void storagePersistedStatus()
      .then((status) => {
        if (active) setPersisted(status);
      })
      // A failed status probe only hides this informational line — there is
      // no data or user action behind it, so no toast is warranted.
      .catch(() => {
        if (active) setPersisted(null);
      });
    return () => {
      active = false;
    };
  }, []);
  if (persisted === null) return null;
  return (
    <p className="text-xs text-muted-foreground" data-testid="storage-persistence">
      {persisted
        ? 'Storage is persistent — the browser will not evict your data.'
        : 'Storage is best-effort — install Campaigner to your home screen so the browser cannot clean it up.'}
    </p>
  );
}

/**
 * Backup & restore (M4-C): saves the ENTIRE app state (every IndexedDB
 * table — campaigns, artifacts, rulebooks, personas, runs, modules, images —
 * as one zip) and restores it. The OpenRouter API key never leaves the
 * browser: it is excluded from saves and the locally stored key survives
 * restores. Native file dialogs where the browser offers them, plain
 * download / file-input fallback otherwise.
 */
export function BackupSection(): JSX.Element {
  const [saving, setSaving] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [restoring, setRestoring] = useState(false);
  const progressStart = useProgressStore((state) => state.start);
  const progressFinish = useProgressStore((state) => state.finish);
  const hasNativePickers = supportsFilePickers();

  async function handleSave(): Promise<void> {
    setSaving(true);
    // Gesture-first: the native save picker needs transient user activation,
    // and building a full backup (every table + image binaries) easily
    // outlives it — so the destination is acquired inside the click handler
    // and the finished zip is written to it afterwards. A save flow that
    // built first failed with "Must be handling a user gesture to show a
    // file picker".
    let target;
    try {
      target = await openSaveTarget({ suggestedName: backupFileName(Date.now()), types: BACKUP_TYPES });
    } catch (error) {
      setSaving(false);
      toastError('Could not save the backup', error);
      return;
    }
    if (target.cancelled) {
      // The user backed out of the native dialog — nothing to build, no toast.
      setSaving(false);
      return;
    }
    progressStart('app-backup', 'Building backup…');
    try {
      const { bytes } = await buildBackup();
      await target.write(new Blob([bytes as BlobPart], { type: 'application/zip' }));
      toastSuccess('Backup saved');
    } catch (error) {
      toastError('Could not save the backup', error);
    } finally {
      progressFinish('app-backup');
      setSaving(false);
    }
  }

  async function handleLoad(): Promise<void> {
    try {
      const file = await pickBackupFile();
      if (file === null) return; // user cancelled the picker
      setPendingFile(file);
    } catch (error) {
      toastError('Could not read the selected file', error);
    }
  }

  async function confirmRestore(): Promise<void> {
    const file = pendingFile;
    if (file === null) return;
    setPendingFile(null);
    setRestoring(true);
    progressStart('app-restore', 'Restoring backup…');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await importBackup(bytes);
      toastSuccess(`Backup restored — ${String(result.totalRows)} rows`);
      window.location.reload();
    } catch (error) {
      toastError('Could not restore the backup', error);
    } finally {
      progressFinish('app-restore');
      setRestoring(false);
    }
  }

  return (
    <Card data-testid="backup-section">
      <CardHeader>
        <CardTitle>Backup &amp; restore</CardTitle>
        <CardDescription>
          Saves everything — all campaigns, artifacts, rulebooks, personas, runs and images — as
          one zip file, and restores it. Your OpenRouter API key is never saved into the file, and
          the key stored in this browser is kept on restore. Restoring replaces all current data.
          {hasNativePickers
            ? ' Your browser lets you pick the save location.'
            : ' Your browser downloads the file instead.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={saving || restoring}
          data-testid="backup-save"
          onClick={() => {
            void handleSave();
          }}
        >
          <SaveIcon aria-hidden data-icon="inline-start" />
          {saving ? 'Saving…' : 'Save everything'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={saving || restoring}
          data-testid="backup-load"
          onClick={() => {
            void handleLoad();
          }}
        >
          <FolderOpenIcon aria-hidden data-icon="inline-start" />
          {restoring ? 'Restoring…' : 'Load everything'}
        </Button>
      </CardContent>
      <StorageStatus />
      <AlertDialog
        open={pendingFile !== null}
        onOpenChange={(next) => {
          if (!next) setPendingFile(null);
        }}
      >
        <AlertDialogContent data-testid="backup-restore-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Restore “{pendingFile?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This REPLACES everything currently in the app — all campaigns, artifacts,
              rulebooks, personas, runs and images. Your OpenRouter API key is kept. This cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="backup-confirm-restore"
              onClick={() => {
                void confirmRestore();
              }}
            >
              <DownloadIcon aria-hidden data-icon="inline-start" />
              Replace everything
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
