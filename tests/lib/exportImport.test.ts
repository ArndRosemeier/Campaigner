import 'fake-indexeddb/auto';

import { unzipSync } from 'fflate';
import { strFromU8 } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';

import { createArtifact, listRevisions } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { updateArtifact } from '@/db/artifactRepo';
import { listCampaigns } from '@/db/campaignRepo';
import { createImage, getImage } from '@/db/imageRepo';
import { createPackBook, finalizePackBook } from '@/db/rulebookRepo';
import { putChunks } from '@/db/chunkRepo';
import { createModule as saveModuleRow, listModulesByCampaign } from '@/db/moduleRepo';
import { ensureBattle, patchBattle } from '@/db/battleRepo';
import { createRun, listRunsByCampaign, updateRun } from '@/db/runRepo';
import { createDeliverable, listDeliverablesByCampaign } from '@/db/deliverableRepo';
import {
  createModule as buildModule,
  fullInclude,
  newId,
  ruleChunkSchema,
  statBlockSchema,
  stampNewEntity,
  type StatBlock,
} from '@/domain';
import { sha256Hex } from '@/lib/hash';
import {
  buildCampaignExport,
  buildExport,
  buildZip,
  EXPORT_FORMAT_VERSION,
  exportFileName,
  importExport,
  importZip,
  MissingDependenciesError,
} from '@/lib/exportImport';
import { resolveMonsterEntryWithRepos } from '@/db/monsterResolve';
import { db } from '@/db/db';
import { clearDatabase } from '../db/helpers';

/**
 * Export/import round-trip (06-MILESTONES M2): whole-campaign and selection
 * JSON, zip bundle, and re-id'd zod-validated import.
 */

beforeEach(clearDatabase);

describe('export/import', () => {
  it('round-trips a whole campaign through JSON with revisions intact', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const artifact = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Grimm',
      tags: ['goblin'],
      summary: 'A goblin boss.',
      body: 'Original body.',
      data: {
        appearance: '',
        personality: '',
        statBlock: null,
      },
    });
    await updateArtifact(artifact.id, { body: 'Edited body.' });

    const exported = await buildCampaignExport(campaign.id);
    expect(exported.campaign?.name).toBe('Emberfall');
    expect(exported.artifacts).toHaveLength(1);
    expect(exported.artifacts[0]?.revisions).toHaveLength(2);

    const json = JSON.parse(JSON.stringify(exported)) as unknown;
    const result = await importExport(json);
    expect(result.createdArtifacts).toBe(1);
    expect(result.campaignId).not.toBe(campaign.id);

    const campaigns = await listCampaigns();
    expect(campaigns).toHaveLength(2);
    const importedCampaign = campaigns.find((row) => row.id === result.campaignId);
    expect(importedCampaign?.name).toBe('Emberfall');

    const importedArtifacts = await db.artifacts
      .where('campaignId')
      .equals(result.campaignId)
      .toArray();
    const imported = importedArtifacts[0];
    expect(imported?.id).not.toBe(artifact.id);
    expect(imported?.body).toBe('Edited body.');
    expect(imported?.currentRevision).toBe(2);
    const revisions = await listRevisions(imported?.id ?? newId());
    expect(revisions).toHaveLength(2);
    expect(revisions.map((row) => row.snapshot.body).sort()).toEqual([
      'Edited body.',
      'Original body.',
    ]);
  });

  it('exports only the selection when artifact ids are given', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const keep = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Keep' });
    await createArtifact({ campaignId: campaign.id, kind: 'note', name: 'Drop' });

    const exported = await buildCampaignExport(campaign.id, [keep.id]);
    expect(exported.artifacts).toHaveLength(1);
    expect(exported.artifacts[0]?.name).toBe('Keep');
    expect(exportFileName(exported)).toContain('emberfall');
  });

  it('builds a zip bundle containing a manifest and per-artifact files', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Grimm' });
    const exported = await buildCampaignExport(campaign.id);
    const zip = buildZip(exported);
    const files = Object.keys(unzipSync(zip));
    expect(files).toContain('campaigner-export.json');
    expect(files.some((name) => name.startsWith('artifacts/npc/'))).toBe(true);

    const manifest = JSON.parse(
      strFromU8(unzipSync(zip)['campaigner-export.json'] ?? new Uint8Array()),
    ) as { format: string; artifacts: unknown[] };
    expect(manifest.format).toBe('campaigner-export');
    expect(manifest.artifacts).toHaveLength(1);
  });

  it('rejects invalid import payloads (missing format marker)', async () => {
    await expect(importExport({ artifacts: [] })).rejects.toThrow();
  });

  it('imports a single-artifact export as a fresh campaign', async () => {
    const artifact = await createArtifact({
      campaignId: newId(),
      kind: 'note',
      name: 'Loose note',
    });
    const exported = buildExport(null, [{ ...artifact, revisions: [] }]);
    const result = await importExport(JSON.parse(JSON.stringify(exported)));
    expect(result.createdArtifacts).toBe(1);
    const campaign = (await listCampaigns()).find((row) => row.id === result.campaignId);
    expect(campaign?.name).toBe('Imported campaign');
  });

  it('zip round-trips an image; plain JSON lists refs with null binaries (M3-A/M3-E)', async () => {
    const campaign = await createCampaign({ name: 'Imagery', system: 'generic-d20' });
    const image = await createImage({
      campaignId: campaign.id,
      blob: new Blob(['fake-webp-bytes'], { type: 'image/webp' }),
      mimeType: 'image/webp',
      width: 120,
      height: 80,
      prompt: 'a tower',
      model: 'google/gemini-2.5-flash-image',
      source: 'generated',
    });
    const artifact = await createArtifact({
      campaignId: campaign.id,
      kind: 'location',
      name: 'Tower',
    });
    await updateArtifact(artifact.id, {
      imageIds: [image.id],
      coverImageId: image.id,
    });

    // Plain JSON: metadata refs only, binaries omitted (M3-E lists the
    // refs with dataBase64: null instead of dropping the images field).
    const plainExport = await buildCampaignExport(campaign.id);
    expect(plainExport.images).toHaveLength(1);
    expect(plainExport.images?.[0]?.dataBase64).toBeNull();
    expect(plainExport.images?.[0]?.id).toBe(image.id);

    // Zip: images ride as binary files, JSON keeps metadata only.
    const zipExport = await buildCampaignExport(campaign.id, undefined, { images: true });
    expect(zipExport.images).toHaveLength(1);
    expect(zipExport.images?.[0]?.dataBase64).not.toBeNull();
    const zip = buildZip(zipExport);
    const files = unzipSync(zip);
    const imageFile = Object.keys(files).find((name) =>
      name.startsWith(`images/${image.id}.`),
    );
    expect(imageFile).toBe(`images/${image.id}.webp`);
    if (imageFile === undefined) throw new Error('image file missing from zip');
    expect(new TextDecoder().decode(files[imageFile])).toBe('fake-webp-bytes');
    // The zip manifest itself omits the inline payload.
    const manifest = JSON.parse(
      strFromU8(files['campaigner-export.json'] ?? new Uint8Array()),
    ) as { images?: { dataBase64: string | null }[] };
    expect(manifest.images?.[0]?.dataBase64).toBeNull();

    // Import the zip: the image comes back with its id preserved so the
    // imported artifact's imageIds/coverImageId references resolve.
    const result = await importZip(zip);
    const importedArtifacts = await db.artifacts
      .where('campaignId')
      .equals(result.campaignId)
      .toArray();
    expect(importedArtifacts[0]?.imageIds).toEqual([image.id]);
    expect(importedArtifacts[0]?.coverImageId).toBe(image.id);
    const restored = await getImage(image.id);
    expect(restored).toBeDefined();
    expect(restored?.campaignId).toBe(result.campaignId);
    expect(new TextDecoder().decode(restored?.bytes ?? new Uint8Array())).toBe(
      'fake-webp-bytes',
    );
    expect(restored?.mimeType).toBe('image/webp');
    expect(restored?.source).toBe('generated');
  });

  it('inline-image JSON import restores the blob from dataBase64', async () => {
    const campaign = await createCampaign({ name: 'Inline', system: 'generic-d20' });
    const image = await createImage({
      campaignId: campaign.id,
      blob: new Blob(['inline-bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
      width: 10,
      height: 10,
      source: 'uploaded',
    });
    const artifact = await createArtifact({
      campaignId: campaign.id,
      kind: 'note',
      name: 'Note',
    });
    await updateArtifact(artifact.id, { imageIds: [image.id] });

    const exported = await buildCampaignExport(campaign.id, undefined, { images: true });
    expect(exported.images?.[0]?.dataBase64).not.toBeNull();
    const result = await importExport(JSON.parse(JSON.stringify(exported)));
    const restored = await getImage(image.id);
    expect(restored?.campaignId).toBe(result.campaignId);
    expect(new TextDecoder().decode(restored?.bytes ?? new Uint8Array())).toBe('inline-bytes');
  });
});

/**
 * Import atomicity (F9 remainder): the whole import — campaign row, images,
 * artifacts, revisions — is ONE rw transaction over the four touched tables
 * (the same contract as backup.ts's restore). A failure halfway through
 * (a revision row failing validation) must roll back everything, never
 * strand a half-imported campaign the picker would offer forever after.
 */
describe('importExport atomicity', () => {
  beforeEach(clearDatabase);

  it('rolls the whole import back when an artifact write fails mid-import', async () => {
    const campaign = await createCampaign({ name: 'Source', system: 'dnd5e' });
    await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'A' });
    await createArtifact({ campaignId: campaign.id, kind: 'note', name: 'B' });
    const exported = await buildCampaignExport(campaign.id);
    const json = JSON.parse(JSON.stringify(exported)) as unknown;

    let addCalls = 0;
    const target = db as unknown as {
      artifacts: { add: (...args: unknown[]) => unknown };
    };
    const originalAdd = target.artifacts.add;
    target.artifacts.add = (...args: unknown[]) => {
      addCalls += 1;
      if (addCalls === 2) return Promise.reject(new Error('injected failure'));
      return originalAdd.apply(target.artifacts, args);
    };
    const revisionsBefore = await db.revisions.count();
    try {
      await expect(importExport(json)).rejects.toThrow('injected failure');
    } finally {
      target.artifacts.add = originalAdd;
    }

    // Nothing persisted: no campaign, no artifacts, and the revision count
    // is unchanged (the source artifacts' own revision-1 rows only).
    expect(await listCampaigns()).toHaveLength(1); // only the source campaign
    expect(await db.artifacts.where('campaignId').notEqual(campaign.id).count()).toBe(0);
    expect(await db.revisions.count()).toBe(revisionsBefore);
  });

  it('issues exactly one rw transaction over campaigns+images+artifacts+revisions', async () => {
    const campaign = await createCampaign({ name: 'Tx shape', system: 'dnd5e' });
    await createArtifact({ campaignId: campaign.id, kind: 'note', name: 'N' });
    const exported = await buildCampaignExport(campaign.id);
    const json = JSON.parse(JSON.stringify(exported)) as unknown;

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
      await importExport(json);
    } finally {
      target.transaction = original;
    }
    const importTxs = calls.filter(
      (args) =>
        args[0] === 'rw' &&
        Array.isArray(args[1]) &&
        (args[1] as { name: string }[]).some((table) => table.name === 'artifacts'),
    );
    expect(importTxs).toHaveLength(1);
    const importTx = importTxs[0];
    if (importTx === undefined) throw new Error('import transaction missing');
    const tables = (importTx[1] as { name: string }[]).map((table) => table.name);
    for (const name of ['campaigns', 'images', 'artifacts', 'revisions']) {
      expect(tables).toContain(name);
    }
  });
});

/** Minimal valid stat block for NPC/battle fixtures below. */
function fixtureStatBlock(over: Partial<StatBlock> = {}): StatBlock {
  return statBlockSchema.parse({
    system: 'pathfinder2e',
    level: '1',
    size: 'Small',
    creatureType: 'humanoid',
    ac: 15,
    acNote: '',
    hp: 7,
    hpFormula: '2d6',
    speed: '25 ft.',
    abilities: { str: 10, dex: 12, con: 10, int: 8, wis: 10, cha: 8 },
    saves: '',
    skills: '',
    senses: '',
    languages: '',
    traits: [],
    actions: [],
    reactions: [],
    legendary: [],
    extras: {},
    ...over,
  });
}

function encounterDataWith(monsters: unknown[]): Record<string, unknown> {
  return {
    difficulty: 'medium',
    levelHint: '1',
    monsters,
    terrain: '',
    tactics: '',
    treasure: '',
    mapImageId: null,
    layout: null,
    preset: 'standard',
    locationKind: 'other',
    siteShape: 'single',
    budgetAdvisory: '',
  };
}

/**
 * Campaign export v2 (07-MILESTONE-3 M3-E): whole-campaign tables, the
 * dependency manifest, v1 backward compatibility, and the loud
 * missing-binary note.
 */
describe('export v2', () => {
  beforeEach(clearDatabase);

  it('writes format version 2 with tables and a golden Monster-Core manifest', async () => {
    expect(EXPORT_FORMAT_VERSION).toBe(2);
    const campaign = await createCampaign({ name: 'Export v2', system: 'pathfinder2e' });

    // Pack-origin book with one cited statblock chunk (the "Monster Core").
    const book = await createPackBook({
      title: 'Monster Core',
      system: 'pathfinder2e',
      filename: 'monster-core.zip',
    });
    await finalizePackBook(book.id, {
      sourceId: 'foundry-pf2e',
      license: 'Community Use Policy',
      entriesImported: 120,
      entriesSkipped: 3,
      entriesFailed: 0,
      itemsImported: 40,
      sourceRef: 'v6.2.1',
      attemptedRefs: ['HEAD', 'v6.2.1'],
    });
    const text = 'Goblin Warrior stat block';
    await putChunks([
      ruleChunkSchema.parse({
        ...stampNewEntity(),
        bookId: book.id,
        pageStart: 1,
        pageEnd: 1,
        chunkType: 'statblock',
        headingPath: ['Goblin Warrior'],
        text,
        statBlock: fixtureStatBlock(),
        contentHash: await sha256Hex(text),
      }),
    ]);
    const chunks = await db.chunks.toArray();
    const chunk = chunks[0];
    if (chunk === undefined) throw new Error('chunk missing');
    const contentHash = await sha256Hex(text);

    const encounter = await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Goblin ambush',
      data: encounterDataWith([
        { name: 'Goblin Warrior', count: 2, notes: '', treasure: '', source: { type: 'rulebook', chunkId: chunk.id } },
      ]) as never,
    });
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');

    const run = await createRun({
      campaignId: campaign.id,
      personaId: newId(),
      autonomy: 'manual',
      userBrief: 'draft goblins',
      pinnedChunkIds: [chunk.id],
    });

    const exported = await buildCampaignExport(campaign.id);
    expect(exported.version).toBe(2);

    const manifest = exported.dependencies;
    if (manifest === undefined) throw new Error('dependencies manifest missing');
    expect(manifest.citations).toHaveLength(1);
    expect(manifest.citations[0]).toMatchObject({
      artifactId: encounter.id,
      artifactName: 'Goblin ambush',
      kind: 'encounter',
      monsterName: 'Goblin Warrior',
      bookTitle: 'Monster Core',
      system: 'pathfinder2e',
      creatureName: 'Goblin Warrior',
      chunkType: 'statblock',
      contentHash,
      citedChunkId: chunk.id,
      status: 'resolved',
    });
    expect(manifest.books).toHaveLength(1);
    expect(manifest.books[0]).toMatchObject({
      title: 'Monster Core',
      system: 'pathfinder2e',
      origin: 'pack',
      filename: 'monster-core.zip',
      pack: {
        sourceId: 'foundry-pf2e',
        sourceRef: 'v6.2.1',
        attemptedRefs: ['HEAD', 'v6.2.1'],
        entriesImported: 120,
        itemsImported: 40,
      },
      chunkCount: 1,
      citedChunkIds: [chunk.id],
    });
    expect(manifest.pinnedChunks).toHaveLength(1);
    expect(manifest.pinnedChunks[0]).toMatchObject({
      runId: run.id,
      chunkId: chunk.id,
      status: 'resolved',
      bookTitle: 'Monster Core',
      contentHash,
    });
    expect(manifest.unmetLibraryRefs).toEqual([]);
  });

  it('round-trips modules, battles, runs and deliverables with remapped references', async () => {
    const campaign = await createCampaign({ name: 'Full', system: 'dnd5e' });
    const module = await saveModuleRow(
      buildModule({
        campaignId: campaign.id,
        title: 'The Warren',
        concept: 'goblins below',
        levelMin: 1,
        levelMax: 3,
        tone: '',
        sizeDial: 'standard',
      }),
    );
    const npc = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Grimm',
      data: { appearance: '', personality: '', statBlock: fixtureStatBlock({ system: 'dnd5e' }) },
    });
    const encounter = await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Ambush',
      data: encounterDataWith([]) as never,
    });
    const battle = await ensureBattle(campaign.id, module.id);
    await patchBattle(battle.id, {
      encounterArtifactId: encounter.id,
      board: {
        ...battle.board,
        tokens: [
          {
            id: newId(),
            artifactId: npc.id,
            label: 'Grimm 1',
            x: 0.5,
            y: 0.5,
            visible: true,
            scale: 1,
            shape: 'circle',
            color: '#ff0000',
            currentHp: 5,
            initiativeRoll: null,
            initiativeBonus: 1,
            treasure: '',
            conditions: [],
          },
        ],
      },
    });
    const run = await createRun({
      campaignId: campaign.id,
      personaId: newId(),
      autonomy: 'manual',
      userBrief: 'detail Grimm',
      targetArtifactId: npc.id,
    });
    await updateRun(run.id, { resultArtifactId: npc.id, status: 'completed' });
    const image = await createImage({
      campaignId: campaign.id,
      blob: new Blob(['cover-bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
      width: 10,
      height: 10,
      source: 'uploaded',
    });
    const deliverable = await createDeliverable({
      campaignId: campaign.id,
      title: 'Module PDF',
      subtitle: '',
      audience: 'gm',
      coverImageId: image.id,
      outline: [{ type: 'artifact', artifactId: npc.id, include: fullInclude() }],
    });

    const exported = await buildCampaignExport(campaign.id, undefined, { images: true });
    expect(exported.modules).toHaveLength(1);
    expect(exported.battles).toHaveLength(1);
    expect(exported.runs).toHaveLength(1);
    expect(exported.deliverables).toHaveLength(1);

    const result = await importExport(JSON.parse(JSON.stringify(exported)) as unknown);
    expect(result.createdArtifacts).toBe(2);

    const modules = await listModulesByCampaign(result.campaignId);
    expect(modules).toHaveLength(1);
    expect(modules[0]?.title).toBe('The Warren');
    expect(modules[0]?.id).not.toBe(module.id);
    const newModuleId = modules[0]?.id;
    if (newModuleId === undefined) throw new Error('imported module missing');

    const importedNpc = (
      await db.artifacts.where('campaignId').equals(result.campaignId).toArray()
    ).find((row) => row.name === 'Grimm');
    const importedEncounter = (
      await db.artifacts.where('campaignId').equals(result.campaignId).toArray()
    ).find((row) => row.name === 'Ambush');
    if (importedNpc === undefined || importedEncounter === undefined) {
      throw new Error('imported artifacts missing');
    }

    const battles = await db.battles.where('campaignId').equals(result.campaignId).toArray();
    expect(battles).toHaveLength(1);
    expect(battles[0]?.moduleId).toBe(newModuleId);
    expect(battles[0]?.encounterArtifactId).toBe(importedEncounter.id);
    expect(battles[0]?.board.tokens[0]?.artifactId).toBe(importedNpc.id);

    const runs = await listRunsByCampaign(result.campaignId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.targetArtifactId).toBe(importedNpc.id);
    expect(runs[0]?.resultArtifactId).toBe(importedNpc.id);

    const deliverables = await listDeliverablesByCampaign(result.campaignId);
    expect(deliverables).toHaveLength(1);
    expect(deliverables[0]?.coverImageId).toBe(image.id);
    const node = deliverables[0]?.outline[0];
    expect(node).toMatchObject({ type: 'artifact', artifactId: importedNpc.id });
    expect(deliverable.id).not.toBe(deliverables[0]?.id);

    const restored = await getImage(image.id);
    expect(restored?.campaignId).toBe(result.campaignId);
    expect(new TextDecoder().decode(restored?.bytes ?? new Uint8Array())).toBe('cover-bytes');
  });

  it('still parses v1 files (no v2 tables, version 1)', async () => {
    const campaign = await createCampaign({ name: 'Legacy', system: 'dnd5e' });
    await createArtifact({ campaignId: campaign.id, kind: 'note', name: 'Old note' });
    const exported = await buildCampaignExport(campaign.id);
    const v1 = JSON.parse(JSON.stringify(exported)) as Record<string, unknown>;
    v1.version = 1;
    delete v1.modules;
    delete v1.battles;
    delete v1.runs;
    delete v1.deliverables;
    delete v1.dependencies;
    delete v1.images;
    delete v1.missingImages;

    const result = await importExport(v1);
    expect(result.createdArtifacts).toBe(1);
    const campaigns = await listCampaigns();
    expect(campaigns.find((row) => row.id === result.campaignId)?.name).toBe('Legacy');
    expect(await listModulesByCampaign(result.campaignId)).toHaveLength(0);
    expect(await listRunsByCampaign(result.campaignId)).toHaveLength(0);
  });

/**
 * Dependency enforcement on import (07-MILESTONE-3 M3-E slice B): the
 * default abort on L0-miss (zero rows written — the check runs BEFORE the
 * transaction opens) vs import-anyway (lands with `missing ref` markers,
 * rulebook chunkIds kept as-is).
 */
describe('import dependency enforcement', () => {
  beforeEach(clearDatabase);

  async function exportGoblinCampaign(): Promise<{ json: unknown; campaignId: string }> {
    const campaign = await createCampaign({ name: 'Dep source', system: 'pathfinder2e' });
    const book = await createPackBook({
      title: 'Monster Core',
      system: 'pathfinder2e',
      filename: 'monster-core.zip',
    });
    await finalizePackBook(book.id, {
      sourceId: 'foundry-pf2e',
      license: 'Community Use Policy',
      entriesImported: 120,
      entriesSkipped: 3,
      entriesFailed: 0,
    });
    const text = 'Goblin Warrior stat block';
    await putChunks([
      ruleChunkSchema.parse({
        ...stampNewEntity(),
        bookId: book.id,
        pageStart: 1,
        pageEnd: 1,
        chunkType: 'statblock',
        headingPath: ['Goblin Warrior'],
        text,
        statBlock: fixtureStatBlock(),
        contentHash: await sha256Hex(text),
      }),
    ]);
    const [chunk] = await db.chunks.toArray();
    if (chunk === undefined) throw new Error('chunk missing');
    await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Goblin ambush',
      data: encounterDataWith([
        { name: 'Goblin Warrior', count: 2, notes: '', treasure: '', source: { type: 'rulebook', chunkId: chunk.id } },
      ]) as never,
    });
    return {
      json: JSON.parse(JSON.stringify(await buildCampaignExport(campaign.id))) as unknown,
      campaignId: campaign.id,
    };
  }

  it('aborts by default when the cited book is gone — zero rows written', async () => {
    const { json } = await exportGoblinCampaign();
    await db.chunks.clear();
    await db.rulebooks.clear();

    const campaignsBefore = await listCampaigns();
    const artifactsBefore = await db.artifacts.count();
    let caught: unknown = null;
    try {
      await importExport(json);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MissingDependenciesError);
    const analysis = (caught as MissingDependenciesError).analysis;
    expect(analysis.citations[0]?.verdict).toBe('missing');
    expect(analysis.books[0]?.matchLevel).toBe('missing');
    expect(analysis.clean).toBe(false);
    // Abort-before-tx: nothing to roll back, nothing written.
    expect(await listCampaigns()).toHaveLength(campaignsBefore.length);
    expect(await db.artifacts.count()).toBe(artifactsBefore);
  });

  it('import-anyway lands the encounter with a truthful `missing ref`', async () => {
    const { json } = await exportGoblinCampaign();
    await db.chunks.clear();
    await db.rulebooks.clear();

    const result = await importExport(json, {}, { dependencyPolicy: 'import-anyway' });
    const imported = await db.artifacts.where('campaignId').equals(result.campaignId).toArray();
    expect(imported).toHaveLength(1);
    const encounter = imported[0];
    if (encounter?.kind !== 'encounter') throw new Error('imported encounter missing');
    // The rulebook chunkId is KEPT as-is (never healed) — so the row
    // resolves exactly like any other dangling citation.
    expect(encounter.data.monsters[0]?.source.type).toBe('rulebook');
    const first = encounter.data.monsters[0];
    if (first === undefined) throw new Error('imported roster entry missing');
    const resolved = await resolveMonsterEntryWithRepos(first);
    expect(resolved).toMatchObject({ statBlock: null, origin: 'missing ref' });
  });

  it('still aborts on version drift (L1) but import-anyway lands it', async () => {
    const { json } = await exportGoblinCampaign();
    // Same book re-ingested: same title/system/creature, different bytes.
    await db.chunks.clear();
    await db.rulebooks.clear();
    const book = await createPackBook({
      title: 'Monster Core',
      system: 'pathfinder2e',
      filename: 'monster-core.zip',
    });
    await finalizePackBook(book.id, {
      sourceId: 'foundry-pf2e',
      license: 'Community Use Policy',
      entriesImported: 120,
      entriesSkipped: 3,
      entriesFailed: 0,
    });
    const revised = 'Goblin Warrior stat block, revised printing';
    await putChunks([
      ruleChunkSchema.parse({
        ...stampNewEntity(),
        bookId: book.id,
        pageStart: 1,
        pageEnd: 1,
        chunkType: 'statblock',
        headingPath: ['Goblin Warrior'],
        text: revised,
        statBlock: fixtureStatBlock(),
        contentHash: await sha256Hex(revised),
      }),
    ]);

    let caught: unknown = null;
    try {
      await importExport(json);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MissingDependenciesError);
    expect((caught as MissingDependenciesError).analysis.citations[0]?.verdict).toBe(
      'version-drift',
    );
    expect((caught as MissingDependenciesError).analysis.books[0]?.matchLevel).toBe('L1');
    expect(await listCampaigns()).toHaveLength(1); // source only

    const result = await importExport(json, {}, { dependencyPolicy: 'import-anyway' });
    expect(result.createdArtifacts).toBe(1);
  });

  it('zip imports enforce the same policy', async () => {
    const { campaignId } = await exportGoblinCampaign();
    const zip = buildZip(
      await buildCampaignExport(campaignId, undefined, { images: true }),
    );
    await db.chunks.clear();
    await db.rulebooks.clear();

    await expect(importZip(zip)).rejects.toBeInstanceOf(MissingDependenciesError);
    expect(await listCampaigns()).toHaveLength(1);
    const result = await importZip(zip, { dependencyPolicy: 'import-anyway' });
    expect(result.createdArtifacts).toBe(1);
  });
});

  it('records a loud missing-binary note instead of silently dropping refs', async () => {
    const campaign = await createCampaign({ name: 'Gappy', system: 'dnd5e' });
    const ghostMap = newId();
    const ghostCover = newId();
    const ghostGallery = newId();
    const encounter = await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Mapless',
      data: { ...encounterDataWith([]), mapImageId: ghostMap } as never,
    });
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');
    await updateArtifact(encounter.id, { imageIds: [ghostGallery] });
    await createDeliverable({
      campaignId: campaign.id,
      title: 'Coverless',
      subtitle: '',
      audience: 'gm',
      coverImageId: ghostCover,
      outline: [],
    });

    const exported = await buildCampaignExport(campaign.id);
    expect(exported.images).toEqual([]);
    const missing = exported.missingImages ?? [];
    expect(missing).toHaveLength(3);
    const byId = new Map(missing.map((entry) => [entry.id, entry.referencedBy]));
    expect(byId.get(ghostMap)).toEqual([`artifact:${encounter.id}:map`]);
    // The gallery id is referenced twice: the artifact row plus the new
    // revision snapshot updateArtifact wrote (both referrers are named).
    expect(byId.get(ghostGallery)).toContain(`artifact:${encounter.id}`);
    expect(byId.get(ghostGallery)).toHaveLength(2);
    const deliverables = await listDeliverablesByCampaign(campaign.id);
    expect(byId.get(ghostCover)).toEqual([`deliverable:${deliverables[0]?.id}:cover`]);
    // The manifest still builds — missing binaries never break the export.
    expect(exported.dependencies).toBeDefined();
  });
});
