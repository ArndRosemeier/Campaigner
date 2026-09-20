import 'fake-indexeddb/auto';

import Dexie from 'dexie';
import { zipSync, strToU8 } from 'fflate';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DECLARED_DB_VERSION, purgeLegacyCampaignData, setCleanCutFault } from '@/db/cleanCut';
import type { CampaignerDB } from '@/db/db';
import { importBackup } from '@/lib/backup';
import { formatCleanCut } from '@/domain/cleanCut';
import { parseExport, withImportMitigation } from '@/lib/exportImport';
import { LegacyCampaignFileRefusedError } from '@/lib/legacyCampaignFile';
import { defaultSettings, settingsSchema } from '@/domain/settings';
import { resolveMonsterEntry } from '@/domain/encounterResolve';
import { monsterEntrySchema } from '@/domain/artifact';

/**
 * THE CLEAN CUT (docs/17 row 278). The owner's amnesty: every CAMPAIGN-scoped
 * row is purged inside ONE `version(31)` upgrade body; the LIBRARY
 * (rulebooks/chunks/embeddings/pdfFiles), the global presentation rows
 * (mobPortraits/personas/ideaBoards) and `settings` survive; and the app can
 * never come up stuck.
 *
 * Every pin here has a red-proof named in its own comment — a way to break the
 * behaviour that makes THIS test fail.
 */

const CAMPAIGN = '00000000-0000-4000-8000-0000000000c1';
const MODULE = '00000000-0000-4000-8000-0000000000d1';
const CAMPAIGN_ARTIFACT = '00000000-0000-4000-8000-0000000000a1';
const GLOBAL_ARTIFACT = '00000000-0000-4000-8000-0000000000a2';
const GLOBAL_IMAGE = '00000000-0000-4000-8000-0000000000b1';
const CAMPAIGN_IMAGE = '00000000-0000-4000-8000-0000000000b2';
const CHUNK = '00000000-0000-4000-8000-0000000000e1';
const BOOK = '00000000-0000-4000-8000-0000000000f1';
const CHUNK_HASH = 'a'.repeat(64);

/** The v30 store block (the shape the owner's install is at), minus the
 * `deliverables` table v21 already dropped. */
const V30_STORES = {
  campaigns: 'id, name',
  artifacts:
    'id, campaignId, kind, [campaignId+kind], name, updatedAt, moduleId, [moduleId+kind]',
  revisions: 'id, artifactId, [artifactId+revision]',
  images: 'id, campaignId',
  rulebooks: 'id, system, status',
  chunks: 'id, bookId, chunkType, contentHash',
  embeddings: 'contentHash',
  personas: 'id, &slug',
  runs: 'id, campaignId, personaId, status, updatedAt',
  modules: 'id, campaignId, updatedAt',
  battles: 'id, campaignId, moduleId, encounterArtifactId',
  pdfFiles: 'id, &bookId',
  mobPortraits: 'id, &creatureKey',
  moduleVersions: 'id, moduleId, createdAt',
  creatureImages: 'id, campaignId, [campaignId+creatureKey]',
  ideaBoards: 'id, updatedAt',
  settings: 'id',
} as const;

function encounterRow(id: string, campaignId: string | null, source: unknown): Record<string, unknown> {
  return {
    id,
    campaignId,
    moduleId: null,
    kind: 'encounter',
    name: 'Ambush',
    tags: [],
    aliases: [],
    summary: '',
    body: '',
    links: [],
    currentRevision: 1,
    imageIds: [],
    coverImageId: null,
    writerModel: '',
    data: {
      difficulty: 'medium',
      levelHint: '3',
      monsters: [{ name: 'Troll', count: 2, notes: '', treasure: '', source }],
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: null,
      layout: null,
      preset: 'standard',
      locationKind: 'other',
      siteShape: 'single',
      budgetAdvisory: '',
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

/** Seed a v30-shaped database with one of everything, then close it. */
async function seedV30(): Promise<void> {
  const legacy = new Dexie('campaigner');
  legacy.version(30).stores(V30_STORES);
  await legacy.open();
  await legacy.table('campaigns').put({ id: CAMPAIGN, name: 'Ember', system: 'dnd5e' });
  await legacy.table('modules').put({ id: MODULE, campaignId: CAMPAIGN, title: 'Vault' });
  await legacy.table('battles').put({ id: 'b1', campaignId: CAMPAIGN, moduleId: MODULE });
  await legacy.table('runs').put({ id: 'r1', campaignId: CAMPAIGN, status: 'completed' });
  await legacy.table('moduleVersions').put({ id: 'mv1', moduleId: MODULE, createdAt: 1 });
  await legacy.table('creatureImages').put({
    id: 'ci1',
    campaignId: CAMPAIGN,
    creatureKey: `chunk:${CHUNK}`,
    imageId: CAMPAIGN_IMAGE,
    updatedAt: 1,
  });
  await legacy.table('artifacts').put(encounterRow(CAMPAIGN_ARTIFACT, CAMPAIGN, { type: 'none' }));
  // The published LIBRARY rows: one clean, one carrying the two citation
  // spellings the clean cut no longer reads.
  await legacy.table('artifacts').put(encounterRow(GLOBAL_ARTIFACT, null, { type: 'none' }));
  await legacy.table('artifacts').put(
    encounterRow('00000000-0000-4000-8000-0000000000a3', null, {
      type: 'rulebook',
      chunkId: CHUNK,
      contentHash: CHUNK_HASH,
      creatureName: 'Troll',
    }),
  );
  await legacy.table('artifacts').put({
    id: '00000000-0000-4000-8000-0000000000a4',
    campaignId: null,
    moduleId: null,
    kind: 'npc',
    name: 'Aunt Agatha',
    tags: [],
    aliases: [],
    summary: '',
    body: '',
    links: [],
    currentRevision: 1,
    imageIds: [],
    coverImageId: null,
    writerModel: '',
    data: {
      appearance: '',
      personality: '',
      statBlock: null,
      creatureRef: { chunkId: CHUNK, creatureName: 'Troll' },
    },
    createdAt: 1,
    updatedAt: 1,
  });
  await legacy.table('images').put({ id: GLOBAL_IMAGE, campaignId: null, mimeType: 'image/png' });
  await legacy.table('images').put({ id: CAMPAIGN_IMAGE, campaignId: CAMPAIGN, mimeType: 'image/png' });
  await legacy.table('revisions').put({ id: 'rev1', artifactId: CAMPAIGN_ARTIFACT, revision: 1 });
  await legacy.table('revisions').put({ id: 'rev2', artifactId: GLOBAL_ARTIFACT, revision: 1 });
  await legacy.table('rulebooks').put({ id: BOOK, title: 'Bestiary', system: 'dnd5e', status: 'ready' });
  await legacy.table('chunks').put({ id: CHUNK, bookId: BOOK, chunkType: 'statblock', contentHash: CHUNK_HASH });
  await legacy.table('embeddings').put({ contentHash: CHUNK_HASH, model: 'm', vector: [0.1] });
  await legacy.table('pdfFiles').put({ id: 'p1', bookId: BOOK, sizeBytes: 10 });
  await legacy.table('personas').put({ id: 'pe1', slug: 'built-in', name: 'Built-in' });
  await legacy.table('ideaBoards').put({ id: 'ib1', updatedAt: 1 });
  await legacy.table('mobPortraits').put({ id: 'mp1', creatureKey: `chunk:${CHUNK}`, imageId: GLOBAL_IMAGE, updatedAt: 1 });
  await legacy.table('settings').put(defaultSettings());
  legacy.close();
}

async function openAppDb(): Promise<CampaignerDB> {
  const { db } = await import('@/db/db');
  await db.open();
  return db;
}

describe('the clean-cut purge (docs/17 row 278)', () => {
  beforeEach(async () => {
    const { db } = await import('@/db/db');
    db.close();
    await Dexie.delete('campaigner');
  });
  afterEach(async () => {
    const { db } = await import('@/db/db');
    db.close();
    await Dexie.delete('campaigner');
    setCleanCutFault(null);
  });

  it('PURGES every campaign-scoped store, KEEPS the library and settings, and reports the counts', async () => {
    await seedV30();
    const db = await openAppDb();

    // Pin 1: no old campaign row survives, and the campaign list reads [].
    // RED-PROOF: declare version(30) (no upgrade fires) → the rows stay.
    expect(await db.campaigns.count()).toBe(0);
    expect(await db.modules.count()).toBe(0);
    expect(await db.battles.count()).toBe(0);
    expect(await db.runs.count()).toBe(0);
    expect(await db.moduleVersions.count()).toBe(0);
    expect(await db.creatureImages.count()).toBe(0);
    expect(await db.artifacts.get(CAMPAIGN_ARTIFACT)).toBeUndefined();
    expect(await db.images.get(CAMPAIGN_IMAGE)).toBeUndefined();
    expect(await db.revisions.get('rev1')).toBeUndefined();
    // The global artifact's revision SURVIVES (its artifact is a library row).
    expect(await db.revisions.get('rev2')).toBeDefined();

    // Pin 2: settings survive. RED-PROOF: add `settings` to the cleared list.
    const settings = await db.settings.get('settings');
    expect(settings?.id).toBe('settings');
    expect(settings?.cleanCut?.campaignsPurged).toBe(1);

    // Pin 3: the library survives count-for-count, and the global artifact
    // still PARSES. RED-PROOF: clear `chunks`.
    expect(await db.rulebooks.count()).toBe(1);
    expect(await db.chunks.count()).toBe(1);
    expect(await db.embeddings.count()).toBe(1);
    expect(await db.pdfFiles.count()).toBe(1);
    expect(await db.personas.count()).toBe(1);
    expect(await db.ideaBoards.count()).toBe(1);
    expect(await db.mobPortraits.count()).toBe(1);
    expect(await db.artifacts.count()).toBe(3);
    expect(await db.images.count()).toBe(1);
    expect(await db.artifacts.get(GLOBAL_ARTIFACT)).toBeDefined();

    // Pin 4: the mobPortraits → library-image chain still resolves.
    // RED-PROOF: clear `images` wholesale → the portrait's blob is gone.
    const portrait = await db.mobPortraits.get('mp1');
    expect(await db.images.get(portrait?.imageId ?? '')).toBeDefined();

    // f.9: the surviving library's unconvertible citations were normalised IN
    // the same transaction, and COUNTED (the notice's instrument).
    const normalised = await db.artifacts.get('00000000-0000-4000-8000-0000000000a3');
    if (normalised?.kind !== 'encounter') throw new Error('the global encounter is missing');
    expect(normalised.data.monsters[0]?.source).toEqual({ type: 'none' });
    const npc = await db.artifacts.get('00000000-0000-4000-8000-0000000000a4');
    expect((npc?.data as { creatureRef?: unknown } | undefined)?.creatureRef).toBeUndefined();
    expect(settings?.cleanCut?.libraryLegacyCitationsDropped).toBe(2);
    expect(settings?.cleanCut?.libraryArtifactsKept).toBe(3);

    // Pin 9: the purge really ran. RED-PROOF: `version(1)` → the fallback
    // opens the stored 30 with versToRun empty and `db.verno` stays 30.
    expect(db.verno).toBe(DECLARED_DB_VERSION);
    expect(db.verno).toBe(31);
  });

  it('is IDEMPOTENT: a second purge deletes nothing and reports all-zero', async () => {
    await seedV30();
    const db = await openAppDb();
    const first = await db.transaction('rw', db.tables, (tx) => purgeLegacyCampaignData({ tx }));
    expect(first.campaignsPurged).toBe(0);
    await db.campaigns.put({ id: CAMPAIGN, name: 'Fresh' } as never);
    const second = await db.transaction('rw', db.tables, (tx) => purgeLegacyCampaignData({ tx }));
    expect(second.campaignsPurged).toBe(1);
    const third = await db.transaction('rw', db.tables, (tx) => purgeLegacyCampaignData({ tx }));
    expect(third.campaignsPurged).toBe(0);
    expect(third.artifactsPurged).toBe(0);
    expect(third.libraryLegacyCitationsDropped).toBe(0);
  });

  it('ABORTS ATOMICALLY when the body throws: the stored version and every row survive', async () => {
    await seedV30();
    setCleanCutFault(() => {
      throw new Error('injected clean-cut fault');
    });
    const { db } = await import('@/db/db');
    await expect(db.open()).rejects.toThrow(/injected clean-cut fault/);

    // The stored version is UNCHANGED and every row is intact.
    const nativeVersion = await new Promise<number>((resolve, reject) => {
      const request = indexedDB.open('campaigner');
      request.onsuccess = () => {
        const version = request.result.version;
        request.result.close();
        resolve(version);
      };
      request.onerror = () => {
        reject(request.error ?? new Error('open failed'));
      };
    });
    expect(nativeVersion).toBe(300);
    const { db: verify } = await import('@/db/db');
    verify.close();
    const legacy = new Dexie('campaigner');
    legacy.version(30).stores(V30_STORES);
    await legacy.open();
    expect(await legacy.table('campaigns').count()).toBe(1);
    expect(await legacy.table('artifacts').count()).toBe(4);
    legacy.close();

    // Removing the hook lets the SAME upgrade complete.
    setCleanCutFault(null);
    const db2 = await openAppDb();
    expect(db2.verno).toBe(31);
    expect(await db2.campaigns.count()).toBe(0);
  });

  it('opens a NEWER stored database with a non-blocking result and DELETES nothing', async () => {
    await seedV30();
    // Rewrite the stored database at native version 320 (declared 32).
    const app = await import('@/db/db');
    app.db.close();
    const newer = new Dexie('campaigner');
    newer.version(32).stores(V30_STORES);
    await newer.open();
    await newer.table('campaigns').put({ id: CAMPAIGN, name: 'From a newer build' });
    newer.close();

    const db = await openAppDb();
    // The open RESOLVED through Dexie's VersionError fallback (a blocking screen
    // would be the failure). The stored version is read off the raw backend:
    // `db.verno` keeps the DECLARED 31 (MEASURED), which is why the guard must
    // not use it.
    expect(Math.round(db.backendDB().version / 10)).toBe(32);
    // No delete: the newer build's rows are exactly as they were.
    expect(await db.campaigns.count()).toBe(1);
    const { openCampaignerDatabase } = await import('@/db/dbBoot');
    expect((await openCampaignerDatabase()).newerVersion).toEqual({ stored: 32, declared: 31 });
  });

  it('keeps exactly ONE .version( and ONE .upgrade( in db.ts', () => {
    const raw = readFileSync(path.join(process.cwd(), 'src/db/db.ts'), 'utf8');
    // Comments mention `.upgrade()` in prose; strip them so the scan counts CODE.
    const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const versions = source.match(/\.version\(/g) ?? [];
    const upgrades = source.match(/\.upgrade\(/g) ?? [];
    expect(versions).toHaveLength(1);
    expect(upgrades).toHaveLength(1);
    expect(source).toContain('DECLARED_DB_VERSION');
  });
});

describe('the clean-cut notice', () => {
  it('names the campaign count and the dropped-citation count', () => {
    const message = formatCleanCut({
      campaignsPurged: 3,
      modulesPurged: 2,
      battlesPurged: 1,
      runsPurged: 0,
      moduleVersionsPurged: 0,
      creatureImagesPurged: 0,
      artifactsPurged: 5,
      imagesPurged: 0,
      revisionsPurged: 0,
      libraryArtifactsKept: 1,
      libraryLegacyCitationsDropped: 2,
    });
    expect(message).toContain('3 campaigns');
    expect(message).toContain('2 unreadable library citations');
    expect(message).toContain('kept');
  });

  it('a report that removed nothing says so plainly', () => {
    const message = formatCleanCut({
      campaignsPurged: 0,
      modulesPurged: 0,
      battlesPurged: 0,
      runsPurged: 0,
      moduleVersionsPurged: 0,
      creatureImagesPurged: 0,
      artifactsPurged: 0,
      imagesPurged: 0,
      revisionsPurged: 0,
      libraryArtifactsKept: 0,
      libraryLegacyCitationsDropped: 0,
    });
    expect(message).toContain('no older campaign data');
  });
});

describe('the surviving settings row', () => {
  it('PARSES an OLD row that still carries all six deleted report fields, dropping them', () => {
    const parsed = settingsSchema.parse({
      ...defaultSettings(),
      retiredSessionNotesRemoved: 3,
      deliverablesRemoved: 2,
      creatureKeyFold: { mergedRows: 1 },
      creatureCitationRepair: { citationsRewritten: 1 },
      mobCopyRepair: { rosterMobsCopied: 1 },
      libraryAdopt: { adopted: [] },
    });
    expect(parsed.cleanCut).toBeNull();
    expect((parsed as Record<string, unknown>).mobCopyRepair).toBeUndefined();
    expect((parsed as Record<string, unknown>).libraryAdopt).toBeUndefined();
  });
});

describe('the npc-ref resolution is re-homed (NOT deleted)', () => {
  it('resolves a linked AUTHORED NPC from its own copied block', async () => {
    const entry = monsterEntrySchema.parse({
      name: 'Vexra',
      count: 1,
      notes: '',
      treasure: '',
      source: { type: 'npc-ref', artifactId: '22222222-2222-4222-8222-222222222222' },
    });
    const resolved = await resolveMonsterEntry(entry, {
      getArtifact: () =>
        Promise.resolve({
          id: '22222222-2222-4222-8222-222222222222',
          campaignId: null,
          moduleId: null,
          kind: 'npc',
          name: 'Vexra',
          tags: [],
          aliases: [],
          summary: '',
          body: '',
          links: [],
          currentRevision: 1,
          imageIds: [],
          coverImageId: null,
          writerModel: '',
          data: {
            appearance: '',
            personality: '',
            statBlock: { system: 'dnd5e', level: '2', ac: 12, hp: 9 },
            sourceLine: 'Bestiary p.4',
          },
          createdAt: 1,
          updatedAt: 1,
        } as never),
      getChunk: () => Promise.resolve(undefined),
      getChunkByContentHash: () => Promise.resolve(undefined),
      getRulebook: () => Promise.resolve(undefined),
    });
    expect(resolved.statBlock?.hp).toBe(9);
    expect(resolved.origin).toContain('Vexra');
  });
});

describe('older FILES are refused loudly (docs/17 row 278)', () => {
  it('refuses a pre-cut backup with its own sentence, writing nothing', async () => {
    const zip = zipSync({
      'campaigner-backup.json': strToU8(
        JSON.stringify({
          format: 'campaigner-backup',
          version: 1,
          exportedAt: 1,
          dbVersion: 30,
          data: {},
        }),
      ),
    });
    await expect(importBackup(new Uint8Array(zip))).rejects.toThrow(LegacyCampaignFileRefusedError);
    await expect(importBackup(new Uint8Array(zip))).rejects.toThrow(/format 1; this build reads format 2/);
  });

  it('refuses a pre-cut export, and withImportMitigation lets the refusal through', () => {
    const refusal = (() => {
      try {
        parseExport({ format: 'campaigner-export', version: 2, exportedAt: 1, campaign: null, artifacts: [] });
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    expect(refusal).toBeInstanceOf(LegacyCampaignFileRefusedError);
    const mitigated = withImportMitigation(refusal);
    expect(mitigated).toBe(refusal);
    expect(mitigated.message).not.toContain('re-export');
  });
});
