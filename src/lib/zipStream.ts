import { strToU8, Zip, ZipDeflate } from 'fflate';

/**
 * THE one way to build a zip without blocking the tab (docs/17 rows 265 and
 * 276).
 *
 * fflate's `zipSync` needs the whole payload in memory and deflates it in ONE
 * synchronous call, so a library-sized payload blocks the main thread until it
 * finishes — on a tablet that is how the tab is killed, and it is why the
 * pre-session backup (row 265) and the campaign export (row 276) both had to
 * stop calling it. This seam wraps fflate's STREAMING `Zip`: entries are added
 * one at a time and their bytes are pushed in `BYTES_PER_PUSH` slices with a
 * MACROTASK yield between them, so rendering, input and the browser's own
 * watchdogs keep getting a turn.
 *
 * The FILE is unchanged — the same entry names, the same `ZIP_LEVEL` the
 * whole-zip `zipSync` applied, and nothing but `unzipSync` reads the bytes back
 * — only HOW it is produced changed. Both zip producers in the app ride this
 * seam: the whole-database backup (`lib/backup.buildBackup`) and the campaign
 * export (`lib/exportImport.buildZip`). A third producer extends THIS file; it
 * never re-implements the push loop (AGENTS rule 4).
 */

/** Bytes handed to the deflate stream between yields (1 MiB). */
export const BYTES_PER_PUSH = 1024 * 1024;

/**
 * The compression level EVERY entry is written with — the level the whole-zip
 * `zipSync` used. Images were MEASURED as pass-through first and taken back out
 * (the backup fixture: 30 patterned 128 KiB images went 375,098 B → 4,131,073
 * B), so a lower level here is a silent size regression, not a saving.
 */
const ZIP_LEVEL = 6;

/** The push half of fflate's streaming zip entries (structural, not imported). */
export interface StreamingEntry {
  push: (chunk: Uint8Array, final?: boolean) => void;
}

/**
 * Hands the main thread back to the browser. A MACROTASK (`setTimeout`), not a
 * resolved promise: a microtask lets the async function continue without ever
 * giving rendering, input or the browser's own watchdogs a turn, which is
 * exactly the difference between a chunked build and a blocked tab — the defect
 * docs/17 row 265 exists for.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** A zip being built in bounded, yielding slices. */
export class StreamingZip {
  private readonly chunks: Uint8Array[] = [];
  private streamError: Error | null = null;
  private readonly zip: Zip;

  constructor() {
    this.zip = new Zip((error, chunk) => {
      if (error) {
        this.streamError = error;
        return;
      }
      if (chunk.length > 0) this.chunks.push(chunk);
    });
  }

  /** Opens an entry; the caller pushes its bytes and finalizes it. */
  add(name: string): StreamingEntry {
    const entry = new ZipDeflate(name, { level: ZIP_LEVEL });
    this.zip.add(entry);
    return entry;
  }

  /** Rethrows a failure the stream callback recorded (never swallowed). */
  failIfStreamBroken(): void {
    if (this.streamError !== null) throw this.streamError;
  }

  /** Pushes bytes in bounded slices, yielding to a macrotask between them. */
  async pushBytes(entry: StreamingEntry, bytes: Uint8Array, finalize: boolean): Promise<void> {
    if (bytes.length === 0) {
      if (finalize) {
        entry.push(new Uint8Array(0), true);
        this.failIfStreamBroken();
      }
      return;
    }
    for (let offset = 0; offset < bytes.length; offset += BYTES_PER_PUSH) {
      const end = Math.min(offset + BYTES_PER_PUSH, bytes.length);
      entry.push(bytes.subarray(offset, end), finalize && end >= bytes.length);
      this.failIfStreamBroken();
      await yieldToEventLoop();
    }
  }

  /** `pushBytes` for UTF-8 text. */
  pushText(entry: StreamingEntry, text: string, finalize: boolean): Promise<void> {
    return this.pushBytes(entry, strToU8(text), finalize);
  }

  /** Closes the archive and rethrows a failure the stream callback recorded. */
  end(): void {
    this.zip.end();
    this.failIfStreamBroken();
  }

  /**
   * Abandons the archive mid-entry. The caller rethrows its own error — a
   * failure is never converted into a partial archive (AGENTS rule 1).
   */
  terminate(): void {
    this.zip.terminate();
  }

  /** The finished zip bytes; only meaningful after `end()`. */
  bytes(): Uint8Array {
    const totalBytes = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }
}
