import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { DownloadIcon, FolderOpenIcon, RefreshCwIcon, SaveIcon } from 'lucide-react';

import {
  buildBackup,
  backupFileName,
  backupRunWasInterrupted,
  importBackup,
  markBackupInFlight,
  noteBackupSettled,
  type BackupProgress,
} from '@/lib/backup';
import { pdfBackupStats } from '@/db/pdfRepo';
import { BACKUP_TYPES, openSaveTarget, pickBackupFile, supportsFilePickers } from '@/lib/filePicker';
import {
  readStorageUsage,
  storagePersistedStatus,
  type StorageUsage,
} from '@/lib/deviceCapabilities';
import { isQuotaExceededError } from '@/lib/errors';
import { useProgressStore } from '@/lib/progress';
import { formatRetiredTableRows } from '@/lib/exportImport';
import { toastError, toastErrorPersistent, toastInfo, toastSuccess } from '@/lib/toast';
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

/** The three states of the usage line: still reading, value, or the platform cannot say. */
type UsageState =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'known'; usage: StorageUsage };

/** Bytes for a human: B, then KB/MB/GB/TB with one decimal while the number is small. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${String(rounded)} ${units[unit] ?? 'TB'}`;
}

/**
 * Storage-persistence and usage (05-UI.md §Tablet, docs/17 row 265): whether
 * the browser committed to keeping the IndexedDB (requested on app start), and
 * how much of its storage allowance it says this origin is using — refreshed on
 * demand, because the figure moves as the library grows.
 *
 * The three failure arms are deliberately DIFFERENT (AGENTS rule 1, never a
 * silent fallback): an absent `navigator.storage.estimate()` is the plain
 * "not available" an informational line deserves (jsdom, older Safari — a
 * capability, not an error); a THROW from a present probe is loud (`toastError`
 * plus the unavailable line); and a reported value says out loud that browsers
 * round and pad these numbers.
 */
function StorageStatus(): JSX.Element {
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [usage, setUsage] = useState<UsageState>({ status: 'loading' });

  const refreshUsage = useCallback(async (): Promise<void> => {
    setUsage({ status: 'loading' });
    try {
      const value = await readStorageUsage();
      setUsage(value === null ? { status: 'unavailable' } : { status: 'known', usage: value });
    } catch (error) {
      setUsage({ status: 'unavailable' });
      toastError('Could not read how much storage is in use', error);
    }
  }, []);

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

  useEffect(() => {
    void refreshUsage();
  }, [refreshUsage]);

  const usageSentence =
    usage.status === 'known'
      ? `Storage in use: ${formatBytes(usage.usage.usageBytes)} of ${formatBytes(
          usage.usage.quotaBytes,
        )} available (${String(
          Math.round((usage.usage.usageBytes / usage.usage.quotaBytes) * 100),
        )}%). Browsers report these figures roughly.`
      : usage.status === 'loading'
        ? 'Checking how much storage is in use…'
        : 'Storage in use: this browser does not report how much space is left.';

  return (
    <div className="flex flex-col gap-1 px-6" data-testid="storage-status">
      {persisted !== null && (
        <p className="text-xs text-muted-foreground" data-testid="storage-persistence">
          {persisted
            ? 'Storage is persistent — the browser will not evict your data.'
            : 'Storage is best-effort — install Campaigner to your home screen so the browser cannot clean it up.'}
        </p>
      )}
      <div className="flex items-center gap-2">
        <p className="text-xs text-muted-foreground" data-testid="storage-usage">
          {usageSentence}
        </p>
        <Button
          variant="ghost"
          size="sm"
          data-testid="storage-refresh"
          onClick={() => {
            void refreshUsage();
          }}
        >
          <RefreshCwIcon aria-hidden data-icon="inline-start" />
          Refresh
        </Button>
      </div>
    </div>
  );
}

/** ~size for the PDF-exclusion note: KB under 1 MB, else rounded MB. */
function pdfBytesLabel(totalBytes: number): string {
  if (totalBytes < 1024 * 1024) return `${String(Math.ceil(totalBytes / 1024))} KB`;
  return `~${String(Math.round(totalBytes / (1024 * 1024)))} MB`;
}

/**
 * Backup & restore (M4-C): saves the ENTIRE app state (every IndexedDB
 * table — campaigns, artifacts, rulebooks, personas, runs, modules, images —
 * as one zip) and restores it. The OpenRouter API key never leaves the
 * browser: it is excluded from saves and the locally stored key survives
 * restores. Retained rulebook PDFs are NEVER included (owner-ratified) —
 * when books carry retained PDFs, a loud note above the save button says so
 * and points at re-import. Native file dialogs where the browser offers
 * them, plain download / file-input fallback otherwise.
 *
 * The SAVE is asynchronous and reports progress (docs/17 row 265): the build
 * yields to the event loop between bounded batches, so a large library no
 * longer blocks the tab in one synchronous `zipSync`. This surface owns the
 * "back up before your session" nudge and the interrupted-run note, both
 * deliberately here rather than in AppShell (the shell is owned elsewhere and
 * the prompt belongs beside the button it asks the user to press).
 */
export function BackupSection(): JSX.Element {
  const [saving, setSaving] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [restoring, setRestoring] = useState(false);
  // Read once on mount: a marker still present means a previous build was
  // killed before it settled (the dead tab could not say so itself).
  const [interrupted, setInterrupted] = useState(() => backupRunWasInterrupted());
  const progressStart = useProgressStore((state) => state.start);
  const progressUpdate = useProgressStore((state) => state.update);
  const progressFinish = useProgressStore((state) => state.finish);
  const hasNativePickers = supportsFilePickers();
  const pdfStats = useLiveQuery(pdfBackupStats, []);

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
    // The marker brackets the part that can actually be interrupted by a dead
    // tab; the picker above is a platform dialog the browser restores itself.
    markBackupInFlight();
    try {
      const { bytes } = await buildBackup({
        onProgress: (progress: BackupProgress) => {
          progressUpdate('app-backup', { detail: progress.detail, progress: progress.progress });
        },
      });
      await target.write(new Blob([bytes as BlobPart], { type: 'application/zip' }));
      toastSuccess('Backup saved');
      setInterrupted(false);
    } catch (error) {
      if (isQuotaExceededError(error)) {
        // The platform's own message ("QuotaExceededError…") is not a sentence
        // anyone can act on, so the raw error goes to the console and the
        // persistent toast carries the MITIGATION instead.
        console.error(error);
        toastErrorPersistent(
          'Not enough space to save the backup',
          new Error(
            'Nothing was saved. Free space on this device — delete unused images in the app, or clear space in the browser — then try again.',
          ),
        );
      } else {
        toastError('Could not save the backup', error);
      }
    } finally {
      noteBackupSettled();
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
      // Retired tables (docs/17 row 108): a pre-v21 backup still carries the
      // `deliverables` table this build deleted. Its rows had nowhere to land,
      // so the skip is stated with its count — never silent (AGENTS rule 1).
      const retiredNote = formatRetiredTableRows(result.retiredRows);
      if (retiredNote !== null) toastInfo(retiredNote);
      // Load-bearing reload (kept on purpose, F10): the restore REPLACED the
      // whole database, so every module-scope cache and store must re-derive
      // from the new rows — the keyword index (backup's chunk restore goes
      // through the chunkRepo write door and invalidates it itself), the
      // persisted UI selections (lastModule may point at a module the
      // restore removed), and every non-live-query store. This is not a
      // chunk-index-only workaround; removing it needs an app-wide
      // re-hydration design, not a one-line change.
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
          Retained rulebook PDFs are never included.
          {hasNativePickers
            ? ' Your browser lets you pick the save location.'
            : ' Your browser downloads the file instead.'}
        </CardDescription>
      </CardHeader>
      <div className="border-t px-6 pt-3" data-testid="backup-session-prompt">
        <p className="text-xs font-medium">
          Before your next session, save a backup. If this browser ever clears its storage, that
          zip is the only way back — and it is the one copy you can keep somewhere else.
        </p>
        {interrupted && (
          <p className="mt-1 text-xs font-medium text-destructive" data-testid="backup-interrupted">
            The last backup did not finish — the tab was closed or reloaded before the file was
            written, so nothing was saved. Run “Save everything” again.
          </p>
        )}
      </div>
      {pdfStats !== undefined && pdfStats.count > 0 && (
        <p
          className="border-t px-6 pt-3 text-xs font-medium text-destructive"
          data-testid="pdf-backup-note"
        >
          This backup does not include{' '}
          {pdfStats.count === 1
            ? '1 attached rulebook PDF'
            : `${String(pdfStats.count)} attached rulebook PDFs`}{' '}
          ({pdfBytesLabel(pdfStats.totalBytes)}). After restoring, re-import those PDFs if you want
          to view them again — your rules, chunks and search are fully backed up.
        </p>
      )}
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
