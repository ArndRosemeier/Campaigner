/**
 * THE ONE refusal for a pre-clean-cut FILE (docs/17 row 278).
 *
 * The owner's decision was to abolish the older-shape layer rather than migrate
 * it — *"loudly refuse to load older versions"* — because a file written before
 * the cut describes CAMPAIGN data that no longer exists here (the cut removed
 * it by design) and an import of one would be a migration in disguise. So both
 * file boundaries refuse it LOUDLY and in the SAME vocabulary:
 *
 * - the BACKUP format moved 1 → 2 (`lib/backup`),
 * - the campaign EXPORT format moved 2 → 3 (`lib/exportImport`).
 *
 * ONE error class for both, so `withImportMitigation` can let the refusal
 * through untouched: the generic mitigation ("update and re-export") is FALSE
 * for a pre-cut file — there is nothing to re-update, and the old file's
 * campaigns have to be recreated — and appending it would make the toast
 * contradict itself.
 */
export class LegacyCampaignFileRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacyCampaignFileRefusedError';
  }
}

/** The refusal sentence for a pre-cut BACKUP, naming both formats. */
export function legacyBackupRefused(found: number): LegacyCampaignFileRefusedError {
  return new LegacyCampaignFileRefusedError(
    `This backup was written by an older version of Campaigner (format ${String(found)}; this build reads format 2). Campaign data did not survive the clean-cut update, so this backup cannot be restored. Save a new backup from this build — the old file's campaigns have to be recreated.`,
  );
}

/** The refusal sentence for a pre-cut campaign EXPORT, naming both formats. */
export function legacyExportRefused(found: number): LegacyCampaignFileRefusedError {
  return new LegacyCampaignFileRefusedError(
    `This campaign export was written by an older version of Campaigner (format ${String(found)}; this build reads format 3). Campaign data did not survive the clean-cut update, so this file cannot be imported. Export again from this build — the old file's campaign has to be recreated.`,
  );
}
