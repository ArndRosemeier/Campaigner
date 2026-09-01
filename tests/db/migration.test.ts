import 'fake-indexeddb/auto';

import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';

/**
 * Schema migration (07-MILESTONE-3 M3-A): a database created by version 1
 * (before images existed) is upgraded in place — artifacts gain
 * `imageIds: []` / `coverImageId: null`, runs gain `targetArtifactId: null`.
 * The v1 store block is never mutated; only the upgrade function fills
 * defaults.
 */

describe('v1 → v4 migration', () => {
  it('fills image, monster-source, and session defaults on rows written by version 1', async () => {
    // Build a v1-only database with pre-M3 rows, then close it.
    const legacy = new Dexie('campaigner');
    legacy.version(1).stores({
      campaigns: 'id, name',
      artifacts: 'id, campaignId, kind, [campaignId+kind], name, updatedAt',
      revisions: 'id, artifactId, [artifactId+revision]',
      rulebooks: 'id, system, status',
      chunks: 'id, bookId, chunkType, contentHash',
      embeddings: 'contentHash',
      personas: 'id, &slug',
      runs: 'id, campaignId, personaId, status, updatedAt',
      settings: 'id',
    });
    await legacy.open();
    await legacy.table('campaigns').put({
      id: '00000000-0000-4000-8000-0000000000c1',
      name: 'Legacy',
      system: 'dnd5e',
      description: '',
      createdAt: 1,
      updatedAt: 1,
    });
    await legacy.table('artifacts').put({
      id: '00000000-0000-4000-8000-0000000000a1',
      campaignId: '00000000-0000-4000-8000-0000000000c1',
      kind: 'note',
      name: 'Old note',
      tags: [],
      summary: '',
      body: 'Written before M3.',
      links: [],
      currentRevision: 1,
      data: {},
      createdAt: 1,
      updatedAt: 1,
    });
    // Pre-M3-B encounter: monster entries have no `source` yet.
    await legacy.table('artifacts').put({
      id: '00000000-0000-4000-8000-0000000000a2',
      campaignId: '00000000-0000-4000-8000-0000000000c1',
      kind: 'encounter',
      name: 'Old ambush',
      tags: [],
      summary: '',
      body: '',
      links: [],
      currentRevision: 1,
      data: {
        difficulty: 'medium',
        levelHint: '3',
        monsters: [{ name: 'Troll', count: 2, notes: 'regenerates' }],
        terrain: '',
        tactics: '',
        treasure: '',
      },
      createdAt: 1,
      updatedAt: 1,
    });
    // Pre-M3-C session: no scenes/log yet.
    await legacy.table('artifacts').put({
      id: '00000000-0000-4000-8000-0000000000a3',
      campaignId: '00000000-0000-4000-8000-0000000000c1',
      kind: 'session',
      name: 'Old session',
      tags: [],
      summary: '',
      body: '',
      links: [],
      currentRevision: 1,
      data: { sessionNumber: '1', recap: '', prep: [], openThreads: [] },
      createdAt: 1,
      updatedAt: 1,
    });
    await legacy.table('runs').put({
      id: '00000000-0000-4000-8000-0000000000d1',
      campaignId: '00000000-0000-4000-8000-0000000000c1',
      personaId: '00000000-0000-4000-8000-0000000000e1',
      autonomy: 'manual',
      status: 'completed',
      userBrief: 'brief',
      pinnedChunkIds: [],
      steps: [],
      resultArtifactId: '00000000-0000-4000-8000-0000000000a1',
      errorMessage: '',
      createdAt: 1,
      updatedAt: 1,
    });
    legacy.close();

    // Opening the app's versioned DB runs the version-2 and version-3 upgrades.
    const { db } = await import('@/db/db');
    const artifact = await db.artifacts.get('00000000-0000-4000-8000-0000000000a1');
    expect(artifact?.imageIds).toEqual([]);
    expect(artifact?.coverImageId).toBeNull();
    const run = await db.runs.get('00000000-0000-4000-8000-0000000000d1');
    expect(run?.targetArtifactId).toBeNull();

    // v1 → v3: pre-M3-B encounter monsters become name-only entries.
    const encounter = await db.artifacts.get('00000000-0000-4000-8000-0000000000a2');
    expect(encounter?.kind === 'encounter' && encounter.data.monsters[0]?.source).toEqual({
      type: 'none',
    });

    // v1 → v4: pre-M3-C sessions gain the play checklist and log defaults.
    const session = await db.artifacts.get('00000000-0000-4000-8000-0000000000a3');
    expect(session?.kind === 'session' && session.data.scenes).toEqual([]);
    expect(session?.kind === 'session' && session.data.log).toBe('');

    // The upgraded rows validate against the current domain schemas.
    const { artifactSchema, personaRunSchema } = await import('@/domain');
    expect(artifactSchema.parse(artifact).imageIds).toEqual([]);
    expect(personaRunSchema.parse(run).targetArtifactId).toBeNull();

    await db.delete();
  });
});

describe('v5 → v6 migration', () => {
  it('creates the modules table and backfills artifact.aliases to []', async () => {
    // Build a v5-only database (before the Module Designer existed) with
    // artifacts that have no `aliases` field, then close it.
    await Dexie.delete('campaigner');
    const legacy = new Dexie('campaigner');
    legacy.version(5).stores({
      campaigns: 'id, name',
      artifacts: 'id, campaignId, kind, [campaignId+kind], name, updatedAt',
      revisions: 'id, artifactId, [artifactId+revision]',
      images: 'id, campaignId',
      rulebooks: 'id, system, status',
      chunks: 'id, bookId, chunkType, contentHash',
      embeddings: 'contentHash',
      personas: 'id, &slug',
      runs: 'id, campaignId, personaId, status, updatedAt',
      deliverables: 'id, campaignId',
      settings: 'id',
    });
    await legacy.open();
    await legacy.table('artifacts').put({
      id: '00000000-0000-4000-8000-0000000000a4',
      campaignId: '00000000-0000-4000-8000-0000000000c1',
      kind: 'note',
      name: 'Pre-v6 note',
      tags: [],
      summary: '',
      body: '',
      links: [],
      imageIds: [],
      coverImageId: null,
      currentRevision: 1,
      data: {},
      createdAt: 1,
      updatedAt: 1,
    });
    await legacy.table('artifacts').put({
      id: '00000000-0000-4000-8000-0000000000a5',
      campaignId: '00000000-0000-4000-8000-0000000000c1',
      kind: 'npc',
      name: 'Pre-v6 npc',
      tags: [],
      summary: '',
      body: '',
      links: [],
      imageIds: [],
      coverImageId: null,
      currentRevision: 1,
      data: { goals: '', methods: '', resources: '', ranks: [] },
      createdAt: 1,
      updatedAt: 1,
    });
    legacy.close();

    // Opening the app's versioned DB runs the version-6 upgrade and creates
    // the empty modules table.
    const { db } = await import('@/db/db');
    await db.open();
    const note = await db.artifacts.get('00000000-0000-4000-8000-0000000000a4');
    const npc = await db.artifacts.get('00000000-0000-4000-8000-0000000000a5');
    expect(note?.aliases).toEqual([]);
    expect(npc?.aliases).toEqual([]);

    const { artifactSchema, createModule } = await import('@/domain');
    expect(artifactSchema.parse(note).aliases).toEqual([]);

    // The new table accepts a module row built by the domain factory.
    const firstModule = createModule({
      campaignId: '00000000-0000-4000-8000-0000000000c1',
      title: 'First Module',
      concept: '',
      levelMin: 1,
      levelMax: 3,
      sizeDial: 'standard',
    });
    await db.modules.put(firstModule);
    expect((await db.modules.get(firstModule.id))?.title).toBe('First Module');

    await db.delete();
  });
});

describe('v6 → v7 migration', () => {
  it('backfills module.entityKinds to [] on pre-M4-C rows', async () => {
    // Build a v6 database (modules exist, entityKinds does not) with one
    // pre-v7 module row, then close it.
    await Dexie.delete('campaigner');
    const legacy = new Dexie('campaigner');
    legacy.version(6).stores({
      campaigns: 'id, name',
      artifacts: 'id, campaignId, kind, [campaignId+kind], name, updatedAt',
      revisions: 'id, artifactId, [artifactId+revision]',
      images: 'id, campaignId',
      rulebooks: 'id, system, status',
      chunks: 'id, bookId, chunkType, contentHash',
      embeddings: 'contentHash',
      personas: 'id, &slug',
      runs: 'id, campaignId, personaId, status, updatedAt',
      deliverables: 'id, campaignId',
      modules: 'id, campaignId, updatedAt',
      settings: 'id',
    });
    await legacy.open();
    await legacy.table('modules').put({
      id: '00000000-0000-4000-8000-0000000000b1',
      campaignId: '00000000-0000-4000-8000-0000000000c1',
      title: 'Pre-v7 module',
      concept: '',
      levelMin: 1,
      levelMax: 3,
      tone: '',
      sizeDial: 'standard',
      spine: null,
      parts: [],
      status: 'draft',
      errorMessage: '',
      createdAt: 1,
      updatedAt: 1,
    });
    legacy.close();

    // Opening the app's versioned DB runs the version-7 upgrade.
    const { db } = await import('@/db/db');
    await db.open();
    const module = await db.modules.get('00000000-0000-4000-8000-0000000000b1');
    expect(module?.entityKinds).toEqual([]);

    // The upgraded row validates against the current module schema.
    const { moduleSchema } = await import('@/domain');
    expect(moduleSchema.parse(module).entityKinds).toEqual([]);

    await db.delete();
  }, 20000);
});
