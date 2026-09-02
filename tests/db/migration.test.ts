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

describe('v1 → current migration', () => {
  it('fills surviving defaults and removes retired session notes', async () => {
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
      id: '00000000-0000-4000-8000-000000000c01',
      name: 'Legacy',
      system: 'dnd5e',
      description: '',
      createdAt: 1,
      updatedAt: 1,
    });
    await legacy.table('artifacts').put({
      id: '00000000-0000-4000-8000-0000000000a1',
      campaignId: '00000000-0000-4000-8000-000000000c01',
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
      campaignId: '00000000-0000-4000-8000-000000000c01',
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
      campaignId: '00000000-0000-4000-8000-000000000c01',
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
      campaignId: '00000000-0000-4000-8000-000000000c01',
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

    // v11 retires session artifacts and records the loud startup notice.
    expect(await db.artifacts.get('00000000-0000-4000-8000-0000000000a3')).toBeUndefined();
    expect((await db.settings.get('settings'))?.retiredSessionNotesRemoved).toBe(1);

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
      campaignId: '00000000-0000-4000-8000-000000000c01',
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
      campaignId: '00000000-0000-4000-8000-000000000c01',
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
      campaignId: '00000000-0000-4000-8000-000000000c01',
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
      campaignId: '00000000-0000-4000-8000-000000000c01',
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

describe('v7 → v8 migration', () => {
  it('backfills the fix-01 normalization state on pre-fix rows', async () => {
    // Build a v7 database (entityKinds exists, the fix-01 fields do not) with
    // one module row that has already recorded kinds, then close it.
    await Dexie.delete('campaigner');
    const legacy = new Dexie('campaigner');
    legacy.version(7).stores({
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
      id: '00000000-0000-4000-8000-0000000000b2',
      campaignId: '00000000-0000-4000-8000-000000000c01',
      title: 'Pre-v8 module',
      concept: '',
      levelMin: 1,
      levelMax: 3,
      tone: '',
      sizeDial: 'standard',
      spine: null,
      parts: [],
      status: 'ready',
      errorMessage: '',
      entityKinds: [{ name: 'Kael', kind: 'npc' }],
      createdAt: 1,
      updatedAt: 1,
    });
    legacy.close();

    // Opening the app's versioned DB runs the version-8 upgrade: the module
    // has never been normalized, carries no error and no proposals.
    const { db } = await import('@/db/db');
    await db.open();
    const module = await db.modules.get('00000000-0000-4000-8000-0000000000b2');
    expect(module?.entityNamesNormalized).toBe(false);
    expect(module?.entityNormalizationError).toBe('');
    expect(module?.entityRewriteProposals).toBeNull();

    // The upgraded row validates against the current module schema (whose
    // entityKinds records now carry `absorbed`).
    const { moduleSchema } = await import('@/domain');
    const parsed = moduleSchema.parse(module);
    expect(parsed.entityNamesNormalized).toBe(false);
    expect(parsed.entityKinds).toEqual([{ name: 'Kael', kind: 'npc', absorbed: [] }]);

    await db.delete();
  }, 20000);
});

describe('v8 → v9 migration', () => {
  it('creates the battles table and backfills encounter mapImageId + image role', async () => {
    // Build a v8 database (pre-M5): encounters have no mapImageId, images
    // have no role, battles do not exist.
    await Dexie.delete('campaigner');
    const legacy = new Dexie('campaigner');
    legacy.version(8).stores({
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
    await legacy.table('artifacts').put({
      id: '00000000-0000-4000-8000-000000000e02',
      campaignId: '00000000-0000-4000-8000-000000000c01',
      kind: 'encounter',
      name: 'Old encounter',
      tags: [],
      summary: '',
      body: '',
      links: [],
      coverImageId: null,
      imageIds: [],
      aliases: [],
      currentRevision: 1,
      createdAt: 1,
      updatedAt: 1,
      data: {
        difficulty: 'medium',
        levelHint: '1',
        monsters: [],
        terrain: '',
        tactics: '',
        treasure: '',
      },
    });
    await legacy.table('images').put({
      id: '00000000-0000-4000-8000-000000000a03',
      campaignId: '00000000-0000-4000-8000-000000000c01',
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'image/webp',
      width: 100,
      height: 100,
      prompt: '',
      model: '',
      source: 'uploaded',
      createdAt: 1,
      updatedAt: 1,
    });
    legacy.close();

    // Opening the app's versioned DB runs the version-9 upgrade: the battles
    // table exists, the encounter gains mapImageId: null, the image gains
    // role 'artwork'.
    const { db } = await import('@/db/db');
    await db.open();
    expect(await db.battles.count()).toBe(0);

    const { artifactSchema } = await import('@/domain');
    const artifact = await db.artifacts.get('00000000-0000-4000-8000-000000000e02');
    expect(artifact?.kind).toBe('encounter');
    const parsed = artifactSchema.parse(artifact);
    if (parsed.kind !== 'encounter') throw new Error('wrong kind');
    expect(parsed.data.mapImageId).toBeNull();

    const image = await db.images.get('00000000-0000-4000-8000-000000000a03');
    // The bytes round-trip through structured clone; the role default is
    // what the migration adds — assert it directly.
    expect(image?.role).toBe('artwork');

    await db.delete();
  }, 20000);
});

describe('v9 → v10 migration', () => {
  it('backfills moduleId: null on pre-ownership rows', async () => {
    // Build a v9 database (the M5 shape — no ownership fields yet) with one
    // artifact row, then close it.
    await Dexie.delete('campaigner');
    const legacy = new Dexie('campaigner');
    legacy.version(9).stores({
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
      battles: 'id, campaignId, sessionId',
      settings: 'id',
    });
    await legacy.open();
    await legacy.table('campaigns').put({
      id: '00000000-0000-4000-8000-000000000c01',
      name: 'Owned',
      system: 'dnd5e',
      description: '',
      createdAt: 1,
      updatedAt: 1,
    });
    await legacy.table('artifacts').put({
      id: '00000000-0000-4000-8000-0000000000a4',
      campaignId: '00000000-0000-4000-8000-000000000c01',
      kind: 'note',
      name: 'Pre-ownership note',
      tags: [],
      aliases: [],
      summary: '',
      body: '',
      links: [],
      currentRevision: 1,
      imageIds: [],
      coverImageId: null,
      data: {},
      createdAt: 1,
      updatedAt: 1,
    });
    legacy.close();

    // Opening the app's versioned DB runs the version-10 upgrade: the row
    // gains `moduleId: null` (campaign-owned) and everything else survives.
    const { db } = await import('@/db/db');
    await db.open();
    const row = await db.artifacts.get('00000000-0000-4000-8000-0000000000a4');
    expect(row?.moduleId).toBeNull();
    expect(row?.campaignId).toBe('00000000-0000-4000-8000-000000000c01');
    expect(row?.name).toBe('Pre-ownership note');
    // The upgraded row validates against the current owned schema and
    // derives the campaign scope.
    const { artifactSchema, artifactScope } = await import('@/domain');
    const parsed = artifactSchema.parse(row);
    expect(artifactScope(parsed)).toBe('campaign');

    await db.delete();
  }, 20000);
});

describe('v10 → v11 migration', () => {
  it('clears battles, removes session notes, records the count, and preserves authored rows', async () => {
    await Dexie.delete('campaigner');
    const legacy = new Dexie('campaigner');
    legacy.version(10).stores({
      campaigns: 'id, name',
      artifacts: 'id, campaignId, kind, [campaignId+kind], name, updatedAt, moduleId, [moduleId+kind]',
      revisions: 'id, artifactId, [artifactId+revision]',
      images: 'id, campaignId',
      rulebooks: 'id, system, status',
      chunks: 'id, bookId, chunkType, contentHash',
      embeddings: 'contentHash',
      personas: 'id, &slug',
      runs: 'id, campaignId, personaId, status, updatedAt',
      deliverables: 'id, campaignId',
      modules: 'id, campaignId, updatedAt',
      battles: 'id, campaignId, sessionId',
      settings: 'id',
    });
    await legacy.open();
    const campaignId = '00000000-0000-4000-8000-000000000c11';
    const moduleId = '00000000-0000-4000-8000-000000000b11';
    const sessionId = '00000000-0000-4000-8000-000000000a11';
    const noteId = '00000000-0000-4000-8000-000000000d11';
    await legacy.table('campaigns').put({
      id: campaignId,
      name: 'Migration campaign',
      system: 'dnd5e',
      description: '',
      createdAt: 1,
      updatedAt: 1,
    });
    await legacy.table('modules').put({
      id: moduleId,
      campaignId,
      title: 'Preserved module',
      concept: '',
      levelMin: 1,
      levelMax: 3,
      sizeDial: 'sketch',
      spine: null,
      parts: [],
      entityKinds: [],
      focusedEntities: [],
      entitySort: 'appearance',
      entityNamesNormalized: false,
      entityNormalizationError: '',
      entityRewriteProposals: null,
      createdAt: 1,
      updatedAt: 1,
    });
    await legacy.table('artifacts').bulkPut([
      {
        id: sessionId,
        campaignId,
        moduleId: null,
        kind: 'session',
        name: 'Retired session',
        tags: [],
        aliases: [],
        summary: '',
        body: '',
        links: [],
        currentRevision: 1,
        imageIds: [],
        coverImageId: null,
        data: { sessionNumber: '1', recap: '', prep: [], openThreads: [], scenes: [], log: '' },
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: noteId,
        campaignId,
        moduleId,
        kind: 'note',
        name: 'Preserved note',
        tags: [],
        aliases: [],
        summary: '',
        body: '',
        links: [{ targetId: sessionId, relation: 'formerly' }],
        currentRevision: 1,
        imageIds: [],
        coverImageId: null,
        data: {},
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    await legacy.table('revisions').put({
      id: '00000000-0000-4000-8000-000000000e11',
      artifactId: sessionId,
      revision: 1,
      snapshot: {},
      source: 'user',
      runId: null,
      createdAt: 1,
    });
    await legacy.table('battles').put({
      id: '00000000-0000-4000-8000-000000000f11',
      campaignId,
      sessionId,
      createdAt: 1,
      updatedAt: 1,
    });
    await legacy.table('settings').put({ id: 'settings', openRouterApiKey: '' });
    legacy.close();

    const { db } = await import('@/db/db');
    await db.open();
    expect(await db.battles.count()).toBe(0);
    expect(await db.artifacts.get(sessionId)).toBeUndefined();
    expect(await db.revisions.where('artifactId').equals(sessionId).count()).toBe(0);
    const note = await db.artifacts.get(noteId);
    expect(note?.name).toBe('Preserved note');
    expect(note?.moduleId).toBe(moduleId);
    expect(note?.links).toEqual([]);
    expect((await db.modules.get(moduleId))?.title).toBe('Preserved module');
    expect((await db.settings.get('settings'))?.retiredSessionNotesRemoved).toBe(1);
    await db.delete();
  }, 20000);
});

describe('v11 → v12 migration', () => {
  it('backfills null encounter layout and battle mapLayout without changing rows', async () => {
    await Dexie.delete('campaigner');
    const legacy = new Dexie('campaigner');
    legacy.version(11).stores({
      campaigns: 'id, name',
      artifacts: 'id, campaignId, kind, [campaignId+kind], name, updatedAt, moduleId, [moduleId+kind]',
      revisions: 'id, artifactId, [artifactId+revision]',
      images: 'id, campaignId',
      rulebooks: 'id, system, status',
      chunks: 'id, bookId, chunkType, contentHash',
      embeddings: 'contentHash',
      personas: 'id, &slug',
      runs: 'id, campaignId, personaId, status, updatedAt',
      deliverables: 'id, campaignId',
      modules: 'id, campaignId, updatedAt',
      battles: 'id, campaignId, moduleId',
      settings: 'id',
    });
    await legacy.open();
    const campaignId = '00000000-0000-4000-8000-000000000c12';
    const moduleId = '00000000-0000-4000-8000-000000000b12';
    const encounterId = '00000000-0000-4000-8000-000000000a12';
    await legacy.table('artifacts').put({
      id: encounterId,
      campaignId,
      moduleId,
      kind: 'encounter',
      name: 'Pre-layout encounter',
      tags: [],
      aliases: [],
      summary: '',
      body: '',
      links: [],
      currentRevision: 1,
      imageIds: [],
      coverImageId: null,
      data: {
        difficulty: '',
        levelHint: '',
        monsters: [],
        terrain: '',
        tactics: '',
        treasure: '',
        mapImageId: null,
      },
      createdAt: 1,
      updatedAt: 1,
    });
    await legacy.table('battles').put({
      id: '00000000-0000-4000-8000-000000000d12',
      campaignId,
      moduleId,
      encounterArtifactId: encounterId,
      seedFighters: [],
      board: {
        mapImageId: null,
        live: false,
        tokens: [],
        veils: [],
        gridSize: 72,
        tokenSize: 64,
        sceneryMovementLocked: false,
        initiativeEnabled: false,
        initiativeOrder: [],
        activeIndex: 0,
        stage: null,
        stagingGround: null,
      },
      createdAt: 1,
      updatedAt: 1,
    });
    legacy.close();

    const { db } = await import('@/db/db');
    await db.open();
    const encounter = await db.artifacts.get(encounterId);
    const battle = await db.battles.where('moduleId').equals(moduleId).first();
    expect(encounter?.kind === 'encounter' ? encounter.data.layout : undefined).toBeNull();
    expect(battle?.board.mapLayout).toBeNull();
    const { artifactSchema, battleSchema } = await import('@/domain');
    expect(artifactSchema.parse(encounter).id).toBe(encounterId);
    expect(battleSchema.parse(battle).moduleId).toBe(moduleId);
    await db.delete();
  }, 20000);
});
