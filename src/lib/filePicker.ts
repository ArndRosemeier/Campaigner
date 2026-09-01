import { downloadBlob } from '@/lib/exportImport';

/**
 * File System Access API wrappers (M4-C backup/restore): browsers that
 * support `showSaveFilePicker`/`showOpenFilePicker` get a native save/open
 * dialog at a user-chosen location; everyone else falls back to a plain
 * download (save) or a hidden file input (open). User cancellation is
 * reported, never swallowed and never escalated to a fallback.
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

const BACKUP_TYPES: PickerType[] = [
  { description: 'Campaigner backup', accept: { 'application/zip': ['.zip'] } },
];

/**
 * Saves a blob: native picker when available, otherwise a download. Returns
 * 'cancelled' when the user backed out of the native dialog.
 */
export async function saveBlobToDisk(blob: Blob, suggestedName: string): Promise<'saved' | 'cancelled'> {
  const save = pickers().save;
  if (save === undefined) {
    downloadBlob(blob, suggestedName);
    return 'saved';
  }
  try {
    const handle = await save({ suggestedName, types: BACKUP_TYPES });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return 'saved';
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
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
