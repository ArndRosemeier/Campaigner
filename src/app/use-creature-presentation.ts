import { useLiveQuery } from 'dexie-react-hooks';

import { creatureImageIdsByKey } from '@/db/creatureImages';
import type { Id } from '@/domain';

/**
 * The campaign's creature PRESENTATION snapshot (docs/11 D6): one identity →
 * the image id of the portrait this campaign shows for it. Read-only and
 * LIVE, so a surface that resolves portraits and a read-only predicate that
 * counts missing ones read the SAME fact — the defect this hook removes is two
 * surfaces disagreeing about whether a creature already has a portrait, which
 * shows up as a confirmation promising work the batch then declines.
 *
 * `undefined` while the first read is in flight: a caller that needs the
 * conservative answer for a not-yet-loaded snapshot treats `undefined` as
 * "unknown" rather than as "no portraits", which is why the map is not
 * defaulted to empty here.
 */
export function useCreaturePresentation(campaignId: Id): ReadonlyMap<string, Id> | undefined {
  return useLiveQuery(() => creatureImageIdsByKey(campaignId), [campaignId]);
}
