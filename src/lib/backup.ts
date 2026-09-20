import { Zip, ZipDeflate, unzipSync, strToU8 } from 'fflate';
import { z } from 'zod';

import { db } from '@/db/db';
import { parseIdeaBoards } from '@/domain/ideaBoard';
import { writeChunks } from '@/db/chunkRepo';
import {
  anyArtifactSchema,
  battleSchema,
  personaSchema,
  settingsSchema,
  storedImageSchema,
  type RuleChunk,
  type StoredImage,
  type StoredPdf,
} from '@/domain';
import { imageFileExtension, retiredTableRows } from '@/lib/exportImport';

/**
 * Full-app backup (M4-C): zips the ENTIRE IndexedDB state — campaigns,
 * artifacts, revisions, rulebooks, chunks, embeddings, personas, runs,
 * modules, images — as one `campaigner-backup.zip`. The
 * OpenRouter API key never leaves the browser: it is stripped from the
 * export and the locally stored key is preserved on import. Image binaries
 * ride the zip as `images/<id>.<ext>` files referenced by the manifest rows
 * (same scheme as the campaign export). Retained rulebook PDF bytes are
 * EXCLUDED always (owner-ratified, source-viewers arc): the PDF is a
 * convenience copy of a file the user owns on disk — chunks, embeddings and
 * everything functional ride the zip; the export reports the exclusion so
 * the backup UI can show a loud re-import note. Import REPLACES the whole
 * database.
 *
 * The SAVE half is asynchronous and chunked (docs/17 row 265): a synchronous
 * `zipSync` over a whole library is the likeliest way the one pre-session
 * safeguard costs the GM his session on a tablet, so `buildBackup` streams the
 * zip with bounded batches and yields to the event loop between them. The FILE
 * is unchanged — one zip, the same entries, the same manifest shape — and the
 * restore half (`unzipSync`) is untouched.
 */

export const BACKUP_FORMAT = 'campaigner-backup';
export const BACKUP_FORMAT_VERSION = 1;
const MANIFEST_NAME = 'campaigner-backup.json';

/**
 * Rows serialized into the manifest between event-loop yields. The two big
 * tables are `chunks` (imported rulebook text) and `embeddings` (vectors), so
 * even one table's `JSON.stringify` is a main-thread block on a real library;
 * this bounds a batch to tens of milliseconds.
 */
const ROWS_PER_YIELD = 40;

/** Bytes handed to the deflate stream between yields (1 MiB). */
const BYTES_PER_PUSH = 1024 * 1024;

/** Progress of a running backup build, for the app-wide progress dock. */
export interface BackupProgress {
  /** What is happening right now ("Packing images (12 of 340)…"). */
  detail: string;
  /** 0..1 across the whole build. */
  progress: number;
}

export interface BuildBackupOptions {
  /** Called as the build advances; a surface maps it onto the progress dock. */
  onProgress?: (progress: BackupProgress) => void;
}

/**
 * Hands the main thread back to the browser. A MACROTASK (`setTimeout`), not a
 * resolved promise: a microtask lets the async function continue without ever
 * giving rendering, input or the browser's own watchdogs a turn, which is
 * exactly the difference between a chunked build and a blocked tab — the
 * defect docs/17 row 265 exists for.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** `mobPortraits` → `mob portraits`, for progress detail lines only. */
function readableTableName(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

/** The push half of fflate's streaming zip entries (structural, not imported). */
interface StreamingEntry {
  push: (chunk: Uint8Array, final?: boolean) => void;
}

/**
 * The in-flight marker (docs/17 row 265). Set while a backup is being built and
 * cleared when it settles, so a tab killed mid-build — iOS memory pressure, a
 * reload, a crash — leaves the mark behind and the NEXT visit to the backup
 * surface can say the last save did not finish. That is the aborted-tab arm of
 * "a failure is never silent": the dead tab cannot toast, but its successor can.
 * localStorage rather than the database because the marker must survive the
 * interruption it records and must never travel inside a backup itself.
 */
const BACKUP_IN_FLIGHT_KEY = 'campaigner.backup-in-flight';

/** The marker store, or null where there is none (node tests, a worker). */
function backupMarkerStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

export function markBackupInFlight(): void {
  backupMarkerStorage()?.setItem(BACKUP_IN_FLIGHT_KEY, String(Date.now()));
}

export function noteBackupSettled(): void {
  backupMarkerStorage()?.removeItem(BACKUP_IN_FLIGHT_KEY);
}

export function backupRunWasInterrupted(): boolean {
  const storage = backupMarkerStorage();
  return storage !== null && storage.getItem(BACKUP_IN_FLIGHT_KEY) !== null;
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_FORMAT_VERSION;
  exportedAt: number;
  /** Dexie schema version the export was taken from. */
  dbVersion: number;
  /** Row count per table (informational). */
  tableCounts: Record<string, number>;
}

/** What the zip does NOT carry: the retained rulebook PDF bytes. */
export interface PdfExclusion {
  count: number;
  totalBytes: number;
}

/** The full backup payload: the zip bytes, the parsed manifest, and what the
 * zip deliberately does NOT carry (retained rulebook PDF bytes). */
export interface BackupFile {
  bytes: Uint8Array;
  manifest: BackupManifest;
  pdfExcluded: PdfExclusion;
}

/**
 * Builds the whole-database backup zip — ASYNCHRONOUSLY and in bounded chunks
 * (docs/17 row 265). The output is still ONE file with the SAME entries and the
 * SAME manifest shape; only the way it is produced changed:
 *
 * - each table is read one at a time, and its rows are serialized in
 *   `ROWS_PER_YIELD`-row batches;
 * - the manifest JSON and every image binary are pushed into fflate's
 *   STREAMING zip in bounded slices, with a macrotask yield between slices, so
 *   the main thread keeps breathing and a mobile watchdog is never handed one
 *   long synchronous `zipSync` to kill the tab over;
 * - progress is reported per table and per image for the progress dock.
 *
 * The memory shape is bounded by design: rows are dropped as each table is
 * packed, so the peak is the LARGEST TABLE plus the growing output, never the
 * whole database plus a second full copy of its zip (`zipSync` needed both).
 * The one copy that cannot go away is the output itself: the single-file
 * contract is what the owner stores in iCloud or mails to himself, and the
 * plain-download fallback needs a Blob.
 */
export async function buildBackup(options: BuildBackupOptions = {}): Promise<BackupFile> {
  const onProgress = options.onProgress;
  const chunks: Uint8Array[] = [];
  let streamError: Error | null = null;
  const zip = new Zip((error, chunk) => {
    if (error) {
      streamError = error;
      return;
    }
    if (chunk.length > 0) chunks.push(chunk);
  });

  const failIfStreamBroken = (): void => {
    if (streamError !== null) throw streamError;
  };

  /** Pushes bytes in bounded slices, yielding between them. */
  const pushBytes = async (
    entry: StreamingEntry,
    bytes: Uint8Array,
    finalize: boolean,
  ): Promise<void> => {
    if (bytes.length === 0) {
      if (finalize) {
        entry.push(new Uint8Array(0), true);
        failIfStreamBroken();
      }
      return;
    }
    for (let offset = 0; offset < bytes.length; offset += BYTES_PER_PUSH) {
      const end = Math.min(offset + BYTES_PER_PUSH, bytes.length);
      entry.push(bytes.subarray(offset, end), finalize && end >= bytes.length);
      failIfStreamBroken();
      await yieldToEventLoop();
    }
  };

  const pushText = (entry: StreamingEntry, text: string, finalize: boolean): Promise<void> =>
    pushBytes(entry, strToU8(text), finalize);

  const manifestEntry = new ZipDeflate(MANIFEST_NAME, { level: 6 });
  zip.add(manifestEntry);

  const tableCounts: Record<string, number> = {};
  const exportedAt = Date.now();
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_FORMAT_VERSION,
    exportedAt,
    dbVersion: db.verno,
    tableCounts,
  };
  let pdfExcluded: PdfExclusion = { count: 0, totalBytes: 0 };

  try {
    const tables = db.tables;
    // One unit per table READ, one per table PACKED, one per image binary:
    // enough resolution for the dock to move without a progress report per row.
    const imageCount = await db.images.count();
    const totalUnits = tables.length * 2 + imageCount;
    let finishedUnits = 0;
    const report = (detail: string): void => {
      finishedUnits += 1;
      onProgress?.({
        detail,
        progress: totalUnits === 0 ? 1 : Math.min(1, finishedUnits / totalUnits),
      });
    };

    /** Serializes rows into the open manifest entry, yielding per batch. */
    const writeRows = async (
      rows: unknown[],
      mapRow: (row: unknown) => unknown,
    ): Promise<void> => {
      for (let start = 0; start < rows.length; start += ROWS_PER_YIELD) {
        const batch = rows.slice(start, start + ROWS_PER_YIELD);
        const text = batch.map((row) => JSON.stringify(mapRow(row))).join(',');
        await pushText(manifestEntry, start === 0 ? text : `,${text}`, false);
      }
    };

    await pushText(
      manifestEntry,
      `{"format":${JSON.stringify(BACKUP_FORMAT)},"version":${String(BACKUP_FORMAT_VERSION)},` +
        `"exportedAt":${String(exportedAt)},"dbVersion":${String(db.verno)},"data":{`,
      false,
    );

    for (const [index, table] of tables.entries()) {
      const rows = await table.toArray();
      const label = readableTableName(table.name);
      report(`Reading ${label} (${String(index + 1)} of ${String(tables.length)})…`);

      if (index > 0) await pushText(manifestEntry, ',', false);
      await pushText(manifestEntry, `${JSON.stringify(table.name)}:[`, false);
      report(`Packing ${label} (${String(index + 1)} of ${String(tables.length)})…`);

      if (table.name === 'settings') {
        // The API key never travels: stripped on export (and re-preserved from
        // the local row on import).
        await writeRows(rows, (row) => ({
          ...(row as Record<string, unknown>),
          openRouterApiKey: '',
        }));
        tableCounts[table.name] = rows.length;
      } else if (table.name === 'pdfFiles') {
        // Retained rulebook PDF bytes NEVER travel (owner-ratified). The table
        // key is still written — empty — so restore's missing-table check
        // passes and the manifest honestly counts 0.
        pdfExcluded = {
          count: rows.length,
          totalBytes: (rows as StoredPdf[]).reduce((sum, row) => sum + row.sizeBytes, 0),
        };
        tableCounts[table.name] = 0;
      } else if (table.name === 'images') {
        const metaRows: unknown[] = [];
        for (const [imageIndex, row] of (rows as StoredImage[]).entries()) {
          const { bytes, ...meta } = row;
          // Realm-safe binary check: Dexie/structured-clone backends may hand
          // back Uint8Arrays from another realm, where `instanceof` lies.
          if (!ArrayBuffer.isView(bytes)) {
            throw new Error(`Image row ${meta.id} has no binary payload`);
          }
          metaRows.push(meta);
          // The SAME level the whole-zip `zipSync` applied to every entry: the
          // streaming split changes how the file is made, never what it holds.
          // (Images were measured as pass-through first — 30 patterned 128 KiB
          // images took the zip from 375 098 B to 4 131 073 B — so storing them
          // uncompressed is a silent size regression, not a saving.)
          const entry = new ZipDeflate(
            `images/${meta.id}.${imageFileExtension(meta.mimeType)}`,
            { level: 6 },
          );
          zip.add(entry);
          await pushBytes(entry, bytes, true);
          report(`Packing images (${String(imageIndex + 1)} of ${String(imageCount)})…`);
        }
        await writeRows(metaRows, (row) => row);
        tableCounts[table.name] = metaRows.length;
      } else {
        await writeRows(rows, (row) => row);
        tableCounts[table.name] = rows.length;
      }

      await pushText(manifestEntry, ']', false);
    }

    // `tableCounts` closes the object AFTER `data`: JSON object order is
    // irrelevant to the parser, and writing it last is what lets the counts be
    // a running tally rather than a second pass over the data.
    await pushText(manifestEntry, `},"tableCounts":${JSON.stringify(tableCounts)}}`, true);
    zip.end();
    failIfStreamBroken();
  } catch (error) {
    // The zip is abandoned mid-entry; terminate so the deflate state and any
    // worker/stream resources go with it. The error is rethrown, never
    // converted into a partial archive (AGENTS rule 1).
    zip.terminate();
    throw error;
  }

  const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, manifest, pdfExcluded };
}

const backupSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.literal(BACKUP_FORMAT_VERSION),
  exportedAt: z.number(),
  dbVersion: z.number(),
  data: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});

export interface BackupImportResult {
  /** Restored row count per table. */
  tableCounts: Record<string, number>;
  totalRows: number;
  /**
   * Rows of RETIRED TABLES the zip still carried and this restore skipped, by
   * table name (`retiredTableRows`): a pre-v21 backup holds the `deliverables`
   * table the app no longer has. Skipped LOUDLY — the backup UI toasts
   * `formatRetiredTableRows` — never crashed on, never silently discarded
   * (docs/17 row 108).
   */
  retiredRows: Record<string, number>;
}

/**
 * Tables a pre-feature backup may legitimately lack: an absent key restores
 * as EMPTY instead of failing the missing-table check. `pdfFiles` (retained
 * PDF bytes, source-viewers arc) landed after backup v1 — its absence in an
 * old zip is the truth (those books have no retained bytes), not corruption.
 * `mobPortraits` (global mob-portrait cache, docs/11 D5 amendment slice A)
 * is likewise derived, rebuildable state — a pre-v18 backup restores with an
 * empty cache and the next canonical generation repopulates it.
 * `moduleVersions` (durable module document versions, docs/18 §2.3 simple
 * undo) landed after backup v1 too: a pre-v19 zip carries no undo history,
 * which is the truth about that database — the first AI change after the
 * restore starts the stack, and no module DOCUMENT text is affected (the
 * parts live on the module rows, which the zip does carry).
 */
const OPTIONAL_TABLES: ReadonlySet<string> = new Set([
  'pdfFiles',
  'mobPortraits',
  'moduleVersions',
  'ideaBoards',
  // `creatureImages` (per-campaign portraits of CITED creatures, docs/11 D5
  // amendment) landed after backup v1: a pre-v20 zip carries none, and an
  // empty presentation tier is exactly what that database had — every cited
  // creature renders initials until its portrait is generated, and no
  // authored text, roster or map is affected.
  'creatureImages',
]);

/**
 * Restores a backup zip, REPLACING every table's contents. The locally
 * stored OpenRouter API key is preserved (backups carry none). A backup
 * missing any current table (except OPTIONAL_TABLES, which restore empty),
 * or missing the binary of a referenced image, fails loudly before anything
 * is written. Retained PDF bytes are never in the zip, so a restore leaves
 * every book without retained bytes — the re-import note in the backup UI
 * says so up front.
 */
export async function importBackup(zipBytes: Uint8Array): Promise<BackupImportResult> {
  const unzipped = unzipSync(zipBytes);
  const manifestEntry = Object.entries(unzipped).find(([path]) => path === MANIFEST_NAME);
  if (manifestEntry === undefined) {
    throw new Error('Not a Campaigner backup (campaigner-backup.json missing)');
  }
  const { 'campaigner-backup.json': _manifest, ...files } = unzipped;
  void _manifest;
  const parsed = backupSchema.parse(JSON.parse(new TextDecoder().decode(manifestEntry[1])));
  // Retired tables: a pre-v21 zip carries `deliverables`, which this build
  // does not have. `db.tables` cannot see it, so without this count the rows
  // would be dropped by silence — the one outcome AGENTS rule 1 forbids.
  const retiredRows = retiredTableRows(parsed.data);

  for (const table of db.tables) {
    if (parsed.data[table.name] === undefined && !OPTIONAL_TABLES.has(table.name)) {
      throw new Error(
        `Backup is missing table "${table.name}" — it was made by an incompatible version`,
      );
    }
  }
  // Validate current authored/play schemas up front so a pre-v11 backup with
  // retired session rows or session-anchored battles fails before the wipe.
  parsed.data.ideaBoards = parseIdeaBoards(parsed.data.ideaBoards ?? []);
  for (const row of parsed.data.settings ?? []) settingsSchema.parse(row);
  for (const row of parsed.data.artifacts ?? []) anyArtifactSchema.parse(row);
  for (const row of parsed.data.battles ?? []) battleSchema.parse(row);
  for (const row of parsed.data.images ?? []) {
    const meta = storedImageSchema.parse({ ...row, bytes: new Uint8Array() });
    const file = files[`images/${meta.id}.${imageFileExtension(meta.mimeType)}`];
    if (file === undefined) {
      throw new Error(`Backup is missing the binary for image ${meta.id}`);
    }
  }

  const localApiKey = (await db.settings.get('settings'))?.openRouterApiKey ?? '';

  await db.transaction('rw', db.tables, async () => {
    for (const table of db.tables) {
      const rows = parsed.data[table.name] ?? [];
      await table.clear();
      if (table.name === 'settings') {
        for (const row of rows) {
          await table.put(settingsSchema.parse({ ...row, openRouterApiKey: localApiKey }));
        }
      } else if (table.name === 'images') {
        for (const row of rows) {
          const meta = storedImageSchema.parse({ ...row, bytes: new Uint8Array() });
          const bytes = files[`images/${meta.id}.${imageFileExtension(meta.mimeType)}`];
          if (bytes === undefined) {
            throw new Error(`Backup is missing the binary for image ${meta.id}`);
          }
          await table.put(storedImageSchema.parse({ ...meta, bytes }));
        }
      } else if (table.name === 'personas') {
        // Personas heal on restore: each row runs through personaSchema,
        // whose preprocess applies the legacy producesKind normalization
        // (normalizeLegacyProducesKind — e.g. pre-M6-E 'session' rows
        // become 'note') exactly as the repo read boundary does (docs/18
        // §2.2). A truly invalid row fails the restore loudly and the
        // transaction aborts untouched — never a planted crash.
        for (const row of rows) {
          await table.put(personaSchema.parse(row));
        }
      } else if (table.name === 'chunks') {
        // F10: chunkRepo is the only chunk-write door — the restore goes
        // through it so the keyword index invalidates WITH the write (a
        // generic bulkPut left the index stale until a page reload healed
        // it). The rows are untrusted manifest records; writeChunks parses
        // each through ruleChunkSchema — a corrupt row fails the restore
        // loudly and the transaction aborts untouched.
        await writeChunks(rows as RuleChunk[]);
      } else {
        await table.bulkPut(rows);
      }
    }
  });

  const tableCounts = Object.fromEntries(
    db.tables.map((table) => [table.name, parsed.data[table.name]?.length ?? 0]),
  );
  return {
    tableCounts,
    totalRows: Object.values(tableCounts).reduce((sum, count) => sum + count, 0),
    retiredRows,
  };
}

/** Suggested filename for a backup zip. */
export function backupFileName(exportedAt: number): string {
  return `campaigner-backup-${new Date(exportedAt).toISOString().slice(0, 10)}.zip`;
}
