import {
  contentCreatureKey,
  libraryCreatureKey,
  newId,
  stampNewEntity,
  type CreatureImage,
  type Id,
  type MonsterEntry,
  type StatBlock,
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

/** The blob one row renders. */
export function documentCoverImageId(row: CreatureImage): Id {
  return row.imageId;
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

/**
 * The roster/citation side of a creature's identity, for the modules that
 * enumerate a roster (the portrait batch, the gap detector): ONE spelling of
 * "which creature is this roster entry?" — a library creature's cited chunk,
 * or an invented mob's content identity. `null` for an entry whose creature is
 * an AUTHORED artifact (an `npc-ref`): its portrait lives on that artifact, so
 * it has no presentation identity at all.
 */
export function rosterCreatureKey(entry: MonsterEntry, statBlock: StatBlock | null): string | null {
  if (entry.source.type === 'rulebook') return libraryCreatureKey(entry.source.chunkId);
  if (entry.source.type === 'inline') return contentCreatureKey(entry.name, entry.source.statBlock);
  if (entry.source.type === 'none') return contentCreatureKey(entry.name, statBlock);
  return null;
}
