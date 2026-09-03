import { downloadBlob } from '@/lib/exportImport';

/**
 * File System Access API wrappers (M4-C backup/restore): browsers that
 * support `showSaveFilePicker`/`showOpenFilePicker` get a native save/open
 * dialog at a user-chosen location; everyone else falls back to a plain
 * download (save) or a hidden file input (open). User cancellation is
 * reported, never swallowed and never escalated to a fallback.
 *
 * Saving is TWO-PHASE (`openSaveTarget` → `write`): `showSaveFilePicker`
 * requires transient user activation, which expires after a few seconds —
 * and building the data to save (a whole-database backup, a PDF) easily
 * outlives it. The destination must therefore be acquired inside the click
 * handler, BEFORE any slow build; the finished blob is written afterwards.
 * A save flow that awaits work first fails with "Must be handling a user
 * gesture to show a file picker" — that ordering is the bug this API shape
 * prevents.
 */

/** Minimal structural types — lib.dom may lack the FS Access declarations. */
interface WritableLike {
  write: (data: BlobPart) => Promise<void>;
  close: () => Promise<void>;
}
interface FileHandleLike {
  getFile: () => Promise<File>;
  createWritable: () => Promise<WritableLike>;
}
export interface PickerType {
  description?: string;
  accept: Record<string, string[]>;
}
type SavePicker = (options?: {
  suggestedName?: string;
  types?: PickerType[];
}) => Promise<FileHandleLike>;
type OpenPicker = (options?: {
  types?: PickerType[];
  multiple?: boolean;
}) => Promise<FileHandleLike[]>;

function pickers(): { save: SavePicker | undefined; open: OpenPicker | undefined } {
  const w = window as unknown as {
    showSaveFilePicker?: SavePicker;
    showOpenFilePicker?: OpenPicker;
  };
  return { save: w.showSaveFilePicker, open: w.showOpenFilePicker };
}

/** True when the browser offers the native file picker dialogs. */
export function supportsFilePickers(): boolean {
  return pickers().save !== undefined && pickers().open !== undefined;
}

export const BACKUP_TYPES: PickerType[] = [
  { description: 'Campaigner backup', accept: { 'application/zip': ['.zip'] } },
];

/** A save destination acquired up front, written to once the data exists. */
export interface SaveTarget {
  /** True when the user backed out of the native dialog — nothing to write. */
  cancelled: boolean;
  /** Writes the finished blob to the chosen location (or downloads it). */
  write: (blob: Blob) => Promise<void>;
}

/**
 * Opens the save destination (native picker, or the download fallback) while
 * the user's click activation is still fresh. Write to `target.write` after
 * the slow build; nothing is written when the user cancelled the dialog.
 */
export async function openSaveTarget(options: {
  suggestedName: string;
  types?: PickerType[];
}): Promise<SaveTarget> {
  const save = pickers().save;
  if (save === undefined) {
    // No native picker: "write" is the plain download, once the blob exists.
    return {
      cancelled: false,
      write: (blob) => {
        downloadBlob(blob, options.suggestedName);
        return Promise.resolve();
      },
    };
  }
  try {
    const handle = await save({
      suggestedName: options.suggestedName,
      ...(options.types !== undefined ? { types: options.types } : {}),
    });
    return {
      cancelled: false,
      write: async (blob) => {
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
      },
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { cancelled: true, write: () => Promise.resolve() };
    }
    throw error;
  }
}

/**
 * Opens a backup file: native picker when available, otherwise a hidden
 * file input. Resolves null when the user cancels.
 */
export async function pickBackupFile(): Promise<File | null> {
  const open = pickers().open;
  if (open !== undefined) {
    try {
      const [handle] = await open({ types: BACKUP_TYPES, multiple: false });
      return handle === undefined ? null : await handle.getFile();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return null;
      throw error;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,application/zip';
    input.style.display = 'none';
    input.addEventListener('change', () => {
      input.remove();
      resolve(input.files?.[0] ?? null);
    });
    input.addEventListener('cancel', () => {
      input.remove();
      resolve(null);
    });
    document.body.append(input);
    input.click();
  });
}
