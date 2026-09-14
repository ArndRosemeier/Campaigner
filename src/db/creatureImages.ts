import {
  newId,
  stampNewEntity,
  type CreatureImage,
  type Id,
} from '@/domain';
import { db } from '@/db/db';

/**
 * The presentation-row store (docs/11 D5 amendment): per-campaign portraits
 * for creatures that are cited but NOT owned. One row per (campaign,
 * creature identity); `imageId` is a campaign-scoped blob cloned from the
 * global canonical slot.
 *
 * Thin by design — the QUESTIONS live in `db/creatureRepo` (resolution, the
 * cover lookup, the cast). This module is only the table and its two row
 * operations, so nothing outside `src/db` ever names the table.
 */

/** Parse-on-read for presentation rows (the ratified `parseBattleRow` template). */
function parseRow(row: CreatureImage): CreatureImage {
  return row;
}

/** One creature's presentation row, when this campaign has one. */
export async function getCreatureImageRow(
  campaignId: Id,
  creatureKey: string,
): Promise<CreatureImage | undefined> {
  const row = await db.creatureImages
    .where('[campaignId+creatureKey]')
    .equals([campaignId, creatureKey])
    .first();
  return row === undefined ? undefined : parseRow(row);
}

/** Every presentation row of one campaign, keyed by creature identity — the
 * snapshot the read-only batch count and the module-level gap detector walk. */
export async function listCreatureImageRows(
  campaignId: Id,
): Promise<CreatureImage[]> {
  const rows = await db.creatureImages.where('campaignId').equals(campaignId).toArray();
  return rows.map(parseRow);
}

/** The campaign's presentation rows as a key → imageId map (the batch UI's
 * one read; one walk, no per-creature query). */
export async function creatureImageIdsByKey(campaignId: Id): Promise<Map<string, Id>> {
  const rows = await listCreatureImageRows(campaignId);
  return new Map(rows.map((row) => [row.creatureKey, row.imageId]));
}

/** Stamps a brand-new presentation row (the caller has already checked that
 * none exists — `setCreatureCover` in `db/creatureRepo` owns the decision). */
export async function insertCreatureImageRow(options: {
  campaignId: Id;
  creatureKey: string;
  imageId: Id;
}): Promise<CreatureImage> {
  const row: CreatureImage = {
    ...stampNewEntity(),
    id: newId(),
    campaignId: options.campaignId,
    creatureKey: options.creatureKey,
    imageId: options.imageId,
  };
  await db.creatureImages.add(row);
  return row;
}
