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
    // entityKinds records now carry `absorbed` plus the structural conflict
    // declarations, all defaulted — parse-on-read, no migration).
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

describe('v12 → v13 migration', () => {
  it('backfills module.includePriorModules to false on pre-v13 rows', async () => {
    await Dexie.delete('campaigner');
    const legacy = new Dexie('campaigner');
    legacy.version(12).stores({
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
    await legacy.table('modules').put({
      id: '00000000-0000-4000-8000-0000000000b3',
      campaignId: '00000000-0000-4000-8000-0000000000c3',
      title: 'Pre-v13 module',
      concept: '',
      levelMin: 1,
      levelMax: 3,
      tone: '',
      sizeDial: 'standard',
      spine: null,
      parts: [],
      status: 'draft',
      errorMessage: '',
      entityKinds: [],
      focusedEntities: [],
      entitySort: 'mention',
      entityNamesNormalized: false,
      entityNormalizationError: '',
      entityRewriteProposals: null,
      createdAt: 1,
      updatedAt: 1,
    });
    legacy.close();

    // Opening the app's versioned DB runs the version-13 upgrade.
    const { db } = await import('@/db/db');
    await db.open();
    const module = await db.modules.get('00000000-0000-4000-8000-0000000000b3');
    expect(module?.includePriorModules).toBe(false);
    const { moduleSchema } = await import('@/domain');
    expect(moduleSchema.parse(module).id).toBe('00000000-0000-4000-8000-0000000000b3');
    await db.delete();
  }, 20000);
});

describe('v14 → v15 migration (dungeon preset, docs/11 D10)', () => {
  it('backfills encounter preset, run encounterPreset and settings encounterPreset', async () => {
    await Dexie.delete('campaigner');
    const legacy = new Dexie('campaigner');
    legacy.version(14).stores({
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
      pdfFiles: 'id, &bookId',
      settings: 'id',
    });
    await legacy.open();
    await legacy.table('artifacts').put({
      id: '00000000-0000-4000-8000-000000000a15',
      campaignId: '00000000-0000-4000-8000-000000000c15',
      kind: 'encounter',
      name: 'Pre-preset encounter',
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
        layout: null,
      },
      createdAt: 1,
      updatedAt: 1,
    });
    await legacy.table('runs').put({
      id: '00000000-0000-4000-8000-000000000b15',
      campaignId: '00000000-0000-4000-8000-000000000c15',
      personaId: '00000000-0000-4000-8000-000000000d15',
      mode: 'encounter',
      status: 'completed',
      autonomy: 'auto',
      userBrief: '',
      pinnedChunkIds: [],
      steps: [],
      resultArtifactId: null,
      targetArtifactId: null,
      encounterMapAspect: '4:3',
      placementModuleId: null,
      runExtras: null,
      errorMessage: '',
      createdAt: 1,
      updatedAt: 1,
    });
    await legacy.table('settings').put({
      id: 'settings',
      encounterMapAspect: '4:3',
      retiredSessionNotesRemoved: 0,
    });
    legacy.close();

    // Opening the app's versioned DB runs the version-15 upgrade.
    const { db } = await import('@/db/db');
    await db.open();
    const encounter = await db.artifacts.get('00000000-0000-4000-8000-000000000a15');
    const run = await db.runs.get('00000000-0000-4000-8000-000000000b15');
    const settings = await db.settings.get('settings');
    expect(encounter?.kind === 'encounter' ? encounter.data.preset : undefined).toBe('standard');
    expect(run?.encounterPreset).toBeNull();
    expect(settings?.encounterPreset).toBe('standard');
    const { artifactSchema, personaRunSchema } = await import('@/domain');
    expect(artifactSchema.parse(encounter).id).toBe('00000000-0000-4000-8000-000000000a15');
    expect(personaRunSchema.parse(run).id).toBe('00000000-0000-4000-8000-000000000b15');
    await db.delete();
  }, 20000);
});

describe('v15 → v16 migration (one live battle per module)', () => {
  it('rebuilds the battles moduleId index as UNIQUE and preserves rows', async () => {
    await Dexie.delete('campaigner');
    const legacy = new Dexie('campaigner');
    legacy.version(15).stores({
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
      pdfFiles: 'id, &bookId',
      settings: 'id',
    });
    await legacy.open();
    const campaignId = '00000000-0000-4000-8000-00000000c616';
    const moduleId = '00000000-0000-4000-8000-000000000b16';
    await legacy.table('campaigns').put({
      id: campaignId,
      name: 'Battle migration',
      system: 'dnd5e',
      description: '',
      createdAt: 1,
      updatedAt: 1,
    });
    await legacy.table('battles').put({
      id: '00000000-0000-4000-8000-00000000f616',
      campaignId,
      moduleId,
      encounterArtifactId: null,
      seedFighters: [],
      board: {
        mapImageId: null,
        mapLayout: null,
        live: false,
        everLive: false,
        tokens: [],
        veils: [],
        effects: [],
        gridSize: null,
        tokenSize: 64,
        sceneryMovementLocked: false,
        initiativeEnabled: false,
        initiativeOrder: [],
        activeIndex: 0,
        stage: null,
        stagingGround: null,
        entrance: null,
      },
      reseed: null,
      createdAt: 1,
      updatedAt: 1,
    });
    legacy.close();

    // Opening the app's versioned DB rebuilds the battles indexes — the
    // surviving row is untouched and still parses against the battle schema.
    const { db } = await import('@/db/db');
    await db.open();
    const battle = await db.battles.get('00000000-0000-4000-8000-00000000f616');
    expect(battle?.moduleId).toBe(moduleId);
    const { battleSchema } = await import('@/domain');
    expect(battleSchema.parse(battle).moduleId).toBe(moduleId);

    // The UNIQUE `&moduleId` index is live: a second row claiming the same
    // module's one live battle is refused by the schema itself.
    await expect(
      db.battles.put({ ...battle, id: '00000000-0000-4000-8000-00000000f617' } as never),
    ).rejects.toMatchObject({ name: 'ConstraintError' });
    // A different module still gets its own battle.
    await expect(
      db.battles.put({
        ...battle,
        id: '00000000-0000-4000-8000-00000000f618',
        moduleId: '00000000-0000-4000-8000-00000000b617',
      } as never),
    ).resolves.toBeDefined();
    await db.delete();
  }, 20000);
});

describe('v16 → v17 migration (site shape + per-room challenge, docs/11 D11/D12)', () => {
  it('backfills siteShape, complex path (spawn first) and the under-budget note', async () => {
    await Dexie.delete('campaigner');
    const legacy = new Dexie('campaigner');
    legacy.version(16).stores({
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
      battles: 'id, campaignId, &moduleId',
      pdfFiles: 'id, &bookId',
      settings: 'id',
    });
    await legacy.open();
    // Multi-room layout (spawn room SECOND — "spawn room first if derivable").
    const roomIdA = '00000000-0000-4000-8000-0000000001a1';
    const roomIdB = '00000000-0000-4000-8000-0000000001a2';
    await legacy.table('artifacts').put({
      id: '00000000-0000-4000-8000-000000000a17',
      campaignId: '00000000-0000-4000-8000-000000000c17',
      kind: 'encounter',
      name: 'Legacy warren',
      tags: [],
      aliases: [],
      summary: '',
      body: '',
      links: [],
      currentRevision: 1,
      imageIds: [],
      coverImageId: null,
      moduleId: null,
      data: {
        difficulty: '',
        levelHint: '',
        monsters: [],
        terrain: '',
        tactics: '',
        treasure: '',
        mapImageId: null,
        preset: 'standard',
        locationKind: 'dungeon',
        layout: {
          gridW: 24,
          gridH: 18,
          theme: 'warren',
          corridors: [],
          rooms: [
            {
              id: roomIdA,
              name: 'Hall',
              rects: [{ x: 1, y: 1, w: 6, h: 6 }],
              mobsRect: { x: 2, y: 2, w: 4, h: 4 },
              description: '',
              monsterIndexes: [],
              spawn: false,
              key: '',
              keyTreasure: '',
            },
            {
              id: roomIdB,
              name: 'Entry',
              rects: [{ x: 10, y: 1, w: 6, h: 6 }],
              mobsRect: { x: 11, y: 2, w: 4, h: 4 },
              description: '',
              monsterIndexes: [],
              spawn: true,
              key: '',
              keyTreasure: '',
            },
          ],
        },
      },
      createdAt: 1,
      updatedAt: 1,
    });
    // One-room layout ⇒ single.
    await legacy.table('artifacts').put({
      id: '00000000-0000-4000-8000-000000000a18',
      campaignId: '00000000-0000-4000-8000-000000000c17',
      kind: 'encounter',
      name: 'Legacy arena',
      tags: [],
      aliases: [],
      summary: '',
      body: '',
      links: [],
      currentRevision: 1,
      imageIds: [],
      coverImageId: null,
      moduleId: null,
      data: {
        difficulty: '',
        levelHint: '',
        monsters: [],
        terrain: '',
        tactics: '',
        treasure: '',
        mapImageId: null,
        preset: 'standard',
        locationKind: 'wilderness',
        layout: {
          gridW: 24,
          gridH: 18,
          theme: 'arena',
          corridors: [],
          rooms: [
            {
              id: roomIdA,
              name: 'Arena',
              rects: [{ x: 1, y: 1, w: 6, h: 6 }],
              mobsRect: { x: 2, y: 2, w: 4, h: 4 },
              description: '',
              monsterIndexes: [],
              spawn: true,
              key: '',
              keyTreasure: '',
            },
          ],
        },
      },
      createdAt: 1,
      updatedAt: 1,
    });
    // Layoutless (uploaded map) ⇒ single, byte-identical behavior.
    await legacy.table('artifacts').put({
      id: '00000000-0000-4000-8000-000000000a19',
      campaignId: '00000000-0000-4000-8000-000000000c17',
      kind: 'encounter',
      name: 'Legacy upload',
      tags: [],
      aliases: [],
      summary: '',
      body: '',
      links: [],
      currentRevision: 1,
      imageIds: [],
      coverImageId: null,
      moduleId: null,
      data: {
        difficulty: '',
        levelHint: '',
        monsters: [],
        terrain: '',
        tactics: '',
        treasure: '',
        mapImageId: null,
        layout: null,
        preset: 'standard',
        locationKind: 'other',
      },
      createdAt: 1,
      updatedAt: 1,
    });
    legacy.close();

    const { db } = await import('@/db/db');
    await db.open();
    const warren = await db.artifacts.get('00000000-0000-4000-8000-000000000a17');
    const arena = await db.artifacts.get('00000000-0000-4000-8000-000000000a18');
    const upload = await db.artifacts.get('00000000-0000-4000-8000-000000000a19');
    expect(warren?.kind === 'encounter' ? warren.data.siteShape : undefined).toBe('complex');
    expect(warren?.kind === 'encounter' ? warren.data.layout?.path : undefined).toEqual([
      roomIdB,
      roomIdA,
    ]);
    expect(warren?.kind === 'encounter' ? warren.data.budgetAdvisory : undefined).toContain(
      'under-budget',
    );
    expect(arena?.kind === 'encounter' ? arena.data.siteShape : undefined).toBe('single');
    expect(arena?.kind === 'encounter' ? arena.data.layout?.path : undefined).toBeUndefined();
    expect(arena?.kind === 'encounter' ? arena.data.budgetAdvisory : undefined).toBe('');
    expect(upload?.kind === 'encounter' ? upload.data.siteShape : undefined).toBe('single');
    expect(upload?.kind === 'encounter' ? upload.data.budgetAdvisory : undefined).toBe('');

    // The upgraded rows validate against the current schemas.
    const { artifactSchema } = await import('@/domain');
    for (const row of [warren, arena, upload]) {
      expect(artifactSchema.parse(row).kind).toBe('encounter');
    }
    await db.delete();
  }, 20000);
});

describe('cover-generation arc (no Dexie bump: parse-on-read defaults)', () => {
  it('v18 rows without coverImageId parse to null through the current schemas', async () => {
    // Covers are additive `z.uuid().nullable().default(null)` fields with NO
    // version bump and NO index changes (the v7/v13/v15/v17 precedent): rows
    // written before covers carry no field and materialize `null` at the
    // read boundary. The store shape below is v18 verbatim.
    await Dexie.delete('campaigner');
    const legacy = new Dexie('campaigner');
    legacy.version(18).stores({
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
      battles: 'id, campaignId, &moduleId',
      pdfFiles: 'id, &bookId',
      mobPortraits: 'id, &chunkId',
      settings: 'id',
    });
    await legacy.open();
    await legacy.table('campaigns').put({
      id: '00000000-0000-4000-8000-000000000c18',
      name: 'Pre-cover campaign',
      system: 'dnd5e',
      description: 'A city of ash.',
      createdAt: 1,
      updatedAt: 1,
    });
    await legacy.table('modules').put({
      id: '00000000-0000-4000-8000-000000000b18',
      campaignId: '00000000-0000-4000-8000-000000000c18',
      title: 'Pre-cover module',
      concept: 'A vault.',
      levelMin: 1,
      levelMax: 3,
      tone: '',
      sizeDial: 'standard',
      spine: null,
      parts: [],
      status: 'draft',
      errorMessage: '',
      entityKinds: [],
      focusedEntities: [],
      entitySort: 'mention',
      entityNamesNormalized: false,
      entityNormalizationError: '',
      entityRewriteProposals: null,
      includePriorModules: false,
      autoGenerateKinds: [],
      autoImageKinds: [],
      autoGenerateBattlemaps: false,
      autoApproveSpine: false,
      createdAt: 1,
      updatedAt: 1,
    });
    legacy.close();

    // Opening the app's versioned DB runs NO upgrade (still v18): the rows
    // come back exactly as written, and the current schemas default them.
    const { db } = await import('@/db/db');
    await db.open();
    const campaign = await db.campaigns.get('00000000-0000-4000-8000-000000000c18');
    const module = await db.modules.get('00000000-0000-4000-8000-000000000b18');
    expect(campaign).not.toHaveProperty('coverImageId');
    expect(module).not.toHaveProperty('coverImageId');

    const { campaignSchema, moduleSchema } = await import('@/domain');
    expect(campaignSchema.parse(campaign).coverImageId).toBeNull();
    expect(moduleSchema.parse(module).coverImageId).toBeNull();

    // The repos parse on read, so surfaces see `null`, never `undefined`.
    const { getCampaign } = await import('@/db/campaignRepo');
    const { getModule } = await import('@/db/moduleRepo');
    expect((await getCampaign('00000000-0000-4000-8000-000000000c18'))?.coverImageId).toBeNull();
    expect((await getModule('00000000-0000-4000-8000-000000000b18'))?.coverImageId).toBeNull();

    await db.delete();
  }, 20000);
});


/**
 * v18 → v19 (owner-directed simple undo, docs/17 ledger row 63): the new
 * `moduleVersions` table is an ADDITIVE store with no upgrade function — the
 * upgrade path is the index rebuild itself (the v14/v18 precedent). A pre-v19
 * database keeps every row untouched and simply has no undo history; the
 * first AI change after the upgrade starts the stack. This is the golden pin
 * for that claim.
 */
describe('v18 → v19 migration (durable module document versions)', () => {
  it('adds an empty moduleVersions table without touching existing rows', async () => {
    await Dexie.delete('campaigner');
    const legacy = new Dexie('campaigner');
    legacy.version(18).stores({
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
      battles: 'id, campaignId, &moduleId',
      pdfFiles: 'id, &bookId',
      mobPortraits: 'id, &chunkId',
      settings: 'id',
    });
    await legacy.open();
    await legacy.table('campaigns').put({
      id: '00000000-0000-4000-8000-000000000c19',
      name: 'Pre-undo campaign',
      system: 'dnd5e',
      description: '',
      createdAt: 1,
      updatedAt: 1,
    });
    await legacy.table('modules').put({
      id: '00000000-0000-4000-8000-000000000b19',
      campaignId: '00000000-0000-4000-8000-000000000c19',
      title: 'Pre-undo module',
      concept: 'A vault.',
      levelMin: 1,
      levelMax: 3,
      tone: '',
      sizeDial: 'standard',
      spine: {
        premise: 'A drowned vault premise.',
        themes: [],
        partPlan: [
          { title: 'The Gate', levelBand: '1', synopsis: '', levelUpTrigger: '' },
        ],
      },
      parts: [
        {
          planIndex: 0,
          markdown: 'Pre-undo part text.',
          status: 'ready',
          errorMessage: '',
          edited: true,
        },
      ],
      status: 'ready',
      errorMessage: '',
      entityKinds: [],
      focusedEntities: [],
      entitySort: 'mention',
      entityNamesNormalized: true,
      entityNormalizationError: '',
      entityRewriteProposals: null,
      includePriorModules: false,
      autoGenerateKinds: [],
      autoImageKinds: [],
      autoGenerateBattlemaps: false,
      autoApproveSpine: false,
      createdAt: 1,
      updatedAt: 1,
    });
    legacy.close();

    // Opening the app's DB walks the chain to its head. v18 → v19 is additive
    // (no upgrade function runs, no row is rewritten) and v19 → v20 (the
    // creature tier, ledger row 106) finds no creature state in this fixture,
    // so both are no-ops on these rows.
    const { db } = await import('@/db/db');
    await db.open();
    expect(db.verno).toBe(20);

    const module = await db.modules.get('00000000-0000-4000-8000-000000000b19');
    expect(module?.parts[0]?.markdown).toBe('Pre-undo part text.');
    // No undo history to carry over — the truthful empty state, not a failure.
    expect(await db.moduleVersions.count()).toBe(0);

    // The table is usable straight after the upgrade: the first AI change
    // starts the stack.
    const { snapshotModuleVersion, listModuleVersions } = await import('@/db/moduleVersionRepo');
    await snapshotModuleVersion(
      '00000000-0000-4000-8000-000000000b19',
      'chat',
      'Chat: after the upgrade',
    );
    const versions = await listModuleVersions('00000000-0000-4000-8000-000000000b19');
    expect(versions).toHaveLength(1);
    expect(versions[0]?.docText).toContain('Pre-undo part text.');
    await db.delete();
  }, 20000);
});

/**
 * v19 → v20 (the creature tier, docs/17 ledger row 106): the owner's incident
 * was two `npc` artifacts that WERE bestiary creatures and were deleted,
 * leaving two roster entries on a permanent `missing ref`. This is the golden
 * pin for the ONE loud repair seam that heals such a database on upgrade, and
 * for the invariant that a portrait survives it.
 */
describe('v19 → v20 migration (the creature tier)', () => {
  const CAMPAIGN = '00000000-0000-4000-8000-000000000c20';
  const MODULE = '00000000-0000-4000-8000-000000000b20';
  const CHUNK = '00000000-0000-4000-8000-000000000d20';
  const MARKED = '00000000-0000-4000-8000-000000000e20';
  const ENCOUNTER = '00000000-0000-4000-8000-000000000f20';
  const COVER = '00000000-0000-4000-8000-000000000a20';
  const SLOT = '00000000-0000-4000-8000-000000000920';

  /** A v19 database in the RETIRED shape: a marked creature row, an encounter
   * citing it by `mobArtifactId`, and a portrait on the row. */
  async function seedLegacyV19(): Promise<void> {
    await Dexie.delete('campaigner');
    const legacy = new Dexie('campaigner');
    legacy.version(19).stores({
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
      battles: 'id, campaignId, &moduleId',
      pdfFiles: 'id, &bookId',
      mobPortraits: 'id, &chunkId',
      moduleVersions: 'id, moduleId, createdAt',
      settings: 'id',
    });
    await legacy.open();
    await legacy.table('campaigns').put({
      id: CAMPAIGN,
      name: 'Ember',
      system: 'dnd5e',
      description: '',
      createdAt: 1,
      updatedAt: 1,
    });
    await legacy.table('modules').put({
      id: MODULE,
      campaignId: CAMPAIGN,
      title: 'Ember Crypt',
      concept: 'A vault.',
      levelMin: 1,
      levelMax: 3,
      parts: [],
      createdAt: 1,
      updatedAt: 1,
      autoGenerateMobImages: false,
      autoGenerateBattlemaps: false,
      autoApproveSpine: false,
    });
    await legacy.table('rulebooks').put({
      id: '00000000-0000-4000-8000-000000000820',
      system: 'dnd5e',
      status: 'ready',
      title: 'Monster Core',
      createdAt: 1,
      updatedAt: 1,
    });
    await legacy.table('chunks').put({
      id: CHUNK,
      bookId: '00000000-0000-4000-8000-000000000820',
      pageStart: 1,
      pageEnd: 1,
      chunkType: 'statblock',
      headingPath: ['Owlbear'],
      text: 'Owlbear. HP 59, AC 13.',
      contentHash: 'hash-owlbear',
    });
    await legacy.table('images').put({
      id: COVER,
      createdAt: 1,
      updatedAt: 1,
      campaignId: CAMPAIGN,
      bytes: new Uint8Array([7, 7]),
      mimeType: 'image/png',
      width: 8,
      height: 8,
      source: 'generated',
      role: 'artwork',
    });
    // The retired creature row: an `npc` whose identity was the marker.
    await legacy.table('artifacts').put({
      id: MARKED,
      createdAt: 1,
      updatedAt: 1,
      campaignId: CAMPAIGN,
      moduleId: MODULE,
      kind: 'npc',
      name: 'Owlbear',
      summary: '',
      body: '',
      aliases: [],
      tags: [],
      links: [],
      imageIds: [],
      coverImageId: COVER,
      data: { appearance: '', personality: '', statBlock: null, monsterChunkId: CHUNK },
    });
    await legacy.table('artifacts').put({
      id: ENCOUNTER,
      createdAt: 1,
      updatedAt: 1,
      campaignId: CAMPAIGN,
      moduleId: MODULE,
      kind: 'encounter',
      name: 'Ash Gate',
      summary: '',
      body: '',
      aliases: [],
      tags: [],
      links: [],
      imageIds: [],
      coverImageId: null,
      data: {
        difficulty: 'medium',
        levelHint: '3',
        monsters: [
          {
            name: 'Owlbear',
            count: 2,
            notes: '',
            treasure: '',
            source: { type: 'npc-ref', artifactId: MARKED },
          },
        ],
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
    });
    await legacy.table('mobPortraits').put({
      id: SLOT,
      createdAt: 1,
      updatedAt: 1,
      chunkId: CHUNK,
      imageId: COVER,
    });
    await legacy.table('settings').put({ id: 'settings', creatureCitationRepair: null });
    legacy.close();
  }

  it('re-keys the portrait slot, rewrites the citation to the library and deletes only cache', async () => {
    await seedLegacyV19();
    const { db } = await import('@/db/db');
    await db.open();
    expect(db.verno).toBe(20);

    // 1. The slot answers to the creature IDENTITY now, not to a chunk id.
    const slot = await db.mobPortraits.get(SLOT);
    expect(slot?.creatureKey).toBe(`chunk:${CHUNK}`);
    expect((slot as unknown as { chunkId?: unknown }).chunkId).toBeUndefined();

    // 2. The roster citation names the LIBRARY — the form that cannot dangle
    //    on a campaign row that no longer exists.
    const encounter = await db.artifacts.get(ENCOUNTER);
    if (encounter?.kind !== 'encounter') throw new Error('encounter missing');
    expect(encounter.data.monsters[0]?.source).toEqual({
      type: 'rulebook',
      chunkId: CHUNK,
      contentHash: 'hash-owlbear',
      creatureName: 'Owlbear',
    });

    // 3. The retired row is GONE (it was cache, never authored content).
    expect(await db.artifacts.get(MARKED)).toBeUndefined();

    // 4. Its portrait did NOT die with it: the campaign's presentation row
    //    carries the same bytes, so the board still shows the owlbear.
    const presentation = await db.creatureImages.where('campaignId').equals(CAMPAIGN).toArray();
    expect(presentation).toHaveLength(1);
    expect(presentation[0]?.creatureKey).toBe(`chunk:${CHUNK}`);
    const carried = await db.images.get(presentation[0]?.imageId ?? '');
    expect(carried?.bytes).toEqual(new Uint8Array([7, 7]));
    expect(carried?.campaignId).toBe(CAMPAIGN);

    // 5. The report is LOUD and persisted where the shell reads it.
    const settings = await db.settings.get('settings');
    expect(settings?.creatureCitationRepair).toEqual({
      citationsRewritten: 1,
      emptyRowsDeleted: 1,
      coversCarriedForward: 1,
      authoredRowsRemoved: [],
      unconverted: [],
    });
    await db.delete();
  }, 20000);

  it('is IDEMPOTENT: a second run finds nothing left to repair and says so', async () => {
    await seedLegacyV19();
    const { db } = await import('@/db/db');
    await db.open();
    const { repairCreatureCitations } = await import('@/db/creatureRepair');
    // An ordinary transaction over the same five tables the upgrade body uses:
    // the seam takes the TRANSACTION, so it can be run twice.
    const second = await db.transaction(
      'rw',
      [db.artifacts, db.chunks, db.images, db.creatureImages, db.settings],
      async (tx) => repairCreatureCitations({ tx }),
    );
    expect(second).toEqual({
      citationsRewritten: 0,
      emptyRowsDeleted: 0,
      coversCarriedForward: 0,
      authoredRowsRemoved: [],
      unconverted: [],
    });
    // And nothing moved: the encounter, the presentation row and the settings
    // report are byte-identical to the first run's outcome.
    const settings = await db.settings.get('settings');
    expect(settings?.creatureCitationRepair?.citationsRewritten).toBe(1);
    expect(await db.creatureImages.where('campaignId').equals(CAMPAIGN).count()).toBe(1);
    await db.delete();
  }, 20000);
});
