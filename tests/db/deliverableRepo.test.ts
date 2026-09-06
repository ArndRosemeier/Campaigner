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
import { db } from '@/db/db';
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

/**
 * Transactional update pin (F9 remainder): updateDeliverable runs its
 * read-modify-write in one rw transaction over deliverables, like its
 * sibling repos — the merge is computed from the row as it exists at write
 * time, so two racing outline edits cannot clobber each other with a stale
 * merge. Structural pin: exactly one 'rw' transaction per update.
 */
describe('updateDeliverable transaction', () => {
  beforeEach(clearDatabase);

  it('wraps the read-modify-write in a single rw transaction', async () => {
    const campaign = await createCampaign({ name: 'Tx campaign', system: 'dnd5e' });
    const created = await createDeliverable({
      campaignId: campaign.id,
      title: 'Outline',
      subtitle: '',
      audience: 'gm',
      coverImageId: null,
      outline: [],
    });

    const calls: unknown[][] = [];
    const original = db.transaction.bind(db) as (...args: unknown[]) => unknown;
    const target = db as unknown as {
      transaction: (...args: unknown[]) => unknown;
    };
    target.transaction = (...args: unknown[]) => {
      calls.push(args);
      return original(...args);
    };
    try {
      await updateDeliverable(created.id, { title: 'Renamed' });
    } finally {
      target.transaction = original;
    }
    const txs = calls.filter((args) => args[0] === 'rw' && args[1] === db.deliverables);
    expect(txs).toHaveLength(1);
    expect((await getDeliverable(created.id))?.title).toBe('Renamed');
  });
});
