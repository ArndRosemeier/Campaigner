import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { createCampaignDocument, getModule, listModulesByCampaign, saveModule } from '@/db/moduleRepo';
import { createModule as buildModule } from '@/domain';
import { isCampaignDocumentExistsError } from '@/lib/errors';
import { clearDatabase } from './helpers';

/**
 * ONE DOCUMENT PER CAMPAIGN at the WRITE boundary (docs/23 §10 phase 2,
 * docs/17 row 389).
 *
 * The app's creation path (`llm/moduleGen.startCampaignDocument`) goes through
 * `createCampaignDocument`, and this file pins its contract: a campaign that
 * already owns a module row REFUSES a second one with the existing document
 * NAMED, and NO row is written. That is AGENTS rules 1/2 at the seam that
 * could otherwise mint an invisible second document.
 *
 * `saveModule`/`createModule` stay the general validated upsert ON PURPOSE:
 * updates write through them, and a test or an IMPORT that must reproduce a
 * LEGACY multi-module campaign seeds rows directly (the extra rows are then
 * surfaced by `LegacyModulesNotice`, never hidden).
 */
describe('createCampaignDocument — one document per campaign (docs/17 row 389)', () => {
  beforeEach(clearDatabase);

  async function campaign(): Promise<string> {
    return (await createCampaign({ name: 'Ember', system: 'dnd5e' })).id;
  }

  function module(campaignId: string, title: string) {
    return buildModule({
      campaignId,
      title,
      concept: 'A first chapter.',
      levelMin: 1,
      levelMax: 2,
      sizeDial: 'sketch',
    });
  }

  it('writes the FIRST document and returns it', async () => {
    const campaignId = await campaign();
    const saved = await createCampaignDocument(module(campaignId, 'Vault of Whispers'));

    expect(saved.campaignId).toBe(campaignId);
    expect((await getModule(saved.id))?.title).toBe('Vault of Whispers');
    expect(await listModulesByCampaign(campaignId)).toHaveLength(1);
  });

  it('REFUSES a second document, naming the existing one, and writes NO row', async () => {
    const campaignId = await campaign();
    await createCampaignDocument(module(campaignId, 'Vault of Whispers'));

    let caught: unknown;
    try {
      await createCampaignDocument(module(campaignId, 'Sunken Cult'));
    } catch (error) {
      caught = error;
    }

    // LOUD and NAMED (AGENTS rules 1/2): never a silent no-op.
    expect(isCampaignDocumentExistsError(caught)).toBe(true);
    expect(caught instanceof Error ? caught.message : '').toContain('Vault of Whispers');
    expect(caught instanceof Error ? caught.message : '').toContain('ONE document');

    // …and the refusal is TOTAL: the campaign still owns exactly the one row,
    // with the would-be second title nowhere in the table.
    const rows = await listModulesByCampaign(campaignId);
    expect(rows).toHaveLength(1);
    expect(rows.map((row) => row.title)).toEqual(['Vault of Whispers']);
  });

  it('does not touch ANOTHER campaign — the rule is per campaign', async () => {
    const first = await campaign();
    const second = await createCampaign({ name: 'Other', system: 'dnd5e' });
    await createCampaignDocument(module(first, 'First Document'));

    const other = await createCampaignDocument(module(second.id, 'Second Document'));
    expect((await getModule(other.id))?.title).toBe('Second Document');
    expect(await listModulesByCampaign(first)).toHaveLength(1);
    expect(await listModulesByCampaign(second.id)).toHaveLength(1);
  });

  it('is NOT the general upsert: `saveModule` still updates an existing row', async () => {
    const campaignId = await campaign();
    const saved = await createCampaignDocument(module(campaignId, 'Vault of Whispers'));
    const renamed = await saveModule({ ...saved, title: 'The Renamed Vault' });
    expect((await getModule(renamed.id))?.title).toBe('The Renamed Vault');
    expect(await listModulesByCampaign(campaignId)).toHaveLength(1);
  });
});

describe('the document title follows the campaign name (docs/17 row 402)', () => {
  beforeEach(clearDatabase);

  it('a new campaign document is titled with the campaign name; a rename moves it; an owner-typed title stays', async () => {
    const { startCampaignDocument } = await import('@/llm/moduleGen');
    const { updateCampaign } = await import('@/db/campaignRepo');
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const id = await startCampaignDocument(campaign);
    expect((await getModule(id))?.title).toBe('Ember');
    await updateCampaign(campaign.id, { name: 'Cinder' });
    expect((await getModule(id))?.title).toBe('Cinder');
    const { patchModule } = await import('@/db/moduleRepo');
    await patchModule(id, { title: 'My Own Title' });
    await updateCampaign(campaign.id, { name: 'Ash' });
    expect((await getModule(id))?.title).toBe('My Own Title');
  });
});
