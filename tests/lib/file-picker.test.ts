import { afterEach, describe, expect, it, vi } from 'vitest';

import * as exportImport from '@/lib/exportImport';
import { BACKUP_TYPES, openSaveTarget, supportsFilePickers } from '@/lib/filePicker';

/**
 * The two-phase save destination (filePicker): the native save dialog must be
 * opened BEFORE any slow build (transient user activation expires in a few
 * seconds — a save flow that built first failed with "Must be handling a user
 * gesture to show a file picker"), and `write` then delivers the finished
 * blob to the handle acquired up front. Cancellation is reported, never
 * swallowed.
 */

interface HandleLike {
  getFile: () => Promise<File>;
  createWritable: () => Promise<{ write: (data: BlobPart) => Promise<void>; close: () => Promise<void> }>;
}

function recordingHandle(): { handle: HandleLike; written: BlobPart[]; closed: () => boolean } {
  const written: BlobPart[] = [];
  let closed = false;
  return {
    handle: {
      getFile: () => Promise.resolve(new File([''], 'unused')),
      createWritable: () =>
        Promise.resolve({
          write: (data) => {
            written.push(data);
            return Promise.resolve();
          },
          close: () => {
            closed = true;
            return Promise.resolve();
          },
        }),
    },
    written,
    closed: () => closed,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('openSaveTarget', () => {
  it('acquires the handle up front and write() delivers the blob to it', async () => {
    const { handle, written, closed } = recordingHandle();
    const savePicker = vi.fn(() => Promise.resolve(handle));
    const openPicker = vi.fn(() => Promise.resolve([handle]));
    vi.stubGlobal('showSaveFilePicker', savePicker);
    vi.stubGlobal('showOpenFilePicker', openPicker);
    expect(supportsFilePickers()).toBe(true);

    const target = await openSaveTarget({ suggestedName: 'backup.zip', types: BACKUP_TYPES });

    // The picker already ran — before any data exists to write.
    expect(savePicker).toHaveBeenCalledWith({ suggestedName: 'backup.zip', types: BACKUP_TYPES });
    expect(target.cancelled).toBe(false);

    const blob = new Blob(['zip-bytes'], { type: 'application/zip' });
    await target.write(blob);

    expect(written).toHaveLength(1);
    expect(closed()).toBe(true);
  });

  it('reports cancellation when the user backs out of the native dialog', async () => {
    vi.stubGlobal(
      'showSaveFilePicker',
      vi.fn(() => Promise.reject(new DOMException('user aborted', 'AbortError'))),
    );

    const target = await openSaveTarget({ suggestedName: 'backup.zip', types: BACKUP_TYPES });

    expect(target.cancelled).toBe(true);
    // Writing to a cancelled target is a deliberate no-op.
    await expect(target.write(new Blob(['x']))).resolves.toBeUndefined();
  });

  it('propagates non-cancellation picker failures loudly', async () => {
    vi.stubGlobal(
      'showSaveFilePicker',
      vi.fn(() => Promise.reject(new TypeError('SecurityError-ish'))),
    );

    await expect(
      openSaveTarget({ suggestedName: 'backup.zip', types: BACKUP_TYPES }),
    ).rejects.toThrow(TypeError);
  });

  it('falls back to a plain download when the browser has no native picker', async () => {
    // jsdom has no FS Access API — nothing was stubbed.
    expect(supportsFilePickers()).toBe(false);
    const downloadSpy = vi.spyOn(exportImport, 'downloadBlob').mockImplementation(() => undefined);

    const target = await openSaveTarget({ suggestedName: 'backup.zip' });
    expect(target.cancelled).toBe(false);

    const blob = new Blob(['zip-bytes'], { type: 'application/zip' });
    await target.write(blob);

    expect(downloadSpy).toHaveBeenCalledTimes(1);
    expect(downloadSpy.mock.calls[0]?.[1]).toBe('backup.zip');
  });
});
