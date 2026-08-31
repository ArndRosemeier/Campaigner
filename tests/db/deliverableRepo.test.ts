import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  createDeliverable,
  deleteDeliverable,
  getDeliverable,
  listDeliverablesByCampaign,
  updateDeliverable,
} from '@/db/deliverableRepo';
import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { clearDatabase } from './helpers';

/**
 * Deliverable persistence (07-MILESTONE-3 M3-D): outline round-trip through
 * the discriminated-union schema (nested chapters/parts, artifact includes,
 * text, galleries).
 */

describe('deliverableRepo', () => {
  beforeEach(clearDatabase);

  it('round-trips a nested outline and partial updates', async () => {
    const campaign = await createCampaign({ name: 'C', system: 'dnd5e' });
    const npc = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Vexra' });

    const created = await createDeliverable({
      campaignId: campaign.id,
      title: 'Beneath the Docks',
      subtitle: 'An urban crawl',
      audience: 'gm',
      coverImageId: null,
      outline: [
        {
          type: 'chapter',
          title: 'Act I',
          children: [
            { type: 'part', title: 'The Dockyards', children: [] },
            { type: 'artifact', artifactId: npc.id, include: { body: true, data: true, statBlocks: false, images: true } },
            { type: 'text', markdown: '> Read aloud.' },
            { type: 'gallery', gallery: 'treasure' },
          ],
        },
        { type: 'gallery', gallery: 'npcs' },
      ],
    });

    expect(await getDeliverable(created.id)).toEqual(created);
    expect(await listDeliverablesByCampaign(campaign.id)).toHaveLength(1);

    const updated = await updateDeliverable(created.id, {
      audience: 'player',
      outline: [{ type: 'chapter', title: 'Solo chapter', children: [] }],
    });
    expect(updated.audience).toBe('player');
    expect(updated.outline[0]?.type).toBe('chapter');

    await deleteDeliverable(created.id);
    expect(await listDeliverablesByCampaign(campaign.id)).toHaveLength(0);
  });
});
