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
  newId,
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
  importExport,
  importZip,
  MissingDependenciesError,
  parseExport,
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

    const files = Object.keys(unzipSync(await buildZip(await buildCampaignExport(campaign.id))));

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
    const zip = await buildZip(exported);
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

  /**
   * ASYNC, CHUNKED ZIP (docs/17 row 276). The campaign export used to call the
   * synchronous `zipSync` over the whole payload on the main thread — the
   * row-265 defect in the other action. Pinned here is the PROPERTY `zipSync`
   * could not have: a MACROTASK that runs while the build is still in flight.
   * The timer is scheduled BEFORE the build starts, so only a real macrotask
   * boundary INSIDE the build lets it run first; an implementation that yields
   * with a resolved promise (a microtask) drains before any timer and reds this
   * too. jsdom cannot end a tab, so this differential is the suite's whole
   * reach and the device is the owner's proof.
   */
  it('yields to the event loop while the zip is packed (row 276 differential)', async () => {
    const campaign = await createCampaign({ name: 'Async Emberfall', system: 'dnd5e' });
    await createArtifact({
      campaignId: campaign.id,
      kind: 'note',
      name: 'Long note',
      body: 'x'.repeat(64 * 1024),
    });
    const exported = await buildCampaignExport(campaign.id);

    let buildSettled = false;
    let macrotaskRanWhilePacking = false;
    setTimeout(() => {
      if (!buildSettled) macrotaskRanWhilePacking = true;
    }, 0);
    const zip = await buildZip(exported).then((bytes) => {
      buildSettled = true;
      return bytes;
    });

    expect(macrotaskRanWhilePacking).toBe(true);
    // …and the file is still the same single-file export the import accepts.
    expect(Object.keys(unzipSync(zip))).toContain('campaigner-export.json');
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
    const zip = await buildZip(zipExport);
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

  it('writes format version 3 with tables and a golden Monster-Core manifest', async () => {
    expect(EXPORT_FORMAT_VERSION).toBe(3);
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
      // A COPIED mob (docs/17 row 255a): it OWNS the block, so it cites no
      // library row — the run pin is the only library dependency left.
      data: encounterDataWith([
        {
          name: 'Goblin Warrior',
          count: 2,
          notes: '',
          treasure: '',
          source: { type: 'inline', statBlock: fixtureStatBlock() },
          sourceLine: 'Monster Core: Goblin Warrior',
          originToken: `chunk:${chunk.id}`,
        },
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
    expect(exported.version).toBe(3);

    const manifest = exported.dependencies;
    if (manifest === undefined) throw new Error('dependencies manifest missing');
    // A COPY cites nothing (docs/17 row 278): the encounter contributes no
    // citation entry at all, and the run pin is the only library dependency.
    expect(manifest.citations).toEqual([]);
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
});

describe('import dependency enforcement', () => {
  beforeEach(clearDatabase);

  /**
   * The export carries a roster `npc-ref` to a row ANOTHER campaign holds — the
   * DRIFT POLICY's always-blocking arm (docs/17 row 261), which is current
   * behaviour. The stat-block citation arms that used to drive these tests were
   * deleted by the clean cut (docs/17 row 278), so a COPIED mob no longer
   * contributes a library dependency; the run pin still does.
   */
  async function exportGoblinCampaign(): Promise<{
    json: unknown;
    campaignId: string;
    otherNpcId: string;
  }> {
    const campaign = await createCampaign({ name: 'Dep source', system: 'pathfinder2e' });
    const otherCampaign = await createCampaign({ name: 'Other', system: 'pathfinder2e' });
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
    const otherNpc = await createArtifact({
      campaignId: otherCampaign.id,
      kind: 'npc',
      name: 'Vexra',
      data: { appearance: '', personality: '', statBlock: fixtureStatBlock() },
    });
    await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Goblin ambush',
      data: encounterDataWith([
        {
          name: 'Vexra',
          count: 1,
          notes: '',
          treasure: '',
          source: { type: 'npc-ref', artifactId: otherNpc.id },
        },
      ]) as never,
    });
    await createRun({
      campaignId: campaign.id,
      personaId: newId(),
      autonomy: 'manual',
      userBrief: 'draft goblins',
      pinnedChunkIds: [chunk.id],
    });
    return {
      json: JSON.parse(JSON.stringify(await buildCampaignExport(campaign.id))) as unknown,
      campaignId: campaign.id,
      otherNpcId: otherNpc.id,
    };
  }

  it('aborts by default when an npc-ref target is outside the export — zero rows written', async () => {
    const { json } = await exportGoblinCampaign();

    const campaignsBefore = await listCampaigns();
    const artifactsBefore = await db.artifacts.count();
    const caught: unknown = await importExport(json).then(
      () => null,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(MissingDependenciesError);
    const analysis = (caught as MissingDependenciesError).analysis;
    expect(analysis.citations).toEqual([]);
    expect(analysis.unmetLibraryRefs).toHaveLength(1);
    expect(analysis.unmetLibraryRefs[0]).toMatchObject({ status: 'not-exported' });
    expect(analysis.blockingCitations).toBe(0);
    expect(analysis.driftedCitations).toBe(0);
    expect(analysis.clean).toBe(false);
    // Abort-before-tx: nothing to roll back, nothing written.
    expect(await listCampaigns()).toHaveLength(campaignsBefore.length);
    expect(await db.artifacts.count()).toBe(artifactsBefore);
  });

  it('still aborts on an unmet NPC ref even when every run pin resolves (docs/17 row 261)', async () => {
    const { json } = await exportGoblinCampaign();
    // The library is intact, so the run pin resolves; only the ref is unmet.
    const manifest = parseExport(json).dependencies;
    if (manifest === undefined) throw new Error('export fixture carries no manifest');
    expect(manifest.pinnedChunks.filter((pin) => pin.status !== 'resolved')).toEqual([]);
    const analysis = await checkImportDependencies(manifest);
    expect(analysis.unmetLibraryRefs).toHaveLength(1);
    expect(analysis.blockingCitations).toBe(0);
    expect(analysis.driftedCitations).toBe(0);
    expect(analysis.clean).toBe(false);
  });

  it('import-anyway lands the encounter with a truthful `missing ref`', async () => {
    const { json, otherNpcId } = await exportGoblinCampaign();
    // The cited row is GONE at import time (the owner's cross-machine case).
    await db.artifacts.delete(otherNpcId);

    const result = await importExport(json, {}, { dependencyPolicy: 'import-anyway' });
    const imported = await db.artifacts.where('campaignId').equals(result.campaignId).toArray();
    const encounter = imported.find((row) => row.kind === 'encounter');
    if (encounter?.kind !== 'encounter') throw new Error('imported encounter missing');
    const first = encounter.data.monsters[0];
    if (first === undefined) throw new Error('imported roster entry missing');
    expect(first.source.type).toBe('npc-ref');
    // Named (docs/11 D9) — and the name is the ROW's, so the marker is
    // directly actionable.
    expect(await resolveMonsterEntryWithRepos(first)).toMatchObject({
      statBlock: null,
      origin: 'missing ref (Vexra)',
    });
  });

  it('imports a drift-only manifest under the DEFAULT policy and REPORTS the drift (docs/17 row 261)', async () => {
    const { json } = await exportGoblinCampaign();
    // Same book re-ingested: same title/system, different bytes.
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

    // The manifest SHAPE still carries citations (format 3 is unchanged): a
    // file written by another install can name a stat-block citation, and the
    // drift policy is what an import does with one. Inject a drifted citation
    // so the policy is exercised end to end.
    const exported = JSON.parse(JSON.stringify(json)) as {
      dependencies: Record<string, unknown>;
    };
    exported.dependencies.citations = [
      {
        artifactId: newId(),
        artifactName: 'Goblin ambush',
        kind: 'encounter',
        monsterName: 'Goblin Warrior',
        citedChunkId: newId(),
        chunkType: 'statblock',
        status: 'missing-chunk',
        contentHash: await sha256Hex('Goblin Warrior stat block, older printing'),
        bookTitle: 'Monster Core',
        system: 'pathfinder2e',
        creatureName: 'Goblin Warrior',
      },
    ];
    exported.dependencies.unmetLibraryRefs = [];

    // The fixture really IS a drift (not present, not missing), proved BEFORE
    // the policy assertion so the import below cannot pass vacuously.
    const manifest = parseExport(exported).dependencies;
    const analysis = await checkImportDependencies(manifest);
    expect(analysis.citations[0]?.verdict).toBe('version-drift');
    expect(analysis.books[0]?.matchLevel).toBe('L1');
    expect(analysis.blockingCitations).toBe(0);
    expect(analysis.driftedCitations).toBe(1);
    expect(analysis.clean).toBe(true);

    // DEFAULT policy: the cross-machine import PROCEEDS — the exact case the
    // owner hit. No MissingDependenciesError, no 'import-anyway' escape hatch.
    const result = await importExport(exported);
    expect(result.createdArtifacts).toBe(1);
    // ...and it is NOT silent: the count rides the result and the picker's
    // sentence names the reason and the residual state.
    expect(result.driftedCitations).toBe(1);
    const note = formatDriftedCitations(result.driftedCitations);
    expect(note).toContain('1 stat block citation');
    expect(note).toContain('DIFFERENT version');
    expect(note).toContain('missing ref');
    // Both campaigns exist: the source and the imported copy.
    expect(await listCampaigns()).toHaveLength(3);
  });

  it('zip imports enforce the same policy', async () => {
    const { campaignId } = await exportGoblinCampaign();
    const zip = await buildZip(
      await buildCampaignExport(campaignId, undefined, { images: true }),
    );

    await expect(importZip(zip)).rejects.toBeInstanceOf(MissingDependenciesError);
    const result = await importZip(zip, { dependencyPolicy: 'import-anyway' });
    expect(result.createdArtifacts).toBe(1);
  });

  it('MissingDependenciesError uses ASCII quotes around missing ref', async () => {
    const { json } = await exportGoblinCampaign();

    const caught: unknown = await importExport(json).then(
      () => null,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(MissingDependenciesError);
    const message = (caught as MissingDependenciesError).message;
    expect(message).toContain("'missing ref'");
    expect(message).not.toContain('\u2018');
    expect(message).not.toContain('\u2019');
  });
});

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
