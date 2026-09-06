import { unzipSync, zipSync, strToU8 } from 'fflate';
import { z } from 'zod';

import { db } from '@/db/db';
import {
  anyArtifactSchema,
  battleSchema,
  settingsSchema,
  storedImageSchema,
  type StoredImage,
  type StoredPdf,
} from '@/domain';
import { imageFileExtension } from '@/lib/exportImport';

/**
 * Full-app backup (M4-C): zips the ENTIRE IndexedDB state — campaigns,
 * artifacts, revisions, rulebooks, chunks, embeddings, personas, runs,
 * deliverables, modules, images — as one `campaigner-backup.zip`. The
 * OpenRouter API key never leaves the browser: it is stripped from the
 * export and the locally stored key is preserved on import. Image binaries
 * ride the zip as `images/<id>.<ext>` files referenced by the manifest rows
 * (same scheme as the campaign export). Retained rulebook PDF bytes are
 * EXCLUDED always (owner-ratified, source-viewers arc): the PDF is a
 * convenience copy of a file the user owns on disk — chunks, embeddings and
 * everything functional ride the zip; the export reports the exclusion so
 * the backup UI can show a loud re-import note. Import REPLACES the whole
 * database.
 */

export const BACKUP_FORMAT = 'campaigner-backup';
export const BACKUP_FORMAT_VERSION = 1;
const MANIFEST_NAME = 'campaigner-backup.json';

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

/** Builds the whole-database backup zip. */
export async function buildBackup(): Promise<BackupFile> {
  const data: Record<string, unknown[]> = {};
  const files: Record<string, Uint8Array> = {};
  let pdfExcluded: PdfExclusion = { count: 0, totalBytes: 0 };

  for (const table of db.tables) {
    const rows = await table.toArray();
    if (table.name === 'settings') {
      // The API key never travels: stripped on export (and re-preserved from
      // the local row on import).
      data[table.name] = rows.map((row) => ({
        ...(row as Record<string, unknown>),
        openRouterApiKey: '',
      }));
    } else if (table.name === 'pdfFiles') {
      // Retained rulebook PDF bytes NEVER travel (owner-ratified). The table
      // key is still written — empty — so restore's missing-table check
      // passes and the manifest honestly counts 0.
      data[table.name] = [];
      pdfExcluded = {
        count: rows.length,
        totalBytes: (rows as StoredPdf[]).reduce((sum, row) => sum + row.sizeBytes, 0),
      };
    } else if (table.name === 'images') {
      const imageRows: unknown[] = [];
      for (const row of rows as StoredImage[]) {
        const { bytes, ...meta } = row;
        // Realm-safe binary check: Dexie/structured-clone backends may hand
        // back Uint8Arrays from another realm, where `instanceof` lies.
        if (!ArrayBuffer.isView(bytes)) {
          throw new Error(`Image row ${meta.id} has no binary payload`);
        }
        imageRows.push(meta);
        files[`images/${meta.id}.${imageFileExtension(meta.mimeType)}`] = bytes;
      }
      data[table.name] = imageRows;
    } else {
      data[table.name] = rows;
    }
  }

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_FORMAT_VERSION,
    exportedAt: Date.now(),
    dbVersion: db.verno,
    tableCounts: Object.fromEntries(
      Object.entries(data).map(([name, rows]) => [name, rows.length]),
    ),
  };
  files[MANIFEST_NAME] = strToU8(
    JSON.stringify({ ...manifest, data }, null, 2),
  );
  return { bytes: zipSync(files, { level: 6 }), manifest, pdfExcluded };
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
}

/**
 * Tables a pre-feature backup may legitimately lack: an absent key restores
 * as EMPTY instead of failing the missing-table check. `pdfFiles` (retained
 * PDF bytes, source-viewers arc) landed after backup v1 — its absence in an
 * old zip is the truth (those books have no retained bytes), not corruption.
 */
const OPTIONAL_TABLES: ReadonlySet<string> = new Set(['pdfFiles']);

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

  for (const table of db.tables) {
    if (parsed.data[table.name] === undefined && !OPTIONAL_TABLES.has(table.name)) {
      throw new Error(
        `Backup is missing table "${table.name}" — it was made by an incompatible version`,
      );
    }
  }
  // Validate current authored/play schemas up front so a pre-v11 backup with
  // retired session rows or session-anchored battles fails before the wipe.
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
  };
}

/** Suggested filename for a backup zip. */
export function backupFileName(exportedAt: number): string {
  return `campaigner-backup-${new Date(exportedAt).toISOString().slice(0, 10)}.zip`;
}
