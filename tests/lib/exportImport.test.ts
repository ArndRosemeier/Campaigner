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
import {
  createModule as saveModuleRow,
  listModulesByCampaign,
  patchModule,
} from '@/db/moduleRepo';
import { ensureBattleForEncounter, patchBattle } from '@/db/battleRepo';
import { insertCreatureImageRow } from '@/db/creatureImages';
import { createRun, listRunsByCampaign, updateRun } from '@/db/runRepo';
import {
  contentCreatureKey,
  createModule as buildModule,
  globalArtifactSchema,
  moduleDocumentPlanSchema,
  newId,
  readStoredDocumentPlan,
  ruleChunkSchema,
  stageSnapshotSchema,
  statBlockSchema,
  stampNewEntity,
  type DependencyAnalysis,
  type StatBlock,
} from '@/domain';
import { sha256Hex } from '@/lib/hash';
import {
  buildCampaignExport,
  buildExport,
  buildZip,
  checkImportDependencies,
  EXPORT_FORMAT_VERSION,
  exportFileName,
  formatDriftedCitations,
  formatRetiredTableRows,
  importExport,
  importZip,
  MissingDependenciesError,
  parseExport,
  parseExportTolerant,
  withImportMitigation,
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

  /**
   * The FALLBACK half of the slug seam (docs/17 row 130): the four hand-rolled
   * copies differed only in the word they used when a name reduces to nothing,
   * and the zip entry is the one place it is easy to lose silently — an empty
   * stem would produce `artifacts/note/-<id8>.json`.
   */
  it('a zip entry for a name with nothing sluggable still carries the `artifact` stem', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const nameless = await createArtifact({ campaignId: campaign.id, kind: 'note', name: '???' });

    const files = Object.keys(unzipSync(buildZip(await buildCampaignExport(campaign.id))));

    expect(files).toContain(`artifacts/note/artifact-${nameless.id.slice(0, 8)}.json`);
  });

  it('exports only the selection when artifact ids are given', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const keep = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Keep' });
    await createArtifact({ campaignId: campaign.id, kind: 'note', name: 'Drop' });

    const exported = await buildCampaignExport(campaign.id, [keep.id]);
    expect(exported.artifacts).toHaveLength(1);
    expect(exported.artifacts[0]?.name).toBe('Keep');
    // BYTE-EXACT: the slug half of the name is the seam's (docs/17 row 130),
    // and `toContain('emberfall')` could not see it change.
    expect(exportFileName(exported)).toBe(
      `emberfall-${new Date(exported.exportedAt).toISOString().slice(0, 10)}.json`,
    );
  });

  it('builds a zip bundle containing a manifest and per-artifact files', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const grimm = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Grimm' });
    const exported = await buildCampaignExport(campaign.id);
    const zip = buildZip(exported);
    const files = Object.keys(unzipSync(zip));
    expect(files).toContain('campaigner-export.json');
    // BYTE-EXACT entry name, not a prefix: the slug half is the seam's
    // (docs/17 row 130) and a `startsWith` check could not see it change.
    expect(files).toContain(`artifacts/npc/grimm-${grimm.id.slice(0, 8)}.json`);

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

  it('round-trips modules, battles and runs with remapped references', async () => {
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
    const battle = await ensureBattleForEncounter(campaign.id, module.id, encounter.id);
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
    // The image rides the MODULE's cover slot: the deliverable-carried cover
    // went with the deliverables concept (docs/17 row 108).
    await patchModule(module.id, { coverImageId: image.id });

    const exported = await buildCampaignExport(campaign.id, undefined, { images: true });
    expect(exported.modules).toHaveLength(1);
    expect(exported.battles).toHaveLength(1);
    expect(exported.runs).toHaveLength(1);

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

    const importedModules = await listModulesByCampaign(result.campaignId);
    expect(importedModules[0]?.coverImageId).toBe(image.id);

    const restored = await getImage(image.id);
    expect(restored?.campaignId).toBe(result.campaignId);
    expect(new TextDecoder().decode(restored?.bytes ?? new Uint8Array())).toBe('cover-bytes');
  });

  it('folds a PRE-MIGRATION export’s creature keys onto the comparable form (docs/17 row 168)', async () => {
    // A file written before the v22 key fold carries keys minted by the OLD
    // mint (`name.trim().toLowerCase()`, no NFC). Importing it verbatim would
    // put legacy bytes back into a folded database and split one creature
    // across two portrait slots again — so the import path folds through the
    // SAME seam the Dexie upgrade uses.
    const DECOMPOSED = 'Wa\u0308chter'; // a + combining diaeresis (U+0308)
    const legacyKey = (name: string, statBlock: unknown): string =>
      `content:${JSON.stringify([name.trim().toLowerCase(), statBlock ?? null])}`;

    const campaign = await createCampaign({ name: 'Mac-authored', system: 'dnd5e' });
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
    const battle = await ensureBattleForEncounter(campaign.id, module.id, newId());
    const image = await createImage({
      campaignId: campaign.id,
      blob: new Blob(['portrait-bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
      width: 10,
      height: 10,
      source: 'uploaded',
    });
    await insertCreatureImageRow({
      campaignId: campaign.id,
      creatureKey: contentCreatureKey(DECOMPOSED, null),
      imageId: image.id,
    });
    const token = {
      artifactId: null,
      label: 'Wächter',
      x: 0.5,
      y: 0.5,
      visible: true,
      scale: 1,
      shape: 'circle' as const,
      color: null,
      currentHp: null,
      initiativeRoll: null,
      initiativeBonus: null,
      treasure: '',
      conditions: [],
    };
    await patchBattle(battle.id, {
      board: {
        ...battle.board,
        tokens: [{ ...token, id: newId(), creatureKey: contentCreatureKey(DECOMPOSED, null) }],
        stage: stageSnapshotSchema.parse({
          tokens: [
            { ...token, id: newId(), creatureKey: contentCreatureKey(DECOMPOSED, { ac: 9 }) },
          ],
        }),
      },
      seedFighters: [
        {
          id: newId(),
          name: 'Wächter',
          maxHp: 7,
          initiativeBonus: 1,
          creatureKey: contentCreatureKey(DECOMPOSED, null),
        },
      ],
    });

    // The export carries the FOLDED bytes; rewrite them to what a
    // pre-migration app wrote, which is exactly the file this pin imports.
    const exported = JSON.parse(JSON.stringify(await buildCampaignExport(campaign.id))) as {
      creatureImages?: { creatureKey: string }[];
      battles?: {
        board: { tokens: { creatureKey?: string }[]; stage: { tokens: { creatureKey?: string }[] } | null };
        seedFighters: { creatureKey?: string }[];
      }[];
    };
    const exportedImage = exported.creatureImages?.[0];
    if (exportedImage === undefined) throw new Error('the export carried no creature image row');
    exportedImage.creatureKey = legacyKey(DECOMPOSED, null);
    const exportedBattle = exported.battles?.[0];
    if (exportedBattle === undefined) throw new Error('the export carried no battle');
    const exportedToken = exportedBattle.board.tokens[0];
    if (exportedToken === undefined) throw new Error('the export carried no board token');
    exportedToken.creatureKey = legacyKey(DECOMPOSED, null);
    const exportedStage = exportedBattle.board.stage;
    if (exportedStage === null) throw new Error('the export carried no saved stage');
    const exportedStageToken = exportedStage.tokens[0];
    if (exportedStageToken === undefined) throw new Error('the export carried no stage token');
    exportedStageToken.creatureKey = legacyKey(DECOMPOSED, { ac: 9 });
    const exportedFighter = exportedBattle.seedFighters[0];
    if (exportedFighter === undefined) throw new Error('the export carried no seed fighter');
    exportedFighter.creatureKey = legacyKey(DECOMPOSED, null);

    const result = await importExport(exported);
    const folded = contentCreatureKey(DECOMPOSED, null);

    const rows = await db.creatureImages.where('campaignId').equals(result.campaignId).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.creatureKey).toBe(folded);
    const battles = await db.battles.where('campaignId').equals(result.campaignId).toArray();
    expect(battles[0]?.board.tokens[0]?.creatureKey).toBe(folded);
    expect(battles[0]?.board.stage?.tokens[0]?.creatureKey).toBe(
      contentCreatureKey(DECOMPOSED, { ac: 9 }),
    );
    expect(battles[0]?.seedFighters[0]?.creatureKey).toBe(folded);
    // Nothing in the restored campaign still answers to the legacy bytes.
    expect([
      ...rows.map((row) => row.creatureKey),
      ...(battles[0]?.board.tokens ?? []).map((row) => row.creatureKey),
      ...(battles[0]?.board.stage?.tokens ?? []).map((row) => row.creatureKey),
      ...(battles[0]?.seedFighters ?? []).map((row) => row.creatureKey),
    ]).not.toContain(legacyKey(DECOMPOSED, null));
  });

  it('THROWS when a module-owned artifact names a module outside the export (v2)', async () => {
    const campaign = await createCampaign({ name: 'Broken refs', system: 'dnd5e' });
    const orphanRef = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Stray' });
    // A moduleId pointing at a row this export does not carry: a hand-edited
    // or corrupt file. Silently demoting it to campaign scope would move a
    // module's artifact out of its module — the battle path 20 lines below
    // throws for the identical breakage.
    await db.artifacts.update(orphanRef.id, { moduleId: newId() });
    const exported = await buildCampaignExport(campaign.id);
    const json = JSON.parse(JSON.stringify(exported)) as Record<string, unknown>;
    json.modules = [];

    await expect(importExport(json)).rejects.toThrow(
      /references the module .* of artifact "Stray", which is outside the export/,
    );
    // Zero rows written: the failure happens inside the one transaction.
    expect(await listCampaigns()).toHaveLength(1);
  });

  it('still DEMOTES a module-owned artifact to campaign level on a v1 file (the documented rescue)', async () => {
    const campaign = await createCampaign({ name: 'Legacy ownership', system: 'dnd5e' });
    const module = await saveModuleRow(
      buildModule({
        campaignId: campaign.id,
        title: 'The Warren',
        concept: '',
        levelMin: 1,
        levelMax: 3,
        tone: '',
        sizeDial: 'standard',
      }),
    );
    const owned = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'npc',
      name: 'Grimm',
    });
    const exported = await buildCampaignExport(campaign.id);
    const v1 = JSON.parse(JSON.stringify(exported)) as Record<string, unknown>;
    // The pre-M3-E shape: version 1, no modules table at all — the artifact's
    // moduleId has nowhere to point, so it demotes (07-MILESTONE-3 M3-E).
    v1.version = 1;
    delete v1.modules;
    delete v1.battles;
    delete v1.runs;
    delete v1.dependencies;

    const result = await importExport(v1);

    expect(result.createdArtifacts).toBe(1);
    expect(await listModulesByCampaign(result.campaignId)).toHaveLength(0);
    const imported = (
      await db.artifacts.where('campaignId').equals(result.campaignId).toArray()
    ).find((row) => row.name === 'Grimm');
    expect(imported?.moduleId).toBeNull();
    expect(imported?.id).not.toBe(owned.id);
  });

  /**
   * docs/17 row 256 — the ONE id-remap pass over a loaded campaign. Two known
   * instances were closed here: a module's `documentPlan` (written VERBATIM, so
   * every plan lost its references and fell back to the procedural outline) and
   * `links[].targetId` (written VERBATIM while the artifact got a fresh id, so
   * EVERY relation in an imported campaign dangled). The library half lands on
   * the ONE adoption seam, and a relation that names nothing at all refuses the
   * import by name.
   */
  describe('the id-remap pass on import (docs/17 row 256)', () => {
    it('keeps a module’s documentPlan BY VALUE — its artifacts are the imported copies, its parts and images are untouched', async () => {
      const campaign = await createCampaign({ name: 'Planned', system: 'dnd5e' });
      const module = await saveModuleRow(
        buildModule({
          campaignId: campaign.id,
          title: 'The Warren',
          concept: '',
          levelMin: 1,
          levelMax: 3,
          tone: '',
          sizeDial: 'standard',
        }),
      );
      const encounter = await createArtifact({
        campaignId: campaign.id,
        kind: 'encounter',
        name: 'Ambush',
        data: encounterDataWith([]) as never,
      });
      const note = await createArtifact({ campaignId: campaign.id, kind: 'note', name: 'The Bell' });
      const image = await createImage({
        campaignId: campaign.id,
        blob: new Blob(['map-bytes'], { type: 'image/png' }),
        mimeType: 'image/png',
        width: 10,
        height: 10,
        source: 'uploaded',
      });
      // A plan in the shape the planner seam writes (`patchModule`).
      await patchModule(module.id, {
        documentPlan: moduleDocumentPlanSchema.parse({
          sections: [
            {
              title: 'The Fight',
              role: 'gm-note',
              audience: 'gm',
              source: { type: 'encounter', artifactId: encounter.id },
              images: [image.id],
            },
            {
              title: 'The Bell',
              role: 'explanation',
              audience: 'all',
              source: { type: 'artifact', artifactId: note.id },
              companion: { artifactId: encounter.id },
              images: [],
            },
            {
              title: 'Before the Gate',
              role: 'read-aloud',
              audience: 'all',
              source: { type: 'part', planIndex: -1 },
              images: [],
            },
          ],
          plannedByModel: 'vendor/planner-1',
          plannedAt: 1_700_000_000_000,
        }),
      });

      const exported = JSON.parse(JSON.stringify(await buildCampaignExport(campaign.id))) as unknown;
      const result = await importExport(exported);

      const importedModule = (await listModulesByCampaign(result.campaignId))[0];
      if (importedModule === undefined) throw new Error('imported module missing');
      const read = readStoredDocumentPlan(importedModule.documentPlan);
      if (read.status !== 'valid') throw new Error(`imported plan is ${read.status}`);
      const importedEncounter = (
        await db.artifacts.where('campaignId').equals(result.campaignId).toArray()
      ).find((row) => row.name === 'Ambush');
      const importedNote = (
        await db.artifacts.where('campaignId').equals(result.campaignId).toArray()
      ).find((row) => row.name === 'The Bell');
      if (importedEncounter === undefined || importedNote === undefined) {
        throw new Error('imported artifacts missing');
      }
      const sections = read.plan.sections;
      // BY VALUE: every named artifact is the IMPORTED copy, never the
      // exporting database's id.
      expect(sections[0]?.source).toEqual({
        type: 'encounter',
        artifactId: importedEncounter.id,
      });
      expect(sections[1]?.source).toEqual({ type: 'artifact', artifactId: importedNote.id });
      expect(sections[1]?.companion).toEqual({ artifactId: importedEncounter.id });
      // A part section is identity (`planIndex`), never remapped.
      expect(sections[2]?.source).toEqual({ type: 'part', planIndex: -1 });
      // The plan survives the real import path as a WHOLE, provenance included.
      expect(read.plan.plannedByModel).toBe('vendor/planner-1');
      expect(read.plan.plannedAt).toBe(1_700_000_000_000);
      // IMAGE ids are NOT remapped (images are inserted with their own id).
      expect(sections[0]?.images).toEqual([image.id]);
      expect(importedModule.coverImageId).toBe(module.coverImageId);
    });

    it('remaps every links[].targetId to the imported copy', async () => {
      const campaign = await createCampaign({ name: 'Linked', system: 'dnd5e' });
      const tower = await createArtifact({
        campaignId: campaign.id,
        kind: 'location',
        name: 'Old Tower',
      });
      const keeper = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Keeper' });
      await updateArtifact(keeper.id, {
        links: [{ targetId: tower.id, relation: 'guards' }],
      });

      const exported = JSON.parse(JSON.stringify(await buildCampaignExport(campaign.id))) as unknown;
      const result = await importExport(exported);
      const rows = await db.artifacts.where('campaignId').equals(result.campaignId).toArray();
      const importedKeeper = rows.find((row) => row.name === 'Keeper');
      const importedTower = rows.find((row) => row.name === 'Old Tower');
      if (importedKeeper === undefined || importedTower === undefined) {
        throw new Error('imported artifacts missing');
      }
      expect(importedKeeper.links).toEqual([
        { targetId: importedTower.id, relation: 'guards' },
      ]);
      // Nothing in the restored campaign still points at the exporting id.
      expect(importedKeeper.links[0]?.targetId).not.toBe(tower.id);
    });

    it('KEEPS a link whose target is gone everywhere, exactly as the file wrote it', async () => {
      const campaign = await createCampaign({ name: 'Dangling', system: 'dnd5e' });
      await createArtifact({ campaignId: campaign.id, kind: 'note', name: 'Fragment' });
      const exported = JSON.parse(JSON.stringify(await buildCampaignExport(campaign.id))) as {
        artifacts: { links: { targetId: string; relation: string }[] }[];
      };
      const goneId = newId();
      exported.artifacts[0]?.links.push({ targetId: goneId, relation: 'quotes' });

      // THE CORRECTED ARM (docs/17 row 256, after the dispatcher's integrated
      // gate refuted the strict one): a miss is NOT a whole-import refusal —
      // a selection export legitimately carries a subset of its campaign
      // (`buildCampaignExport`), and the field's own loud surface (the
      // editor's dangling-link row) is what names it. The import LANDS and the
      // id is kept BYTE-FOR-BYTE, never substituted for a live one.
      const result = await importExport(exported);
      const rows = await db.artifacts.where('campaignId').equals(result.campaignId).toArray();
      const fragment = rows.find((row) => row.name === 'Fragment');
      expect(fragment?.links).toEqual([{ targetId: goneId, relation: 'quotes' }]);
      // The campaign the file described now exists beside the original.
      expect(await listCampaigns()).toHaveLength(2);
    });

    it('ADOPTS a library link through the ONE seam and repoints it at the campaign copy', async () => {
      const campaign = await createCampaign({ name: 'Importer', system: 'dnd5e' });
      const globalNpc = globalArtifactSchema.parse({
        ...stampNewEntity(),
        campaignId: null,
        moduleId: null,
        kind: 'npc',
        name: 'Sage of the Vale',
        tags: [],
        aliases: [],
        summary: '',
        body: '',
        links: [],
        currentRevision: 1,
        imageIds: [],
        coverImageId: null,
        writerModel: '',
        data: { appearance: '', personality: '', statBlock: null },
      });
      await db.artifacts.put(globalNpc);
      const keeper = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Keeper' });
      await updateArtifact(keeper.id, {
        links: [{ targetId: globalNpc.id, relation: 'consults' }],
      });

      const exported = JSON.parse(JSON.stringify(await buildCampaignExport(campaign.id))) as unknown;
      const result = await importExport(exported);
      const rows = await db.artifacts.where('campaignId').equals(result.campaignId).toArray();
      const importedKeeper = rows.find((row) => row.name === 'Keeper');
      if (importedKeeper === undefined) throw new Error('imported keeper missing');
      const target = importedKeeper.links[0]?.targetId;
      expect(target).not.toBe(globalNpc.id);
      const copy = rows.find((row) => row.id === target);
      // The reference points at the campaign's OWN copy of the library row ...
      expect(copy?.name).toBe('Sage of the Vale');
      expect(copy?.copiedFromArtifactId).toBe(globalNpc.id);
      // ... no library pointer survives in the restored campaign ...
      expect(rows.every((row) => row.links.every((link) => link.targetId !== globalNpc.id))).toBe(
        true,
      );
      // ... and the shared library row SURVIVES beside the copy.
      expect((await db.artifacts.get(globalNpc.id))?.campaignId).toBeNull();
    });

    it('ADOPTS a battle keyed to a LIBRARY encounter and keys it to the campaign copy', async () => {
      const campaign = await createCampaign({ name: 'Book battle', system: 'dnd5e' });
      const globalEncounter = globalArtifactSchema.parse({
        ...stampNewEntity(),
        campaignId: null,
        moduleId: null,
        kind: 'encounter',
        name: 'Ford ambush',
        tags: [],
        aliases: [],
        summary: '',
        body: '',
        links: [],
        currentRevision: 1,
        imageIds: [],
        coverImageId: null,
        writerModel: '',
        data: encounterDataWith([
          { name: 'Stamp', count: 1, notes: '', treasure: '', source: { type: 'none' } },
        ]) as never,
      });
      await db.artifacts.put(globalEncounter);
      const module = await saveModuleRow(
        buildModule({
          campaignId: campaign.id,
          title: 'The Ford',
          concept: '',
          levelMin: 1,
          levelMax: 3,
          tone: '',
          sizeDial: 'standard',
        }),
      );
      // The PRE-FIX shape, exactly: the file was written when the battle's
      // seeding encounter was a LIBRARY row (no campaign copy existed).
      await ensureBattleForEncounter(campaign.id, module.id, globalEncounter.id);

      const exported = JSON.parse(JSON.stringify(await buildCampaignExport(campaign.id))) as unknown;
      const result = await importExport(exported);

      const battles = await db.battles.where('campaignId').equals(result.campaignId).toArray();
      expect(battles).toHaveLength(1);
      const key = battles[0]?.encounterArtifactId;
      expect(key).toBeDefined();
      expect(key).not.toBe(globalEncounter.id);
      const copy = key === null || key === undefined ? undefined : await db.artifacts.get(key);
      // The key is a CAMPAIGN row now, and its origin names the library row.
      expect(copy?.campaignId).toBe(result.campaignId);
      expect(copy?.copiedFromArtifactId).toBe(globalEncounter.id);
      // No library key survives anywhere in the restored campaign's battle.
      expect(battles[0]?.reseed?.encounterArtifactId ?? null).not.toBe(globalEncounter.id);
    });

    it('leaves a battle whose encounter was in no table exactly as it was (the retry arm owns it)', async () => {
      const campaign = await createCampaign({ name: 'Gone encounter', system: 'dnd5e' });
      const module = await saveModuleRow(
        buildModule({
          campaignId: campaign.id,
          title: 'The Warren',
          concept: '',
          levelMin: 1,
          levelMax: 3,
          tone: '',
          sizeDial: 'standard',
        }),
      );
      const goneId = newId();
      await ensureBattleForEncounter(campaign.id, module.id, goneId);

      const exported = JSON.parse(JSON.stringify(await buildCampaignExport(campaign.id))) as unknown;
      const result = await importExport(exported);
      const battles = await db.battles.where('campaignId').equals(result.campaignId).toArray();
      // LEFT exactly as it was — never re-keyed to a guess — for the adoption
      // seam's `danglingBattleEncounter` arm to name (docs/17 row 268).
      expect(battles[0]?.encounterArtifactId).toBe(goneId);
    });
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
    // The abort is specifically the MISSING arm, not a drift leaking in.
    expect(analysis.blockingCitations).toBe(1);
    expect(analysis.driftedCitations).toBe(0);
    // Abort-before-tx: nothing to roll back, nothing written.
    expect(await listCampaigns()).toHaveLength(campaignsBefore.length);
    expect(await db.artifacts.count()).toBe(artifactsBefore);
  });

  it('still aborts on an unmet NPC ref even when every citation is present (docs/17 row 261)', async () => {
    const { json } = await exportGoblinCampaign();
    // The library is intact, so the citation is present; only the ref is unmet.
    const exported = JSON.parse(JSON.stringify(json)) as {
      dependencies?: Record<string, unknown>;
    };
    const dependencies = exported.dependencies;
    if (dependencies === undefined) throw new Error('export fixture carries no manifest');
    dependencies.unmetLibraryRefs = [
      {
        artifactId: newId(),
        artifactName: 'Goblin ambush',
        kind: 'encounter',
        monsterName: 'Vexra',
        npcArtifactId: newId(),
        status: 'not-exported',
      },
    ];

    const campaignsBefore = await listCampaigns();
    let caught: unknown = null;
    try {
      await importExport(exported);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MissingDependenciesError);
    const analysis = (caught as MissingDependenciesError).analysis;
    // This arm blocks on its OWN: no blocking/drifted citations at all.
    expect(analysis.blockingCitations).toBe(0);
    expect(analysis.driftedCitations).toBe(0);
    expect(analysis.unmetLibraryRefs).toHaveLength(1);
    expect(analysis.clean).toBe(false);
    expect(await listCampaigns()).toHaveLength(campaignsBefore.length);
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
    // The rulebook chunkId is KEPT as-is — so the row resolves exactly like
    // any other dangling citation (the manifest hash heals content identity
    // around it, but with no local bytes there is still nothing to hit).
    expect(encounter.data.monsters[0]?.source.type).toBe('rulebook');
    const first = encounter.data.monsters[0];
    if (first === undefined) throw new Error('imported roster entry missing');
    const resolved = await resolveMonsterEntryWithRepos(first);
    // Named (docs/11 D9) — and the name is the CREATURE's, so the marker is
    // directly actionable against the library that lacks it.
    expect(resolved).toMatchObject({ statBlock: null, origin: 'missing ref (Goblin Warrior)' });
  });

  it('imports a drift-only manifest under the DEFAULT policy and REPORTS the drift (docs/17 row 261)', async () => {
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

    // The fixture really IS a drift (not present, not missing), proved BEFORE
    // the policy assertion so the import below cannot pass vacuously.
    const manifest = parseExportTolerant(json).export.dependencies;
    const analysis = await checkImportDependencies(manifest);
    expect(analysis.citations[0]?.verdict).toBe('version-drift');
    expect(analysis.books[0]?.matchLevel).toBe('L1');
    expect(analysis.blockingCitations).toBe(0);
    expect(analysis.driftedCitations).toBe(1);
    expect(analysis.clean).toBe(true);

    // DEFAULT policy: the cross-machine import PROCEEDS — the exact case the
    // owner hit. No MissingDependenciesError, no 'import-anyway' escape hatch.
    const result = await importExport(json);
    expect(result.createdArtifacts).toBe(1);
    expect(result.skippedRetired).toBe(0);
    // ...and it is NOT silent: the count rides the result and the picker's
    // sentence names the reason and the residual state.
    expect(result.driftedCitations).toBe(1);
    const note = formatDriftedCitations(result.driftedCitations);
    expect(note).toContain('1 stat block citation');
    expect(note).toContain('DIFFERENT version');
    expect(note).toContain('missing ref');
    // Both campaigns exist: the source and the imported copy.
    expect(await listCampaigns()).toHaveLength(2);

    // The residual is the repo's existing truthful one: the drifted citation
    // has no local id and no local hash, so the encounter lands as a NAMED
    // `missing ref` — never the other version's stats silently substituted.
    const imported = await db.artifacts
      .where('campaignId')
      .equals(result.campaignId)
      .toArray();
    const encounter = imported.find((row) => row.kind === 'encounter');
    if (encounter?.kind !== 'encounter') throw new Error('imported encounter missing');
    const first = encounter.data.monsters[0];
    if (first === undefined) throw new Error('imported roster entry missing');
    expect(await resolveMonsterEntryWithRepos(first)).toMatchObject({
      statBlock: null,
      origin: 'missing ref (Goblin Warrior)',
    });
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

  it('MissingDependenciesError uses ASCII quotes around missing ref', async () => {
    const { json } = await exportGoblinCampaign();
    await db.chunks.clear();
    await db.rulebooks.clear();

    const caught: unknown = await importExport(json).then(
      () => null,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(MissingDependenciesError);
    const message = (caught as MissingDependenciesError).message;
    expect(message).toContain("'missing ref'");
    expect(message).not.toContain('‘');
    expect(message).not.toContain('’');
  });
});

/**
 * Import content-identity healing (chunk-hash-fallback arc): pre-stamp
 * exports cite bare uuids, but the v2 manifest carries per-citation
 * contentHash — import stamps manifest hashes onto entries whose source
 * lacks them, so byte-identical installs resolve through the hash fallback.
 * The owner's case end to end: L0-exact Monster Core installed, banner
 * persists — now the markers clear with no re-export.
 */
describe('import content-identity healing', () => {
  beforeEach(clearDatabase);

  async function exportPrestampGoblinCampaign(): Promise<{ json: unknown; oldChunkId: string; contentHash: string }> {
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
    const contentHash = await sha256Hex(text);
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
        contentHash,
      }),
    ]);
    const [chunk] = await db.chunks.toArray();
    if (chunk === undefined) throw new Error('chunk missing');
    // A pre-stamp citation: bare uuid, no content identity of its own.
    await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Goblin ambush',
      data: encounterDataWith([
        { name: 'Goblin Warrior', count: 2, notes: '', treasure: '', source: { type: 'rulebook', chunkId: chunk.id } },
      ]) as never,
    });
    const exported = await buildCampaignExport(campaign.id);
    // The manifest carries the hash even though the entry does not.
    expect(exported.dependencies?.citations[0]?.contentHash).toBe(contentHash);
    // …and the BOOK, because the book RESOLVED at export time: that is what
    // lets the import name the pack this citation came from (docs/17 row 155).
    expect(exported.dependencies?.citations[0]?.bookTitle).toBe('Monster Core');
    return {
      json: JSON.parse(JSON.stringify(exported)) as unknown,
      oldChunkId: chunk.id,
      contentHash,
    };
  }

  async function reinstallByteIdentical(): Promise<void> {
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
  }

  async function importedEncounter(campaignId: string) {
    const imported = await db.artifacts.where('campaignId').equals(campaignId).toArray();
    const encounter = imported.find((row) => row.kind === 'encounter');
    if (encounter?.kind !== 'encounter') throw new Error('imported encounter missing');
    const first = encounter.data.monsters[0];
    if (first === undefined) throw new Error('imported roster entry missing');
    return first;
  }

  it('old-export import stamps manifest hashes and resolves byte-identical installs', async () => {
    const { json, oldChunkId, contentHash } = await exportPrestampGoblinCampaign();
    // Byte-identical reinstall under NEW row ids (the user case).
    await db.chunks.clear();
    await db.rulebooks.clear();
    await reinstallByteIdentical();

    // L0-present: the default policy lets this through, no import-anyway.
    const result = await importExport(json);
    const first = await importedEncounter(result.campaignId);
    if (first.source.type !== 'rulebook') throw new Error('expected a rulebook citation');
    // The uuid is KEPT as-is; content identity heals around it.
    expect(first.source.chunkId).toBe(oldChunkId);
    expect(first.source.contentHash).toBe(contentHash);
    expect(first.source.creatureName).toBe('Goblin Warrior');
    // The BOOK heals from the manifest too (docs/17 row 155): an export made
    // by a build that knew the book hands the pack name to the importing
    // machine, so this citation can name what to install even though the
    // exported entry itself recorded nothing.
    expect(first.source.bookTitle).toBe('Monster Core');
    const resolved = await resolveMonsterEntryWithRepos(first);
    expect(resolved.origin).toBe('Monster Core: Goblin Warrior');
    expect(resolved.statBlock).not.toBeNull();
  });

  it('names the pack of a strand it CANNOT resolve — the healing is what the banner reads', async () => {
    const { json } = await exportPrestampGoblinCampaign();
    await db.chunks.clear();
    await db.rulebooks.clear();

    const result = await importExport(json, {}, { dependencyPolicy: 'import-anyway' });
    const first = await importedEncounter(result.campaignId);
    if (first.source.type !== 'rulebook') throw new Error('expected a rulebook citation');
    const resolved = await resolveMonsterEntryWithRepos(first);
    expect(resolved.origin).toBe('missing ref (Goblin Warrior)');
    expect(resolved.missingRef).toEqual({
      creature: 'Goblin Warrior',
      bookTitle: 'Monster Core',
    });
  });

  it('import-anyway heals the hash while content is absent; a later install clears the marker', async () => {
    const { json, contentHash } = await exportPrestampGoblinCampaign();
    await db.chunks.clear();
    await db.rulebooks.clear();

    const result = await importExport(json, {}, { dependencyPolicy: 'import-anyway' });
    const first = await importedEncounter(result.campaignId);
    if (first.source.type !== 'rulebook') throw new Error('expected a rulebook citation');
    expect(first.source.contentHash).toBe(contentHash);
    const gapped = await resolveMonsterEntryWithRepos(first);
    expect(gapped).toMatchObject({
      statBlock: null,
      origin: 'missing ref (Goblin Warrior)',
    });
    // The strand says WHICH pack it came from even while it is unresolved —
    // the whole point of the healing (docs/17 row 155).
    expect(gapped.missingRef?.bookTitle).toBe('Monster Core');

    // Installing the byte-identical content later clears the marker with no
    // further import — the banner contract is this same resolution.
    await reinstallByteIdentical();
    const cleared = await resolveMonsterEntryWithRepos(first);
    expect(cleared.origin).toBe('Monster Core: Goblin Warrior');
    expect(cleared.statBlock).not.toBeNull();
  });

  it('leaves already-stamped entries untouched', async () => {
    const campaign = await createCampaign({ name: 'Stamped source', system: 'pathfinder2e' });
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
    const contentHash = await sha256Hex(text);
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
        contentHash,
      }),
    ]);
    const [chunk] = await db.chunks.toArray();
    if (chunk === undefined) throw new Error('chunk missing');
    // A new-birth citation: stamped at creation, as finalize/the dialog write.
    await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Goblin ambush',
      data: encounterDataWith([
        {
          name: 'Goblin Warrior',
          count: 2,
          notes: '',
          treasure: '',
          source: { type: 'rulebook', chunkId: chunk.id, contentHash, creatureName: 'Goblin Warrior' },
        },
      ]) as never,
    });
    const json = JSON.parse(JSON.stringify(await buildCampaignExport(campaign.id))) as unknown;
    await db.chunks.clear();
    await db.rulebooks.clear();
    await reinstallByteIdentical();

    const result = await importExport(json);
    const first = await importedEncounter(result.campaignId);
    if (first.source.type !== 'rulebook') throw new Error('expected a rulebook citation');
    // The heal fills gaps only — a stamped entry lands verbatim.
    expect(first.source.contentHash).toBe(contentHash);
    expect(first.source.creatureName).toBe('Goblin Warrior');
    expect((await resolveMonsterEntryWithRepos(first)).origin).toBe('Monster Core: Goblin Warrior');
  });
});

  it('records a loud missing-binary note instead of silently dropping refs', async () => {
    const campaign = await createCampaign({ name: 'Gappy', system: 'dnd5e' });
    const ghostMap = newId();
    const ghostCover = newId();
    const ghostGallery = newId();
    const module = await saveModuleRow(
      buildModule({
        campaignId: campaign.id,
        title: 'Coverless Vault',
        concept: '',
        levelMin: 1,
        levelMax: 3,
        sizeDial: 'sketch',
      }),
    );
    await patchModule(module.id, { coverImageId: ghostCover });
    const encounter = await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Mapless',
      data: { ...encounterDataWith([]), mapImageId: ghostMap } as never,
    });
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');
    await updateArtifact(encounter.id, { imageIds: [ghostGallery] });
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
    expect(byId.get(ghostCover)).toEqual([`module:${module.id}:cover`]);
    // The manifest still builds — missing binaries never break the export.
    expect(exported.dependencies).toBeDefined();
  });
});

/**
 * Retired-row import tolerance (06-MILESTONES M2 import rules): an export
 * written by an older build rides retired `session` artifacts (with their
 * revision snapshots) and session-anchored pre-v11 battles into a fresh
 * import whose schemas no longer accept them. Those rows are SKIPPED-WITH-
 * COUNT (the v11 upgrade precedent: sessions + revisions deleted, battles
 * cleared) and reported — never silent, never abort-the-world. Live-kind
 * rows that fail ONLY on version-drift grounds (stale generated layout
 * geometry, explicit nulls where current schemas carry defaults) skip the
 * same way; genuinely corrupt rows still abort via the original ZodError.
 */
describe('import retired-row tolerance', () => {
  beforeEach(clearDatabase);

  let roomCounter = 0;

  function distinctRoom(over: Record<string, unknown> = {}): Record<string, unknown> {
    const i = roomCounter++;
    const x = (i % 4) * 12;
    const y = Math.floor(i / 4) * 12;
    return {
      id: newId(),
      name: `Room ${String(i)}`,
      rects: [{ x, y, w: 12, h: 12 }],
      mobsRect: { x: x + 1, y: y + 1, w: 4, h: 4 },
      description: '',
      monsterIndexes: [],
      spawn: true,
      ...over,
    };
  }

  function distinctLayout(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      gridW: 48,
      gridH: 48,
      theme: 'cave',
      rooms: [distinctRoom()],
      corridors: [],
      ...over,
    };
  }

  function legacyEncounterData(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      difficulty: 'medium',
      levelHint: '1',
      monsters: [],
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: null,
      layout: null,
      preset: 'standard',
      locationKind: 'other',
      siteShape: 'single',
      budgetAdvisory: '',
      ...over,
    };
  }

  function sessionRow(campaignId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
    const stamp = Date.now();
    const id = newId();
    const base = {
      id,
      campaignId,
      moduleId: null,
      kind: 'session',
      name: 'Session 12',
      tags: [],
      aliases: [],
      summary: '',
      body: 'Recap body.',
      links: [],
      currentRevision: 2,
      imageIds: [],
      coverImageId: null,
      data: {
        sessionNumber: '12',
        recap: '',
        prep: [],
        openThreads: [],
        scenes: [],
        log: '',
      },
      createdAt: stamp,
      updatedAt: stamp,
      ...over,
    };
    const revision = (n: number): Record<string, unknown> => ({
      id: newId(),
      artifactId: id,
      revision: n,
      snapshot: { ...base, currentRevision: n },
      source: 'user',
      runId: null,
      createdAt: stamp,
      updatedAt: stamp,
    });
    return { ...base, revisions: [revision(1), revision(2)] };
  }

  it('skips retired session rows with their revisions and reports the count', async () => {
    const campaign = await createCampaign({ name: 'Old', system: 'dnd5e' });
    const note = await createArtifact({ campaignId: campaign.id, kind: 'note', name: 'Keep' });
    await updateArtifact(note.id, { body: 'Edited.' });
    const exported = JSON.parse(JSON.stringify(await buildCampaignExport(campaign.id))) as {
      artifacts: Record<string, unknown>[];
    };
    exported.artifacts.push(sessionRow(campaign.id));

    // The strict boundary still rejects the legacy file (no silent widening).
    expect(() => parseExport(exported)).toThrow();
    // Current-shape files stay zero-skip.
    expect(parseExportTolerant(JSON.parse(JSON.stringify(await buildCampaignExport(campaign.id)))).skippedRetired).toBe(0);

    const result = await importExport(exported);
    expect(result.createdArtifacts).toBe(1);
    expect(result.skippedRetired).toBe(1);
    expect(result.skippedNames).toEqual(['Session 12']);

    const imported = await db.artifacts.where('campaignId').equals(result.campaignId).toArray();
    expect(imported).toHaveLength(1);
    expect(imported[0]?.name).toBe('Keep');
    expect(imported[0]?.body).toBe('Edited.');
    const revisions = await listRevisions(imported[0]?.id ?? newId());
    expect(revisions).toHaveLength(2);
    // The session's own revision snapshots rode the skip — nothing landed.
    expect(await db.revisions.where('artifactId').equals((exported.artifacts[1] as { id: string }).id).count()).toBe(0);
  });

  it('skips single-shape encounters with stale multi-room layouts', async () => {
    const campaign = await createCampaign({ name: 'Old', system: 'dnd5e' });
    await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Arena',
      data: legacyEncounterData({ layout: distinctLayout() }),
    } as never);
    const exported = JSON.parse(JSON.stringify(await buildCampaignExport(campaign.id))) as {
      artifacts: { data: { siteShape: string; layout: { rooms: Record<string, unknown>[] } } }[];
    };
    // Legacy file: a persisted single shape carrying two rooms.
    exported.artifacts[0]?.data.layout.rooms.push({ ...distinctRoom(), spawn: false });

    const result = await importExport(exported);
    expect(result.createdArtifacts).toBe(0);
    expect(result.skippedRetired).toBe(1);
    expect(result.skippedNames).toEqual(['Arena']);
    expect(await db.artifacts.where('campaignId').equals(result.campaignId).count()).toBe(0);
  });

  it('skips layouts with no spawn room', async () => {
    const campaign = await createCampaign({ name: 'Old', system: 'dnd5e' });
    await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Spawnless',
      data: legacyEncounterData({
        siteShape: 'complex',
        layout: distinctLayout({ rooms: [distinctRoom(), { ...distinctRoom(), spawn: false }] }),
      }),
    } as never);
    const exported = JSON.parse(JSON.stringify(await buildCampaignExport(campaign.id))) as {
      artifacts: { data: { layout: { rooms: { spawn: boolean }[] } } }[];
    };
    for (const rm of exported.artifacts[0]?.data.layout.rooms ?? []) rm.spawn = false;

    const result = await importExport(exported);
    expect(result.createdArtifacts).toBe(0);
    expect(result.skippedRetired).toBe(1);
    expect(result.skippedNames).toEqual(['Spawnless']);
  });

  it('skips layouts with overlapping rooms', async () => {
    const campaign = await createCampaign({ name: 'Old', system: 'dnd5e' });
    await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Overlapped',
      data: legacyEncounterData({
        siteShape: 'complex',
        layout: distinctLayout({ rooms: [distinctRoom(), { ...distinctRoom(), spawn: false }] }),
      }),
    } as never);
    const exported = JSON.parse(JSON.stringify(await buildCampaignExport(campaign.id))) as {
      artifacts: { data: { layout: { rooms: { rects: unknown; mobsRect: unknown }[] } } }[];
    };
    const rooms = exported.artifacts[0]?.data.layout.rooms;
    if (rooms?.[1] && rooms[0]) {
      rooms[1].rects = rooms[0].rects;
      rooms[1].mobsRect = rooms[0].mobsRect;
    }

    const result = await importExport(exported);
    expect(result.createdArtifacts).toBe(0);
    expect(result.skippedRetired).toBe(1);
    expect(result.skippedNames).toEqual(['Overlapped']);
  });

  it('skips session-anchored pre-v11 battles without losing the module', async () => {
    const campaign = await createCampaign({ name: 'Old', system: 'dnd5e' });
    await saveModuleRow(
      buildModule({ campaignId: campaign.id, title: 'The Warren', concept: 'goblins', levelMin: 1, levelMax: 3, tone: '', sizeDial: 'standard' }),
    );
    await createArtifact({ campaignId: campaign.id, kind: 'note', name: 'Keep' });
    const exported = JSON.parse(JSON.stringify(await buildCampaignExport(campaign.id))) as {
      battles: Record<string, unknown>[];
    };
    const stamp = Date.now();
    // The exact pre-v11 shape: session-anchored, no moduleId (v11 cleared
    // battles because live state cannot be re-anchored from retired sessions).
    exported.battles = [
      {
        id: newId(),
        campaignId: campaign.id,
        sessionId: newId(),
        encounterArtifactId: null,
        reseed: null,
        seedFighters: [],
        board: {
          mapImageId: null, mapLayout: null, live: false, everLive: false, tokens: [], veils: [],
          effects: [], gridSize: null, tokenSize: 64, sceneryMovementLocked: false,
          initiativeEnabled: false, initiativeOrder: [], activeIndex: 0, stage: null,
          stagingGround: null, entrance: null,
        },
        createdAt: stamp,
        updatedAt: stamp,
      },
    ];

    const result = await importExport(exported);
    expect(result.createdArtifacts).toBe(1);
    expect(result.skippedRetired).toBe(1);
    expect(result.skippedNames).toEqual([]);
    expect(await listModulesByCampaign(result.campaignId)).toHaveLength(1);
    expect(await db.battles.where('campaignId').equals(result.campaignId).count()).toBe(0);
  });

  it('skips rows with explicit nulls where current schemas carry defaults', async () => {
    const campaign = await createCampaign({ name: 'Old', system: 'dnd5e' });
    await createArtifact({ campaignId: campaign.id, kind: 'note', name: 'Nullish' });
    await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Nullish fight',
      data: legacyEncounterData(),
    } as never);
    const exported = JSON.parse(JSON.stringify(await buildCampaignExport(campaign.id))) as {
      artifacts: { name: string; aliases: unknown; imageIds: unknown; data: Record<string, unknown> }[];
    };
    const noteRow = exported.artifacts.find((row) => row.name === 'Nullish');
    if (noteRow) {
      noteRow.aliases = null;
      noteRow.imageIds = null;
    }
    const encounterRow = exported.artifacts.find((row) => row.name === 'Nullish fight');
    if (encounterRow) {
      encounterRow.data.preset = null;
      encounterRow.data.locationKind = null;
      encounterRow.data.budgetAdvisory = null;
    }

    const result = await importExport(exported);
    expect(result.createdArtifacts).toBe(0);
    expect(result.skippedRetired).toBe(2);
    expect(result.skippedNames).toEqual(expect.arrayContaining(['Nullish', 'Nullish fight']));
  });

  it('still aborts loudly on genuinely corrupt live-kind rows', async () => {
    const campaign = await createCampaign({ name: 'Old', system: 'dnd5e' });
    await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Grimm' });
    const base = JSON.parse(JSON.stringify(await buildCampaignExport(campaign.id))) as {
      artifacts: [Record<string, unknown>, ...Record<string, unknown>[]];
      battles: Record<string, unknown>[];
    };

    // Empty name on a live kind: corruption, not drift.
    const emptyName = structuredClone(base);
    emptyName.artifacts[0].name = '';
    await expect(importExport(emptyName)).rejects.toThrow();

    // Never-valid kind ('map' was never in the enum): corruption, not drift.
    const badKind = structuredClone(base);
    badKind.artifacts[0].kind = 'map';
    await expect(importExport(badKind)).rejects.toThrow();

    // Corrupt roster entry (non-positive count) with a VALID layout: the
    // layout probe cannot launder a corrupt row.
    const badRoster = structuredClone(base);
    badRoster.artifacts[0].kind = 'encounter';
    (badRoster.artifacts[0] as { data: Record<string, unknown> }).data = legacyEncounterData({
      monsters: [
        { name: 'Goblin', count: 0, notes: '', treasure: '', source: { type: 'custom' } },
      ],
    });
    await expect(importExport(badRoster)).rejects.toThrow();

    // Battle with neither moduleId nor sessionId: no git-proven legacy shape.
    const stamp = Date.now();
    const badBattle = structuredClone(base);
    badBattle.battles = [
      {
        id: newId(),
        campaignId: campaign.id,
        encounterArtifactId: null,
        reseed: null,
        seedFighters: [],
        board: {
          mapImageId: null, mapLayout: null, live: false, everLive: false, tokens: [], veils: [],
          effects: [], gridSize: null, tokenSize: 64, sceneryMovementLocked: false,
          initiativeEnabled: false, initiativeOrder: [], activeIndex: 0, stage: null,
          stagingGround: null, entrance: null,
        },
        createdAt: stamp,
        updatedAt: stamp,
      },
    ];
    await expect(importExport(badBattle)).rejects.toThrow();

    // Abort-before-tx still holds: nothing landed from any attempt.
    expect(await listCampaigns()).toHaveLength(1);
  });

  it('skipped rows take their dependency citations with them (no dep abort)', async () => {
    const campaign = await createCampaign({ name: 'Old', system: 'dnd5e' });
    await createArtifact({ campaignId: campaign.id, kind: 'note', name: 'Keep' });
    const exported = JSON.parse(JSON.stringify(await buildCampaignExport(campaign.id))) as {
      artifacts: Record<string, unknown>[];
      dependencies?: {
        citations: Record<string, unknown>[];
        books: Record<string, unknown>[];
        pinnedChunks: Record<string, unknown>[];
        unmetLibraryRefs: Record<string, unknown>[];
      };
    };
    const sessionId = newId();
    exported.artifacts.push(sessionRow(campaign.id, { id: sessionId, name: 'Session 9' }));
    const chunkId = newId();
    // Hand-crafted legacy manifest: the retired session cites a rulebook the
    // local library does not have, plus an unmet NPC ref on the same row.
    exported.dependencies = {
      citations: [
        {
          artifactId: sessionId,
          artifactName: 'Session 9',
          kind: 'session',
          monsterName: 'Goblin Warrior',
          citedChunkId: chunkId,
          chunkType: 'statblock',
          status: 'resolved',
          bookTitle: 'Ghost Book',
          system: 'pathfinder2e',
          creatureName: 'Goblin Warrior',
        },
      ],
      books: [
        {
          title: 'Ghost Book',
          system: 'pathfinder2e',
          origin: 'pdf',
          pageCount: 100,
          pack: null,
          chunkCount: 50,
          citedChunkIds: [chunkId],
        },
      ],
      pinnedChunks: [],
      unmetLibraryRefs: [
        {
          artifactId: sessionId,
          artifactName: 'Session 9',
          kind: 'session',
          monsterName: 'Old friend',
          npcArtifactId: newId(),
          status: 'missing',
        },
      ],
    };

    // Default policy: no MissingDependenciesError — the skipped row's
    // citations left with it.
    const result = await importExport(exported);
    expect(result.createdArtifacts).toBe(1);
    expect(result.skippedRetired).toBe(1);
    expect(result.skippedNames).toEqual(['Session 9']);
  });

  it('a live row citing a missing book still aborts after a skip in the same file', async () => {
    const campaign = await createCampaign({ name: 'Old', system: 'pathfinder2e' });
    const encounter = await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Goblin ambush',
      data: legacyEncounterData({
        monsters: [
          { name: 'Goblin Warrior', count: 2, notes: '', treasure: '', source: { type: 'rulebook', chunkId: newId() } },
        ],
      }),
    } as never);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');
    const exported = JSON.parse(JSON.stringify(await buildCampaignExport(campaign.id))) as {
      artifacts: Record<string, unknown>[];
      dependencies?: {
        citations: Record<string, unknown>[];
        books: Record<string, unknown>[];
        pinnedChunks: Record<string, unknown>[];
        unmetLibraryRefs: Record<string, unknown>[];
      };
    };
    exported.artifacts.push(sessionRow(campaign.id, { name: 'Session 3' }));
    const chunkId = (encounter.data.monsters[0] as { source: { chunkId: string } }).source.chunkId;
    exported.dependencies = {
      citations: [
        {
          artifactId: encounter.id,
          artifactName: 'Goblin ambush',
          kind: 'encounter',
          monsterName: 'Goblin Warrior',
          citedChunkId: chunkId,
          chunkType: 'statblock',
          status: 'resolved',
          bookTitle: 'Ghost Book',
          system: 'pathfinder2e',
          creatureName: 'Goblin Warrior',
        },
      ],
      books: [
        {
          title: 'Ghost Book',
          system: 'pathfinder2e',
          origin: 'pdf',
          pageCount: 100,
          pack: null,
          chunkCount: 50,
          citedChunkIds: [chunkId],
        },
      ],
      pinnedChunks: [],
      unmetLibraryRefs: [],
    };

    // The LIVE encounter's missing citation still aborts (slice B intact) —
    // the session skip does not confuse the check. Zero rows written.
    const campaignsBefore = await listCampaigns();
    await expect(importExport(exported)).rejects.toBeInstanceOf(MissingDependenciesError);
    expect(await listCampaigns()).toHaveLength(campaignsBefore.length);

    // Import-anyway lands the live encounter and still reports the skip.
    const result = await importExport(exported, {}, { dependencyPolicy: 'import-anyway' });
    expect(result.createdArtifacts).toBe(1);
    expect(result.skippedRetired).toBe(1);
    expect(result.skippedNames).toEqual(['Session 3']);
  });
});

/**
 * RETIRED TABLES (docs/17 row 108): `deliverables` was a whole table, and a
 * file written before the concept was deleted still contains its rows. There
 * is nowhere to put them, so they are SKIPPED — and the skip is REPORTED with
 * a count, never silent (AGENTS rule 1) and never a crash on the extra key.
 */
describe('retired-table import tolerance', () => {
  beforeEach(clearDatabase);

  it('imports an old file carrying `deliverables` rows, skipping them with a reported count', async () => {
    const campaign = await createCampaign({ name: 'Old File', system: 'dnd5e' });
    await createArtifact({ campaignId: campaign.id, kind: 'note', name: 'Kept note' });
    const exported = JSON.parse(JSON.stringify(await buildCampaignExport(campaign.id))) as Record<
      string,
      unknown
    >;
    // NO CURRENT EXPORT carries this key — add it by hand, exactly as the
    // pre-v21 files do, so the tolerance is exercised against the real shape.
    expect(exported.deliverables).toBeUndefined();
    exported.deliverables = [
      {
        id: newId(),
        campaignId: campaign.id,
        title: 'Beneath the Docks',
        subtitle: 'An urban crawl',
        audience: 'gm',
        coverImageId: null,
        outline: [{ type: 'artifact', artifactId: newId(), include: {} }],
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: newId(),
        campaignId: campaign.id,
        title: 'Player handouts',
        subtitle: '',
        audience: 'player',
        coverImageId: null,
        outline: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ];

    // No throw, and the campaign lands.
    const result = await importExport(exported);
    expect(result.createdArtifacts).toBe(1);
    expect(
      (await listCampaigns()).find((row) => row.id === result.campaignId)?.name,
    ).toBe('Old File');

    // LOUD: the count is reported, and the table is not in this build at all.
    expect(result.retiredRows).toEqual({ deliverables: 2 });
    expect(db.tables.map((table) => table.name)).not.toContain('deliverables');
    // The sentence the picker toasts names the table, the count and the reason.
    const note = formatRetiredTableRows(result.retiredRows);
    expect(note).toContain('2 rows');
    expect(note).toContain('deliverables');
    expect(note).toContain('module PDF');
  });

  it('reports nothing for a current file (an empty count is never announced)', async () => {
    const campaign = await createCampaign({ name: 'Current', system: 'dnd5e' });
    const exported = await buildCampaignExport(campaign.id);
    const result = await importExport(JSON.parse(JSON.stringify(exported)) as unknown);
    expect(result.retiredRows).toEqual({});
    expect(formatRetiredTableRows(result.retiredRows)).toBeNull();
  });
});

/**
 * The drift sentence (docs/17 row 261): the count, the reason, and the honest
 * residual. An import no longer aborts on a version-drift, so this sentence is
 * the ONLY surface that tells the user why those encounters landed unresolved —
 * it may never be empty while the count is positive.
 */
describe('drift reporting', () => {
  it('says nothing for zero drifts (an empty count is never announced)', () => {
    expect(formatDriftedCitations(0)).toBeNull();
  });

  it('names the count, the DIFFERENT version and the residual `missing ref`', () => {
    const one = formatDriftedCitations(1);
    expect(one).toContain('1 stat block citation');
    expect(one).toContain('DIFFERENT version');
    expect(one).toContain('that encounter lands');
    expect(one).toContain('missing ref');
    const many = formatDriftedCitations(3);
    expect(many).toContain('3 stat block citations');
    expect(many).toContain('those encounters land');
  });
});

/**
 * Import-failure readability (error-humanization arc): the
 * `MissingDependenciesError` message itself reads as STEPS (it surfaces in
 * non-dialog contexts too — any `importExport`/`importZip` caller), and
 * `withImportMitigation` guarantees no import toast states just a cause.
 */
describe('import failure readability', () => {
  /** Minimal blocking-citation shape: the error reads only verdict + L1 title. */
  interface FakeBlockingCitation {
    citation: { bookTitle?: string };
    verdict: 'present' | 'version-drift' | 'missing';
    fuzzyHints: string[];
  }

  function fakeAnalysis(
    overrides: {
      citations?: FakeBlockingCitation[];
      unmetLibraryRefs?: DependencyAnalysis['unmetLibraryRefs'];
      blockingCitations?: number;
      driftedCitations?: number;
    } = {},
  ): DependencyAnalysis {
    return {
      citations: [],
      books: [],
      unmetLibraryRefs: [],
      pinnedMissing: [],
      clean: false,
      blockingCitations: 0,
      driftedCitations: 0,
      ...overrides,
    } as unknown as DependencyAnalysis;
  }

  it('names only the MISSING book, never a drifted one it already holds (docs/17 row 261)', () => {
    const error = new MissingDependenciesError(
      fakeAnalysis({
        blockingCitations: 1,
        driftedCitations: 1,
        citations: [
          { citation: { bookTitle: 'Monster Core' }, verdict: 'missing', fuzzyHints: [] },
          // Drift is NOT an install target: Bestiary 2 is already here, under
          // another version — telling the user to install it would be a lie.
          { citation: { bookTitle: 'Bestiary 2' }, verdict: 'version-drift', fuzzyHints: [] },
        ],
      }),
    );
    expect(error.message).toContain('Monster Core');
    expect(error.message).not.toContain('Bestiary 2');
  });

  it('MissingDependenciesError reads as numbered steps naming the missing titles', () => {
    const error = new MissingDependenciesError(
      fakeAnalysis({
        blockingCitations: 2,
        citations: [
          {
            citation: { bookTitle: 'Monster Core' },
            verdict: 'missing',
            fuzzyHints: [],
          },
          {
            citation: { bookTitle: 'Monster Core' },
            verdict: 'version-drift',
            fuzzyHints: [],
          },
        ],
      }),
    );
    expect(error.message).toContain('1.');
    expect(error.message).toContain('Import bestiary pack');
    expect(error.message).toContain('Monster Core');
    expect(error.message).toContain('2.');
    expect(error.message).toContain('missing ref');
    // Titles dedupe — one install target, not two.
    expect(error.message.match(/Monster Core/g)).toHaveLength(1);
  });

  it('MissingDependenciesError steps survive an untitled gap (unmet NPC refs)', () => {
    const error = new MissingDependenciesError(
      fakeAnalysis({
        unmetLibraryRefs: [
          {
            artifactId: '11111111-1111-4111-8111-111111111111',
            artifactName: 'Goblin ambush',
            kind: 'encounter',
            monsterName: 'Grimm',
            npcArtifactId: '22222222-2222-4222-8222-222222222222',
            status: 'not-exported',
          },
        ],
      }),
    );
    expect(error.message).toContain('NPC');
    expect(error.message).toContain('1.');
    expect(error.message).toContain('2.');
  });

  it('withImportMitigation passes Zod-shaped and deps errors through, mitigates the rest', async () => {
    const { z } = await import('zod');
    const parsed = z.object({ name: z.string() }).safeParse({});
    if (parsed.success) throw new Error('fixture should fail validation');
    expect(withImportMitigation(parsed.error)).toBe(parsed.error);

    const deps = new MissingDependenciesError(fakeAnalysis());
    expect(withImportMitigation(deps)).toBe(deps);

    const plain = new Error('Not a Campaigner zip export (manifest missing)');
    const wrapped = withImportMitigation(plain);
    expect(wrapped).not.toBe(plain);
    expect(wrapped.message).toContain('Not a Campaigner zip export (manifest missing)');
    expect(wrapped.message).toContain('same version');
  });
});
