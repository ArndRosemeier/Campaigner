import { useState } from 'react';
import type { JSX } from 'react';
import { DownloadIcon, FolderOpenIcon, SaveIcon } from 'lucide-react';

import { buildBackup, backupFileName, importBackup } from '@/lib/backup';
import { pickBackupFile, saveBlobToDisk, supportsFilePickers } from '@/lib/filePicker';
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
    progressStart('app-backup', 'Building backup…');
    try {
      const { bytes, manifest } = await buildBackup();
      const outcome = await saveBlobToDisk(
        new Blob([bytes as BlobPart], { type: 'application/zip' }),
        backupFileName(manifest.exportedAt),
      );
      if (outcome === 'saved') {
        toastSuccess('Backup saved');
      }
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
